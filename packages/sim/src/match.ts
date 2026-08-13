import type { Balance, PhaseKind } from "@burrow/config";
import { BASE_TOOL_SLOT, BUILDING_FLAG, BTN, CHEST_FLAG, CHEST_VARIANT, EFLAG, ENT, FP, GUARDIAN_VARIANT, LANDMARK, LAST_BUILDING_TOOL_SLOT, PFLAG, PRES, RELIC, ROLE, SOUND, TICK_HZ, WEAPON, aimToRadians, cellsToFp } from "./constants";
import { MAT, isCraftMaterial, minerDiggable, monsterBreakable } from "./materials";
import { generateMap, type GeneratedMap } from "./mapgen";
import { applyDigBrush, fillDisc, hasLineOfSight, type CellChange, type DigResult, World } from "./terrain";
import { circleCollides, depenetrate, moveCircle } from "./movement";
import { computeVentilation, hasVentPath, type VentilationWorkspace } from "./oxygen";
import { Rng } from "./rng";
import { blastPatternForVariant, bombBlastArmMask, bombBlastPatternContains } from "./bomb";
import { BOMB_FEATURE, bombFeatureForUpgrade, bombUpgradeQuotes, type BombUpgradeId, type CraftResource } from "./upgrades";
import {
  hasWeaponBlueprint,
  WEAPON_BLUEPRINT_IDS,
  weaponBlueprintBit,
  weaponFieldProfile,
  weaponKindForBlueprint,
  weaponTechDefinition,
  weaponTechForSlot,
  type WeaponBlueprintId
} from "./weapon-tree";
import {
  BUILDING,
  BUILDING_DEFS,
  buildingBit,
  buildingDefinition,
  buildingForSlot,
  buildingPrerequisiteMet,
  type BuildingDefinition,
  type BuildingResource
} from "./buildings";

/* ------------------------------------------------------------------ types */

export interface InputFrame {
  seq: number;
  moveX: number; // -1 | 0 | 1
  moveY: number;
  aim: number; // 0..255
  buttons: number;
  slot: number; // 1..37
}

export interface PlayerSim {
  id: number;
  name: string;
  bot: boolean;
  devMode: boolean;
  connected: boolean;
  x: number; // FP
  y: number;
  facing: number; // 0..255
  role: number;
  presentation: number;
  convertingUntilTick: number;
  stunUntilTick: number;
  slowedUntilTick: number;
  stamina: number; // 0..max (float ok, server-only)
  oxygen: number; // seconds remaining
  carriedGems: number;
  reinforceGems: number;
  gold: number;
  fossils: number;
  copper: number;
  iron: number;
  platinum: number;
  coal: number;
  power: number;
  powerCapacity: number;
  infrastructureUnlocked: boolean;
  buildingBlueprints: number;
  relics: number;
  refineryCycles: number;
  bombSpeedLevel: number;
  bombRangeLevel: number;
  bombWidthLevel: number;
  bombCapacityLevel: number;
  bombFeatures: number;
  visionLevel: number;
  moveSpeedLevel: number;
  healthLevel: number;
  health: number;
  nextNapalmDamageTick: number;
  nextFieldEffectTick: number;
  dynamite: number;
  c4: number;
  clusterBombs: number;
  napalm: number;
  nukes: number;
  turretKits: number;
  weaponBlueprints: number;
  wallUnlocked: boolean;
  securedGems: number;
  rubble: number;
  supportParts: number;
  pickDurability: number;
  selectedSlot: number;
  input: InputFrame;
  prevButtons: number;
  pendingInputs: InputFrame[];
  lastProcessedSeq: number;
  captureWindupEnd: number; // 0 = none
  captureCooldownEnd: number;
  huntCooldownEnd: number;
  nextWallBuildTick: number;
  lastWallNoticeTick: number;
  lastRejectedWallKey: string;
  rejectedWallRetryTick: number;
  digging: boolean;
  incapacitated: boolean;
  eliminated: boolean;
  wasConvertedAtTick: number;
  stats: {
    captures: number;
    cellsDug: number;
    gemsBanked: number;
    survivedTicks: number;
  };
  score: number;
}

export interface EntitySim {
  id: number;
  kind: number; // ENT.*
  x: number; // FP
  y: number;
  ownerId: number;
  cooldownEnd: number;
  bombFuseTicks?: number;
  blastRange?: number;
  blastHalfWidth?: number;
  blastNoiseFringe?: number;
  blastWobble?: number;
  blastStepTicks?: number;
  blastFeatures?: number;
  weaponKind?: number;
  facing?: number;
  flags?: number;
  baseId?: number;
  minerCount?: number;
  targetX?: number;
  targetY?: number;
  targetId?: number;
  targetEntityId?: number;
  retargetAt?: number;
  launchX?: number;
  launchY?: number;
  launchStartTick?: number;
  launchEndTick?: number;
  aim?: number;
  buildingKind?: number;
  health?: number;
  maxHealth?: number;
  disabledUntilTick?: number;
  trackProgress?: number;
  trackDirection?: number;
}

export interface ZombieSim extends EntitySim {
  facing: number;
  targetId: number;
  retargetAt: number;
  pathRefreshAt: number;
  waypointX: number;
  waypointY: number;
  attackCooldownEnd: number;
}

export interface GuardianSim extends EntitySim {
  homeX: number;
  homeY: number;
  targetId: number;
  attackCooldownEnd: number;
}

export type SimEvent =
  | { type: "patch"; cells: CellChange[]; revs: { cx: number; cy: number; rev: number }[] }
  | { type: "sound"; sound: number; x: number; y: number; intensity: number }
  | { type: "phase"; index: number; kind: PhaseKind | "countdown" | "ended"; endTick: number }
  | { type: "log"; playerId: number | null; msg: string }
  | { type: "feed"; kind: "down" | "loot" | "combat"; msg: string }
  | { type: "converted"; playerId: number }
  | { type: "entities"; added: EntitySim[]; removed: number[] }
  | {
      type: "end";
      winner: "miners" | "infected" | "player" | "draw";
      winnerPlayerId: number;
      scores: { id: number; name: string; role: number; score: number; captures: number; securedGems: number; survived: boolean }[];
    };

interface ScheduledCollapse {
  x: number;
  y: number;
  radius: number;
  atTick: number;
  warned: boolean;
}

interface ActiveBombBlast {
  ownerId: number;
  x: number;
  y: number;
  shapeSeed: number;
  range: number;
  halfWidth: number;
  noiseFringe: number;
  wobble: number;
  stepTicks: number;
  features: number;
  weaponKind: number;
  blueprint?: WeaponBlueprintId;
  aim: number;
  distance: number;
  nextTick: number;
  hitPlayers: Set<number>;
  hitEntities: Set<number>;
}

interface ScheduledEchoBlast {
  atTick: number;
  ownerId: number;
  x: number;
  y: number;
  weaponKind: number;
  range: number;
  halfWidth: number;
  features: number;
  aim: number;
}

function blueprintForWeaponKind(weaponKind: number | undefined): WeaponBlueprintId | undefined {
  if (weaponKind === undefined || weaponKind < 32) return undefined;
  return WEAPON_BLUEPRINT_IDS[weaponKind - 32];
}

type ResidualFieldKind = "acid-bomb" | "cryo-bomb" | "gas-bomb" | "emp-charge";

function residualFieldTicks(blueprint: WeaponBlueprintId | undefined): number {
  if (blueprint === "acid-bomb") return 180;
  if (blueprint === "cryo-bomb") return 150;
  if (blueprint === "gas-bomb") return 210;
  if (blueprint === "emp-charge") return 120;
  return 0;
}

function blastDamageMultiplier(weaponKind: number, blueprint: WeaponBlueprintId | undefined): number {
  if (weaponKind === WEAPON.DYNAMITE) return 1.15;
  if (weaponKind === WEAPON.C4) return 1.35;
  if (weaponKind === WEAPON.CLUSTER || weaponKind === WEAPON.CLUSTER_CHILD) return 0.55;
  if (weaponKind === WEAPON.NAPALM) return 0.55;
  if (weaponKind === WEAPON.NUKE) return 2;
  if (weaponKind === WEAPON.TURRET_SHELL) return 0.7;
  if (weaponKind === WEAPON.BASE_CORE) return 1.25;
  if (blueprint === "shaped-charge") return 1.45;
  if (blueprint === "sticky-bomb") return 1.25;
  if (blueprint === "material-bomb") return 1.2;
  if (blueprint === "collapse-charge" || blueprint === "drill-torpedo") return 1.1;
  if (blueprint === "acid-bomb") return 0.6;
  if (blueprint === "shrapnel-mine" || blueprint === "vampire-bomb") return 0.75;
  if (blueprint === "chain-bomb" || blueprint === "bouncing-bomb") return 0.9;
  return 1;
}

/* ------------------------------------------------------------ MatchSim */

export class MatchSim {
  readonly bal: Balance;
  readonly world: World;
  readonly map: GeneratedMap;
  readonly players: PlayerSim[] = [];
  readonly entities = new Map<number, EntitySim>();
  readonly zombies: ZombieSim[] = [];
  readonly guardians: GuardianSim[] = [];
  readonly events: SimEvent[] = [];

  tick = 0;
  phaseIndex = -1; // -1 countdown
  phaseEndTick = 0;
  zombieReleaseTick = Number.MAX_SAFE_INTEGER;
  ended = false;
  winner: "miners" | "infected" | "player" | "draw" | null = null;
  winnerPlayerId = -1;

  private ventilated: Uint8Array;
  private ventilationWorkspace: VentilationWorkspace = { queue: new Int32Array(65536) };
  private ventDirty = false;
  private lastVentRecompute = 0;
  private zombieReleaseAnnounced = false;
  private nextEntityId = 1;
  private collapses: ScheduledCollapse[] = [];
  private bombBlasts: ActiveBombBlast[] = [];
  private echoBlasts: ScheduledEchoBlast[] = [];
  private burningCells = new Map<string, { x: number; y: number; ownerId: number; endTick: number }>();
  private residualFields = new Map<string, { x: number; y: number; ownerId: number; endTick: number; kind: ResidualFieldKind }>();
  private botStuckTicks = new Map<number, number>();
  private botStuckPos = new Map<number, { x: number; y: number }>();
  private rngLoot: Rng;
  private rngCollapse: Rng;
  private rngZombies: Rng;
  private playerRadiusFp: number;

  constructor(seed: number, bal: Balance, names: { name: string; bot: boolean; devMode?: boolean }[]) {
    this.bal = bal;
    this.map = generateMap(seed, bal, names.length);
    this.world = this.map.world;
    this.rngLoot = new Rng(seed ^ 0x100c1);
    this.rngCollapse = new Rng(seed ^ 0xc0111);
    this.rngZombies = new Rng(seed ^ 0x20b1e5);
    this.playerRadiusFp = cellsToFp(bal.movement.playerRadiusCells);
    this.ventilated = computeVentilation(this.world, {
      workspace: this.ventilationWorkspace,
      ventCells: this.map.ventCells
    });

    const infectedIdx = bal.match.initialInfected > 0 ? new Rng(seed ^ 0x1f3c7ed).nextInt(names.length) : -1;
    names.forEach((n, i) => {
      const spawn = this.map.spawns[i];
      this.players.push(this.makePlayer(i, n.name, n.bot, spawn.x, spawn.y, i === infectedIdx, n.devMode ?? false));
    });

    for (const g of this.map.looseGems) {
      const e: EntitySim = {
        id: this.nextEntityId++,
        kind: g.kind === "reinforce" ? ENT.REINFORCE_GEM : ENT.GEM,
        x: cellsToFp(g.x + 0.5),
        y: cellsToFp(g.y + 0.5),
        ownerId: -1,
        cooldownEnd: 0
      };
      this.entities.set(e.id, e);
    }

    this.spawnPlayerZombies();
    this.spawnRuinTreasure();

    this.phaseEndTick = bal.match.countdownSeconds * TICK_HZ;
    this.events.push({ type: "phase", index: -1, kind: "countdown", endTick: this.phaseEndTick });
  }

  private makePlayer(id: number, name: string, bot: boolean, cx: number, cy: number, infected: boolean, devMode: boolean): PlayerSim {
    const player: PlayerSim = {
      id,
      name,
      bot,
      devMode,
      connected: true,
      x: cellsToFp(cx + 0.5),
      y: cellsToFp(cy + 0.5),
      facing: 0,
      role: infected ? ROLE.INFECTED : ROLE.MINER,
      presentation: PRES.DISGUISED,
      convertingUntilTick: 0,
      stunUntilTick: 0,
      slowedUntilTick: 0,
      stamina: this.bal.movement.staminaMax,
      oxygen: this.bal.oxygen.emergencySeconds,
      carriedGems: 0,
      reinforceGems: 0,
      gold: 0,
      fossils: 0,
      copper: 0,
      iron: 0,
      platinum: 0,
      coal: 0,
      power: 0,
      powerCapacity: 0,
      infrastructureUnlocked: false,
      buildingBlueprints: 0,
      relics: 0,
      refineryCycles: 0,
      bombSpeedLevel: 0,
      bombRangeLevel: 0,
      bombWidthLevel: 0,
      bombCapacityLevel: 0,
      bombFeatures: 0,
      visionLevel: 0,
      moveSpeedLevel: 0,
      healthLevel: 0,
      health: this.bal.combat.baseHealth,
      nextNapalmDamageTick: 0,
      nextFieldEffectTick: 0,
      dynamite: 0,
      c4: 0,
      clusterBombs: 0,
      napalm: 0,
      nukes: 0,
      turretKits: 0,
      weaponBlueprints: 0,
      wallUnlocked: false,
      securedGems: 0,
      rubble: 2,
      supportParts: 2,
      pickDurability: 0,
      selectedSlot: 1,
      input: { seq: 0, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 1 },
      prevButtons: 0,
      pendingInputs: [],
      lastProcessedSeq: 0,
      captureWindupEnd: 0,
      captureCooldownEnd: 0,
      huntCooldownEnd: 0,
      nextWallBuildTick: 0,
      lastWallNoticeTick: -TICK_HZ,
      lastRejectedWallKey: "",
      rejectedWallRetryTick: 0,
      digging: false,
      incapacitated: false,
      eliminated: false,
      wasConvertedAtTick: infected ? -1 : 0,
      stats: { captures: 0, cellsDug: 0, gemsBanked: 0, survivedTicks: 0 },
      score: 0
    };
    this.refillDevResources(player);
    return player;
  }

  private refillDevResources(p: PlayerSim): void {
    if (!p.devMode) return;
    p.carriedGems = 60000;
    p.reinforceGems = 60000;
    p.gold = 60000;
    p.fossils = 60000;
    p.copper = 60000;
    p.iron = 60000;
    p.platinum = 60000;
    p.coal = 60000;
    if (p.powerCapacity > 0) p.power = p.powerCapacity;
    p.buildingBlueprints = (1 << BUILDING_DEFS.length) - 1;
    p.rubble = this.bal.dig.rubbleMax;
    p.supportParts = 255;
    p.wallUnlocked = true;
    p.dynamite = 99;
    p.c4 = 99;
    p.clusterBombs = 99;
    p.napalm = 99;
    p.nukes = 99;
    p.turretKits = 99;
    p.weaponBlueprints = WEAPON_BLUEPRINT_IDS.reduce((mask, id) => (mask | weaponBlueprintBit(id)) >>> 0, 0);
    p.relics = RELIC.ECHO_CORE | RELIC.GEODE_HEART | RELIC.PHOENIX_CASING | RELIC.DEAD_MINERS_SWITCH;
  }

  /* -------------------------------------------------- phase helpers */

  phaseKind(): PhaseKind | "countdown" | "ended" {
    if (this.ended) return "ended";
    if (this.phaseIndex < 0) return "countdown";
    const p = this.bal.match.phases[this.phaseIndex];
    return p ? p.kind : "ended";
  }

  zombiesReleased(): boolean {
    return this.phaseIndex >= 0 && this.tick >= this.zombieReleaseTick;
  }

  /* -------------------------------------------------- input intake */

  queueInput(playerId: number, frame: InputFrame): void {
    const p = this.players[playerId];
    if (!p) return;
    if (frame.seq <= p.lastProcessedSeq) return;
    frame.moveX = Math.max(-1, Math.min(1, frame.moveX | 0));
    frame.moveY = Math.max(-1, Math.min(1, frame.moveY | 0));
    frame.aim &= 255;
    frame.slot = Math.max(1, Math.min(LAST_BUILDING_TOOL_SLOT, frame.slot | 0));
    const previous = p.pendingInputs[p.pendingInputs.length - 1] ?? p.input;
    const edgeButtons = BTN.PRIMARY | BTN.INTERACT | BTN.USE | BTN.PLACE | BTN.TRIGGER | BTN.HUNT;
    if ((frame.buttons & ~previous.buttons & edgeButtons) !== 0) {
      // An action should not sit behind stale movement after a frame or
      // network stall. Its newest position/aim also supersedes that backlog.
      p.pendingInputs.length = 0;
    } else if (p.pendingInputs.length >= 3) {
      // Bound ordinary input latency to roughly three simulation ticks.
      p.pendingInputs.shift();
    }
    p.pendingInputs.push(frame);
  }

  /* -------------------------------------------------- main tick (spec §18.1) */

  step(): void {
    if (this.ended) return;
    this.tick++;

    // 1. consume inputs
    for (const p of this.players) {
      const next = p.pendingInputs.shift();
      if (next) {
        p.prevButtons = p.input.buttons;
        p.input = next;
        p.lastProcessedSeq = next.seq;
      } else {
        p.prevButtons = p.input.buttons;
        // hold movement, but strip edge-triggered buttons so we don't re-fire
      }
    }

    // 2. phase state
    this.updatePhase();
    if (this.ended) return;

    const running = this.phaseIndex >= 0;

    if (running) {
      for (const p of this.players) {
        this.refillDevResources(p);
        // 3-4. movement + collision
        this.stepPlayerMovement(p);
        // 5. digging / placement (available throughout the daylight match)
        this.stepDigPlace(p);
        // 6. auto-collect nearby loose gems (walk-over pickup)
        this.stepAutoCollect(p);
        // 7. contextual actions + hunt form
        this.stepActions(p);
        // 8. infected capture after the zombie release
        this.stepCapture(p);
      }

      // Timed Bomberman-style bombs resolve before monsters choose targets.
      this.stepBombs();
      if (this.ended) return;

      this.stepBurningGround();
      if (this.ended) return;

      this.stepLandmarkHazards();
      if (this.ended) return;

      this.stepGuardians();
      this.stepTurrets();
      this.stepInfrastructure();
      this.stepHunters();
      this.stepOreCarts();
      this.stepAutoMiners();
      if (this.ended) return;

      // Spawn-point zombies remain dormant for the preparation window, then hunt.
      this.stepZombies();

      // 8. conversion timers
      for (const p of this.players) {
        if (p.convertingUntilTick > 0 && this.tick >= p.convertingUntilTick) {
          p.convertingUntilTick = 0;
          p.role = ROLE.INFECTED;
          p.presentation = this.zombiesReleased() ? PRES.HUNT : PRES.DISGUISED;
          p.wasConvertedAtTick = this.tick;
          p.carriedGems = 0; // unbanked gems lost on conversion (spec §9.3)
          this.events.push({ type: "converted", playerId: p.id });
          this.emitSound(SOUND.CAPTURE, p.x, p.y, 180);
          this.checkWinCondition();
        }
      }

      // 9. oxygen + status
      this.stepOxygen();

      // 10. anti-stuck: if bot hasn't moved > 1 cell in 120 ticks, clear around it
      this.stepBotUnstuck();

      // 11. scheduled collapses
      this.stepCollapses();

      // survivors accumulate time
      for (const p of this.players) if (p.role === ROLE.MINER && !p.eliminated) p.stats.survivedTicks++;
    }
  }

  private updatePhase(): void {
    if (this.tick < this.phaseEndTick) return;
    // advance phase
    this.phaseIndex++;
    const phases = this.bal.match.phases;
    if (this.phaseIndex >= phases.length) {
      // The daylight survival timer expired.
      this.endMatch(this.players.some((p) => p.role === ROLE.MINER && !p.eliminated) ? "miners" : "infected");
      return;
    }
    const def = phases[this.phaseIndex];
    this.phaseEndTick = def.seconds <= 0 ? 0xffffffff : this.tick + def.seconds * TICK_HZ;
    if (this.phaseIndex === 0) {
      this.zombieReleaseTick = this.tick + this.bal.zombies.releaseAfterSeconds * TICK_HZ;
    }
    this.events.push({ type: "phase", index: this.phaseIndex, kind: def.kind, endTick: this.phaseEndTick });

    if (this.phaseIndex === 0) this.onDayStart();
  }

  private onDayStart(): void {
    for (const p of this.players) {
      p.presentation = PRES.DISGUISED;
      p.captureWindupEnd = 0;
    }
  }

  /* -------------------------------------------------- movement */

