import type { Balance } from "@burrow/config";

export const BOMB_FEATURE = {
  WIDE: 1,
  DIAGONAL: 2,
  TWIN: 4,
  REMOTE: 8,
  SHIELD: 16,
  PROSPECTOR: 32
} as const;

export type BombUpgradeId =
  | "speed" | "range" | "wide" | "width" | "diagonal" | "twin" | "capacity" | "remote" | "shield" | "prospector"
  | "vision" | "mobility" | "vitality";
export type CraftResource = "common" | "gold" | "fossils" | "copper" | "iron" | "platinum" | "coal";
export type ResourceCost = Partial<Record<CraftResource, number>>;

export interface BombUpgradeProgress {
  bombSpeedLevel: number;
  bombRangeLevel: number;
  bombWidthLevel: number;
  bombCapacityLevel: number;
  bombFeatures: number;
  visionLevel: number;
  moveSpeedLevel: number;
  healthLevel: number;
}

export interface BombUpgradeQuote {
  id: BombUpgradeId;
  label: string;
  description: string;
  level: number;
  maxLevel: number;
  maxed: boolean;
  prerequisiteMet: boolean;
  prerequisite: string;
  cost: ResourceCost;
}

export function bombUpgradeQuotes(progress: BombUpgradeProgress, bal: Balance): BombUpgradeQuote[] {
  const u = bal.bombUpgrades;
  const player = bal.playerUpgrades;
  const speedLevel = progress.bombSpeedLevel;
  const rangeLevel = progress.bombRangeLevel;
  const feature = (flag: number) => (progress.bombFeatures & flag) !== 0;
  return [
    {
      id: "speed",
      label: "Fast Fuse",
      description: `-${(u.speed.fuseReductionTicks / 30).toFixed(1)}s fuse each level`,
      level: speedLevel,
      maxLevel: u.speed.maxLevel,
      maxed: speedLevel >= u.speed.maxLevel,
      prerequisiteMet: true,
      prerequisite: "",
      cost: {
        copper: u.speed.copperBase + speedLevel * u.speed.copperPerLevel
      }
    },
    {
      id: "range",
      label: "Long Charge",
      description: `+${u.range.rangePerLevelCells} blast cells each level`,
      level: rangeLevel,
      maxLevel: u.range.maxLevel,
      maxed: rangeLevel >= u.range.maxLevel,
      prerequisiteMet: true,
      prerequisite: "",
      cost: {
        iron: u.range.ironBase + rangeLevel * u.range.ironPerLevel
      }
    },
    uniqueQuote("wide", "Gold Casing", "+2 total corridor width", BOMB_FEATURE.WIDE, feature, rangeLevel >= u.wide.requiresRangeLevel,
      `requires Range ${u.wide.requiresRangeLevel}`, { gold: u.wide.goldCost, iron: u.wide.ironCost }),
    {
      id: "width",
      label: "Payload Width",
      description: "+2 total corridor width each level",
      level: progress.bombWidthLevel,
      maxLevel: u.width.maxLevel,
      maxed: progress.bombWidthLevel >= u.width.maxLevel,
      prerequisiteMet: feature(BOMB_FEATURE.WIDE),
      prerequisite: "requires Gold Casing",
      cost: {
        gold: u.width.goldBase + progress.bombWidthLevel * u.width.goldPerLevel,
        iron: u.width.ironBase + progress.bombWidthLevel * u.width.ironPerLevel
      }
    },
    uniqueQuote("diagonal", "Fossil Resonance", "adds noisy diagonal blast arms", BOMB_FEATURE.DIAGONAL, feature,
      rangeLevel >= u.diagonal.requiresRangeLevel, `requires Range ${u.diagonal.requiresRangeLevel}`,
      { fossils: u.diagonal.fossilCost, gold: u.diagonal.goldCost }),
    uniqueQuote("twin", "Platinum Twin", "+1 simultaneously active bomb", BOMB_FEATURE.TWIN, feature,
      speedLevel >= u.twin.requiresSpeedLevel, `requires Speed ${u.twin.requiresSpeedLevel}`,
      { platinum: u.twin.platinumCost, copper: u.twin.copperCost }),
    {
      id: "capacity",
      label: "Bomb Rack",
      description: "+1 simultaneously active bomb each level",
      level: progress.bombCapacityLevel,
      maxLevel: u.capacity.maxLevel,
      maxed: progress.bombCapacityLevel >= u.capacity.maxLevel,
      prerequisiteMet: feature(BOMB_FEATURE.TWIN),
      prerequisite: "requires Platinum Twin",
      cost: {
        platinum: u.capacity.platinumBase + progress.bombCapacityLevel * u.capacity.platinumPerLevel,
        copper: u.capacity.copperBase + progress.bombCapacityLevel * u.capacity.copperPerLevel
      }
    },
    uniqueQuote("remote", "Gold Detonator", "Q remotely detonates your bombs", BOMB_FEATURE.REMOTE, feature,
      speedLevel >= u.remote.requiresSpeedLevel, `requires Speed ${u.remote.requiresSpeedLevel}`,
      { gold: u.remote.goldCost, copper: u.remote.copperCost }),
    uniqueQuote("shield", "Blast Ward", "you survive your own bomb blasts", BOMB_FEATURE.SHIELD, feature,
      progress.bombWidthLevel >= u.shield.requiresWidthLevel, `requires Width ${u.shield.requiresWidthLevel}`,
      { fossils: u.shield.fossilCost, platinum: u.shield.platinumCost }),
    uniqueQuote("prospector", "Prospector Core", "bombs recover double materials", BOMB_FEATURE.PROSPECTOR, feature,
      rangeLevel >= u.prospector.requiresRangeLevel, `requires Range ${u.prospector.requiresRangeLevel}`,
      { gold: u.prospector.goldCost, fossils: u.prospector.fossilCost }),
    stackQuote(
      "vision", "Survey Optics", "reveals resources deeper through terrain shadows",
      progress.visionLevel, player.vision.maxLevel,
      {
        fossils: player.vision.fossilBase + progress.visionLevel * player.vision.fossilPerLevel
      }
    ),
    stackQuote(
      "mobility", "Tunnel Stride", `+${player.mobility.speedPercentPerLevel}% movement speed each level`,
      progress.moveSpeedLevel, player.mobility.maxLevel,
      {
        copper: player.mobility.copperBase + progress.moveSpeedLevel * player.mobility.copperPerLevel
      }
    ),
    stackQuote(
      "vitality", "Reinforced Suit", `+${player.vitality.healthPerLevel} maximum health each level`,
      progress.healthLevel, player.vitality.maxLevel,
      {
        iron: player.vitality.ironBase + progress.healthLevel * player.vitality.ironPerLevel
      }
    )
  ];
}

