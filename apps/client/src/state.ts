import { BALANCE } from "@burrow/config";
import { FP, World, moveCircle, cellsToFp, PFLAG, BTN, ENT, buildingDefinition } from "@burrow/sim";
import type { SnapshotMsg, SnapshotEntity, ChunkMsg, PatchMsg } from "@burrow/protocol";

export interface RemoteEntity {
  kind: number;
  id: number;
  // interpolation buffer
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromAt: number;
  toAt: number;
  facing: number;
  flags: number;
  variant: number;
  width: number;
  nameVisible: boolean;
  lastSeen: number;
}

interface PendingInput {
  seq: number;
  moveX: number;
  moveY: number;
  buttons: number;
}

/** Client-side mirror of everything we're allowed to know, plus local
 *  prediction of our own movement (spec §17.3). */
export class ClientState {
  world: World | null = null;
  knownChunks: Uint8Array | null = null; // explored map for minimap
  playerId = -1;
  names: string[] = [];
  role = 0;
  worldSize = BALANCE.world.size;
  chunkSize = 64;
  cellPx = 4;

  // predicted self (FP)
  predX = 0;
  predY = 0;
  prevPredX = 0;
  prevPredY = 0;
  havePos = false;
  pending: PendingInput[] = [];
  seq = 0;

  // authoritative-ish HUD state from snapshots
  self: SnapshotMsg["self"] | null = null;
  selfFlags = 0;
  lastSnapshotTick = 0;
  lastSnapshotAt = 0;
  phaseIndex = -1;
  phaseKind = "countdown";
  phaseEndTick = 0;
  zombieReleaseTick = Number.MAX_SAFE_INTEGER;

  entities = new Map<string, RemoteEntity>();
  dirtyChunks = new Set<number>();

  reset(worldSize: number, chunkSize: number, cellPx: number, playerId: number, names: string[], spawnX?: number, spawnY?: number): void {
    this.worldSize = worldSize;
    this.chunkSize = chunkSize;
    this.cellPx = cellPx;
    this.playerId = playerId;
    this.names = names;
    this.world = new World(worldSize, chunkSize, false);
    // unknown terrain starts as HARD (renders as dark rock)
    this.world.mat.fill(3);
    this.knownChunks = new Uint8Array(this.world.chunksPerSide * this.world.chunksPerSide);
    this.entities.clear();
    this.pending = [];
    this.seq = 0;
    this.zombieReleaseTick = Number.MAX_SAFE_INTEGER;
    // seed position from welcome so camera doesn't start at map corner
    this.predX = spawnX ?? 0;
    this.predY = spawnY ?? 0;
    this.prevPredX = this.predX;
    this.prevPredY = this.predY;
    this.havePos = spawnX !== undefined;
    this.self = null;
  }

  estServerTick(now: number): number {
    return this.lastSnapshotTick + ((now - this.lastSnapshotAt) / 1000) * 30;
  }

  applyChunk(m: ChunkMsg): void {
    if (!this.world || !this.knownChunks) return;
    this.world.decodeChunkRLE(m.cx, m.cy, m.rle, m.revision);
    const idx = m.cy * this.world.chunksPerSide + m.cx;
    this.knownChunks[idx] = 1;
    this.markChunkDirty(m.cx, m.cy);
    this.markChunkDirty(m.cx - 1, m.cy, true);
    this.markChunkDirty(m.cx + 1, m.cy, true);
    this.markChunkDirty(m.cx, m.cy - 1, true);
    this.markChunkDirty(m.cx, m.cy + 1, true);
  }

  applyPatch(m: PatchMsg): void {
    if (!this.world) return;
    for (const c of m.cells) {
      this.world.setRaw(c.x, c.y, c.mat);
      const cx = Math.floor(c.x / this.chunkSize);
      const cy = Math.floor(c.y / this.chunkSize);
      this.markChunkDirty(cx, cy);
      const localX = c.x - cx * this.chunkSize;
      const localY = c.y - cy * this.chunkSize;
      if (localX === 0) this.markChunkDirty(cx - 1, cy, true);
      if (localX === this.chunkSize - 1) this.markChunkDirty(cx + 1, cy, true);
      if (localY === 0) this.markChunkDirty(cx, cy - 1, true);
      if (localY === this.chunkSize - 1) this.markChunkDirty(cx, cy + 1, true);
    }
    for (const r of m.revs) {
      this.world.revisions[r.cy * this.world.chunksPerSide + r.cx] = r.rev;
    }
  }

  private markChunkDirty(cx: number, cy: number, onlyIfKnown = false): void {
    if (!this.world || cx < 0 || cy < 0 || cx >= this.world.chunksPerSide || cy >= this.world.chunksPerSide) return;
    const idx = cy * this.world.chunksPerSide + cx;
    if (!onlyIfKnown || this.knownChunks?.[idx]) this.dirtyChunks.add(idx);
  }

  /** Predict own movement one 30 Hz step and remember it for reconciliation. */
  predictStep(moveX: number, moveY: number, buttons: number): void {
    this.seq++;
    this.pending.push({ seq: this.seq, moveX, moveY, buttons });
    if (this.pending.length > 90) this.pending.shift();
    this.prevPredX = this.predX;
    this.prevPredY = this.predY;
    this.stepBody(moveX, moveY, buttons);
  }

