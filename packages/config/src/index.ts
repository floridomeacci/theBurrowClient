import balanceJson from "./balance.json";

export type PhaseKind = "day";

export interface PhaseDef {
  kind: PhaseKind;
  seconds: number;
}

export type Balance = typeof balanceJson & {
  match: { phases: PhaseDef[] };
};

export const BALANCE: Balance = balanceJson as unknown as Balance;

/** World size the hand-tuned balance.json mapgen counts were authored for. */
export const REFERENCE_WORLD_SIZE = 4096;

/**
 * Balance variant for a different square world size. Mapgen item counts scale
 * with world area, distances/spacings with the linear ratio, so 1024/2048
 * worlds keep the same density and remain generatable.
 */
export function balanceForWorldSize(size: number): Balance {
  if (size === REFERENCE_WORLD_SIZE) return BALANCE;
  const area = (size / REFERENCE_WORLD_SIZE) ** 2;
  const linear = size / REFERENCE_WORLD_SIZE;
  const count = (v: number): number => Math.max(1, Math.round(v * area));
  const dist = (v: number): number => Math.max(1, Math.round(v * linear));
  const m = BALANCE.mapgen;
  return withOverrides(BALANCE, {
    world: { ...BALANCE.world, size },
    mapgen: {
      ...m,
      chambersMin: count(m.chambersMin),
      chambersMax: count(m.chambersMax),
      chamberSpacing: dist(m.chamberSpacing),
      extraLoopEdges: count(m.extraLoopEdges),
      secondaryCaveZones: count(m.secondaryCaveZones),
      spawnMinDistCells: dist(m.spawnMinDistCells),
      ventCount: count(m.ventCount),
      gemClusters: count(m.gemClusters),
      singleGemDeposits: count(m.singleGemDeposits),
      reinforceGemClusters: count(m.reinforceGemClusters),
      goldSingles: count(m.goldSingles),
      goldClusters: count(m.goldClusters),
      fossilSingles: count(m.fossilSingles),
      fossilClusters: count(m.fossilClusters),
      copperSingles: count(m.copperSingles),
      copperClusters: count(m.copperClusters),
      ironSingles: count(m.ironSingles),
      ironClusters: count(m.ironClusters),
      platinumSingles: count(m.platinumSingles),
      platinumClusters: count(m.platinumClusters),
      coalSingles: count(m.coalSingles),
      coalClusters: count(m.coalClusters),
      ruinCount: count(m.ruinCount),
      ancientTunnelNetworks: count(m.ancientTunnelNetworks),
      ritualSites: count(m.ritualSites),
      oasisSites: count(m.oasisSites),
      ancientVaultSites: count(m.ancientVaultSites),
      ambientEnemies: count(m.ambientEnemies),
      landmarkSpawnClearanceCells: dist(m.landmarkSpawnClearanceCells),
      bedrockFormations: count(m.bedrockFormations),
      bedrockSpawnClearanceCells: dist(m.bedrockSpawnClearanceCells),
      boulderBlocks: count(m.boulderBlocks),
      unstablePatches: count(m.unstablePatches)
    }
  });
}

/** Deep-merge override support so the server can hot-tune values. */
export function withOverrides(base: Balance, overrides: Partial<Balance>): Balance {
  return deepMerge(JSON.parse(JSON.stringify(base)), overrides) as Balance;
}

function deepMerge(target: any, src: any): any {
  if (src === undefined || src === null) return target;
  for (const key of Object.keys(src)) {
    const sv = src[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && typeof target[key] === "object") {
      deepMerge(target[key], sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}
