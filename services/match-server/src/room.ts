import type { WebSocket } from "ws";
import { BALANCE, type Balance } from "@burrow/config";
import {
  BotController,
  EFLAG,
  ENT,
  FP,
  MatchSim,
  PFLAG,
  PRES,
  ROLE,
  type BombUpgradeId,
  WEAPON_BLUEPRINT_IDS,
  type WeaponBlueprintId,
  TICK_MS,
  type PlayerSim,
  type SimEvent
} from "@burrow/sim";
import {
  MSG,
  PROTOCOL_VERSION,
  decodeInput,
  INPUT_PACKET_BYTES,
  encodeChunk,
  encodePatch,
  encodeSnapshot,
  encodeSound,
  type ControlToClient,
  type SnapshotEntity
} from "@burrow/protocol";

interface Client {
  ws: WebSocket;
  name: string;
  playerId: number; // slot in sim (assigned at start); -1 in lobby
  viewPlayerId: number;
  devMode: boolean;
  devCameraX: number | null;
  devCameraY: number | null;
  assumedRevs: Int32Array | null; // per-chunk revision the client should hold; -1 = never sent
  isHost: boolean;
  lastChatAt: number;
}

export interface RoomOptions {
  matchId: string;
  seed?: number;
  balance?: Balance;
  autoStartFull?: boolean;
}

/** One authoritative match room: lobby -> 30 Hz sim -> results. */
export class Room {
  readonly matchId: string;
  readonly bal: Balance;
  private clients: Client[] = [];
  private sim: MatchSim | null = null;
  private bots: BotController | null = null;
  private seed: number;
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private tickAccum = 0;
  private autoStartFull: boolean;
  onFinished: ((room: Room) => void) | null = null;

  constructor(opts: RoomOptions) {
    this.matchId = opts.matchId;
    this.bal = opts.balance ?? BALANCE;
    this.seed = opts.seed ?? ((Math.random() * 0xffffffff) >>> 0);
    this.autoStartFull = opts.autoStartFull ?? true;
  }

  get started(): boolean {
    return this.sim !== null;
  }

  get playerCount(): number {
    return this.clients.length;
  }

  get finished(): boolean {
    return this.sim?.ended ?? false;
  }

  /* ------------------------------------------------------------ lobby */

  addClient(ws: WebSocket, name: string, devMode = false): void {
    if (this.sim) {
      // reconnection: match by name to a disconnected slot
      const p = this.sim.players.find((q) => !q.bot && q.name === name && !q.connected);
      if (p) {
        const client: Client = { ws, name, playerId: p.id, viewPlayerId: p.id, devMode, devCameraX: null, devCameraY: null, assumedRevs: null, isHost: false, lastChatAt: 0 };
        this.clients.push(client);
        p.connected = true;
        this.resumeIfPaused();
        this.initClientForMatch(client);
        this.wireInput(client);
        return;
      }
      this.sendJson(ws, { t: "error", msg: "match already running" });
      ws.close();
      return;
    }
    const client: Client = { ws, name, playerId: -1, viewPlayerId: -1, devMode, devCameraX: null, devCameraY: null, assumedRevs: null, isHost: this.clients.length === 0, lastChatAt: 0 };
    this.clients.push(client);
    this.wireInput(client);
    this.broadcastLobby();
    if (this.autoStartFull && this.clients.length >= this.bal.match.players) this.start();
  }

  removeClient(ws: WebSocket): void {
    const idx = this.clients.findIndex((c) => c.ws === ws);
    if (idx === -1) return;
    const [client] = this.clients.splice(idx, 1);
    if (this.sim && client.playerId >= 0) {
      const p = this.sim.players[client.playerId];
      if (p) p.connected = false; // remains stationary & vulnerable (spec §17.7)
    }
    if (!this.sim) {
      if (client.isHost && this.clients.length > 0) this.clients[0].isHost = true;
      this.broadcastLobby();
    }
    if (this.clients.length === 0) this.stop();
  }

