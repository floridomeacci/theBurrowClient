import { BALANCE } from "@burrow/config";
import { BASE_TOOL_SLOT, BOMB_FEATURE, BUILDING, BUILDING_FLAG, CHEST_FLAG, CHEST_VARIANT, EFLAG, ENT, FP, GUARDIAN_VARIANT, LANDMARK, MAT, PFLAG, WEAPON, WEAPON_BLUEPRINT_IDS, blastPatternForVariant, bombBlastArmMask, bombBlastPatternContains, buildingDefinition, buildingForSlot, buildingPrerequisiteMet, hash2, hasLineOfSight, isCraftMaterial, valueNoise, type WeaponBlueprintId } from "@burrow/sim";
import type { ClientState, RemoteEntity } from "./state";

const INTERNAL_W = 960;
const INTERNAL_H = 540;
const TERRAIN_LIGHT_BLEED_PX = 10;
const RESOURCE_LIGHT_BLEED_PX = 28;
const GEM_LIGHT_BLEED_PX = 40;
const OPEN_SHADOW_LIGHT = 0.4;
const VISION_SHADOW_BLEED_PX_PER_LEVEL = 3;
const LIGHT_MASK_MARGIN_CELLS = 3;
const CHARACTER_SHEET_URL = "/sprites/miner-characters.webp";
const MINING_BASE_URL = "/items/current/mining-base-world.webp";
const CHARACTER_FRAME_PX = 200;
const CHARACTER_DRAW_PX = 26;
const CHARACTER_ROWS_BY_OCTANT = [6, 4, 0, 3, 7, 1, 5, 2] as const;