  private stepPlayerMovement(p: PlayerSim): void {
    p.facing = p.input.aim;
    if (p.convertingUntilTick > 0 || this.tick < p.stunUntilTick || p.incapacitated || p.eliminated) return;

    const mv = this.bal.movement;
    let speedPx: number;
    const sprinting = (p.input.buttons & BTN.SPRINT) !== 0 && p.stamina > 1;
    if (p.role === ROLE.INFECTED && p.presentation === PRES.HUNT) speedPx = mv.infectedHunt;
    else if (sprinting) speedPx = mv.minerSprint;
    else speedPx = mv.minerWalk;
    speedPx *= 1 + p.moveSpeedLevel * this.bal.playerUpgrades.mobility.speedPercentPerLevel / 100;
    if (this.tick < p.slowedUntilTick) speedPx *= 0.52;

    // stamina
    if (sprinting && (p.input.moveX !== 0 || p.input.moveY !== 0) && p.presentation !== PRES.HUNT) {
      p.stamina = Math.max(0, p.stamina - mv.sprintDrainPerSec / TICK_HZ);
    } else {
      p.stamina = Math.min(mv.staminaMax, p.stamina + mv.staminaRegenPerSec / TICK_HZ);
    }

    let dx = p.input.moveX;
    let dy = p.input.moveY;
    if (dx === 0 && dy === 0) return;
    const inv = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
    const vFp = Math.round((speedPx / this.bal.world.cellPx / TICK_HZ) * FP * inv);
    const res = moveCircle(this.world, p.x, p.y, this.playerRadiusFp, dx * vFp, dy * vFp, this.infrastructureObstacles());
    p.x = res.x;
    p.y = res.y;

  }

  private infrastructureObstacles(): { x: number; y: number; radius: number }[] {
    return [...this.entities.values()]
      .filter((entity) => entity.kind === ENT.MINING_BASE || entity.kind === ENT.BUILDING)
      .map((entity) => ({
        x: entity.x,
        y: entity.y,
        radius: cellsToFp(entity.kind === ENT.MINING_BASE
          ? this.bal.automation.base.collisionRadiusCells
          : buildingDefinition(entity.buildingKind ?? -1)?.collisionRadius ?? 1.5)
      }));
  }

  /* -------------------------------------------------- dig & placement */

  private aimTargetCell(p: PlayerSim, reach: number): { x: number; y: number } {
    const ang = aimToRadians(p.input.aim);
    const px = p.x / FP;
    const py = p.y / FP;
    // walk forward from player to reach, stop just inside first solid
    let tx = px;
    let ty = py;
    for (let d = 1; d <= reach; d += 0.5) {
      const nx = px + Math.cos(ang) * d;
      const ny = py + Math.sin(ang) * d;
      tx = nx;
      ty = ny;
      if (this.world.isSolid(Math.floor(nx), Math.floor(ny))) break;
    }
    return { x: tx, y: ty };
  }

  /** Furthest empty cell along the aim ray. Construction must happen in
   *  excavated space, never by replacing rock or a vent. */
  private aimOpenCell(p: PlayerSim, reach: number): { x: number; y: number } {
    const ang = aimToRadians(p.input.aim);
    const px = p.x / FP;
    const py = p.y / FP;
    let tx = px;
    let ty = py;
    for (let d = 2; d <= reach; d += 0.5) {
      const nx = px + Math.cos(ang) * d;
      const ny = py + Math.sin(ang) * d;
      const mat = this.world.get(Math.floor(nx), Math.floor(ny));
      // Existing rigid walls do not pull the placement target toward the
      // player after building. They remain invalid candidate cells, but the
      // five-cell ghost stays anchored at the same aimed location.
      if (mat !== MAT.EMPTY && mat !== MAT.REINFORCE) break;
      tx = nx;
      ty = ny;
    }
    return { x: tx, y: ty };
  }

  private stepDigPlace(p: PlayerSim): void {
    p.digging = false;
    if (p.convertingUntilTick > 0 || this.tick < p.stunUntilTick || p.incapacitated || p.eliminated) return;
    const btn = p.input.buttons;
    const pressed = (b: number) => (btn & b) !== 0 && (p.prevButtons & b) === 0;
    const slotChanged = p.input.slot !== p.selectedSlot;
    if (slotChanged) {
      const slot = p.input.slot;
      p.selectedSlot = (slot >= 1 && slot <= 9) || slot === BASE_TOOL_SLOT || weaponTechForSlot(slot) !== undefined || buildingForSlot(slot) !== undefined ? slot : 1;
    }

    const hunting = p.role === ROLE.INFECTED && p.presentation === PRES.HUNT;

    // --- primary: dig/build at all times, or break while actively hunting ---
    if ((btn & BTN.PRIMARY) !== 0) {
      if (hunting) {
        // Capture is handled below; break an aimed weak obstacle when present.
        this.doMonsterBreak(p);
      } else if (p.selectedSlot === 1 && (pressed(BTN.PRIMARY) || slotChanged)) {
        this.placeBomb(p);
      } else if (p.selectedSlot === 2) {
        if (p.pickDurability > 0) this.doDig(p, minerDiggable);
        else if (pressed(BTN.PRIMARY) || slotChanged) this.craftPick(p);
      } else if (p.selectedSlot === 3 && this.tick >= p.nextWallBuildTick) {
        p.nextWallBuildTick = this.tick + this.bal.construction.rigidWall.buildIntervalTicks;
        this.placeRigidWall(p);
      } else if (p.selectedSlot >= 4 && p.selectedSlot <= 8 && (pressed(BTN.PRIMARY) || slotChanged)) {
        this.placeSpecialBomb(p, p.selectedSlot);
      } else if (p.selectedSlot === 9 && (pressed(BTN.PRIMARY) || slotChanged)) {
        this.placeTurret(p);
      } else if (p.selectedSlot >= 10 && (pressed(BTN.PRIMARY) || slotChanged)) {
        if (p.selectedSlot === BASE_TOOL_SLOT) this.placeMiningBase(p);
        else if (buildingForSlot(p.selectedSlot)) this.placeInfrastructureBuilding(p, p.selectedSlot);
        else this.placeBlueprintWeapon(p, p.selectedSlot);
      }
    }

    if (hunting) return;

    if (pressed(BTN.USE)) this.remoteDetonateBombs(p);

    if (pressed(BTN.INTERACT)) this.interactNearby(p);

    // --- R: place rubble ---
    if (pressed(BTN.PLACE)) {
      this.placeRubble(p);
    }

    // --- F: trigger own charges, or prepare a new one (day) ---
    if (pressed(BTN.TRIGGER)) {
      if (this.ownedCharges(p) > 0) this.triggerCharges(p);
      else this.placeCharge(p);
    }
  }

  private doDig(p: PlayerSim, canDig: (m: number) => boolean): void {
    const t = this.aimTargetCell(p, this.bal.dig.reachCells);
    const res = applyDigBrush(this.world, t.x, t.y, this.bal.dig.brushRadiusCells, this.bal.dig.damagePerTick, canDig);
    if (res.hitSolid) {
      p.digging = true;
      p.pickDurability = Math.max(0, p.pickDurability - 1);
      if (p.pickDurability === 0) this.events.push({ type: "log", playerId: p.id, msg: "Your pick wore out — craft another in slot 2" });
      if (this.tick % 8 === 0) this.emitSound(SOUND.DIG, p.x, p.y, 60);
    }
    if (res.cleared.length > 0) {
      p.stats.cellsDug += res.cleared.length;
      p.score += Math.ceil(res.cleared.length / 10);
      this.ventDirty = true;
      this.pushPatch(res.cleared);
      // rubble resource gain
      if (this.rngLoot.chance(this.bal.dig.rubbleGainChance) && p.rubble < this.bal.dig.rubbleMax) p.rubble++;
    }
    this.awardMinedMaterial(p, MAT.GEM, res.gemCellsCleared);
    this.awardMinedMaterial(p, MAT.REINFORCE_GEM, res.reinforceGemCellsCleared);
    this.awardMinedMaterial(p, MAT.GOLD, res.goldCellsCleared);
    this.awardMinedMaterial(p, MAT.FOSSIL, res.fossilCellsCleared);
    this.awardMinedMaterial(p, MAT.COPPER, res.copperCellsCleared);
    this.awardMinedMaterial(p, MAT.IRON, res.ironCellsCleared);
    this.awardMinedMaterial(p, MAT.PLATINUM, res.platinumCellsCleared);
    this.awardMinedMaterial(p, MAT.COAL, res.coalCellsCleared);
    for (const u of res.unstableCleared) {
      if (this.rngCollapse.chance(0.35)) this.scheduleCollapse(u.x, u.y, this.rngCollapse.range(5, 9));
    }
  }

  private craftPick(p: PlayerSim): void {
    const cfg = this.bal.items.pick;
    if (p.carriedGems < cfg.gemCost) {
      this.wallNotice(p, `A pick costs ${cfg.gemCost} common gems`);
      return;
    }
    p.carriedGems -= cfg.gemCost;
    p.pickDurability = cfg.durabilityTicks;
    this.events.push({ type: "log", playerId: p.id, msg: `Pick crafted — ${cfg.durabilityTicks / TICK_HZ}s of digging durability` });
    this.emitSound(SOUND.CRAFT, p.x, p.y, 120);
  }

  purchaseBombUpgrade(playerId: number, id: BombUpgradeId): boolean {
    const p = this.players[playerId];
    if (!p || this.phaseIndex < 0 || p.eliminated || p.incapacitated || p.convertingUntilTick > 0) return false;
    const quote = bombUpgradeQuotes(p, this.bal).find((candidate) => candidate.id === id);
    if (!quote) return false;
    if (quote.maxed) {
      this.events.push({ type: "log", playerId, msg: `${quote.label} is already maxed` });
      return false;
    }
    if (!quote.prerequisiteMet) {
      this.events.push({ type: "log", playerId, msg: `${quote.label}: ${quote.prerequisite}` });
      return false;
    }
    for (const [resource, amount] of Object.entries(quote.cost) as [CraftResource, number][]) {
      if (this.craftResourceAmount(p, resource) < amount) {
        this.events.push({ type: "log", playerId, msg: `Not enough materials for ${quote.label}` });
        return false;
      }
    }
    if (!p.devMode) for (const [resource, amount] of Object.entries(quote.cost) as [CraftResource, number][]) {
      this.spendCraftResource(p, resource, amount);
    }
    if (id === "speed") p.bombSpeedLevel++;
    else if (id === "range") p.bombRangeLevel++;
    else if (id === "width") p.bombWidthLevel++;
    else if (id === "capacity") p.bombCapacityLevel++;
    else if (id === "vision") p.visionLevel++;
    else if (id === "mobility") p.moveSpeedLevel++;
    else if (id === "vitality") {
      p.healthLevel++;
      p.health = Math.min(this.playerMaxHealth(p), p.health + this.bal.playerUpgrades.vitality.healthPerLevel);
    }
    else p.bombFeatures |= bombFeatureForUpgrade(id);
    this.events.push({ type: "log", playerId, msg: `${quote.label} crafted and installed` });
    this.emitSound(SOUND.CRAFT, p.x, p.y, 150);
    return true;
  }

  purchaseWeaponTech(playerId: number, id: WeaponBlueprintId): boolean {
    const p = this.players[playerId];
    if (!p || this.phaseIndex < 0 || p.eliminated || p.incapacitated || p.convertingUntilTick > 0) return false;
    const tech = weaponTechDefinition(id);
    if (!tech) return false;
    const owned = hasWeaponBlueprint(p.weaponBlueprints, id);
    if (!owned) {
      if (tech.prerequisite && !hasWeaponBlueprint(p.weaponBlueprints, tech.prerequisite)) {
        const prerequisite = weaponTechDefinition(tech.prerequisite)?.label ?? tech.prerequisite;
        this.events.push({ type: "log", playerId, msg: `${tech.label} requires ${prerequisite}` });
        return false;
      }
      const unlockEntries = Object.entries(tech.unlockCost) as [CraftResource, number][];
      if (!unlockEntries.every(([resource, amount]) => this.craftResourceAmount(p, resource) >= amount)) {
        this.events.push({ type: "log", playerId, msg: `Not enough materials to unlock ${tech.label}` });
        return false;
      }
      if (!p.devMode) for (const [resource, amount] of unlockEntries) this.spendCraftResource(p, resource, amount);
      p.weaponBlueprints = (p.weaponBlueprints | weaponBlueprintBit(id)) >>> 0;
      if (tech.inventory) p[tech.inventory] = Math.min(99, p[tech.inventory] + 1);
      this.events.push({ type: "log", playerId, msg: `${tech.label} blueprint unlocked${tech.inventory ? " — first payload crafted" : ""}` });
      this.emitSound(SOUND.CRAFT, p.x, p.y, 160);
      return true;
    }
    if (!tech.inventory || tech.ammoCost === undefined) {
      this.events.push({ type: "log", playerId, msg: `${tech.label} blueprint is already unlocked` });
      return false;
    }
    if (p[tech.inventory] >= 99) {
      this.events.push({ type: "log", playerId, msg: `${tech.label} inventory is full` });
      return false;
    }
    const ammoEntries = Object.entries(tech.ammoCost) as [CraftResource, number][];
    if (!ammoEntries.every(([resource, amount]) => this.craftResourceAmount(p, resource) >= amount)) {
      this.events.push({ type: "log", playerId, msg: `Not enough materials for a ${tech.label} payload` });
      return false;
    }
    if (!p.devMode) for (const [resource, amount] of ammoEntries) this.spendCraftResource(p, resource, amount);
    p[tech.inventory]++;
    this.events.push({ type: "log", playerId, msg: `${tech.label} payload crafted` });
    this.emitSound(SOUND.CRAFT, p.x, p.y, 145);
    return true;
  }

  private craftResourceAmount(p: PlayerSim, resource: CraftResource): number {
    if (resource === "common") return p.carriedGems;
    return p[resource];
  }

  private spendCraftResource(p: PlayerSim, resource: CraftResource, amount: number): void {
    if (resource === "common") p.carriedGems -= amount;
    else p[resource] -= amount;
  }

  private awardMinedMaterial(p: PlayerSim, mat: number, cells: number, refined = false): void {
    if (cells <= 0) return;
    if ((p.bombFeatures & BOMB_FEATURE.PROSPECTOR) !== 0) cells *= 2;
    if (refined && this.hasPoweredBuilding(p.id, BUILDING.ORE_REFINERY)) {
      p.refineryCycles += cells;
      const every = this.bal.automation.infrastructure.refineryBonusEvery;
      const bonus = Math.floor(p.refineryCycles / every);
      p.refineryCycles %= every;
      cells += bonus;
    }
    if (mat === MAT.GEM) {
      for (let i = 0; i < cells; i++) p.carriedGems += this.rngLoot.range(this.bal.gems.perGemRockMin, this.bal.gems.perGemRockMax);
    } else if (mat === MAT.REINFORCE_GEM) {
      const firstUnlock = !p.wallUnlocked;
      for (let i = 0; i < cells; i++) {
        p.reinforceGems += this.rngLoot.range(this.bal.gems.perReinforceRockMin, this.bal.gems.perReinforceRockMax);
      }
      p.wallUnlocked = true;
      if (firstUnlock) this.events.push({ type: "log", playerId: p.id, msg: "Rigid walls unlocked by reinforcement crystal" });
    } else if (mat === MAT.GOLD) p.gold += cells;
    else if (mat === MAT.FOSSIL) p.fossils += cells;
    else if (mat === MAT.COPPER) p.copper += cells;
    else if (mat === MAT.IRON) p.iron += cells;
    else if (mat === MAT.PLATINUM) p.platinum += cells;
    else if (mat === MAT.COAL) p.coal += cells;
    this.emitSound(SOUND.GEM, p.x, p.y, mat === MAT.REINFORCE_GEM || mat === MAT.PLATINUM ? 140 : 110);
  }

  private awardDigResult(owner: PlayerSim, result: DigResult, refined: boolean): void {
    if (result.cleared.length === 0) return;
    this.ventDirty = true;
    this.pushPatch(result.cleared);
    owner.stats.cellsDug += result.cleared.length;
    owner.score += Math.ceil(result.cleared.length / 12);
    this.awardMinedMaterial(owner, MAT.GEM, result.gemCellsCleared, refined);
    this.awardMinedMaterial(owner, MAT.REINFORCE_GEM, result.reinforceGemCellsCleared, refined);
    this.awardMinedMaterial(owner, MAT.GOLD, result.goldCellsCleared, refined);
    this.awardMinedMaterial(owner, MAT.FOSSIL, result.fossilCellsCleared, refined);
    this.awardMinedMaterial(owner, MAT.COPPER, result.copperCellsCleared, refined);
    this.awardMinedMaterial(owner, MAT.IRON, result.ironCellsCleared, refined);
    this.awardMinedMaterial(owner, MAT.PLATINUM, result.platinumCellsCleared, refined);
    this.awardMinedMaterial(owner, MAT.COAL, result.coalCellsCleared, refined);
    for (const unstable of result.unstableCleared) {
      if (this.rngCollapse.chance(0.35)) this.scheduleCollapse(unstable.x, unstable.y, this.rngCollapse.range(5, 9));
    }
  }

  private doMonsterBreak(p: PlayerSim): void {
    const t = this.aimTargetCell(p, 4);
    const m = this.world.get(Math.floor(t.x), Math.floor(t.y));
    if (!monsterBreakable(m)) return;
    const res = applyDigBrush(this.world, t.x, t.y, 2.2, 2, monsterBreakable);
    p.digging = res.hitSolid;
    if (this.tick % 6 === 0) this.emitSound(SOUND.RUBBLE_BREAK, p.x, p.y, 200); // deliberately loud (spec §11.3)
    if (res.cleared.length > 0) {
      this.ventDirty = true;
      this.pushPatch(res.cleared);
      p.score += 1;
    }
  }

  private placeRubble(p: PlayerSim): void {
    if (p.rubble <= 0) return;
    const t = this.aimTargetCell(p, 5);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    // must target empty cells, not overlapping any player
    for (const q of this.players) {
      const d2 = (q.x - cellsToFp(tx + 0.5)) ** 2 + (q.y - cellsToFp(ty + 0.5)) ** 2;
      if (d2 < cellsToFp(3) ** 2) return;
    }
    const changes = fillDisc(this.world, tx + 0.5, ty + 0.5, 1.8, MAT.RUBBLE, (m) => m === MAT.EMPTY);
    if (changes.length === 0) return;
    p.rubble--;
    this.ventDirty = true;
    this.pushPatch(changes);
    this.emitSound(SOUND.PLACE, p.x, p.y, 90);
  }

  private placeRigidWall(p: PlayerSim): void {
    const wall = this.bal.construction.rigidWall;
    if (!p.wallUnlocked) {
      this.wallNotice(p, "Find a blue reinforcement crystal to unlock rigid walls");
      return;
    }
    if (p.carriedGems < wall.gemCostPerCell) {
      this.wallNotice(p, `Rigid walls need ${wall.gemCostPerCell} common gem per cell`);
      return;
    }

    const t = this.aimOpenCell(p, wall.reachCells);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const ang = aimToRadians(p.input.aim);
    const vertical = Math.abs(Math.cos(ang)) >= Math.abs(Math.sin(ang));
    const half = Math.floor(wall.lengthCells / 2);
    const offsets = [0];
    for (let i = 1; i <= half; i++) offsets.push(-i, i);
    const candidates = offsets.map((i) => ({ x: vertical ? tx : tx + i, y: vertical ? ty + i : ty }));
    const actorCellBlocked = (x: number, y: number): boolean => {
      const blocked = (actor: { x: number; y: number }) => {
        const x0 = x * FP;
        const y0 = y * FP;
        const px = Math.max(x0, Math.min(actor.x, x0 + FP));
        const py = Math.max(y0, Math.min(actor.y, y0 + FP));
        return (actor.x - px) ** 2 + (actor.y - py) ** 2 < this.playerRadiusFp ** 2;
      };
      return this.players.some(blocked) || this.zombies.some(blocked);
    };
    const entityCellBlocked = (x: number, y: number): boolean =>
      [...this.entities.values()].some((e) => Math.floor(e.x / FP) === x && Math.floor(e.y / FP) === y);
    const physical = candidates.filter(
      (c) =>
        this.world.inBounds(c.x, c.y) &&
        this.world.get(c.x, c.y) === MAT.EMPTY &&
        !actorCellBlocked(c.x, c.y) &&
        !entityCellBlocked(c.x, c.y)
    );
    if (physical.length === 0) return;

    const affordableCount = Math.floor(p.carriedGems / wall.gemCostPerCell);
    const affordable = physical.slice(0, affordableCount);
    if (affordable.length === 0) {
      this.wallNotice(p, `Rigid walls need ${wall.gemCostPerCell} common gem per cell`);
      return;
    }
    const attemptKey = affordable.map((c) => `${c.x}:${c.y}`).join("|");
    if (attemptKey === p.lastRejectedWallKey && this.tick < p.rejectedWallRetryTick) return;

    // Protect only miners who currently have a route to a vent. Targeted BFS
    // avoids repeatedly scanning the entire 4096² world for a five-cell wall.
    const hasSafeAir = (q: PlayerSim): boolean => {
      const x = Math.floor(q.x / FP);
      const y = Math.floor(q.y / FP);
      return hasVentPath(this.world, x, y) || this.isInsidePoweredOxygenPocket(x, y);
    };
    const protectedMiners = this.players.filter((q) => {
      if (q.role !== ROLE.MINER || q.convertingUntilTick > 0) return false;
      return hasSafeAir(q);
    });
    const cutsMinerOxygen = (): boolean => protectedMiners.some((q) => !hasSafeAir(q));

    for (const c of affordable) this.world.setRaw(c.x, c.y, MAT.REINFORCE);
    const fullPieceIsSafe = !cutsMinerOxygen();
    for (const c of affordable) this.world.setRaw(c.x, c.y, MAT.EMPTY);

    let accepted: { x: number; y: number }[];
    if (fullPieceIsSafe) {
      accepted = affordable;
    } else if (affordable.length === 1) {
      accepted = [];
    } else {
      accepted = [];
      for (const c of affordable) {
        this.world.setRaw(c.x, c.y, MAT.REINFORCE);
        if (cutsMinerOxygen()) {
          this.world.setRaw(c.x, c.y, MAT.EMPTY);
        } else {
          accepted.push(c);
        }
      }
      for (const c of accepted) this.world.setRaw(c.x, c.y, MAT.EMPTY);
    }

    if (accepted.length === 0) {
      p.lastRejectedWallKey = attemptKey;
      p.rejectedWallRetryTick = this.tick + TICK_HZ;
      this.wallNotice(p, "Wall cell rejected: it would cut a miner off from oxygen");
      return;
    }

    const changes: CellChange[] = [];
    for (const c of accepted) {
      const ch = this.world.set(c.x, c.y, MAT.REINFORCE);
      if (ch) changes.push(ch);
    }
    if (changes.length !== accepted.length) return;
    p.carriedGems -= accepted.length * wall.gemCostPerCell;
    p.score += accepted.length;
    this.ventDirty = true;
    this.pushPatch(changes);
    this.emitSound(SOUND.PLACE, p.x, p.y, Math.min(180, 70 + accepted.length * 18));

    if (accepted.length < affordable.length) {
      const acceptedKeys = new Set(accepted.map((c) => `${c.x}:${c.y}`));
      p.lastRejectedWallKey = affordable
        .filter((c) => !acceptedKeys.has(`${c.x}:${c.y}`))
        .map((c) => `${c.x}:${c.y}`)
        .join("|");
      p.rejectedWallRetryTick = this.tick + TICK_HZ;
      this.wallNotice(p, `Built ${accepted.length}/${affordable.length} safe wall cells; oxygen route preserved`);
    } else {
      p.lastRejectedWallKey = "";
    }
  }

