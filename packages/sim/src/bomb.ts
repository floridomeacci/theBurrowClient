import { hash2 } from "./rng";
import { WEAPON } from "./constants";
import { WEAPON_BLUEPRINT_IDS, type WeaponBlueprintId } from "./weapon-tree";

export interface BombBlastShapeConfig {
  blastRangeCells: number;
  blastHalfWidthCells: number;
  blastNoiseFringeCells: number;
  blastWobbleCells: number;
  blastDiagonal?: boolean;
}

export type BombBlastPattern =
  | "cross"
  | "line"
  | "forward-line"
  | "cone"
  | "elbow"
  | "bar"
  | "diamond"
  | "compact"
  | "ring"
  | "x"
  | "fork"
  | "fan"
  | "star"
  | "flood";

const BLUEPRINT_PATTERNS: Record<WeaponBlueprintId, BombBlastPattern> = {
  dynamite: "line",
  "drill-torpedo": "forward-line",
  "shaped-charge": "cone",
  "acid-bomb": "elbow",
  "collapse-charge": "bar",
  "material-bomb": "diamond",
  "remote-c4": "diamond",
  "sticky-bomb": "compact",
  "decoy-bomb": "cross",
  "proximity-mine": "ring",
  "shrapnel-mine": "x",
  "chain-bomb": "ring",
  "phase-bomb": "forward-line",
  "cluster-bomb": "compact",
  "bouncing-bomb": "elbow",
  "concussion-bomb": "compact",
  "cryo-bomb": "star",
  "gas-bomb": "flood",
  "emp-charge": "ring",
  napalm: "fan",
  "auto-turret": "compact",
  "vampire-bomb": "fork"
};

export function blastPatternForVariant(variant: number): BombBlastPattern {
  if (variant >= 32) {
    const blueprint = WEAPON_BLUEPRINT_IDS[variant - 32];
    if (blueprint) return BLUEPRINT_PATTERNS[blueprint];
  }
  if (variant === WEAPON.DYNAMITE) return "line";
  if (variant === WEAPON.C4) return "diamond";
  if (variant === WEAPON.CLUSTER) return "compact";
  if (variant === WEAPON.NAPALM) return "fan";
  if (variant === WEAPON.NUKE) return "star";
  if (variant === WEAPON.TURRET || variant === WEAPON.TURRET_SHELL) return "compact";
  if (variant === WEAPON.CLUSTER_CHILD) return "x";
  if (variant === WEAPON.BASE_CORE) return "diamond";
  return "cross";
}

export function blastPatternLabel(pattern: BombBlastPattern): string {
  if (pattern === "forward-line") return "forward bore";
  if (pattern === "elbow") return "L-shaped";
  if (pattern === "bar") return "wide line";
  if (pattern === "compact") return "radial";
  if (pattern === "x") return "diagonal X";
  if (pattern === "fork") return "forked";
  if (pattern === "flood") return "tunnel flood";
  return pattern;
}

/** Weapon-specific silhouette shared by damage, excavation, bots, the live
 * renderer, and the Armory preview. Aim is deliberately octant-quantized so
 * the compact snapshot representation renders exactly what the server hits. */
export function bombBlastPatternContains(
  dx: number,
  dy: number,
  cfg: BombBlastShapeConfig,
  shapeSeed: number,
  pattern: BombBlastPattern,
  aim = 0
): boolean {
  if (pattern === "flood") return false; // flood fill depends on live tunnels
  if (pattern === "cross") return bombBlastArmMask(dx, dy, cfg, shapeSeed) !== 0;
  if (pattern === "star") return bombBlastArmMask(dx, dy, { ...cfg, blastDiagonal: true }, shapeSeed) !== 0;
  if (pattern === "x") {
    return (bombBlastArmMask(dx, dy, { ...cfg, blastDiagonal: true }, shapeSeed) & 12) !== 0;
  }

  const octant = Math.round(((aim & 255) / 32)) & 7;
  const angle = octant * Math.PI / 4;
  const forward = dx * Math.cos(angle) + dy * Math.sin(angle);
  const side = -dx * Math.sin(angle) + dy * Math.cos(angle);
  const edgeNoise = ((hash2(dx, dy, shapeSeed ^ 0x6a09e667) % 5) - 2) * 0.28;
  const width = Math.max(0.75, cfg.blastHalfWidthCells + edgeNoise);
  const range = cfg.blastRangeCells;
  let contained = false;

  if (pattern === "line") {
    contained = Math.abs(forward) <= range && Math.abs(side) <= width;
  } else if (pattern === "forward-line") {
    contained = forward >= -1.25 && forward <= range && Math.abs(side) <= width;
  } else if (pattern === "cone" || pattern === "fan") {
    const flare = pattern === "fan" ? 0.58 : 0.34;
    contained = forward >= -1 && forward <= range && Math.abs(side) <= width + Math.max(0, forward) * flare;
  } else if (pattern === "elbow") {
    const turnAt = Math.max(2, Math.floor(range * 0.56));
    const turnSign = (shapeSeed & 1) === 0 ? 1 : -1;
    const firstLeg = forward >= -1 && forward <= turnAt && Math.abs(side) <= width;
    const secondLeg = Math.abs(forward - turnAt) <= width && side * turnSign >= -width && side * turnSign <= range - turnAt + width;
    contained = firstLeg || secondLeg;
  } else if (pattern === "bar") {
    contained = Math.abs(side) <= range && Math.abs(forward) <= width;
  } else if (pattern === "diamond") {
    const diamondRange = Math.min(range, 8 + cfg.blastHalfWidthCells);
    contained = Math.abs(forward) + Math.abs(side) <= diamondRange + edgeNoise;
  } else if (pattern === "compact") {
    const compactRange = Math.min(range, Math.max(3, cfg.blastHalfWidthCells + 4));
    contained = Math.hypot(dx, dy) <= compactRange + edgeNoise;
  } else if (pattern === "ring") {
    const radius = Math.hypot(dx, dy);
    const outer = Math.min(range, Math.max(5, cfg.blastHalfWidthCells + 6));
    const ringWidth = Math.max(1.5, cfg.blastHalfWidthCells + 0.5);
    contained = radius <= outer + edgeNoise && radius >= Math.max(1.5, outer - ringWidth);
  } else if (pattern === "fork") {
    const splitAt = Math.max(2, range * 0.38);
    const trunk = forward >= -1 && forward <= splitAt && Math.abs(side) <= width;
    const branchDistance = Math.abs(Math.abs(side) - Math.max(0, forward - splitAt) * 0.68);
    const branches = forward >= splitAt && forward <= range && branchDistance <= width;
    contained = trunk || branches;
  }

  // The diagonal engineering upgrade remains stackable without replacing the
  // weapon's primary silhouette.
  if (!contained && cfg.blastDiagonal) {
    contained = (bombBlastArmMask(dx, dy, { ...cfg, blastHalfWidthCells: Math.max(0, cfg.blastHalfWidthCells - 1), blastDiagonal: true }, shapeSeed) & 12) !== 0;
  }
  return contained;
}