  private stepBody(moveX: number, moveY: number, buttons: number): void {
    if (!this.world || !this.havePos) return;
    if (this.selfFlags & (PFLAG.CONVERTING | PFLAG.STUNNED | PFLAG.INCAP)) return;
    const mv = BALANCE.movement;
    let speedPx = mv.minerWalk;
    const stamina = this.self ? (this.self.stamina / 255) * mv.staminaMax : 100;
    if (this.selfFlags & PFLAG.HUNT) speedPx = mv.infectedHunt;
    else if (buttons & BTN.SPRINT && stamina > 1) speedPx = mv.minerSprint;
    speedPx *= 1 + (this.self?.moveSpeedLevel ?? 0) * BALANCE.playerUpgrades.mobility.speedPercentPerLevel / 100;
    if (this.selfFlags & PFLAG.SLOWED) speedPx *= 0.52;
    let dx = moveX;
    let dy = moveY;
    if (dx === 0 && dy === 0) return;
    const inv = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
    const vFp = Math.round((speedPx / BALANCE.world.cellPx / 30) * FP * inv);
    const r = cellsToFp(mv.playerRadiusCells);
    const baseRadius = cellsToFp(BALANCE.automation.base.collisionRadiusCells);
    const obstacles = [...this.entities.values()]
      .filter((entity) => entity.kind === ENT.MINING_BASE || entity.kind === ENT.BUILDING)
      .map((entity) => ({
        x: entity.toX,
        y: entity.toY,
        radius: entity.kind === ENT.MINING_BASE
          ? baseRadius
          : cellsToFp(buildingDefinition(entity.variant & 15)?.collisionRadius ?? 1.5)
      }));
    const res = moveCircle(this.world, this.predX, this.predY, r, dx * vFp, dy * vFp, obstacles);
    this.predX = res.x;
    this.predY = res.y;
  }

  applySnapshot(m: SnapshotMsg, now: number): void {
    this.lastSnapshotTick = m.tick;
    this.lastSnapshotAt = now;
    this.phaseIndex = m.phaseIndex;
    this.phaseEndTick = m.phaseEndTick;
    this.self = m.self;
    this.selfFlags = m.self.flags;

    // reconciliation: rewind to authoritative pos, replay unacked inputs
    if (!this.havePos) {
      this.predX = this.prevPredX = m.self.x;
      this.predY = this.prevPredY = m.self.y;
      this.havePos = true;
    } else {
      this.pending = this.pending.filter((p) => p.seq > m.lastSeq);
      const oldX = this.predX;
      const oldY = this.predY;
      this.predX = m.self.x;
      this.predY = m.self.y;
      for (const p of this.pending) this.stepBody(p.moveX, p.moveY, p.buttons);
      // avoid micro-jitter: if correction tiny, keep old prediction
      const err = Math.hypot(this.predX - oldX, this.predY - oldY);
      if (err < FP / 8) {
        this.predX = oldX;
        this.predY = oldY;
      }
    }

    // entity interpolation buffers
    const seen = new Set<string>();
    for (const e of m.entities) {
      const key = `${e.kind}:${e.id}`;
      seen.add(key);
      const prev = this.entities.get(key);
      if (prev) {
        prev.fromX = this.lerpNow(prev, now, "x");
        prev.fromY = this.lerpNow(prev, now, "y");
        prev.fromAt = now;
        prev.toX = e.x;
        prev.toY = e.y;
        prev.toAt = now + 1000 / BALANCE.network.snapshotHz;
        prev.facing = e.facing;
        prev.flags = e.flags;
        prev.variant = e.variant;
        prev.width = e.width;
        prev.nameVisible = e.nameVisible;
        prev.lastSeen = now;
      } else {
        this.entities.set(key, {
          kind: e.kind,
          id: e.id,
          fromX: e.x,
          fromY: e.y,
          toX: e.x,
          toY: e.y,
          fromAt: now,
          toAt: now,
          facing: e.facing,
          flags: e.flags,
          variant: e.variant,
          width: e.width,
          nameVisible: e.nameVisible,
          lastSeen: now
        } satisfies RemoteEntity);
      }
    }
    for (const [key, e] of this.entities) {
      if (!seen.has(key) && now - e.lastSeen > 250) this.entities.delete(key);
    }
  }

  lerpNow(e: RemoteEntity, now: number, axis: "x" | "y"): number {
    const t = e.toAt <= e.fromAt ? 1 : Math.min(1, (now - e.fromAt) / (e.toAt - e.fromAt));
    return axis === "x" ? e.fromX + (e.toX - e.fromX) * t : e.fromY + (e.toY - e.fromY) * t;
  }
}

export function entityFromSnapshot(e: SnapshotEntity): RemoteEntity {
  return {
    kind: e.kind,
    id: e.id,
    fromX: e.x,
    fromY: e.y,
    toX: e.x,
    toY: e.y,
    fromAt: 0,
    toAt: 0,
    facing: e.facing,
    flags: e.flags,
    variant: e.variant,
    width: e.width,
    nameVisible: e.nameVisible,
    lastSeen: 0
  };
}