  private broadcastLobby(): void {
    const players = this.clients.map((c, i) => ({ id: i, name: c.name, bot: false }));
    const hostId = this.clients.findIndex((c) => c.isHost);
    this.clients.forEach((client, selfId) => {
      this.sendJson(client.ws, { t: "lobby", players, hostId, selfId });
    });
  }

  /* ------------------------------------------------------------ start */

  start(): void {
    if (this.sim || this.clients.length === 0) return;
    const humans = this.clients.map((c) => ({ name: c.name, bot: false, devMode: c.devMode }));
    const roster = [...humans];
    let botN = 1;
    while (roster.length < this.bal.match.players) roster.push({ name: `Bot-${botN++}`, bot: true, devMode: false });

    this.sim = new MatchSim(this.seed, this.bal, roster);
    this.bots = new BotController(this.seed);

    this.clients.forEach((c, i) => {
      c.playerId = i;
      c.viewPlayerId = i;
      this.initClientForMatch(c);
    });

    this.lastTickAt = performance.now();
    this.timer = setInterval(() => this.pump(), TICK_MS / 2);
    console.log(`[room ${this.matchId}] match started seed=${this.sim.map.seed} players=${roster.length}`);
  }

  private resumeIfPaused(): void {
    if (!this.sim || this.sim.ended || this.timer) return;
    this.lastTickAt = performance.now();
    this.timer = setInterval(() => this.pump(), TICK_MS / 2);
    console.log(`[room ${this.matchId}] match resumed after reconnect`);
  }

  private initClientForMatch(client: Client): void {
    const sim = this.sim!;
    const w = sim.world;
    client.assumedRevs = new Int32Array(w.chunksPerSide * w.chunksPerSide).fill(-1);
    const p = sim.players[client.playerId];
    this.sendJson(client.ws, {
      t: "welcome",
      playerId: client.playerId,
      worldSize: w.size,
      chunkSize: w.chunkSize,
      cellPx: this.bal.world.cellPx,
      names: sim.players.map((p) => p.name),
      tick: sim.tick,
      matchId: this.matchId,
      spawnX: p.x,   // immediate camera placement before first snapshot
      spawnY: p.y,
      devMode: client.devMode
    });
    // role is private (spec §22.2)
    this.sendJson(client.ws, { t: "role", role: p.role });
    this.sendJson(client.ws, {
      t: "phase",
      index: sim.phaseIndex,
      kind: sim.phaseKind(),
      endTick: sim.phaseEndTick,
      tick: sim.tick,
      zombieReleaseTick: sim.zombieReleaseTick
    });
    this.syncChunks(client);
  }

  /* ------------------------------------------------------------ input */

