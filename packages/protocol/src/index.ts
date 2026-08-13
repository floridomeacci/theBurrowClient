/** Binary game-channel protocol (spec §17.6). Versioned; hot-path messages
 *  are binary, infrequent control messages are small JSON text frames. */

export const PROTOCOL_VERSION = 10;
export const INPUT_PACKET_BYTES = 15;

export const MSG = {
  // client -> server
  INPUT: 1,
  // server -> client
  SNAPSHOT: 10,
  PATCH: 11,
  CHUNK: 12,
  SOUND: 13
} as const;

/* ---------------------------------------------------------------- input */

export interface InputMsg {
  seq: number;
  moveX: number;
  moveY: number;
  aim: number;
  buttons: number;
  slot: number;
  ackTick: number;
}

export function encodeInput(m: InputMsg): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_PACKET_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, PROTOCOL_VERSION);
  v.setUint8(1, MSG.INPUT);
  v.setUint32(2, m.seq >>> 0, true);
  v.setInt8(6, m.moveX);
  v.setInt8(7, m.moveY);
  v.setUint8(8, m.aim & 255);
  v.setUint16(9, m.buttons & 0xffff, true);
  v.setUint8(11, m.slot & 255);
  // 12..14: ackTick (u24 wraps fine for 30hz matches)
  v.setUint16(12, m.ackTick & 0xffff, true);
  v.setUint8(14, (m.ackTick >>> 16) & 255);
  return buf;
}

export function decodeInput(v: DataView): InputMsg {
  return {
    seq: v.getUint32(2, true),
    moveX: v.getInt8(6),
    moveY: v.getInt8(7),
    aim: v.getUint8(8),
    buttons: v.getUint16(9, true),
    slot: v.getUint8(11),
    ackTick: v.getUint16(12, true) | (v.getUint8(14) << 16)
  };
}

/* -------------------------------------------------------------- snapshot */

export interface SnapshotSelf {
  x: number; // FP
  y: number;
  stamina: number; // 0..255 scaled
  oxygen: number; // 0..255 scaled
  carried: number;
  secured: number;
  reinforceGems: number;
  rubble: number;
  support: number;
  flags: number; // PFLAG bitfield
  slot: number;
  wallUnlocked: number;
  charges: number;
  pickDurability: number;
  gold: number;
  fossils: number;
  copper: number;
  iron: number;
  platinum: number;
  bombSpeedLevel: number;
  bombRangeLevel: number;
  bombWidthLevel: number;
  bombCapacityLevel: number;
  bombFeatures: number;
  health: number;
  maxHealth: number;
  visionLevel: number;
  moveSpeedLevel: number;
  healthLevel: number;
  dynamite: number;
  c4: number;
  clusterBombs: number;
  napalm: number;
  nukes: number;
  turretKits: number;
  weaponBlueprints: number;
  coal: number;
  power: number;
  powerCapacity: number;
  infrastructureUnlocked: number;
  buildingBlueprints: number;
  relics: number;
}

export interface SnapshotEntity {
  kind: number; // ENT.*
  id: number;
  x: number; // FP
  y: number;
  facing: number;
  flags: number;
  variant: number;
  width: number;
  nameVisible: boolean;
}

export interface SnapshotMsg {
  tick: number;
  lastSeq: number;
  phaseIndex: number; // int8: -1 countdown
  phaseEndTick: number;
  self: SnapshotSelf;
  entities: SnapshotEntity[];
}

const SNAP_HEAD = 2 + 4 + 4 + 1 + 4;
const SELF_SIZE = 68;
const ENT_SIZE = 16;