  private wallNotice(p: PlayerSim, msg: string): void {
    if (this.tick - p.lastWallNoticeTick < TICK_HZ) return;
    p.lastWallNoticeTick = this.tick;
    this.events.push({ type: "log", playerId: p.id, msg });
  }

  ownedCharges(p: PlayerSim): number {
    let n = 0;
    for (const e of this.entities.values()) if (e.kind === ENT.CHARGE && e.ownerId === p.id) n++;
    return n;
  }

  private placeCharge(p: PlayerSim): void {
    if (p.supportParts < this.bal.items.charge.supportCost) return;
    p.supportParts -= this.bal.items.charge.supportCost;
    const t = this.aimTargetCell(p, 5);
    const e: EntitySim = {
      id: this.nextEntityId++,
      kind: ENT.CHARGE,
      x: cellsToFp(t.x),
      y: cellsToFp(t.y),
      ownerId: p.id,
      cooldownEnd: 0
    };
    this.entities.set(e.id, e);
    this.events.push({ type: "entities", added: [e], removed: [] });
    this.emitSound(SOUND.PLACE, p.x, p.y, 70);
  }

  private triggerCharges(p: PlayerSim): void {
    const removed: number[] = [];
    for (const e of this.entities.values()) {
      if (e.kind !== ENT.CHARGE || e.ownerId !== p.id) continue;
      this.scheduleCollapse(Math.floor(e.x / FP), Math.floor(e.y / FP), this.bal.items.charge.collapseRadiusCells);
      removed.push(e.id);
    }
    for (const id of removed) this.entities.delete(id);
    if (removed.length) this.events.push({ type: "entities", added: [], removed });
  }

  ownedBombs(p: PlayerSim): number {
    let n = 0;
    for (const e of this.entities.values()) if (e.kind === ENT.BOMB && e.ownerId === p.id) n++;
    return n;
  }

  private placeBomb(p: PlayerSim): void {
    const cfg = this.bal.items.bomb;
    const cx = Math.floor(p.x / FP);
    const cy = Math.floor(p.y / FP);
    const upgrade = this.bal.bombUpgrades;
    const fuseTicks = Math.max(
      Math.min(cfg.fuseTicks, upgrade.speed.minFuseTicks),
      cfg.fuseTicks - p.bombSpeedLevel * upgrade.speed.fuseReductionTicks
    );
    this.spawnBomb(p, cx, cy, WEAPON.STANDARD, fuseTicks,
      cfg.blastRangeCells + p.bombRangeLevel * upgrade.range.rangePerLevelCells,
      cfg.blastHalfWidthCells + ((p.bombFeatures & BOMB_FEATURE.WIDE) !== 0 ? 1 : 0) + p.bombWidthLevel,
      p.bombFeatures
    );
  }

  private placeSpecialBomb(p: PlayerSim, slot: number): void {
    const kind = slot === 4 ? WEAPON.DYNAMITE : slot === 5 ? WEAPON.C4 : slot === 6 ? WEAPON.CLUSTER : slot === 7 ? WEAPON.NAPALM : WEAPON.NUKE;
    const inventoryKey = kind === WEAPON.DYNAMITE ? "dynamite" : kind === WEAPON.C4 ? "c4" : kind === WEAPON.CLUSTER ? "clusterBombs" : kind === WEAPON.NAPALM ? "napalm" : "nukes";
    if (p[inventoryKey] <= 0) {
      this.wallNotice(p, "Find this special weapon in a guarded ruin chest");
      return;
    }
    const special = this.bal.specialWeapons;
    const upgrade = this.bal.bombUpgrades;
    const rangeBonus = p.bombRangeLevel * upgrade.range.rangePerLevelCells;
    const widthBonus = p.bombWidthLevel + ((p.bombFeatures & BOMB_FEATURE.WIDE) !== 0 ? 1 : 0);
    let fuse: number;
    let range: number;
    let halfWidth: number;
    if (kind === WEAPON.DYNAMITE) {
      fuse = special.dynamite.fuseTicks;
      range = special.dynamite.rangeCells + rangeBonus;
      halfWidth = special.dynamite.halfWidthCells + widthBonus;
    } else if (kind === WEAPON.C4) {
      fuse = special.c4.fuseTicks;
      range = special.c4.rangeCells + rangeBonus;
      halfWidth = special.c4.halfWidthCells + widthBonus;
    } else if (kind === WEAPON.CLUSTER) {
      fuse = special.cluster.fuseTicks;
      range = special.cluster.rangeCells + rangeBonus;
      halfWidth = this.bal.items.bomb.blastHalfWidthCells + widthBonus;
    } else if (kind === WEAPON.NAPALM) {
      fuse = special.napalm.fuseTicks;
      range = special.napalm.rangeCells + rangeBonus;
      halfWidth = this.bal.items.bomb.blastHalfWidthCells + widthBonus;
    } else {
      fuse = special.nuke.fuseTicks;
      range = special.nuke.rangeCells + rangeBonus;
      halfWidth = special.nuke.halfWidthCells + widthBonus;
    }
    if (kind !== WEAPON.C4) {
      fuse = Math.max(this.bal.bombUpgrades.speed.minFuseTicks, fuse - p.bombSpeedLevel * this.bal.bombUpgrades.speed.fuseReductionTicks);
    }
    const features = p.bombFeatures | (kind === WEAPON.NUKE ? BOMB_FEATURE.DIAGONAL : 0);
    const placed = this.spawnBomb(p, Math.floor(p.x / FP), Math.floor(p.y / FP), kind, fuse, range, halfWidth, features, false, undefined, p.input.aim);
    if (placed && !p.devMode) p[inventoryKey]--;
  }

  private placeBlueprintWeapon(p: PlayerSim, slot: number): void {
    const tech = weaponTechForSlot(slot);
    if (!tech || tech.inventory !== undefined || !hasWeaponBlueprint(p.weaponBlueprints, tech.id)) {
      this.wallNotice(p, "Unlock this weapon blueprint in the Armory");
      return;
    }
    const profile = weaponFieldProfile(tech.id);
    if (!profile) return;
    const upgrade = this.bal.bombUpgrades;
    const range = profile.rangeCells + p.bombRangeLevel * upgrade.range.rangePerLevelCells;
    const halfWidth = profile.halfWidthCells + p.bombWidthLevel + ((p.bombFeatures & BOMB_FEATURE.WIDE) !== 0 ? 1 : 0);
    let fuse = Math.max(upgrade.speed.minFuseTicks, profile.fuseTicks - p.bombSpeedLevel * upgrade.speed.fuseReductionTicks);
    const features = p.bombFeatures | (profile.diagonal ? BOMB_FEATURE.DIAGONAL : 0);
    const weaponKind = weaponKindForBlueprint(tech.id);
    const playerCellX = Math.floor(p.x / FP);
    const playerCellY = Math.floor(p.y / FP);
    let targetX = playerCellX;
    let targetY = playerCellY;
    let ignoreTerrain = false;
    let launch: { fromX: number; fromY: number; delayTicks: number; flightTicks: number; flags?: number } | undefined;
    const angle = aimToRadians(p.input.aim);
    const traceTarget = (distance: number, passRock: boolean): { x: number; y: number } => {
      let x = playerCellX;
      let y = playerCellY;
      for (let step = 1; step <= distance; step++) {
        const nextX = Math.floor(p.x / FP + Math.cos(angle) * step);
        const nextY = Math.floor(p.y / FP + Math.sin(angle) * step);
        if (!this.world.inBounds(nextX, nextY)) break;
        const mat = this.world.get(nextX, nextY);
        if (mat === MAT.BEDROCK || mat === MAT.REINFORCE || (!passRock && this.world.isSolid(nextX, nextY))) break;
        x = nextX;
        y = nextY;
      }
      return { x, y };
    };

    if (tech.id === "drill-torpedo") {
      const target = traceTarget(Math.min(12, range), true);
      targetX = target.x;
      targetY = target.y;
      ignoreTerrain = true;
      launch = { fromX: p.x, fromY: p.y, delayTicks: 0, flightTicks: 24, flags: EFLAG.PROJECTILE | EFLAG.DRILLING };
    } else if (tech.id === "phase-bomb") {
      const distance = Math.min(10, range);
      targetX = Math.max(0, Math.min(this.world.size - 1, Math.floor(p.x / FP + Math.cos(angle) * distance)));
      targetY = Math.max(0, Math.min(this.world.size - 1, Math.floor(p.y / FP + Math.sin(angle) * distance)));
      ignoreTerrain = true;
      launch = { fromX: p.x, fromY: p.y, delayTicks: 0, flightTicks: 20, flags: EFLAG.PROJECTILE };
    } else if (tech.id === "bouncing-bomb") {
      const target = traceTarget(Math.min(10, range), false);
      targetX = target.x;
      targetY = target.y;
      ignoreTerrain = true;
      launch = { fromX: p.x, fromY: p.y, delayTicks: 0, flightTicks: 28, flags: EFLAG.AIRBORNE | EFLAG.BOUNCING };
    } else if (tech.id === "sticky-bomb") {
      const maxDistance2 = cellsToFp(8) ** 2;
      const target = this.players
        .filter((other) => other.id !== p.id && !other.eliminated)
        .map((other) => ({ other, d2: (other.x - p.x) ** 2 + (other.y - p.y) ** 2 }))
        .filter(({ other, d2 }) => d2 <= maxDistance2 && hasLineOfSight(this.world, p.x / FP, p.y / FP, other.x / FP, other.y / FP))
        .sort((a, b) => a.d2 - b.d2)[0]?.other;
      if (target) {
        targetX = Math.floor(target.x / FP);
        targetY = Math.floor(target.y / FP);
        ignoreTerrain = true;
      } else {
        const targetCell = this.aimOpenCell(p, 7);
        targetX = Math.floor(targetCell.x);
        targetY = Math.floor(targetCell.y);
      }
      const bomb = this.spawnBomb(p, targetX, targetY, weaponKind, fuse, range, halfWidth, features, ignoreTerrain, launch, p.input.aim);
      if (bomb && target) bomb.targetId = target.id;
      else if (bomb) {
        const attachRange2 = cellsToFp(2) ** 2;
        const attachment = [...this.entities.values()]
          .filter((entity) =>
            entity.id !== bomb.id &&
            (entity.kind === ENT.GUARDIAN || entity.kind === ENT.TURRET || entity.kind === ENT.MINING_BASE || entity.kind === ENT.AUTO_MINER ||
              entity.kind === ENT.BUILDING || entity.kind === ENT.HUNTER || entity.kind === ENT.ORE_CART) &&
            (entity.x - bomb.x) ** 2 + (entity.y - bomb.y) ** 2 <= attachRange2
          )
          .sort((a, b) =>
            ((a.x - bomb.x) ** 2 + (a.y - bomb.y) ** 2) -
            ((b.x - bomb.x) ** 2 + (b.y - bomb.y) ** 2)
          )[0];
        if (attachment) bomb.targetEntityId = attachment.id;
      }
      return;
    } else if (tech.id === "proximity-mine") {
      fuse = 36_000;
    }

    this.spawnBomb(
      p,
      targetX,
      targetY,
      weaponKind,
      fuse,
      range,
      halfWidth,
      features,
      ignoreTerrain,
      launch,
      p.input.aim
    );
  }

  ownedMiningBases(p: PlayerSim): number {
    let count = 0;
    for (const entity of this.entities.values()) if (entity.kind === ENT.MINING_BASE && entity.ownerId === p.id) count++;
    return count;
  }

  ownedAutoMiners(p: PlayerSim): number {
    let count = 0;
    for (const entity of this.entities.values()) if (entity.kind === ENT.AUTO_MINER && entity.ownerId === p.id) count++;
    return count;
  }

  private minersForBase(baseId: number): EntitySim[] {
    return [...this.entities.values()].filter((entity) => entity.kind === ENT.AUTO_MINER && entity.baseId === baseId);
  }

