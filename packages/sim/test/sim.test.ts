import { describe, expect, it } from "vitest";
import { BALANCE as PRODUCTION_BALANCE, withOverrides } from "@burrow/config";
import {
  BotController,
  BASE_TOOL_SLOT,
  BOMB_FEATURE,
  BUILDING,
  BUILDING_DEFS,
  BUILDING_FLAG,
  CHEST_FLAG,
  CHEST_VARIANT,
  EFLAG,
  ENT,
  FP,
  GUARDIAN_VARIANT,
  LANDMARK,
  MAT,
  MatchSim,
  ROLE,
  RELIC,
  TICK_HZ,
  WEAPON,
  WEAPON_BLUEPRINT_IDS,
  WEAPON_TECH,
  World,
  applyDigBrush,
  blastPatternForVariant,
  bombUpgradeQuotes,
  bombBlastContains,
  bombBlastPatternContains,
  cellsToFp,
  computeVentilation,
  generateMap,
  hasWeaponBlueprint,
  minerDiggable,
  monsterBreakable,
  weaponFieldProfile,
  weaponKindForBlueprint,
  weaponTechDefinition
} from "../src";

const roster = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, bot: true }));

// Most mechanics tests use the original compact world so the suite stays
// fast; one dedicated test below exercises the complete production 4K map.
const BALANCE = withOverrides(PRODUCTION_BALANCE, {
  world: { ...PRODUCTION_BALANCE.world, size: 1024 },
  mapgen: {
    ...PRODUCTION_BALANCE.mapgen,
    chambersMin: 12,
    chambersMax: 24,
    extraLoopEdges: 8,
    secondaryCaveZones: 10,
    spawnMinDistCells: 180,
    ventCount: 14,
    gemClusters: 52,
    singleGemDeposits: 180,
    reinforceGemClusters: 12,
    goldSingles: 28,
    goldClusters: 6,
    fossilSingles: 34,
    fossilClusters: 6,
    copperSingles: 72,
    copperClusters: 14,
    ironSingles: 64,
    ironClusters: 12,
    platinumSingles: 16,
    platinumClusters: 4,
    ruinCount: 6,
    ancientTunnelNetworks: 10,
    ritualSites: 2,
    oasisSites: 2,
    ancientVaultSites: 3,
    ambientEnemies: 10,
    landmarkSpawnClearanceCells: 80,
    bedrockFormations: 44,
    boulderBlocks: 18,
    unstablePatches: 30
  }
} as any);

describe("mapgen", () => {
  it("generates the complete 4096×4096 production world", () => {
    expect(PRODUCTION_BALANCE.world.size).toBe(4096);
    expect(PRODUCTION_BALANCE.world.size / PRODUCTION_BALANCE.world.chunk).toBe(64);
    expect(PRODUCTION_BALANCE.match.phases).toEqual([{ kind: "day", seconds: 0 }]);
    expect(PRODUCTION_BALANCE.match.winCondition).toBe("lastPlayerStanding");
    expect(PRODUCTION_BALANCE.match.initialInfected).toBe(0);
    expect(PRODUCTION_BALANCE.zombies.perPlayer).toBe(0);
    expect(PRODUCTION_BALANCE.items.bomb.blastRangeCells).toBe(8);
    expect(PRODUCTION_BALANCE.items.bomb.blastHalfWidthCells).toBe(2);
    expect(PRODUCTION_BALANCE.items.bomb.blastNoiseFringeCells).toBe(2);
    expect(PRODUCTION_BALANCE.items.bomb.blastWobbleCells).toBe(1);
    expect(PRODUCTION_BALANCE.items.bomb.blastStepTicks).toBe(1);
    expect(PRODUCTION_BALANCE.items.pick.gemCost).toBe(5);
    expect(PRODUCTION_BALANCE.items.pick.durabilityTicks).toBe(300);
    expect(PRODUCTION_BALANCE.automation.base.maxPerPlayer).toBe(1);
    expect(PRODUCTION_BALANCE.automation.miner.maxPerBase).toBe(6);
    expect(PRODUCTION_BALANCE.playerUpgrades.vision.maxLevel).toBe(4);
    expect(PRODUCTION_BALANCE.playerUpgrades.mobility.maxLevel).toBe(4);
    expect(PRODUCTION_BALANCE.playerUpgrades.vitality.maxLevel).toBe(4);
    expect(PRODUCTION_BALANCE.automation.base.siteClearanceRadiusCells).toBe(13);
    expect(PRODUCTION_BALANCE.mapgen.spawnPocketRadiusCells).toBe(12);
    expect(PRODUCTION_BALANCE.mapgen.gemClusters).toBe(1050);
    expect(PRODUCTION_BALANCE.mapgen.singleGemDeposits).toBe(11000);
    const m = generateMap(20260806, PRODUCTION_BALANCE, 8);
    expect(m.world.size).toBe(4096);
    expect(m.world.chunksPerSide).toBe(64);
    expect(m.world.mat).toHaveLength(4096 * 4096);
    expect(m.ventCells).toHaveLength(PRODUCTION_BALANCE.mapgen.ventCount);
    expect(m.bedrockFormations).toHaveLength(PRODUCTION_BALANCE.mapgen.bedrockFormations);
    expect(m.ruins).toHaveLength(PRODUCTION_BALANCE.mapgen.ruinCount);
    expect(m.ancientTunnels).toHaveLength(PRODUCTION_BALANCE.mapgen.ancientTunnelNetworks);
    expect(m.ambientEnemies).toHaveLength(PRODUCTION_BALANCE.mapgen.ambientEnemies);
    expect(m.specialSites.filter((site) => site.kind === "volcano")).toHaveLength(1);
    expect(m.specialSites.filter((site) => site.kind === "ritual")).toHaveLength(PRODUCTION_BALANCE.mapgen.ritualSites);
    expect(m.specialSites.filter((site) => site.kind === "oasis")).toHaveLength(PRODUCTION_BALANCE.mapgen.oasisSites);
    expect(m.specialSites.filter((site) => site.kind === "ancient-vault")).toHaveLength(PRODUCTION_BALANCE.mapgen.ancientVaultSites);
    const volcano = m.specialSites.find((site) => site.kind === "volcano")!;
    expect(Math.hypot(volcano.x - m.world.size / 2, volcano.y - m.world.size / 2)).toBeLessThan(m.world.size * 0.18);
    expect(m.specialSites.every((site) => m.world.get(site.cacheX, site.cacheY) === MAT.EMPTY)).toBe(true);
    expect(m.specialSites.every((site) => m.spawns.every((spawn) => Math.hypot(spawn.x - site.x, spawn.y - site.y) >= PRODUCTION_BALANCE.mapgen.landmarkSpawnClearanceCells))).toBe(true);
    for (const ruin of m.ruins) {
      expect(m.world.get(ruin.chestX, ruin.chestY)).toBe(MAT.EMPTY);
      expect(ruin.guardians).toHaveLength(PRODUCTION_BALANCE.treasure.guardiansPerRuin);
      expect(m.spawns.every((spawn) => Math.hypot(spawn.x - ruin.x, spawn.y - ruin.y) >= PRODUCTION_BALANCE.treasure.ruinSpawnClearanceCells)).toBe(true);
    }
    expect(m.spawns.every((s) => s.x <= 4095 && s.y <= 4095)).toBe(true);
    const resourceCounts = new Map<number, number>();
    for (const mat of m.world.mat) resourceCounts.set(mat, (resourceCounts.get(mat) ?? 0) + 1);
    expect(resourceCounts.get(MAT.GEM)).toBeGreaterThan(PRODUCTION_BALANCE.mapgen.singleGemDeposits);
    expect(resourceCounts.get(MAT.GOLD)).toBeGreaterThan(PRODUCTION_BALANCE.mapgen.goldSingles);
    expect(resourceCounts.get(MAT.FOSSIL)).toBeGreaterThan(PRODUCTION_BALANCE.mapgen.fossilSingles);
    expect(resourceCounts.get(MAT.COPPER)).toBeGreaterThan(PRODUCTION_BALANCE.mapgen.copperSingles);
    expect(resourceCounts.get(MAT.IRON)).toBeGreaterThan(PRODUCTION_BALANCE.mapgen.ironSingles);
    expect(resourceCounts.get(MAT.PLATINUM)).toBeGreaterThan(PRODUCTION_BALANCE.mapgen.platinumSingles);
    expect(resourceCounts.get(MAT.COAL)).toBeGreaterThan(PRODUCTION_BALANCE.mapgen.coalSingles);
    expect(resourceCounts.get(MAT.LAVA)).toBeGreaterThan(100);
    expect(resourceCounts.get(MAT.MOSS)).toBeGreaterThan(100);
    expect(resourceCounts.get(MAT.WATER)).toBeGreaterThan(100);
  }, 20_000);

  it("same seed produces identical map checksum", () => {
    const a = generateMap(12345, BALANCE, 8);
    const b = generateMap(12345, BALANCE, 8);
    expect(a.world.worldChecksum()).toBe(b.world.worldChecksum());
    expect(a.spawns).toEqual(b.spawns);
  });

  it("different seeds produce different maps", () => {
    const a = generateMap(1, BALANCE, 8);
    const b = generateMap(2, BALANCE, 8);
    expect(a.world.worldChecksum()).not.toBe(b.world.worldChecksum());
  });

  it("validates many seeds without exhausting regeneration", () => {
    for (let s = 100; s < 120; s++) {
      const m = generateMap(s, BALANCE, 8);
      expect(m.spawns.length).toBe(8);
      expect(m.chambers.length).toBeGreaterThanOrEqual(BALANCE.mapgen.chambersMin);
    }
  }, 10_000);

  it("spawns are separated by the configured minimum distance", () => {
    const m = generateMap(777, BALANCE, 8);
    const min = BALANCE.mapgen.spawnMinDistCells;
    for (let i = 0; i < m.spawns.length; i++) {
      for (let j = i + 1; j < m.spawns.length; j++) {
        const d = Math.hypot(m.spawns[i].x - m.spawns[j].x, m.spawns[i].y - m.spawns[j].y);
        expect(d).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it("generates open spawn pockets and reinforcement crystal deposits", () => {
    const m = generateMap(24680, BALANCE, 8);
    expect(m.spawns.every((spawn) => m.world.get(spawn.x, spawn.y) === MAT.EMPTY)).toBe(true);
    const radius = BALANCE.mapgen.spawnPocketRadiusCells;
    for (const spawn of m.spawns) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy <= radius * radius) {
            expect(m.world.isSolid(spawn.x + dx, spawn.y + dy)).toBe(false);
          }
        }
      }
    }
    expect([...m.world.mat].filter((mat) => mat === MAT.REINFORCE_GEM).length).toBeGreaterThan(0);
  });

  it("generates varied shaped bedrock formations away from every spawn", () => {
    const m = generateMap(13579, BALANCE, 8);
    let bedrock = 0;
    let nearestSpawn = Infinity;
    for (let y = 1; y < m.world.size - 1; y++) {
      for (let x = 1; x < m.world.size - 1; x++) {
        if (m.world.get(x, y) !== MAT.BEDROCK) continue;
        bedrock++;
        for (const s of m.spawns) nearestSpawn = Math.min(nearestSpawn, Math.hypot(s.x - x, s.y - y));
      }
    }
    expect(bedrock).toBeGreaterThan(50_000);
    expect(nearestSpawn).toBeGreaterThanOrEqual(BALANCE.mapgen.bedrockSpawnClearanceCells);
    expect(m.bedrockFormations).toHaveLength(BALANCE.mapgen.bedrockFormations);
    expect(new Set(m.bedrockFormations.map((f) => f.kind))).toEqual(new Set(["line", "L", "U", "S"]));
  });
});