/**
 * Deterministic, contiguous blast silhouette shared by simulation and client.
 * Each arm keeps its safe five-cell core, but its center meanders and each
 * edge independently gains an irregular fringe. The tips taper unevenly so
 * the result reads as fractured earth rather than a stamped rectangle.
 */
export function bombBlastContains(
  dx: number,
  dy: number,
  cfg: BombBlastShapeConfig,
  shapeSeed: number
): boolean {
  return bombBlastArmMask(dx, dy, cfg, shapeSeed) !== 0;
}

/** Bit 0 is the horizontal arm and bit 1 is the vertical arm. */
export function bombBlastArmMask(
  dx: number,
  dy: number,
  cfg: BombBlastShapeConfig,
  shapeSeed: number
): number {
  // In the noisy overlap near the center, assign cells to the arm they extend
  // along. This keeps a rigid wall from being bypassed through the unrelated
  // perpendicular arm's fringe.
  let mask =
    (Math.abs(dx) >= Math.abs(dy) && armContains(dx, dy, false, cfg, shapeSeed) ? 1 : 0) |
    (Math.abs(dy) >= Math.abs(dx) && armContains(dy, dx, true, cfg, shapeSeed) ? 2 : 0);
  if (cfg.blastDiagonal) {
    const diagonalCfg = { ...cfg, blastHalfWidthCells: cfg.blastHalfWidthCells + 1 };
    if (armContains(dx, dy - dx, false, diagonalCfg, shapeSeed ^ 0x36a9)) mask |= 4;
    if (armContains(dx, dy + dx, true, diagonalCfg, shapeSeed ^ 0xa63d)) mask |= 8;
  }
  return mask;
}

function armContains(
  longitudinal: number,
  transverse: number,
  vertical: boolean,
  cfg: BombBlastShapeConfig,
  shapeSeed: number
): boolean {
  const along = Math.abs(longitudinal);
  if (along > cfg.blastRangeCells) return false;

  const armSalt = vertical ? 0x71c3 : 0x29af;
  const wobbleRange = Math.max(0, cfg.blastWobbleCells | 0);
  const wobble =
    along <= 1 || wobbleRange === 0
      ? 0
      : (hash2(longitudinal, armSalt, shapeSeed ^ 0x4a39b70d) % (wobbleRange * 2 + 1)) - wobbleRange;
  const cross = transverse - wobble;

  const fringe = Math.max(0, cfg.blastNoiseFringeCells | 0);
  const negativeExtra = edgeFringe(longitudinal, armSalt - 1, fringe, shapeSeed);
  const positiveExtra = edgeFringe(longitudinal, armSalt + 1, fringe, shapeSeed);
  if (cross < -cfg.blastHalfWidthCells - negativeExtra || cross > cfg.blastHalfWidthCells + positiveExtra) {
    return false;
  }

  // Preserve full centerline reach, but roughen and round the outer tip cells.
  const outsideCenter = Math.max(0, Math.abs(cross) - 1);
  const randomInset = outsideCenter > 0 ? hash2(cross, armSalt ^ longitudinal, shapeSeed ^ 0x93d765dd) & 1 : 0;
  const tipInset = Math.min(2, Math.floor(outsideCenter / 2) + randomInset);
  return along <= cfg.blastRangeCells - tipInset;
}

function edgeFringe(longitudinal: number, edgeSalt: number, maxFringe: number, shapeSeed: number): number {
  if (maxFringe <= 0) return 0;
  const roll = hash2(longitudinal, edgeSalt, shapeSeed ^ 0xc2b2ae35) % 100;
  if (maxFringe >= 2 && roll < 22) return 2;
  if (roll < 68) return 1;
  return 0;
}