  private placeMiningBase(p: PlayerSim): void {
    const cfg = this.bal.automation.base;
    if (this.ownedMiningBases(p) >= cfg.maxPerPlayer) {
      this.wallNotice(p, "Only one mining base can be active");
      return;
    }
    if (p.carriedGems < cfg.commonCost || p.iron < cfg.ironCost) {
      this.wallNotice(p, `A mining base costs ${cfg.commonCost} common gems and ${cfg.ironCost} iron`);
      return;
    }
    const target = this.aimOpenCell(p, cfg.placementReachCells);
    const cx = Math.floor(target.x);
    const cy = Math.floor(target.y);
    // The visible footprint is smaller than the base's collision body. Keep a
    // full walking/miner apron clear so a legal placement cannot form a trap.
    const radius = cfg.siteClearanceRadiusCells;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const dx = x + 0.5 - (cx + 0.5);
        const dy = y + 0.5 - (cy + 0.5);
        if (dx * dx + dy * dy <= radius * radius && this.world.get(x, y) !== MAT.EMPTY) {
          this.wallNotice(p, "Mining bases need a larger clear excavated pad");
          return;
        }
      }
    }
    const xFp = cellsToFp(cx + 0.5);
    const yFp = cellsToFp(cy + 0.5);
    const clearanceFp = cellsToFp(cfg.collisionRadiusCells + this.bal.movement.playerRadiusCells);
    if ([...this.entities.values()].some((entity) => {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM || entity.kind === ENT.BLAST || entity.kind === ENT.FIRE) return false;
      return (entity.x - xFp) ** 2 + (entity.y - yFp) ** 2 < clearanceFp ** 2;
    })) {
      this.wallNotice(p, "The mining base footprint is occupied");
      return;
    }
    if (this.players.some((player) => !player.eliminated && (player.x - xFp) ** 2 + (player.y - yFp) ** 2 < clearanceFp ** 2)) {
      this.wallNotice(p, "Move everyone clear of the mining base footprint");
      return;
    }

    // Loose crystals are resources, not physical obstacles. If the base body
    // covers one, sweep it into the owner's inventory during construction.
    const sweptGems: number[] = [];
    const bodyRadiusFp = cellsToFp(cfg.collisionRadiusCells);
    for (const entity of this.entities.values()) {
      if (entity.kind !== ENT.GEM && entity.kind !== ENT.REINFORCE_GEM) continue;
      if ((entity.x - xFp) ** 2 + (entity.y - yFp) ** 2 >= bodyRadiusFp ** 2) continue;
      if (entity.kind === ENT.REINFORCE_GEM) {
        const firstUnlock = !p.wallUnlocked;
        p.reinforceGems++;
        p.wallUnlocked = true;
        if (firstUnlock) this.events.push({ type: "log", playerId: p.id, msg: "Rigid walls unlocked by reinforcement crystal" });
      } else {
        p.carriedGems++;
      }
      sweptGems.push(entity.id);
    }
    for (const id of sweptGems) this.entities.delete(id);
    if (sweptGems.length > 0) this.events.push({ type: "entities", added: [], removed: sweptGems });

    const base: EntitySim = {
      id: this.nextEntityId++,
      kind: ENT.MINING_BASE,
      x: xFp,
      y: yFp,
      ownerId: p.id,
      cooldownEnd: 0,
      minerCount: 0,
      health: this.bal.combat.bombDamage,
      maxHealth: this.bal.combat.bombDamage
    };
    this.entities.set(base.id, base);
    p.infrastructureUnlocked = true;
    if (!p.devMode) {
      p.carriedGems -= cfg.commonCost;
      p.iron -= cfg.ironCost;
    }
    this.events.push({ type: "entities", added: [base], removed: [] });
    this.spawnAutoMiner(base, p);
    this.events.push({ type: "log", playerId: p.id, msg: "Mining base deployed with one autonomous miner" });
    this.events.push({ type: "feed", kind: "loot", msg: `${p.name} established a mining base` });
    this.emitSound(SOUND.CRAFT, base.x, base.y, 170);
  }

  private buildingResourceAmount(p: PlayerSim, resource: BuildingResource): number {
    return resource === "common" ? p.carriedGems : p[resource];
  }

  private canAffordBuilding(p: PlayerSim, definition: BuildingDefinition): boolean {
    return Object.entries(definition.cost).every(([resource, amount]) =>
      this.buildingResourceAmount(p, resource as BuildingResource) >= (amount ?? 0)
    );
  }

  private spendBuildingCost(p: PlayerSim, definition: BuildingDefinition): void {
    if (p.devMode) return;
    for (const [resource, amount] of Object.entries(definition.cost) as [BuildingResource, number][]) {
      if (resource === "common") p.carriedGems -= amount;
      else p[resource] -= amount;
    }
  }

  private buildingCostText(definition: BuildingDefinition): string {
    return Object.entries(definition.cost).map(([resource, amount]) => `${amount} ${resource}`).join(", ");
  }

  private isInsideOwnerGrid(ownerId: number, x: number, y: number): boolean {
    const cfg = this.bal.automation.infrastructure;
    const baseRadius2 = cellsToFp(cfg.baseGridRadiusCells) ** 2;
    const relayRadius2 = cellsToFp(cfg.relayLinkRadiusCells) ** 2;
    for (const entity of this.entities.values()) {
      if (entity.ownerId !== ownerId) continue;
      const d2 = (entity.x - x) ** 2 + (entity.y - y) ** 2;
      if (entity.kind === ENT.MINING_BASE && d2 <= baseRadius2) return true;
      if (
        entity.kind === ENT.BUILDING && entity.buildingKind === BUILDING.POWER_RELAY &&
        ((entity.flags ?? 0) & BUILDING_FLAG.CONNECTED) !== 0 && d2 <= relayRadius2
      ) return true;
    }
    return false;
  }

  private placeInfrastructureBuilding(p: PlayerSim, slot: number): void {
    const definition = buildingForSlot(slot);
    if (!definition) return;
    if (!p.infrastructureUnlocked || this.ownedMiningBases(p) === 0) {
      this.wallNotice(p, "Deploy a mining base before constructing outpost machinery");
      return;
    }
    if (!buildingPrerequisiteMet(p.buildingBlueprints, definition)) {
      const required = buildingDefinition(definition.prerequisite ?? -1)?.label ?? "prerequisite building";
      this.wallNotice(p, `${definition.label} requires a ${required}`);
      return;
    }
    if (!this.canAffordBuilding(p, definition)) {
      this.wallNotice(p, `${definition.label} costs ${this.buildingCostText(definition)}`);
      return;
    }

    const target = this.aimOpenCell(p, this.bal.automation.infrastructure.placementReachCells);
    const cx = Math.floor(target.x);
    const cy = Math.floor(target.y);
    const radius = definition.footprintRadius;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const dx = x + 0.5 - (cx + 0.5);
        const dy = y + 0.5 - (cy + 0.5);
        if (dx * dx + dy * dy <= radius * radius && this.world.get(x, y) !== MAT.EMPTY) {
          this.wallNotice(p, `${definition.label} needs a clear excavated footprint`);
          return;
        }
      }
    }
    const xFp = cellsToFp(cx + 0.5);
    const yFp = cellsToFp(cy + 0.5);
    if (!this.isInsideOwnerGrid(p.id, xFp, yFp)) {
      this.wallNotice(p, "This site is outside the base grid — extend it with a Cable Relay");
      return;
    }
    const occupied = [...this.entities.values()].some((entity) => {
      const otherRadius = entity.kind === ENT.MINING_BASE
        ? this.bal.automation.base.collisionRadiusCells
        : entity.kind === ENT.BUILDING
          ? buildingDefinition(entity.buildingKind ?? -1)?.collisionRadius ?? 1.5
          : 1;
      const minDistance = cellsToFp(definition.collisionRadius + otherRadius + 0.5);
      return (entity.x - xFp) ** 2 + (entity.y - yFp) ** 2 < minDistance ** 2;
    });
    if (occupied || this.players.some((player) => {
      const minDistance = cellsToFp(definition.collisionRadius + this.bal.movement.playerRadiusCells + 0.5);
      return !player.eliminated && (player.x - xFp) ** 2 + (player.y - yFp) ** 2 < minDistance ** 2;
    })) {
      this.wallNotice(p, `${definition.label} footprint is occupied`);
      return;
    }

    const building: EntitySim = {
      id: this.nextEntityId++,
      kind: ENT.BUILDING,
      buildingKind: definition.kind,
      x: xFp,
      y: yFp,
      ownerId: p.id,
      cooldownEnd: this.tick,
      health: definition.health,
      maxHealth: definition.health,
      flags: 0
    };
    this.entities.set(building.id, building);
    this.spendBuildingCost(p, definition);
    p.buildingBlueprints = (p.buildingBlueprints | buildingBit(definition.kind)) >>> 0;
    this.events.push({ type: "entities", added: [building], removed: [] });
    this.events.push({ type: "log", playerId: p.id, msg: `${definition.label} constructed` });
    this.emitSound(SOUND.CRAFT, building.x, building.y, 145);
  }

  private hasPoweredBuilding(ownerId: number, kind: number): boolean {
    for (const entity of this.entities.values()) {
      if (
        entity.kind === ENT.BUILDING && entity.ownerId === ownerId && entity.buildingKind === kind &&
        ((entity.flags ?? 0) & BUILDING_FLAG.POWERED) !== 0
      ) return true;
    }
    return false;
  }

  private poweredBuildingCount(ownerId: number, kind: number): number {
    let count = 0;
    for (const entity of this.entities.values()) {
      if (
        entity.kind === ENT.BUILDING && entity.ownerId === ownerId && entity.buildingKind === kind &&
        ((entity.flags ?? 0) & BUILDING_FLAG.POWERED) !== 0
      ) count++;
    }
    return count;
  }

  private recomputePowerGrid(p: PlayerSim): void {
    const cfg = this.bal.automation.infrastructure;
    const bases = [...this.entities.values()].filter((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id);
    const buildings = [...this.entities.values()].filter((entity) => entity.kind === ENT.BUILDING && entity.ownerId === p.id);
    for (const building of buildings) building.flags = (building.flags ?? 0) & ~BUILDING_FLAG.CONNECTED;
    if (bases.length === 0) {
      p.power = 0;
      p.powerCapacity = 0;
      for (const building of buildings) building.flags = 0;
      return;
    }

    const baseRadius2 = cellsToFp(cfg.baseGridRadiusCells) ** 2;
    const relayRadius2 = cellsToFp(cfg.relayLinkRadiusCells) ** 2;
    const connectedRelays: EntitySim[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const relay of buildings) {
        if (relay.buildingKind !== BUILDING.POWER_RELAY || connectedRelays.includes(relay)) continue;
        if ((relay.disabledUntilTick ?? 0) > this.tick) continue;
        const linkedToBase = bases.some((base) => (base.x - relay.x) ** 2 + (base.y - relay.y) ** 2 <= baseRadius2);
        const linkedToRelay = connectedRelays.some((other) => (other.x - relay.x) ** 2 + (other.y - relay.y) ** 2 <= relayRadius2);
        if (linkedToBase || linkedToRelay) {
          connectedRelays.push(relay);
          changed = true;
        }
      }
    }

    for (const building of buildings) {
      const linkedToBase = bases.some((base) => (base.x - building.x) ** 2 + (base.y - building.y) ** 2 <= baseRadius2);
      const linkedToRelay = connectedRelays.some((relay) => (relay.x - building.x) ** 2 + (relay.y - building.y) ** 2 <= relayRadius2);
      if (linkedToBase || linkedToRelay) building.flags = (building.flags ?? 0) | BUILDING_FLAG.CONNECTED;
      else building.flags = (building.flags ?? 0) & ~(BUILDING_FLAG.POWERED | BUILDING_FLAG.ACTIVE);
      if ((building.disabledUntilTick ?? 0) > this.tick) building.flags = (building.flags ?? 0) & ~(BUILDING_FLAG.CONNECTED | BUILDING_FLAG.POWERED | BUILDING_FLAG.ACTIVE);
    }

    p.powerCapacity = cfg.baseCapacity + buildings.filter((building) =>
      building.buildingKind === BUILDING.BATTERY_BANK && ((building.flags ?? 0) & BUILDING_FLAG.CONNECTED) !== 0 &&
      (building.disabledUntilTick ?? 0) <= this.tick
    ).length * cfg.batteryCapacity;
    p.power = Math.min(p.power, p.powerCapacity);
    if (this.tick % cfg.gridIntervalTicks !== 0) return;

    for (const building of buildings) building.flags = (building.flags ?? 0) & ~(BUILDING_FLAG.POWERED | BUILDING_FLAG.ACTIVE);
    for (const generator of buildings) {
      if (generator.buildingKind !== BUILDING.COAL_GENERATOR || ((generator.flags ?? 0) & BUILDING_FLAG.CONNECTED) === 0) continue;
      if ((generator.disabledUntilTick ?? 0) > this.tick) continue;
      generator.flags = (generator.flags ?? 0) | BUILDING_FLAG.POWERED;
      if (generator.cooldownEnd > this.tick) {
        generator.flags |= BUILDING_FLAG.ACTIVE;
        continue;
      }
      if (p.coal <= 0 || p.power >= p.powerCapacity) continue;
      if (!p.devMode) p.coal--;
      p.power = Math.min(p.powerCapacity, p.power + cfg.powerPerCoal);
      generator.cooldownEnd = this.tick + cfg.generatorIntervalTicks;
      generator.flags |= BUILDING_FLAG.ACTIVE;
    }
    for (const building of buildings) {
      if (((building.flags ?? 0) & BUILDING_FLAG.CONNECTED) === 0 || (building.disabledUntilTick ?? 0) > this.tick) continue;
      const definition = buildingDefinition(building.buildingKind ?? -1);
      if (!definition || definition.kind === BUILDING.COAL_GENERATOR) continue;
      if (definition.powerDraw === 0 || p.power >= definition.powerDraw) {
        if (!p.devMode) p.power -= definition.powerDraw;
        building.flags = (building.flags ?? 0) | BUILDING_FLAG.POWERED;
      }
    }
  }

  private poweredShieldMultiplier(ownerId: number, x: number, y: number): number {
    const definition = buildingDefinition(BUILDING.SHIELD_PYLON)!;
    const range2 = cellsToFp(definition.range) ** 2;
    const protectedByShield = [...this.entities.values()].some((building) =>
      building.kind === ENT.BUILDING && building.ownerId === ownerId && building.buildingKind === BUILDING.SHIELD_PYLON &&
      ((building.flags ?? 0) & BUILDING_FLAG.POWERED) !== 0 &&
      (building.x - x) ** 2 + (building.y - y) ** 2 <= range2
    );
    return protectedByShield ? this.bal.automation.infrastructure.shieldDamageMultiplier : 1;
  }

  private stepInfrastructure(): void {
    for (const player of this.players) this.recomputePowerGrid(player);
    const cfg = this.bal.automation.infrastructure;
    for (const building of [...this.entities.values()]) {
      if (building.kind !== ENT.BUILDING || ((building.flags ?? 0) & BUILDING_FLAG.POWERED) === 0 || building.cooldownEnd > this.tick) continue;
      const definition = buildingDefinition(building.buildingKind ?? -1);
      const owner = this.players[building.ownerId];
      if (!definition || !owner) continue;

      if (definition.kind === BUILDING.SENTRY_GUN) {
        const range2 = cellsToFp(definition.range) ** 2;
        const target = this.players
          .filter((player) => player.id !== owner.id && !player.eliminated)
          .map((player) => ({ player, d2: (player.x - building.x) ** 2 + (player.y - building.y) ** 2 }))
          .filter(({ player, d2 }) => d2 <= range2 && hasLineOfSight(this.world, building.x / FP, building.y / FP, player.x / FP, player.y / FP))
          .sort((a, b) => a.d2 - b.d2)[0]?.player;
        building.cooldownEnd = this.tick + (target ? cfg.sentryFireIntervalTicks : 15);
        if (target) {
          const fired = this.spawnBomb(owner, Math.floor(target.x / FP), Math.floor(target.y / FP), WEAPON.TURRET_SHELL,
            cfg.sentryShellFuseTicks, cfg.sentryShellRangeCells + owner.bombRangeLevel, 1 + owner.bombWidthLevel,
            owner.bombFeatures & (BOMB_FEATURE.WIDE | BOMB_FEATURE.SHIELD), true);
          if (fired) this.emitSound(SOUND.PLACE, building.x, building.y, 135);
        }
      } else if (definition.kind === BUILDING.ARC_COIL) {
        const range2 = cellsToFp(definition.range) ** 2;
        const target = this.players
          .filter((player) => player.id !== owner.id && !player.eliminated)
          .map((player) => ({ player, d2: (player.x - building.x) ** 2 + (player.y - building.y) ** 2 }))
          .filter(({ player, d2 }) => d2 <= range2 && hasLineOfSight(this.world, building.x / FP, building.y / FP, player.x / FP, player.y / FP))
          .sort((a, b) => a.d2 - b.d2)[0]?.player;
        building.cooldownEnd = this.tick + (target ? cfg.arcIntervalTicks : 12);
        if (target) {
          target.stunUntilTick = Math.max(target.stunUntilTick, this.tick + cfg.arcStunTicks);
          this.damagePlayer(target, cfg.arcDamage, `${owner.name}'s arc coil`, `${owner.name}'s arc coil`);
          this.emitSound(SOUND.STUN, target.x, target.y, 180);
        }
      } else if (definition.kind === BUILDING.REPAIR_DEPOT) {
        const range2 = cellsToFp(definition.range) ** 2;
        let repaired = false;
        for (const target of this.entities.values()) {
          if (target.ownerId !== owner.id || (target.kind !== ENT.BUILDING && target.kind !== ENT.MINING_BASE)) continue;
          if (target.health === undefined || target.maxHealth === undefined || target.health >= target.maxHealth) continue;
          if ((target.x - building.x) ** 2 + (target.y - building.y) ** 2 > range2) continue;
          target.health = Math.min(target.maxHealth, target.health + cfg.repairAmount);
          repaired = true;
        }
        building.cooldownEnd = this.tick + (repaired ? cfg.repairIntervalTicks : 20);
        if (repaired) building.flags = (building.flags ?? 0) | BUILDING_FLAG.ACTIVE;
      } else if (definition.kind === BUILDING.DIGGER_BARRACKS) {
        const diggers = this.minersForBase(building.id);
        const hunters = [...this.entities.values()].filter((entity) => entity.kind === ENT.HUNTER && entity.baseId === building.id);
        let deployed = false;
        if (diggers.length < cfg.barracksDiggerCap && owner.carriedGems >= cfg.barracksDiggerCommonCost && owner.iron >= cfg.barracksDiggerIronCost) {
          if (this.spawnAutoMiner(building, owner, cfg.barracksDiggerCap)) {
            if (!owner.devMode) {
              owner.carriedGems -= cfg.barracksDiggerCommonCost;
              owner.iron -= cfg.barracksDiggerIronCost;
            }
            deployed = true;
          }
        }
        if (hunters.length < cfg.barracksHunterCap && owner.carriedGems >= cfg.barracksHunterCommonCost && owner.iron >= cfg.barracksHunterIronCost) {
          if (this.spawnBarracksHunter(building, owner, hunters.length)) {
            if (!owner.devMode) {
              owner.carriedGems -= cfg.barracksHunterCommonCost;
              owner.iron -= cfg.barracksHunterIronCost;
            }
            deployed = true;
          }
        }
        building.cooldownEnd = this.tick + cfg.barracksSpawnIntervalTicks;
        if (deployed) {
          building.flags = (building.flags ?? 0) | BUILDING_FLAG.ACTIVE;
          this.emitSound(SOUND.CRAFT, building.x, building.y, 120);
        }
      } else if (definition.kind === BUILDING.DEEP_DRILL) {
        const target = this.findDeepDrillTarget(building, definition.range || cfg.drillWorkRadiusCells);
        building.cooldownEnd = this.tick + cfg.drillIntervalTicks;
        if (target) {
          const dx = target.x + 0.5 - building.x / FP;
          const dy = target.y + 0.5 - building.y / FP;
          const distanceToTarget = Math.max(0.1, Math.hypot(dx, dy));
          const angle = Math.atan2(dy, dx);
          building.facing = Math.round((((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
          let workCell: { x: number; y: number } | undefined;
          for (let distance = definition.collisionRadius; distance <= distanceToTarget; distance += 0.4) {
            const x = Math.floor(building.x / FP + dx / distanceToTarget * distance);
            const y = Math.floor(building.y / FP + dy / distanceToTarget * distance);
            const material = this.world.get(x, y);
            if (material === MAT.EMPTY || material === MAT.VENT) continue;
            if (minerDiggable(material)) workCell = { x, y };
            break;
          }
          if (workCell) {
            building.flags = (building.flags ?? 0) | BUILDING_FLAG.ACTIVE;
            const result = applyDigBrush(this.world, workCell.x + 0.5, workCell.y + 0.5, cfg.drillRadiusCells, cfg.drillDamage, minerDiggable);
            this.awardDigResult(owner, result, true);
            if (result.hitSolid && this.tick % 12 === 0) this.emitSound(SOUND.DIG, building.x, building.y, 105);
          }
        }
      } else if (definition.kind === BUILDING.TRACK_DEPOT) {
        const base = this.nearestOwnedBase(owner.id, building.x, building.y);
        const cart = [...this.entities.values()].find((entity) => entity.kind === ENT.ORE_CART && entity.baseId === building.id);
        if (base && !hasLineOfSight(this.world, building.x / FP, building.y / FP, base.x / FP, base.y / FP)) {
          const dx = base.x / FP - building.x / FP;
          const dy = base.y / FP - building.y / FP;
          const length = Math.max(1, Math.hypot(dx, dy));
          for (let distance = definition.collisionRadius; distance < length; distance += 0.5) {
            const x = Math.floor(building.x / FP + dx / length * distance);
            const y = Math.floor(building.y / FP + dy / length * distance);
            const material = this.world.get(x, y);
            if (material === MAT.EMPTY || material === MAT.VENT) continue;
            if (minerDiggable(material)) {
              const result = applyDigBrush(this.world, x + 0.5, y + 0.5, 1.6, cfg.drillDamage, minerDiggable);
              this.awardDigResult(owner, result, true);
              if (result.hitSolid) this.emitSound(SOUND.DIG, building.x, building.y, 85);
            }
            break;
          }
        } else if (base && !cart) this.spawnOreCart(building, base, owner);
        building.cooldownEnd = this.tick + 12;
        if (base) building.flags = (building.flags ?? 0) | BUILDING_FLAG.ACTIVE;
      } else if (definition.kind === BUILDING.DRILL_FORGE) {
        building.cooldownEnd = this.tick + 12;
        building.flags = (building.flags ?? 0) | BUILDING_FLAG.ACTIVE;
      }
    }
  }

  private findDeepDrillTarget(drill: EntitySim, radius: number): { x: number; y: number } | null {
    const cx = drill.x / FP;
    const cy = drill.y / FP;
    let best: { x: number; y: number; score: number } | null = null;
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.world.size - 1, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.world.size - 1, Math.ceil(cx + radius)); x++) {
        const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        if (d2 > radius * radius) continue;
        const material = this.world.get(x, y);
        if (!minerDiggable(material)) continue;
        const resource = material === MAT.GEM || material === MAT.REINFORCE_GEM || material === MAT.GOLD || material === MAT.FOSSIL ||
          material === MAT.COPPER || material === MAT.IRON || material === MAT.PLATINUM || material === MAT.COAL;
        const score = (resource ? 100000 : 0) - d2 + ((x * 23 + y * 47 + drill.id) & 15) * 0.05;
        if (!best || score > best.score) best = { x, y, score };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private nearestOwnedBase(ownerId: number, x: number, y: number): EntitySim | undefined {
    return [...this.entities.values()]
      .filter((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === ownerId)
      .sort((a, b) => ((a.x - x) ** 2 + (a.y - y) ** 2) - ((b.x - x) ** 2 + (b.y - y) ** 2))[0];
  }

  private spawnOutside(source: EntitySim, ordinal: number, bodyRadius: number): { x: number; y: number } | null {
    const sourceRadius = source.kind === ENT.MINING_BASE
      ? this.bal.automation.base.collisionRadiusCells
      : buildingDefinition(source.buildingKind ?? -1)?.collisionRadius ?? 2;
    const distance = Math.ceil(sourceRadius + bodyRadius + 0.7);
    for (let attempt = 0; attempt < 32; attempt++) {
      const angle = ((ordinal * 11 + attempt) / 32) * Math.PI * 2;
      const cx = Math.floor(source.x / FP + Math.cos(angle) * distance);
      const cy = Math.floor(source.y / FP + Math.sin(angle) * distance);
      if (this.world.get(cx, cy) !== MAT.EMPTY) continue;
      const x = cellsToFp(cx + 0.5);
      const y = cellsToFp(cy + 0.5);
      if ([...this.entities.values()].some((entity) =>
        (entity.kind === ENT.AUTO_MINER || entity.kind === ENT.HUNTER) &&
        (entity.x - x) ** 2 + (entity.y - y) ** 2 < cellsToFp(1.5) ** 2
      )) continue;
      return { x, y };
    }
    return null;
  }

  private spawnAutoMiner(base: EntitySim, owner: PlayerSim, cap = this.bal.automation.miner.maxPerBase): EntitySim | null {
    const cfg = this.bal.automation.miner;
    const current = this.minersForBase(base.id);
    if (current.length >= cap) return null;
    const ordinal = current.length;
    // Start outside the base body. The owning player is a safe fallback when
    // the base is deployed in a narrow chamber with only one open approach.
    let spawnX = owner.x;
    let spawnY = owner.y;
    const spawn = this.spawnOutside(base, ordinal, cfg.bodyRadiusCells);
    if (spawn) { spawnX = spawn.x; spawnY = spawn.y; }
    else if (base.kind === ENT.BUILDING) return null;
    const miner: EntitySim = {
      id: this.nextEntityId++,
      kind: ENT.AUTO_MINER,
      x: spawnX,
      y: spawnY,
      ownerId: owner.id,
      cooldownEnd: this.tick,
      facing: (ordinal * 53) & 255,
      flags: 0,
      baseId: base.id,
      retargetAt: 0
    };
    this.entities.set(miner.id, miner);
    base.minerCount = current.length + 1;
    this.events.push({ type: "entities", added: [miner], removed: [] });
    return miner;
  }

  private spawnBarracksHunter(barracks: EntitySim, owner: PlayerSim, ordinal: number): EntitySim | null {
    const spawn = this.spawnOutside(barracks, ordinal + 8, 0.9);
    if (!spawn) return null;
    const hunter: EntitySim = {
      id: this.nextEntityId++, kind: ENT.HUNTER, x: spawn.x, y: spawn.y, ownerId: owner.id,
      cooldownEnd: this.tick, facing: (ordinal * 91) & 255, flags: 0, baseId: barracks.id,
      retargetAt: this.tick, health: 70, maxHealth: 70
    };
    this.entities.set(hunter.id, hunter);
    this.events.push({ type: "entities", added: [hunter], removed: [] });
    return hunter;
  }

  private spawnOreCart(depot: EntitySim, base: EntitySim, owner: PlayerSim): EntitySim {
    const cart: EntitySim = {
      id: this.nextEntityId++, kind: ENT.ORE_CART, x: depot.x, y: depot.y, ownerId: owner.id,
      cooldownEnd: this.tick, facing: 0, flags: EFLAG.DRILLING, baseId: depot.id,
      targetEntityId: base.id, trackProgress: 0, trackDirection: 1
    };
    this.entities.set(cart.id, cart);
    this.events.push({ type: "entities", added: [cart], removed: [] });
    return cart;
  }

  private stepHunters(): void {
    const cfg = this.bal.automation.infrastructure;
    const radiusFp = cellsToFp(0.8);
    for (const hunter of [...this.entities.values()]) {
      if (hunter.kind !== ENT.HUNTER) continue;
      const barracks = this.entities.get(hunter.baseId ?? -1);
      const owner = this.players[hunter.ownerId];
      if (!barracks || barracks.kind !== ENT.BUILDING || barracks.buildingKind !== BUILDING.DIGGER_BARRACKS || !owner) {
        this.entities.delete(hunter.id);
        this.events.push({ type: "entities", added: [], removed: [hunter.id] });
        continue;
      }
      const range2 = cellsToFp(cfg.hunterRangeCells) ** 2;
      const target = this.players
        .filter((player) => player.id !== owner.id && !player.eliminated)
        .map((player) => ({ player, d2: (player.x - hunter.x) ** 2 + (player.y - hunter.y) ** 2 }))
        .filter(({ player, d2 }) => d2 <= range2 && hasLineOfSight(this.world, hunter.x / FP, hunter.y / FP, player.x / FP, player.y / FP))
        .sort((a, b) => a.d2 - b.d2)[0]?.player;
      if (target) {
        hunter.targetId = target.id;
        hunter.targetX = target.x / FP;
        hunter.targetY = target.y / FP;
        if ((target.x - hunter.x) ** 2 + (target.y - hunter.y) ** 2 <= cellsToFp(2.2) ** 2 && hunter.cooldownEnd <= this.tick) {
          hunter.cooldownEnd = this.tick + cfg.hunterAttackIntervalTicks;
          this.damagePlayer(target, cfg.hunterDamage, `${owner.name}'s hunter`, `${owner.name}'s hunter`);
          this.emitSound(SOUND.STUN, target.x, target.y, 105);
        }
      } else if ((hunter.retargetAt ?? 0) <= this.tick || hunter.targetX === undefined || hunter.targetY === undefined) {
        const angle = (hunter.id * 1.91 + this.tick / 90) % (Math.PI * 2);
        hunter.targetX = barracks.x / FP + Math.cos(angle) * 10;
        hunter.targetY = barracks.y / FP + Math.sin(angle) * 10;
        hunter.retargetAt = this.tick + 90;
        hunter.targetId = undefined;
      }
      const dx = (hunter.targetX ?? hunter.x / FP) - hunter.x / FP;
      const dy = (hunter.targetY ?? hunter.y / FP) - hunter.y / FP;
      const length = Math.hypot(dx, dy);
      if (length < 0.4) { hunter.retargetAt = this.tick; continue; }
      hunter.facing = Math.round((((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
      const speedFp = Math.max(1, Math.round((cfg.hunterSpeed / this.bal.world.cellPx / TICK_HZ) * FP));
      const moved = moveCircle(this.world, hunter.x, hunter.y, radiusFp, Math.round(dx / length * speedFp), Math.round(dy / length * speedFp));
      hunter.x = moved.x;
      hunter.y = moved.y;
    }
  }

  private stepOreCarts(): void {
    const cfg = this.bal.automation.infrastructure;
    for (const cart of [...this.entities.values()]) {
      if (cart.kind !== ENT.ORE_CART) continue;
      const depot = this.entities.get(cart.baseId ?? -1);
      const base = this.entities.get(cart.targetEntityId ?? -1);
      const owner = this.players[cart.ownerId];
      if (!depot || depot.kind !== ENT.BUILDING || depot.buildingKind !== BUILDING.TRACK_DEPOT || !base || base.kind !== ENT.MINING_BASE || !owner) {
        this.entities.delete(cart.id);
        this.events.push({ type: "entities", added: [], removed: [cart.id] });
        continue;
      }
      if (((depot.flags ?? 0) & BUILDING_FLAG.POWERED) === 0) continue;
      const distance = Math.max(1, Math.hypot(base.x - depot.x, base.y - depot.y) / FP);
      let progress = cart.trackProgress ?? 0;
      let direction = cart.trackDirection ?? 1;
      progress += direction * cfg.cartSpeedCellsPerTick / distance;
      if (progress >= 1) { progress = 1; direction = -1; }
      else if (progress <= 0 && direction < 0) {
        progress = 0; direction = 1;
        owner.carriedGems += cfg.cartDeliveryCommon;
        owner.score += cfg.cartDeliveryCommon;
        depot.flags = (depot.flags ?? 0) | BUILDING_FLAG.ACTIVE;
        this.emitSound(SOUND.GEM, depot.x, depot.y, 80);
      }
      cart.trackProgress = progress;
      cart.trackDirection = direction;
      cart.x = Math.round(depot.x + (base.x - depot.x) * progress);
      cart.y = Math.round(depot.y + (base.y - depot.y) * progress);
      cart.facing = Math.round((((Math.atan2((base.y - depot.y) * direction, (base.x - depot.x) * direction) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
    }
  }

  private interactNearby(p: PlayerSim): void {
    const range2 = cellsToFp(this.bal.automation.base.interactRangeCells) ** 2;
    const base = [...this.entities.values()]
      .filter((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id)
      .map((entity) => ({ entity, d2: (entity.x - p.x) ** 2 + (entity.y - p.y) ** 2 }))
      .filter(({ d2 }) => d2 <= range2)
      .sort((a, b) => a.d2 - b.d2)[0]?.entity;
    if (!base) return;
    const cfg = this.bal.automation.miner;
    const count = this.minersForBase(base.id).length;
    base.minerCount = count;
    if (count >= cfg.maxPerBase) {
      this.events.push({ type: "log", playerId: p.id, msg: `Mining base is full — ${cfg.maxPerBase} miners active` });
      return;
    }
    if (p.carriedGems < cfg.commonCost || p.iron < cfg.ironCost) {
      this.events.push({ type: "log", playerId: p.id, msg: `A base miner costs ${cfg.commonCost} common gems and ${cfg.ironCost} iron` });
      return;
    }
    const miner = this.spawnAutoMiner(base, p);
    if (!miner) return;
    if (!p.devMode) {
      p.carriedGems -= cfg.commonCost;
      p.iron -= cfg.ironCost;
    }
    this.events.push({ type: "log", playerId: p.id, msg: `Miner deployed — ${base.minerCount}/${cfg.maxPerBase} active` });
    this.emitSound(SOUND.CRAFT, base.x, base.y, 135);
  }

  private stepAutoMiners(): void {
    const cfg = this.bal.automation.miner;
    const radiusFp = cellsToFp(cfg.bodyRadiusCells);
    for (const miner of [...this.entities.values()]) {
      if (miner.kind !== ENT.AUTO_MINER) continue;
      const base = this.entities.get(miner.baseId ?? -1);
      const owner = this.players[miner.ownerId];
      const validSource = base?.kind === ENT.MINING_BASE || (base?.kind === ENT.BUILDING && base.buildingKind === BUILDING.DIGGER_BARRACKS);
      if (!base || !validSource || !owner) {
        this.entities.delete(miner.id);
        this.events.push({ type: "entities", added: [], removed: [miner.id] });
        continue;
      }
      const infrastructure = this.bal.automation.infrastructure;
      const forgeStacks = Math.min(infrastructure.forgeMaxStacks, this.poweredBuildingCount(owner.id, BUILDING.DRILL_FORGE));

      const targetMat = miner.targetX === undefined || miner.targetY === undefined
        ? MAT.EMPTY
        : this.world.get(miner.targetX, miner.targetY);
      if (miner.retargetAt === undefined || this.tick >= miner.retargetAt || !minerDiggable(targetMat)) {
        const target = this.findAutoMinerTarget(miner, base, cfg.workRadiusCells + forgeStacks * infrastructure.forgeWorkRadiusPerStack);
        miner.targetX = target?.x;
        miner.targetY = target?.y;
        miner.retargetAt = this.tick + cfg.retargetTicks;
      }
      if (miner.targetX === undefined || miner.targetY === undefined) {
        miner.flags = 0;
        continue;
      }

      const targetX = miner.targetX + 0.5;
      const targetY = miner.targetY + 0.5;
      const dx = targetX - miner.x / FP;
      const dy = targetY - miner.y / FP;
      const length = Math.max(0.001, Math.hypot(dx, dy));
      const ux = dx / length;
      const uy = dy / length;
      miner.facing = Math.round((((Math.atan2(uy, ux) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;

      let obstruction: { x: number; y: number; mat: number } | undefined;
      for (let distance = cfg.bodyRadiusCells + 0.35; distance <= cfg.digReachCells; distance += 0.35) {
        const x = Math.floor(miner.x / FP + ux * distance);
        const y = Math.floor(miner.y / FP + uy * distance);
        const mat = this.world.get(x, y);
        if (mat !== MAT.EMPTY && mat !== MAT.VENT) {
          obstruction = { x, y, mat };
          break;
        }
      }

      if (obstruction && minerDiggable(obstruction.mat)) {
        miner.flags = PFLAG.DIGGING;
        if (this.tick < miner.cooldownEnd) continue;
        miner.cooldownEnd = this.tick + Math.max(1, cfg.digIntervalTicks - Math.floor(forgeStacks / 2));
        const result = applyDigBrush(
          this.world, obstruction.x + 0.5, obstruction.y + 0.5,
          cfg.digRadiusCells + forgeStacks * infrastructure.forgeDigRadiusPerStack,
          cfg.digDamage + forgeStacks * infrastructure.forgeDigDamagePerStack,
          minerDiggable
        );
        if (this.tick % 12 === 0) this.emitSound(SOUND.DIG, miner.x, miner.y, 70);
        this.awardDigResult(owner, result, true);
        continue;
      }

      if (obstruction) {
        miner.targetX = undefined;
        miner.targetY = undefined;
        miner.retargetAt = this.tick;
        miner.flags = 0;
        continue;
      }

      miner.flags = 0;
      const forgeMultiplier = 1 + forgeStacks * infrastructure.forgeSpeedPercentPerStack / 100;
      const trackMultiplier = this.hasPoweredBuilding(owner.id, BUILDING.TRACK_DEPOT) ? infrastructure.trackMinerSpeedMultiplier : 1;
      const speedFp = Math.max(1, Math.round((cfg.speed * forgeMultiplier * trackMultiplier / this.bal.world.cellPx / TICK_HZ) * FP));
      const moved = moveCircle(this.world, miner.x, miner.y, radiusFp, Math.round(ux * speedFp), Math.round(uy * speedFp));
      miner.x = moved.x;
      miner.y = moved.y;
    }
  }

  private findAutoMinerTarget(miner: EntitySim, base: EntitySim, radius = this.bal.automation.miner.workRadiusCells): { x: number; y: number } | null {
    const bx = base.x / FP;
    const by = base.y / FP;
    const mx = miner.x / FP;
    const my = miner.y / FP;
    let best: { x: number; y: number; score: number } | null = null;
    // The work window follows the miner. Keeping it fixed on the base made an
    // excavated base radius a permanent dead zone: after the last local cell
    // was cleared, the miner could never acquire the next rock frontier.
    for (let y = Math.max(0, Math.floor(my - radius)); y <= Math.min(this.world.size - 1, Math.ceil(my + radius)); y++) {
      for (let x = Math.max(0, Math.floor(mx - radius)); x <= Math.min(this.world.size - 1, Math.ceil(mx + radius)); x++) {
        const minerD2 = (x + 0.5 - mx) ** 2 + (y + 0.5 - my) ** 2;
        if (minerD2 > radius * radius) continue;
        const mat = this.world.get(x, y);
        if (!minerDiggable(mat)) continue;
        const resource = mat === MAT.GEM || mat === MAT.REINFORCE_GEM || mat === MAT.GOLD || mat === MAT.FOSSIL || mat === MAT.COPPER || mat === MAT.IRON || mat === MAT.PLATINUM || mat === MAT.COAL;
        const distance = Math.sqrt(minerD2);
        const baseD2 = (x + 0.5 - bx) ** 2 + (y + 0.5 - by) ** 2;
        const spread = ((x * 31 + y * 17 + miner.id * 13) & 31) * 0.08;
        // Nearby rock remains the efficient default and embedded resources
        // retain absolute priority. The tiny base-distance bias keeps several
        // miners from sprinting far away before finishing the local frontier.
        const score = (resource ? 100000 : 0) - distance * 10 - baseD2 * 0.02 + spread;
        if (!best || score > best.score) best = { x, y, score };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private placeTurret(p: PlayerSim): void {
    if (p.turretKits <= 0) {
      this.wallNotice(p, "Find a turret kit in a guarded ruin chest");
      return;
    }
    const target = this.aimOpenCell(p, 6);
    const cx = Math.floor(target.x);
    const cy = Math.floor(target.y);
    if (this.world.get(cx, cy) !== MAT.EMPTY) return;
    if ([...this.entities.values()].some((entity) => Math.floor(entity.x / FP) === cx && Math.floor(entity.y / FP) === cy)) return;
    if (this.players.some((player) => !player.eliminated && this.bombBlastHits(player, [{ x: cx, y: cy }]))) return;
    const turret: EntitySim = {
      id: this.nextEntityId++,
      kind: ENT.TURRET,
      x: cellsToFp(cx + 0.5),
      y: cellsToFp(cy + 0.5),
      ownerId: p.id,
      cooldownEnd: this.tick + this.bal.specialWeapons.turret.fireIntervalTicks,
      weaponKind: WEAPON.TURRET
    };
    this.entities.set(turret.id, turret);
    if (!p.devMode) p.turretKits--;
    this.events.push({ type: "entities", added: [turret], removed: [] });
    this.events.push({ type: "log", playerId: p.id, msg: "Auto-turret deployed" });
    this.emitSound(SOUND.PLACE, turret.x, turret.y, 160);
  }

  private stepTurrets(): void {
    const cfg = this.bal.specialWeapons.turret;
    const range2 = cellsToFp(cfg.rangeCells) ** 2;
    for (const turret of [...this.entities.values()]) {
      if (turret.kind !== ENT.TURRET || turret.cooldownEnd > this.tick) continue;
      const owner = this.players[turret.ownerId];
      if (!owner) continue;
      const target = this.players
        .filter((player) => !player.eliminated && player.id !== turret.ownerId)
        .map((player) => ({ player, d2: (player.x - turret.x) ** 2 + (player.y - turret.y) ** 2 }))
        .filter(({ player, d2 }) => d2 <= range2 && hasLineOfSight(
          this.world,
          turret.x / FP,
          turret.y / FP,
          player.x / FP,
          player.y / FP
        ))
        .sort((a, b) => a.d2 - b.d2)[0]?.player;
      if (!target) {
        turret.cooldownEnd = this.tick + Math.max(5, Math.floor(cfg.fireIntervalTicks / 3));
        continue;
      }
      const fired = this.spawnBomb(
        owner,
        Math.floor(target.x / FP),
        Math.floor(target.y / FP),
        WEAPON.TURRET_SHELL,
        cfg.shellFuseTicks,
        cfg.shellRangeCells + owner.bombRangeLevel,
        1 + owner.bombWidthLevel,
        owner.bombFeatures & (BOMB_FEATURE.WIDE | BOMB_FEATURE.SHIELD),
        true
      );
      turret.cooldownEnd = this.tick + cfg.fireIntervalTicks;
      if (fired) this.emitSound(SOUND.PLACE, turret.x, turret.y, 135);
    }
  }

  private spawnBomb(
    p: PlayerSim,
    cx: number,
    cy: number,
    weaponKind: number,
    fuseTicks: number,
    range: number,
    halfWidth: number,
    features: number,
    ignoreLimit = false,
    launch?: { fromX: number; fromY: number; delayTicks: number; flightTicks: number; flags?: number },
    aim = 0
  ): EntitySim | false {
    const cfg = this.bal.items.bomb;
    const maxActive = cfg.maxActivePerPlayer + ((p.bombFeatures & BOMB_FEATURE.TWIN) !== 0 ? 1 : 0) + p.bombCapacityLevel;
    if (!ignoreLimit && this.ownedBombs(p) >= maxActive) return false;
    const mat = this.world.get(cx, cy);
    if (!ignoreLimit && mat !== MAT.EMPTY && mat !== MAT.VENT) return false;
    const targetX = cellsToFp(cx + 0.5);
    const targetY = cellsToFp(cy + 0.5);
    for (const existing of this.entities.values()) {
      const occupiedX = existing.kind === ENT.BOMB ? existing.targetX ?? existing.x : existing.x;
      const occupiedY = existing.kind === ENT.BOMB ? existing.targetY ?? existing.y : existing.y;
      if (existing.kind === ENT.BOMB && Math.floor(occupiedX / FP) === cx && Math.floor(occupiedY / FP) === cy) return false;
    }
    const launchStartTick = launch ? this.tick + launch.delayTicks : undefined;
    const launchEndTick = launchStartTick === undefined ? undefined : launchStartTick + launch!.flightTicks;
    const e: EntitySim = {
      id: this.nextEntityId++,
      kind: ENT.BOMB,
      x: launch?.fromX ?? targetX,
      y: launch?.fromY ?? targetY,
      ownerId: p.id,
      cooldownEnd: (launchEndTick ?? this.tick) + fuseTicks,
      bombFuseTicks: fuseTicks,
      blastRange: Math.min(31, range),
      blastHalfWidth: halfWidth,
      blastNoiseFringe: cfg.blastNoiseFringeCells,
      blastWobble: cfg.blastWobbleCells,
      blastStepTicks: cfg.blastStepTicks,
      blastFeatures: features,
      weaponKind,
      flags: launch ? launch.flags ?? EFLAG.AIRBORNE : 0,
      targetX: launch ? targetX : undefined,
      targetY: launch ? targetY : undefined,
      launchX: launch?.fromX,
      launchY: launch?.fromY,
      launchStartTick,
      launchEndTick,
      aim
    };
    this.entities.set(e.id, e);
    this.events.push({ type: "entities", added: [e], removed: [] });
    if (!launch) this.emitSound(SOUND.PLACE, e.x, e.y, 90);
    return e;
  }

  private remoteDetonateBombs(p: PlayerSim): void {
    let armed = 0;
    for (const bomb of this.entities.values()) {
      if (bomb.kind !== ENT.BOMB || bomb.ownerId !== p.id || bomb.launchEndTick !== undefined) continue;
      if ((p.bombFeatures & BOMB_FEATURE.REMOTE) === 0 && bomb.weaponKind !== WEAPON.C4) continue;
      bomb.cooldownEnd = this.tick;
      armed++;
    }
    if (armed > 0) this.events.push({ type: "log", playerId: p.id, msg: `Remote detonated ${armed} bomb${armed === 1 ? "" : "s"}` });
  }

  private stepAirborneBombs(): void {
    for (const bomb of this.entities.values()) {
      if (bomb.kind !== ENT.BOMB || bomb.launchEndTick === undefined) continue;
      const start = bomb.launchStartTick ?? this.tick;
      const end = Math.max(start + 1, bomb.launchEndTick ?? start + 1);
      if (this.tick < start) continue;
      const raw = Math.max(0, Math.min(1, (this.tick - start) / (end - start)));
      const eased = raw * raw * (3 - 2 * raw);
      const fromX = bomb.launchX ?? bomb.x;
      const fromY = bomb.launchY ?? bomb.y;
      const targetX = bomb.targetX ?? bomb.x;
      const targetY = bomb.targetY ?? bomb.y;
      bomb.x = Math.round(fromX + (targetX - fromX) * eased);
      bomb.y = Math.round(fromY + (targetY - fromY) * eased);
      if (((bomb.flags ?? 0) & EFLAG.DRILLING) !== 0) this.drillMovingBomb(bomb);
      if (raw >= 1) {
        bomb.x = targetX;
        bomb.y = targetY;
        bomb.flags = (bomb.flags ?? 0) & ~(EFLAG.AIRBORNE | EFLAG.PROJECTILE | EFLAG.DRILLING | EFLAG.BOUNCING);
        bomb.launchEndTick = undefined;
      }
    }
  }

  private stepSpecialBombBehaviors(): void {
    for (const bomb of this.entities.values()) {
      if (bomb.kind !== ENT.BOMB) continue;
      const blueprint = blueprintForWeaponKind(bomb.weaponKind);
      if (blueprint === "sticky-bomb" && bomb.targetId !== undefined) {
        const target = this.players[bomb.targetId];
        if (target && !target.eliminated) {
          bomb.x = target.x;
          bomb.y = target.y;
        } else {
          bomb.targetId = undefined;
        }
      }
      if (blueprint === "sticky-bomb" && bomb.targetEntityId !== undefined) {
        const target = this.entities.get(bomb.targetEntityId);
        if (target) {
          bomb.x = target.x;
          bomb.y = target.y;
        } else {
          bomb.targetEntityId = undefined;
        }
      }
      if (blueprint !== "proximity-mine" || bomb.cooldownEnd - this.tick < 30) continue;
      const triggerRange2 = cellsToFp(6) ** 2;
      const rival = this.players.some((player) =>
        player.id !== bomb.ownerId && !player.eliminated &&
        (player.x - bomb.x) ** 2 + (player.y - bomb.y) ** 2 <= triggerRange2 &&
        hasLineOfSight(this.world, bomb.x / FP, bomb.y / FP, player.x / FP, player.y / FP)
      );
      if (rival) {
        bomb.bombFuseTicks = 12;
        bomb.cooldownEnd = this.tick + 12;
        this.emitSound(SOUND.PLACE, bomb.x, bomb.y, 150);
      }
    }
  }

  private drillMovingBomb(bomb: EntitySim): void {
    const cx = Math.floor(bomb.x / FP);
    const cy = Math.floor(bomb.y / FP);
    const changes: CellChange[] = [];
    const mined = new Map<number, number>();
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > 2) continue;
        const mat = this.world.get(x, y);
        if (mat === MAT.EMPTY || mat === MAT.VENT || mat === MAT.BEDROCK || mat === MAT.REINFORCE || mat === MAT.LAVA || mat === MAT.MOSS || mat === MAT.WATER) continue;
        if (
          mat === MAT.GEM || mat === MAT.REINFORCE_GEM || mat === MAT.GOLD || mat === MAT.FOSSIL ||
          mat === MAT.COPPER || mat === MAT.IRON || mat === MAT.PLATINUM || mat === MAT.COAL
        ) mined.set(mat, (mined.get(mat) ?? 0) + 1);
        const change = this.world.set(x, y, MAT.EMPTY);
        if (change) changes.push(change);
      }
    }
    if (changes.length === 0) return;
    this.ventDirty = true;
    this.pushPatch(changes);
    const owner = this.players[bomb.ownerId];
    if (owner) for (const [material, count] of mined) this.awardMinedMaterial(owner, material, count);
  }

  private stepBombs(): void {
    this.stepSpecialBombBehaviors();
    this.stepAirborneBombs();
    const dueEchoes = this.echoBlasts.filter((echo) => echo.atTick <= this.tick);
    this.echoBlasts = this.echoBlasts.filter((echo) => echo.atTick > this.tick);
    for (const echo of dueEchoes) {
      const owner = this.players[echo.ownerId];
      if (!owner) continue;
      const bomb = this.spawnBomb(owner, echo.x, echo.y, echo.weaponKind, 0, echo.range, echo.halfWidth, echo.features, true, undefined, echo.aim);
      if (bomb) bomb.targetId = -2; // echoed payloads repeat exactly once
    }
    const removed: number[] = [];
    const added: EntitySim[] = [];
    for (const e of this.entities.values()) {
      if ((e.kind === ENT.BLAST || e.kind === ENT.FIRE) && e.cooldownEnd <= this.tick) {
        this.entities.delete(e.id);
        removed.push(e.id);
      }
    }

    let exploded = false;
    const processed = new Set<ActiveBombBlast>();
    const startDueBombs = (): boolean => {
      let started = false;
      const due: EntitySim[] = [];
      for (const e of this.entities.values()) {
        if (e.kind === ENT.BOMB && e.cooldownEnd <= this.tick) due.push(e);
      }
      for (const bomb of due) {
        started = true;
        exploded = true;
        this.entities.delete(bomb.id);
        removed.push(bomb.id);
        const visualId = this.nextEntityId++;
        let range = bomb.blastRange ?? this.bal.items.bomb.blastRangeCells;
        let halfWidth = bomb.blastHalfWidth ?? this.bal.items.bomb.blastHalfWidthCells;
        const noiseFringe = bomb.blastNoiseFringe ?? this.bal.items.bomb.blastNoiseFringeCells;
        const wobble = bomb.blastWobble ?? this.bal.items.bomb.blastWobbleCells;
        const stepTicks = bomb.blastStepTicks ?? this.bal.items.bomb.blastStepTicks;
        const features = bomb.blastFeatures ?? 0;
        const weaponKind = bomb.weaponKind ?? WEAPON.STANDARD;
        const blueprint = blueprintForWeaponKind(weaponKind);
        const aim = bomb.aim ?? 0;
        const owner = this.players[bomb.ownerId];
        if (blueprint === "material-bomb") {
          const changes: CellChange[] = [];
          let absorbed = 0;
          const centerX = Math.floor(bomb.x / FP);
          const centerY = Math.floor(bomb.y / FP);
          for (let y = centerY - 6; y <= centerY + 6; y++) {
            for (let x = centerX - 6; x <= centerX + 6; x++) {
              if ((x - centerX) ** 2 + (y - centerY) ** 2 > 36) continue;
              const material = this.world.get(x, y);
              if (material !== MAT.GEM && material !== MAT.REINFORCE_GEM && !isCraftMaterial(material)) continue;
              const exposed = this.world.get(x + 1, y) === MAT.EMPTY || this.world.get(x - 1, y) === MAT.EMPTY ||
                this.world.get(x, y + 1) === MAT.EMPTY || this.world.get(x, y - 1) === MAT.EMPTY;
              if (!exposed) continue;
              const change = this.world.set(x, y, MAT.EMPTY);
              if (change) {
                changes.push(change);
                absorbed++;
              }
            }
          }
          if (changes.length > 0) {
            this.pushPatch(changes);
            this.ventDirty = true;
          }
          range = Math.min(31, range + Math.min(10, absorbed));
          halfWidth += Math.min(3, Math.floor(absorbed / 3));
        }
        if (owner && (owner.relics & RELIC.ECHO_CORE) !== 0 && bomb.targetId !== -2 && blueprint !== "decoy-bomb") {
          this.echoBlasts.push({
            atTick: this.tick + 90,
            ownerId: owner.id,
            x: Math.floor(bomb.x / FP),
            y: Math.floor(bomb.y / FP),
            weaponKind,
            range,
            halfWidth,
            features,
            aim
          });
        }
        if (blueprint === "collapse-charge") this.scheduleCollapse(Math.floor(bomb.x / FP), Math.floor(bomb.y / FP), Math.max(7, Math.floor(range * 0.8)));
        if (blueprint === "chain-bomb") {
          const chainRange2 = cellsToFp(range) ** 2;
          for (const chained of this.entities.values()) {
            if (chained.kind !== ENT.BOMB || chained.id === bomb.id || chained.launchEndTick !== undefined) continue;
            if ((chained.x - bomb.x) ** 2 + (chained.y - bomb.y) ** 2 <= chainRange2) chained.cooldownEnd = Math.min(chained.cooldownEnd, this.tick + 3);
          }
        }
        if (weaponKind === WEAPON.CLUSTER && owner) {
          const cluster = this.bal.specialWeapons.cluster;
          for (let i = 0; i < cluster.childCount; i++) {
            const angle = (i / cluster.childCount) * Math.PI * 2 + (visualId % 13) * 0.07;
            const cx = Math.floor(bomb.x / FP + Math.cos(angle) * cluster.scatterRadiusCells);
            const cy = Math.floor(bomb.y / FP + Math.sin(angle) * cluster.scatterRadiusCells);
            this.spawnBomb(
              owner,
              cx,
              cy,
              WEAPON.CLUSTER_CHILD,
              cluster.childFuseTicks,
              cluster.childRangeCells,
              1,
              features,
              true,
              { fromX: bomb.x, fromY: bomb.y, delayTicks: cluster.scatterDelayTicks, flightTicks: cluster.childFlightTicks }
            );
          }
        }
        if (blueprint !== "decoy-bomb") {
          this.bombBlasts.push({
            ownerId: bomb.ownerId,
            x: Math.floor(bomb.x / FP),
            y: Math.floor(bomb.y / FP),
            shapeSeed: visualId,
            range,
            halfWidth,
            noiseFringe,
            wobble,
            stepTicks,
            features,
            weaponKind,
            blueprint,
            aim,
            distance: 0,
            nextTick: this.tick,
            hitPlayers: new Set(),
            hitEntities: new Set()
          });
        }
        const duration =
          range * stepTicks +
          this.bal.items.bomb.blastVisualTicks;
        const visual: EntitySim = {
          id: visualId,
          kind: ENT.BLAST,
          x: bomb.x,
          y: bomb.y,
          ownerId: bomb.ownerId,
          cooldownEnd: this.tick + duration,
          blastRange: range,
          blastHalfWidth: halfWidth,
          blastNoiseFringe: noiseFringe,
          blastWobble: wobble,
          blastStepTicks: stepTicks,
          blastFeatures: features,
          weaponKind,
          aim
        };
        this.entities.set(visual.id, visual);
        added.push(visual);
        const lingeringTicks = weaponKind === WEAPON.NAPALM
          ? this.bal.specialWeapons.napalm.burnTicks
          : residualFieldTicks(blueprint);
        if (lingeringTicks > 0) {
          const fire: EntitySim = {
            id: this.nextEntityId++,
            kind: ENT.FIRE,
            x: bomb.x,
            y: bomb.y,
            ownerId: bomb.ownerId,
            cooldownEnd: this.tick + range * stepTicks + lingeringTicks,
            blastRange: range,
            blastHalfWidth: halfWidth,
            blastNoiseFringe: noiseFringe,
            blastWobble: wobble,
            blastStepTicks: stepTicks,
            blastFeatures: features,
            weaponKind,
            aim
          };
          this.entities.set(fire.id, fire);
          added.push(fire);
        }
        this.emitSound(SOUND.BOMB, bomb.x, bomb.y, 255);
      }
      return started;
    };

    while (true) {
      startDueBombs();
      const dueWaves = this.bombBlasts.filter((blast) => !processed.has(blast) && blast.nextTick <= this.tick);
      if (dueWaves.length === 0) break;

      for (const blast of dueWaves) {
        processed.add(blast);
        exploded = true;
        const cells = this.bombBlastLayerCells(blast, blast.distance);
        const keys = new Set(cells.map((cell) => `${cell.x}:${cell.y}`));

        // Every lane continues through destructible rock, carving a traversable
        // five-cell-wide corridor. Only bedrock and rigid walls stop a lane.
        const owner = this.players[blast.ownerId];
        const changes: CellChange[] = [];
        const minedMaterials = new Map<number, number>();
        const nonDestructive = blast.blueprint === "concussion-bomb" || blast.blueprint === "cryo-bomb" || blast.blueprint === "gas-bomb" || blast.blueprint === "emp-charge";
        for (const cell of cells) {
          const mat = this.world.get(cell.x, cell.y);
          if (blast.blueprint === "cryo-bomb") this.burningCells.delete(`${cell.x}:${cell.y}`);
          if (nonDestructive || mat === MAT.EMPTY || mat === MAT.VENT || mat === MAT.BEDROCK || mat === MAT.LAVA || mat === MAT.MOSS || mat === MAT.WATER || (mat === MAT.REINFORCE && blast.blueprint !== "acid-bomb")) continue;
          if (
            mat === MAT.GEM || mat === MAT.REINFORCE_GEM || mat === MAT.GOLD || mat === MAT.FOSSIL ||
            mat === MAT.COPPER || mat === MAT.IRON || mat === MAT.PLATINUM || mat === MAT.COAL
          ) minedMaterials.set(mat, (minedMaterials.get(mat) ?? 0) + 1);
          const change = this.world.set(cell.x, cell.y, MAT.EMPTY);
          if (change) changes.push(change);
        }
        if (changes.length > 0) {
          this.ventDirty = true;
          this.pushPatch(changes);
        }
        if (owner) for (const [mat, count] of minedMaterials) this.awardMinedMaterial(owner, mat, count);
        if (blast.weaponKind === WEAPON.NAPALM) {
          const endTick = this.tick + this.bal.specialWeapons.napalm.burnTicks;
          for (const cell of cells) this.burningCells.set(`${cell.x}:${cell.y}`, { ...cell, ownerId: blast.ownerId, endTick });
        }
        const fieldTicks = residualFieldTicks(blast.blueprint);
        if (fieldTicks > 0 && blast.blueprint) {
          const endTick = this.tick + fieldTicks;
          const kind = blast.blueprint as ResidualFieldKind;
          for (const cell of cells) this.residualFields.set(`${cell.x}:${cell.y}`, { ...cell, ownerId: blast.ownerId, endTick, kind });
        }

        for (const e of this.entities.values()) {
          if (e.kind === ENT.BOMB && e.launchEndTick === undefined && keys.has(`${Math.floor(e.x / FP)}:${Math.floor(e.y / FP)}`)) {
            if (blast.blueprint === "emp-charge") e.cooldownEnd += 150;
            else e.cooldownEnd = this.tick;
          }
        }

        // Guardians and player deployables are physical combat targets.
        // Destroying every guardian linked to a chest unseals that treasure.
        for (const entity of [...this.entities.values()]) {
          if (
            entity.kind !== ENT.GUARDIAN && entity.kind !== ENT.TURRET &&
            entity.kind !== ENT.MINING_BASE && entity.kind !== ENT.AUTO_MINER && entity.kind !== ENT.BUILDING &&
            entity.kind !== ENT.HUNTER && entity.kind !== ENT.ORE_CART
          ) continue;
          if (!this.entities.has(entity.id) || blast.hitEntities.has(entity.id)) continue;
          const hit = entity.kind === ENT.MINING_BASE || entity.kind === ENT.BUILDING
            ? this.bombBlastHitsCircle(entity.x, entity.y, cellsToFp(entity.kind === ENT.MINING_BASE
              ? this.bal.automation.base.collisionRadiusCells
              : buildingDefinition(entity.buildingKind ?? -1)?.collisionRadius ?? 1.5), cells)
            : keys.has(`${Math.floor(entity.x / FP)}:${Math.floor(entity.y / FP)}`);
          if (!hit) continue;
          blast.hitEntities.add(entity.id);
          if (blast.blueprint === "emp-charge" && (entity.kind === ENT.TURRET || entity.kind === ENT.BUILDING)) {
            entity.cooldownEnd = Math.max(entity.cooldownEnd, this.tick + 300);
            entity.disabledUntilTick = Math.max(entity.disabledUntilTick ?? 0, this.tick + 300);
            entity.flags = (entity.flags ?? 0) & ~(BUILDING_FLAG.POWERED | BUILDING_FLAG.ACTIVE);
            continue;
          }
          if (nonDestructive) continue;
          if (entity.kind === ENT.BUILDING || entity.kind === ENT.MINING_BASE) {
            const damage = Math.max(1, Math.round(this.bal.combat.bombDamage * this.poweredShieldMultiplier(entity.ownerId, entity.x, entity.y)));
            entity.health = Math.max(0, (entity.health ?? this.bal.combat.bombDamage) - damage);
            if (entity.health > 0) continue;
          }
          this.entities.delete(entity.id);
          removed.push(entity.id);
          if (entity.kind === ENT.GUARDIAN) {
            const linkedChest = this.entities.get(entity.ownerId);
            const stillGuarded = [...this.entities.values()].some((candidate) =>
              candidate.kind === ENT.GUARDIAN && candidate.ownerId === entity.ownerId
            );
            if (linkedChest?.kind === ENT.CHEST && !stillGuarded) {
              linkedChest.flags = (linkedChest.flags ?? 0) & ~CHEST_FLAG.SEALED;
              if (owner) this.events.push({ type: "log", playerId: owner.id, msg: "Ruin seal broken — cross the chest to collect it" });
              this.emitSound(SOUND.CRAFT, linkedChest.x, linkedChest.y, 130);
            }
          }
          if (entity.kind === ENT.MINING_BASE) {
            for (const miner of this.minersForBase(entity.id)) {
              this.entities.delete(miner.id);
              removed.push(miner.id);
            }
            for (const cart of [...this.entities.values()].filter((candidate) => candidate.kind === ENT.ORE_CART && candidate.targetEntityId === entity.id)) {
              this.entities.delete(cart.id);
              removed.push(cart.id);
            }
            const baseOwner = this.players[entity.ownerId];
            if (baseOwner && this.ownedMiningBases(baseOwner) === 0) baseOwner.infrastructureUnlocked = false;
            if (owner) {
              const baseCfg = this.bal.automation.base;
              this.spawnBomb(
                owner,
                Math.floor(entity.x / FP),
                Math.floor(entity.y / FP),
                WEAPON.BASE_CORE,
                0,
                baseCfg.explosionRangeCells,
                baseCfg.explosionHalfWidthCells,
                0,
                true
              );
            }
          } else if (entity.kind === ENT.BUILDING) {
            const definition = buildingDefinition(entity.buildingKind ?? -1);
            for (const dependent of [...this.entities.values()].filter((candidate) => candidate.baseId === entity.id)) {
              this.entities.delete(dependent.id);
              removed.push(dependent.id);
            }
            if (definition?.kind === BUILDING.COAL_GENERATOR && owner) {
              this.spawnBomb(owner, Math.floor(entity.x / FP), Math.floor(entity.y / FP), WEAPON.BASE_CORE, 8, 6, 1, 0, true);
            }
          } else if (entity.kind === ENT.AUTO_MINER) {
            const base = this.entities.get(entity.baseId ?? -1);
            if (base?.kind === ENT.MINING_BASE || base?.kind === ENT.BUILDING) base.minerCount = this.minersForBase(base.id).length;
          }
          if (entity.kind === ENT.GUARDIAN && owner) {
            const variant = entity.weaponKind ?? GUARDIAN_VARIANT.RUIN;
            const label = variant === GUARDIAN_VARIANT.TUNNEL_CRAWLER ? "tunnel crawler"
              : variant === GUARDIAN_VARIANT.EMBERLING ? "emberling"
                : variant === GUARDIAN_VARIANT.BONE_WRAITH ? "bone wraith"
                  : "ruin guardian";
            owner.score += variant === GUARDIAN_VARIANT.RUIN ? 50 : 25;
            this.events.push({ type: "log", playerId: owner.id, msg: `${label[0].toUpperCase()}${label.slice(1)} destroyed` });
            this.events.push({ type: "feed", kind: "combat", msg: `${owner.name} destroyed a ${label}` });
          } else if ((entity.kind === ENT.MINING_BASE || entity.kind === ENT.AUTO_MINER || entity.kind === ENT.HUNTER || entity.kind === ENT.ORE_CART) && owner) {
            const label = entity.kind === ENT.MINING_BASE ? "a mining base" : entity.kind === ENT.AUTO_MINER ? "an auto-miner" : entity.kind === ENT.HUNTER ? "a hunter" : "an ore cart";
            this.events.push({ type: "feed", kind: "combat", msg: `${owner.name} destroyed ${label}` });
          } else if (entity.kind === ENT.BUILDING && owner) {
            const label = buildingDefinition(entity.buildingKind ?? -1)?.label ?? "outpost building";
            this.events.push({ type: "feed", kind: "combat", msg: `${owner.name} destroyed a ${label}` });
          }
        }

        for (const player of this.players) {
          if (player.eliminated || blast.hitPlayers.has(player.id) || !this.bombBlastHits(player, cells)) continue;
          if (player.id === blast.ownerId && (blast.features & BOMB_FEATURE.SHIELD) !== 0) continue;
          blast.hitPlayers.add(player.id);
          const selfKill = owner?.id === player.id;
          const privateSource = selfKill ? "your own bomb" : `${owner?.name ?? "a player"}'s bomb`;
          const publicSource = selfKill ? "their own bomb" : `${owner?.name ?? "a player"}'s bomb`;
          let damage = Math.round(this.bal.combat.bombDamage * blastDamageMultiplier(blast.weaponKind, blast.blueprint));
          if (blast.blueprint === "concussion-bomb") {
            damage = Math.max(1, Math.floor(damage * 0.15));
            player.stunUntilTick = Math.max(player.stunUntilTick, this.tick + 75);
            const length = Math.max(1, Math.hypot(player.x - blast.x * FP, player.y - blast.y * FP));
            const push = cellsToFp(3);
            const moved = moveCircle(
              this.world,
              player.x,
              player.y,
              this.playerRadiusFp,
              Math.round(((player.x - blast.x * FP) / length) * push),
              Math.round(((player.y - blast.y * FP) / length) * push),
              this.infrastructureObstacles()
            );
            player.x = moved.x;
            player.y = moved.y;
          } else if (blast.blueprint === "cryo-bomb") {
            damage = Math.max(1, Math.floor(damage * 0.35));
            player.stunUntilTick = Math.max(player.stunUntilTick, this.tick + 60);
          } else if (blast.blueprint === "gas-bomb") {
            damage = Math.max(1, Math.floor(damage * 0.2));
            player.oxygen = Math.max(0, player.oxygen - 24);
          } else if (blast.blueprint === "emp-charge") {
            damage = 0;
            player.stunUntilTick = Math.max(player.stunUntilTick, this.tick + 30);
          }
          damage = Math.max(0, Math.round(damage * this.poweredShieldMultiplier(player.id, player.x, player.y)));
          const healthBefore = player.health;
          if (damage > 0) this.damagePlayer(player, damage, privateSource, publicSource);
          if (blast.blueprint === "vampire-bomb" && owner && owner.id !== player.id) {
            owner.health = Math.min(this.playerMaxHealth(owner), owner.health + Math.max(0, healthBefore - player.health));
          }
        }

        blast.distance++;
        blast.nextTick = this.tick + blast.stepTicks;
      }
    }

    this.bombBlasts = this.bombBlasts.filter((blast) => blast.distance <= blast.range);
    if (added.length > 0 || removed.length > 0) this.events.push({ type: "entities", added, removed });
    if (exploded) this.checkWinCondition();
  }

  private bombBlastLayerCells(blast: ActiveBombBlast, distance: number): { x: number; y: number }[] {
    if (blast.blueprint === "gas-bomb") return this.gasBlastLayerCells(blast, distance);
    const cells: { x: number; y: number }[] = [];
    const pattern = blastPatternForVariant(blast.weaponKind);
    const cfg = {
      blastRangeCells: blast.range,
      blastHalfWidthCells: blast.halfWidth,
      blastNoiseFringeCells: blast.noiseFringe,
      blastWobbleCells: blast.wobble,
      blastDiagonal: (blast.features & BOMB_FEATURE.DIAGONAL) !== 0
    };
    for (let dy = -distance; dy <= distance; dy++) {
      for (let dx = -distance; dx <= distance; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== distance) continue;
        if (!bombBlastPatternContains(dx, dy, cfg, blast.shapeSeed, pattern, blast.aim)) continue;
        if (pattern === "cross" || pattern === "star" || pattern === "x") {
          const laneCfg = pattern === "cross" ? cfg : { ...cfg, blastDiagonal: true };
          let armMask = bombBlastArmMask(dx, dy, laneCfg, blast.shapeSeed);
          if (pattern === "x") armMask &= 12;
          if (armMask === 0 || this.bombLaneBlocked(blast, dx, dy, armMask)) continue;
        } else if (this.bombRayBlocked(blast, dx, dy)) {
          continue;
        }
        cells.push({ x: blast.x + dx, y: blast.y + dy });
      }
    }
    return cells;
  }

  /** Gas follows connected excavated corridors instead of cutting a geometric
   * cross through rock. Rebuilding the small frontier per wave keeps the
   * result deterministic even when another explosion opens a passage. */
  private gasBlastLayerCells(blast: ActiveBombBlast, distance: number): { x: number; y: number }[] {
    let frontier = [{ x: blast.x, y: blast.y }];
    const visited = new Set([`${blast.x}:${blast.y}`]);
    for (let step = 0; step < distance; step++) {
      const next: { x: number; y: number }[] = [];
      for (const cell of frontier) {
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = cell.x + ox;
          const y = cell.y + oy;
          const key = `${x}:${y}`;
          if (visited.has(key) || !this.world.inBounds(x, y)) continue;
          const mat = this.world.get(x, y);
          if (mat !== MAT.EMPTY && mat !== MAT.VENT) continue;
          visited.add(key);
          next.push({ x, y });
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return frontier;
  }

  private bombRayBlocked(blast: ActiveBombBlast, dx: number, dy: number): boolean {
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps === 0) return false;
    for (let step = 1; step <= steps; step++) {
      const x = blast.x + Math.round(dx * step / steps);
      const y = blast.y + Math.round(dy * step / steps);
      if (!this.world.inBounds(x, y)) return true;
      const material = this.world.get(x, y);
      if (material === MAT.BEDROCK || (material === MAT.REINFORCE && blast.blueprint !== "acid-bomb")) return true;
    }
    return false;
  }

  private bombLaneBlocked(blast: ActiveBombBlast, dx: number, dy: number, armMask: number): boolean {
    const blocked = (x: number, y: number) => {
      if (!this.world.inBounds(x, y)) return true;
      const mat = this.world.get(x, y);
      return mat === MAT.BEDROCK || (mat === MAT.REINFORCE && blast.blueprint !== "acid-bomb");
    };

    let horizontalBlocked = true;
    if ((armMask & 1) !== 0) {
      const sx = Math.sign(dx);
      horizontalBlocked = dx === 0 ? blocked(blast.x, blast.y + dy) : false;
      for (let step = 1; step <= Math.abs(dx); step++) {
        if (blocked(blast.x + sx * step, blast.y + dy)) horizontalBlocked = true;
      }
    }

    let verticalBlocked = true;
    if ((armMask & 2) !== 0) {
      const sy = Math.sign(dy);
      verticalBlocked = dy === 0 ? blocked(blast.x + dx, blast.y) : false;
      for (let step = 1; step <= Math.abs(dy); step++) {
        if (blocked(blast.x + dx, blast.y + sy * step)) verticalBlocked = true;
      }
    }

    let diagonalBlocked = true;
    if ((armMask & 12) !== 0) {
      diagonalBlocked = false;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps === 0) diagonalBlocked = blocked(blast.x, blast.y);
      for (let step = 1; step <= steps; step++) {
        const x = blast.x + Math.round((dx * step) / steps);
        const y = blast.y + Math.round((dy * step) / steps);
        if (blocked(x, y)) diagonalBlocked = true;
      }
    }
    return horizontalBlocked && verticalBlocked && diagonalBlocked;
  }

  private bombBlastHits(player: PlayerSim, blast: { x: number; y: number }[]): boolean {
    return this.bombBlastHitsCircle(player.x, player.y, this.playerRadiusFp, blast);
  }

  private bombBlastHitsCircle(xFp: number, yFp: number, radiusFp: number, blast: { x: number; y: number }[]): boolean {
    for (const cell of blast) {
      const x0 = cell.x * FP;
      const y0 = cell.y * FP;
      const nearestX = Math.max(x0, Math.min(xFp, x0 + FP));
      const nearestY = Math.max(y0, Math.min(yFp, y0 + FP));
      if ((xFp - nearestX) ** 2 + (yFp - nearestY) ** 2 < radiusFp ** 2) return true;
    }
    return false;
  }

  /* ------------------------------------------- contextual player actions */

  private stepActions(p: PlayerSim): void {
    if (p.convertingUntilTick > 0 || this.tick < p.stunUntilTick || p.incapacitated || p.eliminated) return;
    const btn = p.input.buttons;
    const pressed = (b: number) => (btn & b) !== 0 && (p.prevButtons & b) === 0;

    // hunt toggle
    if (pressed(BTN.HUNT) && p.role === ROLE.INFECTED && this.zombiesReleased() && this.tick >= p.huntCooldownEnd) {
      p.presentation = p.presentation === PRES.HUNT ? PRES.DISGUISED : PRES.HUNT;
      p.huntCooldownEnd = this.tick + Math.round((this.bal.capture.huntRevealCooldownMs / 1000) * TICK_HZ);
      if (p.presentation === PRES.HUNT) this.emitSound(SOUND.TRANSFORM, p.x, p.y, 160);
    }
  }

  private stepAutoCollect(p: PlayerSim): void {
    if (p.convertingUntilTick > 0 || this.tick < p.stunUntilTick || p.incapacitated || p.eliminated) return;
    this.tryCollect(p);
    this.collectNearbyChest(p);
  }

  private tryCollect(p: PlayerSim): void {
    const rangeFp = cellsToFp(3.5);
    const removed: number[] = [];
    for (const e of this.entities.values()) {
      if (e.kind !== ENT.GEM && e.kind !== ENT.REINFORCE_GEM) continue;
      const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
      if (d2 > rangeFp * rangeFp) continue;
      if (e.kind === ENT.REINFORCE_GEM) {
        const firstUnlock = !p.wallUnlocked;
        p.reinforceGems++;
        p.wallUnlocked = true;
        if (firstUnlock) this.events.push({ type: "log", playerId: p.id, msg: "Rigid walls unlocked by reinforcement crystal" });
      } else {
        p.carriedGems += 1;
      }
      removed.push(e.id);
      this.emitSound(SOUND.GEM, p.x, p.y, 60);
    }
    for (const id of removed) this.entities.delete(id);
    if (removed.length) this.events.push({ type: "entities", added: [], removed });
  }

  /* ------------------------------------------- ruins, guardians, treasure */

  private spawnRuinTreasure(): void {
    for (const ruin of this.map.ruins) {
      const chest: EntitySim = {
        id: this.nextEntityId++,
        kind: ENT.CHEST,
        x: cellsToFp(ruin.chestX + 0.5),
        y: cellsToFp(ruin.chestY + 0.5),
        ownerId: -1,
        cooldownEnd: 0,
        flags: CHEST_FLAG.SEALED,
        weaponKind: CHEST_VARIANT.RUIN
      };
      this.entities.set(chest.id, chest);
      for (const spawn of ruin.guardians) {
        const guardian: GuardianSim = {
          id: this.nextEntityId++,
          kind: ENT.GUARDIAN,
          x: cellsToFp(spawn.x + 0.5),
          y: cellsToFp(spawn.y + 0.5),
          ownerId: chest.id,
          cooldownEnd: 0,
          homeX: cellsToFp(spawn.x + 0.5),
          homeY: cellsToFp(spawn.y + 0.5),
          targetId: -1,
          attackCooldownEnd: 0,
          weaponKind: GUARDIAN_VARIANT.RUIN,
          facing: 0
        };
        this.guardians.push(guardian);
        this.entities.set(guardian.id, guardian);
      }
    }
    const landmarkVariant = (kind: GeneratedMap["specialSites"][number]["kind"]): number =>
      kind === "volcano" ? LANDMARK.VOLCANO
        : kind === "ritual" ? LANDMARK.RITUAL
          : kind === "oasis" ? LANDMARK.OASIS
            : LANDMARK.ANCIENT_VAULT;
    const chestVariant = (kind: GeneratedMap["specialSites"][number]["kind"]): number =>
      kind === "volcano" ? CHEST_VARIANT.VOLCANO
        : kind === "ritual" ? CHEST_VARIANT.RITUAL
          : kind === "oasis" ? CHEST_VARIANT.OASIS
            : CHEST_VARIANT.ANCIENT_VAULT;
    for (const site of this.map.specialSites) {
      const landmark: EntitySim = {
        id: this.nextEntityId++,
        kind: ENT.LANDMARK,
        x: cellsToFp(site.x + 0.5),
        y: cellsToFp(site.y + 0.5),
        ownerId: -1,
        cooldownEnd: 0,
        weaponKind: landmarkVariant(site.kind)
      };
      const cache: EntitySim = {
        id: this.nextEntityId++,
        kind: ENT.CHEST,
        x: cellsToFp(site.cacheX + 0.5),
        y: cellsToFp(site.cacheY + 0.5),
        ownerId: -1,
        cooldownEnd: 0,
        flags: 0,
        weaponKind: chestVariant(site.kind)
      };
      this.entities.set(landmark.id, landmark);
      this.entities.set(cache.id, cache);
    }
    for (const spawn of this.map.ambientEnemies) {
      const variant = spawn.variant === "emberling" ? GUARDIAN_VARIANT.EMBERLING
        : spawn.variant === "wraith" ? GUARDIAN_VARIANT.BONE_WRAITH
          : GUARDIAN_VARIANT.TUNNEL_CRAWLER;
      const guardian: GuardianSim = {
        id: this.nextEntityId++,
        kind: ENT.GUARDIAN,
        x: cellsToFp(spawn.x + 0.5),
        y: cellsToFp(spawn.y + 0.5),
        ownerId: -1,
        cooldownEnd: 0,
        homeX: cellsToFp(spawn.x + 0.5),
        homeY: cellsToFp(spawn.y + 0.5),
        targetId: -1,
        attackCooldownEnd: 0,
        retargetAt: this.tick,
        weaponKind: variant,
        facing: 0
      };
      this.guardians.push(guardian);
      this.entities.set(guardian.id, guardian);
    }
  }

  private stepGuardians(): void {
    const cfg = this.bal.treasure;
    const baseSpeedFp = Math.round((cfg.guardianSpeed / this.bal.world.cellPx / TICK_HZ) * FP);
    const baseAggro2 = cellsToFp(cfg.guardianAggroRadiusCells) ** 2;
    const baseLeash2 = cellsToFp(cfg.guardianLeashRadiusCells) ** 2;
    const attack2 = cellsToFp(cfg.guardianAttackRangeCells) ** 2;
    for (const guardian of this.guardians) {
      if (!this.entities.has(guardian.id)) continue;
      const variant = guardian.weaponKind ?? GUARDIAN_VARIANT.RUIN;
      const ambient = guardian.ownerId < 0;
      const speedFp = Math.round(baseSpeedFp * (variant === GUARDIAN_VARIANT.TUNNEL_CRAWLER ? 1.16 : variant === GUARDIAN_VARIANT.BONE_WRAITH ? 1.08 : variant === GUARDIAN_VARIANT.EMBERLING ? 0.94 : 1));
      const aggro2 = ambient ? cellsToFp(cfg.guardianAggroRadiusCells * 1.25) ** 2 : baseAggro2;
      const leash2 = ambient ? cellsToFp(Math.max(48, cfg.guardianLeashRadiusCells * 2.6)) ** 2 : baseLeash2;
      const outsideLeash = (guardian.x - guardian.homeX) ** 2 + (guardian.y - guardian.homeY) ** 2 > leash2;
      const candidates = (outsideLeash ? [] : this.players)
        .filter((p) => !p.eliminated)
        .map((p) => ({ p, d2: (p.x - guardian.x) ** 2 + (p.y - guardian.y) ** 2 }))
        .filter((entry) =>
          entry.d2 <= aggro2 &&
          (entry.p.x - guardian.homeX) ** 2 + (entry.p.y - guardian.homeY) ** 2 <= leash2
        )
        .sort((a, b) => a.d2 - b.d2);
      const target = candidates[0]?.p;
      if (!target && ambient && this.tick >= (guardian.retargetAt ?? 0)) {
        guardian.retargetAt = this.tick + 90 + this.rngZombies.nextInt(150);
        for (let tries = 0; tries < 16; tries++) {
          const angle = this.rngZombies.nextFloat() * Math.PI * 2;
          const distance = cellsToFp(6 + this.rngZombies.nextInt(22));
          const wanderX = guardian.homeX + Math.round(Math.cos(angle) * distance);
          const wanderY = guardian.homeY + Math.round(Math.sin(angle) * distance);
          if (!this.world.isSolid(Math.floor(wanderX / FP), Math.floor(wanderY / FP))) {
            guardian.targetX = wanderX;
            guardian.targetY = wanderY;
            break;
          }
        }
      }
      const tx = target?.x ?? guardian.targetX ?? guardian.homeX;
      const ty = target?.y ?? guardian.targetY ?? guardian.homeY;
      const dx = tx - guardian.x;
      const dy = ty - guardian.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const moved = moveCircle(this.world, guardian.x, guardian.y, this.playerRadiusFp, Math.round(dx / length * speedFp), Math.round(dy / length * speedFp));
      guardian.x = moved.x;
      guardian.y = moved.y;
      guardian.facing = Math.round((((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
      if (target && (target.x - guardian.x) ** 2 + (target.y - guardian.y) ** 2 <= attack2 && this.tick >= guardian.attackCooldownEnd) {
        guardian.attackCooldownEnd = this.tick + cfg.guardianAttackCooldownTicks;
        const label = variant === GUARDIAN_VARIANT.TUNNEL_CRAWLER ? "a tunnel crawler"
          : variant === GUARDIAN_VARIANT.EMBERLING ? "an emberling"
            : variant === GUARDIAN_VARIANT.BONE_WRAITH ? "a bone wraith"
              : "a ruin guardian";
        const damage = variant === GUARDIAN_VARIANT.TUNNEL_CRAWLER ? 24
          : variant === GUARDIAN_VARIANT.EMBERLING ? 34
            : variant === GUARDIAN_VARIANT.BONE_WRAITH ? 20
              : this.bal.combat.guardianDamage;
        this.damagePlayer(target, damage, label, label);
      }
    }
    this.checkWinCondition();
  }

  private collectNearbyChest(p: PlayerSim): void {
    const range2 = cellsToFp(this.bal.treasure.chestInteractRangeCells) ** 2;
    const chest = [...this.entities.values()].find((entity) =>
      entity.kind === ENT.CHEST && (entity.x - p.x) ** 2 + (entity.y - p.y) ** 2 <= range2
    );
    if (!chest) return;
    if ([...this.entities.values()].some((entity) => entity.kind === ENT.GUARDIAN && entity.ownerId === chest.id)) return;
    const variant = chest.weaponKind ?? CHEST_VARIANT.RUIN;
    if (variant !== CHEST_VARIANT.RUIN) {
      let label: string;
      let place: string;
      if (variant === CHEST_VARIANT.VOLCANO) {
        label = "Phoenix Casing";
        place = "the Eternal Caldera";
        p.relics |= RELIC.PHOENIX_CASING;
        p.bombFeatures |= BOMB_FEATURE.SHIELD;
        p.weaponBlueprints |= weaponBlueprintBit("napalm");
        p.napalm += 2;
      } else if (variant === CHEST_VARIANT.RITUAL) {
        label = "Dead Miner’s Switch";
        place = "a forbidden ritual ground";
        p.relics |= RELIC.DEAD_MINERS_SWITCH;
        p.bombFeatures |= BOMB_FEATURE.REMOTE;
        p.weaponBlueprints |= weaponBlueprintBit("vampire-bomb");
      } else if (variant === CHEST_VARIANT.OASIS) {
        label = "Geode Heart";
        place = "a living oasis";
        p.relics |= RELIC.GEODE_HEART;
        p.bombFeatures |= BOMB_FEATURE.PROSPECTOR;
        p.weaponBlueprints |= weaponBlueprintBit("cryo-bomb");
        p.healthLevel = Math.min(this.bal.playerUpgrades.vitality.maxLevel, p.healthLevel + 1);
        p.health = this.playerMaxHealth(p);
      } else {
        label = "Echo Core";
        place = "an ancient vault";
        p.relics |= RELIC.ECHO_CORE;
        p.bombFeatures |= BOMB_FEATURE.TWIN;
        p.weaponBlueprints |= weaponBlueprintBit("phase-bomb");
      }
      this.entities.delete(chest.id);
      this.events.push({ type: "entities", added: [], removed: [chest.id] });
      this.events.push({ type: "log", playerId: p.id, msg: `${label} recovered — relic gear installed` });
      this.events.push({ type: "feed", kind: "loot", msg: `${p.name} recovered ${label} from ${place}` });
      this.emitSound(SOUND.CRAFT, p.x, p.y, 220);
      return;
    }
    const loot = this.rngLoot.nextInt(6);
    const key = loot === 0 ? "dynamite" : loot === 1 ? "c4" : loot === 2 ? "clusterBombs" : loot === 3 ? "napalm" : loot === 4 ? "nukes" : "turretKits";
    const label = loot === 0 ? "Dynamite" : loot === 1 ? "C4" : loot === 2 ? "Cluster Bomb" : loot === 3 ? "Napalm" : loot === 4 ? "Nuke" : "Turret Kit";
    p[key]++;
    this.entities.delete(chest.id);
    this.events.push({ type: "entities", added: [], removed: [chest.id] });
    this.events.push({ type: "log", playerId: p.id, msg: `Ruin treasure collected: ${label}` });
    this.events.push({ type: "feed", kind: "loot", msg: `${p.name} uncovered ${label} in a fossil ruin` });
    this.emitSound(SOUND.CRAFT, p.x, p.y, 180);
  }

  /** The unique central caldera is never dormant. Its renderer continuously
   *  erupts; this authoritative pulse makes lingering on the molten rim risky. */
  private stepLandmarkHazards(): void {
    const volcano = this.map.specialSites.find((site) => site.kind === "volcano");
    if (!volcano) return;
    const vx = cellsToFp(volcano.x + 0.5);
    const vy = cellsToFp(volcano.y + 0.5);
    if (this.tick % 150 === 0) this.emitSound(SOUND.COLLAPSE, vx, vy, 255);
    if (this.tick % 45 !== 0) return;
    const heat2 = cellsToFp(16) ** 2;
    for (const player of this.players) {
      if (player.eliminated || (player.x - vx) ** 2 + (player.y - vy) ** 2 > heat2) continue;
      this.damagePlayer(player, 6, "the caldera's heat", "the Eternal Caldera");
    }
    this.checkWinCondition();
  }

  private stepBurningGround(): void {
    for (const [key, fire] of this.burningCells) if (fire.endTick <= this.tick) this.burningCells.delete(key);
    for (const [key, field] of this.residualFields) if (field.endTick <= this.tick) this.residualFields.delete(key);
    for (const player of this.players) {
      if (player.eliminated) continue;
      const cx = Math.floor(player.x / FP);
      const cy = Math.floor(player.y / FP);
      let fireSource: { ownerId: number } | undefined;
      let fieldSource: { ownerId: number; kind: ResidualFieldKind } | undefined;
      for (let dy = -2; dy <= 2 && (!fireSource || !fieldSource); dy++) for (let dx = -2; dx <= 2 && (!fireSource || !fieldSource); dx++) {
        const fire = this.burningCells.get(`${cx + dx}:${cy + dy}`);
        if (!fireSource && fire && this.bombBlastHits(player, [fire])) fireSource = fire;
        const field = this.residualFields.get(`${cx + dx}:${cy + dy}`);
        if (!fieldSource && field && this.bombBlastHits(player, [field])) fieldSource = field;
      }
      if (fireSource) {
        const owner = this.players[fireSource.ownerId];
        const shieldedOwner = owner?.id === player.id && (owner.bombFeatures & BOMB_FEATURE.SHIELD) !== 0;
        if (!shieldedOwner && this.tick >= player.nextNapalmDamageTick) {
          player.nextNapalmDamageTick = this.tick + this.bal.combat.napalmDamageIntervalTicks;
          this.damagePlayer(player, this.bal.combat.napalmDamage, owner ? `${owner.name}'s napalm` : "napalm fire");
        }
      }
      if (!fieldSource || player.eliminated || this.tick < player.nextFieldEffectTick) continue;
      const owner = this.players[fieldSource.ownerId];
      if (owner?.id === player.id && (owner.bombFeatures & BOMB_FEATURE.SHIELD) !== 0) continue;
      player.nextFieldEffectTick = this.tick + 20;
      if (fieldSource.kind === "acid-bomb") {
        const damage = Math.max(1, Math.round(7 * this.poweredShieldMultiplier(player.id, player.x, player.y)));
        this.damagePlayer(player, damage, owner ? `${owner.name}'s acid pool` : "corrosive acid");
      } else if (fieldSource.kind === "gas-bomb") {
        player.oxygen = Math.max(0, player.oxygen - 6);
      } else if (fieldSource.kind === "cryo-bomb") {
        player.slowedUntilTick = Math.max(player.slowedUntilTick, this.tick + 32);
      } else if (fieldSource.kind === "emp-charge") {
        player.stamina = Math.max(0, player.stamina - 14);
        player.stunUntilTick = Math.max(player.stunUntilTick, this.tick + 6);
      }
    }
    this.checkWinCondition();
  }

  playerMaxHealth(player: PlayerSim): number {
    return this.bal.combat.baseHealth + player.healthLevel * this.bal.playerUpgrades.vitality.healthPerLevel;
  }

  resourceSenseRadiusCells(player: PlayerSim): number {
    return this.bal.vision.dayRadiusCells + player.visionLevel * this.bal.playerUpgrades.vision.radiusPerLevelCells;
  }

  private damagePlayer(player: PlayerSim, damage: number, source: string, publicSource = source): void {
    if (player.eliminated || damage <= 0) return;
    if (damage >= player.health && (player.relics & RELIC.PHOENIX_CASING) !== 0) {
      player.relics &= ~RELIC.PHOENIX_CASING;
      player.health = 1;
      const rebirth = this.spawnBomb(
        player,
        Math.floor(player.x / FP),
        Math.floor(player.y / FP),
        WEAPON.BASE_CORE,
        0,
        10,
        2,
        BOMB_FEATURE.SHIELD,
        true
      );
      if (rebirth) rebirth.targetId = -2;
      this.events.push({ type: "log", playerId: player.id, msg: "Phoenix Casing shattered — lethal damage denied" });
      this.events.push({ type: "feed", kind: "combat", msg: `${player.name} erupted from a Phoenix Casing` });
      return;
    }
    player.health = Math.max(0, player.health - damage);
    if (player.health <= 0) {
      this.eliminatePlayer(player, source, publicSource);
      return;
    }
    this.events.push({
      type: "log",
      playerId: player.id,
      msg: `${source[0].toUpperCase()}${source.slice(1)} hit you — ${player.health}/${this.playerMaxHealth(player)} health`
    });
  }

  private eliminatePlayer(player: PlayerSim, source: string, publicSource = source): void {
    if (player.eliminated) return;
    if ((player.relics & RELIC.DEAD_MINERS_SWITCH) !== 0) {
      let armed = 0;
      for (const bomb of this.entities.values()) {
        if (bomb.kind !== ENT.BOMB || bomb.ownerId !== player.id || bomb.launchEndTick !== undefined) continue;
        bomb.cooldownEnd = this.tick;
        armed++;
      }
      this.triggerCharges(player);
      if (armed > 0) this.events.push({ type: "feed", kind: "combat", msg: `${player.name}'s dead miner switch armed ${armed} charge${armed === 1 ? "" : "s"}` });
    }
    player.health = 0;
    player.eliminated = true;
    player.incapacitated = true;
    player.convertingUntilTick = 0;
    player.captureWindupEnd = 0;
    player.carriedGems = 0;
    this.events.push({ type: "log", playerId: player.id, msg: `You were killed by ${source}` });
    this.events.push({ type: "feed", kind: "down", msg: `${player.name} was eliminated by ${publicSource}` });
  }

  /* ------------------------------------------- spawn-point zombies */

  private spawnPlayerZombies(): void {
    for (const player of this.players) {
      for (let i = 0; i < this.bal.zombies.perPlayer; i++) {
        const z: ZombieSim = {
          id: this.nextEntityId++,
          kind: ENT.ZOMBIE,
          x: player.x,
          y: player.y,
          ownerId: -1,
          cooldownEnd: 0,
          targetId: -1,
          retargetAt: 0,
          pathRefreshAt: 0,
          waypointX: player.x,
          waypointY: player.y,
          attackCooldownEnd: 0,
          facing: 0
        };
        this.zombies.push(z);
        this.entities.set(z.id, z);
      }
    }
  }

  private stepZombies(): void {
    const cfg = this.bal.zombies;
    if (!this.zombiesReleased()) {
      for (const z of this.zombies) z.targetId = -1;
      return;
    }
    if (!this.zombieReleaseAnnounced && this.zombies.length > 0) {
      this.zombieReleaseAnnounced = true;
      for (const z of this.zombies) {
        z.retargetAt = this.tick;
        z.pathRefreshAt = this.tick;
      }
      this.events.push({ type: "log", playerId: null, msg: "Zombies have awakened at every starting point" });
      for (const z of this.zombies) this.emitSound(SOUND.ZOMBIE, z.x, z.y, 255);
    }
    const aggroFp = cellsToFp(cfg.aggroRadiusCells);
    const attackFp = cellsToFp(cfg.attackRangeCells);
    const speedFp = Math.round((cfg.speed / this.bal.world.cellPx / TICK_HZ) * FP);

    for (const z of this.zombies) {
      let target: PlayerSim | undefined = this.players[z.targetId];
      const targetValid =
        target &&
        target.role === ROLE.MINER &&
        target.convertingUntilTick === 0 &&
        !target.incapacitated &&
        !target.eliminated &&
        (target.x - z.x) ** 2 + (target.y - z.y) ** 2 <= aggroFp * aggroFp;

      if (this.tick >= z.retargetAt || !targetValid) {
        const nearby = this.players.filter(
          (p) =>
            p.role === ROLE.MINER &&
            p.convertingUntilTick === 0 &&
            !p.incapacitated &&
            !p.eliminated &&
            (p.x - z.x) ** 2 + (p.y - z.y) ** 2 <= aggroFp * aggroFp
        );
        target = nearby.length > 0 ? nearby[this.rngZombies.nextInt(nearby.length)] : undefined;
        z.targetId = target?.id ?? -1;
        z.retargetAt = this.tick + cfg.retargetTicks;
        z.pathRefreshAt = this.tick;
      }

      if (!target) continue;
      const d2 = (target.x - z.x) ** 2 + (target.y - z.y) ** 2;
      if (d2 <= attackFp * attackFp && this.tick >= z.attackCooldownEnd) {
        if (hasLineOfSight(this.world, z.x / FP, z.y / FP, target.x / FP, target.y / FP)) {
          target.convertingUntilTick = this.tick + Math.round((this.bal.capture.conversionMs / 1000) * TICK_HZ);
          target.captureWindupEnd = 0;
          z.attackCooldownEnd = this.tick + Math.round((cfg.attackCooldownMs / 1000) * TICK_HZ);
          z.targetId = -1;
          z.retargetAt = this.tick + cfg.retargetTicks;
          this.events.push({ type: "log", playerId: target.id, msg: "A zombie caught you" });
          this.emitSound(SOUND.ZOMBIE, target.x, target.y, 180);
          continue;
        }
      }

      if (this.tick >= z.pathRefreshAt) {
        const next = hasLineOfSight(this.world, z.x / FP, z.y / FP, target.x / FP, target.y / FP)
          ? { x: target.x, y: target.y }
          : this.findZombieWaypoint(z, target);
        z.waypointX = next.x;
        z.waypointY = next.y;
        z.pathRefreshAt = this.tick + cfg.pathRefreshTicks;
      }

      const dx = z.waypointX - z.x;
      const dy = z.waypointY - z.y;
      const len = Math.hypot(dx, dy);
      if (len < FP / 8) {
        z.pathRefreshAt = this.tick;
        continue;
      }
      const mx = Math.round((dx / len) * speedFp);
      const my = Math.round((dy / len) * speedFp);
      const moved = moveCircle(this.world, z.x, z.y, this.playerRadiusFp, mx, my);
      z.x = moved.x;
      z.y = moved.y;
      z.facing = Math.round((((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
      if (moved.hitX || moved.hitY) z.pathRefreshAt = this.tick;
    }
  }

  /** Bounded deterministic BFS through excavated cells. It returns a short
   *  look-ahead waypoint, keeping zombies responsive without global paths. */
  private findZombieWaypoint(z: ZombieSim, target: PlayerSim): { x: number; y: number } {
    const sx = Math.floor(z.x / FP);
    const sy = Math.floor(z.y / FP);
    const tx = Math.floor(target.x / FP);
    const ty = Math.floor(target.y / FP);
    const pad = 48;
    const minX = Math.max(0, Math.min(sx, tx) - pad);
    const minY = Math.max(0, Math.min(sy, ty) - pad);
    const maxX = Math.min(this.world.size - 1, Math.max(sx, tx) + pad);
    const maxY = Math.min(this.world.size - 1, Math.max(sy, ty) + pad);
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const count = width * height;
    const parent = new Int32Array(count);
    parent.fill(-1);
    const queue = new Int32Array(count);
    const local = (x: number, y: number) => (y - minY) * width + (x - minX);
    const start = local(sx, sy);
    const goal = local(tx, ty);
    parent[start] = start;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;

    while (head < tail && parent[goal] === -1) {
      const cur = queue[head++];
      const x = (cur % width) + minX;
      const y = ((cur / width) | 0) + minY;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1]
      ] as const) {
        if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;
        const ni = local(nx, ny);
        if (parent[ni] !== -1 || this.world.isSolid(nx, ny)) continue;
        parent[ni] = cur;
        queue[tail++] = ni;
      }
    }

    if (parent[goal] === -1) return { x: target.x, y: target.y };
    const reverse: number[] = [];
    let cur = goal;
    while (cur !== start) {
      reverse.push(cur);
      cur = parent[cur];
    }
    const lookAhead = reverse[Math.max(0, reverse.length - 6)] ?? goal;
    const x = (lookAhead % width) + minX + 0.5;
    const y = ((lookAhead / width) | 0) + minY + 0.5;
    return { x: cellsToFp(x), y: cellsToFp(y) };
  }

  /* -------------------------------------------------- capture */

  private stepCapture(p: PlayerSim): void {
    if (!this.zombiesReleased() || p.role !== ROLE.INFECTED || p.presentation !== PRES.HUNT) return;
    if (p.convertingUntilTick > 0 || this.tick < p.stunUntilTick || p.incapacitated || p.eliminated) return;
    const pressed = (p.input.buttons & BTN.PRIMARY) !== 0 && (p.prevButtons & BTN.PRIMARY) === 0;

    if (p.captureWindupEnd > 0 && this.tick >= p.captureWindupEnd) {
      p.captureWindupEnd = 0;
      this.resolveCaptureHit(p);
      p.captureCooldownEnd = this.tick + Math.round((this.bal.capture.cooldownMs / 1000) * TICK_HZ);
      return;
    }

    if (pressed && p.captureWindupEnd === 0 && this.tick >= p.captureCooldownEnd) {
      // only start windup if not aiming at breakable wall (break handled in dig step)
      const t = this.aimTargetCell(p, 3);
      if (!monsterBreakable(this.world.get(Math.floor(t.x), Math.floor(t.y)))) {
        p.captureWindupEnd = this.tick + Math.round((this.bal.capture.windupMs / 1000) * TICK_HZ);
        this.emitSound(SOUND.TRANSFORM, p.x, p.y, 90);
      }
    }
  }

  private resolveCaptureHit(hunter: PlayerSim): void {
    const rangeFp = cellsToFp(this.bal.capture.rangeCells);
    for (const q of this.players) {
      if (q.id === hunter.id || q.role !== ROLE.MINER || q.convertingUntilTick > 0 || q.eliminated) continue;
      const d2 = (q.x - hunter.x) ** 2 + (q.y - hunter.y) ** 2;
      if (d2 > rangeFp * rangeFp) continue;
      if (!hasLineOfSight(this.world, hunter.x / FP, hunter.y / FP, q.x / FP, q.y / FP)) continue; // no capture through walls
      // capture!
      q.convertingUntilTick = this.tick + Math.round((this.bal.capture.conversionMs / 1000) * TICK_HZ);
      hunter.stats.captures++;
      hunter.score += 20;
      this.emitSound(SOUND.CAPTURE, q.x, q.y, 150);
      return;
    }
  }

  private checkInfectedVictory(): void {
    if (this.players.every((p) => p.role === ROLE.INFECTED || p.eliminated)) {
      this.endMatch("infected");
    }
  }

  private checkWinCondition(): void {
    if (this.bal.match.winCondition === "lastPlayerStanding") {
      // Let an already-triggered expanding blast finish carving and resolving
      // chain reactions before freezing the simulation on the results screen.
      if (this.bombBlasts.length > 0) return;
      const living = this.players.filter((p) => !p.eliminated);
      if (living.length <= 1) this.endMatch(living.length === 1 ? "player" : "draw", living[0]?.id ?? -1);
      return;
    }
    this.checkInfectedVictory();
  }

  /* -------------------------------------------------- oxygen */

  isVentilatedCell(x: number, y: number): boolean {
    if (!this.world.inBounds(x, y)) return true;
    if (this.world.get(x, y) === MAT.VENT) return true;
    if (this.map.specialSites.some((site) => site.kind === "oasis" && (site.x - x) ** 2 + (site.y - y) ** 2 <= 25 ** 2)) return true;
    if (this.ventilated[y * this.world.size + x] === 1) return true;
    return this.isInsidePoweredOxygenPocket(x, y);
  }

  private isInsidePoweredOxygenPocket(x: number, y: number): boolean {
    const definition = buildingDefinition(BUILDING.OXYGEN_RECYCLER)!;
    const radius2 = cellsToFp(definition.range) ** 2;
    const xFp = cellsToFp(x + 0.5);
    const yFp = cellsToFp(y + 0.5);
    return [...this.entities.values()].some((building) =>
      building.kind === ENT.BUILDING && building.buildingKind === BUILDING.OXYGEN_RECYCLER &&
      ((building.flags ?? 0) & BUILDING_FLAG.POWERED) !== 0 &&
      (building.x - xFp) ** 2 + (building.y - yFp) ** 2 <= radius2 &&
      hasLineOfSight(this.world, building.x / FP, building.y / FP, x + 0.5, y + 0.5)
    );
  }

  private stepOxygen(): void {
    // recompute ventilation lazily
    if (this.ventDirty && this.tick - this.lastVentRecompute >= this.bal.oxygen.ventilationRecomputeTicks) {
      computeVentilation(this.world, {
        target: this.ventilated,
        workspace: this.ventilationWorkspace,
        ventCells: this.map.ventCells
      });
      this.ventDirty = false;
      this.lastVentRecompute = this.tick;
    }

    const dt = 1 / TICK_HZ;
    for (const p of this.players) {
      if (p.eliminated) {
        p.incapacitated = true;
        continue;
      }
      if (p.role === ROLE.INFECTED) {
        p.oxygen = this.bal.oxygen.emergencySeconds;
        p.incapacitated = false;
        continue;
      }
      const cx = Math.floor(p.x / FP);
      const cy = Math.floor(p.y / FP);
      const inVent = this.isVentilatedCell(cx, cy);
      if (inVent || !this.world.inBounds(cx, cy)) {
        p.oxygen = Math.min(this.bal.oxygen.emergencySeconds, p.oxygen + this.bal.oxygen.recoveryPerSecond * dt);
      } else {
        p.oxygen = Math.max(0, p.oxygen - dt);
        if (p.oxygen < 15 && this.tick % 45 === 0) this.emitSound(SOUND.BREATH, p.x, p.y, 40);
      }
      p.incapacitated = p.oxygen <= 0;
    }

  }

  /* -------------------------------------------------- anti-stuck */

  private stepBotUnstuck(): void {
    const stuckThreshold = 120;
    const unstuckRadius = 5;
    for (const p of this.players) {
      if (!p.bot || p.convertingUntilTick > 0) continue;
      const cx = Math.floor(p.x / FP);
      const cy = Math.floor(p.y / FP);
      const prev = this.botStuckPos.get(p.id);
      if (!prev) {
        this.botStuckPos.set(p.id, { x: cx, y: cy });
        this.botStuckTicks.set(p.id, 0);
        continue;
      }
      if (prev.x === cx && prev.y === cy) {
        const stuck = (this.botStuckTicks.get(p.id) ?? 0) + 1;
        this.botStuckTicks.set(p.id, stuck);
        if (stuck >= stuckThreshold) {
          const changes: CellChange[] = [];
          const r2 = unstuckRadius * unstuckRadius;
          for (let y = cy - unstuckRadius; y <= cy + unstuckRadius; y++) {
            for (let x = cx - unstuckRadius; x <= cx + unstuckRadius; x++) {
              if (!this.world.inBounds(x, y)) continue;
              const dx = x - cx;
              const dy = y - cy;
              if (dx * dx + dy * dy > r2) continue;
              const m = this.world.get(x, y);
              if (m === MAT.EMPTY || m === MAT.VENT || m === MAT.REINFORCE || m === MAT.BEDROCK || m === MAT.BOULDER) continue;
              const ch = this.world.set(x, y, MAT.EMPTY);
              if (ch) changes.push(ch);
            }
          }
          if (changes.length) {
            this.ventDirty = true;
            this.pushPatch(changes);
            const np = depenetrate(this.world, p.x, p.y, this.playerRadiusFp);
            p.x = np.x;
            p.y = np.y;
          }
          this.botStuckTicks.set(p.id, 0);
        }
      } else {
        this.botStuckPos.set(p.id, { x: cx, y: cy });
        this.botStuckTicks.set(p.id, 0);
      }
    }
  }

  /* -------------------------------------------------- collapses */

  scheduleCollapse(x: number, y: number, radius: number): void {
    this.collapses.push({ x, y, radius, atTick: this.tick + this.bal.items.charge.fuseTicks, warned: false });
  }

  private stepCollapses(): void {
    for (let i = this.collapses.length - 1; i >= 0; i--) {
      const c = this.collapses[i];
      if (!c.warned) {
        this.emitSound(SOUND.COLLAPSE_WARN, cellsToFp(c.x), cellsToFp(c.y), 120);
        c.warned = true;
      }
      if (this.tick < c.atTick) continue;
      this.collapses.splice(i, 1);
      this.applyCollapse(c);
    }
  }

  private applyCollapse(c: ScheduledCollapse): void {
    const rng = this.rngCollapse;
    const changes: CellChange[] = [];
    // deterministic template: fill empties with rubble, chance-crack solids open
    const r = c.radius;
    for (let y = c.y - r; y <= c.y + r; y++) {
      for (let x = c.x - r; x <= c.x + r; x++) {
        if (!this.world.inBounds(x, y)) continue;
        const dx = x - c.x;
        const dy = y - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const m = this.world.get(x, y);
        if (m === MAT.EMPTY && rng.chance(0.85)) {
          const ch = this.world.set(x, y, MAT.RUBBLE);
          if (ch) changes.push(ch);
        } else if ((m === MAT.SOFT || m === MAT.UNSTABLE) && d2 > (r - 2) * (r - 2) && rng.chance(0.25)) {
          const ch = this.world.set(x, y, MAT.EMPTY); // reveal adjacent weak pockets
          if (ch) changes.push(ch);
        }
      }
    }
    if (changes.length) {
      this.ventDirty = true;
      this.pushPatch(changes);
      this.emitSound(SOUND.COLLAPSE, cellsToFp(c.x), cellsToFp(c.y), 255);
      // shove players out of new rubble
      for (const p of this.players) {
        if (circleCollides(this.world, p.x, p.y, this.playerRadiusFp)) {
          const np = depenetrate(this.world, p.x, p.y, this.playerRadiusFp);
          p.x = np.x;
          p.y = np.y;
        }
      }
      for (const z of this.zombies) {
        if (circleCollides(this.world, z.x, z.y, this.playerRadiusFp)) {
          const np = depenetrate(this.world, z.x, z.y, this.playerRadiusFp);
          z.x = np.x;
          z.y = np.y;
          z.pathRefreshAt = this.tick;
        }
      }
    }
  }

  /* -------------------------------------------------- results / events */

  private endMatch(winner: "miners" | "infected" | "player" | "draw", winnerPlayerId = -1): void {
    if (this.ended) return;
    this.ended = true;
    this.winner = winner;
    this.winnerPlayerId = winnerPlayerId;
    for (const p of this.players) {
      if (p.role === ROLE.MINER && !p.eliminated) {
        p.securedGems += p.carriedGems; // survivors keep everything at end
        p.score += this.bal.gems.surviveBonus + Math.floor(p.stats.survivedTicks / TICK_HZ / 10);
      }
    }
    this.events.push({
      type: "end",
      winner,
      winnerPlayerId,
      scores: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        score: p.score,
        captures: p.stats.captures,
        securedGems: p.securedGems,
        survived: p.role === ROLE.MINER && !p.eliminated
      }))
    });
  }

  private pushPatch(cells: CellChange[]): void {
    const chunkSet = new Map<number, { cx: number; cy: number; rev: number }>();
    for (const ch of cells) {
      const cx = (ch.x / this.world.chunkSize) | 0;
      const cy = (ch.y / this.world.chunkSize) | 0;
      const idx = cy * this.world.chunksPerSide + cx;
      chunkSet.set(idx, { cx, cy, rev: this.world.revisions[idx] });
    }
    this.events.push({ type: "patch", cells, revs: [...chunkSet.values()] });
  }

  private emitSound(sound: number, xFp: number, yFp: number, intensity: number): void {
    this.events.push({ type: "sound", sound, x: Math.floor(xFp / FP), y: Math.floor(yFp / FP), intensity });
  }

  drainEvents(): SimEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /* -------------------------------------------------- visibility (interest mgmt) */

  /** Which players/entities can `viewer` currently see (spec §12.1, §17.5). */
  visibleFor(viewer: PlayerSim): { players: PlayerSim[]; entities: EntitySim[]; nameVisible: Set<number> } {
    const vis = this.bal.vision;
    const nameFp = cellsToFp(vis.nameRangeCells);

    const players: PlayerSim[] = [];
    const nameVisible = new Set<number>();
    for (const q of this.players) {
      if (q.id === viewer.id) continue;
      const d2 = (q.x - viewer.x) ** 2 + (q.y - viewer.y) ** 2;
      if (!hasLineOfSight(this.world, viewer.x / FP, viewer.y / FP, q.x / FP, q.y / FP)) continue;
      players.push(q);
      if (d2 < nameFp * nameFp) nameVisible.add(q.id);
    }

    const entities: EntitySim[] = [];
    for (const e of this.entities.values()) {
      // own devices always visible to owner
      if (e.ownerId !== viewer.id) {
        let visible = hasLineOfSight(this.world, viewer.x / FP, viewer.y / FP, e.x / FP, e.y / FP);
        if (!visible && e.kind === ENT.LANDMARK) {
          // Water and lava occupy landmark centers. Test their open cardinal
          // overlooks so the large site visual appears as soon as its rim does.
          const radius = e.weaponKind === LANDMARK.VOLCANO ? 16 : e.weaponKind === LANDMARK.OASIS ? 12 : 7;
          visible = [[radius, 0], [-radius, 0], [0, radius], [0, -radius]].some(([dx, dy]) =>
            hasLineOfSight(this.world, viewer.x / FP, viewer.y / FP, e.x / FP + dx, e.y / FP + dy)
          );
        }
        if (!visible) continue;
        if (e.kind === ENT.CHARGE) continue; // other players' charges are hidden
      }
      entities.push(e);
    }
    return { players, entities, nameVisible };
  }

  /** Sound audibility per player (distance + LOS attenuation). */
  hearersOf(x: number, y: number, intensity: number): { player: PlayerSim; intensity: number }[] {
    const out: { player: PlayerSim; intensity: number }[] = [];
    const rangeCells = intensity * 0.9; // simple mapping
    for (const p of this.players) {
      const d = Math.hypot(p.x / FP - x, p.y / FP - y);
      if (d > rangeCells) continue;
      const los = hasLineOfSight(this.world, p.x / FP, p.y / FP, x, y);
      const att = los ? 1 : 0.45;
      const heard = Math.max(0, Math.min(255, Math.round(intensity * att * (1 - d / rangeCells))));
      if (heard > 4) out.push({ player: p, intensity: heard });
    }
    return out;
  }
}