describe("terrain", () => {
  it("gives bomb arms deterministic, traversable, irregular silhouettes", () => {
    const cfg = PRODUCTION_BALANCE.items.bomb;
    const seed = 1234;
    const cells = new Set<string>();
    for (let y = -cfg.blastRangeCells; y <= cfg.blastRangeCells; y++) {
      for (let x = -cfg.blastRangeCells; x <= cfg.blastRangeCells; x++) {
        if (bombBlastContains(x, y, cfg, seed)) cells.add(`${x}:${y}`);
      }
    }

    // The full centerlines remain open so the result is always usable.
    for (let d = -cfg.blastRangeCells; d <= cfg.blastRangeCells; d++) {
      expect(cells.has(`${d}:0`)).toBe(true);
      expect(cells.has(`0:${d}`)).toBe(true);
    }

    // Arm edges vary by section and extend beyond the old ruler-straight edge.
    const bounds = [-7, -6, 6, 7].map((x) => {
      const ys = Array.from({ length: 13 }, (_, i) => i - 6).filter((y) => cells.has(`${x}:${y}`));
      return `${Math.min(...ys)}:${Math.max(...ys)}`;
    });
    expect(new Set(bounds).size).toBeGreaterThan(1);
    expect([...cells].some((key) => {
      const [x, y] = key.split(":").map(Number);
      return Math.abs(x) >= 5 && Math.abs(y) > cfg.blastHalfWidthCells;
    })).toBe(true);

    // Shape generation is stable, while a new bomb seed produces a new edge.
    const fingerprint = (shapeSeed: number) =>
      Array.from({ length: 17 }, (_, yi) =>
        Array.from({ length: 17 }, (_, xi) => (bombBlastContains(xi - 8, yi - 8, cfg, shapeSeed) ? "1" : "0")).join("")
      ).join("");
    expect(fingerprint(seed)).toBe(fingerprint(seed));
    expect(fingerprint(seed)).not.toBe(fingerprint(seed + 1));
    expect(bombBlastContains(6, 6, cfg, seed)).toBe(false);
    expect(bombBlastContains(6, 6, { ...cfg, blastDiagonal: true }, seed)).toBe(true);
  });

  it("gives weapon families genuinely different directional silhouettes", () => {
    const cfg = { ...PRODUCTION_BALANCE.items.bomb, blastRangeCells: 10, blastHalfWidthCells: 2 };
    const hit = (variant: number, x: number, y: number, seed = 400) =>
      bombBlastPatternContains(x, y, cfg, seed, blastPatternForVariant(variant), 0);

    expect(hit(WEAPON.DYNAMITE, 8, 0)).toBe(true);
    expect(hit(WEAPON.DYNAMITE, 0, 8)).toBe(false);
    expect(hit(weaponKindForBlueprint("shaped-charge"), 8, 2)).toBe(true);
    expect(hit(weaponKindForBlueprint("shaped-charge"), -4, 0)).toBe(false);
    expect(hit(weaponKindForBlueprint("acid-bomb"), 5, 4)).toBe(true);
    expect(hit(weaponKindForBlueprint("acid-bomb"), 8, 0)).toBe(false);
    expect(hit(weaponKindForBlueprint("collapse-charge"), 0, 8)).toBe(true);
    expect(hit(weaponKindForBlueprint("collapse-charge"), 8, 0)).toBe(false);
    expect(hit(weaponKindForBlueprint("proximity-mine"), 0, 0)).toBe(false);
    expect(hit(weaponKindForBlueprint("proximity-mine"), 7, 0)).toBe(true);
    expect(hit(weaponKindForBlueprint("shrapnel-mine"), 6, 6)).toBe(true);
    expect(hit(weaponKindForBlueprint("shrapnel-mine"), 6, 0)).toBe(false);

    const fingerprints = WEAPON_BLUEPRINT_IDS.map((id, index) => {
      const variant = weaponKindForBlueprint(id);
      return Array.from({ length: 21 }, (_, yi) =>
        Array.from({ length: 21 }, (_, xi) => hit(variant, xi - 10, yi - 10, 900 + index) ? "1" : "0").join("")
      ).join("");
    });
    expect(new Set(fingerprints).size).toBeGreaterThanOrEqual(11);
  });

  it("dig brush clears soft rock deterministically and bumps revisions", () => {
    const w = new World(128, 64);
    w.mat.fill(MAT.SOFT);
    const rev0 = w.revisions[0];
    let cleared = 0;
    for (let i = 0; i < 10; i++) {
      const res = applyDigBrush(w, 32.5, 32.5, 2.5, 4, minerDiggable);
      cleared += res.cleared.length;
    }
    expect(cleared).toBeGreaterThan(0);
    expect(w.get(32, 32)).toBe(MAT.EMPTY);
    expect(w.revisions[0]).toBeGreaterThan(rev0);
  });

  it("dig never produces invalid material ids", () => {
    const w = new World(64, 64);
    w.mat.fill(MAT.DENSE);
    for (let i = 0; i < 50; i++) applyDigBrush(w, 20 + (i % 5), 20, 3, 4, minerDiggable);
    for (let i = 0; i < w.mat.length; i++) expect(w.mat[i]).toBeLessThanOrEqual(16);
  });

  it("reports reinforcement crystals separately from common gem rock", () => {
    const w = new World(64, 64);
    w.mat.fill(MAT.DENSE);
    w.setRaw(31, 32, MAT.GEM);
    w.setRaw(32, 32, MAT.REINFORCE_GEM);
    const res = applyDigBrush(w, 32, 32, 2, 255, minerDiggable);
    expect(res.gemCellsCleared).toBe(1);
    expect(res.reinforceGemCellsCleared).toBe(1);
  });

  it("reports every embedded bomb-crafting material separately", () => {
    const w = new World(64, 64);
    w.mat.fill(MAT.DENSE);
    w.setRaw(29, 32, MAT.GOLD);
    w.setRaw(30, 32, MAT.FOSSIL);
    w.setRaw(31, 32, MAT.COPPER);
    w.setRaw(32, 32, MAT.IRON);
    w.setRaw(33, 32, MAT.PLATINUM);
    const res = applyDigBrush(w, 31.5, 32.5, 4, 255, minerDiggable);
    expect(res.goldCellsCleared).toBe(1);
    expect(res.fossilCellsCleared).toBe(1);
    expect(res.copperCellsCleared).toBe(1);
    expect(res.ironCellsCleared).toBe(1);
    expect(res.platinumCellsCleared).toBe(1);
  });

  it("natural bedrock cannot be dug by miners or broken by monsters", () => {
    const w = new World(64, 64);
    w.mat.fill(MAT.EMPTY);
    w.setRaw(32, 32, MAT.BEDROCK);
    for (let i = 0; i < 20; i++) applyDigBrush(w, 32.5, 32.5, 2, 255, minerDiggable);
    expect(w.get(32, 32)).toBe(MAT.BEDROCK);
    expect(minerDiggable(MAT.BEDROCK)).toBe(false);
    expect(monsterBreakable(MAT.BEDROCK)).toBe(false);
  });

  it("chunk RLE round-trips", () => {
    const m = generateMap(42, BALANCE, 8);
    const w = m.world;
    const rle = w.encodeChunkRLE(3, 4);
    const w2 = new World(w.size, w.chunkSize);
    w2.decodeChunkRLE(3, 4, rle, 7);
    expect(w2.chunkChecksum(3, 4)).toBe(w.chunkChecksum(3, 4));
    expect(w2.revisions[4 * w2.chunksPerSide + 3]).toBe(7);
  });
});

describe("oxygen", () => {
  it("sealed regions are not ventilated; vented regions are", () => {
    const w = new World(64, 64);
    w.mat.fill(MAT.DENSE);
    // open room A with vent
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) w.setRaw(x, y, MAT.EMPTY);
    w.setRaw(10, 10, MAT.VENT);
    // sealed room B
    for (let y = 40; y < 45; y++) for (let x = 40; x < 45; x++) w.setRaw(x, y, MAT.EMPTY);
    const vent = computeVentilation(w);
    expect(vent[15 * 64 + 15]).toBe(1);
    expect(vent[42 * 64 + 42]).toBe(0);
  });
});