export function encodeSnapshot(m: SnapshotMsg): ArrayBuffer {
  const buf = new ArrayBuffer(SNAP_HEAD + SELF_SIZE + 1 + m.entities.length * ENT_SIZE);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, PROTOCOL_VERSION);
  v.setUint8(o++, MSG.SNAPSHOT);
  v.setUint32(o, m.tick, true);
  o += 4;
  v.setUint32(o, m.lastSeq, true);
  o += 4;
  v.setInt8(o++, m.phaseIndex);
  v.setUint32(o, m.phaseEndTick, true);
  o += 4;
  const s = m.self;
  v.setInt32(o, s.x, true);
  o += 4;
  v.setInt32(o, s.y, true);
  o += 4;
  v.setUint16(o, s.carried, true);
  o += 2;
  v.setUint16(o, s.secured, true);
  o += 2;
  v.setUint16(o, s.reinforceGems, true);
  o += 2;
  v.setUint8(o++, s.stamina);
  v.setUint8(o++, s.oxygen);
  v.setUint8(o++, s.rubble);
  v.setUint8(o++, s.support);
  v.setUint16(o, s.flags, true);
  o += 2;
  v.setUint8(o++, s.slot);
  v.setUint8(o++, s.wallUnlocked);
  v.setUint8(o++, s.charges);
  v.setUint16(o, s.pickDurability, true);
  o += 2;
  v.setUint16(o, s.gold, true);
  o += 2;
  v.setUint16(o, s.fossils, true);
  o += 2;
  v.setUint16(o, s.copper, true);
  o += 2;
  v.setUint16(o, s.iron, true);
  o += 2;
  v.setUint16(o, s.platinum, true);
  o += 2;
  v.setUint8(o++, s.bombSpeedLevel);
  v.setUint8(o++, s.bombRangeLevel);
  v.setUint8(o++, s.bombWidthLevel);
  v.setUint8(o++, s.bombCapacityLevel);
  v.setUint8(o++, s.bombFeatures);
  v.setUint16(o, s.health, true);
  o += 2;
  v.setUint16(o, s.maxHealth, true);
  o += 2;
  v.setUint8(o++, s.visionLevel);
  v.setUint8(o++, s.moveSpeedLevel);
  v.setUint8(o++, s.healthLevel);
  v.setUint8(o++, s.dynamite);
  v.setUint8(o++, s.c4);
  v.setUint8(o++, s.clusterBombs);
  v.setUint8(o++, s.napalm);
  v.setUint8(o++, s.nukes);
  v.setUint8(o++, s.turretKits);
  v.setUint32(o, s.weaponBlueprints >>> 0, true);
  o += 4;
  v.setUint16(o, s.coal, true);
  o += 2;
  v.setUint16(o, s.power, true);
  o += 2;
  v.setUint16(o, s.powerCapacity, true);
  o += 2;
  v.setUint8(o++, s.infrastructureUnlocked);
  v.setUint16(o, s.buildingBlueprints, true);
  o += 2;
  v.setUint16(o, s.relics, true);
  o += 2;
  v.setUint8(o++, m.entities.length);
  for (const e of m.entities) {
    v.setUint8(o++, e.kind);
    v.setUint16(o, e.id, true);
    o += 2;
    v.setInt32(o, e.x, true);
    o += 4;
    v.setInt32(o, e.y, true);
    o += 4;
    v.setUint8(o++, e.facing);
    v.setUint8(o++, e.flags);
    v.setUint8(o++, e.variant);
    v.setUint8(o++, e.width);
    v.setUint8(o++, e.nameVisible ? 1 : 0);
  }
  return buf;
}

