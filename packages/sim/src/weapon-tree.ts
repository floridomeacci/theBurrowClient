import type { ResourceCost } from "./upgrades";

export const WEAPON_BLUEPRINT_IDS = [
  "dynamite", "drill-torpedo", "shaped-charge", "acid-bomb", "collapse-charge", "material-bomb",
  "remote-c4", "sticky-bomb", "decoy-bomb", "proximity-mine", "shrapnel-mine", "chain-bomb", "phase-bomb",
  "cluster-bomb", "bouncing-bomb", "concussion-bomb", "cryo-bomb", "gas-bomb", "emp-charge",
  "napalm", "auto-turret", "vampire-bomb"
] as const;

export type WeaponBlueprintId = (typeof WEAPON_BLUEPRINT_IDS)[number];
export type WeaponTechBranch = "demolition" | "traps" | "control" | "warfare";
export type WeaponInventoryKey = "dynamite" | "c4" | "clusterBombs" | "napalm" | "turretKits";

export interface WeaponTechDefinition {
  id: WeaponBlueprintId;
  label: string;
  description: string;
  branch: WeaponTechBranch;
  tier: number;
  fieldSlot: number;
  unlockCost: ResourceCost;
  prerequisite?: WeaponBlueprintId;
  inventory?: WeaponInventoryKey;
  ammoCost?: ResourceCost;
}

export const WEAPON_TECH_BRANCHES: readonly { id: WeaponTechBranch; label: string; description: string }[] = [
  { id: "demolition", label: "Demolition", description: "Direct excavation and rock-breaking." },
  { id: "traps", label: "Traps & triggers", description: "Mines, chains, triggers, and decoys." },
  { id: "control", label: "Field control", description: "Disruption, denial, and crowd control." },
  { id: "warfare", label: "Siege systems", description: "Fire, automated defence, and sustain." }
];

export const WEAPON_TECH: readonly WeaponTechDefinition[] = [
  { id: "dynamite", label: "Dynamite", description: "Cuts one long two-sided line through rock.", branch: "demolition", tier: 1, fieldSlot: 4, unlockCost: { copper: 4 }, inventory: "dynamite", ammoCost: { copper: 2 } },
  { id: "drill-torpedo", label: "Drill Torpedo", description: "Burrows ahead, then continues as a narrow forward bore.", branch: "demolition", tier: 2, fieldSlot: 10, unlockCost: { iron: 6, copper: 3 }, prerequisite: "dynamite" },
  { id: "shaped-charge", label: "Shaped Charge", description: "Projects a lethal forward cone with almost no rear blast.", branch: "demolition", tier: 2, fieldSlot: 11, unlockCost: { iron: 5, gold: 1 }, prerequisite: "dynamite" },
  { id: "acid-bomb", label: "Acid Bomb", description: "Turns an L-shaped breach and leaves a damaging corrosive pool.", branch: "demolition", tier: 3, fieldSlot: 12, unlockCost: { copper: 6, fossils: 3 }, prerequisite: "shaped-charge" },
  { id: "collapse-charge", label: "Collapse Charge", description: "Cuts a wide crosswise line and drops delayed rubble.", branch: "demolition", tier: 3, fieldSlot: 13, unlockCost: { iron: 9, coal: 3 }, prerequisite: "drill-torpedo" },
  { id: "material-bomb", label: "Material Bomb", description: "Consumes exposed ore to enlarge a dense diamond blast.", branch: "demolition", tier: 4, fieldSlot: 14, unlockCost: { gold: 4, platinum: 2 }, prerequisite: "acid-bomb" },

  { id: "remote-c4", label: "Remote C4", description: "Detonates on Q into a dense diamond kill zone.", branch: "traps", tier: 1, fieldSlot: 5, unlockCost: { copper: 4, iron: 2 }, inventory: "c4", ammoCost: { iron: 2 } },
  { id: "sticky-bomb", label: "Sticky Bomb", description: "Attaches to a target for a compact high-damage burst.", branch: "traps", tier: 2, fieldSlot: 15, unlockCost: { iron: 5, copper: 2 }, prerequisite: "remote-c4" },
  { id: "decoy-bomb", label: "Decoy Bomb", description: "Fakes a live bomb without exploding.", branch: "traps", tier: 2, fieldSlot: 16, unlockCost: { common: 5 }, prerequisite: "remote-c4" },
  { id: "proximity-mine", label: "Proximity Mine", description: "Triggers a hollow perimeter ring when a rival approaches.", branch: "traps", tier: 3, fieldSlot: 17, unlockCost: { copper: 7, iron: 3 }, prerequisite: "sticky-bomb" },
  { id: "shrapnel-mine", label: "Shrapnel Mine", description: "Fires a thin diagonal X through open corridors.", branch: "traps", tier: 4, fieldSlot: 18, unlockCost: { iron: 9, copper: 3 }, prerequisite: "proximity-mine" },
  { id: "chain-bomb", label: "Chain Bomb", description: "Sends out a trigger ring that jumps to nearby explosives.", branch: "traps", tier: 5, fieldSlot: 19, unlockCost: { copper: 9, gold: 2 }, prerequisite: "shrapnel-mine" },
  { id: "phase-bomb", label: "Phase Bomb", description: "Passes through walls, then fires a narrow forward line.", branch: "traps", tier: 6, fieldSlot: 20, unlockCost: { platinum: 3, fossils: 5 }, prerequisite: "chain-bomb" },

  { id: "cluster-bomb", label: "Cluster Bomb", description: "A compact burst scatters six delayed diagonal child blasts.", branch: "control", tier: 1, fieldSlot: 6, unlockCost: { common: 6, copper: 2 }, inventory: "clusterBombs", ammoCost: { copper: 2 } },
  { id: "bouncing-bomb", label: "Bouncing Bomb", description: "Ricochets through tunnels before cutting around a corner.", branch: "control", tier: 2, fieldSlot: 21, unlockCost: { copper: 6, iron: 2 }, prerequisite: "cluster-bomb" },
  { id: "concussion-bomb", label: "Concussion Bomb", description: "A compact pressure wave throws and stuns without digging.", branch: "control", tier: 2, fieldSlot: 22, unlockCost: { iron: 7 }, prerequisite: "cluster-bomb" },
  { id: "cryo-bomb", label: "Cryo Bomb", description: "Freezes an eight-arm star into a persistent slowing field.", branch: "control", tier: 3, fieldSlot: 23, unlockCost: { platinum: 2, fossils: 4 }, prerequisite: "concussion-bomb" },
  { id: "gas-bomb", label: "Gas Bomb", description: "Floods connected tunnels with toxic gas.", branch: "control", tier: 4, fieldSlot: 24, unlockCost: { fossils: 5, coal: 4 }, prerequisite: "cryo-bomb" },
  { id: "emp-charge", label: "EMP Charge", description: "Leaves a jamming ring that drains energy and disables devices.", branch: "control", tier: 5, fieldSlot: 25, unlockCost: { copper: 8, platinum: 2 }, prerequisite: "gas-bomb" },
  { id: "napalm", label: "Napalm", description: "Projects a forward fire fan and leaves every cell burning.", branch: "warfare", tier: 1, fieldSlot: 7, unlockCost: { coal: 5, gold: 1 }, inventory: "napalm", ammoCost: { coal: 2 } },
  { id: "auto-turret", label: "Auto-Turret", description: "Tracks rivals and fires explosive shells.", branch: "warfare", tier: 1, fieldSlot: 9, unlockCost: { iron: 9, copper: 4 }, inventory: "turretKits", ammoCost: { iron: 3 } },
  { id: "vampire-bomb", label: "Vampire Bomb", description: "Forks toward escape lanes and converts damage into health.", branch: "warfare", tier: 2, fieldSlot: 26, unlockCost: { fossils: 7, platinum: 3 }, prerequisite: "napalm" }
];