function angleToFacing(angle: number): number {
  return Math.round((((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
}

/** Base palette per material [r,g,b]. Per-cell brightness jitter via hash. */
const PALETTE: Record<number, [number, number, number]> = {
  [MAT.EMPTY]: [53, 41, 34],
  [MAT.SOFT]: [119, 80, 52],
  [MAT.DENSE]: [91, 80, 77],
  [MAT.HARD]: [59, 60, 68],
  [MAT.GEM]: [42, 167, 116],
  [MAT.UNSTABLE]: [139, 80, 41],
  [MAT.BOULDER]: [104, 106, 112],
  [MAT.RUBBLE]: [94, 70, 52],
  [MAT.REINFORCE]: [132, 113, 68],
  [MAT.VENT]: [88, 105, 128],
  [MAT.REINFORCE_GEM]: [48, 127, 207],
  [MAT.BEDROCK]: [55, 58, 61],
  [MAT.GOLD]: [198, 146, 31],
  [MAT.FOSSIL]: [204, 199, 181],
  [MAT.COPPER]: [166, 78, 42],
  [MAT.IRON]: [96, 107, 115],
  [MAT.PLATINUM]: [160, 190, 204],
  [MAT.COAL]: [42, 45, 47],
  [MAT.LAVA]: [184, 54, 20],
  [MAT.MOSS]: [48, 91, 53],
  [MAT.WATER]: [33, 82, 91]
};

const DEPOSIT_HIGHLIGHT: Record<number, [number, number, number]> = {
  [MAT.GEM]: [104, 255, 183],
  [MAT.REINFORCE_GEM]: [144, 215, 255],
  [MAT.GOLD]: [255, 222, 85],
  [MAT.FOSSIL]: [255, 251, 226],
  [MAT.COPPER]: [239, 132, 72],
  [MAT.IRON]: [169, 184, 193],
  [MAT.PLATINUM]: [226, 246, 255],
  [MAT.COAL]: [116, 121, 123]
};

function isDepositMaterial(material: number): boolean {
  return material === MAT.GEM || material === MAT.REINFORCE_GEM || material === MAT.GOLD ||
    material === MAT.FOSSIL || material === MAT.COPPER || material === MAT.IRON || material === MAT.PLATINUM || material === MAT.COAL;
}

function isOpenMaterial(material: number): boolean {
  return material === MAT.EMPTY || material === MAT.VENT;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  gravity: number;
  maxLife?: number;
  size?: number;
  kind?: "dust" | "air" | "spark" | "smoke" | "chip" | "pickup";
  seed?: number;
  targetX?: number;
  targetY?: number;
}

interface PickImpact {
  x: number;
  y: number;
  angle: number;
  life: number;
  maxLife: number;
  color: string;
  seed: number;
}

export interface ToolPreviewSpec {
  slot: number;
  blast?: {
    range: number;
    halfWidth: number;
    diagonal?: boolean;
    variant: number;
    fuseTicks: number;
  };
}

export interface RenderView {
  cameraWorldX?: number;
  cameraWorldY?: number;
  disableFog?: boolean;
  inspectionMode?: boolean;
}

const BOMB_COLORS: Record<number, [string, string]> = {
  [WEAPON.STANDARD]: ["#5a2020", "#171316"],
  [WEAPON.DYNAMITE]: ["#ff9b42", "#6e2d1e"],
  [WEAPON.C4]: ["#76c7ff", "#243c52"],
  [WEAPON.CLUSTER]: ["#d879ff", "#482150"],
  [WEAPON.NAPALM]: ["#ffdc57", "#701d12"],
  [WEAPON.NUKE]: ["#baff5a", "#29441e"],
  [WEAPON.TURRET_SHELL]: ["#b8edff", "#285266"],
  [WEAPON.CLUSTER_CHILD]: ["#ff86c8", "#53233e"],
  [WEAPON.BASE_CORE]: ["#ff6b32", "#4d1712"]
};

const BLUEPRINT_BOMB_COLORS: Record<WeaponBlueprintId, [string, string]> = {
  "dynamite": ["#ff9b42", "#6e2d1e"],
  "drill-torpedo": ["#f1a65a", "#4b3b35"],
  "shaped-charge": ["#ff715f", "#61251f"],
  "acid-bomb": ["#b6ee54", "#36541f"],
  "collapse-charge": ["#c59767", "#4e4036"],
  "material-bomb": ["#f0cf60", "#574725"],
  "remote-c4": ["#76c7ff", "#243c52"],
  "sticky-bomb": ["#ff6b79", "#5d2833"],
  "decoy-bomb": ["#c7b8a0", "#4b4641"],
  "proximity-mine": ["#ffb35c", "#5a3a22"],
  "shrapnel-mine": ["#d6e0e3", "#4d565d"],
  "chain-bomb": ["#64d8bd", "#214c47"],
  "phase-bomb": ["#ba8cff", "#442e68"],
  "cluster-bomb": ["#d879ff", "#482150"],
  "bouncing-bomb": ["#ec78d2", "#57294f"],
  "concussion-bomb": ["#75bfff", "#284862"],
  "cryo-bomb": ["#b7f3ff", "#315b69"],
  "gas-bomb": ["#9bcf64", "#38502c"],
  "emp-charge": ["#6ee8ff", "#225466"],
  "napalm": ["#ffdc57", "#701d12"],
  "auto-turret": ["#ffd06b", "#55401f"],
  "vampire-bomb": ["#ff5572", "#5b172b"]
};

const BLAST_COLORS: Record<number, readonly [string, string, string, string, string]> = {
  [WEAPON.STANDARD]: ["rgba(112,28,17,.58)", "rgba(238,65,22,.92)", "rgba(255,168,43,.97)", "rgba(255,247,174,.98)", "rgba(62,34,31,.72)"],
  [WEAPON.DYNAMITE]: ["rgba(129,43,18,.6)", "rgba(255,99,25,.94)", "rgba(255,190,54,.98)", "rgba(255,250,188,.98)", "rgba(68,39,29,.74)"],
  [WEAPON.C4]: ["rgba(30,70,103,.58)", "rgba(48,157,224,.92)", "rgba(121,215,255,.97)", "rgba(225,250,255,.99)", "rgba(30,44,57,.74)"],
  [WEAPON.CLUSTER]: ["rgba(86,25,105,.6)", "rgba(190,64,231,.92)", "rgba(241,137,255,.97)", "rgba(255,230,255,.99)", "rgba(55,30,61,.74)"],
  [WEAPON.NAPALM]: ["rgba(137,25,9,.64)", "rgba(255,61,13,.94)", "rgba(255,183,31,.98)", "rgba(255,244,128,.99)", "rgba(72,25,19,.76)"],
  [WEAPON.NUKE]: ["rgba(38,105,56,.62)", "rgba(72,232,112,.93)", "rgba(184,255,88,.98)", "rgba(241,255,201,.99)", "rgba(28,58,38,.76)"],
  [WEAPON.TURRET_SHELL]: ["rgba(31,80,100,.58)", "rgba(80,188,229,.92)", "rgba(174,235,255,.97)", "rgba(241,253,255,.99)", "rgba(29,48,56,.72)"],
  [WEAPON.CLUSTER_CHILD]: ["rgba(102,31,75,.58)", "rgba(240,80,166,.92)", "rgba(255,154,211,.97)", "rgba(255,231,245,.99)", "rgba(61,31,48,.72)"],
  [WEAPON.BASE_CORE]: ["rgba(93,20,12,.68)", "rgba(238,52,17,.96)", "rgba(255,142,32,.99)", "rgba(255,242,163,.99)", "rgba(58,27,24,.8)"]
};

function blueprintForVariant(variant: number): WeaponBlueprintId | undefined {
  return variant >= 32 ? WEAPON_BLUEPRINT_IDS[variant - 32] : undefined;
}

function bombColors(variant: number): [string, string] {
  const blueprint = blueprintForVariant(variant);
  return blueprint ? BLUEPRINT_BOMB_COLORS[blueprint] : BOMB_COLORS[variant] ?? BOMB_COLORS[WEAPON.STANDARD];
}

function blastColors(variant: number): readonly [string, string, string, string, string] {
  const blueprint = blueprintForVariant(variant);
  if (!blueprint) return BLAST_COLORS[variant] ?? BLAST_COLORS[WEAPON.STANDARD];
  if (blueprint === "acid-bomb" || blueprint === "gas-bomb") return ["rgba(47,93,30,.6)", "rgba(111,196,57,.92)", "rgba(187,239,91,.97)", "rgba(239,255,188,.99)", "rgba(38,58,30,.75)"];
  if (blueprint === "cryo-bomb") return ["rgba(34,87,106,.58)", "rgba(80,194,226,.92)", "rgba(175,241,255,.98)", "rgba(242,254,255,.99)", "rgba(34,54,63,.74)"];
  if (blueprint === "phase-bomb" || blueprint === "bouncing-bomb") return ["rgba(79,42,112,.6)", "rgba(166,91,226,.92)", "rgba(223,157,255,.98)", "rgba(251,231,255,.99)", "rgba(50,35,62,.74)"];
  if (blueprint === "concussion-bomb" || blueprint === "emp-charge") return ["rgba(26,76,105,.58)", "rgba(47,163,224,.92)", "rgba(132,224,255,.98)", "rgba(232,251,255,.99)", "rgba(28,48,61,.74)"];
  if (blueprint === "vampire-bomb" || blueprint === "sticky-bomb") return ["rgba(112,20,49,.62)", "rgba(225,45,87,.93)", "rgba(255,119,139,.98)", "rgba(255,224,225,.99)", "rgba(62,25,37,.76)"];
  if (blueprint === "chain-bomb" || blueprint === "shrapnel-mine") return ["rgba(37,81,78,.58)", "rgba(66,183,160,.92)", "rgba(164,236,214,.98)", "rgba(236,255,249,.99)", "rgba(32,50,49,.74)"];
  if (blueprint === "material-bomb") return ["rgba(105,73,24,.6)", "rgba(225,158,39,.92)", "rgba(255,216,88,.98)", "rgba(255,250,192,.99)", "rgba(61,47,26,.74)"];
  return ["rgba(123,44,23,.6)", "rgba(239,87,36,.92)", "rgba(255,178,61,.98)", "rgba(255,245,186,.99)", "rgba(64,39,31,.74)"];
}

function residualPreviewMs(variant: number): number {
  if (variant === WEAPON.NAPALM) return (BALANCE.specialWeapons.napalm.burnTicks / 30) * 1000;
  const blueprint = blueprintForVariant(variant);
  if (blueprint === "acid-bomb") return 6000;
  if (blueprint === "cryo-bomb") return 5000;
  if (blueprint === "gas-bomb") return 7000;
  if (blueprint === "emp-charge") return 4000;
  return 0;
}

/** Shared by the world renderer and the HUD preview so both bombs have the
 * exact same fuse flash, silhouette, palette, and pixel dimensions. */
function drawPixelBomb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  variant: number,
  remaining: number,
  now: number,
  airborneProgress?: number
): void {
  const flashMs = 70 + remaining * 360;
  const lit = Math.floor(now / flashMs) % 2 === 0;
  const palette = bombColors(variant);
  const blueprint = blueprintForVariant(variant);
  const cx = Math.round(x);
  const groundCy = Math.round(y);
  const flight = airborneProgress === undefined ? 0 : Math.max(0, Math.min(1, airborneProgress));
  const lift = airborneProgress === undefined ? 0 : Math.round(Math.sin(flight * Math.PI) * 13);
  const cy = groundCy - lift;
  const bright = lit ? palette[0] : palette[1];
  const dark = palette[1];
  const sparkPhase = Math.floor(now / 55) % 4;
  ctx.save();
  const shadowWidth = Math.max(5, 12 - Math.round(lift * 0.35));
  ctx.fillStyle = `rgba(0,0,0,${0.46 - Math.min(0.22, lift * 0.012)})`;
  ctx.fillRect(cx - Math.floor(shadowWidth / 2), groundCy + 6, shadowWidth, 3);
  ctx.fillRect(cx - Math.max(2, Math.floor(shadowWidth / 3)), groundCy + 9, Math.max(4, Math.floor(shadowWidth * 0.66)), 1);

  if (variant === WEAPON.DYNAMITE) {
    ctx.fillStyle = "#1a1110";
    ctx.fillRect(cx - 7, cy - 5, 14, 12);
    for (let stick = 0; stick < 3; stick++) {
      const sx = cx - 6 + stick * 4;
      ctx.fillStyle = dark;
      ctx.fillRect(sx, cy - 5, 4, 11);
      ctx.fillStyle = bright;
      ctx.fillRect(sx + 1, cy - 4, 1, 8);
      ctx.fillStyle = "rgba(255,255,255,.22)";
      ctx.fillRect(sx + 1, cy - 4, 2, 1);
    }
    ctx.fillStyle = "#d8aa5b";
    ctx.fillRect(cx - 7, cy - 1, 14, 2);
    ctx.fillStyle = "#4b351f";
    ctx.fillRect(cx - 7, cy + 1, 14, 1);
  } else if (variant === WEAPON.C4) {
    ctx.fillStyle = "#101416";
    ctx.fillRect(cx - 7, cy - 5, 14, 11);
    ctx.fillStyle = dark;
    ctx.fillRect(cx - 6, cy - 4, 12, 9);
    ctx.fillStyle = "#30383a";
    ctx.fillRect(cx - 5, cy - 3, 10, 2);
    ctx.fillRect(cx - 5, cy + 2, 10, 2);
    ctx.fillStyle = lit ? "#b9eeff" : "#376679";
    ctx.fillRect(cx - 2, cy - 1, 5, 3);
    ctx.fillStyle = "#b74339";
    ctx.fillRect(cx + 4, cy - 3, 1, 1);
    ctx.fillStyle = "#73888d";
    ctx.fillRect(cx - 7, cy - 7, 1, 3);
  } else if (blueprint === "drill-torpedo") {
    ctx.fillStyle = "#111316";
    ctx.fillRect(cx - 8, cy - 4, 13, 9);
    ctx.fillRect(cx + 5, cy - 2, 3, 5);
    ctx.fillStyle = dark;
    ctx.fillRect(cx - 7, cy - 3, 11, 7);
    ctx.fillStyle = bright;
    ctx.fillRect(cx - 5, cy - 2, 8, 2);
    ctx.fillStyle = "#d9dde0";
    ctx.fillRect(cx + 4, cy - 1, 3, 3);
    ctx.fillStyle = "#7b412b";
    ctx.fillRect(cx - 8, cy - 6, 3, 3);
    ctx.fillRect(cx - 8, cy + 4, 3, 3);
  } else if (blueprint === "proximity-mine" || blueprint === "shrapnel-mine") {
    ctx.fillStyle = "#0d1012";
    ctx.fillRect(cx - 7, cy, 14, 5);
    ctx.fillRect(cx - 5, cy - 3, 10, 8);
    ctx.fillStyle = dark;
    ctx.fillRect(cx - 5, cy - 2, 10, 6);
    ctx.fillStyle = bright;
    ctx.fillRect(cx - 3, cy - 1, 6, 2);
    ctx.fillStyle = lit ? "#fff0a2" : "#81352c";
    ctx.fillRect(cx - 1, cy - 4, 3, 3);
    if (blueprint === "shrapnel-mine") {
      ctx.fillStyle = "#b9c4c8";
      ctx.fillRect(cx - 7, cy - 1, 2, 2);
      ctx.fillRect(cx + 5, cy - 1, 2, 2);
    }
  } else if (blueprint === "shaped-charge" || blueprint === "collapse-charge" || blueprint === "emp-charge" || blueprint === "sticky-bomb" || blueprint === "decoy-bomb") {
    ctx.fillStyle = "#101113";
    ctx.fillRect(cx - 7, cy - 5, 14, 11);
    ctx.fillStyle = dark;
    ctx.fillRect(cx - 6, cy - 4, 12, 9);
    ctx.fillStyle = bright;
    ctx.fillRect(cx - 5, cy - 3, 10, 2);
    ctx.fillRect(cx - 5, cy + 2, 10, 1);
    ctx.fillStyle = blueprint === "emp-charge" ? "#d8fbff" : lit ? "#ffe7a0" : "#71352f";
    ctx.fillRect(cx - 2, cy - 1, 4, 3);
    if (blueprint === "sticky-bomb") {
      ctx.fillStyle = "#d9c0aa";
      ctx.fillRect(cx - 8, cy - 3, 2, 7);
      ctx.fillRect(cx + 6, cy - 3, 2, 7);
    } else if (blueprint === "decoy-bomb") {
      ctx.fillStyle = "#827e75";
      ctx.fillRect(cx - 4, cy + 4, 3, 1);
      ctx.fillRect(cx + 2, cy + 4, 3, 1);
    }
  } else {
    // A stepped, hand-pixelled sphere instead of an antialiased canvas arc.
    ctx.fillStyle = "#090a0c";
    ctx.fillRect(cx - 4, cy - 6, 8, 13);
    ctx.fillRect(cx - 6, cy - 4, 12, 9);
    ctx.fillRect(cx - 5, cy - 5, 10, 11);
    ctx.fillStyle = dark;
    ctx.fillRect(cx - 4, cy - 5, 8, 11);
    ctx.fillRect(cx - 5, cy - 3, 10, 7);
    ctx.fillStyle = bright;
    ctx.fillRect(cx - 3, cy - 4, 5, 7);
    ctx.fillRect(cx - 4, cy - 2, 7, 4);
    ctx.fillStyle = "rgba(255,255,255,.3)";
    ctx.fillRect(cx - 3, cy - 4, 3, 1);
    ctx.fillRect(cx - 4, cy - 2, 1, 2);
    ctx.fillStyle = "rgba(0,0,0,.32)";
    ctx.fillRect(cx - 3, cy + 3, 7, 2);
    ctx.fillRect(cx + 3, cy - 1, 2, 4);
    if (variant === WEAPON.CLUSTER || variant === WEAPON.CLUSTER_CHILD) {
      ctx.fillStyle = bright;
      ctx.fillRect(cx - 7, cy - 1, 2, 3);
      ctx.fillRect(cx + 5, cy - 1, 2, 3);
      ctx.fillRect(cx - 1, cy + 6, 3, 2);
    } else if (variant === WEAPON.NAPALM) {
      ctx.fillStyle = "#f0b534";
      ctx.fillRect(cx - 1, cy - 3, 2, 7);
      ctx.fillStyle = "#7d2718";
      ctx.fillRect(cx - 4, cy, 8, 1);
    } else if (variant === WEAPON.NUKE) {
      ctx.fillStyle = "#c9ff59";
      ctx.fillRect(cx - 1, cy - 3, 2, 2);
      ctx.fillRect(cx - 3, cy + 1, 2, 2);
      ctx.fillRect(cx + 1, cy + 1, 2, 2);
      ctx.fillStyle = "#18251a";
      ctx.fillRect(cx - 1, cy, 2, 2);
    } else if (blueprint === "acid-bomb" || blueprint === "gas-bomb") {
      ctx.fillStyle = blueprint === "acid-bomb" ? "#d7ff70" : "#b6dd77";
      ctx.fillRect(cx - 1, cy - 3, 2, 2);
      ctx.fillRect(cx - 3, cy, 2, 2);
      ctx.fillRect(cx + 2, cy + 2, 1, 1);
    } else if (blueprint === "cryo-bomb") {
      ctx.fillStyle = "#e7fcff";
      ctx.fillRect(cx - 1, cy - 4, 2, 9);
      ctx.fillRect(cx - 4, cy - 1, 9, 2);
    } else if (blueprint === "chain-bomb") {
      ctx.fillStyle = "#b2efe0";
      ctx.fillRect(cx - 3, cy - 2, 3, 2);
      ctx.fillRect(cx, cy, 3, 2);
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
    } else if (blueprint === "phase-bomb") {
      ctx.fillStyle = "rgba(239,217,255,.65)";
      ctx.fillRect(cx - 6, cy - 3, 2, 2);
      ctx.fillRect(cx + 5, cy + 2, 2, 2);
    } else if (blueprint === "bouncing-bomb") {
      ctx.fillStyle = "#ffb1e9";
      ctx.fillRect(cx - 5, cy + 4, 10, 2);
      ctx.fillStyle = "#2a1628";
      ctx.fillRect(cx - 3, cy + 6, 6, 1);
    } else if (blueprint === "concussion-bomb") {
      ctx.fillStyle = "#d7f1ff";
      ctx.fillRect(cx - 4, cy - 1, 2, 2);
      ctx.fillRect(cx + 3, cy - 1, 2, 2);
      ctx.fillRect(cx - 1, cy - 4, 2, 2);
      ctx.fillRect(cx - 1, cy + 3, 2, 2);
    } else if (blueprint === "material-bomb") {
      ctx.fillStyle = "#ffd25d";
      ctx.fillRect(cx - 3, cy - 3, 2, 2);
      ctx.fillStyle = "#7fd6b0";
      ctx.fillRect(cx + 1, cy - 1, 2, 2);
      ctx.fillStyle = "#b5e8ff";
      ctx.fillRect(cx - 2, cy + 2, 2, 2);
    } else if (blueprint === "vampire-bomb") {
      ctx.fillStyle = "#ffd7dd";
      ctx.fillRect(cx - 3, cy - 2, 2, 3);
      ctx.fillRect(cx + 2, cy - 2, 2, 3);
      ctx.fillStyle = "#9c1837";
      ctx.fillRect(cx - 1, cy + 1, 2, 3);
    }
  }

  ctx.fillStyle = "#665346";
  ctx.fillRect(cx + 1, cy - 8, 2, 3);
  ctx.fillRect(cx + 3, cy - 9, 2, 2);
  ctx.fillStyle = lit ? "#fff5a1" : "#d86b31";
  ctx.fillRect(cx + 4, cy - 11, 2, 2);
  if (lit) {
    ctx.fillStyle = sparkPhase % 2 === 0 ? "#fffbd2" : "#ff9f35";
    ctx.fillRect(cx + 3 + (sparkPhase === 1 ? 2 : 0), cy - 12, 1, 1);
    ctx.fillRect(cx + 5, cy - 10 - (sparkPhase === 3 ? 2 : 0), 1, 1);
  }
  ctx.restore();
}

function drawPixelBlastCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellPx: number,
  kind: number,
  variant: number,
  entityId: number,
  dx: number,
  dy: number,
  now: number
): void {
  const fire = kind === ENT.FIRE;
  const palette = blastColors(variant);
  const size = Math.max(3, Math.round(cellPx));
  const left = Math.round(x - size / 2);
  const top = Math.round(y - size / 2);
  const phase = Math.floor(now / (fire ? 80 : 45));
  const flicker = hash2(dx + phase, dy - phase, entityId ^ 0x6e31);
  const ox = (flicker >>> 5) % Math.max(1, size - 1);
  const oy = (flicker >>> 9) % Math.max(1, size - 1);
  ctx.save();
  if (fire) {
    const lick = flicker % 3;
    ctx.fillStyle = palette[4];
    ctx.fillRect(left, top + 1, size, size);
    ctx.fillStyle = palette[0];
    ctx.fillRect(left + (lick === 0 ? 1 : 0), top - lick, Math.max(2, size - 1), size + lick);
    ctx.fillStyle = palette[1];
    ctx.fillRect(left + 1, top + 1 - lick, Math.max(1, size - 2), Math.max(2, size - 1 + lick));
    ctx.fillStyle = palette[2];
    ctx.fillRect(left + 1 + (flicker & 1), top + 1, 1, Math.max(1, size - 2));
    if ((flicker & 3) === 0) {
      ctx.fillStyle = palette[3];
      ctx.fillRect(left + ox, top + oy, 1, 1);
    }
  } else {
    // Soft square glow underneath a chamfered, internally textured heat cell.
    ctx.fillStyle = palette[0];
    ctx.fillRect(left - 1, top - 1, size + 2, size + 2);
    ctx.fillStyle = palette[4];
    ctx.fillRect(left, top + size - 1, size, 1);
    ctx.fillRect(left + size - 1, top, 1, size);
    ctx.fillStyle = palette[1];
    ctx.fillRect(left, top + 1, size, Math.max(1, size - 2));
    ctx.fillRect(left + 1, top, Math.max(1, size - 2), size);
    ctx.fillStyle = palette[2];
    if ((flicker & 1) === 0) {
      ctx.fillRect(left + 1, top, Math.max(1, size - 2), size);
    } else {
      ctx.fillRect(left, top + 1, size, Math.max(1, size - 2));
    }
    ctx.fillStyle = palette[3];
    ctx.fillRect(left + ox, top + oy, Math.min(2, size - ox), Math.min(2, size - oy));
  }
  ctx.restore();
}

function drawPixelTurret(ctx: CanvasRenderingContext2D, x: number, y: number, entityId: number, now: number): void {
  const turn = now / 500 + entityId;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const dx = Math.round(Math.cos(turn));
  const dy = Math.round(Math.sin(turn));
  ctx.fillStyle = "rgba(0,0,0,.48)";
  ctx.fillRect(cx - 8, cy + 6, 16, 3);
  ctx.fillStyle = "#17191c";
  ctx.fillRect(cx - 7, cy + 2, 14, 5);
  ctx.fillRect(cx - 5, cy - 5, 10, 10);
  ctx.fillStyle = "#4c4e54";
  ctx.fillRect(cx - 6, cy + 2, 12, 3);
  ctx.fillStyle = "#2b2d31";
  ctx.fillRect(cx - 5, cy + 5, 3, 2);
  ctx.fillRect(cx + 2, cy + 5, 3, 2);
  ctx.fillStyle = "#9b6631";
  ctx.fillRect(cx - 4, cy - 5, 8, 7);
  ctx.fillStyle = "#e3a84f";
  ctx.fillRect(cx - 3, cy - 4, 5, 2);
  ctx.fillStyle = "#ffdf83";
  ctx.fillRect(cx - 1, cy - 3, 2, 2);
  ctx.fillStyle = "#71767c";
  for (let step = 3; step <= 10; step += 3) ctx.fillRect(cx + dx * step - 1, cy - 3 + dy * step - 1, 3, 3);
  ctx.fillStyle = Math.floor(now / 180 + entityId) % 2 === 0 ? "#fff0a6" : "#c45838";
  ctx.fillRect(cx + dx * 11 - 1, cy - 3 + dy * 11 - 1, 2, 2);
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private chunkCanvases = new Map<number, HTMLCanvasElement>();
  private light: HTMLCanvasElement;
  private lightCtx: CanvasRenderingContext2D;
  private terrainLightMask: HTMLCanvasElement;
  private terrainLightRevision = 0;
  private terrainLightKey = "";
  private terrainLightOriginX = 0;
  private terrainLightOriginY = 0;
  private terrainLightWorld: ClientState["world"] = null;
  private particles: Particle[] = [];
  private pickImpacts: PickImpact[] = [];
  private lastPickImpactAt = -Infinity;
  private ventPositions: { x: number; y: number }[] = [];
  private ventScanned = new Set<number>();
  private particleWorld: ClientState["world"] = null;
  private blastBursts = new Map<number, number>();
  private minimap: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;
  private lastMinimapAt = 0;
  private characterSheet: HTMLImageElement;
  private miningBaseImage: HTMLImageElement;
  shake = 0;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    canvas.width = INTERNAL_W;
    canvas.height = INTERNAL_H;
    this.ctx.imageSmoothingEnabled = false;
    this.characterSheet = new Image();
    this.characterSheet.decoding = "async";
    this.characterSheet.src = CHARACTER_SHEET_URL;
    this.miningBaseImage = new Image();
    this.miningBaseImage.decoding = "async";
    this.miningBaseImage.src = MINING_BASE_URL;
    this.light = document.createElement("canvas");
    this.light.width = INTERNAL_W;
    this.light.height = INTERNAL_H;
    this.lightCtx = this.light.getContext("2d")!;
    this.terrainLightMask = document.createElement("canvas");
    this.minimap = minimap;
    this.minimapCtx = minimap.getContext("2d")!;
  }

  screenScale(): { sx: number; sy: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { sx: rect.width / INTERNAL_W, sy: rect.height / INTERNAL_H };
  }

  /** A tiny transparent world viewport for the DETAILS panel. Explosives use
   * the same four-pixel cells and paint routines as live match entities. */
  renderToolPreview(canvas: HTMLCanvasElement, tool: ToolPreviewSpec, now: number): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    const centerX = Math.floor(canvas.width / 2);
    const centerY = Math.floor(canvas.height / 2) + 1;
    if (!tool.blast) {
      this.drawUtilityPreview(ctx, tool.slot, centerX, centerY, now);
      return;
    }

    const base = BALANCE.items.bomb;
    const variant = tool.blast.variant;
    const seed = 4700 + tool.slot * 137;
    // Remote C4 is normally player-triggered, so only its waiting period is
    // condensed; its fuse flashes and ensuing blast are still drawn exactly.
    const fuseMs = variant === WEAPON.C4 ? 3000 : (tool.blast.fuseTicks / 30) * 1000;
    const stepMs = (base.blastStepTicks / 30) * 1000;
    const growthMs = tool.blast.range * stepMs;
    const visualMs = (base.blastVisualTicks / 30) * 1000;
    const clusterMs = variant === WEAPON.CLUSTER
      ? (BALANCE.specialWeapons.cluster.scatterDelayTicks / 30) * 1000
        + (BALANCE.specialWeapons.cluster.childFlightTicks / 30) * 1000
        + (BALANCE.specialWeapons.cluster.childFuseTicks / 30) * 1000
        + BALANCE.specialWeapons.cluster.childRangeCells * stepMs + visualMs
      : 0;
    const residualMs = residualPreviewMs(variant);
    const effectMs = Math.max(growthMs + visualMs, clusterMs, residualMs);
    const pauseMs = 700;
    const local = now % (fuseMs + effectMs + pauseMs);

    if (local < fuseMs) {
      if (tool.slot === 9) drawPixelTurret(ctx, centerX, centerY, seed, now);
      drawPixelBomb(ctx, centerX, centerY, variant, 1 - local / fuseMs, now);
      return;
    }

    const elapsed = local - fuseMs;
    const cfg = {
      ...base,
      blastRangeCells: tool.blast.range,
      blastHalfWidthCells: tool.blast.halfWidth,
      blastDiagonal: Boolean(tool.blast.diagonal)
    };
    if (tool.slot === 9) drawPixelTurret(ctx, centerX, centerY, seed, now);
    if (elapsed <= growthMs + visualMs) {
      const radius = Math.min(tool.blast.range, Math.floor(elapsed / stepMs));
      this.drawPreviewBlast(ctx, centerX, centerY, radius, cfg, ENT.BLAST, variant, seed, now);
    }

    if (residualMs > 0 && elapsed <= residualMs) {
      this.drawPreviewBlast(ctx, centerX, centerY, tool.blast.range, cfg, ENT.FIRE, variant, seed + 1, now);
    }

    if (variant === WEAPON.CLUSTER) {
      this.drawClusterChildren(ctx, centerX, centerY, tool, elapsed, stepMs, visualMs, seed, now);
    }
  }

  private drawPreviewBlast(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    cfg: typeof BALANCE.items.bomb & { blastDiagonal: boolean },
    kind: number,
    variant: number,
    seed: number,
    now: number
  ): void {
    const pattern = blastPatternForVariant(variant);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const contained = pattern === "flood"
          ? this.previewFloodContains(dx, dy, radius, seed)
          : bombBlastPatternContains(dx, dy, cfg, seed, pattern, 0);
        if (!contained) continue;
        drawPixelBlastCell(ctx, centerX + dx * 4, centerY + dy * 4, 4, kind, variant, seed, dx, dy, now);
      }
    }
  }

  private previewFloodContains(dx: number, dy: number, radius: number, seed: number): boolean {
    if (Math.abs(dx) > radius || Math.abs(dy) > radius) return false;
    const mainTunnel = Math.abs(dy - Math.round(Math.sin((dx + seed) * 0.7) * 1.5)) <= 1 && dx >= -radius && dx <= radius;
    const branch = dx >= -1 && dx <= 1 && dy >= -Math.floor(radius * 0.35) && dy <= radius;
    const sidePocket = dy >= Math.floor(radius * 0.45) - 1 && dy <= Math.floor(radius * 0.45) + 1 && dx >= 0 && dx <= Math.floor(radius * 0.7);
    return mainTunnel || branch || sidePocket;
  }

  private drawClusterChildren(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    tool: ToolPreviewSpec,
    elapsed: number,
    stepMs: number,
    visualMs: number,
    seed: number,
    now: number
  ): void {
    if (!tool.blast) return;
    const cluster = BALANCE.specialWeapons.cluster;
    const scatterDelayMs = (cluster.scatterDelayTicks / 30) * 1000;
    const flightMs = (cluster.childFlightTicks / 30) * 1000;
    const childFuseMs = (cluster.childFuseTicks / 30) * 1000;
    const launchedFor = elapsed - scatterDelayMs;
    const childElapsed = launchedFor - flightMs - childFuseMs;
    const base = BALANCE.items.bomb;
    const childCfg = {
      ...base,
      blastRangeCells: cluster.childRangeCells,
      blastHalfWidthCells: 1,
      blastDiagonal: Boolean(tool.blast.diagonal)
    };
    for (let i = 0; i < cluster.childCount; i++) {
      const angle = (i / cluster.childCount) * Math.PI * 2 + (seed % 13) * 0.07;
      const cellX = Math.floor(0.5 + Math.cos(angle) * cluster.scatterRadiusCells);
      const cellY = Math.floor(0.5 + Math.sin(angle) * cluster.scatterRadiusCells);
      const targetX = centerX + cellX * 4;
      const targetY = centerY + cellY * 4;
      const childSeed = seed + i + 1;
      if (launchedFor < 0) continue;
      if (launchedFor < flightMs) {
        const raw = launchedFor / flightMs;
        const travel = raw * raw * (3 - 2 * raw);
        drawPixelBomb(
          ctx,
          centerX + (targetX - centerX) * travel,
          centerY + (targetY - centerY) * travel,
          WEAPON.CLUSTER_CHILD,
          1,
          now,
          raw
        );
      } else if (launchedFor < flightMs + childFuseMs) {
        drawPixelBomb(ctx, targetX, targetY, WEAPON.CLUSTER_CHILD, 1 - (launchedFor - flightMs) / childFuseMs, now);
      } else if (childElapsed <= cluster.childRangeCells * stepMs + visualMs) {
        const radius = Math.min(cluster.childRangeCells, Math.floor(childElapsed / stepMs));
        this.drawPreviewBlast(ctx, targetX, targetY, radius, childCfg, ENT.BLAST, WEAPON.CLUSTER_CHILD, childSeed, now);
      }
    }
  }

  private drawUtilityPreview(
    ctx: CanvasRenderingContext2D,
    slot: number,
    centerX: number,
    centerY: number,
    now: number
  ): void {
    const phase = (now % 1800) / 1800;
    if (slot === 2) {
      const cleared = Math.min(3, Math.floor(phase * 5));
      for (let i = 1; i <= 3; i++) {
        const x = centerX + i * 4;
        ctx.fillStyle = i <= cleared ? "rgba(38,30,28,.38)" : "#3a3846";
        ctx.fillRect(x - 2, centerY - 2, 4, 4);
      }
      this.drawMiner(ctx, centerX - 8, centerY, PFLAG.DIGGING, "#e8b44a", now);
      for (let i = 0; i < 5; i++) {
        const dustX = centerX + 2 + (hash2(i, Math.floor(now / 90), 771) % 15);
        const dustY = centerY - 5 + (hash2(i, Math.floor(now / 90), 337) % 11);
        ctx.fillStyle = "rgba(168,136,96,.72)";
        ctx.fillRect(dustX, dustY, 1, 1);
      }
      return;
    }

    if (slot === 3) {
      const built = Math.min(5, Math.floor(phase * 7));
      for (let i = 0; i < built; i++) {
        const x = centerX + (i - 2) * 4;
        ctx.fillStyle = "#8c7846";
        ctx.fillRect(x - 2, centerY - 2, 4, 4);
        ctx.fillStyle = "#6b5a37";
        ctx.fillRect(x + 1, centerY - 2, 1, 4);
        ctx.fillRect(x - 2, centerY + 1, 4, 1);
      }
      this.drawMiner(ctx, centerX, centerY - 10, 0, "#e8b44a", now);
      return;
    }

    if (slot === BASE_TOOL_SLOT) {
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i <= Math.floor(phase * 4) ? "rgba(45,35,30,.35)" : "#3a3846";
        ctx.fillRect(centerX + 23 + i * 4, centerY - 2, 4, 4);
      }
      this.drawMiningBase(ctx, centerX - 17, centerY + 2, 1, true, now, 0.5);
      this.drawAutoMiner(ctx, centerX + 10 + phase * 12, centerY + 1, 0, true, 0, now);
      return;
    }

    this.drawMiner(ctx, centerX, centerY, 0, "#e8b44a", now);
  }

  addDust(x: number, y: number, color = "#a8886044", n = 4): void {
    for (let i = 0; i < n; i++) {
      const life = 0.4 + Math.random() * 0.4;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 8,
        vx: (Math.random() - 0.5) * 40,
        vy: (Math.random() - 0.5) * 40 - 10,
        life,
        maxLife: life,
        color,
        gravity: 30,
        kind: "dust",
        seed: Math.random() * Math.PI * 2
      });
    }
  }

  /** Directional pick feedback at the actual rock face, including hits that
   *  damage a cell without clearing it yet. */
  addPickImpact(st: ClientState, aim: number, now: number): void {
    if (!st.world || now - this.lastPickImpactAt < 72) return;
    const angle = (aim / 256) * Math.PI * 2;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const playerX = st.predX / FP;
    const playerY = st.predY / FP;
    let targetX = playerX + ux;
    let targetY = playerY + uy;
    let material: number = MAT.EMPTY;
    for (let distance = 1; distance <= BALANCE.dig.reachCells; distance += 0.5) {
      const x = playerX + ux * distance;
      const y = playerY + uy * distance;
      targetX = x;
      targetY = y;
      const candidate = st.world.get(Math.floor(x), Math.floor(y));
      if (!isOpenMaterial(candidate)) {
        material = candidate;
        break;
      }
    }
    if (isOpenMaterial(material)) return;

    this.lastPickImpactAt = now;
    const cellX = Math.floor(targetX);
    const cellY = Math.floor(targetY);
    const impactX = (cellX + 0.5) * st.cellPx;
    const impactY = (cellY + 0.5) * st.cellPx;
    const [r, g, b] = PALETTE[material] ?? PALETTE[MAT.SOFT];
    const chipColor = `rgb(${Math.min(255, r + 24)},${Math.min(255, g + 20)},${Math.min(255, b + 16)})`;
    const dustColor = `rgba(${r},${g},${b},.72)`;
    const tangentX = -uy;
    const tangentY = ux;

    for (let i = 0; i < 7; i++) {
      const spread = (Math.random() - 0.5) * 52;
      const recoil = 22 + Math.random() * 42;
      const life = 0.24 + Math.random() * 0.28;
      this.particles.push({
        x: impactX + (Math.random() - 0.5) * st.cellPx,
        y: impactY + (Math.random() - 0.5) * st.cellPx,
        vx: -ux * recoil + tangentX * spread,
        vy: -uy * recoil + tangentY * spread - 12,
        life,
        maxLife: life,
        color: i % 3 === 0 ? "#d7b06d" : chipColor,
        gravity: 92,
        size: i % 4 === 0 ? 3 : 2,
        kind: i % 3 === 0 ? "spark" : "chip",
        seed: Math.random() * Math.PI * 2
      });
    }
    for (let i = 0; i < 4; i++) {
      const life = 0.32 + Math.random() * 0.3;
      this.particles.push({
        x: impactX - ux * (2 + Math.random() * 4) + tangentX * (Math.random() - 0.5) * 5,
        y: impactY - uy * (2 + Math.random() * 4) + tangentY * (Math.random() - 0.5) * 5,
        vx: -ux * (6 + Math.random() * 15) + tangentX * (Math.random() - 0.5) * 16,
        vy: -uy * (6 + Math.random() * 15) + tangentY * (Math.random() - 0.5) * 16 - 4,
        life,
        maxLife: life,
        color: dustColor,
        gravity: -3,
        size: 2 + (i & 1),
        kind: "smoke",
        seed: Math.random() * Math.PI * 2
      });
    }
    this.pickImpacts.push({
      x: impactX,
      y: impactY,
      angle,
      life: 0.17,
      maxLife: 0.17,
      color: chipColor,
      seed: Math.random() * Math.PI * 2
    });
    this.shake = Math.max(this.shake, 0.65);
    this.trimParticles();
  }

  /** Burst fragments from terrain pixels confirmed as excavated by the server. */
  addPickCrumble(cells: { x: number; y: number; material: number }[], cellPx: number, aim: number): void {
    if (cells.length === 0) return;
    const angle = (aim / 256) * Math.PI * 2;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const tangentX = -uy;
    const tangentY = ux;
    const sampleCount = Math.min(28, cells.length);
    for (let sample = 0; sample < sampleCount; sample++) {
      const cell = cells[Math.floor(sample * cells.length / sampleCount)];
      const [r, g, b] = PALETTE[cell.material] ?? PALETTE[MAT.SOFT];
      const baseX = (cell.x + 0.5) * cellPx;
      const baseY = (cell.y + 0.5) * cellPx;
      const color = `rgb(${Math.min(255, r + 18)},${Math.min(255, g + 14)},${Math.min(255, b + 10)})`;
      const fragments = sample < 10 ? 3 : 2;
      for (let i = 0; i < fragments; i++) {
        const spread = (Math.random() - 0.5) * 70;
        const recoil = 14 + Math.random() * 38;
        const life = 0.3 + Math.random() * 0.38;
        this.particles.push({
          x: baseX + (Math.random() - 0.5) * cellPx,
          y: baseY + (Math.random() - 0.5) * cellPx,
          vx: -ux * recoil + tangentX * spread,
          vy: -uy * recoil + tangentY * spread - 14,
          life,
          maxLife: life,
          color,
          gravity: 100,
          size: 1 + ((sample + i) % 3),
          kind: "chip",
          seed: Math.random() * Math.PI * 2
        });
      }
      if (sample % 3 === 0) {
        const life = 0.45 + Math.random() * 0.3;
        this.particles.push({
          x: baseX,
          y: baseY,
          vx: -ux * (4 + Math.random() * 10),
          vy: -uy * (4 + Math.random() * 10) - 5,
          life,
          maxLife: life,
          color: `rgba(${r},${g},${b},.62)`,
          gravity: -4,
          size: 3,
          kind: "smoke",
          seed: Math.random() * Math.PI * 2
        });
      }
    }
    this.shake = Math.max(this.shake, Math.min(1.8, 0.7 + cells.length / 35));
    this.trimParticles();
  }

  /** Terrain fragments travel away from the explosive origin as each server
   *  confirmed blast cell is carved out. */
  addBombCrumble(
    cells: { x: number; y: number; material: number }[],
    cellPx: number,
    origins: { x: number; y: number }[]
  ): void {
    if (cells.length === 0 || origins.length === 0) return;
    const sampleCount = Math.min(44, cells.length);
    for (let sample = 0; sample < sampleCount; sample++) {
      const cell = cells[Math.floor(sample * cells.length / sampleCount)];
      let origin = origins[0];
      let closest = Infinity;
      for (const candidate of origins) {
        const dx = cell.x + 0.5 - candidate.x;
        const dy = cell.y + 0.5 - candidate.y;
        const distance = dx * dx + dy * dy;
        if (distance < closest) {
          closest = distance;
          origin = candidate;
        }
      }
      let dx = cell.x + 0.5 - origin.x;
      let dy = cell.y + 0.5 - origin.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.1) {
        const angle = Math.random() * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
      } else {
        dx /= length;
        dy /= length;
      }
      const tangentX = -dy;
      const tangentY = dx;
      const [r, g, b] = PALETTE[cell.material] ?? PALETTE[MAT.SOFT];
      const highlight = DEPOSIT_HIGHLIGHT[cell.material];
      const baseX = (cell.x + 0.5) * cellPx;
      const baseY = (cell.y + 0.5) * cellPx;
      const fragmentColor = `rgb(${Math.min(255, r + 22)},${Math.min(255, g + 17)},${Math.min(255, b + 12)})`;
      const fragments = sample < 14 ? 3 : 2;
      for (let i = 0; i < fragments; i++) {
        const spread = (Math.random() - 0.5) * 82;
        const speed = 28 + Math.random() * 64;
        const life = 0.3 + Math.random() * 0.45;
        this.particles.push({
          x: baseX + (Math.random() - 0.5) * cellPx,
          y: baseY + (Math.random() - 0.5) * cellPx,
          vx: dx * speed + tangentX * spread,
          vy: dy * speed + tangentY * spread - 18,
          life,
          maxLife: life,
          color: highlight && i === 0 ? `rgb(${highlight[0]},${highlight[1]},${highlight[2]})` : fragmentColor,
          gravity: 112,
          size: 1 + ((sample + i) % 3),
          kind: highlight && i === 0 ? "spark" : "chip",
          seed: Math.random() * Math.PI * 2
        });
      }
      if (sample % 4 === 0) {
        const life = 0.4 + Math.random() * 0.35;
        this.particles.push({
          x: baseX,
          y: baseY,
          vx: dx * (8 + Math.random() * 16),
          vy: dy * (8 + Math.random() * 16) - 5,
          life,
          maxLife: life,
          color: `rgba(${r},${g},${b},.68)`,
          gravity: -5,
          size: 3 + (sample % 2),
          kind: "smoke",
          seed: Math.random() * Math.PI * 2
        });
      }
    }
    this.shake = Math.max(this.shake, Math.min(3.2, 1.1 + cells.length / 24));
    this.trimParticles();
  }

  /** Loose pickups break into bright shards that curve into the miner. */
  addGemPickup(fromX: number, fromY: number, toX: number, toY: number, reinforce: boolean): void {
    const color = reinforce ? "#58c9ff" : "#ffe367";
    const highlight = reinforce ? "#d9f6ff" : "#fff8bd";
    for (let i = 0; i < 11; i++) {
      const angle = (i / 11) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 12 + Math.random() * 30;
      const life = 0.5 + (i % 4) * 0.045;
      this.particles.push({
        x: fromX + (Math.random() - 0.5) * 5,
        y: fromY + (Math.random() - 0.5) * 5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        color: i % 3 === 0 ? highlight : color,
        gravity: 0,
        size: i % 4 === 0 ? 3 : 2,
        kind: "pickup",
        seed: Math.random() * Math.PI * 2,
        targetX: toX,
        targetY: toY
      });
    }
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const life = 0.2 + Math.random() * 0.14;
      this.particles.push({
        x: fromX,
        y: fromY,
        vx: Math.cos(angle) * (32 + Math.random() * 22),
        vy: Math.sin(angle) * (32 + Math.random() * 22),
        life,
        maxLife: life,
        color: highlight,
        gravity: 0,
        size: i % 2 ? 1 : 2,
        kind: "spark",
        seed: Math.random() * Math.PI * 2
      });
    }
    this.trimParticles();
  }

  /** Ruin loot erupts from the reliquary, briefly fans outward, then streams
   * into the collecting player. It is intentionally richer than common gems. */
  addTreasurePickup(fromX: number, fromY: number, toX: number, toY: number, variant: number = CHEST_VARIANT.RUIN): void {
    const palette = variant === CHEST_VARIANT.VOLCANO ? ["#fff09a", "#ff9a35", "#ef3f22", "#7e2622", "#ffd35a"] as const
      : variant === CHEST_VARIANT.RITUAL ? ["#ffd5d5", "#ed526e", "#9d274e", "#6d4ac4", "#e6c6be"] as const
        : variant === CHEST_VARIANT.OASIS ? ["#eaffc1", "#73d98e", "#49b9b1", "#d7e89d", "#8ee6d4"] as const
          : variant === CHEST_VARIANT.ANCIENT_VAULT ? ["#e7faff", "#75cbe5", "#7c8fd8", "#d6cdb5", "#aeeaf1"] as const
            : ["#fff5be", "#ffd45e", "#dc8d36", "#79d8e8", "#d6cdb5"] as const;
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2 + Math.random() * 0.18;
      const speed = 28 + Math.random() * 58;
      const life = 0.68 + (i % 6) * 0.055;
      this.particles.push({
        x: fromX + (Math.random() - 0.5) * 10,
        y: fromY - 5 + (Math.random() - 0.5) * 7,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 18,
        life,
        maxLife: life,
        color: palette[i % palette.length],
        gravity: 0,
        size: i % 7 === 0 ? 4 : i % 3 === 0 ? 3 : 2,
        kind: "pickup",
        seed: Math.random() * Math.PI * 2,
        targetX: toX,
        targetY: toY
      });
    }
    for (let ray = 0; ray < 12; ray++) {
      const angle = (ray / 12) * Math.PI * 2;
      const life = 0.28 + (ray % 3) * 0.06;
      this.particles.push({
        x: fromX + Math.cos(angle) * 5,
        y: fromY - 3 + Math.sin(angle) * 5,
        vx: Math.cos(angle) * (68 + (ray % 4) * 13),
        vy: Math.sin(angle) * (68 + (ray % 4) * 13),
        life,
        maxLife: life,
        color: ray % 2 === 0 ? "#fff6bf" : "#e6a544",
        gravity: 0,
        size: ray % 3 === 0 ? 2 : 1,
        kind: "spark",
        seed: Math.random() * Math.PI * 2
      });
    }
    for (let dust = 0; dust < 8; dust++) {
      const life = 0.45 + Math.random() * 0.35;
      this.particles.push({
        x: fromX + (Math.random() - 0.5) * 22,
        y: fromY + 4 + (Math.random() - 0.5) * 5,
        vx: (Math.random() - 0.5) * 25,
        vy: -9 - Math.random() * 19,
        life,
        maxLife: life,
        color: dust % 3 === 0 ? "#cfc6ac" : "#756d61",
        gravity: -2,
        size: 2 + (dust & 1),
        kind: "smoke",
        seed: Math.random() * Math.PI * 2
      });
    }
    this.shake = Math.max(this.shake, 1.25);
    this.trimParticles();
  }

  private trimParticles(): void {
    if (this.particles.length > 1200) this.particles.splice(0, this.particles.length - 1200);
  }

  /** Repaint dirty chunk canvases from the world mirror. */
  syncChunks(st: ClientState): void {
    if (!st.world) return;
    if (this.particleWorld !== st.world) {
      this.particleWorld = st.world;
      this.particles.length = 0;
      this.pickImpacts.length = 0;
      this.ventPositions.length = 0;
      this.ventScanned.clear();
      this.blastBursts.clear();
    }
    if (st.dirtyChunks.size > 0) this.terrainLightRevision++;
    const cs = st.chunkSize;
    const px = st.cellPx;
    for (const idx of st.dirtyChunks) {
      const cx = idx % st.world.chunksPerSide;
      const cy = (idx / st.world.chunksPerSide) | 0;
      this.buildChunkCanvas(st, cx, cy, idx);
      // scan this chunk for vent cells (once per load)
      const chunkKey = idx;
      if (!this.ventScanned.has(chunkKey) && st.knownChunks && st.knownChunks[idx]) {
        this.ventScanned.add(chunkKey);
        const x0 = cx * st.chunkSize;
        const y0 = cy * st.chunkSize;
        for (let vy = y0; vy < y0 + st.chunkSize; vy++) {
          for (let vx = x0; vx < x0 + st.chunkSize; vx++) {
            if (st.world!.get(vx, vy) === MAT.VENT) {
              this.ventPositions.push({ x: vx, y: vy });
            }
          }
        }
      }
    }
    st.dirtyChunks.clear();
  }

  /** Always returns a valid canvas for a chunk (lazy-create from world buffer). */
  private getChunkCanvas(st: ClientState, cx: number, cy: number): HTMLCanvasElement {
    if (!st.world) throw new Error("no world");
    const idx = cy * st.world.chunksPerSide + cx;
    let cc = this.chunkCanvases.get(idx);
    if (!cc) this.buildChunkCanvas(st, cx, cy, idx);
    return this.chunkCanvases.get(idx)!;
  }

  private buildChunkCanvas(st: ClientState, cx: number, cy: number, idx: number): void {
    if (!st.world) return;
    const cs = st.chunkSize;
    const px = st.cellPx;
    let cc = this.chunkCanvases.get(idx);
    if (!cc) {
      cc = document.createElement("canvas");
      cc.width = cs * px;
      cc.height = cs * px;
      this.chunkCanvases.set(idx, cc);
    }
    const cctx = cc.getContext("2d")!;
    const img = cctx.createImageData(cs * px, cs * px);
    const data = img.data;
    for (let y = 0; y < cs; y++) {
      const wy = cy * cs + y;
      for (let x = 0; x < cs; x++) {
        const wx = cx * cs + x;
        const m = st.world.mat[wy * st.world.size + wx];
        const base = PALETTE[m] ?? PALETTE[MAT.HARD];
        const deposit = isDepositMaterial(m);
        const open = isOpenMaterial(m);
        const broadNoise = (valueNoise(wx, wy, 22, 0x4521) - 0.5) * (open ? 18 : 10);
        const patchNoise = (valueNoise(wx, wy, 6, 0x91a7) - 0.5) * (open ? 12 : 17);
        const cellNoise = ((hash2(wx, wy, 0x72d3) & 255) / 255 - 0.5) * (open ? 5 : 11);
        const materialNoise = broadNoise + patchNoise + cellNoise;
        const left = st.world.get(wx - 1, wy);
        const right = st.world.get(wx + 1, wy);
        const top = st.world.get(wx, wy - 1);
        const bottom = st.world.get(wx, wy + 1);
        const leftOpen = isOpenMaterial(left);
        const rightOpen = isOpenMaterial(right);
        const topOpen = isOpenMaterial(top);
        const bottomOpen = isOpenMaterial(bottom);
        const detailSeed = hash2(wx, wy, 0xb84f);
        let fossilInfluence = 0;
        if (m === MAT.EMPTY) {
          if (st.world.get(wx - 2, wy) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx + 2, wy) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx, wy - 2) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx, wy + 2) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx - 4, wy) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx + 4, wy) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx, wy - 4) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx, wy + 4) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx - 3, wy - 3) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx + 3, wy - 3) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx - 3, wy + 3) === MAT.FOSSIL) fossilInfluence++;
          if (st.world.get(wx + 3, wy + 3) === MAT.FOSSIL) fossilInfluence++;
        }
        const ruinFloor = fossilInfluence >= 2;
        const crackCell = !open && !deposit && detailSeed % 11 === 0;
        const crackOffset = (detailSeed >>> 8) % Math.max(1, px);
        const pebbleCell = m === MAT.EMPTY && detailSeed % 17 === 0;
        const pebbleX = (detailSeed >>> 10) % Math.max(1, px);
        const pebbleY = (detailSeed >>> 16) % Math.max(1, px);
        for (let py = 0; py < px; py++) {
          for (let pxx = 0; pxx < px; pxx++) {
            const di = ((y * px + py) * cs * px + (x * px + pxx)) * 4;
            const worldPixelX = wx * px + pxx;
            const worldPixelY = wy * px + py;
            const pixelHash = hash2(worldPixelX, worldPixelY, 0xd231);
            const micro = ((pixelHash & 31) - 15) * (open ? 0.38 : deposit ? 0.55 : 0.7);
            let shade = materialNoise + micro;

            // Directional cave-wall relief: bright upper-left lips and deep
            // lower-right seams only at material boundaries, never a rigid grid.
            if (!open) {
              if (py === 0 && top !== m) shade += topOpen ? 26 : 9;
              if (pxx === 0 && left !== m) shade += leftOpen ? 18 : 7;
              if (py === px - 1 && bottom !== m) shade -= bottomOpen ? 31 : 11;
              if (pxx === px - 1 && right !== m) shade -= rightOpen ? 23 : 9;
              if (!deposit && (detailSeed & 3) === 0 && py === 0) shade += 5;
              if (!deposit && (detailSeed & 7) === 1 && pxx === px - 1) shade -= 7;
              if (crackCell && pxx === ((py + crackOffset) % px)) shade -= 25;
            } else if (m === MAT.EMPTY) {
              if (py === 0 && !topOpen) shade -= 13;
              if (pxx === 0 && !leftOpen) shade -= 8;
              if (py === px - 1 && !bottomOpen) shade -= 6;
              if (pxx === px - 1 && !rightOpen) shade -= 5;
              if (pebbleCell && pxx === pebbleX && py === pebbleY) shade -= 20;
              if (pebbleCell && pxx === Math.max(0, pebbleX - 1) && py === Math.max(0, pebbleY - 1)) shade += 10;
              if (ruinFloor) {
                // Subtle cracked paving bleeds a few cells inward from fossil
                // masonry, preserving the cave palette while making ruins read
                // as constructed spaces instead of ordinary empty tunnels.
                shade += 5 + fossilInfluence * 0.8;
                if (((wx + wy) & 3) === 0 && py === px - 1) shade -= 16;
                if (((wx * 3 + wy) & 7) === 1 && pxx === 0) shade -= 11;
                if (pixelHash % 31 === 0) shade += 18;
              }
            }

            if (m === MAT.BEDROCK && pixelHash % 23 === 0) shade += 24;
            if (m === MAT.RUBBLE && pixelHash % 9 === 0) shade -= 14;
            if (m === MAT.VENT) shade += (pxx + py) % 3 === 0 ? 17 : -7;
            if (m === MAT.LAVA) shade += pixelHash % 7 === 0 || pxx === ((py + detailSeed) % px) ? 68 : -8;
            if (m === MAT.MOSS) shade += pixelHash % 9 === 0 ? 32 : pixelHash % 5 === 0 ? -15 : 0;
            if (m === MAT.WATER) shade += py === ((detailSeed >>> 4) % px) ? 35 : pixelHash % 11 === 0 ? 18 : -5;

            let rr = base[0] + shade;
            let gg = base[1] + shade;
            let bb = base[2] + shade;
            if (ruinFloor) {
              rr += 7;
              gg += 6;
              bb += 2;
            }
            const highlight = DEPOSIT_HIGHLIGHT[m];
            if (highlight && (pixelHash % 13 === 0 || ((detailSeed & 7) === 0 && pxx === py))) {
              const mix = pixelHash % 13 === 0 ? 0.78 : 0.48;
              rr += (highlight[0] - rr) * mix;
              gg += (highlight[1] - gg) * mix;
              bb += (highlight[2] - bb) * mix;
            }
            if (m === MAT.EMPTY && pixelHash % 97 === 0) {
              rr += 13;
              gg += 9;
              bb += 5;
            }
            rr = clamp8(rr);
            gg = clamp8(gg);
            bb = clamp8(bb);
            data[di] = rr;
            data[di + 1] = gg;
            data[di + 2] = bb;
            data[di + 3] = 255;
          }
        }
      }
    }
    cctx.putImageData(img, 0, 0);
  }

  render(st: ClientState, now: number, dt: number, ambient: number, mouse: { x: number; y: number }, view: RenderView = {}): { px: number; py: number } {
    const ctx = this.ctx;
    const px = st.cellPx;
    // camera in world px
    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    this.shake = Math.max(0, this.shake - dt * 30);

    const selfPx = (st.predX / FP) * px;
    const selfPy = (st.predY / FP) * px;
    const detached = view.cameraWorldX !== undefined && view.cameraWorldY !== undefined;
    const cameraCenterX = detached ? view.cameraWorldX! : selfPx;
    const cameraCenterY = detached ? view.cameraWorldY! : selfPy;
    const worldPixelSize = st.worldSize * px;
    const camX = Math.round(detached
      ? Math.max(0, Math.min(Math.max(0, worldPixelSize - INTERNAL_W), cameraCenterX - INTERNAL_W / 2))
      : selfPx - INTERNAL_W / 2 + shakeX);
    const camY = Math.round(detached
      ? Math.max(0, Math.min(Math.max(0, worldPixelSize - INTERNAL_H), cameraCenterY - INTERNAL_H / 2))
      : selfPy - INTERNAL_H / 2 + shakeY);

    ctx.fillStyle = "#080608";
    ctx.fillRect(0, 0, INTERNAL_W, INTERNAL_H);

    if (!st.world) return { px: 0, py: 0 };

    // visible chunks
    const chunkPx = st.chunkSize * px;
    const c0x = Math.max(0, Math.floor(camX / chunkPx));
    const c0y = Math.max(0, Math.floor(camY / chunkPx));
    const c1x = Math.min(st.world.chunksPerSide - 1, Math.floor((camX + INTERNAL_W) / chunkPx));
    const c1y = Math.min(st.world.chunksPerSide - 1, Math.floor((camY + INTERNAL_H) / chunkPx));
    this.evictDistantChunkCanvases(st, c0x, c0y, c1x, c1y);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const idx = cy * st.world.chunksPerSide + cx;
        const cc = this.getChunkCanvas(st, cx, cy);
        if (cc) {
          ctx.drawImage(cc, cx * chunkPx - camX, cy * chunkPx - camY);
        }
      }
    }

    this.drawMiningTracks(ctx, st, now, camX, camY);

    // entities
    for (const e of st.entities.values()) {
      const ex = (st.lerpNow(e, now, "x") / FP) * px - camX;
      const ey = (st.lerpNow(e, now, "y") / FP) * px - camY;
      if (ex < -30 || ey < -30 || ex > INTERNAL_W + 30 || ey > INTERNAL_H + 30) continue;
      this.drawEntity(ctx, e, ex, ey, st, now);
    }

    // vent particles: emit from known vent positions near camera
    for (const vp of this.ventPositions) {
      const vx = vp.x * px - camX;
      const vy = vp.y * px - camY;
      if (vx < -20 || vy < -20 || vx > INTERNAL_W + 20 || vy > INTERNAL_H + 20) continue;
      const ventSeed = hash2(vp.x, vp.y, 0x71e5);
      for (let wisp = 0; wisp < 2; wisp++) {
        const travel = (now / 34 + (ventSeed & 127) + wisp * 11) % 24;
        const drift = Math.round(Math.sin(now / 210 + ventSeed + wisp * 2.4) * 2);
        const alpha = Math.sin((travel / 24) * Math.PI) * 0.2;
        ctx.fillStyle = `rgba(169,205,213,${alpha})`;
        ctx.fillRect(Math.round(vx + px / 2 + drift), Math.round(vy - travel), 1, 3);
        ctx.fillRect(Math.round(vx + px / 2 + drift + (wisp === 0 ? 1 : -1)), Math.round(vy - travel - 2), 2, 1);
      }
      if (Math.random() < 0.05) {
        const life = 1.35 + Math.random() * 1.75;
        this.particles.push({
          x: vp.x * px + Math.random() * px,
          y: vp.y * px,
          vx: (Math.random() - 0.5) * 5,
          vy: -14 - Math.random() * 13,
          life,
          maxLife: life,
          color: Math.random() < 0.3 ? "#d0e4e8" : "#91b3bd",
          gravity: 4,
          kind: "air",
          size: 1,
          seed: Math.random() * Math.PI * 2
        });
      }
    }

    // self
    const sx = selfPx - camX;
    const sy = selfPy - camY;
    const selfDx = st.predX - st.prevPredX;
    const selfDy = st.predY - st.prevPredY;
    const selfMoving = Math.abs(selfDx) + Math.abs(selfDy) > FP / 64;
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = ((mouse.x - rect.left) / Math.max(1, rect.width)) * INTERNAL_W;
    const mouseY = ((mouse.y - rect.top) / Math.max(1, rect.height)) * INTERNAL_H;
    const selfFacing = selfMoving
      ? angleToFacing(Math.atan2(selfDy, selfDx))
      : angleToFacing(Math.atan2(mouseY - sy, mouseX - sx));
    if (st.selfFlags & PFLAG.HUNT) this.drawMonster(ctx, sx, sy, now);
    else this.drawCharacter(ctx, sx, sy, selfFacing, selfMoving || (st.selfFlags & PFLAG.DIGGING) !== 0, st.selfFlags, now, st.playerId);
    if (st.selfFlags & PFLAG.CONVERTING) this.drawConversionRing(ctx, sx, sy, now);

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      const maxLife = p.maxLife ?? p.life;
      const lifeRatio = Math.max(0, Math.min(1, p.life / Math.max(0.001, maxLife)));
      if (p.kind === "pickup" && p.targetX !== undefined && p.targetY !== undefined) {
        const progress = 1 - lifeRatio;
        const pull = Math.min(1, dt * (5 + progress * 28));
        p.x += p.vx * dt * lifeRatio + (p.targetX - p.x) * pull;
        p.y += p.vy * dt * lifeRatio + (p.targetY - p.y) * pull;
        p.vx *= Math.max(0, 1 - dt * 8);
        p.vy *= Math.max(0, 1 - dt * 8);
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += p.gravity * dt;
      }
      const screenX = Math.round(p.x - camX);
      const screenY = Math.round(p.y - camY);
      ctx.fillStyle = p.color;
      if (p.kind === "air") {
        const age = 1 - lifeRatio;
        const alpha = Math.sin(Math.min(1, age) * Math.PI) * 0.52;
        const sway = Math.round(Math.sin(now / 180 + (p.seed ?? 0) + age * 5) * 2);
        ctx.globalAlpha = alpha;
        ctx.fillRect(screenX + sway, screenY, 1, 3);
        ctx.fillRect(screenX + sway + (age > 0.5 ? -1 : 1), screenY - 2, 2, 1);
        if (age > 0.34) ctx.fillRect(screenX + sway + 1, screenY + 2, 1, 1);
      } else if (p.kind === "spark") {
        ctx.globalAlpha = lifeRatio;
        const size = p.size ?? 1;
        ctx.fillRect(screenX, screenY, size, size);
        const tailX = Math.sign(-p.vx);
        const tailY = Math.sign(-p.vy);
        ctx.fillRect(screenX + tailX * 2, screenY + tailY * 2, 1, 1);
      } else if (p.kind === "smoke") {
        ctx.globalAlpha = lifeRatio * 0.52;
        const size = p.size ?? 3;
        ctx.fillRect(screenX, screenY, size, size - 1);
        ctx.fillRect(screenX + (Math.sin(now / 130 + (p.seed ?? 0)) > 0 ? -1 : size), screenY + 1, 1, Math.max(1, size - 2));
      } else if (p.kind === "chip") {
        ctx.globalAlpha = Math.min(1, lifeRatio * 1.35);
        const size = p.size ?? 2;
        const horizontal = Math.abs(p.vx) >= Math.abs(p.vy);
        ctx.fillRect(screenX, screenY, horizontal ? size + 1 : size, horizontal ? size : size + 1);
        if (size >= 2) {
          ctx.globalAlpha *= 0.45;
          ctx.fillRect(screenX - Math.sign(p.vx), screenY - Math.sign(p.vy), 1, 1);
        }
      } else if (p.kind === "pickup") {
        const progress = 1 - lifeRatio;
        const size = p.size ?? 2;
        ctx.globalAlpha = Math.min(1, Math.sin(Math.min(1, progress + 0.08) * Math.PI) * 1.35);
        ctx.fillRect(screenX, screenY - size, size, size * 2 + 1);
        ctx.fillRect(screenX - size, screenY, size * 2 + 1, size);
        ctx.globalAlpha *= 0.5;
        const trailX = Math.sign(-(p.targetX! - p.x));
        const trailY = Math.sign(-(p.targetY! - p.y));
        ctx.fillRect(screenX + trailX * 3, screenY + trailY * 3, 1, 1);
      } else {
        ctx.globalAlpha = lifeRatio;
        const size = p.size ?? 2;
        ctx.fillRect(screenX, screenY, size, size);
      }
      ctx.globalAlpha = 1;
    }

    // A short pixel crack/pulse makes repeated non-clearing pick hits legible.
    for (let i = this.pickImpacts.length - 1; i >= 0; i--) {
      const impact = this.pickImpacts[i];
      impact.life -= dt;
      if (impact.life <= 0) {
        this.pickImpacts.splice(i, 1);
        continue;
      }
      const progress = 1 - impact.life / impact.maxLife;
      const ix = Math.round(impact.x - camX);
      const iy = Math.round(impact.y - camY);
      const ux = Math.cos(impact.angle);
      const uy = Math.sin(impact.angle);
      const tx = -uy;
      const ty = ux;
      const reach = 2 + Math.round(progress * 5);
      ctx.globalAlpha = (1 - progress) * 0.9;
      ctx.fillStyle = "#ffe3a0";
      ctx.fillRect(Math.round(ix - ux * reach), Math.round(iy - uy * reach), 2, 2);
      ctx.fillStyle = impact.color;
      for (const side of [-1, 1]) {
        const branch = 2 + ((Math.floor(impact.seed * 10) + side) & 1);
        ctx.fillRect(Math.round(ix + tx * reach * side), Math.round(iy + ty * reach * side), branch, 1);
        ctx.fillRect(Math.round(ix + tx * (reach - 1) * side - ux * 2), Math.round(iy + ty * (reach - 1) * side - uy * 2), 1, branch);
      }
      ctx.globalAlpha = 1;
    }

    // Developer inspection deliberately bypasses both the ambient veil and
    // per-pixel LOS mask. Normal play keeps the complete terrain lighting path.
    if (!view.disableFog) {
      this.renderLight(st, sx, sy, ambient, now);
      ctx.drawImage(this.light, 0, 0);
    }

    // Construction ghost stays readable above the lighting layer.
    if (!view.inspectionMode) {
      this.drawWallPreview(ctx, st, mouse, now, camX, camY);
      this.drawBasePreview(ctx, st, mouse, now, camX, camY);
      this.drawBuildingPreview(ctx, st, mouse, now, camX, camY);
    }

    // minimap occasionally
    if (now - this.lastMinimapAt > 400) {
      this.lastMinimapAt = now;
      this.renderMinimap(st, detached ? cameraCenterX / px : undefined, detached ? cameraCenterY / px : undefined);
    }

    return { px: sx, py: sy };
  }

  /** Keep long exploration sessions bounded; terrain bytes remain cached and
   *  an evicted canvas is rebuilt lazily if the player returns. */
  private evictDistantChunkCanvases(st: ClientState, c0x: number, c0y: number, c1x: number, c1y: number): void {
    if (!st.world || this.chunkCanvases.size <= 64) return;
    const padding = 2;
    for (const idx of this.chunkCanvases.keys()) {
      const cx = idx % st.world.chunksPerSide;
      const cy = (idx / st.world.chunksPerSide) | 0;
      if (cx < c0x - padding || cx > c1x + padding || cy < c0y - padding || cy > c1y + padding) {
        this.chunkCanvases.delete(idx);
      }
    }
  }

  private drawWallPreview(
    ctx: CanvasRenderingContext2D,
    st: ClientState,
    mouse: { x: number; y: number },
    now: number,
    camX: number,
    camY: number
  ): void {
    if (!st.world || !st.self || st.self.slot !== 3 || st.phaseKind === "countdown" || st.phaseKind === "ended") return;
    if (st.selfFlags & (PFLAG.CONVERTING | PFLAG.STUNNED | PFLAG.INCAP)) return;

    const wall = BALANCE.construction.rigidWall;
    const rect = this.canvas.getBoundingClientRect();
    const mx = ((mouse.x - rect.left) / Math.max(1, rect.width)) * INTERNAL_W;
    const my = ((mouse.y - rect.top) / Math.max(1, rect.height)) * INTERNAL_H;
    const rawAng = Math.atan2(my - INTERNAL_H / 2, mx - INTERNAL_W / 2);
    const aim = Math.round((((rawAng + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
    const ang = (aim / 256) * Math.PI * 2;
    const pxCell = st.predX / FP;
    const pyCell = st.predY / FP;
    let tx = pxCell;
    let ty = pyCell;
    for (let d = 2; d <= wall.reachCells; d += 0.5) {
      const nx = pxCell + Math.cos(ang) * d;
      const ny = pyCell + Math.sin(ang) * d;
      const mat = st.world.get(Math.floor(nx), Math.floor(ny));
      if (mat !== MAT.EMPTY && mat !== MAT.REINFORCE) break;
      tx = nx;
      ty = ny;
    }

    const cx = Math.floor(tx);
    const cy = Math.floor(ty);
    const vertical = Math.abs(Math.cos(ang)) >= Math.abs(Math.sin(ang));
    const half = Math.floor(wall.lengthCells / 2);
    const offsets = [0];
    for (let i = 1; i <= half; i++) offsets.push(-i, i);
    let budget = Math.floor(st.self.carried / wall.gemCostPerCell);
    let green = 0;
    const radiusFp = Math.round(BALANCE.movement.playerRadiusCells * FP);
    const cellOverlapsActor = (x: number, y: number, ax: number, ay: number) => {
      const x0 = x * FP;
      const y0 = y * FP;
      const nearestX = Math.max(x0, Math.min(ax, x0 + FP));
      const nearestY = Math.max(y0, Math.min(ay, y0 + FP));
      return (ax - nearestX) ** 2 + (ay - nearestY) ** 2 < radiusFp ** 2;
    };

    ctx.save();
    for (const i of offsets) {
      const x = vertical ? cx : cx + i;
      const y = vertical ? cy + i : cy;
      const entityBlocked = [...st.entities.values()].some(
        (e) => Math.floor(st.lerpNow(e, now, "x") / FP) === x && Math.floor(st.lerpNow(e, now, "y") / FP) === y
      );
      const actorBlocked =
        cellOverlapsActor(x, y, st.predX, st.predY) ||
        [...st.entities.values()].some(
          (e) =>
            (e.kind === ENT.PLAYER || e.kind === ENT.ZOMBIE) &&
            cellOverlapsActor(x, y, st.lerpNow(e, now, "x"), st.lerpNow(e, now, "y"))
        );
      const terrainOpen = st.world.inBounds(x, y) && st.world.get(x, y) === MAT.EMPTY;
      const valid = st.self.wallUnlocked !== 0 && terrainOpen && !entityBlocked && !actorBlocked && budget > 0;
      if (valid) {
        budget--;
        green++;
      }
      const sx = x * st.cellPx - camX;
      const sy = y * st.cellPx - camY;
      ctx.fillStyle = valid ? "rgba(65, 235, 120, 0.62)" : "rgba(235, 65, 75, 0.58)";
      ctx.fillRect(sx, sy, st.cellPx, st.cellPx);
      ctx.strokeStyle = valid ? "rgba(175, 255, 195, 0.95)" : "rgba(255, 175, 175, 0.9)";
      ctx.strokeRect(sx + 0.5, sy + 0.5, Math.max(1, st.cellPx - 1), Math.max(1, st.cellPx - 1));
    }

    const labelX = (cx + 0.5) * st.cellPx - camX;
    const labelY = (cy - half - 1) * st.cellPx - camY;
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = green > 0 ? "#b9ffca" : "#ffb0b0";
    const label = st.self.wallUnlocked
      ? `${green}/${wall.lengthCells} cells · ${green * wall.gemCostPerCell}💎`
      : "find 🔷 to unlock";
    ctx.fillText(label, labelX, labelY);
    ctx.restore();
  }

  private drawBasePreview(
    ctx: CanvasRenderingContext2D,
    st: ClientState,
    mouse: { x: number; y: number },
    now: number,
    camX: number,
    camY: number
  ): void {
    if (!st.world || !st.self || st.self.slot !== BASE_TOOL_SLOT || st.phaseKind === "countdown" || st.phaseKind === "ended") return;
    if (st.selfFlags & (PFLAG.CONVERTING | PFLAG.STUNNED | PFLAG.INCAP)) return;
    const cfg = BALANCE.automation.base;
    const rect = this.canvas.getBoundingClientRect();
    const mx = ((mouse.x - rect.left) / Math.max(1, rect.width)) * INTERNAL_W;
    const my = ((mouse.y - rect.top) / Math.max(1, rect.height)) * INTERNAL_H;
    const angle = Math.atan2(my - INTERNAL_H / 2, mx - INTERNAL_W / 2);
    const pxCell = st.predX / FP;
    const pyCell = st.predY / FP;
    let tx = pxCell;
    let ty = pyCell;
    for (let distance = 2; distance <= cfg.placementReachCells; distance += 0.5) {
      const nx = pxCell + Math.cos(angle) * distance;
      const ny = pyCell + Math.sin(angle) * distance;
      if (st.world.get(Math.floor(nx), Math.floor(ny)) !== MAT.EMPTY) break;
      tx = nx;
      ty = ny;
    }
    const cx = Math.floor(tx);
    const cy = Math.floor(ty);
    let footprintOpen = true;
    for (let y = Math.floor(cy - cfg.siteClearanceRadiusCells); y <= Math.ceil(cy + cfg.siteClearanceRadiusCells); y++) {
      for (let x = Math.floor(cx - cfg.siteClearanceRadiusCells); x <= Math.ceil(cx + cfg.siteClearanceRadiusCells); x++) {
        const dx = x + 0.5 - (cx + 0.5);
        const dy = y + 0.5 - (cy + 0.5);
        if (dx * dx + dy * dy <= cfg.siteClearanceRadiusCells ** 2 && st.world.get(x, y) !== MAT.EMPTY) footprintOpen = false;
      }
    }
    const targetX = (cx + 0.5) * FP;
    const targetY = (cy + 0.5) * FP;
    const clearance = (cfg.collisionRadiusCells + BALANCE.movement.playerRadiusCells) * FP;
    const entityBlocked = [...st.entities.values()].some((entity) => {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM || entity.kind === ENT.BLAST || entity.kind === ENT.FIRE) return false;
      const x = st.lerpNow(entity, now, "x");
      const y = st.lerpNow(entity, now, "y");
      return (x - targetX) ** 2 + (y - targetY) ** 2 < clearance ** 2;
    });
    const playerBlocked = (st.predX - targetX) ** 2 + (st.predY - targetY) ** 2 < clearance ** 2;
    const ownsBase = [...st.entities.values()].some((entity) => entity.kind === ENT.MINING_BASE && entity.variant === st.playerId);
    const affordable = st.self.carried >= cfg.commonCost && st.self.iron >= cfg.ironCost;
    const valid = footprintOpen && !entityBlocked && !playerBlocked && !ownsBase && affordable;
    const x = (cx + 0.5) * st.cellPx - camX;
    const y = (cy + 0.5) * st.cellPx - camY;
    ctx.save();
    ctx.globalAlpha = 0.54;
    ctx.fillStyle = valid ? "#55db78" : "#e54f58";
    ctx.beginPath();
    ctx.arc(x, y, cfg.siteClearanceRadiusCells * st.cellPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.78;
    this.drawMiningBase(ctx, x, y, 1, valid, now);
    ctx.globalAlpha = 1;
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = valid ? "#b9ffca" : "#ffb0b0";
    ctx.fillText(ownsBase ? "1 base maximum" : `${cfg.commonCost} gems + ${cfg.ironCost} iron`, x, y - 44);
    ctx.restore();
  }

  private drawBuildingPreview(
    ctx: CanvasRenderingContext2D,
    st: ClientState,
    mouse: { x: number; y: number },
    now: number,
    camX: number,
    camY: number
  ): void {
    if (!st.world || !st.self || st.phaseKind === "countdown" || st.phaseKind === "ended") return;
    const definition = buildingForSlot(st.self.slot);
    if (!definition || (st.selfFlags & (PFLAG.CONVERTING | PFLAG.STUNNED | PFLAG.INCAP)) !== 0) return;
    const cfg = BALANCE.automation.infrastructure;
    const rect = this.canvas.getBoundingClientRect();
    const mx = ((mouse.x - rect.left) / Math.max(1, rect.width)) * INTERNAL_W;
    const my = ((mouse.y - rect.top) / Math.max(1, rect.height)) * INTERNAL_H;
    const angle = Math.atan2(my - INTERNAL_H / 2, mx - INTERNAL_W / 2);
    const pxCell = st.predX / FP;
    const pyCell = st.predY / FP;
    let tx = pxCell;
    let ty = pyCell;
    for (let distance = 2; distance <= cfg.placementReachCells; distance += 0.5) {
      const nx = pxCell + Math.cos(angle) * distance;
      const ny = pyCell + Math.sin(angle) * distance;
      if (st.world.get(Math.floor(nx), Math.floor(ny)) !== MAT.EMPTY) break;
      tx = nx;
      ty = ny;
    }
    const cx = Math.floor(tx);
    const cy = Math.floor(ty);
    let footprintOpen = true;
    for (let y = Math.floor(cy - definition.footprintRadius); y <= Math.ceil(cy + definition.footprintRadius); y++) {
      for (let x = Math.floor(cx - definition.footprintRadius); x <= Math.ceil(cx + definition.footprintRadius); x++) {
        const dx = x + 0.5 - (cx + 0.5);
        const dy = y + 0.5 - (cy + 0.5);
        if (dx * dx + dy * dy <= definition.footprintRadius ** 2 && st.world.get(x, y) !== MAT.EMPTY) footprintOpen = false;
      }
    }
    const targetX = (cx + 0.5) * FP;
    const targetY = (cy + 0.5) * FP;
    const ownBases = [...st.entities.values()].filter((entity) => entity.kind === ENT.MINING_BASE && entity.variant === st.playerId);
    const ownRelays = [...st.entities.values()].filter((entity) =>
      entity.kind === ENT.BUILDING && (entity.variant >> 4) === st.playerId && (entity.variant & 15) === BUILDING.POWER_RELAY &&
      (entity.flags & BUILDING_FLAG.CONNECTED) !== 0
    );
    const inGrid = ownBases.some((base) => (base.toX - targetX) ** 2 + (base.toY - targetY) ** 2 <= (cfg.baseGridRadiusCells * FP) ** 2) ||
      ownRelays.some((relay) => (relay.toX - targetX) ** 2 + (relay.toY - targetY) ** 2 <= (cfg.relayLinkRadiusCells * FP) ** 2);
    const entityBlocked = [...st.entities.values()].some((entity) => {
      const otherDefinition = entity.kind === ENT.BUILDING ? buildingDefinition(entity.variant & 15) : undefined;
      const otherRadius = entity.kind === ENT.MINING_BASE ? BALANCE.automation.base.collisionRadiusCells : otherDefinition?.collisionRadius ?? 1;
      const clearance = (definition.collisionRadius + otherRadius + 0.5) * FP;
      return (entity.toX - targetX) ** 2 + (entity.toY - targetY) ** 2 < clearance ** 2;
    });
    const playerClearance = (definition.collisionRadius + BALANCE.movement.playerRadiusCells + 0.5) * FP;
    const playerBlocked = (st.predX - targetX) ** 2 + (st.predY - targetY) ** 2 < playerClearance ** 2;
    const resources = { common: st.self.carried, copper: st.self.copper, iron: st.self.iron, gold: st.self.gold, platinum: st.self.platinum, coal: st.self.coal };
    const affordable = Object.entries(definition.cost).every(([resource, amount]) => resources[resource as keyof typeof resources] >= (amount ?? 0));
    const valid = footprintOpen && inGrid && !entityBlocked && !playerBlocked && affordable &&
      st.self.infrastructureUnlocked !== 0 && buildingPrerequisiteMet(st.self.buildingBlueprints, definition);
    const x = (cx + 0.5) * st.cellPx - camX;
    const y = (cy + 0.5) * st.cellPx - camY;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = valid ? "#55db78" : "#e54f58";
    ctx.beginPath();
    ctx.arc(x, y, definition.footprintRadius * st.cellPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    this.drawOutpostBuilding(ctx, x, y, definition.kind, BUILDING_FLAG.POWERED | BUILDING_FLAG.CONNECTED, 255, now, true, 0);
    ctx.globalAlpha = 1;
    ctx.font = "8px Goldman, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = valid ? "#b9ffca" : "#ffb0b0";
    ctx.fillText(!inGrid ? "OUTSIDE POWER GRID" : !footprintOpen ? "CLEAR MORE ROCK" : valid ? "CLICK TO CONSTRUCT" : "NEED MATERIALS", x, y - definition.footprintRadius * st.cellPx - 8);
    ctx.restore();
  }

  private drawMiningTracks(
    ctx: CanvasRenderingContext2D,
    st: ClientState,
    now: number,
    camX: number,
    camY: number
  ): void {
    if (!st.world) return;
    const entities = [...st.entities.values()];
    for (const depot of entities) {
      if (depot.kind !== ENT.BUILDING || (depot.variant & 15) !== BUILDING.TRACK_DEPOT || (depot.flags & BUILDING_FLAG.POWERED) === 0) continue;
      const ownerId = depot.variant >> 4;
      const base = entities
        .filter((entity) => entity.kind === ENT.MINING_BASE && entity.variant === ownerId)
        .sort((a, b) => ((a.toX - depot.toX) ** 2 + (a.toY - depot.toY) ** 2) - ((b.toX - depot.toX) ** 2 + (b.toY - depot.toY) ** 2))[0];
      if (!base || !hasLineOfSight(st.world, depot.toX / FP, depot.toY / FP, base.toX / FP, base.toY / FP)) continue;
      const x1 = depot.toX / FP * st.cellPx - camX;
      const y1 = depot.toY / FP * st.cellPx - camY;
      const x2 = base.toX / FP * st.cellPx - camX;
      const y2 = base.toY / FP * st.cellPx - camY;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / length;
      const ny = dx / length;
      ctx.save();
      ctx.strokeStyle = "rgba(20,18,17,.82)";
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.strokeStyle = "#77736b";
      ctx.lineWidth = 1;
      for (const side of [-2, 2]) {
        ctx.beginPath(); ctx.moveTo(x1 + nx * side, y1 + ny * side); ctx.lineTo(x2 + nx * side, y2 + ny * side); ctx.stroke();
      }
      for (let d = 4; d < length; d += 7) {
        const x = x1 + dx * d / length;
        const y = y1 + dy * d / length;
        ctx.strokeStyle = "#4b4035";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - nx * 4, y - ny * 4); ctx.lineTo(x + nx * 4, y + ny * 4); ctx.stroke();
      }
      const signal = (now / 18) % length;
      ctx.fillStyle = "rgba(241,187,73,.8)";
      ctx.fillRect(Math.round(x1 + dx * signal / length) - 1, Math.round(y1 + dy * signal / length) - 1, 2, 2);
      ctx.restore();
    }
  }

  private drawEntity(ctx: CanvasRenderingContext2D, e: RemoteEntity, x: number, y: number, st: ClientState, now: number): void {
    if (e.kind === ENT.PLAYER) {
      if (e.flags & PFLAG.HUNT) this.drawMonster(ctx, x, y, now);
      else {
        const dx = e.toX - e.fromX;
        const dy = e.toY - e.fromY;
        const moving = Math.abs(dx) + Math.abs(dy) > FP / 64;
        const facing = moving ? angleToFacing(Math.atan2(dy, dx)) : e.facing;
        this.drawCharacter(ctx, x, y, facing, moving || (e.flags & PFLAG.DIGGING) !== 0, e.flags, now, e.id);
      }
      if (e.flags & PFLAG.CONVERTING) this.drawConversionRing(ctx, x, y, now);
      if (e.nameVisible && st.names[e.id]) {
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(220,215,200,0.85)";
        ctx.fillText(st.names[e.id], x, y - 18);
      }
    } else if (e.kind === ENT.GEM || e.kind === ENT.REINFORCE_GEM) {
      const t = Math.round(Math.sin(now / 300 + e.id));
      const cx = Math.round(x);
      const cy = Math.round(y + t);
      const reinforce = e.kind === ENT.REINFORCE_GEM;
      ctx.fillStyle = "rgba(0,0,0,.4)";
      ctx.fillRect(cx - 4, cy + 5, 8, 2);
      ctx.fillStyle = reinforce ? "#214e78" : "#6c5520";
      ctx.fillRect(cx - 2, cy - 5, 5, 11);
      ctx.fillRect(cx - 4, cy - 2, 9, 5);
      ctx.fillStyle = reinforce ? "#58b8ff" : "#e8d44a";
      ctx.fillRect(cx - 2, cy - 4, 4, 8);
      ctx.fillRect(cx - 3, cy - 1, 7, 3);
      ctx.fillStyle = reinforce ? "#bceaff" : "#fff09a";
      ctx.fillRect(cx - 1, cy - 3, 2, 3);
      if (Math.floor(now / 180 + e.id) % 5 === 0) {
        ctx.fillRect(cx + 3, cy - 5, 1, 2);
        ctx.fillRect(cx + 2, cy - 4, 3, 1);
      }
    } else if (e.kind === ENT.ZOMBIE) {
      this.drawZombie(ctx, x, y, e.facing, now);
    } else if (e.kind === ENT.BOMB) {
      const airborne = (e.flags & EFLAG.AIRBORNE) !== 0;
      const moving = (e.flags & (EFLAG.AIRBORNE | EFLAG.PROJECTILE | EFLAG.BOUNCING)) !== 0;
      const pendingClusterChild = airborne && !((e.flags & (EFLAG.PROJECTILE | EFLAG.BOUNCING)) !== 0) && e.facing === 0;
      if (!pendingClusterChild) {
        const travel = moving ? e.facing / 255 : undefined;
        const arc = travel === undefined
          ? undefined
          : (e.flags & EFLAG.PROJECTILE) !== 0
            ? 1
            : (e.flags & EFLAG.BOUNCING) !== 0
              ? (travel < 0.5 ? travel * 2 : (travel - 0.5) * 2)
              : travel;
        drawPixelBomb(ctx, x, y, e.variant, moving ? 1 : e.facing / 255, now, arc);
      }
    } else if (e.kind === ENT.BLAST) {
      this.drawBlast(ctx, e, x, y, st, now);
    } else if (e.kind === ENT.FIRE) {
      this.drawBlast(ctx, e, x, y, st, now);
    } else if (e.kind === ENT.CHEST) {
      this.drawRuinChest(ctx, x, y, (e.flags & CHEST_FLAG.SEALED) !== 0, e.id, now, e.variant);
    } else if (e.kind === ENT.GUARDIAN) {
      this.drawRuinGuardian(ctx, x, y, e.id, now, e.variant);
    } else if (e.kind === ENT.LANDMARK) {
      this.drawLandmark(ctx, x, y, e.variant, e.id, now);
    } else if (e.kind === ENT.TURRET) {
      drawPixelTurret(ctx, x, y, e.id, now);
    } else if (e.kind === ENT.MINING_BASE) {
      const owned = e.variant === st.playerId;
      this.drawMiningBase(ctx, x, y, e.width, owned, now);
      const distance = Math.hypot(e.toX / FP - st.predX / FP, e.toY / FP - st.predY / FP);
      if (owned && distance <= BALANCE.automation.base.interactRangeCells + 1) {
        const miner = BALANCE.automation.miner;
        const full = e.width >= miner.maxPerBase;
        const affordable = st.self !== null && st.self.carried >= miner.commonCost && st.self.iron >= miner.ironCost;
        ctx.font = "8px Goldman, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = full ? "#8b867b" : affordable ? "#d9c59e" : "#a86b62";
        ctx.fillText(full ? `${e.width}/${miner.maxPerBase} MINERS` : `E · MINER ${e.width}/${miner.maxPerBase}`, x, y - 49);
        if (!full) {
          ctx.font = "7px Goldman, sans-serif";
          ctx.fillText(`${miner.commonCost} GEMS + ${miner.ironCost} IRON`, x, y - 41);
        }
      }
    } else if (e.kind === ENT.BUILDING) {
      this.drawOutpostBuilding(ctx, x, y, e.variant & 15, e.flags, e.width, now, false, e.facing);
    } else if (e.kind === ENT.AUTO_MINER) {
      this.drawAutoMiner(ctx, x, y, e.facing, (e.flags & PFLAG.DIGGING) !== 0, e.variant, now);
    } else if (e.kind === ENT.HUNTER) {
      this.drawHunter(ctx, x, y, e.facing, e.variant, now);
    } else if (e.kind === ENT.ORE_CART) {
      this.drawOreCart(ctx, x, y, e.facing, e.variant, now);
    } else if (e.kind === ENT.BELL) {
      ctx.fillStyle = "#d8b84a";
      ctx.fillRect(x - 3, y - 4, 6, 6);
      ctx.fillRect(x - 1, y + 2, 2, 2);
    } else if (e.kind === ENT.CHARGE) {
      const cx = Math.round(x);
      const cy = Math.round(y);
      ctx.fillStyle = "rgba(0,0,0,.42)";
      ctx.fillRect(cx - 5, cy + 4, 10, 2);
      ctx.fillStyle = "#25171b";
      ctx.fillRect(cx - 5, cy - 3, 10, 8);
      ctx.fillStyle = "#8c2c3d";
      ctx.fillRect(cx - 4, cy - 2, 8, 6);
      ctx.fillStyle = "#d1495b";
      ctx.fillRect(cx - 3, cy - 1, 6, 2);
      ctx.fillStyle = Math.floor(now / 260) % 2 ? "#ffdd66" : "#663333";
      ctx.fillRect(cx - 1, cy - 5, 2, 2);
      ctx.fillStyle = "#aeb3b6";
      ctx.fillRect(cx + 4, cy - 1, 2, 3);
    }
  }

  private drawRuinChest(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    sealed: boolean,
    entityId: number,
    now: number,
    variant: number = CHEST_VARIANT.RUIN
  ): void {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const pulse = 0.5 + Math.sin(now / 360 + entityId) * 0.5;
    const flicker = Math.floor(now / 170 + entityId);
    ctx.save();
    ctx.translate(cx, cy);

    if (variant !== CHEST_VARIANT.RUIN) {
      const aura = variant === CHEST_VARIANT.VOLCANO ? [255, 76, 24]
        : variant === CHEST_VARIANT.RITUAL ? [194, 43, 66]
          : variant === CHEST_VARIANT.OASIS ? [86, 215, 139]
            : [101, 177, 220];
      ctx.fillStyle = `rgba(${aura[0]},${aura[1]},${aura[2]},${0.08 + pulse * 0.09})`;
      ctx.fillRect(-25, -18, 50, 34);
      ctx.fillStyle = `rgba(${aura[0]},${aura[1]},${aura[2]},${0.45 + pulse * 0.28})`;
      for (let rune = 0; rune < 8; rune++) {
        const angle = rune / 8 * Math.PI * 2 + now / 4200;
        ctx.fillRect(Math.round(Math.cos(angle) * 20) - 1, Math.round(Math.sin(angle) * 12) - 1, 2, 2);
      }
    }

    // Uneven fossil shrine floor and broken cardinal approaches.
    ctx.fillStyle = "rgba(7,6,8,.38)";
    ctx.fillRect(-22, 10, 44, 5);
    ctx.fillStyle = "rgba(76,73,70,.78)";
    ctx.fillRect(-18, -11, 36, 23);
    ctx.fillRect(-22, -7, 44, 15);
    ctx.fillStyle = "rgba(102,97,88,.72)";
    ctx.fillRect(-17, -10, 10, 7);
    ctx.fillRect(-5, -10, 11, 6);
    ctx.fillRect(8, -9, 9, 7);
    ctx.fillRect(-21, -1, 9, 7);
    ctx.fillRect(13, -1, 8, 7);
    ctx.fillRect(-16, 7, 10, 5);
    ctx.fillRect(-4, 6, 9, 6);
    ctx.fillRect(7, 7, 10, 5);
    ctx.fillStyle = "rgba(43,42,42,.85)";
    ctx.fillRect(-7, -10, 2, 5);
    ctx.fillRect(6, -8, 2, 7);
    ctx.fillRect(-13, -2, 2, 7);
    ctx.fillRect(11, 1, 2, 6);
    ctx.fillRect(-6, 6, 2, 6);
    ctx.fillRect(5, 7, 2, 5);
    ctx.fillRect(-18, 5, 5, 2);
    ctx.fillRect(14, -3, 7, 2);
    ctx.fillStyle = "rgba(207,198,174,.38)";
    ctx.fillRect(-20, -7, 5, 1);
    ctx.fillRect(15, -7, 5, 1);
    ctx.fillRect(-16, 10, 7, 1);
    ctx.fillRect(10, 10, 6, 1);

    // Fossil corner markers and the reliquary's engraved orbit.
    ctx.fillStyle = "rgba(213,206,184,.7)";
    ctx.fillRect(-22, -10, 3, 7);
    ctx.fillRect(-24, -8, 7, 3);
    ctx.fillRect(19, -10, 3, 7);
    ctx.fillRect(17, -8, 7, 3);
    ctx.fillRect(-22, 7, 3, 6);
    ctx.fillRect(-24, 9, 7, 3);
    ctx.fillRect(19, 7, 3, 6);
    ctx.fillRect(17, 9, 7, 3);
    ctx.fillStyle = sealed ? `rgba(151,78,54,${0.32 + pulse * 0.24})` : `rgba(242,194,74,${0.32 + pulse * 0.32})`;
    ctx.fillRect(-15, -1, 3, 2);
    ctx.fillRect(12, -1, 3, 2);
    ctx.fillRect(-1, -10, 2, 3);
    ctx.fillRect(-1, 8, 2, 3);
    ctx.fillRect(-11, -7, 2, 2);
    ctx.fillRect(9, -7, 2, 2);
    ctx.fillRect(-11, 6, 2, 2);
    ctx.fillRect(9, 6, 2, 2);

    if (!sealed) {
      // Once guardians fall, light leaks from beneath the raised lid.
      ctx.fillStyle = `rgba(255,196,64,${0.12 + pulse * 0.1})`;
      ctx.fillRect(-18, -14, 36, 27);
      ctx.fillStyle = `rgba(255,224,116,${0.45 + pulse * 0.3})`;
      ctx.fillRect(-1, -19 - (flicker & 1), 2, 5);
      ctx.fillRect(-12, -14, 2, 4);
      ctx.fillRect(10, -15, 2, 5);
      ctx.fillRect(-17, -8, 4, 2);
      ctx.fillRect(13, -8, 4, 2);
    }

    // Stepped stone pedestal.
    ctx.fillStyle = "rgba(0,0,0,.58)";
    ctx.fillRect(-14, 8, 28, 5);
    ctx.fillStyle = "#343337";
    ctx.fillRect(-13, 5, 26, 5);
    ctx.fillStyle = "#5d5a58";
    ctx.fillRect(-11, 3, 22, 5);
    ctx.fillStyle = "#858078";
    ctx.fillRect(-9, 3, 16, 1);
    ctx.fillStyle = "#26252a";
    ctx.fillRect(-10, 8, 7, 2);
    ctx.fillRect(3, 8, 7, 2);

    // Raised lid when available; heavy closed lid while sealed.
    if (!sealed) {
      ctx.fillStyle = "#201713";
      ctx.fillRect(-10, -12, 20, 7);
      ctx.fillRect(-8, -15, 16, 3);
      ctx.fillStyle = "#74452a";
      ctx.fillRect(-9, -12, 18, 5);
      ctx.fillStyle = "#a86938";
      ctx.fillRect(-7, -14, 14, 3);
      ctx.fillStyle = "#d4a44f";
      ctx.fillRect(-10, -9, 20, 2);
      ctx.fillRect(-2, -14, 4, 7);
      ctx.fillStyle = "#ffe39a";
      ctx.fillRect(-1, -12, 2, 3);
      ctx.fillStyle = "#ffce55";
      ctx.fillRect(-8, -4, 16, 4);
    } else {
      ctx.fillStyle = "#201713";
      ctx.fillRect(-11, -9, 22, 8);
      ctx.fillRect(-8, -12, 16, 3);
      ctx.fillStyle = "#704126";
      ctx.fillRect(-10, -8, 20, 7);
      ctx.fillStyle = "#a56837";
      ctx.fillRect(-8, -10, 16, 4);
      ctx.fillStyle = "#d2a049";
      ctx.fillRect(-11, -4, 22, 2);
      ctx.fillRect(-2, -10, 4, 7);
      ctx.fillStyle = "#f1ce76";
      ctx.fillRect(-1, -8, 2, 2);
    }

    // Deep box, metal bands, feet, rivets and central lock plate.
    ctx.fillStyle = "#171214";
    ctx.fillRect(-11, -2, 22, 11);
    ctx.fillStyle = "#5b3523";
    ctx.fillRect(-10, -1, 20, 9);
    ctx.fillStyle = "#8d5430";
    ctx.fillRect(-9, 0, 18, 3);
    ctx.fillStyle = "#3a261e";
    ctx.fillRect(-9, 4, 18, 3);
    ctx.fillStyle = "#c18d43";
    ctx.fillRect(-10, -1, 2, 9);
    ctx.fillRect(8, -1, 2, 9);
    ctx.fillRect(-2, -2, 4, 10);
    ctx.fillStyle = "#f0c96e";
    ctx.fillRect(-8, 1, 1, 1);
    ctx.fillRect(7, 1, 1, 1);
    ctx.fillRect(-8, 6, 1, 1);
    ctx.fillRect(7, 6, 1, 1);
    ctx.fillStyle = sealed ? "#8b493c" : "#ffe48b";
    ctx.fillRect(-3, 1, 6, 5);
    ctx.fillStyle = sealed ? "#e16a4e" : "#fff7c1";
    ctx.fillRect(-1, 2, 2, 2);
    ctx.fillStyle = "#20181a";
    ctx.fillRect(-8, 8, 4, 2);
    ctx.fillRect(4, 8, 4, 2);

    if (sealed) {
      // Crossed chains visibly explain why walking over it does nothing yet.
      ctx.fillStyle = "#393a3d";
      for (let i = -8; i <= 8; i += 4) {
        ctx.fillRect(i, Math.round(i * 0.45), 3, 2);
        ctx.fillRect(i, Math.round(-i * 0.45), 3, 2);
      }
      ctx.fillStyle = pulse > 0.55 ? "#ed7357" : "#793c38";
      ctx.fillRect(-2, 0, 4, 5);
      ctx.fillRect(-1, -2, 2, 3);
    } else {
      for (let mote = 0; mote < 5; mote++) {
        const seed = hash2(entityId, mote, Math.floor(now / 110));
        ctx.fillStyle = mote % 2 === 0 ? "#fff2a8" : "#e8a93f";
        ctx.fillRect(-10 + seed % 21, -5 - ((seed >>> 8) % 13), mote % 3 === 0 ? 2 : 1, mote % 2 === 0 ? 2 : 1);
      }
    }
    ctx.restore();
  }

  private drawLandmark(ctx: CanvasRenderingContext2D, x: number, y: number, variant: number, entityId: number, now: number): void {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const pulse = 0.5 + Math.sin(now / 480 + entityId) * 0.5;
    ctx.save();
    ctx.translate(cx, cy);
    if (variant === LANDMARK.VOLCANO) {
      // The terrain owns the full caldera; this animated crown keeps it visibly
      // active at all times with heat shimmer, lava fountains, ash, and embers.
      ctx.fillStyle = `rgba(255,67,18,${0.08 + pulse * 0.07})`;
      ctx.fillRect(-52, -38, 104, 76);
      ctx.fillStyle = "rgba(13,10,12,.78)";
      ctx.fillRect(-37, -15, 74, 30);
      ctx.fillRect(-30, -22, 60, 44);
      ctx.fillStyle = "#3c3030";
      ctx.fillRect(-33, -14, 66, 28);
      ctx.fillRect(-27, -19, 54, 38);
      ctx.fillStyle = "#702c20";
      ctx.fillRect(-25, -12, 50, 24);
      ctx.fillStyle = pulse > 0.48 ? "#ffbd32" : "#f46a20";
      ctx.fillRect(-21, -9, 42, 18);
      ctx.fillStyle = "#ffe169";
      ctx.fillRect(-14, -5, 11, 5);
      ctx.fillRect(3, 1, 14, 4);
      ctx.fillStyle = "#d94318";
      ctx.fillRect(-18, 7, 8, 3);
      ctx.fillRect(9, -7, 9, 4);
      const eruption = (now / 70 + entityId * 13) % 54;
      for (let mote = 0; mote < 18; mote++) {
        const seed = hash2(entityId, mote, Math.floor(now / 170));
        const lift = (eruption + mote * 7) % 54;
        const spread = 4 + lift * 0.42;
        const mx = Math.round(((seed & 255) / 255 - 0.5) * spread);
        const my = Math.round(-10 - lift + Math.sin(mote * 2.4) * 3);
        ctx.fillStyle = mote % 4 === 0 ? "#ffe66f" : mote % 3 === 0 ? "#ff6a24" : "rgba(92,69,64,.68)";
        ctx.fillRect(mx, my, mote % 5 === 0 ? 3 : 2, mote % 3 === 0 ? 3 : 2);
      }
    } else if (variant === LANDMARK.RITUAL) {
      ctx.fillStyle = "rgba(9,5,10,.58)";
      ctx.fillRect(-45, -33, 90, 66);
      ctx.strokeStyle = `rgba(205,43,67,${0.5 + pulse * 0.38})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 29, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      for (let point = 0; point <= 5; point++) {
        const index = (point * 2) % 5;
        const angle = -Math.PI / 2 + index / 5 * Math.PI * 2;
        const px = Math.cos(angle) * 25;
        const py = Math.sin(angle) * 25;
        if (point === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.fillStyle = "#4c4243";
      ctx.fillRect(-8, -5, 16, 12);
      ctx.fillStyle = "#a52f45";
      ctx.fillRect(-4, -8, 8, 3);
      for (let candle = 0; candle < 9; candle++) {
        const angle = candle / 9 * Math.PI * 2;
        const px = Math.round(Math.cos(angle) * 35);
        const py = Math.round(Math.sin(angle) * 27);
        ctx.fillStyle = "#d9c2a0"; ctx.fillRect(px - 1, py - 2, 2, 4);
        ctx.fillStyle = candle % 2 ? "#ff5a35" : "#ffcc55"; ctx.fillRect(px - 1, py - 5 - (Math.floor(now / 180 + candle) & 1), 2, 3);
      }
    } else if (variant === LANDMARK.OASIS) {
      ctx.fillStyle = `rgba(49,153,108,${0.1 + pulse * 0.08})`;
      ctx.fillRect(-47, -33, 94, 66);
      ctx.fillStyle = "rgba(21,63,69,.82)";
      ctx.fillRect(-27, -12, 54, 24);
      ctx.fillRect(-21, -17, 42, 34);
      ctx.fillStyle = "rgba(79,175,174,.65)";
      ctx.fillRect(-20, -8, 40, 3);
      ctx.fillRect(-13, 5, 28, 2);
      for (let fern = 0; fern < 14; fern++) {
        const angle = fern / 14 * Math.PI * 2 + 0.17;
        const distance = 28 + (fern % 3) * 4;
        const px = Math.round(Math.cos(angle) * distance);
        const py = Math.round(Math.sin(angle) * distance * 0.7);
        ctx.fillStyle = fern % 2 ? "#4f9d56" : "#75bd67";
        ctx.fillRect(px - 1, py - 7, 3, 8);
        ctx.fillRect(px - 5, py - 5, 5, 2);
        ctx.fillRect(px + 1, py - 3, 5, 2);
      }
      ctx.fillStyle = "rgba(168,238,206,.8)";
      for (let bubble = 0; bubble < 6; bubble++) {
        const seed = hash2(entityId, bubble, Math.floor(now / 260));
        ctx.fillRect(-18 + seed % 37, -7 + ((seed >>> 8) % 15), 1 + (bubble & 1), 1);
      }
    } else {
      ctx.fillStyle = "rgba(8,10,13,.52)";
      ctx.fillRect(-45, -31, 90, 62);
      ctx.fillStyle = "#3e4448";
      ctx.fillRect(-34, -24, 8, 48);
      ctx.fillRect(26, -24, 8, 48);
      ctx.fillRect(-30, -25, 60, 8);
      ctx.fillStyle = "#77766d";
      ctx.fillRect(-31, -21, 5, 38);
      ctx.fillRect(26, -21, 5, 38);
      ctx.fillStyle = `rgba(100,190,218,${0.38 + pulse * 0.45})`;
      ctx.fillRect(-2, -17, 4, 8);
      ctx.fillRect(-12, -12, 4, 4);
      ctx.fillRect(9, -12, 4, 4);
      ctx.fillRect(-19, 3, 5, 3);
      ctx.fillRect(15, 3, 5, 3);
      ctx.fillRect(-2, 8, 4, 8);
      ctx.fillStyle = "#252a2d";
      ctx.fillRect(-21, 18, 42, 6);
      ctx.fillStyle = "#aba994";
      ctx.fillRect(-18, 18, 36, 2);
    }
    ctx.restore();
  }

  private drawRuinGuardian(ctx: CanvasRenderingContext2D, x: number, y: number, entityId: number, now: number, variant: number = GUARDIAN_VARIANT.RUIN): void {
    const cx = Math.round(x);
    const cy = Math.round(y + Math.sin(now / 150 + entityId) * 1.3);
    const rune = Math.floor(now / 190 + entityId) % 2 === 0;
    if (variant === GUARDIAN_VARIANT.TUNNEL_CRAWLER) {
      ctx.fillStyle = "rgba(0,0,0,.48)"; ctx.fillRect(cx - 10, cy + 5, 21, 3);
      ctx.fillStyle = "#332d2b"; ctx.fillRect(cx - 8, cy - 3, 17, 9); ctx.fillRect(cx - 4, cy - 7, 9, 15);
      ctx.fillStyle = "#8d755f"; ctx.fillRect(cx - 3, cy - 6, 7, 10); ctx.fillRect(cx - 7, cy - 2, 15, 5);
      ctx.fillStyle = "#c6b18c"; ctx.fillRect(cx - 10, cy - 5, 5, 2); ctx.fillRect(cx + 6, cy - 5, 5, 2);
      ctx.fillRect(cx - 12, cy + 1, 5, 2); ctx.fillRect(cx + 8, cy + 1, 5, 2);
      ctx.fillStyle = rune ? "#ffc95c" : "#9b4b2f"; ctx.fillRect(cx - 2, cy - 4, 2, 2); ctx.fillRect(cx + 3, cy - 4, 2, 2);
      return;
    }
    if (variant === GUARDIAN_VARIANT.EMBERLING) {
      ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(cx - 8, cy + 8, 17, 3);
      ctx.fillStyle = "#251d20"; ctx.fillRect(cx - 7, cy - 6, 15, 15); ctx.fillRect(cx - 4, cy - 10, 9, 20);
      ctx.fillStyle = rune ? "#ff8a27" : "#bd3d1d"; ctx.fillRect(cx - 4, cy - 5, 9, 10);
      ctx.fillStyle = "#ffd355"; ctx.fillRect(cx - 2, cy - 3, 5, 5); ctx.fillRect(cx - 6, cy - 9, 3, 4); ctx.fillRect(cx + 4, cy - 10, 3, 5);
      return;
    }
    if (variant === GUARDIAN_VARIANT.BONE_WRAITH) {
      const fade = 0.62 + Math.sin(now / 220 + entityId) * 0.18;
      ctx.fillStyle = `rgba(0,0,0,${fade * .45})`; ctx.fillRect(cx - 8, cy + 7, 17, 3);
      ctx.fillStyle = `rgba(202,211,199,${fade})`; ctx.fillRect(cx - 6, cy - 8, 13, 11); ctx.fillRect(cx - 4, cy + 3, 9, 6);
      ctx.fillStyle = `rgba(52,69,72,${fade})`; ctx.fillRect(cx - 3, cy - 5, 2, 3); ctx.fillRect(cx + 2, cy - 5, 2, 3); ctx.fillRect(cx - 2, cy, 5, 2);
      ctx.fillStyle = `rgba(118,210,201,${fade})`; ctx.fillRect(cx - 8, cy - 2, 3, 6); ctx.fillRect(cx + 6, cy - 2, 3, 6);
      return;
    }
    ctx.fillStyle = "rgba(0,0,0,.48)";
    ctx.fillRect(cx - 9, cy + 8, 18, 3);
    ctx.fillStyle = "#2a292e";
    ctx.fillRect(cx - 8, cy - 5, 16, 13);
    ctx.fillRect(cx - 6, cy - 9, 12, 19);
    ctx.fillStyle = "#55545a";
    ctx.fillRect(cx - 7, cy - 4, 14, 10);
    ctx.fillStyle = "#77746f";
    ctx.fillRect(cx - 5, cy - 7, 10, 5);
    ctx.fillRect(cx - 8, cy - 2, 4, 6);
    ctx.fillRect(cx + 4, cy - 2, 4, 6);
    ctx.fillStyle = "#cfc8b3";
    ctx.fillRect(cx - 4, cy - 9, 8, 3);
    ctx.fillRect(cx - 9, cy - 7, 4, 2);
    ctx.fillRect(cx + 5, cy - 7, 4, 2);
    ctx.fillRect(cx - 10, cy - 6, 2, 5);
    ctx.fillRect(cx + 8, cy - 6, 2, 5);
    ctx.fillStyle = "#343239";
    ctx.fillRect(cx - 4, cy + 6, 3, 4);
    ctx.fillRect(cx + 1, cy + 6, 3, 4);
    ctx.fillStyle = rune ? "#ff8a5b" : "#9d453b";
    ctx.fillRect(cx - 3, cy - 5, 2, 2);
    ctx.fillRect(cx + 2, cy - 5, 2, 2);
    ctx.fillRect(cx - 1, cy - 1, 2, 4);
    ctx.fillStyle = rune ? "rgba(255,115,73,.2)" : "rgba(120,54,51,.12)";
    ctx.fillRect(cx - 10, cy - 9, 20, 18);
  }

  private drawOutpostBuilding(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    kind: number,
    flags: number,
    health: number,
    now: number,
    preview: boolean,
    facing: number
  ): void {
    const definition = buildingDefinition(kind);
    if (!definition) return;
    const powered = (flags & BUILDING_FLAG.POWERED) !== 0;
    const connected = (flags & BUILDING_FLAG.CONNECTED) !== 0;
    const active = (flags & BUILDING_FLAG.ACTIVE) !== 0;
    const width = Math.round(Math.max(14, definition.collisionRadius * 8));
    const height = Math.round(Math.max(12, definition.collisionRadius * 7));
    const left = Math.round(x - width / 2);
    const top = Math.round(y - height / 2);
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.42)";
    ctx.fillRect(left - 2, top + height - 1, width + 4, 3);
    ctx.fillStyle = powered || preview ? "#dddcd3" : "#777a78";
    ctx.fillRect(left, top, width, height);
    ctx.fillStyle = "#484c4b";
    ctx.fillRect(left + 2, top + 2, width - 4, height - 4);
    ctx.strokeStyle = connected || preview ? "#c7a653" : "#5b5e5c";
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
    ctx.fillStyle = powered || preview ? "#f2efe1" : "#a09f98";
    if (kind === BUILDING.COAL_GENERATOR) {
      const phase = Math.floor(now / 100) % 4;
      ctx.fillRect(left + 3, top - 5, 4, 7);
      ctx.fillStyle = active ? `rgba(205,205,196,${0.35 + phase * 0.12})` : "rgba(80,80,78,.3)";
      ctx.fillRect(left + 2 - phase, top - 8 - phase, 5 + phase, 2 + phase);
      ctx.fillStyle = powered ? "#e6ae43" : "#706348";
      ctx.fillRect(left + width - 7, top + 4, 4, Math.max(4, height - 10));
    } else if (kind === BUILDING.BATTERY_BANK) {
      const charge = powered ? 2 + Math.floor(now / 260) % 4 : 1;
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i < charge ? "#e8c454" : "#68675f";
        ctx.fillRect(left + 4 + i * Math.max(3, Math.floor((width - 9) / 4)), top + 5, Math.max(2, Math.floor((width - 13) / 4)), height - 12);
      }
    } else if (kind === BUILDING.POWER_RELAY) {
      ctx.fillRect(Math.round(x) - 1, top - 8, 3, height + 8);
      ctx.fillRect(Math.round(x) - 5, top - 7, 11, 2);
      ctx.fillStyle = powered && Math.floor(now / 360) % 2 === 0 ? "#ffd960" : "#806d3b";
      ctx.fillRect(Math.round(x) - 2, top - 11, 5, 3);
    } else if (kind === BUILDING.OXYGEN_RECYCLER) {
      const lift = powered ? Math.floor(now / 170) % 8 : 0;
      ctx.strokeStyle = powered ? "#8dd9d1" : "#747d7a";
      ctx.beginPath(); ctx.arc(x, y - 1, Math.max(4, width * 0.22), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = powered ? "rgba(146,226,213,.8)" : "#777";
      ctx.fillRect(Math.round(x) - 1, top + height - 6 - lift, 2, 2);
    } else if (kind === BUILDING.FLOODLIGHT) {
      ctx.fillRect(left + 3, top - 5, width - 6, 5);
      if (powered) { ctx.fillStyle = "#fff4a8"; ctx.fillRect(left + 5, top - 4, width - 10, 2); }
    } else if (kind === BUILDING.SENTRY_GUN) {
      const sweep = powered ? Math.sin(now / 450) * 0.45 : 0;
      ctx.fillRect(Math.round(x) - 2, top - 6, 5, 8);
      ctx.save(); ctx.translate(x, top - 3); ctx.rotate(sweep); ctx.fillRect(0, -1, Math.round(width * 0.65), 3); ctx.restore();
    } else if (kind === BUILDING.ARC_COIL) {
      const pulse = Math.floor(now / 90) % 3;
      ctx.fillRect(left + 3 + pulse, top - 5 - pulse, width - 6 - pulse * 2, 2);
      ctx.fillStyle = powered ? "#86ddec" : "#858989";
      ctx.fillRect(Math.round(x) - 1, top - 8, 3, 8);
    } else if (kind === BUILDING.SHIELD_PYLON) {
      ctx.strokeStyle = powered ? "rgba(108,207,232,.9)" : "#777";
      ctx.beginPath(); ctx.arc(x, y, width * 0.7, Math.PI, Math.PI * 2); ctx.stroke();
    } else if (kind === BUILDING.REPAIR_DEPOT) {
      const arm = powered ? Math.sin(now / 180) * 4 : 0;
      ctx.fillRect(left + 4, top + 4, width - 8, 4);
      ctx.fillRect(Math.round(x + arm) - 1, top - 5, 3, 11);
      ctx.fillStyle = active ? "#f0b249" : "#89847a";
      ctx.fillRect(Math.round(x + arm) - 4, top - 7, 9, 3);
    } else if (kind === BUILDING.ORE_REFINERY) {
      const crusher = powered ? Math.floor(now / 130) % 5 : 2;
      ctx.fillRect(left + 3, top + 4, width - 6, 3);
      ctx.fillRect(left + 5 + crusher, top + 9, Math.max(3, width / 3), 4);
      ctx.fillStyle = "#9d7440";
      ctx.fillRect(left + width - 9 - crusher, top + 9, 5, 4);
    } else if (kind === BUILDING.DIGGER_BARRACKS) {
      const door = active ? Math.floor(now / 90) % Math.max(3, Math.floor(width / 3)) : 0;
      ctx.fillStyle = "#1f2021";
      ctx.fillRect(Math.round(x) - Math.floor(width / 5), top + 5, Math.floor(width * 0.4), height - 7);
      ctx.fillStyle = powered ? "#b4aea0" : "#74736d";
      ctx.fillRect(Math.round(x) - Math.floor(width / 5) + door, top + 6, 2, height - 9);
      ctx.fillStyle = powered && Math.floor(now / 240) % 2 === 0 ? "#f04e3e" : "#74352e";
      ctx.fillRect(left + 4, top + 4, 3, 3);
    } else if (kind === BUILDING.DEEP_DRILL) {
      const angle = facing / 256 * Math.PI * 2;
      const spin = active ? Math.floor(now / 55) % 3 : 1;
      ctx.save(); ctx.translate(x, y - 2); ctx.rotate(angle);
      ctx.fillStyle = powered ? "#d7d2c7" : "#777";
      ctx.fillRect(-2, -5, Math.round(width * 0.62), 10);
      ctx.fillStyle = "#9a7041";
      ctx.fillRect(Math.round(width * 0.38), -4 + spin, 8, 2);
      ctx.fillRect(Math.round(width * 0.38), 2 - spin, 8, 2);
      ctx.restore();
    } else if (kind === BUILDING.TRACK_DEPOT) {
      const belt = powered ? Math.floor(now / 95) % 6 : 0;
      ctx.fillStyle = "#242426";
      ctx.fillRect(left + 3, Math.round(y) - 5, width - 6, 10);
      for (let i = -2; i < width; i += 6) {
        ctx.fillStyle = "#a99f8b";
        ctx.fillRect(left + 3 + (i + belt) % Math.max(6, width - 7), Math.round(y) - 4, 2, 8);
      }
    } else if (kind === BUILDING.DRILL_FORGE) {
      const hammer = powered ? Math.round(Math.abs(Math.sin(now / 125)) * 8) : 5;
      ctx.fillStyle = active ? "#d28a3c" : "#78624c";
      ctx.fillRect(left + 4, top + height - 10, width - 8, 4);
      ctx.fillStyle = powered ? "#e1ddd2" : "#777";
      ctx.fillRect(Math.round(x) - 1, top - 6 + hammer, 3, 12);
      ctx.fillRect(Math.round(x) - 7, top - 7 + hammer, 15, 4);
    } else {
      ctx.fillRect(left + 3, top + 3, width - 6, 3);
      ctx.fillRect(left + 4, top + 8, Math.max(2, width - 8), 2);
    }
    ctx.font = "6px Goldman, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = powered || preview ? "#eae7db" : "#aaa9a1";
    ctx.fillText(definition.shortLabel, Math.round(x), top + height - 3);
    if (!preview && health < 255) {
      const barWidth = width;
      ctx.fillStyle = "#241b1a";
      ctx.fillRect(left, top + height + 3, barWidth, 2);
      ctx.fillStyle = health > 85 ? "#76b85a" : "#d55345";
      ctx.fillRect(left, top + height + 3, Math.round(barWidth * health / 255), 2);
    }
    ctx.restore();
  }

  private drawBlast(
    ctx: CanvasRenderingContext2D,
    e: RemoteEntity,
    screenX: number,
    screenY: number,
    st: ClientState,
    now: number
  ): void {
    if (!st.world) return;
    if (e.kind === ENT.BLAST) this.emitBlastBurst(e, st, now);
    const base = BALANCE.items.bomb;
    const features = e.flags & 3;
    const encodedRange = e.flags >> 3;
    const halfWidth = e.width & 15;
    const aim = ((e.width >> 4) & 7) * 32;
    const blueprint = blueprintForVariant(e.variant);
    const pattern = blastPatternForVariant(e.variant);
    const cfg = {
      ...base,
      blastRangeCells: encodedRange || base.blastRangeCells,
      blastHalfWidthCells: halfWidth || base.blastHalfWidthCells + ((features & BOMB_FEATURE.WIDE) !== 0 ? 1 : 0),
      blastDiagonal: (features & BOMB_FEATURE.DIAGONAL) !== 0
    };
    const radius = Math.min(cfg.blastRangeCells, e.facing);
    const originX = Math.floor(e.toX / FP);
    const originY = Math.floor(e.toY / FP);
    const blocked = (x: number, y: number) => {
      const mat = st.world!.get(x, y);
      return mat === MAT.BEDROCK || (mat === MAT.REINFORCE && blueprint !== "acid-bomb");
    };
    if (blueprint === "gas-bomb") {
      const queue = [{ x: originX, y: originY, distance: 0 }];
      const visited = new Set([`${originX}:${originY}`]);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const cell = queue[cursor]!;
        const dx = cell.x - originX;
        const dy = cell.y - originY;
        drawPixelBlastCell(
          ctx,
          screenX + dx * st.cellPx,
          screenY + dy * st.cellPx,
          st.cellPx,
          e.kind,
          e.variant,
          e.id,
          dx,
          dy,
          now
        );
        if (cell.distance >= radius) continue;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = cell.x + ox;
          const y = cell.y + oy;
          const key = `${x}:${y}`;
          if (visited.has(key) || !st.world.inBounds(x, y)) continue;
          const material = st.world.get(x, y);
          if (material !== MAT.EMPTY && material !== MAT.VENT) continue;
          visited.add(key);
          queue.push({ x, y, distance: cell.distance + 1 });
        }
      }
      return;
    }
    const laneBlocked = (dx: number, dy: number, armMask: number): boolean => {
      let horizontalBlocked = true;
      if ((armMask & 1) !== 0) {
        const sx = Math.sign(dx);
        horizontalBlocked = dx === 0 ? blocked(originX, originY + dy) : false;
        for (let step = 1; step <= Math.abs(dx); step++) {
          if (blocked(originX + sx * step, originY + dy)) horizontalBlocked = true;
        }
      }

      let verticalBlocked = true;
      if ((armMask & 2) !== 0) {
        const sy = Math.sign(dy);
        verticalBlocked = dy === 0 ? blocked(originX + dx, originY) : false;
        for (let step = 1; step <= Math.abs(dy); step++) {
          if (blocked(originX + dx, originY + sy * step)) verticalBlocked = true;
        }
      }
      let diagonalBlocked = true;
      if ((armMask & 12) !== 0) {
        diagonalBlocked = false;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        if (steps === 0) diagonalBlocked = blocked(originX, originY);
        for (let step = 1; step <= steps; step++) {
          const x = originX + Math.round((dx * step) / steps);
          const y = originY + Math.round((dy * step) / steps);
          if (blocked(x, y)) diagonalBlocked = true;
        }
      }
      return horizontalBlocked && verticalBlocked && diagonalBlocked;
    };
    const rayBlocked = (dx: number, dy: number): boolean => {
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps === 0) return false;
      for (let step = 1; step <= steps; step++) {
        const x = originX + Math.round(dx * step / steps);
        const y = originY + Math.round(dy * step / steps);
        if (!st.world!.inBounds(x, y) || blocked(x, y)) return true;
      }
      return false;
    };

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!bombBlastPatternContains(dx, dy, cfg, e.id, pattern, aim)) continue;
        if (pattern === "cross" || pattern === "star" || pattern === "x") {
          const laneCfg = pattern === "cross" ? cfg : { ...cfg, blastDiagonal: true };
          let armMask = bombBlastArmMask(dx, dy, laneCfg, e.id);
          if (pattern === "x") armMask &= 12;
          if (armMask === 0 || laneBlocked(dx, dy, armMask)) continue;
        } else if (rayBlocked(dx, dy)) {
          continue;
        }
        const x = screenX + dx * st.cellPx;
        const y = screenY + dy * st.cellPx;
        drawPixelBlastCell(ctx, x, y, st.cellPx, e.kind, e.variant, e.id, dx, dy, now);
      }
    }
  }

  private emitBlastBurst(e: RemoteEntity, st: ClientState, now: number): void {
    if (this.blastBursts.has(e.id)) return;
    this.blastBursts.set(e.id, now);
    for (const [id, seenAt] of this.blastBursts) {
      if (now - seenAt > 30_000) this.blastBursts.delete(id);
    }
    const worldX = (e.toX / FP) * st.cellPx;
    const worldY = (e.toY / FP) * st.cellPx;
    const accent = bombColors(e.variant)[0];
    const violent = e.variant === WEAPON.NUKE;
    const baseCore = e.variant === WEAPON.BASE_CORE;
    const sparkCount = violent ? 34 : baseCore ? 26 : 18;
    for (let i = 0; i < sparkCount; i++) {
      const seed = hash2(e.id, i, 0xb17a);
      const angle = ((seed & 0xffff) / 0xffff) * Math.PI * 2;
      const speed = 20 + ((seed >>> 16) & 63) * (violent ? 0.95 : baseCore ? 0.78 : 0.58);
      const life = 0.28 + ((seed >>> 24) & 31) / 70;
      this.particles.push({
        x: worldX,
        y: worldY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 9,
        life,
        maxLife: life,
        color: i % 4 === 0 ? "#fff4b0" : accent,
        gravity: 48,
        size: i % 5 === 0 ? 2 : 1,
        kind: "spark",
        seed
      });
    }
    const smokeCount = violent ? 16 : baseCore ? 12 : 7;
    for (let i = 0; i < smokeCount; i++) {
      const seed = hash2(e.id, i, 0x51d7);
      const angle = ((seed & 0xffff) / 0xffff) * Math.PI * 2;
      const speed = 5 + ((seed >>> 16) & 31) * 0.35;
      const life = 0.55 + ((seed >>> 24) & 31) / 35;
      this.particles.push({
        x: worldX + Math.cos(angle) * 3,
        y: worldY + Math.sin(angle) * 3,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 6,
        life,
        maxLife: life,
        color: e.variant === WEAPON.NUKE ? "#314b35" : "#392d2a",
        gravity: -2,
        size: 2 + (seed % 3),
        kind: "smoke",
        seed
      });
    }
    if (this.particles.length > 1200) this.particles.splice(0, this.particles.length - 1200);
    this.shake = Math.max(this.shake, violent ? 8 : baseCore ? 6 : 3.5);
  }

  private drawMiner(ctx: CanvasRenderingContext2D, x: number, y: number, flags: number, tint: string, now: number): void {
    const bob = (flags & PFLAG.DIGGING) !== 0 ? Math.sin(now / 60) * 1.2 : 0;
    // body
    ctx.fillStyle = "#4a4038";
    ctx.fillRect(x - 4, y - 3 + bob, 8, 8);
    // helmet
    ctx.fillStyle = tint;
    ctx.fillRect(x - 4, y - 7 + bob, 8, 5);
    // headlamp
    ctx.fillStyle = "#fff7c8";
    ctx.fillRect(x - 1, y - 6 + bob, 2, 2);
    if (flags & PFLAG.STUNNED) {
      ctx.strokeStyle = "#9ad4ff";
      ctx.strokeRect(x - 6, y - 9, 12, 14);
    }
    if (flags & PFLAG.INCAP) {
      ctx.fillStyle = "rgba(200,60,60,0.7)";
      ctx.fillRect(x - 5, y - 10, 10, 2);
    }
  }

  private drawMiningBase(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    minerCount: number,
    owned: boolean,
    now: number,
    scale = 1
  ): void {
    const pulse = 0.72 + Math.sin(now / 260) * 0.18;
    const size = Math.round(76 * scale);
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    if (this.miningBaseImage.complete && this.miningBaseImage.naturalWidth > 0) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.miningBaseImage, left, top, size, size);
      ctx.restore();
    } else {
      // Compact fallback while the supplied artwork is still loading.
      ctx.fillStyle = owned ? "#6d5540" : "#4d4543";
      ctx.fillRect(x - 28 * scale, y - 24 * scale, 56 * scale, 48 * scale);
      ctx.fillStyle = "#332b29";
      ctx.fillRect(x - 22 * scale, y - 18 * scale, 44 * scale, 36 * scale);
      ctx.fillStyle = "#171719";
      ctx.fillRect(x - 8 * scale, y - 2 * scale, 16 * scale, 20 * scale);
    }
    const statusY = Math.round(y + 34 * scale);
    ctx.fillStyle = owned ? `rgba(255,111,72,${pulse})` : "rgba(120,116,108,.72)";
    ctx.fillRect(Math.round(x) - 2, statusY - 4, 4, 2);
    for (let i = 0; i < Math.min(6, minerCount); i++) {
      ctx.fillStyle = "#d9a25d";
      ctx.fillRect(Math.round(x) - 11 + i * 4, statusY, 3, 2);
    }
  }

  private drawAutoMiner(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    facing: number,
    digging: boolean,
    ownerId: number,
    now: number
  ): void {
    const angle = (facing / 256) * Math.PI * 2;
    const bob = digging ? Math.sin(now / 55 + ownerId) : Math.sin(now / 150 + ownerId) * 0.4;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.rotate(angle);
    ctx.fillStyle = "#292a2d";
    ctx.fillRect(-5, -5, 9, 10);
    ctx.fillStyle = ["#d9a25d", "#8bb7d6", "#c77d68", "#8fc97b"][ownerId & 3];
    ctx.fillRect(-4, -7, 7, 4);
    ctx.fillStyle = "#ffe6a3";
    ctx.fillRect(2, -5, 3, 2);
    ctx.fillStyle = "#97938b";
    ctx.fillRect(4, -2, 5, 4);
    ctx.fillStyle = "#d2c9b4";
    ctx.fillRect(8, -1, 3, 2);
    if (digging && Math.floor(now / 70) % 2 === 0) {
      ctx.fillStyle = "#ffca62";
      ctx.fillRect(11, -4, 2, 2);
      ctx.fillRect(12, 3, 1, 1);
    }
    ctx.restore();
  }

  private drawHunter(ctx: CanvasRenderingContext2D, x: number, y: number, facing: number, ownerId: number, now: number): void {
    const angle = facing / 256 * Math.PI * 2;
    ctx.save();
    ctx.translate(x, y + Math.sin(now / 110 + ownerId) * 0.7);
    ctx.rotate(angle);
    ctx.fillStyle = "#202226";
    ctx.fillRect(-6, -6, 11, 12);
    ctx.fillStyle = ["#d9a25d", "#8bb7d6", "#c77d68", "#8fc97b"][ownerId & 3];
    ctx.fillRect(-5, -8, 8, 4);
    ctx.fillStyle = "#d34132";
    ctx.fillRect(1, -7, 3, 2);
    ctx.fillStyle = "#98938b";
    ctx.fillRect(4, -2, 8, 4);
    ctx.fillStyle = "#eee5d1";
    ctx.fillRect(11, -1, 3, 2);
    if (Math.floor(now / 180 + ownerId) % 2 === 0) {
      ctx.fillStyle = "#ff5948";
      ctx.fillRect(-1, -10, 2, 2);
    }
    ctx.restore();
  }

  private drawOreCart(ctx: CanvasRenderingContext2D, x: number, y: number, facing: number, ownerId: number, now: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(facing / 256 * Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(-8, 4, 16, 3);
    ctx.fillStyle = "#343434";
    ctx.fillRect(-8, -5, 16, 10);
    ctx.fillStyle = "#81796b";
    ctx.fillRect(-6, -4, 12, 6);
    ctx.fillStyle = ["#d9a25d", "#8bb7d6", "#c77d68", "#8fc97b"][ownerId & 3];
    ctx.fillRect(-5, -3, 10, 3);
    ctx.fillStyle = Math.floor(now / 180) % 2 ? "#ffd65b" : "#8d6729";
    ctx.fillRect(5, -2, 2, 2);
    ctx.fillStyle = "#171717";
    ctx.fillRect(-6, 4, 4, 3);
    ctx.fillRect(3, 4, 4, 3);
    ctx.restore();
  }

  private drawCharacter(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    facing: number,
    moving: boolean,
    flags: number,
    now: number,
    animationOffset: number
  ): void {
    if (!this.characterSheet.complete || this.characterSheet.naturalWidth < CHARACTER_FRAME_PX * 4) {
      this.drawMiner(ctx, x, y, flags, "#e8b44a", now);
      return;
    }
    const octant = Math.round((facing & 255) / 32) & 7;
    const row = CHARACTER_ROWS_BY_OCTANT[octant];
    const frame = moving ? (Math.floor(now / 135) + animationOffset) & 3 : 0;
    const bob = moving ? Math.sin((now + animationOffset * 47) / 90) * 0.35 : 0;
    const dx = Math.round(x - CHARACTER_DRAW_PX / 2);
    const dy = Math.round(y - CHARACTER_DRAW_PX * 0.58 + bob);
    ctx.drawImage(
      this.characterSheet,
      frame * CHARACTER_FRAME_PX,
      row * CHARACTER_FRAME_PX,
      CHARACTER_FRAME_PX,
      CHARACTER_FRAME_PX,
      dx,
      dy,
      CHARACTER_DRAW_PX,
      CHARACTER_DRAW_PX
    );
    if (flags & PFLAG.STUNNED) {
      ctx.strokeStyle = "#9ad4ff";
      ctx.strokeRect(x - 9, y - 13, 18, 22);
    }
    if (flags & PFLAG.INCAP) {
      ctx.fillStyle = "rgba(200,60,60,0.8)";
      ctx.fillRect(x - 8, y - 15, 16, 2);
    }
    if (flags & PFLAG.SLOWED) {
      const shimmer = Math.floor(now / 120 + animationOffset) & 1;
      ctx.fillStyle = "rgba(142,226,255,.86)";
      ctx.fillRect(Math.round(x) - 8, Math.round(y) + 7, 5, 2);
      ctx.fillRect(Math.round(x) + 3, Math.round(y) + 7, 5, 2);
      ctx.fillRect(Math.round(x) - 5 + shimmer * 7, Math.round(y) + 4, 2, 2);
    }
  }

  private drawMonster(ctx: CanvasRenderingContext2D, x: number, y: number, now: number): void {
    const pulse = Math.sin(now / 120) * 1.5;
    ctx.fillStyle = "#2a1218";
    ctx.beginPath();
    ctx.arc(x, y, 7 + pulse * 0.5, 0, Math.PI * 2);
    ctx.fill();
    // spikes
    ctx.fillStyle = "#511f2a";
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + now / 400;
      ctx.fillRect(x + Math.cos(a) * 8 - 1, y + Math.sin(a) * 8 - 1, 3, 3);
    }
    // eyes
    ctx.fillStyle = "#ff5f4a";
    ctx.fillRect(x - 3, y - 2, 2, 2);
    ctx.fillRect(x + 1, y - 2, 2, 2);
  }

  private drawZombie(ctx: CanvasRenderingContext2D, x: number, y: number, facing: number, now: number): void {
    const bob = Math.sin(now / 95) * 1.2;
    ctx.fillStyle = "#38513c";
    ctx.fillRect(x - 5, y - 5 + bob, 10, 10);
    ctx.fillStyle = "#6f8f61";
    ctx.fillRect(x - 4, y - 7 + bob, 8, 5);
    const ang = (facing / 256) * Math.PI * 2;
    const ex = Math.round(Math.cos(ang) * 2);
    const ey = Math.round(Math.sin(ang) * 2);
    ctx.fillStyle = "#d7f06a";
    ctx.fillRect(x - 2 + ex, y - 4 + ey + bob, 2, 2);
    ctx.fillRect(x + 1 + ex, y - 4 + ey + bob, 2, 2);
    ctx.strokeStyle = "rgba(111,143,97,0.45)";
    ctx.strokeRect(x - 7, y - 9 + bob, 14, 16);
  }

  private drawConversionRing(ctx: CanvasRenderingContext2D, x: number, y: number, now: number): void {
    ctx.strokeStyle = `rgba(209,73,91,${0.5 + Math.sin(now / 80) * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.stroke();
  }

  private renderLight(st: ClientState, sx: number, sy: number, ambient: number, now: number): void {
    const lctx = this.lightCtx;
    lctx.globalCompositeOperation = "source-over";
    lctx.fillStyle = `rgba(4,2,8,${ambient})`;
    lctx.clearRect(0, 0, INTERNAL_W, INTERNAL_H);
    lctx.fillRect(0, 0, INTERNAL_W, INTERNAL_H);
    if (!st.world) return;
    const visionLevel = st.self?.visionLevel ?? 0;
    const playerCellX = Math.floor(st.predX / FP);
    const playerCellY = Math.floor(st.predY / FP);
    const key = `${playerCellX}:${playerCellY}:${visionLevel}:${st.cellPx}:${this.terrainLightRevision}`;
    if (this.terrainLightWorld !== st.world || this.terrainLightKey !== key) {
      this.rebuildTerrainLightMask(st, playerCellX, playerCellY, visionLevel);
      this.terrainLightWorld = st.world;
      this.terrainLightKey = key;
    }

    const playerPxX = (st.predX / FP) * st.cellPx;
    const playerPxY = (st.predY / FP) * st.cellPx;
    const camX = playerPxX - sx;
    const camY = playerPxY - sy;
    lctx.globalCompositeOperation = "destination-out";
    lctx.imageSmoothingEnabled = false;
    lctx.drawImage(
      this.terrainLightMask,
      Math.round(this.terrainLightOriginX - camX),
      Math.round(this.terrainLightOriginY - camY)
    );
    // Explosives carve warm, local holes through the fog instead of having
    // their brightest pixels flattened by the global darkness pass.
    for (const e of st.entities.values()) {
      const floodlight = e.kind === ENT.BUILDING && (e.variant & 15) === BUILDING.FLOODLIGHT && (e.flags & BUILDING_FLAG.POWERED) !== 0;
      if (e.kind !== ENT.BOMB && e.kind !== ENT.BLAST && e.kind !== ENT.FIRE && !floodlight) continue;
      if (e.kind === ENT.BOMB && (e.flags & EFLAG.AIRBORNE) !== 0 && e.facing === 0) continue;
      const ex = (st.lerpNow(e, now, "x") / FP) * st.cellPx - camX;
      const ey = (st.lerpNow(e, now, "y") / FP) * st.cellPx - camY;
      if (ex < -120 || ey < -120 || ex > INTERNAL_W + 120 || ey > INTERNAL_H + 120) continue;
      const pulse = 0.82 + Math.sin(now / 70 + e.id) * 0.18;
      const radius = floodlight
        ? (buildingDefinition(BUILDING.FLOODLIGHT)?.range ?? 32) * st.cellPx
        : e.kind === ENT.BLAST
        ? Math.min(110, 24 + e.facing * st.cellPx * 0.72)
        : e.kind === ENT.FIRE ? 20 : 12 + pulse * 4;
      const strength = floodlight ? 0.62 : e.kind === ENT.BLAST ? 0.9 : e.kind === ENT.FIRE ? 0.42 : 0.28 + pulse * 0.12;
      const glow = lctx.createRadialGradient(ex, ey, 0, ex, ey, radius);
      glow.addColorStop(0, `rgba(255,255,255,${strength})`);
      glow.addColorStop(0.52, `rgba(255,255,255,${strength * 0.42})`);
      glow.addColorStop(1, "rgba(255,255,255,0)");
      lctx.fillStyle = glow;
      lctx.fillRect(ex - radius, ey - radius, radius * 2, radius * 2);
    }
    lctx.globalCompositeOperation = "source-over";
  }

  private rebuildTerrainLightMask(
    st: ClientState,
    playerCellX: number,
    playerCellY: number,
    visionLevel: number
  ): void {
    if (!st.world) return;
    const world = st.world;
    const cellPx = st.cellPx;
    const visionBleedPx = visionLevel * VISION_SHADOW_BLEED_PX_PER_LEVEL;
    const terrainBleedPx = TERRAIN_LIGHT_BLEED_PX + visionBleedPx;
    const resourceBleedPx = RESOURCE_LIGHT_BLEED_PX + visionBleedPx;
    const gemBleedPx = GEM_LIGHT_BLEED_PX + visionBleedPx;
    const bleedCells = Math.ceil(gemBleedPx / cellPx) + LIGHT_MASK_MARGIN_CELLS;
    // Cover the complete viewport instead of cutting visibility off at a
    // circular sight radius. Open terrain is limited only by actual LOS;
    // solid terrain and corners keep the existing pixel-level shadow falloff.
    const halfViewportCellsX = Math.ceil(INTERNAL_W / (2 * cellPx));
    const halfViewportCellsY = Math.ceil(INTERNAL_H / (2 * cellPx));
    const x0 = Math.max(0, playerCellX - halfViewportCellsX - bleedCells);
    const y0 = Math.max(0, playerCellY - halfViewportCellsY - bleedCells);
    const x1 = Math.min(world.size - 1, playerCellX + halfViewportCellsX + bleedCells);
    const y1 = Math.min(world.size - 1, playerCellY + halfViewportCellsY + bleedCells);
    const cellWidth = x1 - x0 + 1;
    const cellHeight = y1 - y0 + 1;
    const width = cellWidth * cellPx;
    const height = cellHeight * cellPx;
    this.terrainLightMask.width = width;
    this.terrainLightMask.height = height;
    this.terrainLightOriginX = x0 * cellPx;
    this.terrainLightOriginY = y0 * cellPx;

    const visibleOpen = new Uint8Array(cellWidth * cellHeight);
    const shadowedOpen = new Uint8Array(cellWidth * cellHeight);
    const viewerX = playerCellX + 0.5;
    const viewerY = playerCellY + 0.5;
    for (let localY = 0; localY < cellHeight; localY++) {
      const worldY = y0 + localY;
      for (let localX = 0; localX < cellWidth; localX++) {
        const worldX = x0 + localX;
        if (world.isSolid(worldX, worldY)) continue;
        shadowedOpen[localY * cellWidth + localX] = 1;
        if (!hasLineOfSight(world, viewerX, viewerY, worldX + 0.5, worldY + 0.5)) continue;
        visibleOpen[localY * cellWidth + localX] = 1;
      }
    }

    // Chamfer distance transform at native render resolution. The resulting
    // mask is genuinely per-pixel: ordinary terrain fades for ten pixels from
    // exposed tunnel edges. Ores carry farther, while common and reinforcement
    // gems retain a readable glint for ten terrain cells beyond clear LOS.
    const far = 1_000_000;
    const diagonal = Math.SQRT2;
    const distances = new Float32Array(width * height);
    distances.fill(far);
    for (let cellY = 0; cellY < cellHeight; cellY++) {
      for (let cellX = 0; cellX < cellWidth; cellX++) {
        if (visibleOpen[cellY * cellWidth + cellX] === 0) continue;
        const px0 = cellX * cellPx;
        const py0 = cellY * cellPx;
        for (let py = py0; py < py0 + cellPx; py++) {
          distances.fill(0, py * width + px0, py * width + px0 + cellPx);
        }
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        let distance = distances[index];
        if (x > 0) distance = Math.min(distance, distances[index - 1] + 1);
        if (y > 0) distance = Math.min(distance, distances[index - width] + 1);
        if (x > 0 && y > 0) distance = Math.min(distance, distances[index - width - 1] + diagonal);
        if (x + 1 < width && y > 0) distance = Math.min(distance, distances[index - width + 1] + diagonal);
        distances[index] = distance;
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const index = y * width + x;
        let distance = distances[index];
        if (x + 1 < width) distance = Math.min(distance, distances[index + 1] + 1);
        if (y + 1 < height) distance = Math.min(distance, distances[index + width] + 1);
        if (x + 1 < width && y + 1 < height) distance = Math.min(distance, distances[index + width + 1] + diagonal);
        if (x > 0 && y + 1 < height) distance = Math.min(distance, distances[index + width - 1] + diagonal);
        distances[index] = distance;
      }
    }

    const maskCtx = this.terrainLightMask.getContext("2d")!;
    const mask = maskCtx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const cellY = Math.floor(y / cellPx);
      const worldY = y0 + cellY;
      for (let x = 0; x < width; x++) {
        const cellX = Math.floor(x / cellPx);
        const worldX = x0 + cellX;
        const cellIndex = cellY * cellWidth + cellX;
        const visible = visibleOpen[cellIndex] !== 0;
        const isShadowedOpen = shadowedOpen[cellIndex] !== 0;
        const material = world.get(worldX, worldY);
        const distance = distances[y * width + x];
        let strength = visible ? 1 : 0;
        if (!visible && isShadowedOpen) {
          strength = OPEN_SHADOW_LIGHT;
          if (distance <= terrainBleedPx) {
            const t = distance / terrainBleedPx;
            strength = Math.max(strength, 1 - t * t * (3 - 2 * t));
          }
        } else if (!visible && world.isSolid(worldX, worldY)) {
          const gem = isGemMaterial(material);
          const revealDistance = gem ? gemBleedPx : isResourceMaterial(material) ? resourceBleedPx : terrainBleedPx;
          if (distance <= revealDistance) {
            const t = distance / revealDistance;
            strength = 1 - t * t * (3 - 2 * t);
            if (gem) strength = Math.max(strength, Math.sqrt(Math.max(0, 1 - t)) * 0.5);
          }
        }
        if (strength <= 0) continue;
        const index = (y * width + x) * 4;
        mask.data[index] = 255;
        mask.data[index + 1] = 255;
        mask.data[index + 2] = 255;
        mask.data[index + 3] = Math.round(strength * 255);
      }
    }
    maskCtx.putImageData(mask, 0, 0);
  }

  private renderMinimap(st: ClientState, cameraCellX?: number, cameraCellY?: number): void {
    const mm = this.minimapCtx;
    const w = this.minimap.width;
    mm.fillStyle = "#0b0910";
    mm.fillRect(0, 0, w, w);
    if (!st.world || !st.knownChunks) return;
    const step = st.worldSize / w; // world cells per minimap pixel
    const samples = Math.min(4, Math.max(1, Math.ceil(step / 8)));
    const img = mm.createImageData(w, w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        let known = false;
        let foundEmpty = false;
        let foundBedrock = false;
        let foundFossil = false;
        let foundResource = false;
        for (let sampleY = 0; sampleY < samples; sampleY++) {
          for (let sampleX = 0; sampleX < samples; sampleX++) {
            const wx = Math.min(st.world.size - 1, Math.floor((x + (sampleX + 0.5) / samples) * step));
            const wy = Math.min(st.world.size - 1, Math.floor((y + (sampleY + 0.5) / samples) * step));
            if (!st.knownChunks[st.world.chunkIndexOf(wx, wy)]) continue;
            known = true;
            const sampled = st.world.mat[wy * st.world.size + wx];
            foundEmpty ||= sampled === MAT.EMPTY;
            foundBedrock ||= sampled === MAT.BEDROCK;
            foundFossil ||= sampled === MAT.FOSSIL;
            foundResource ||= sampled === MAT.GEM || sampled === MAT.GOLD || sampled === MAT.COPPER || sampled === MAT.IRON || sampled === MAT.PLATINUM || sampled === MAT.COAL;
          }
        }
        if (!known) continue;
        const di = (y * w + x) * 4;
        if (foundFossil) {
          img.data[di] = 213;
          img.data[di + 1] = 199;
          img.data[di + 2] = 166;
          img.data[di + 3] = 235;
        } else if (foundResource) {
          img.data[di] = 202;
          img.data[di + 1] = 151;
          img.data[di + 2] = 66;
          img.data[di + 3] = 225;
        } else if (foundEmpty) {
          img.data[di] = 137;
          img.data[di + 1] = 128;
          img.data[di + 2] = 113;
          img.data[di + 3] = 215;
        } else if (foundBedrock) {
          img.data[di] = 76;
          img.data[di + 1] = 88;
          img.data[di + 2] = 92;
          img.data[di + 3] = 230;
        } else {
          img.data[di] = 43;
          img.data[di + 1] = 36;
          img.data[di + 2] = 43;
          img.data[di + 3] = 160;
        }
      }
    }
    mm.putImageData(img, 0, 0);
    // Nearby visible tactical markers never reveal anything outside the
    // server-approved LOS snapshot.
    for (const entity of st.entities.values()) {
      if (
        entity.kind !== ENT.PLAYER && entity.kind !== ENT.CHEST && entity.kind !== ENT.GUARDIAN &&
        entity.kind !== ENT.TURRET && entity.kind !== ENT.MINING_BASE && entity.kind !== ENT.BUILDING &&
        entity.kind !== ENT.AUTO_MINER && entity.kind !== ENT.HUNTER && entity.kind !== ENT.ORE_CART && entity.kind !== ENT.LANDMARK
      ) continue;
      const ex = (entity.toX / FP / st.worldSize) * w;
      const ey = (entity.toY / FP / st.worldSize) * w;
      mm.fillStyle = entity.kind === ENT.PLAYER ? "#ef6258"
        : entity.kind === ENT.CHEST ? "#ffd56c"
        : entity.kind === ENT.GUARDIAN ? "#c18aea"
        : entity.kind === ENT.LANDMARK ? entity.variant === LANDMARK.VOLCANO ? "#ff5729" : entity.variant === LANDMARK.RITUAL ? "#d64062" : entity.variant === LANDMARK.OASIS ? "#66d790" : "#75bed7"
        : entity.kind === ENT.MINING_BASE ? "#d9a25d"
        : entity.kind === ENT.BUILDING ? (entity.flags & BUILDING_FLAG.POWERED) !== 0 ? "#f2d465" : "#777b78"
        : entity.kind === ENT.HUNTER ? "#ec5145"
        : entity.kind === ENT.ORE_CART ? "#c69647"
        : "#70d8ee";
      mm.fillRect(Math.floor(ex) - 1, Math.floor(ey) - 1, 3, 3);
    }
    // Self marker with a dark outline for contrast on any terrain.
    const sx = ((st.predX / FP) / st.worldSize) * w;
    const sy = ((st.predY / FP) / st.worldSize) * w;
    mm.fillStyle = "#171116";
    mm.fillRect(Math.floor(sx) - 2, Math.floor(sy) - 2, 5, 5);
    mm.fillStyle = "#ffca5c";
    mm.fillRect(Math.floor(sx) - 1, Math.floor(sy) - 1, 3, 3);
    if (cameraCellX !== undefined && cameraCellY !== undefined) {
      const cx = (cameraCellX / st.worldSize) * w;
      const cy = (cameraCellY / st.worldSize) * w;
      mm.strokeStyle = "#74e8ff";
      mm.strokeRect(Math.floor(cx) - 3, Math.floor(cy) - 3, 7, 7);
      mm.fillStyle = "#d9fbff";
      mm.fillRect(Math.floor(cx), Math.floor(cy), 1, 1);
    }
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function isResourceMaterial(material: number): boolean {
  return material === MAT.GEM || material === MAT.REINFORCE_GEM || isCraftMaterial(material);
}

function isGemMaterial(material: number): boolean {
  return material === MAT.GEM || material === MAT.REINFORCE_GEM;
}