export function decodeSnapshot(v: DataView): SnapshotMsg {
  let o = 2;
  const tick = v.getUint32(o, true);
  o += 4;
  const lastSeq = v.getUint32(o, true);
  o += 4;
  const phaseIndex = v.getInt8(o++);
  const phaseEndTick = v.getUint32(o, true);
  o += 4;
  const self: SnapshotSelf = {
    x: v.getInt32(o, true),
    y: v.getInt32(o + 4, true),
    carried: v.getUint16(o + 8, true),
    secured: v.getUint16(o + 10, true),
    reinforceGems: v.getUint16(o + 12, true),
    stamina: v.getUint8(o + 14),
    oxygen: v.getUint8(o + 15),
    rubble: v.getUint8(o + 16),
    support: v.getUint8(o + 17),
    flags: v.getUint16(o + 18, true),
    slot: v.getUint8(o + 20),
    wallUnlocked: v.getUint8(o + 21),
    charges: v.getUint8(o + 22),
    pickDurability: v.getUint16(o + 23, true),
    gold: v.getUint16(o + 25, true),
    fossils: v.getUint16(o + 27, true),
    copper: v.getUint16(o + 29, true),
    iron: v.getUint16(o + 31, true),
    platinum: v.getUint16(o + 33, true),
    bombSpeedLevel: v.getUint8(o + 35),
    bombRangeLevel: v.getUint8(o + 36),
    bombWidthLevel: v.getUint8(o + 37),
    bombCapacityLevel: v.getUint8(o + 38),
    bombFeatures: v.getUint8(o + 39),
    health: v.getUint16(o + 40, true),
    maxHealth: v.getUint16(o + 42, true),
    visionLevel: v.getUint8(o + 44),
    moveSpeedLevel: v.getUint8(o + 45),
    healthLevel: v.getUint8(o + 46),
    dynamite: v.getUint8(o + 47),
    c4: v.getUint8(o + 48),
    clusterBombs: v.getUint8(o + 49),
    napalm: v.getUint8(o + 50),
    nukes: v.getUint8(o + 51),
    turretKits: v.getUint8(o + 52),
    weaponBlueprints: v.getUint32(o + 53, true),
    coal: v.getUint16(o + 57, true),
    power: v.getUint16(o + 59, true),
    powerCapacity: v.getUint16(o + 61, true),
    infrastructureUnlocked: v.getUint8(o + 63),
    buildingBlueprints: v.getUint16(o + 64, true),
    relics: v.getUint16(o + 66, true)
  };
  o += SELF_SIZE;
  const n = v.getUint8(o++);
  const entities: SnapshotEntity[] = [];
  for (let i = 0; i < n; i++) {
    entities.push({
      kind: v.getUint8(o),
      id: v.getUint16(o + 1, true),
      x: v.getInt32(o + 3, true),
      y: v.getInt32(o + 7, true),
      facing: v.getUint8(o + 11),
      flags: v.getUint8(o + 12),
      variant: v.getUint8(o + 13),
      width: v.getUint8(o + 14),
      nameVisible: v.getUint8(o + 15) === 1
    });
    o += ENT_SIZE;
  }
  return { tick, lastSeq, phaseIndex, phaseEndTick, self, entities };
}

/* ---------------------------------------------------------------- patch */

export interface PatchMsg {
  cells: { x: number; y: number; mat: number }[];
  revs: { cx: number; cy: number; rev: number }[];
}

export function encodePatch(m: PatchMsg): ArrayBuffer {
  const buf = new ArrayBuffer(2 + 2 + m.cells.length * 5 + 1 + m.revs.length * 6);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, PROTOCOL_VERSION);
  v.setUint8(o++, MSG.PATCH);
  v.setUint16(o, m.cells.length, true);
  o += 2;
  for (const c of m.cells) {
    v.setUint16(o, c.x, true);
    o += 2;
    v.setUint16(o, c.y, true);
    o += 2;
    v.setUint8(o++, c.mat);
  }
  v.setUint8(o++, m.revs.length);
  for (const r of m.revs) {
    v.setUint8(o++, r.cx);
    v.setUint8(o++, r.cy);
    v.setUint32(o, r.rev, true);
    o += 4;
  }
  return buf;
}

export function decodePatch(v: DataView): PatchMsg {
  let o = 2;
  const n = v.getUint16(o, true);
  o += 2;
  const cells: PatchMsg["cells"] = [];
  for (let i = 0; i < n; i++) {
    cells.push({ x: v.getUint16(o, true), y: v.getUint16(o + 2, true), mat: v.getUint8(o + 4) });
    o += 5;
  }
  const nr = v.getUint8(o++);
  const revs: PatchMsg["revs"] = [];
  for (let i = 0; i < nr; i++) {
    revs.push({ cx: v.getUint8(o), cy: v.getUint8(o + 1), rev: v.getUint32(o + 2, true) });
    o += 6;
  }
  return { cells, revs };
}

/* ---------------------------------------------------------------- chunk */

export interface ChunkMsg {
  cx: number;
  cy: number;
  revision: number;
  checksum: number;
  rle: Uint8Array;
}

