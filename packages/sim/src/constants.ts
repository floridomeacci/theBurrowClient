/** Fixed-point scale: 256 sub-units per terrain cell. All authoritative
 *  positions/velocities are integers in FP units. */
export const FP = 256;
export const FP_BITS = 8;

export const cellsToFp = (c: number): number => Math.round(c * FP);
export const fpToCells = (v: number): number => v / FP;
export const fpFloorCell = (v: number): number => v >> FP_BITS;

/** Quantized aim: 0..255 maps to 0..2PI */
export const aimToRadians = (a: number): number => (a / 256) * Math.PI * 2;

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/** Input button bitfield */
export const BTN = {
  PRIMARY: 1, // use selected slot / capture attack
  SPRINT: 2,
  INTERACT: 4, // reserved contextual interaction
  USE: 8, // reserved utility action
  PLACE: 16, // R: place rubble
  TRIGGER: 32, // F: trigger own collapse charges
  HUNT: 64 // toggle hunt stance after zombie release (infected)
} as const;

export const ROLE = { MINER: 0, INFECTED: 1 } as const;
export const PRES = { DISGUISED: 0, HUNT: 1 } as const;

export const PHASE = { COUNTDOWN: -1 } as const;

export const SOUND = {
  DIG: 1,
  GEM: 2,
  COLLAPSE_WARN: 3,
  COLLAPSE: 4,
  RUBBLE_BREAK: 5,
  TRANSFORM: 6,
  CAPTURE: 7,
  BELL: 8,
  PLACE: 9,
  CRAFT: 10,
  STUN: 11,
  BREATH: 12,
  ZOMBIE: 13,
  BOMB: 14
} as const;

export const ENT = {
  PLAYER: 0,
  GEM: 1,
  BELL: 2, // retained protocol id for backwards-safe recordings
  CHARGE: 3,
  ZOMBIE: 4,
  REINFORCE_GEM: 5,
  BOMB: 6,
  BLAST: 7,
  CHEST: 8,
  GUARDIAN: 9,
  TURRET: 10,
  FIRE: 11,
  MINING_BASE: 12,
  AUTO_MINER: 13,
  BUILDING: 14,
  HUNTER: 15,
  ORE_CART: 16,
  LANDMARK: 17
} as const;

/** Persistent world-site visuals. These values travel in entity.variant. */
export const LANDMARK = {
  VOLCANO: 0,
  RITUAL: 1,
  OASIS: 2,
  ANCIENT_VAULT: 3
} as const;

/** Treasure theme/reward carried in entity.variant. */
export const CHEST_VARIANT = {
  RUIN: 0,
  VOLCANO: 1,
  RITUAL: 2,
  OASIS: 3,
  ANCIENT_VAULT: 4
} as const;

/** Guardian and ambient creature silhouettes carried in entity.variant. */
export const GUARDIAN_VARIANT = {
  RUIN: 0,
  TUNNEL_CRAWLER: 1,
  EMBERLING: 2,
  BONE_WRAITH: 3
} as const;

/** Permanent discoveries, except Phoenix Casing which is consumed on use. */
export const RELIC = {
  ECHO_CORE: 1,
  GEODE_HEART: 2,
  PHOENIX_CASING: 4,
  DEAD_MINERS_SWITCH: 8
} as const;

export const BASE_TOOL_SLOT = 27;
export const FIRST_BUILDING_TOOL_SLOT = 28;
export const LAST_BUILDING_TOOL_SLOT = 41;

export const BUILDING_FLAG = {
  POWERED: 1,
  ACTIVE: 2,
  CONNECTED: 4
} as const;

/** Chest state is sent through the existing entity flags byte. */
export const CHEST_FLAG = {
  SEALED: 1
} as const;

export const WEAPON = {
  STANDARD: 0,
  DYNAMITE: 1,
  C4: 2,
  CLUSTER: 3,
  NAPALM: 4,
  NUKE: 5,
  TURRET: 6,
  TURRET_SHELL: 7,
  CLUSTER_CHILD: 8,
  BASE_CORE: 9
} as const;

/** Flags carried by non-player snapshot entities. */
export const EFLAG = {
  AIRBORNE: 1,
  PROJECTILE: 2,
  DRILLING: 4,
  BOUNCING: 8
} as const;

/** Player state flags in snapshots */
export const PFLAG = {
  HUNT: 1,
  CONVERTING: 2,
  STUNNED: 4,
  DIGGING: 8,
  INCAP: 16,
  SPRINT: 32,
  SLOWED: 64
} as const;