const BLUEPRINT_INDEX = new Map<WeaponBlueprintId, number>(WEAPON_BLUEPRINT_IDS.map((id, index) => [id, index]));

export function weaponBlueprintBit(id: WeaponBlueprintId): number {
  const index = BLUEPRINT_INDEX.get(id);
  return index === undefined ? 0 : (1 << index) >>> 0;
}

export function hasWeaponBlueprint(mask: number, id: WeaponBlueprintId): boolean {
  return (mask & weaponBlueprintBit(id)) !== 0;
}

export function weaponTechDefinition(id: WeaponBlueprintId): WeaponTechDefinition | undefined {
  return WEAPON_TECH.find((tech) => tech.id === id);
}

export function weaponTechForSlot(slot: number): WeaponTechDefinition | undefined {
  return WEAPON_TECH.find((tech) => tech.fieldSlot === slot);
}

export interface WeaponFieldProfile {
  fuseTicks: number;
  rangeCells: number;
  halfWidthCells: number;
  diagonal?: boolean;
}

const FIELD_PROFILES: Partial<Record<WeaponBlueprintId, WeaponFieldProfile>> = {
  "drill-torpedo": { fuseTicks: 66, rangeCells: 18, halfWidthCells: 0 },
  "shaped-charge": { fuseTicks: 58, rangeCells: 12, halfWidthCells: 1 },
  "acid-bomb": { fuseTicks: 88, rangeCells: 9, halfWidthCells: 2 },
  "collapse-charge": { fuseTicks: 96, rangeCells: 13, halfWidthCells: 3 },
  "material-bomb": { fuseTicks: 78, rangeCells: 11, halfWidthCells: 2 },
  "sticky-bomb": { fuseTicks: 92, rangeCells: 7, halfWidthCells: 1 },
  "decoy-bomb": { fuseTicks: 100, rangeCells: 6, halfWidthCells: 1 },
  "proximity-mine": { fuseTicks: 110, rangeCells: 8, halfWidthCells: 1 },
  "shrapnel-mine": { fuseTicks: 74, rangeCells: 13, halfWidthCells: 0, diagonal: true },
  "chain-bomb": { fuseTicks: 64, rangeCells: 10, halfWidthCells: 1 },
  "phase-bomb": { fuseTicks: 82, rangeCells: 15, halfWidthCells: 1 },
  "bouncing-bomb": { fuseTicks: 74, rangeCells: 13, halfWidthCells: 1 },
  "concussion-bomb": { fuseTicks: 56, rangeCells: 8, halfWidthCells: 2 },
  "cryo-bomb": { fuseTicks: 80, rangeCells: 9, halfWidthCells: 2 },
  "gas-bomb": { fuseTicks: 90, rangeCells: 11, halfWidthCells: 2 },
  "emp-charge": { fuseTicks: 58, rangeCells: 9, halfWidthCells: 2 },
  "vampire-bomb": { fuseTicks: 68, rangeCells: 10, halfWidthCells: 2 }
};

export function weaponFieldProfile(id: WeaponBlueprintId): WeaponFieldProfile | undefined {
  return FIELD_PROFILES[id];
}

export function weaponKindForBlueprint(id: WeaponBlueprintId): number {
  return 32 + (BLUEPRINT_INDEX.get(id) ?? 0);
}