export function encodeChunk(m: ChunkMsg): ArrayBuffer {
  const buf = new ArrayBuffer(2 + 1 + 1 + 4 + 4 + 2 + m.rle.length);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, PROTOCOL_VERSION);
  v.setUint8(o++, MSG.CHUNK);
  v.setUint8(o++, m.cx);
  v.setUint8(o++, m.cy);
  v.setUint32(o, m.revision, true);
  o += 4;
  v.setUint32(o, m.checksum, true);
  o += 4;
  v.setUint16(o, m.rle.length, true);
  o += 2;
  new Uint8Array(buf, o).set(m.rle);
  return buf;
}

export function decodeChunk(v: DataView): ChunkMsg {
  let o = 2;
  const cx = v.getUint8(o++);
  const cy = v.getUint8(o++);
  const revision = v.getUint32(o, true);
  o += 4;
  const checksum = v.getUint32(o, true);
  o += 4;
  const len = v.getUint16(o, true);
  o += 2;
  const rle = new Uint8Array(v.buffer, v.byteOffset + o, len).slice();
  return { cx, cy, revision, checksum, rle };
}

/* ---------------------------------------------------------------- sound */

export interface SoundMsg {
  sound: number;
  x: number; // cells
  y: number;
  intensity: number;
}

export function encodeSound(m: SoundMsg): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint8(0, PROTOCOL_VERSION);
  v.setUint8(1, MSG.SOUND);
  v.setUint8(2, m.sound);
  v.setUint16(3, m.x, true);
  v.setUint16(5, m.y, true);
  v.setUint8(7, m.intensity);
  return buf;
}

export function decodeSound(v: DataView): SoundMsg {
  return { sound: v.getUint8(2), x: v.getUint16(3, true), y: v.getUint16(5, true), intensity: v.getUint8(7) };
}

/* ------------------------------------------------------- JSON control types */

export interface JoinMsg {
  t: "join";
  name: string;
  token?: string;
}

export interface WelcomeMsg {
  t: "welcome";
  playerId: number;
  worldSize: number;
  chunkSize: number;
  cellPx: number;
  names: string[];
  tick: number;
  matchId: string;
  spawnX: number;
  spawnY: number;
  devMode: boolean;
}

export type ControlToServer =
  | JoinMsg
  | { t: "start" }
  | { t: "chat"; msg: string }
  | { t: "upgrade"; node: "speed" | "range" | "wide" | "width" | "diagonal" | "twin" | "capacity" | "remote" | "shield" | "prospector" | "vision" | "mobility" | "vitality" }
  | { t: "weapon-tech"; id: "dynamite" | "drill-torpedo" | "shaped-charge" | "acid-bomb" | "collapse-charge" | "material-bomb" | "remote-c4" | "sticky-bomb" | "decoy-bomb" | "proximity-mine" | "shrapnel-mine" | "chain-bomb" | "phase-bomb" | "cluster-bomb" | "bouncing-bomb" | "concussion-bomb" | "cryo-bomb" | "gas-bomb" | "emp-charge" | "napalm" | "auto-turret" | "vampire-bomb" }
  | { t: "dev-view"; direction: -1 | 1 }
  | { t: "dev-camera"; active: boolean; x: number; y: number }
  | { t: "repair"; cx: number; cy: number }
  | { t: "ping"; at: number };

export type ControlToClient =
  | WelcomeMsg
  | { t: "lobby"; players: { id: number; name: string; bot: boolean }[]; hostId: number; selfId: number }
  | { t: "chat"; id: number; name: string; msg: string; at: number }
  | { t: "phase"; index: number; kind: string; endTick: number; tick: number; zombieReleaseTick: number }
  | { t: "role"; role: number }
  | { t: "dev-view"; playerId: number; name: string; bot: boolean; own: boolean }
  | { t: "log"; msg: string }
  | { t: "feed"; kind: "down" | "loot" | "combat"; msg: string }
  | { t: "names"; names: string[] }
  | { t: "pong"; at: number }
  | {
      t: "end";
      winner: string;
      winnerPlayerId: number;
      scores: { id: number; name: string; role: number; score: number; captures: number; securedGems: number; survived: boolean }[];
    }
  | { t: "error"; msg: string };