function stackQuote(
  id: BombUpgradeId,
  label: string,
  description: string,
  level: number,
  maxLevel: number,
  cost: ResourceCost
): BombUpgradeQuote {
  return { id, label, description, level, maxLevel, maxed: level >= maxLevel, prerequisiteMet: true, prerequisite: "", cost };
}

function uniqueQuote(
  id: BombUpgradeId,
  label: string,
  description: string,
  flag: number,
  hasFeature: (flag: number) => boolean,
  prerequisiteMet: boolean,
  prerequisite: string,
  cost: ResourceCost
): BombUpgradeQuote {
  const owned = hasFeature(flag);
  return { id, label, description, level: owned ? 1 : 0, maxLevel: 1, maxed: owned, prerequisiteMet, prerequisite, cost };
}

export function bombFeatureForUpgrade(id: BombUpgradeId): number {
  if (id === "wide") return BOMB_FEATURE.WIDE;
  if (id === "diagonal") return BOMB_FEATURE.DIAGONAL;
  if (id === "twin") return BOMB_FEATURE.TWIN;
  if (id === "remote") return BOMB_FEATURE.REMOTE;
  if (id === "shield") return BOMB_FEATURE.SHIELD;
  if (id === "prospector") return BOMB_FEATURE.PROSPECTOR;
  return 0;
}