  private wireInput(client: Client): void {
    client.ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        this.handleControl(client, data.toString());
        return;
      }
      if (data.length !== INPUT_PACKET_BYTES) return;
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (v.getUint8(0) !== PROTOCOL_VERSION) return; // modified protocol -> drop (spec §22.3)
      if (v.getUint8(1) !== MSG.INPUT || !this.sim || client.playerId < 0) return;
      const m = decodeInput(v);
      this.sim.queueInput(client.playerId, {
        seq: m.seq,
        moveX: m.moveX,
        moveY: m.moveY,
        aim: m.aim,
        buttons: m.buttons,
        slot: m.slot
      });
    });
  }

  private handleControl(client: Client, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case "start":
        if (client.isHost && !this.sim) this.start();
        break;
      case "chat": {
        if (this.sim) return;
        const now = Date.now();
        if (now - client.lastChatAt < 350) return;
        const text = String(msg.msg ?? "")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160)
          .trim();
        if (!text) return;
        client.lastChatAt = now;
        const id = this.clients.indexOf(client);
        for (const recipient of this.clients) {
          this.sendJson(recipient.ws, { t: "chat", id, name: client.name, msg: text, at: now });
        }
        break;
      }
      case "ping":
        this.sendJson(client.ws, { t: "pong", at: msg.at });
        break;
      case "upgrade": {
        if (!this.sim || client.playerId < 0) return;
        const allowed = new Set<BombUpgradeId>([
          "speed", "range", "wide", "width", "diagonal", "twin", "capacity", "remote", "shield", "prospector",
          "vision", "mobility", "vitality"
        ]);
        if (!allowed.has(msg.node)) return;
        this.sim.purchaseBombUpgrade(client.playerId, msg.node);
        break;
      }
      case "weapon-tech": {
        if (!this.sim || client.playerId < 0) return;
        const id = String(msg.id) as WeaponBlueprintId;
        if (!(WEAPON_BLUEPRINT_IDS as readonly string[]).includes(id)) return;
        this.sim.purchaseWeaponTech(client.playerId, id);
        break;
      }
      case "dev-view": {
        if (!this.sim || !client.devMode || client.playerId < 0) return;
        const count = this.sim.players.length;
        const direction = msg.direction === -1 ? -1 : 1;
        client.viewPlayerId = (client.viewPlayerId + direction + count) % count;
        client.assumedRevs?.fill(-1);
        const viewed = this.sim.players[client.viewPlayerId];
        this.sendJson(client.ws, {
          t: "dev-view",
          playerId: viewed.id,
          name: viewed.name,
          bot: viewed.bot,
          own: viewed.id === client.playerId
        });
        break;
      }
      case "dev-camera": {
        if (!this.sim || !client.devMode || client.playerId < 0) return;
        if (!msg.active) {
          client.devCameraX = null;
          client.devCameraY = null;
          return;
        }
        const x = Number(msg.x);
        const y = Number(msg.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const maximum = this.sim.world.size - 1;
        client.devCameraX = Math.max(0, Math.min(maximum, x));
        client.devCameraY = Math.max(0, Math.min(maximum, y));
        break;
      }
      case "repair": {
        if (!this.sim || !client.assumedRevs) return;
        const cx = msg.cx | 0;
        const cy = msg.cy | 0;
        const w = this.sim.world;
        if (cx < 0 || cy < 0 || cx >= w.chunksPerSide || cy >= w.chunksPerSide) return;
        client.assumedRevs[cy * w.chunksPerSide + cx] = -1; // force resend next sync
        break;
      }
    }
  }

  /* ------------------------------------------------------------ tick pump */

  private pump(): void {
    const now = performance.now();
    this.tickAccum += now - this.lastTickAt;
    this.lastTickAt = now;
    let steps = 0;
    while (this.tickAccum >= TICK_MS && steps < 5) {
      this.tickAccum -= TICK_MS;
      steps++;
      this.stepOnce();
    }
    if (steps === 5) this.tickAccum = 0; // shed load rather than spiral
  }

  private stepOnce(): void {
    const sim = this.sim!;
    this.bots!.stepBots(sim);
    sim.step();
    this.dispatchEvents(sim.drainEvents());

    // snapshots at snapshotHz
    const div = Math.max(1, Math.round(this.bal.network.serverTickHz / this.bal.network.snapshotHz));
    if (sim.tick % div === 0) {
      for (const c of this.clients) {
        if (c.playerId < 0) continue;
        this.syncChunks(c);
        this.sendSnapshot(c);
      }
    }

    if (sim.ended) this.stop();
  }

  private dispatchEvents(events: SimEvent[]): void {
    const sim = this.sim!;
    for (const ev of events) {
      switch (ev.type) {
        case "patch": {
          for (const c of this.clients) {
            if (c.playerId < 0 || !c.assumedRevs) continue;
            const revs = ev.revs.filter((r) => {
              const idx = r.cy * sim.world.chunksPerSide + r.cx;
              return c.assumedRevs![idx] >= 0 && this.chunkIsInInterest(c, r.cx, r.cy);
            });
            if (revs.length === 0) continue;
            const chunkIndices = new Set(revs.map((r) => r.cy * sim.world.chunksPerSide + r.cx));
            const cells = ev.cells.filter((cell) => chunkIndices.has(sim.world.chunkIndexOf(cell.x, cell.y)));
            for (const r of revs) c.assumedRevs[r.cy * sim.world.chunksPerSide + r.cx] = r.rev;
            this.sendBinary(c.ws, encodePatch({ cells, revs }));
          }
          break;
        }
        case "sound": {
          const buf = encodeSound({ sound: ev.sound, x: ev.x, y: ev.y, intensity: ev.intensity });
          for (const c of this.clients) this.sendBinary(c.ws, buf);
          break;
        }
        case "phase":
          for (const c of this.clients)
            this.sendJson(c.ws, {
              t: "phase",
              index: ev.index,
              kind: ev.kind,
              endTick: ev.endTick,
              tick: sim.tick,
              zombieReleaseTick: sim.zombieReleaseTick
            });
          break;
        case "log": {
          if (ev.playerId === null) {
            for (const c of this.clients) this.sendJson(c.ws, { t: "log", msg: ev.msg });
          } else {
            const c = this.clients.find((cc) => cc.playerId === ev.playerId);
            if (c) this.sendJson(c.ws, { t: "log", msg: ev.msg });
          }
          break;
        }
        case "feed":
          for (const c of this.clients) this.sendJson(c.ws, { t: "feed", kind: ev.kind, msg: ev.msg });
          break;
        case "converted": {
          const c = this.clients.find((cc) => cc.playerId === ev.playerId);
          if (c) {
            this.sendJson(c.ws, { t: "role", role: ROLE.INFECTED });
            this.sendJson(c.ws, { t: "log", msg: "You have been converted. Hunt with the others in daylight." });
          }
          break;
        }
        case "entities":
          break; // entity visibility flows through snapshots
        case "end":
          for (const c of this.clients) this.sendJson(c.ws, { t: "end", winner: ev.winner, winnerPlayerId: ev.winnerPlayerId, scores: ev.scores });
          break;
      }
    }
  }

  /* ------------------------------------------------------------ sync */

  private interestCenter(c: Client): { x: number; y: number } {
    if (c.devMode && c.devCameraX !== null && c.devCameraY !== null) {
      return { x: c.devCameraX, y: c.devCameraY };
    }
    const sim = this.sim!;
    const player = sim.players[c.viewPlayerId >= 0 ? c.viewPlayerId : c.playerId];
    return { x: player.x / FP, y: player.y / FP };
  }

  private snapshotVisibility(c: Client, viewer: PlayerSim): ReturnType<MatchSim["visibleFor"]> {
    const sim = this.sim!;
    if (!c.devMode || c.devCameraX === null || c.devCameraY === null) return sim.visibleFor(viewer);
    const radius = this.bal.network.interestRadiusChunks * sim.world.chunkSize;
    const inside = (x: number, y: number) =>
      Math.abs(x / FP - c.devCameraX!) <= radius && Math.abs(y / FP - c.devCameraY!) <= radius;
    const players = sim.players.filter((player) => player.id !== viewer.id && inside(player.x, player.y));
    const entities = [...sim.entities.values()].filter((entity) => inside(entity.x, entity.y));
    return { players, entities, nameVisible: new Set(players.map((player) => player.id)) };
  }

  private syncChunks(c: Client): void {
    const sim = this.sim!;
    if (!c.assumedRevs || c.playerId < 0) return;
    const w = sim.world;
    const center = this.interestCenter(c);
    const pcx = Math.floor(center.x / w.chunkSize);
    const pcy = Math.floor(center.y / w.chunkSize);
    const radius = this.bal.network.interestRadiusChunks;
    const nearby: { cx: number; cy: number; d2: number }[] = [];
    for (let cy = Math.max(0, pcy - radius); cy <= Math.min(w.chunksPerSide - 1, pcy + radius); cy++) {
      for (let cx = Math.max(0, pcx - radius); cx <= Math.min(w.chunksPerSide - 1, pcx + radius); cx++) {
        nearby.push({ cx, cy, d2: (cx - pcx) ** 2 + (cy - pcy) ** 2 });
      }
    }
    nearby.sort((a, b) => a.d2 - b.d2);

    let sent = 0;
    for (const { cx, cy } of nearby) {
      const idx = cy * w.chunksPerSide + cx;
      const rev = w.revisions[idx];
      if (c.assumedRevs[idx] === rev) continue;
      if (sent >= 14) return; // budget per snapshot interval
      const rle = w.encodeChunkRLE(cx, cy);
      this.sendBinary(c.ws, encodeChunk({ cx, cy, revision: rev, checksum: w.chunkChecksum(cx, cy), rle }));
      c.assumedRevs[idx] = rev;
      sent++;
    }
  }

  private chunkIsInInterest(c: Client, cx: number, cy: number): boolean {
    const sim = this.sim;
    if (!sim || c.playerId < 0) return false;
    const center = this.interestCenter(c);
    const pcx = Math.floor(center.x / sim.world.chunkSize);
    const pcy = Math.floor(center.y / sim.world.chunkSize);
    const radius = this.bal.network.interestRadiusChunks;
    return Math.abs(cx - pcx) <= radius && Math.abs(cy - pcy) <= radius;
  }

  private sendSnapshot(c: Client): void {
    const sim = this.sim!;
    const p = sim.players[c.viewPlayerId >= 0 ? c.viewPlayerId : c.playerId];

    const entities: SnapshotEntity[] = [];
    const visible = this.snapshotVisibility(c, p);
    for (const q of visible.players) {
      entities.push({
        kind: ENT.PLAYER,
        id: q.id,
        x: q.x,
        y: q.y,
        facing: q.facing,
        flags: this.playerFlags(q, sim),
        variant: 0,
        width: 0,
        nameVisible: visible.nameVisible.has(q.id)
      });
    }
    for (const e of visible.entities) {
      if (entities.length >= 250) break;
      let facing = 0;
      if (e.kind === ENT.ZOMBIE) facing = sim.zombies.find((z) => z.id === e.id)?.facing ?? 0;
      else if (e.kind === ENT.GUARDIAN || e.kind === ENT.AUTO_MINER || e.kind === ENT.HUNTER || e.kind === ENT.ORE_CART || e.kind === ENT.BUILDING) facing = e.facing ?? 0;
      else if (e.kind === ENT.BOMB) {
        if (e.launchEndTick !== undefined) {
          const start = e.launchStartTick ?? sim.tick;
          const end = Math.max(start + 1, e.launchEndTick ?? start + 1);
          facing = Math.min(255, Math.max(0, Math.round(((sim.tick - start) / (end - start)) * 255)));
        } else {
          const remaining = Math.max(0, e.cooldownEnd - sim.tick);
          facing = Math.min(255, Math.round((remaining / (e.bombFuseTicks ?? this.bal.items.bomb.fuseTicks)) * 255));
        }
      } else if (e.kind === ENT.BLAST) {
        const cfg = this.bal.items.bomb;
        const range = e.blastRange ?? cfg.blastRangeCells;
        const stepTicks = e.blastStepTicks ?? cfg.blastStepTicks;
        const duration = range * stepTicks + cfg.blastVisualTicks;
        const startTick = e.cooldownEnd - duration;
        facing = Math.min(range, Math.max(0, Math.floor((sim.tick - startTick) / stepTicks)));
      } else if (e.kind === ENT.FIRE) {
        facing = Math.min(31, e.blastRange ?? this.bal.specialWeapons.napalm.rangeCells);
      }
      const flags = e.kind === ENT.BLAST || e.kind === ENT.FIRE
        ? (((e.blastRange ?? this.bal.items.bomb.blastRangeCells) & 31) << 3) | ((e.blastFeatures ?? 0) & 3)
        : e.kind === ENT.AUTO_MINER || e.kind === ENT.HUNTER || e.kind === ENT.ORE_CART || e.kind === ENT.BOMB || e.kind === ENT.BUILDING || e.kind === ENT.CHEST ? e.flags ?? 0 : 0;
      entities.push({
        kind: e.kind,
        id: e.id,
        x: e.x,
        y: e.y,
        facing,
        flags,
        variant: e.kind === ENT.BUILDING
          ? ((e.buildingKind ?? 0) & 15) | ((e.ownerId & 15) << 4)
          : e.kind === ENT.MINING_BASE || e.kind === ENT.AUTO_MINER || e.kind === ENT.HUNTER || e.kind === ENT.ORE_CART ? e.ownerId & 255 : e.weaponKind ?? 0,
        width: e.kind === ENT.BUILDING
          ? Math.max(0, Math.min(255, Math.round(((e.health ?? 1) / Math.max(1, e.maxHealth ?? 1)) * 255)))
          : e.kind === ENT.MINING_BASE
          ? e.minerCount ?? 0
          : e.kind === ENT.BLAST || e.kind === ENT.FIRE
            ? ((e.blastHalfWidth ?? 0) & 15) | ((((e.aim ?? 0) >> 5) & 7) << 4)
            : e.blastHalfWidth ?? 0,
        nameVisible: false
      });
    }

    const mv = this.bal.movement;
    const snap = encodeSnapshot({
      tick: sim.tick,
      lastSeq: p.lastProcessedSeq,
      phaseIndex: sim.phaseIndex,
      phaseEndTick: sim.phaseEndTick,
      self: {
        x: p.x,
        y: p.y,
        stamina: Math.round((p.stamina / mv.staminaMax) * 255),
        oxygen: Math.round((p.oxygen / this.bal.oxygen.emergencySeconds) * 255),
        carried: p.carriedGems,
        secured: p.securedGems,
        reinforceGems: p.reinforceGems,
        rubble: p.rubble,
        support: p.supportParts,
        flags: this.playerFlags(p, sim),
        slot: p.selectedSlot,
        wallUnlocked: p.wallUnlocked ? 1 : 0,
        charges: sim.ownedCharges(p),
        pickDurability: p.pickDurability,
        gold: p.gold,
        fossils: p.fossils,
        copper: p.copper,
        iron: p.iron,
        platinum: p.platinum,
        bombSpeedLevel: p.bombSpeedLevel,
        bombRangeLevel: p.bombRangeLevel,
        bombWidthLevel: p.bombWidthLevel,
        bombCapacityLevel: p.bombCapacityLevel,
        bombFeatures: p.bombFeatures,
        health: p.health,
        maxHealth: sim.playerMaxHealth(p),
        visionLevel: p.visionLevel,
        moveSpeedLevel: p.moveSpeedLevel,
        healthLevel: p.healthLevel,
        dynamite: p.dynamite,
        c4: p.c4,
        clusterBombs: p.clusterBombs,
        napalm: p.napalm,
        nukes: p.nukes,
        turretKits: p.turretKits,
        weaponBlueprints: p.weaponBlueprints,
        coal: p.coal,
        power: p.power,
        powerCapacity: p.powerCapacity,
        infrastructureUnlocked: p.infrastructureUnlocked ? 1 : 0,
        buildingBlueprints: p.buildingBlueprints,
        relics: p.relics
      },
      entities
    });
    this.sendBinary(c.ws, snap);
  }

  private playerFlags(p: PlayerSim, sim: MatchSim): number {
    let f = 0;
    if (p.presentation === PRES.HUNT) f |= PFLAG.HUNT;
    if (p.convertingUntilTick > 0) f |= PFLAG.CONVERTING;
    if (sim.tick < p.stunUntilTick) f |= PFLAG.STUNNED;
    if (p.digging) f |= PFLAG.DIGGING;
    if (p.incapacitated) f |= PFLAG.INCAP;
    if (sim.tick < p.slowedUntilTick) f |= PFLAG.SLOWED;
    return f;
  }

  /* ------------------------------------------------------------ io */

  private sendJson(ws: WebSocket, msg: ControlToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendBinary(ws: WebSocket, buf: ArrayBuffer): void {
    if (ws.readyState === ws.OPEN) ws.send(buf);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.onFinished) this.onFinished(this);
  }
}