describe("match", () => {
  const fastBal = withOverrides(BALANCE, {
    match: {
      ...BALANCE.match,
      countdownSeconds: 0,
      phases: [{ kind: "day", seconds: 6 }]
    },
    zombies: { ...BALANCE.zombies, perPlayer: 0, releaseAfterSeconds: 0 }
  } as any);

  it("starts the production rules with no infected players or zombies", () => {
    const sim = new MatchSim(999, BALANCE, roster(8));
    expect(sim.players.every((p) => p.role === ROLE.MINER)).toBe(true);
    expect(sim.zombies).toHaveLength(0);
  });

  it("runs one continuous daylight phase and ends on its survival timer", () => {
    const sim = new MatchSim(5, fastBal, roster(8));
    sim.drainEvents(); // constructor emits the countdown phase
    const kinds: string[] = [];
    for (let i = 0; i < 8 * TICK_HZ && !sim.ended; i++) {
      sim.step();
      for (const ev of sim.drainEvents()) if (ev.type === "phase") kinds.push(ev.kind);
    }
    expect(kinds).toEqual(["day"]);
    expect(sim.ended).toBe(true);
    expect(sim.winner).toBe("miners"); // bots didn't move; nobody was captured
  });

  it("capture converts a miner and infected win when all are converted", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, initialInfected: 1, winCondition: "infection", countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0, releaseAfterSeconds: 0 }
    } as any);
    const sim = new MatchSim(31337, bal, roster(2));
    const infected = sim.players.find((p) => p.role === ROLE.INFECTED)!;
    const miner = sim.players.find((p) => p.role === ROLE.MINER)!;
    // teleport them together in a carved arena
    for (let y = 100; y < 120; y++) for (let x = 100; x < 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    infected.x = cellsToFp(110);
    infected.y = cellsToFp(110);
    miner.x = cellsToFp(112);
    miner.y = cellsToFp(110);
    sim.step(); // enter permanent day and release the outbreak

    // enter hunt stance
    let seq = 1;
    sim.queueInput(infected.id, { seq: seq++, moveX: 0, moveY: 0, aim: 0, buttons: 64, slot: 1 });
    sim.step();
    expect(infected.presentation).toBe(1);

    // attack: press primary (windup), release, wait for resolution + conversion
    sim.queueInput(infected.id, { seq: seq++, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    for (let i = 0; i < 300 && !sim.ended; i++) {
      sim.queueInput(infected.id, { seq: seq++, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 1 });
      sim.step();
    }
    expect(miner.role).toBe(ROLE.INFECTED);
    expect(sim.winner).toBe("infected");
  });

  it("keeps digging available after the zombies are released", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 30 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0, releaseAfterSeconds: 0 }
    } as any);
    const sim = new MatchSim(2222, bal, roster(2));
    const p = sim.players[0];
    for (let y = 96; y <= 104; y++) for (let x = 96; x <= 110; x++) sim.world.setRaw(x, y, MAT.DENSE);
    for (let y = 98; y <= 102; y++) for (let x = 96; x <= 101; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    p.pickDurability = bal.items.pick.durabilityTicks;
    const before = sim.world.worldChecksum();
    for (let i = 1; i < 40; i++) {
      sim.queueInput(p.id, { seq: i, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 2 });
      sim.step();
    }
    expect(sim.zombiesReleased()).toBe(true);
    expect(sim.world.worldChecksum()).not.toBe(before);
  });

  it("crafts slot 2 from common gems and consumes its digging durability", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      items: { ...BALANCE.items, pick: { gemCost: 2, durabilityTicks: 3 } },
      zombies: { ...BALANCE.zombies, perPlayer: 0, releaseAfterSeconds: 120 }
    } as any);
    const sim = new MatchSim(2233, bal, roster(2));
    const p = sim.players[0];
    for (let y = 96; y <= 104; y++) for (let x = 96; x <= 110; x++) sim.world.setRaw(x, y, MAT.DENSE);
    for (let y = 98; y <= 102; y++) for (let x = 96; x <= 101; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    const before = sim.world.worldChecksum();

    p.carriedGems = 1;
    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 2 });
    sim.step();
    expect(sim.zombiesReleased()).toBe(false);
    expect(p.pickDurability).toBe(0);
    expect(p.carriedGems).toBe(1);
    expect(sim.world.worldChecksum()).toBe(before);

    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 2 });
    sim.step();
    p.carriedGems = 2;
    sim.queueInput(p.id, { seq: 3, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 2 });
    sim.step();
    expect(p.carriedGems).toBe(0);
    expect(p.pickDurability).toBe(3);
    expect(sim.world.worldChecksum()).toBe(before);

    for (let seq = 4; seq <= 6; seq++) {
      sim.queueInput(p.id, { seq, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 2 });
      sim.step();
    }
    expect(p.pickDurability).toBe(0);
    expect(sim.world.worldChecksum()).not.toBe(before);
    expect(sim.drainEvents()).toContainEqual({
      type: "log",
      playerId: p.id,
      msg: "Your pick wore out — craft another in slot 2"
    });
  });

  it("crafts a prerequisite-gated bomb tree with stackable speed and range", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0, releaseAfterSeconds: 120 }
    } as any);
    const sim = new MatchSim(2277, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    p.carriedGems = 100;
    p.gold = 100;
    p.fossils = 100;
    p.copper = 100;
    p.iron = 100;
    p.platinum = 100;

    expect(sim.purchaseBombUpgrade(p.id, "wide")).toBe(false);
    expect(sim.purchaseBombUpgrade(p.id, "speed")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "speed")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "range")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "range")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "wide")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "diagonal")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "twin")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "remote")).toBe(true);
    expect(p.bombSpeedLevel).toBe(2);
    expect(p.bombRangeLevel).toBe(2);
    expect(p.bombFeatures).toBe(BOMB_FEATURE.WIDE | BOMB_FEATURE.DIAGONAL | BOMB_FEATURE.TWIN | BOMB_FEATURE.REMOTE);

    for (let y = 96; y <= 110; y++) for (let x = 96; x <= 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    const first = [...sim.entities.values()].find((entity) => entity.kind === ENT.BOMB)!;
    expect(first.cooldownEnd - sim.tick).toBe(66);
    expect(first.blastRange).toBe(12);
    expect(first.blastHalfWidth).toBe(3);
    expect(first.blastFeatures! & BOMB_FEATURE.DIAGONAL).not.toBe(0);

    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 1 });
    sim.step();
    p.x = cellsToFp(115.5);
    sim.queueInput(p.id, { seq: 3, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    expect(sim.ownedBombs(p)).toBe(2);

    sim.queueInput(p.id, { seq: 4, moveX: 0, moveY: 0, aim: 0, buttons: 8, slot: 1 });
    sim.step();
    expect(sim.ownedBombs(p)).toBe(0);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BLAST && entity.blastRange === 12)).toBe(true);
  });

  it("caps every Armory upgrade and outpost recipe at two resource types", () => {
    for (let level = 0; level <= 4; level++) {
      const quotes = bombUpgradeQuotes({
        bombSpeedLevel: level,
        bombRangeLevel: level,
        bombWidthLevel: Math.min(level, 3),
        bombCapacityLevel: Math.min(level, 3),
        bombFeatures: BOMB_FEATURE.WIDE | BOMB_FEATURE.DIAGONAL | BOMB_FEATURE.TWIN | BOMB_FEATURE.REMOTE | BOMB_FEATURE.SHIELD | BOMB_FEATURE.PROSPECTOR,
        visionLevel: level,
        moveSpeedLevel: level,
        healthLevel: level
      }, BALANCE);
      expect(quotes.every((quote) => Object.keys(quote.cost).length <= 2)).toBe(true);
    }
    const specializedCore = bombUpgradeQuotes({
      bombSpeedLevel: 0,
      bombRangeLevel: 0,
      bombWidthLevel: 0,
      bombCapacityLevel: 0,
      bombFeatures: 0,
      visionLevel: 0,
      moveSpeedLevel: 0,
      healthLevel: 0
    }, BALANCE).filter((quote) => ["speed", "range", "vision", "mobility", "vitality"].includes(quote.id));
    expect(specializedCore.every((quote) => quote.cost.common === undefined)).toBe(true);
    expect(BUILDING_DEFS.every((building) => Object.keys(building.cost).length <= 2)).toBe(true);
    expect(WEAPON_TECH.every((tech) => Object.keys(tech.unlockCost).length <= 2 && (!tech.ammoCost || Object.keys(tech.ammoCost).length <= 2))).toBe(true);
    expect(WEAPON_TECH.filter((tech) => tech.unlockCost.common !== undefined).length).toBeLessThan(WEAPON_TECH.length / 3);
    expect(BUILDING_DEFS.every((building) => building.cost.common === undefined)).toBe(true);
  });

  it("unlocks prerequisite-gated weapon blueprints with specialized ore and crafts their payloads", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2388, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    p.carriedGems = 0;
    p.copper = 20;
    p.iron = 20;
    p.gold = p.fossils = p.platinum = p.coal = 20;

    expect(sim.purchaseWeaponTech(p.id, "drill-torpedo")).toBe(false);
    expect(hasWeaponBlueprint(p.weaponBlueprints, "drill-torpedo")).toBe(false);

    expect(sim.purchaseWeaponTech(p.id, "dynamite")).toBe(true);
    expect(hasWeaponBlueprint(p.weaponBlueprints, "dynamite")).toBe(true);
    expect(p.dynamite).toBe(1);
    expect(p.copper).toBe(16);
    expect(p.carriedGems).toBe(0);

    expect(sim.purchaseWeaponTech(p.id, "dynamite")).toBe(true);
    expect(p.dynamite).toBe(2);
    expect(p.copper).toBe(14);

    expect(sim.purchaseWeaponTech(p.id, "drill-torpedo")).toBe(true);
    expect(hasWeaponBlueprint(p.weaponBlueprints, "drill-torpedo")).toBe(true);
    expect(p.copper).toBe(11);
    expect(p.iron).toBe(14);
    expect(sim.purchaseWeaponTech(p.id, "drill-torpedo")).toBe(false);
    expect(p.carriedGems).toBe(0);
  });

  it("equips and places every researched field prototype through its authoritative slot", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2390, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    p.carriedGems = p.gold = p.fossils = p.copper = p.iron = p.platinum = p.coal = 500;
    expect(sim.purchaseWeaponTech(p.id, "dynamite")).toBe(true);
    expect(sim.purchaseWeaponTech(p.id, "drill-torpedo")).toBe(true);
    const tech = weaponTechDefinition("drill-torpedo")!;
    const profile = weaponFieldProfile("drill-torpedo")!;
    for (let y = 90; y <= 120; y++) for (let x = 90; x <= 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(105.5);
    p.y = cellsToFp(105.5);
    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: tech.fieldSlot });
    sim.step();
    const bomb = [...sim.entities.values()].find((entity) => entity.kind === ENT.BOMB && entity.ownerId === p.id)!;
    expect(p.selectedSlot).toBe(tech.fieldSlot);
    expect(bomb.weaponKind).toBe(weaponKindForBlueprint("drill-torpedo"));
    expect(bomb.blastRange).toBe(profile.rangeCells);
    expect(bomb.blastHalfWidth).toBe(profile.halfWidthCells);
  });

  it("stacks shadow sensing, movement speed, and health without capping direct line of sight", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2424, bal, roster(2));
    sim.step();
    const base = sim.players[0];
    const upgraded = sim.players[1];
    upgraded.carriedGems = upgraded.fossils = upgraded.copper = upgraded.iron = upgraded.platinum = 100;

    expect(sim.purchaseBombUpgrade(upgraded.id, "vision")).toBe(true);
    expect(sim.purchaseBombUpgrade(upgraded.id, "mobility")).toBe(true);
    expect(sim.purchaseBombUpgrade(upgraded.id, "vitality")).toBe(true);
    expect([upgraded.visionLevel, upgraded.moveSpeedLevel, upgraded.healthLevel]).toEqual([1, 1, 1]);
    expect(upgraded.health).toBe(bal.combat.baseHealth + bal.playerUpgrades.vitality.healthPerLevel);

    for (let y = 90; y <= 160; y++) for (let x = 80; x <= 230; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    base.x = cellsToFp(100.5);
    base.y = cellsToFp(100.5);
    upgraded.x = cellsToFp(100.5);
    upgraded.y = cellsToFp(120.5);
    const baseStart = base.x;
    const upgradedStart = upgraded.x;
    sim.queueInput(base.id, { seq: 1, moveX: 1, moveY: 0, aim: 0, buttons: 0, slot: 1 });
    sim.queueInput(upgraded.id, { seq: 1, moveX: 1, moveY: 0, aim: 0, buttons: 0, slot: 1 });
    sim.step();
    expect(upgraded.x - upgradedStart).toBeGreaterThan(base.x - baseStart);

    base.x = cellsToFp(100.5);
    base.y = cellsToFp(140.5);
    upgraded.x = cellsToFp(220.5);
    upgraded.y = cellsToFp(140.5);
    expect(sim.resourceSenseRadiusCells(upgraded)).toBeGreaterThan(sim.resourceSenseRadiusCells(base));
    expect(sim.visibleFor(base).players).toContain(upgraded);
    expect(sim.visibleFor(upgraded).players).toContain(base);

    sim.world.setRaw(160, 140, MAT.BEDROCK);
    expect(sim.visibleFor(base).players).not.toContain(upgraded);
    expect(sim.visibleFor(upgraded).players).not.toContain(base);
  });

  it("vitality absorbs one hit per expanding blast and separate blasts stack damage", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 },
      items: { ...BALANCE.items, bomb: { ...BALANCE.items.bomb, fuseTicks: 1, blastRangeCells: 4 } }
    } as any);
    const sim = new MatchSim(2525, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    const rival = sim.players[1];
    p.carriedGems = p.iron = p.platinum = 100;
    expect(sim.purchaseBombUpgrade(p.id, "vitality")).toBe(true);
    for (let y = 90; y <= 140; y++) for (let x = 90; x <= 160; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    rival.x = cellsToFp(150.5);
    rival.y = cellsToFp(130.5);

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 1 });
    for (let i = 0; i < bal.items.bomb.blastRangeCells + 3; i++) sim.step();
    expect(p.eliminated).toBe(false);
    expect(p.health).toBe(50);

    sim.queueInput(p.id, { seq: 3, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    sim.queueInput(p.id, { seq: 4, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 1 });
    sim.step();
    expect(p.eliminated).toBe(true);
    expect(p.health).toBe(0);
  });

  it("dev mode continuously supplies every resource and can buy the complete stacking tree", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2121, bal, [
      { name: "developer", bot: false, devMode: true },
      { name: "target", bot: true }
    ]);
    sim.step();
    const p = sim.players[0];
    expect([p.carriedGems, p.gold, p.fossils, p.copper, p.iron, p.platinum]).toEqual([60000, 60000, 60000, 60000, 60000, 60000]);
    expect([p.dynamite, p.c4, p.clusterBombs, p.napalm, p.nukes, p.turretKits]).toEqual([99, 99, 99, 99, 99, 99]);
    expect(WEAPON_BLUEPRINT_IDS.every((id) => hasWeaponBlueprint(p.weaponBlueprints, id))).toBe(true);

    for (let i = 0; i < 4; i++) expect(sim.purchaseBombUpgrade(p.id, "speed")).toBe(true);
    for (let i = 0; i < 4; i++) expect(sim.purchaseBombUpgrade(p.id, "range")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "wide")).toBe(true);
    for (let i = 0; i < 3; i++) expect(sim.purchaseBombUpgrade(p.id, "width")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "diagonal")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "twin")).toBe(true);
    for (let i = 0; i < 3; i++) expect(sim.purchaseBombUpgrade(p.id, "capacity")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "remote")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "shield")).toBe(true);
    expect(sim.purchaseBombUpgrade(p.id, "prospector")).toBe(true);
    for (let i = 0; i < 4; i++) expect(sim.purchaseBombUpgrade(p.id, "vision")).toBe(true);
    for (let i = 0; i < 4; i++) expect(sim.purchaseBombUpgrade(p.id, "mobility")).toBe(true);
    for (let i = 0; i < 4; i++) expect(sim.purchaseBombUpgrade(p.id, "vitality")).toBe(true);
    expect([p.bombSpeedLevel, p.bombRangeLevel, p.bombWidthLevel, p.bombCapacityLevel, p.bombFeatures]).toEqual([4, 4, 3, 3, 63]);
    expect([p.visionLevel, p.moveSpeedLevel, p.healthLevel, p.health]).toEqual([4, 4, 4, 300]);
    expect(p.carriedGems).toBe(60000);
  });

  it("exposes and authoritatively places every field weapon in a developer match", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2122, bal, [
      { name: "developer", bot: false, devMode: true },
      { name: "target", bot: true }
    ]);
    sim.step();
    const p = sim.players[0];
    p.bombCapacityLevel = 40;
    for (let y = 80; y <= 180; y++) for (let x = 80; x <= 180; x++) sim.world.setRaw(x, y, MAT.EMPTY);

    const fieldWeapons = WEAPON_TECH.filter((tech) => tech.inventory === undefined);
    expect(fieldWeapons.map((tech) => tech.fieldSlot)).toEqual(Array.from({ length: 17 }, (_, index) => index + 10));
    for (const [index, tech] of fieldWeapons.entries()) {
      p.x = cellsToFp(100.5);
      p.y = cellsToFp(90.5 + index * 4);
      sim.queueInput(p.id, { seq: index * 2 + 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: tech.fieldSlot });
      sim.step();
      sim.queueInput(p.id, { seq: index * 2 + 2, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: tech.fieldSlot });
      sim.step();
      expect(
        [...sim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.weaponKind === weaponKindForBlueprint(tech.id)),
        `${tech.label} should deploy from slot ${tech.fieldSlot}`
      ).toBe(true);
    }
  });

  it("gives shaped, acid, and decoy payloads their distinct terrain behavior", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const makeSim = (seed: number) => {
      const sim = new MatchSim(seed, bal, roster(2));
      sim.step();
      sim.players[0]!.x = cellsToFp(70.5);
      sim.players[0]!.y = cellsToFp(70.5);
      sim.players[1]!.x = cellsToFp(75.5);
      sim.players[1]!.y = cellsToFp(75.5);
      for (let y = 66; y <= 78; y++) for (let x = 66; x <= 78; x++) sim.world.setRaw(x, y, MAT.EMPTY);
      return sim;
    };
    const detonate = (sim: MatchSim, blueprint: (typeof WEAPON_BLUEPRINT_IDS)[number], range: number, halfWidth: number) => {
      const bomb = (sim as any).spawnBomb(
        sim.players[0],
        100,
        100,
        weaponKindForBlueprint(blueprint),
        1,
        range,
        halfWidth,
        0,
        true,
        undefined,
        0
      );
      expect(bomb).toBeTruthy();
      for (let i = 0; i <= range + 2; i++) sim.step();
    };

    const shaped = makeSim(2123);
    for (let y = 88; y <= 112; y++) for (let x = 88; x <= 112; x++) shaped.world.setRaw(x, y, MAT.SOFT);
    shaped.world.setRaw(100, 100, MAT.EMPTY);
    detonate(shaped, "shaped-charge", 10, 1);
    expect(shaped.world.get(106, 100)).toBe(MAT.EMPTY);
    expect(shaped.world.get(94, 100)).toBe(MAT.SOFT);

    const acid = makeSim(2124);
    for (let y = 96; y <= 104; y++) for (let x = 96; x <= 110; x++) acid.world.setRaw(x, y, MAT.SOFT);
    acid.world.setRaw(100, 100, MAT.EMPTY);
    for (let x = 101; x <= 105; x++) acid.world.setRaw(x, 100, MAT.REINFORCE);
    acid.world.setRaw(106, 100, MAT.BEDROCK);
    detonate(acid, "acid-bomb", 9, 1);
    expect(acid.world.get(104, 100)).toBe(MAT.EMPTY);
    expect(acid.world.get(106, 100)).toBe(MAT.BEDROCK);

    const decoy = makeSim(2125);
    for (let y = 96; y <= 104; y++) for (let x = 96; x <= 108; x++) decoy.world.setRaw(x, y, MAT.SOFT);
    decoy.world.setRaw(100, 100, MAT.EMPTY);
    const before = decoy.world.get(104, 100);
    detonate(decoy, "decoy-bomb", 6, 1);
    expect(decoy.world.get(104, 100)).toBe(before);
    expect([...decoy.entities.values()].some((entity) => entity.kind === ENT.BLAST && entity.weaponKind === weaponKindForBlueprint("decoy-bomb"))).toBe(true);
  });

  it("spreads gas through tunnels and applies non-destructive control effects", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2126, bal, roster(2));
    sim.step();
    const [owner, victim] = sim.players;
    for (let y = 94; y <= 108; y++) for (let x = 94; x <= 110; x++) sim.world.setRaw(x, y, MAT.SOFT);
    for (let x = 100; x <= 105; x++) sim.world.setRaw(x, 100, MAT.EMPTY);
    for (let y = 100; y <= 104; y++) sim.world.setRaw(105, y, MAT.EMPTY);
    owner.x = cellsToFp(100.5);
    owner.y = cellsToFp(100.5);
    owner.bombFeatures |= BOMB_FEATURE.SHIELD;
    victim.x = cellsToFp(105.5);
    victim.y = cellsToFp(103.5);
    const oxygenBefore = victim.oxygen;
    const bomb = (sim as any).spawnBomb(
      owner,
      100,
      100,
      weaponKindForBlueprint("gas-bomb"),
      1,
      11,
      2,
      owner.bombFeatures,
      true
    );
    expect(bomb).toBeTruthy();
    for (let i = 0; i < 14; i++) sim.step();
    expect(victim.oxygen).toBeLessThan(oxygenBefore - 20);
    expect(victim.health).toBe(80);
    expect([...sim.entities.values()].some((entity) =>
      entity.kind === ENT.FIRE && entity.weaponKind === weaponKindForBlueprint("gas-bomb")
    )).toBe(true);
    const oxygenDuringField = victim.oxygen;
    for (let i = 0; i < 24; i++) sim.step();
    expect(victim.oxygen).toBeLessThan(oxygenDuringField);
    expect(sim.world.get(104, 100)).toBe(MAT.EMPTY);
    expect(sim.world.get(104, 101)).toBe(MAT.SOFT);
  });

  it("keeps acid, cryo, and EMP effects active after their initial wave", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const runField = (blueprint: "acid-bomb" | "cryo-bomb" | "emp-charge") => {
      const sim = new MatchSim(2190 + blueprint.length, bal, roster(2));
      sim.step();
      const [owner, victim] = sim.players;
      for (let y = 90; y <= 110; y++) for (let x = 90; x <= 110; x++) sim.world.setRaw(x, y, MAT.EMPTY);
      owner.x = cellsToFp(100.5);
      owner.y = cellsToFp(100.5);
      owner.bombFeatures |= BOMB_FEATURE.SHIELD;
      victim.x = cellsToFp((blueprint === "emp-charge" ? 107 : 104) + 0.5);
      victim.y = cellsToFp(100.5);
      victim.healthLevel = 2;
      victim.health = sim.playerMaxHealth(victim);
      const bomb = (sim as any).spawnBomb(
        owner, 100, 100, weaponKindForBlueprint(blueprint), 1, 8, 2, owner.bombFeatures, true, undefined, 0
      );
      expect(bomb).toBeTruthy();
      for (let i = 0; i < 14; i++) sim.step();
      return { sim, victim };
    };

    const acid = runField("acid-bomb");
    const acidHealth = acid.victim.health;
    for (let i = 0; i < 24; i++) acid.sim.step();
    expect(acid.victim.health).toBeLessThan(acidHealth);

    const cryo = runField("cryo-bomb");
    expect(cryo.victim.slowedUntilTick).toBeGreaterThan(cryo.sim.tick);

    const emp = runField("emp-charge");
    expect(emp.victim.stamina).toBeLessThan(bal.movement.staminaMax);
    expect([...emp.sim.entities.values()].some((entity) =>
      entity.kind === ENT.FIRE && entity.weaponKind === weaponKindForBlueprint("emp-charge")
    )).toBe(true);
  });

  it("C4 is remotely triggered and cluster bombs split into six timed children", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 },
      bombUpgrades: {
        ...BALANCE.bombUpgrades,
        speed: { ...BALANCE.bombUpgrades.speed, minFuseTicks: 1 }
      },
      specialWeapons: {
        ...BALANCE.specialWeapons,
        cluster: { ...BALANCE.specialWeapons.cluster, fuseTicks: 1, childFuseTicks: 20 }
      }
    } as any);
    const sim = new MatchSim(2221, bal, roster(2));
    const p = sim.players[0];
    for (let y = 90; y <= 130; y++) for (let x = 90; x <= 130; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(110.5);
    p.y = cellsToFp(110.5);
    p.bombFeatures |= BOMB_FEATURE.SHIELD;
    p.c4 = 1;
    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 5 });
    sim.step();
    const c4 = [...sim.entities.values()].find((entity) => entity.kind === ENT.BOMB && entity.weaponKind === WEAPON.C4)!;
    expect(c4.cooldownEnd - sim.tick).toBeGreaterThan(1000);
    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 5 });
    sim.step();
    sim.queueInput(p.id, { seq: 3, moveX: 0, moveY: 0, aim: 0, buttons: 8, slot: 5 });
    sim.step();
    expect(sim.entities.has(c4.id)).toBe(false);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BLAST && entity.weaponKind === WEAPON.C4)).toBe(true);

    while ([...sim.entities.values()].some((entity) => entity.kind === ENT.BLAST)) sim.step();
    p.x = cellsToFp(120.5);
    p.y = cellsToFp(120.5);
    p.clusterBombs = 1;
    sim.queueInput(p.id, { seq: 4, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 6 });
    sim.step();
    sim.queueInput(p.id, { seq: 5, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 6 });
    sim.step();
    const children = [...sim.entities.values()].filter((entity) => entity.kind === ENT.BOMB && entity.weaponKind === WEAPON.CLUSTER_CHILD);
    expect(children).toHaveLength(6);
    expect(children.every((child) => ((child.flags ?? 0) & EFLAG.AIRBORNE) !== 0)).toBe(true);
    expect(children.every((child) => child.x === cellsToFp(120.5) && child.y === cellsToFp(120.5))).toBe(true);
    const launchStart = children[0]!.launchStartTick!;
    const launchEnd = children[0]!.launchEndTick!;
    expect(launchStart - sim.tick).toBe(bal.specialWeapons.cluster.scatterDelayTicks);
    expect(launchEnd - launchStart).toBe(bal.specialWeapons.cluster.childFlightTicks);
    expect(children[0]!.cooldownEnd - launchEnd).toBe(bal.specialWeapons.cluster.childFuseTicks);

    while (sim.tick < launchStart) sim.step();
    expect(children.every((child) => child.x === cellsToFp(120.5) && child.y === cellsToFp(120.5))).toBe(true);
    sim.step();
    expect(children.some((child) => child.x !== cellsToFp(120.5) || child.y !== cellsToFp(120.5))).toBe(true);
    while (sim.tick < launchEnd) sim.step();
    expect(children.every((child) => ((child.flags ?? 0) & EFLAG.AIRBORNE) === 0)).toBe(true);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BLAST && entity.weaponKind === WEAPON.CLUSTER_CHILD)).toBe(false);
    while (sim.tick < children[0]!.cooldownEnd - 1) sim.step();
    expect(children.every((child) => sim.entities.has(child.id))).toBe(true);
    sim.step();
    expect([...sim.entities.values()].filter((entity) => entity.kind === ENT.BLAST && entity.weaponKind === WEAPON.CLUSTER_CHILD)).toHaveLength(6);
  });

  it("napalm leaves lethal fire, nukes gain diagonal reach, and turrets fire at rivals", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 },
      bombUpgrades: {
        ...BALANCE.bombUpgrades,
        speed: { ...BALANCE.bombUpgrades.speed, minFuseTicks: 1 }
      },
      specialWeapons: {
        ...BALANCE.specialWeapons,
        napalm: { ...BALANCE.specialWeapons.napalm, fuseTicks: 1, rangeCells: 4, burnTicks: 20 },
        turret: { ...BALANCE.specialWeapons.turret, fireIntervalTicks: 1, shellFuseTicks: 20 }
      }
    } as any);
    const sim = new MatchSim(2222, bal, roster(2));
    const [p, victim] = sim.players;
    for (let y = 80; y <= 150; y++) for (let x = 80; x <= 150; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    victim.x = cellsToFp(140.5);
    victim.y = cellsToFp(140.5);
    p.bombFeatures |= BOMB_FEATURE.SHIELD;
    p.napalm = 1;
    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 7 });
    sim.step();
    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 7 });
    sim.step();
    for (let i = 0; i < 7; i++) sim.step();
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.FIRE)).toBe(true);
    victim.x = p.x;
    victim.y = p.y;
    sim.step();
    expect(victim.eliminated).toBe(true);
    expect(p.eliminated).toBe(false);

    const nukeSim = new MatchSim(2223, bal, roster(2));
    const nukePlayer = nukeSim.players[0];
    nukePlayer.nukes = 1;
    nukeSim.queueInput(nukePlayer.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 8 });
    nukeSim.step();
    const nuke = [...nukeSim.entities.values()].find((entity) => entity.kind === ENT.BOMB && entity.weaponKind === WEAPON.NUKE)!;
    expect(nuke.blastRange).toBe(bal.specialWeapons.nuke.rangeCells);
    expect(nuke.blastFeatures! & BOMB_FEATURE.DIAGONAL).not.toBe(0);

    const turretSim = new MatchSim(2224, bal, roster(2));
    const [builder, target] = turretSim.players;
    for (let y = 90; y <= 120; y++) for (let x = 90; x <= 140; x++) turretSim.world.setRaw(x, y, MAT.EMPTY);
    builder.x = cellsToFp(100.5);
    builder.y = cellsToFp(100.5);
    target.x = cellsToFp(116.5);
    target.y = cellsToFp(100.5);
    builder.turretKits = 1;
    turretSim.queueInput(builder.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 9 });
    turretSim.step();
    expect([...turretSim.entities.values()].some((entity) => entity.kind === ENT.TURRET)).toBe(true);
    turretSim.queueInput(builder.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 9 });
    turretSim.step();
    expect([...turretSim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.weaponKind === WEAPON.TURRET_SHELL)).toBe(true);
  });

  it("deploys one mining base with a starter miner and builds more miners through interaction", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2230, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    for (let y = 84; y <= 116; y++) for (let x = 86; x <= 130; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = bal.automation.base.commonCost + bal.automation.miner.commonCost * 8;
    p.iron = bal.automation.base.ironCost + bal.automation.miner.ironCost * 8;

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: BASE_TOOL_SLOT });
    sim.step();
    const base = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id)!;
    expect(base).toBeDefined();
    expect(sim.ownedMiningBases(p)).toBe(1);
    expect(sim.ownedAutoMiners(p)).toBe(1);
    expect(base.minerCount).toBe(1);
    expect(p.carriedGems).toBe(bal.automation.miner.commonCost * 8);
    expect(p.iron).toBe(bal.automation.miner.ironCost * 8);

    p.x = base.x;
    p.y = base.y;
    let seq = 2;
    for (let i = 1; i < bal.automation.miner.maxPerBase + 2; i++) {
      sim.queueInput(p.id, { seq: seq++, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 1 });
      sim.step();
      sim.queueInput(p.id, { seq: seq++, moveX: 0, moveY: 0, aim: 0, buttons: 4, slot: 1 });
      sim.step();
    }
    expect(sim.ownedAutoMiners(p)).toBe(bal.automation.miner.maxPerBase);
    expect(base.minerCount).toBe(bal.automation.miner.maxPerBase);

    sim.queueInput(p.id, { seq: seq++, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: BASE_TOOL_SLOT });
    sim.step();
    sim.queueInput(p.id, { seq: seq++, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: BASE_TOOL_SLOT });
    sim.step();
    expect(sim.ownedMiningBases(p)).toBe(1);
  });

  it("builds a fourteen-structure outpost tree and runs a relay-dependent coal power grid", () => {
    expect(BUILDING_DEFS).toHaveLength(14);
    expect(new Set(BUILDING_DEFS.map((building) => building.slot)).size).toBe(14);
    expect(BUILDING_DEFS.every((building) => Object.keys(building.cost).length <= 2)).toBe(true);
    expect(BUILDING_DEFS.some((building) => building.kind === BUILDING.SENTRY_GUN)).toBe(true);
    expect(BUILDING_DEFS.some((building) => building.kind === BUILDING.OXYGEN_RECYCLER)).toBe(true);
    expect(BUILDING_DEFS.some((building) => building.kind === BUILDING.DIGGER_BARRACKS)).toBe(true);
    expect(BUILDING_DEFS.some((building) => building.kind === BUILDING.DEEP_DRILL)).toBe(true);

    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(22301, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    for (let y = 70; y <= 155; y++) for (let x = 70; x <= 170; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = 200;
    p.iron = 100;
    p.copper = 100;
    p.gold = 100;
    p.platinum = 100;
    p.coal = 10;

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: BASE_TOOL_SLOT });
    sim.step();
    const base = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id)!;
    expect(base).toBeDefined();
    expect(p.infrastructureUnlocked).toBe(true);
    // Keep this grid test focused on structure connectivity; the starter
    // miner otherwise occupies the newly enlarged dynamo footprint.
    for (const miner of [...sim.entities.values()].filter((entity) => entity.kind === ENT.AUTO_MINER && entity.ownerId === p.id)) sim.entities.delete(miner.id);
    p.input.buttons = 0;
    p.prevButtons = 0;

    p.x = cellsToFp(115.5);
    p.y = cellsToFp(100.5);
    p.input.aim = 0;
    (sim as any).placeInfrastructureBuilding(p, BUILDING_DEFS[BUILDING.COAL_GENERATOR].slot);
    const generator = [...sim.entities.values()].find((entity) => entity.kind === ENT.BUILDING && entity.buildingKind === BUILDING.COAL_GENERATOR)!;
    expect(generator).toBeDefined();

    for (let tick = 0; tick < 35; tick++) sim.step();
    expect(p.coal).toBe(10 - (BUILDING_DEFS[BUILDING.COAL_GENERATOR].cost.coal ?? 0) - 1);
    expect(p.power).toBe(bal.automation.infrastructure.baseCapacity);
    expect(generator.flags! & BUILDING_FLAG.POWERED).not.toBe(0);

    p.x = cellsToFp(114.5);
    p.y = cellsToFp(101.5);
    p.input.aim = 64;
    (sim as any).placeInfrastructureBuilding(p, BUILDING_DEFS[BUILDING.POWER_RELAY].slot);
    const relay = [...sim.entities.values()].find((entity) => entity.kind === ENT.BUILDING && entity.buildingKind === BUILDING.POWER_RELAY)!;
    expect(relay).toBeDefined();
    for (let tick = 0; tick < 35; tick++) sim.step();
    expect(relay.flags! & BUILDING_FLAG.CONNECTED).not.toBe(0);

    p.x = cellsToFp(114.5);
    p.y = cellsToFp(121.5);
    p.input.aim = 64;
    (sim as any).placeInfrastructureBuilding(p, BUILDING_DEFS[BUILDING.OXYGEN_RECYCLER].slot);
    const scrubber = [...sim.entities.values()].find((entity) => entity.kind === ENT.BUILDING && entity.buildingKind === BUILDING.OXYGEN_RECYCLER)!;
    expect(scrubber).toBeDefined();
    for (let tick = 0; tick < 35; tick++) sim.step();
    expect(scrubber.flags! & BUILDING_FLAG.POWERED).not.toBe(0);
    expect(sim.isVentilatedCell(Math.floor(scrubber.x / FP), Math.floor(scrubber.y / FP))).toBe(true);

    sim.entities.delete(relay.id);
    sim.step();
    expect(scrubber.flags! & BUILDING_FLAG.CONNECTED).toBe(0);
    expect(scrubber.flags! & BUILDING_FLAG.POWERED).toBe(0);
  });

  it("runs an observable mining colony with barracks crews, deep drilling, carts, and forge stacks", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(223011, bal, roster(2));
    sim.step();
    const [owner, rival] = sim.players;
    for (let y = 55; y <= 145; y++) for (let x = 55; x <= 145; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    owner.x = cellsToFp(100.5);
    owner.y = cellsToFp(100.5);
    rival.x = cellsToFp(80.5);
    rival.y = cellsToFp(100.5);
    owner.devMode = true;
    owner.carriedGems = 100;
    owner.iron = 100;
    owner.coal = 100;
    owner.infrastructureUnlocked = true;

    const base = { id: 9200, kind: ENT.MINING_BASE, x: owner.x, y: owner.y, ownerId: owner.id, cooldownEnd: 0, health: 600, maxHealth: 600, minerCount: 0 };
    sim.entities.set(base.id, base);
    const addBuilding = (id: number, kind: number, x: number, y: number) => {
      const definition = BUILDING_DEFS[kind];
      const entity = {
        id, kind: ENT.BUILDING, buildingKind: kind, x: cellsToFp(x + 0.5), y: cellsToFp(y + 0.5), ownerId: owner.id,
        cooldownEnd: 0, health: definition.health, maxHealth: definition.health, flags: 0
      };
      sim.entities.set(id, entity);
      return entity;
    };
    addBuilding(9201, BUILDING.COAL_GENERATOR, 100, 75);
    const barracks = addBuilding(9202, BUILDING.DIGGER_BARRACKS, 74, 100);
    const drill = addBuilding(9203, BUILDING.DEEP_DRILL, 126, 100);
    const depot = addBuilding(9204, BUILDING.TRACK_DEPOT, 100, 126);
    const forge = addBuilding(9205, BUILDING.DRILL_FORGE, 118, 118);
    sim.world.setRaw(134, 100, MAT.COAL);

    sim.tick = 29;
    for (let tick = 0; tick < 8; tick++) sim.step();

    const diggers = [...sim.entities.values()].filter((entity) => entity.kind === ENT.AUTO_MINER && entity.baseId === barracks.id);
    const hunters = [...sim.entities.values()].filter((entity) => entity.kind === ENT.HUNTER && entity.baseId === barracks.id);
    const carts = [...sim.entities.values()].filter((entity) => entity.kind === ENT.ORE_CART && entity.baseId === depot.id);
    expect(diggers).toHaveLength(1);
    expect(hunters).toHaveLength(1);
    expect(carts).toHaveLength(1);
    expect(Math.hypot(carts[0].x - depot.x, carts[0].y - depot.y)).toBeGreaterThan(0);
    expect(sim.world.get(134, 100)).toBe(MAT.EMPTY);
    expect(owner.coal).toBeGreaterThanOrEqual(101);
    expect(drill.flags! & BUILDING_FLAG.ACTIVE).not.toBe(0);
    expect(forge.flags! & BUILDING_FLAG.ACTIVE).not.toBe(0);
    expect(hunters[0].targetId).toBe(rival.id);
  });

  it("powers defenses, repairs structures, shields miners, and refines autonomous ore", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(22302, bal, roster(2));
    sim.step();
    const [owner, rival] = sim.players;
    for (let y = 75; y <= 130; y++) for (let x = 75; x <= 140; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    owner.x = cellsToFp(100.5);
    owner.y = cellsToFp(100.5);
    rival.x = cellsToFp(112.5);
    rival.y = cellsToFp(100.5);
    owner.power = 150;
    owner.coal = 4;
    owner.infrastructureUnlocked = true;

    const base = { id: 9000, kind: ENT.MINING_BASE, x: owner.x, y: owner.y, ownerId: owner.id, cooldownEnd: 0, health: 100, maxHealth: 100, minerCount: 0 };
    sim.entities.set(base.id, base);
    const addBuilding = (id: number, kind: number, x: number, y: number, health?: number) => {
      const definition = BUILDING_DEFS[kind];
      const entity = {
        id,
        kind: ENT.BUILDING,
        buildingKind: kind,
        x: cellsToFp(x + 0.5),
        y: cellsToFp(y + 0.5),
        ownerId: owner.id,
        cooldownEnd: 0,
        health: health ?? definition.health,
        maxHealth: definition.health,
        flags: 0
      };
      sim.entities.set(id, entity);
      return entity;
    };
    const generator = addBuilding(9001, BUILDING.COAL_GENERATOR, 92, 92, 50);
    addBuilding(9002, BUILDING.BATTERY_BANK, 108, 92);
    addBuilding(9003, BUILDING.SENTRY_GUN, 100, 106);
    addBuilding(9004, BUILDING.ARC_COIL, 106, 104);
    addBuilding(9005, BUILDING.SHIELD_PYLON, 96, 104);
    addBuilding(9006, BUILDING.REPAIR_DEPOT, 91, 101);
    addBuilding(9007, BUILDING.ORE_REFINERY, 106, 109);

    sim.tick = 29;
    sim.step();
    expect(rival.health).toBe(bal.combat.baseHealth - bal.automation.infrastructure.arcDamage);
    expect(rival.stunUntilTick).toBeGreaterThan(sim.tick);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.weaponKind === WEAPON.TURRET_SHELL)).toBe(true);
    expect(generator.health).toBe(82);

    owner.iron = 0;
    (sim as any).awardMinedMaterial(owner, MAT.IRON, 2, true);
    expect(owner.iron).toBe(3);

    owner.health = bal.combat.baseHealth;
    (sim as any).spawnBomb(rival, Math.floor(owner.x / FP), Math.floor(owner.y / FP), WEAPON.STANDARD, 1, 1, 1, 0, true);
    sim.step();
    sim.step();
    expect(owner.health).toBe(bal.combat.baseHealth - Math.round(bal.combat.bombDamage * bal.automation.infrastructure.shieldDamageMultiplier));
    expect(owner.eliminated).toBe(false);
  });

  it("has bots reserve resources and deploy the first powered outpost building", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(22303, bal, roster(2));
    sim.step();
    const [bot, rival] = sim.players;
    bot.x = cellsToFp(100.5);
    bot.y = cellsToFp(100.5);
    rival.x = cellsToFp(240.5);
    rival.y = cellsToFp(240.5);
    for (let y = 75; y <= 125; y++) for (let x = 75; x <= 125; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    const base = { id: 9100, kind: ENT.MINING_BASE, x: bot.x, y: bot.y, ownerId: bot.id, cooldownEnd: 0, health: 100, maxHealth: 100, minerCount: 0 };
    sim.entities.set(base.id, base);
    bot.infrastructureUnlocked = true;
    bot.pickDurability = bal.items.pick.durabilityTicks;
    const generator = BUILDING_DEFS[BUILDING.COAL_GENERATOR];
    bot.carriedGems = generator.cost.common ?? 0;
    bot.iron = generator.cost.iron ?? 0;
    bot.copper = generator.cost.copper ?? 0;
    bot.coal = 5;

    const bots = new BotController(22303);
    for (let tick = 0; tick < 20; tick++) {
      bots.stepBots(sim);
      sim.step();
    }
    expect([...sim.entities.values()].some((entity) =>
      entity.kind === ENT.BUILDING && entity.ownerId === bot.id && entity.buildingKind === BUILDING.COAL_GENERATOR
    )).toBe(true);
  });

  it("treats a mining base as solid and chains a destructive core explosion when bombed", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2232, bal, roster(2));
    sim.step();
    const [builder, rival] = sim.players;
    for (let y = 75; y <= 145; y++) for (let x = 75; x <= 150; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    builder.x = cellsToFp(100.5);
    builder.y = cellsToFp(100.5);
    rival.x = cellsToFp(145.5);
    rival.y = cellsToFp(140.5);
    builder.carriedGems = bal.automation.base.commonCost;
    builder.iron = bal.automation.base.ironCost;
    sim.queueInput(builder.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: BASE_TOOL_SLOT });
    sim.step();
    const base = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === builder.id)!;
    expect(base).toBeDefined();

    builder.x = base.x - cellsToFp(10);
    builder.y = base.y;
    for (let seq = 2; seq < 24; seq++) {
      sim.queueInput(builder.id, { seq, moveX: 1, moveY: 0, aim: 0, buttons: 0, slot: 1 });
      sim.step();
    }
    const minimumDistance = cellsToFp(bal.automation.base.collisionRadiusCells + bal.movement.playerRadiusCells);
    expect(Math.hypot(builder.x - base.x, builder.y - base.y)).toBeGreaterThanOrEqual(minimumDistance - FP / 4);

    builder.x = cellsToFp(80.5);
    builder.y = cellsToFp(80.5);
    const baseCellX = Math.floor(base.x / FP);
    const baseCellY = Math.floor(base.y / FP);
    sim.world.setRaw(baseCellX, baseCellY + 6, MAT.SOFT);
    const trigger = (sim as any).spawnBomb(
      builder,
      baseCellX - 6,
      baseCellY,
      WEAPON.STANDARD,
      1,
      8,
      1,
      0,
      true
    );
    expect(trigger).toBeTruthy();
    for (let i = 0; i < 16; i++) sim.step();

    expect(sim.entities.has(base.id)).toBe(false);
    expect(sim.ownedAutoMiners(builder)).toBe(0);
    expect(sim.world.get(baseCellX, baseCellY + 6)).toBe(MAT.EMPTY);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BLAST && entity.weaponKind === WEAPON.BASE_CORE)).toBe(true);
  });

  it("auto-miners tunnel through nearby rock and deliver exposed resources to their owner", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      automation: {
        ...BALANCE.automation,
        miner: { ...BALANCE.automation.miner, speed: 128, digDamage: 50, digIntervalTicks: 1, retargetTicks: 1, workRadiusCells: 20 }
      },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2231, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    for (let y = 78; y <= 122; y++) for (let x = 85; x <= 132; x++) sim.world.setRaw(x, y, MAT.DENSE);
    for (let y = 86; y <= 114; y++) for (let x = 92; x <= 127; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    sim.world.setRaw(128, 100, MAT.GEM);
    for (const [id, entity] of sim.entities) {
      if ((entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) &&
        (entity.x / FP - 110.5) ** 2 + (entity.y / FP - 100.5) ** 2 < 40 ** 2) sim.entities.delete(id);
    }
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = bal.automation.base.commonCost;
    p.iron = bal.automation.base.ironCost;

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: BASE_TOOL_SLOT });
    sim.step();
    expect(sim.ownedAutoMiners(p)).toBe(1);
    const gemsAfterDeployment = p.carriedGems;
    expect(gemsAfterDeployment).toBeGreaterThan(0);
    for (let i = 0; i < 180 && sim.world.get(128, 100) !== MAT.EMPTY; i++) sim.step();
    expect(sim.world.get(128, 100)).toBe(MAT.EMPTY);
    expect(p.carriedGems).toBeGreaterThanOrEqual(gemsAfterDeployment);
    expect(p.stats.cellsDug).toBeGreaterThan(0);
  });

  it("auto-miners advance beyond the base-centered work radius after clearing the first pocket", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      automation: {
        ...BALANCE.automation,
        miner: { ...BALANCE.automation.miner, speed: 128, digDamage: 50, digIntervalTicks: 1, retargetTicks: 1, workRadiusCells: 10 }
      },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2232, bal, roster(2));
    sim.step();
    const p = sim.players[0];
    for (let y = 82; y <= 118; y++) for (let x = 82; x <= 146; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    p.x = cellsToFp(100.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = bal.automation.base.commonCost;
    p.iron = bal.automation.base.ironCost;

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: BASE_TOOL_SLOT });
    sim.step();
    const base = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === p.id)!;
    const farRockX = Math.floor(base.x / FP) + 19;
    const farRockY = Math.floor(base.y / FP);
    sim.world.setRaw(farRockX, farRockY, MAT.DENSE);
    expect(Math.hypot(farRockX + 0.5 - base.x / FP, farRockY + 0.5 - base.y / FP)).toBeGreaterThan(bal.automation.miner.workRadiusCells);

    for (let tick = 0; tick < 120 && sim.world.get(farRockX, farRockY) !== MAT.EMPTY; tick++) sim.step();
    expect(sim.world.get(farRockX, farRockY)).toBe(MAT.EMPTY);
  });

  it("spawns persistent landmark sites, unguarded relic caches, and sparse tunnel creatures", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(606060, bal, [{ name: "relic hunter", bot: false }, { name: "observer", bot: false }]);
    const landmarks = [...sim.entities.values()].filter((entity) => entity.kind === ENT.LANDMARK);
    const specialCaches = [...sim.entities.values()].filter((entity) => entity.kind === ENT.CHEST && (entity.weaponKind ?? 0) !== CHEST_VARIANT.RUIN);
    const ambient = [...sim.entities.values()].filter((entity) => entity.kind === ENT.GUARDIAN && entity.ownerId < 0);
    expect(landmarks).toHaveLength(sim.map.specialSites.length);
    expect(landmarks.some((entity) => entity.weaponKind === LANDMARK.VOLCANO)).toBe(true);
    expect(specialCaches).toHaveLength(sim.map.specialSites.length);
    expect(specialCaches.every((entity) => (entity.flags! & CHEST_FLAG.SEALED) === 0)).toBe(true);
    expect(ambient).toHaveLength(bal.mapgen.ambientEnemies);
    expect(ambient.some((entity) => entity.weaponKind === GUARDIAN_VARIANT.TUNNEL_CRAWLER || entity.weaponKind === GUARDIAN_VARIANT.BONE_WRAITH)).toBe(true);

    const hunter = sim.players[0];
    for (const site of sim.map.specialSites.filter((entry, index, all) => all.findIndex((candidate) => candidate.kind === entry.kind) === index)) {
      hunter.x = cellsToFp(site.cacheX + 0.5);
      hunter.y = cellsToFp(site.cacheY + 0.5);
      sim.step();
    }
    expect(hunter.relics & (RELIC.ECHO_CORE | RELIC.GEODE_HEART | RELIC.PHOENIX_CASING | RELIC.DEAD_MINERS_SWITCH)).toBe(
      RELIC.ECHO_CORE | RELIC.GEODE_HEART | RELIC.PHOENIX_CASING | RELIC.DEAD_MINERS_SWITCH
    );
  });

  it("keeps ruin treasure sealed until its guardians fall, then collects it on contact", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 },
      treasure: { ...BALANCE.treasure, guardianSpeed: 0, guardianAttackRangeCells: 0.1 },
      items: { ...BALANCE.items, bomb: { ...BALANCE.items.bomb, fuseTicks: 1, blastRangeCells: 8 } }
    } as any);
    const sim = new MatchSim(2225, bal, roster(2));
    const p = sim.players[0];
    const ruin = sim.map.ruins[0];
    const chest = [...sim.entities.values()].find((entity) => entity.kind === ENT.CHEST && Math.floor(entity.x / FP) === ruin.chestX)!;
    const guards = [...sim.entities.values()].filter((entity) => entity.kind === ENT.GUARDIAN && entity.ownerId === chest.id);
    p.x = chest.x;
    p.y = chest.y;
    p.bombFeatures |= BOMB_FEATURE.SHIELD;
    guards.forEach((guard, index) => {
      guard.x = chest.x + cellsToFp(index === 0 ? 4 : -4);
      guard.y = chest.y;
    });

    expect(chest.flags! & CHEST_FLAG.SEALED).toBe(CHEST_FLAG.SEALED);
    // No interaction input: crossing a guarded chest leaves it sealed without
    // repeatedly spamming a contextual warning.
    sim.step();
    expect(sim.entities.has(chest.id)).toBe(true);
    expect(sim.drainEvents().some((event) => event.type === "log" && event.msg.includes("sealed"))).toBe(false);

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    for (let i = 0; i < 12 && [...sim.entities.values()].some((entity) => entity.kind === ENT.GUARDIAN && entity.ownerId === chest.id); i++) sim.step();
    expect([...sim.entities.values()].filter((entity) => entity.kind === ENT.GUARDIAN && entity.ownerId === chest.id)).toHaveLength(0);
    expect(sim.entities.get(chest.id)?.flags! & CHEST_FLAG.SEALED).toBe(0);
    // The next tick collects the unsealed chest simply because the player is
    // standing over it; BTN.INTERACT is never sent.
    sim.step();
    expect(sim.entities.has(chest.id)).toBe(false);
    expect(p.dynamite + p.c4 + p.clusterBombs + p.napalm + p.nukes + p.turretKits).toBe(1);
  });

  it("slot 1 places a timed bomb whose cross blast destroys rock and kills any player", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      items: {
        ...BALANCE.items,
        bomb: {
          ...BALANCE.items.bomb,
          fuseTicks: 3,
          blastRangeCells: 8,
          blastHalfWidthCells: 2,
          blastStepTicks: 1,
          maxActivePerPlayer: 1
        }
      },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(2323, bal, roster(3));
    sim.step();
    const [placer, victim, safe] = sim.players;
    for (let y = 90; y <= 110; y++) for (let x = 90; x <= 125; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    placer.x = cellsToFp(100.5);
    placer.y = cellsToFp(100.5);
    victim.x = cellsToFp(108.5);
    victim.y = cellsToFp(100.5);
    safe.x = cellsToFp(120.5);
    safe.y = cellsToFp(105.5);
    sim.world.setRaw(100, 105, MAT.SOFT);
    sim.world.setRaw(103, 100, MAT.PLATINUM);
    sim.world.setRaw(104, 100, MAT.IRON);
    sim.world.setRaw(105, 100, MAT.FOSSIL);
    sim.world.setRaw(106, 100, MAT.COPPER);
    sim.world.setRaw(107, 100, MAT.GOLD);
    sim.world.setRaw(108, 100, MAT.GEM);
    sim.world.setRaw(102, 102, MAT.SOFT);
    sim.world.setRaw(106, 106, MAT.SOFT);
    sim.world.setRaw(100, 97, MAT.REINFORCE);
    sim.world.setRaw(100, 96, MAT.SOFT);

    sim.queueInput(placer.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    const bomb = [...sim.entities.values()].find((entity) => entity.kind === ENT.BOMB)!;
    expect(bomb.x).toBe(cellsToFp(100.5));
    expect(bomb.y).toBe(cellsToFp(100.5));
    expect(bomb.cooldownEnd).toBe(sim.tick + 3);
    expect(sim.ownedBombs(placer)).toBe(1);

    sim.queueInput(placer.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 1 });
    sim.step();
    expect(sim.ownedBombs(placer)).toBe(1);
    sim.step();
    expect(sim.entities.has(bomb.id)).toBe(true);
    sim.step();

    expect(sim.entities.has(bomb.id)).toBe(false);
    expect(placer.eliminated).toBe(true);
    expect(victim.eliminated).toBe(false);
    expect(safe.eliminated).toBe(false);
    expect(sim.world.get(100, 105)).toBe(MAT.SOFT);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BLAST && entity.x === cellsToFp(100.5) && entity.y === cellsToFp(100.5))).toBe(true);

    for (let i = 0; i < 8; i++) sim.step();

    expect(victim.eliminated).toBe(true);
    expect(sim.world.get(100, 105)).toBe(MAT.EMPTY);
    expect(sim.world.get(108, 100)).toBe(MAT.EMPTY);
    expect(placer.carriedGems).toBeGreaterThan(0);
    expect(placer.gold).toBe(1);
    expect(placer.fossils).toBe(1);
    expect(placer.copper).toBe(1);
    expect(placer.iron).toBe(1);
    expect(placer.platinum).toBe(1);
    expect(sim.world.get(102, 102)).toBe(MAT.EMPTY);
    expect(sim.world.get(106, 106)).toBe(MAT.SOFT);
    expect(sim.world.get(100, 97)).toBe(MAT.REINFORCE);
    expect(sim.world.get(100, 96)).toBe(MAT.SOFT);
    const events = sim.drainEvents();
    expect(events).toContainEqual({
      type: "log",
      playerId: placer.id,
      msg: "You were killed by your own bomb"
    });
    expect(events).toContainEqual({
      type: "feed",
      kind: "down",
      msg: "p0 was eliminated by their own bomb"
    });
  });

  it("uses the crystal unlock and charges common gems per built wall cell", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, initialInfected: 1, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0, releaseAfterSeconds: 0 }
    } as any);
    const sim = new MatchSim(1515, bal, roster(2));
    const p = sim.players.find((q) => q.role === ROLE.MINER)!;
    sim.step();
    expect(sim.zombiesReleased()).toBe(true);
    for (let y = 90; y <= 110; y++) {
      for (let x = 90; x <= 125; x++) sim.world.setRaw(x, y, MAT.DENSE);
    }
    for (let y = 94; y <= 106; y++) {
      for (let x = 95; x <= 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    sim.world.setRaw(95, 100, MAT.VENT);
    p.x = cellsToFp(108.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = 10;
    p.reinforceGems = 2;
    p.wallUnlocked = true;

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 3 });
    sim.step();
    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 3 });
    sim.step();

    for (let y = 98; y <= 102; y++) expect(sim.world.get(115, y)).toBe(MAT.REINFORCE);
    expect(p.carriedGems).toBe(10 - 5 * bal.construction.rigidWall.gemCostPerCell);
    expect(p.reinforceGems).toBe(2); // blue crystals unlock; common gems pay per built cell
  });

  it("collecting a reinforcement crystal unlocks the wall builder", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(1555, bal, roster(2));
    const p = sim.players.find((q) => q.role === ROLE.MINER)!;
    sim.entities.set(60_000, {
      id: 60_000,
      kind: ENT.REINFORCE_GEM,
      x: p.x,
      y: p.y,
      ownerId: -1,
      cooldownEnd: 0
    });

    sim.step();

    expect(p.wallUnlocked).toBe(true);
    expect(p.reinforceGems).toBe(1);
    expect(sim.entities.has(60_000)).toBe(false);
  });

  it("awards exactly one common gem for one loose gem pickup", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(1556, bal, roster(2));
    const p = sim.players[0];
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) sim.entities.delete(id);
    }
    p.carriedGems = 0;
    sim.entities.set(60_001, {
      id: 60_001,
      kind: ENT.GEM,
      x: p.x,
      y: p.y,
      ownerId: -1,
      cooldownEnd: 0
    });

    sim.step();

    expect(p.carriedGems).toBe(1);
    expect(sim.entities.has(60_001)).toBe(false);
  });

  it("builds only the oxygen-safe portion of a wall", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, initialInfected: 1, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(1616, bal, roster(2));
    const p = sim.players.find((q) => q.role === ROLE.MINER)!;
    const infected = sim.players.find((q) => q.role === ROLE.INFECTED)!;
    sim.step();
    for (let y = 90; y <= 110; y++) {
      for (let x = 90; x <= 125; x++) sim.world.setRaw(x, y, MAT.DENSE);
    }
    for (let y = 98; y <= 102; y++) {
      for (let x = 95; x <= 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    sim.world.setRaw(120, 100, MAT.VENT);
    p.x = cellsToFp(104.5);
    p.y = cellsToFp(100.5);
    infected.x = cellsToFp(97.5);
    infected.y = cellsToFp(100.5);
    p.carriedGems = 10;
    p.reinforceGems = 2;
    p.wallUnlocked = true;
    sim.drainEvents();

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 0, slot: 3 });
    sim.step();
    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 3 });
    sim.step();

    for (let y = 98; y <= 101; y++) expect(sim.world.get(111, y)).toBe(MAT.REINFORCE);
    expect(sim.world.get(111, 102)).toBe(MAT.EMPTY);
    expect(p.carriedGems).toBe(6);
    expect(p.reinforceGems).toBe(2);
    expect(sim.drainEvents()).toContainEqual({
      type: "log",
      playerId: p.id,
      msg: "Built 4/5 safe wall cells; oxygen route preserved"
    });
  });

  it("builds and charges only empty cells when part of the preview touches rock", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(1666, bal, roster(2));
    const p = sim.players.find((q) => q.role === ROLE.MINER)!;
    sim.step();
    for (let y = 90; y <= 110; y++) {
      for (let x = 90; x <= 125; x++) sim.world.setRaw(x, y, MAT.DENSE);
    }
    for (let y = 94; y <= 106; y++) {
      for (let x = 95; x <= 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    sim.world.setRaw(95, 100, MAT.VENT);
    sim.world.setRaw(115, 99, MAT.DENSE);
    sim.world.setRaw(115, 102, MAT.DENSE);
    p.x = cellsToFp(108.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = 10;
    p.wallUnlocked = true;

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 3 });
    sim.step();

    expect(sim.world.get(115, 100)).toBe(MAT.REINFORCE);
    expect(sim.world.get(115, 101)).toBe(MAT.REINFORCE);
    expect(sim.world.get(115, 98)).toBe(MAT.REINFORCE);
    expect(sim.world.get(115, 99)).toBe(MAT.DENSE);
    expect(sim.world.get(115, 102)).toBe(MAT.DENSE);
    expect(p.carriedGems).toBe(7);
  });

  it("continues extending a wall while primary is held and the player moves", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      construction: {
        ...BALANCE.construction,
        rigidWall: { ...BALANCE.construction.rigidWall, buildIntervalTicks: 1 }
      },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(1677, bal, roster(2));
    const p = sim.players.find((q) => q.role === ROLE.MINER)!;
    sim.step();
    for (let y = 90; y <= 115; y++) {
      for (let x = 90; x <= 125; x++) sim.world.setRaw(x, y, MAT.DENSE);
    }
    for (let y = 94; y <= 110; y++) {
      for (let x = 95; x <= 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    sim.world.setRaw(95, 100, MAT.VENT);
    p.x = cellsToFp(108.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = 20;
    p.wallUnlocked = true;

    sim.queueInput(p.id, { seq: 1, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 3 });
    sim.step();
    p.y = cellsToFp(103.5);
    sim.queueInput(p.id, { seq: 2, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 3 });
    sim.step();

    for (let y = 98; y <= 105; y++) expect(sim.world.get(115, y)).toBe(MAT.REINFORCE);
    expect(p.carriedGems).toBe(12);
  });

  it("keeps the wall target anchored after building while the player stays still", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      construction: {
        ...BALANCE.construction,
        rigidWall: { ...BALANCE.construction.rigidWall, buildIntervalTicks: 1 }
      },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(1688, bal, roster(2));
    // This test teleports into an arbitrary fixed coordinate. Remove the new
    // world encounters so it remains an isolated wall-placement assertion.
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GUARDIAN || entity.kind === ENT.CHEST || entity.kind === ENT.LANDMARK) sim.entities.delete(id);
    }
    const p = sim.players.find((q) => q.role === ROLE.MINER)!;
    sim.step();
    for (let y = 90; y <= 110; y++) {
      for (let x = 90; x <= 125; x++) sim.world.setRaw(x, y, MAT.DENSE);
    }
    for (let y = 94; y <= 106; y++) {
      for (let x = 95; x <= 120; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    sim.world.setRaw(95, 100, MAT.VENT);
    p.x = cellsToFp(108.5);
    p.y = cellsToFp(100.5);
    p.carriedGems = 20;
    p.wallUnlocked = true;

    for (let seq = 1; seq <= 5; seq++) {
      sim.queueInput(p.id, { seq, moveX: 0, moveY: 0, aim: 0, buttons: 1, slot: 3 });
      sim.step();
    }
    for (let y = 98; y <= 102; y++) {
      expect(sim.world.get(115, y)).toBe(MAT.REINFORCE);
      expect(sim.world.get(114, y)).toBe(MAT.EMPTY);
    }
    expect(p.carriedGems).toBe(15);
  });

  it("does not spawn legacy zombies in the production rules", () => {
    const sim = new MatchSim(1616, BALANCE, roster(8));
    expect(sim.zombies).toHaveLength(0);
  });

  it("keeps spawn-point zombies dormant for two minutes, then releases them", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, initialInfected: 1, winCondition: "infection", countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 1, releaseAfterSeconds: 2, attackRangeCells: 0.25, aggroRadiusCells: 80 }
    } as any);
    const sim = new MatchSim(1717, bal, roster(2));
    const miner = sim.players.find((q) => q.role === ROLE.MINER)!;
    const infected = sim.players.find((q) => q.role === ROLE.INFECTED)!;
    const z = sim.zombies[miner.id];
    const spawnX = z.x;
    const spawnY = z.y;
    const sx = Math.floor(spawnX / FP);
    const sy = Math.floor(spawnY / FP);
    for (let y = sy - 20; y <= sy + 20; y++) {
      for (let x = sx - 20; x <= sx + 20; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    miner.x = spawnX + cellsToFp(16);
    miner.y = spawnY;
    infected.x = spawnX - cellsToFp(40);
    infected.y = spawnY;
    const start = Math.hypot(miner.x - z.x, miner.y - z.y);

    sim.step(); // enter day; release is now exactly two minutes away
    sim.drainEvents();
    const startX = z.x;
    const startY = z.y;
    for (let i = 0; i < 2 * TICK_HZ - 1; i++) sim.step();

    expect(sim.zombiesReleased()).toBe(false);
    expect(z.targetId).toBe(-1);
    expect(z.x).toBe(startX);
    expect(z.y).toBe(startY);

    sim.step();

    expect(sim.zombiesReleased()).toBe(true);
    expect(z.targetId).toBe(miner.id);
    expect(z.x).toBeGreaterThan(spawnX);
    expect(z.y).toBe(spawnY);
    expect(Math.hypot(miner.x - z.x, miner.y - z.y)).toBeLessThan(start);
    expect(sim.drainEvents()).toContainEqual({
      type: "log",
      playerId: null,
      msg: "Zombies have awakened at every starting point"
    });
  });

  it("a spawn-point zombie starts the normal conversion timer when it catches a miner", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, initialInfected: 1, winCondition: "infection", countdownSeconds: 0, phases: [{ kind: "day", seconds: 60 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 1, releaseAfterSeconds: 0, aggroRadiusCells: 80 }
    } as any);
    const sim = new MatchSim(1818, bal, roster(2));
    const miner = sim.players.find((q) => q.role === ROLE.MINER)!;
    const infected = sim.players.find((q) => q.role === ROLE.INFECTED)!;
    const z = sim.zombies[miner.id];
    const zx = Math.floor(z.x / FP);
    const zy = Math.floor(z.y / FP);
    for (let y = zy - 6; y <= zy + 6; y++) {
      for (let x = zx - 6; x <= zx + 6; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    miner.x = z.x + cellsToFp(2);
    miner.y = z.y;
    infected.x = z.x - cellsToFp(20);
    infected.y = z.y;

    sim.step();

    expect(miner.convertingUntilTick).toBeGreaterThan(sim.tick);
    expect(z.targetId).toBe(-1);
  });

  it("bots run a full match without errors", () => {
    const bal = withOverrides(BALANCE, {
      match: {
        ...BALANCE.match,
        countdownSeconds: 0,
        phases: [{ kind: "day", seconds: 11 }]
      },
      zombies: { ...BALANCE.zombies, releaseAfterSeconds: 2 }
    } as any);
    const sim = new MatchSim(444, bal, roster(8));
    const bots = new BotController(444);
    for (let i = 0; i < 12 * TICK_HZ && !sim.ended; i++) {
      bots.stepBots(sim);
      sim.step();
      sim.drainEvents();
    }
    expect(sim.ended).toBe(true);
  });

  it("bots reserve an affordable automation kit and deploy a mining base", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(443, bal, roster(2));
    const bot = sim.players[0];
    sim.step();
    for (let y = 84; y <= 116; y++) for (let x = 86; x <= 130; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    bot.x = cellsToFp(100.5);
    bot.y = cellsToFp(100.5);
    bot.pickDurability = bal.items.pick.durabilityTicks;
    bot.carriedGems = bal.automation.base.commonCost;
    bot.iron = bal.automation.base.ironCost;
    const bots = new BotController(443);
    bots.stepBots(sim);
    sim.step();
    expect(sim.ownedMiningBases(bot)).toBe(1);
    expect(sim.ownedAutoMiners(bot)).toBe(1);
    expect(bot.carriedGems).toBe(0);
    expect(bot.iron).toBe(0);
  });

  it("bots excavate a planned base footprint before attempting deployment", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(445, bal, [{ name: "builder", bot: true }, { name: "observer", bot: false }]);
    const bot = sim.players[0];
    sim.step();
    bot.x = cellsToFp(100.5);
    bot.y = cellsToFp(100.5);
    for (let y = 75; y <= 125; y++) for (let x = 75; x <= 125; x++) sim.world.setRaw(x, y, MAT.SOFT);
    for (let y = 97; y <= 103; y++) for (let x = 97; x <= 103; x++) {
      if ((x - 100) ** 2 + (y - 100) ** 2 <= 9) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    for (const [id, entity] of sim.entities) {
      if ((entity.x / FP - 100.5) ** 2 + (entity.y / FP - 100.5) ** 2 < 40 ** 2) sim.entities.delete(id);
    }
    bot.pickDurability = bal.items.pick.durabilityTicks;
    bot.carriedGems = bal.automation.base.commonCost;
    bot.iron = bal.automation.base.ironCost;

    const bots = new BotController(445);
    let clearedTerrain = false;
    const failedPlacementMessages: string[] = [];
    for (let tick = 0; tick < 20 * TICK_HZ && sim.ownedMiningBases(bot) === 0; tick++) {
      bots.stepBots(sim);
      sim.step();
      clearedTerrain ||= bot.stats.cellsDug > 0;
      for (const event of sim.drainEvents()) {
        if (event.type === "log" && /Mining bases need|footprint is occupied|Move everyone clear/.test(event.msg)) {
          failedPlacementMessages.push(event.msg);
        }
      }
    }

    expect(clearedTerrain).toBe(true);
    expect(failedPlacementMessages).toEqual([]);
    expect(sim.ownedMiningBases(bot)).toBe(1);
    expect(sim.ownedAutoMiners(bot)).toBe(1);
    const base = [...sim.entities.values()].find((entity) => entity.kind === ENT.MINING_BASE && entity.ownerId === bot.id)!;
    const cx = base.x / FP;
    const cy = base.y / FP;
    const clearRadius = bal.automation.base.siteClearanceRadiusCells;
    for (let y = Math.floor(cy - clearRadius); y <= Math.ceil(cy + clearRadius); y++) {
      for (let x = Math.floor(cx - clearRadius); x <= Math.ceil(cx + clearRadius); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= clearRadius * clearRadius) expect(sim.world.get(x, y)).toBe(MAT.EMPTY);
      }
    }
  });

  it("bots repeatedly escape their own excavation bombs instead of chain-suiciding", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4242, bal, roster(8));
    const bots = new BotController(4242);
    for (let i = 0; i < 15 * TICK_HZ && !sim.ended; i++) {
      bots.stepBots(sim);
      sim.step();
    }
    expect(sim.players.filter((player) => !player.eliminated).length).toBeGreaterThanOrEqual(6);
    expect(sim.ended).toBe(false);
  });

  it("bots approach a rock face before planting an excavation bomb", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4343, bal, roster(2));
    const bot = sim.players[0];
    const startX = Math.floor(bot.x / FP);
    const startY = Math.floor(bot.y / FP);
    for (let y = startY - 14; y <= startY + 14; y++) {
      for (let x = startX - 14; x <= startX + 14; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    const rockX = startX + 8;
    for (let y = startY - 4; y <= startY + 4; y++) sim.world.setRaw(rockX, y, MAT.SOFT);
    sim.step(); // leave the zero-length countdown

    const bots = new BotController(4343);
    let bomb: ReturnType<MatchSim["entities"]["get"]>;
    for (let i = 0; i < 60 && !bomb; i++) {
      bots.stepBots(sim);
      sim.step();
      bomb = [...sim.entities.values()].find((entity) => entity.kind === ENT.BOMB && entity.ownerId === bot.id);
    }

    expect(bomb).toBeDefined();
    expect(Math.abs(bomb!.x / FP - (rockX + 0.5))).toBeLessThanOrEqual(3.5);
    expect(bot.x / FP).toBeGreaterThan(startX + 3);
    for (let i = 0; i < bal.items.bomb.fuseTicks + bal.items.bomb.blastRangeCells + 5; i++) {
      bots.stepBots(sim);
      sim.step();
    }
    expect(sim.world.get(rockX, startY)).toBe(MAT.EMPTY);
  });

  it("bots kite ruin guardians around a bomb and escape before the blast", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 },
      items: { ...BALANCE.items, bomb: { ...BALANCE.items.bomb, fuseTicks: 30 } },
      treasure: { ...BALANCE.treasure, guardianAggroRadiusCells: 40 }
    } as any);
    const sim = new MatchSim(4393, bal, roster(2));
    const bot = sim.players[0];
    const rival = sim.players[1];
    const guardian = sim.guardians[0];
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GUARDIAN && entity.id !== guardian.id) sim.entities.delete(id);
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM || entity.kind === ENT.CHEST) sim.entities.delete(id);
    }
    for (let y = 45; y <= 165; y++) for (let x = 45; x <= 205; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    bot.x = cellsToFp(100.5);
    bot.y = cellsToFp(105.5);
    rival.x = cellsToFp(195.5);
    rival.y = cellsToFp(125.5);
    guardian.x = guardian.homeX = cellsToFp(108.5);
    guardian.y = guardian.homeY = cellsToFp(105.5);
    // Isolate the guardian behavior: the rival is occluded, so the bot cannot
    // correctly prioritize that otherwise-visible enemy over the ruin fight.
    for (let y = 45; y <= 165; y++) sim.world.setRaw(170, y, MAT.BEDROCK);
    sim.step();

    const bots = new BotController(4393);
    let planted = false;
    for (let i = 0; i < 10 * TICK_HZ && sim.entities.has(guardian.id) && !bot.eliminated; i++) {
      bots.stepBots(sim);
      sim.step();
      planted ||= [...sim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.ownerId === bot.id);
    }

    expect(planted).toBe(true);
    expect(bot.eliminated).toBe(false);
    expect(sim.entities.has(guardian.id)).toBe(false);
  });

  it("bots bomb through a sealed ruin wall instead of walking into its guardian", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 },
      items: { ...BALANCE.items, bomb: { ...BALANCE.items.bomb, fuseTicks: 24 } }
    } as any);
    const sim = new MatchSim(4394, bal, roster(2));
    const bot = sim.players[0];
    const rival = sim.players[1];
    const guardian = sim.guardians[0];
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GUARDIAN && entity.id !== guardian.id) sim.entities.delete(id);
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM || entity.kind === ENT.CHEST) sim.entities.delete(id);
    }
    for (let y = 85; y <= 125; y++) for (let x = 85; x <= 190; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    bot.x = cellsToFp(100.5);
    bot.y = cellsToFp(105.5);
    rival.x = cellsToFp(180.5);
    rival.y = cellsToFp(120.5);
    guardian.x = guardian.homeX = cellsToFp(113.5);
    guardian.y = guardian.homeY = cellsToFp(105.5);
    for (let y = 98; y <= 112; y++) sim.world.setRaw(106, y, MAT.FOSSIL);
    sim.step();

    const bots = new BotController(4394);
    let planted = false;
    for (let i = 0; i < 3 * TICK_HZ && !bot.eliminated; i++) {
      bots.stepBots(sim);
      sim.step();
      planted ||= [...sim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.ownerId === bot.id);
      if (sim.world.get(106, 105) === MAT.EMPTY) break;
    }

    expect(planted).toBe(true);
    expect(sim.world.get(106, 105)).toBe(MAT.EMPTY);
    expect(bot.eliminated).toBe(false);
  });

  it("bots prioritize a visible loose gem during the opening economy", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4444, bal, roster(2));
    const bot = sim.players[0];
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) sim.entities.delete(id);
    }
    sim.entities.set(900_001, {
      id: 900_001,
      kind: ENT.GEM,
      x: bot.x + cellsToFp(7),
      y: bot.y,
      ownerId: -1,
      cooldownEnd: 0
    });
    sim.step();

    const beforeX = bot.x;
    const bots = new BotController(4444);
    bots.stepBots(sim);
    sim.step();

    expect(bot.x).toBeGreaterThan(beforeX);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.ownerId === bot.id)).toBe(false);
  });

  it("bots weight a visible gem cluster above a closer isolated gem", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4545, bal, roster(2));
    const bot = sim.players[0];
    const startX = Math.floor(bot.x / FP);
    const startY = Math.floor(bot.y / FP);
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) sim.entities.delete(id);
    }
    for (let y = startY - 45; y <= startY + 45; y++) {
      for (let x = startX - 45; x <= startX + 45; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    sim.world.setRaw(startX + 5, startY, MAT.GEM);
    for (let y = startY - 1; y <= startY + 1; y++) {
      for (let x = startX - 16; x <= startX - 14; x++) sim.world.setRaw(x, y, MAT.GEM);
    }
    bot.pickDurability = bal.items.pick.durabilityTicks;
    sim.step();

    const beforeX = bot.x;
    const bots = new BotController(4545);
    bots.stepBots(sim);
    sim.step();

    expect(bot.x).toBeLessThan(beforeX);
    const objective = (bots as any).objectives.get(bot.id)?.value;
    expect(objective?.kind).toBe("deposit");
    expect(objective?.x).toBeLessThanOrEqual(startX - 15);
  });

  it("bots install an affordable upgrade immediately while reserving an uncrafted pick", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4646, bal, roster(2));
    const bot = sim.players[0];
    bot.carriedGems = bal.items.pick.gemCost;
    bot.copper = bal.bombUpgrades.speed.copperBase;
    sim.step();

    const bots = new BotController(4646);
    bots.stepBots(sim);

    expect(bot.bombSpeedLevel).toBe(1);
    expect(bot.carriedGems).toBe(bal.items.pick.gemCost);
  });

  it("bots prioritize a visible enemy above a rich gem cluster", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4747, bal, roster(2));
    const bot = sim.players[0];
    const enemy = sim.players[1];
    const startX = Math.floor(bot.x / FP);
    const startY = Math.floor(bot.y / FP);
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) sim.entities.delete(id);
    }
    for (let y = startY - 45; y <= startY + 45; y++) {
      for (let x = startX - 45; x <= startX + 45; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    for (let y = startY - 14; y <= startY - 10; y++) {
      for (let x = startX - 2; x <= startX + 2; x++) sim.world.setRaw(x, y, MAT.GEM);
    }
    bot.pickDurability = bal.items.pick.durabilityTicks;
    sim.step();
    enemy.x = bot.x + cellsToFp(9);
    enemy.y = bot.y;

    const bots = new BotController(4747);
    bots.stepBots(sim);
    sim.step();

    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.ownerId === bot.id)).toBe(true);
  });

  it("bots ignore an enemy hidden behind rock and continue toward visible resources", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4848, bal, roster(2));
    const bot = sim.players[0];
    const enemy = sim.players[1];
    const startX = Math.floor(bot.x / FP);
    const startY = Math.floor(bot.y / FP);
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) sim.entities.delete(id);
    }
    for (let y = startY - 45; y <= startY + 45; y++) {
      for (let x = startX - 45; x <= startX + 45; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    for (let y = startY - 13; y <= startY - 11; y++) {
      for (let x = startX - 1; x <= startX + 1; x++) sim.world.setRaw(x, y, MAT.GEM);
    }
    for (let y = startY - 6; y <= startY + 6; y++) sim.world.setRaw(startX + 4, y, MAT.BEDROCK);
    bot.pickDurability = bal.items.pick.durabilityTicks;
    sim.step();
    enemy.x = bot.x + cellsToFp(9);
    enemy.y = bot.y;
    const beforeY = bot.y;

    const bots = new BotController(4848);
    bots.stepBots(sim);
    sim.step();

    expect(bot.y).toBeLessThan(beforeY);
    expect([...sim.entities.values()].some((entity) => entity.kind === ENT.BOMB && entity.ownerId === bot.id)).toBe(false);
  });

  it("bots reject a rich deposit behind bedrock instead of mining forever", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(4949, bal, roster(2));
    const bot = sim.players[0];
    const startX = Math.floor(bot.x / FP);
    const startY = Math.floor(bot.y / FP);
    for (const [id, entity] of sim.entities) {
      if (entity.kind === ENT.GEM || entity.kind === ENT.REINFORCE_GEM) sim.entities.delete(id);
    }
    for (let y = startY - 45; y <= startY + 45; y++) {
      for (let x = startX - 45; x <= startX + 45; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    // The larger western cluster would win by density, but its direct route is
    // permanently blocked. The eastern single is weaker but actionable.
    for (let y = startY - 2; y <= startY + 2; y++) {
      for (let x = startX - 18; x <= startX - 14; x++) sim.world.setRaw(x, y, MAT.GEM);
    }
    for (let y = startY - 8; y <= startY + 8; y++) sim.world.setRaw(startX - 6, y, MAT.BEDROCK);
    sim.world.setRaw(startX + 9, startY, MAT.GEM);
    bot.pickDurability = bal.items.pick.durabilityTicks;
    sim.step();
    const beforeX = bot.x;

    const bots = new BotController(4949);
    bots.stepBots(sim);
    sim.step();

    expect(bot.x).toBeGreaterThan(beforeX);
  });

  it("low-oxygen bots return to a vent and refill instead of becoming permanently idle", () => {
    const bal = withOverrides(BALANCE, {
      match: { ...BALANCE.match, countdownSeconds: 0, phases: [{ kind: "day", seconds: 0 }] },
      zombies: { ...BALANCE.zombies, perPlayer: 0 }
    } as any);
    const sim = new MatchSim(5050, bal, roster(2));
    const bot = sim.players[0];
    const spawnX = Math.floor(bot.x / FP);
    const startY = Math.floor(bot.y / FP);
    const direction = spawnX < sim.world.size / 2 ? 1 : -1;
    let startX = spawnX + direction * 36;
    while (sim.isVentilatedCell(startX, startY)) startX += direction;
    const ventX = startX + direction * 18;
    for (let y = startY - 3; y <= startY + 3; y++) {
      for (let x = Math.min(startX, ventX) - 2; x <= Math.max(startX, ventX) + 2; x++) sim.world.setRaw(x, y, MAT.EMPTY);
    }
    sim.world.setRaw(ventX, startY, MAT.VENT);
    sim.map.ventCells.splice(0, sim.map.ventCells.length, { x: ventX, y: startY });
    bot.x = cellsToFp(startX + 0.5);
    bot.y = cellsToFp(startY + 0.5);
    bot.oxygen = 20;
    bot.pickDurability = bal.items.pick.durabilityTicks;
    sim.step();
    const beforeX = bot.x;

    const bots = new BotController(5050);
    let recoveredTo = bot.oxygen;
    for (let i = 0; i < 12 * TICK_HZ; i++) {
      bots.stepBots(sim);
      sim.step();
      recoveredTo = Math.max(recoveredTo, bot.oxygen);
    }

    expect(Math.abs(bot.x - beforeX)).toBeGreaterThan(cellsToFp(5));
    expect(recoveredTo).toBeGreaterThan(bal.oxygen.emergencySeconds * 0.85);
    expect(bot.incapacitated).toBe(false);
  });

  it("terrain ops in same order produce identical checksums (determinism)", () => {
    const run = () => {
      const sim = new MatchSim(888, fastBal, roster(8));
      const bots = new BotController(888);
      for (let i = 0; i < 3 * TICK_HZ; i++) {
        bots.stepBots(sim);
        sim.step();
        sim.drainEvents();
      }
      return sim.world.worldChecksum();
    };
    expect(run()).toBe(run());
  });
});
