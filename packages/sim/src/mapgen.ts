import type { Balance } from "@burrow/config";
import { Rng, fbm } from "./rng";
import { MAT } from "./materials";
import { World } from "./terrain";

export interface GeneratedMap {
  world: World;
  spawns: { x: number; y: number }[]; // cell coords
  chambers: { x: number; y: number; r: number }[];
  looseGems: { x: number; y: number; kind: "common" | "reinforce" }[];
  ventCells: { x: number; y: number }[];
  bedrockFormations: { x: number; y: number; kind: "line" | "L" | "U" | "S" }[];
  ruins: RuinSite[];
  ancientTunnels: AncientTunnelSite[];
  specialSites: LandmarkSite[];
  ambientEnemies: AmbientEnemySpawn[];
  seed: number;
  attempts: number;
}

export interface RuinSite {
  x: number;
  y: number;
  chestX: number;
  chestY: number;
  guardians: { x: number; y: number }[];
}

export type AncientTunnelKind = "spiral" | "serpent" | "fork" | "loop";
export interface AncientTunnelSite { x: number; y: number; kind: AncientTunnelKind }
export type LandmarkKind = "volcano" | "ritual" | "oasis" | "ancient-vault";
export interface LandmarkSite {
  kind: LandmarkKind;
  x: number;
  y: number;
  cacheX: number;
  cacheY: number;
}
export interface AmbientEnemySpawn {
  x: number;
  y: number;
  variant: "crawler" | "emberling" | "wraith";
}

interface Ctx {
  world: World;
  rng: Rng;
  size: number;
  bal: Balance;
  chambers: { x: number; y: number; r: number }[];
  spawns: { x: number; y: number }[];
  looseGems: { x: number; y: number; kind: "common" | "reinforce" }[];
  ventCells: { x: number; y: number }[];
  bedrockFormations: { x: number; y: number; kind: "line" | "L" | "U" | "S" }[];
  ruins: RuinSite[];
  ancientTunnels: AncientTunnelSite[];
  specialSites: LandmarkSite[];
  ambientEnemies: AmbientEnemySpawn[];
  seed: number;
}

/** Full deterministic pipeline (spec §6.4 stages A–I). Regenerates with a
 *  derived seed if validation fails, up to mapgen.maxRegenAttempts. */
export function generateMap(seed: number, bal: Balance, playerCount: number): GeneratedMap {
  const maxAttempts = bal.mapgen.maxRegenAttempts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptSeed = (seed + attempt * 0x51ed270b) >>> 0;
    const map = generateOnce(attemptSeed, bal, playerCount);
    if (map && validate(map, bal, playerCount)) {
      return { ...map, seed: attemptSeed, attempts: attempt + 1 };
    }
  }
  throw new Error(`mapgen: failed to produce a valid map after ${maxAttempts} attempts (seed ${seed})`);
}

function generateOnce(seed: number, bal: Balance, playerCount: number): GeneratedMap | null {
  const size = bal.world.size;
  const world = new World(size, bal.world.chunk);
  const rng = new Rng(seed);
  const ctx: Ctx = {
    world,
    rng,
    size,
    bal,
    chambers: [],
    spawns: [],
    looseGems: [],
    ventCells: [],
    bedrockFormations: [],
    ruins: [],
    ancientTunnels: [],
    specialSites: [],
    ambientEnemies: [],
    seed
  };

  stageBaseDensity(ctx);
  stageChambers(ctx);
  stageTunnelGraph(ctx);
  stageSecondaryCaves(ctx);
  stageBlockers(ctx);
  if (!stageSpawns(ctx, playerCount)) return null;
  stageAncientTunnels(ctx);
  stageSpecialSites(ctx);
  stageBedrockFormations(ctx);
  stageRuins(ctx);
  stageVents(ctx);
  stageGems(ctx);
  stageCraftMaterials(ctx);
  stageAmbientEnemies(ctx);
  return {
    world,
    spawns: ctx.spawns,
    chambers: ctx.chambers,
    looseGems: ctx.looseGems,
    ventCells: ctx.ventCells,
    bedrockFormations: ctx.bedrockFormations,
    ruins: ctx.ruins,
    ancientTunnels: ctx.ancientTunnels,
    specialSites: ctx.specialSites,
    ambientEnemies: ctx.ambientEnemies,
    seed,
    attempts: 1
  };
}

/* ---------------- Stage A: base density ---------------- */

function stageBaseDensity(ctx: Ctx): void {
  const { world, size, seed } = ctx;
  const nseed = seed ^ 0x600d5eed;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x, y, nseed);
      let m: number = MAT.DENSE;
      if (n < 0.42) m = MAT.SOFT;
      else if (n > 0.74) m = MAT.HARD;
      world.setRaw(x, y, m);
    }
  }
  // unstable patches
  const rng = ctx.rng.fork(11);
  for (let i = 0; i < ctx.bal.mapgen.unstablePatches; i++) {
    const cx = rng.range(20, size - 20);
    const cy = rng.range(20, size - 20);
    const r = rng.range(4, 9);
    blob(world, cx, cy, r, rng, (m) => (m === MAT.SOFT || m === MAT.DENSE ? MAT.UNSTABLE : m));
  }
  // hard border walls
  for (let i = 0; i < size; i++) {
    for (let b = 0; b < 4; b++) {
      world.setRaw(i, b, MAT.HARD);
      world.setRaw(i, size - 1 - b, MAT.HARD);
      world.setRaw(b, i, MAT.HARD);
      world.setRaw(size - 1 - b, i, MAT.HARD);
    }
  }
}

/* ---------------- Stage B: chambers ---------------- */

function stageChambers(ctx: Ctx): void {
  const { world, size, bal } = ctx;
  const rng = ctx.rng.fork(22);
  const want = rng.range(bal.mapgen.chambersMin, bal.mapgen.chambersMax);
  const spacing = bal.mapgen.chamberSpacing;
  let guard = 4000;
  while (ctx.chambers.length < want && guard-- > 0) {
    const x = rng.range(40, size - 40);
    const y = rng.range(40, size - 40);
    let ok = true;
    for (const c of ctx.chambers) {
      const dx = c.x - x;
      const dy = c.y - y;
      if (dx * dx + dy * dy < spacing * spacing) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const r = rng.range(bal.mapgen.chamberRadiusMin, bal.mapgen.chamberRadiusMax);
    carveChamber(world, x, y, r, rng);
    ctx.chambers.push({ x, y, r });
  }
}

function carveChamber(world: World, cx: number, cy: number, r: number, rng: Rng): void {
  const wob = rng.nextInt(1000);
  for (let y = cy - r - 3; y <= cy + r + 3; y++) {
    for (let x = cx - r - 3; x <= cx + r + 3; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const ang = Math.atan2(dy, dx);
      const edge = r * (0.8 + 0.25 * Math.sin(ang * 3 + wob) + 0.1 * Math.sin(ang * 7 + wob * 2));
      if (dx * dx + dy * dy <= edge * edge) world.setRaw(x, y, MAT.EMPTY);
    }
  }
}

/* ---------------- Stage C: tunnel graph ---------------- */

function stageTunnelGraph(ctx: Ctx): void {
  const { chambers } = ctx;
  const rng = ctx.rng.fork(33);
  if (chambers.length < 2) return;

  // Prim MST
  const inTree = new Set<number>([0]);
  const edges: [number, number][] = [];
  while (inTree.size < chambers.length) {
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const a of inTree) {
      for (let b = 0; b < chambers.length; b++) {
        if (inTree.has(b)) continue;
        const dx = chambers[a].x - chambers[b].x;
        const dy = chambers[a].y - chambers[b].y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = [a, b];
        }
      }
    }
    if (!best) break;
    edges.push(best);
    inTree.add(best[1]);
  }

  // extra loop edges: connect random near pairs not already joined
  const joined = new Set(edges.map(([a, b]) => key(a, b)));
  let extra = ctx.bal.mapgen.extraLoopEdges;
  let guard = 500;
  while (extra > 0 && guard-- > 0) {
    const a = rng.nextInt(chambers.length);
    // nearest few candidates
    const cand = chambers
      .map((c, i) => ({ i, d: (c.x - chambers[a].x) ** 2 + (c.y - chambers[a].y) ** 2 }))
      .filter((e) => e.i !== a)
      .sort((p, q) => p.d - q.d)
      .slice(0, 4);
    const b = cand[rng.nextInt(cand.length)].i;
    if (joined.has(key(a, b))) continue;
    joined.add(key(a, b));
    edges.push([a, b]);
    extra--;
  }

  for (const [a, b] of edges) carveTunnel(ctx, chambers[a], chambers[b], rng);
  function key(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }
}

function carveTunnel(ctx: Ctx, from: { x: number; y: number }, to: { x: number; y: number }, rng: Rng): void {
  const { world } = ctx;
  let x = from.x;
  let y = from.y;
  const wide = rng.chance(0.35);
  let guard = 4000;
  while (guard-- > 0) {
    const dx = to.x - x;
    const dy = to.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist < 3) break;
    const ang = Math.atan2(dy, dx) + (rng.nextFloat() - 0.5) * 1.4;
    const step = 2 + rng.nextInt(2);
    x += Math.cos(ang) * step;
    y += Math.sin(ang) * step;
    const r = wide ? 3 + rng.nextInt(2) : 2 + rng.nextInt(2);
    carveDisc(world, Math.round(x), Math.round(y), r);
  }
}

function carveDisc(world: World, cx: number, cy: number, r: number): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        if (x > 4 && y > 4 && x < world.size - 5 && y < world.size - 5) world.setRaw(x, y, MAT.EMPTY);
      }
    }
  }
}

/* ---------------- Stage D: secondary caves ---------------- */

function stageSecondaryCaves(ctx: Ctx): void {
  const { world, size } = ctx;
  const rng = ctx.rng.fork(44);
  const zones = ctx.bal.mapgen.secondaryCaveZones;
  for (let z = 0; z < zones; z++) {
    const zx = rng.range(60, size - 60);
    const zy = rng.range(60, size - 60);
    const zr = rng.range(14, 26);
    // random fill + CA smoothing inside the zone
    const w = zr * 2 + 1;
    let grid = new Uint8Array(w * w);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.chance(0.46) ? 1 : 0;
    for (let it = 0; it < 3; it++) {
      const next = new Uint8Array(w * w);
      for (let y = 1; y < w - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          let n = 0;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) n += grid[(y + oy) * w + (x + ox)];
          next[y * w + x] = n >= 5 ? 1 : 0;
        }
      }
      grid = next;
    }
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        if (!grid[y * w + x]) continue;
        const gx = zx - zr + x;
        const gy = zy - zr + y;
        const dx = gx - zx;
        const dy = gy - zy;
        if (dx * dx + dy * dy > zr * zr) continue;
        if (gx > 4 && gy > 4 && gx < size - 5 && gy < size - 5) world.setRaw(gx, gy, MAT.EMPTY);
      }
    }
  }
}

/* ---------------- Stage E: natural blockers ---------------- */

function stageBlockers(ctx: Ctx): void {
  const { world, size, bal } = ctx;
  const rng = ctx.rng.fork(55);
  let placed = 0;
  let guard = Math.max(3000, bal.mapgen.boulderBlocks * 120);
  while (placed < bal.mapgen.boulderBlocks && guard-- > 0) {
    const x = rng.range(20, size - 20);
    const y = rng.range(20, size - 20);
    if (world.get(x, y) !== MAT.EMPTY) continue;
    // must be a corridor: solid on two opposite-ish sides
    const solidL = world.isSolid(x - 4, y);
    const solidR = world.isSolid(x + 4, y);
    const solidU = world.isSolid(x, y - 4);
    const solidD = world.isSolid(x, y + 4);
    if (!((solidL && solidR) || (solidU && solidD))) continue;
    blob(world, x, y, rng.range(3, 4), rng, (m) => (m === MAT.EMPTY ? MAT.BOULDER : m));
    placed++;
  }
}

/* ---------------- Stage H: spawn pockets ---------------- */

function stageSpawns(ctx: Ctx, playerCount: number): boolean {
  const { world, size, bal } = ctx;
  const rng = ctx.rng.fork(66);
  const minD = bal.mapgen.spawnMinDistCells;
  let guard = 6000;
  while (ctx.spawns.length < playerCount && guard-- > 0) {
    const x = rng.range(60, size - 60);
    const y = rng.range(60, size - 60);
    let ok = true;
    for (const s of ctx.spawns) {
      const dx = s.x - x;
      const dy = s.y - y;
      if (dx * dx + dy * dy < minD * minD) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // Room to prepare, build, and escape the dormant spawn-point zombie.
    const radius = bal.mapgen.spawnPocketRadiusCells;
    carveDisc(world, x, y, radius);
    blobRing(world, x, y, radius + 1, radius + 4, rng, MAT.SOFT);
    ctx.spawns.push({ x, y });
  }
  return ctx.spawns.length === playerCount;
}

/* ---------------- Ancient tunnel networks and landmark chambers ---------------- */

/** Carves old, intentionally designed passages into the natural cave graph. The
 *  templates only define topology; rotation, wobble, erosion, width, and broken
 *  fossil edging make every network read differently. */
function stageAncientTunnels(ctx: Ctx): void {
  // Independent streams keep new content from reshuffling legacy resources,
  // spawns, and bot-opening layouts for the same world seed.
  const rng = new Rng(ctx.seed ^ 0x6a41c1);
  const kinds: AncientTunnelKind[] = ["spiral", "serpent", "fork", "loop"];
  const clearance2 = ctx.bal.mapgen.landmarkSpawnClearanceCells ** 2;
  const awayFromSpawns = (x: number, y: number) => ctx.spawns.every((spawn) => (spawn.x - x) ** 2 + (spawn.y - y) ** 2 >= clearance2);
  let guard = ctx.bal.mapgen.ancientTunnelNetworks * 180;
  while (ctx.ancientTunnels.length < ctx.bal.mapgen.ancientTunnelNetworks && guard-- > 0) {
    const cx = rng.range(45, ctx.size - 45);
    const cy = rng.range(45, ctx.size - 45);
    if (ctx.spawns.some((spawn) => (spawn.x - cx) ** 2 + (spawn.y - cy) ** 2 < clearance2)) continue;
    if (ctx.ancientTunnels.some((site) => (site.x - cx) ** 2 + (site.y - cy) ** 2 < 52 ** 2)) continue;
    const kind = kinds[(ctx.ancientTunnels.length + rng.nextInt(kinds.length)) % kinds.length];
    const local = ancientTunnelPoints(kind, rng);
    const angle = rng.nextFloat() * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const points = local.map((point) => ({
      x: cx + point.x * cos - point.y * sin,
      y: cy + point.x * sin + point.y * cos
    }));
    let changed = carveAncientStroke(ctx.world, points, rng, rng.range(2, 4), awayFromSpawns);
    if (kind === "fork") {
      const middle = points[Math.floor(points.length * 0.55)];
      const branchAngle = angle + (rng.chance(0.5) ? 1 : -1) * randomBetween(rng, 0.75, 1.2);
      const branch = Array.from({ length: 7 }, (_, i) => ({
        x: middle.x + Math.cos(branchAngle) * i * 4.5,
        y: middle.y + Math.sin(branchAngle) * i * 4.5 + Math.sin(i * 1.4) * 1.8
      }));
      changed += carveAncientStroke(ctx.world, branch, rng, rng.range(2, 3), awayFromSpawns);
    }
    if (changed < 100) continue;
    ctx.ancientTunnels.push({ x: cx, y: cy, kind });
  }
}

function ancientTunnelPoints(kind: AncientTunnelKind, rng: Rng): BedrockPoint[] {
  const points: BedrockPoint[] = [];
  if (kind === "spiral") {
    const turns = randomBetween(rng, 1.65, 2.7);
    for (let i = 0; i < 42; i++) {
      const t = i / 41;
      const radius = 4 + t * rng.range(23, 34);
      const angle = t * Math.PI * 2 * turns;
      points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
  } else if (kind === "serpent") {
    const phase = rng.nextFloat() * Math.PI * 2;
    for (let i = 0; i < 22; i++) {
      const t = i / 21;
      points.push({
        x: (t - 0.5) * rng.range(58, 78),
        y: Math.sin(phase + t * Math.PI * randomBetween(rng, 3.2, 5.2)) * rng.range(8, 17) + Math.sin(t * 19) * 2
      });
    }
  } else if (kind === "loop") {
    const rx = rng.range(19, 31);
    const ry = rng.range(11, 23);
    for (let i = 0; i <= 32; i++) {
      const angle = (i / 32) * Math.PI * 2;
      points.push({ x: Math.cos(angle) * rx + Math.sin(angle * 3) * 3, y: Math.sin(angle) * ry + Math.cos(angle * 5) * 2 });
    }
  } else {
    for (let i = 0; i < 17; i++) {
      const t = i / 16;
      points.push({ x: (t - 0.5) * rng.range(54, 72), y: Math.sin(t * Math.PI * 2 + rng.nextFloat() * 0.18) * 5 });
    }
  }
  return points;
}

function carveAncientStroke(
  world: World,
  points: BedrockPoint[],
  rng: Rng,
  baseRadius: number,
  canCarve: (x: number, y: number) => boolean = () => true
): number {
  let changed = 0;
  for (let segment = 0; segment + 1 < points.length; segment++) {
    const a = points[segment];
    const b = points[segment + 1];
    const length = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const steps = Math.max(1, Math.ceil(length / 1.4));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      const radius = Math.max(2, baseRadius + Math.round(Math.sin(segment * 1.7 + t * 3.1) + randomBetween(rng, -0.8, 0.8)));
      for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
        if (ox * ox + oy * oy > radius * radius || !world.inBounds(x + ox, y + oy) || !canCarve(x + ox, y + oy)) continue;
        const before = world.get(x + ox, y + oy);
        if (before === MAT.REINFORCE || before === MAT.VENT || before === MAT.BEDROCK) continue;
        if (before !== MAT.EMPTY) changed++;
        world.setRaw(x + ox, y + oy, MAT.EMPTY);
      }
      // Broken pale masonry ribs give a readable ancient edge without making
      // the passage uniformly outlined or obstructing its player-width center.
      if ((segment + step) % 9 === 0) {
        const nx = -(b.y - a.y) / length;
        const ny = (b.x - a.x) / length;
        for (const side of [-1, 1]) {
          const fx = Math.round(x + nx * side * (radius + 1));
          const fy = Math.round(y + ny * side * (radius + 1));
          if (world.inBounds(fx, fy) && canCarve(fx, fy) && canHostDeposit(world.get(fx, fy))) world.setRaw(fx, fy, MAT.FOSSIL);
        }
      }
    }
  }
  return changed;
}

function stageSpecialSites(ctx: Ctx): void {
  const rng = new Rng(ctx.seed ^ 0x51ec1a1);
  const clearance2 = ctx.bal.mapgen.landmarkSpawnClearanceCells ** 2;
  const separation = Math.min(135, Math.max(75, Math.floor(ctx.size / 8)));
  const findLocation = (central: boolean): { x: number; y: number } | undefined => {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const margin = central ? Math.max(60, Math.floor(ctx.size * 0.38)) : 45;
      const max = central ? Math.min(ctx.size - 60, Math.floor(ctx.size * 0.62)) : ctx.size - 45;
      const x = rng.range(margin, max);
      const y = rng.range(margin, max);
      if (ctx.spawns.some((spawn) => (spawn.x - x) ** 2 + (spawn.y - y) ** 2 < clearance2)) continue;
      if (ctx.specialSites.some((site) => (site.x - x) ** 2 + (site.y - y) ** 2 < separation ** 2)) continue;
      return { x, y };
    }
    return undefined;
  };
  const counts: [LandmarkKind, number][] = [
    ["volcano", 1],
    ["ritual", ctx.bal.mapgen.ritualSites],
    ["oasis", ctx.bal.mapgen.oasisSites],
    ["ancient-vault", ctx.bal.mapgen.ancientVaultSites]
  ];
  for (const [kind, count] of counts) {
    for (let i = 0; i < count; i++) {
      const location = findLocation(kind === "volcano");
      if (!location) continue;
      const site = carveSpecialSite(ctx, kind, location.x, location.y, rng);
      ctx.specialSites.push(site);
      const nearest = ctx.chambers.reduce((best, chamber) =>
        (chamber.x - site.x) ** 2 + (chamber.y - site.y) ** 2 < (best.x - site.x) ** 2 + (best.y - site.y) ** 2 ? chamber : best,
        ctx.chambers[0]
      );
      if (nearest) carveAncientStroke(
        ctx.world,
        [{ x: site.x, y: site.y }, nearest],
        rng,
        rng.range(2, 3),
        (x, y) => ctx.spawns.every((spawn) => (spawn.x - x) ** 2 + (spawn.y - y) ** 2 >= clearance2)
      );
    }
  }
}

function carveSpecialSite(ctx: Ctx, kind: LandmarkKind, cx: number, cy: number, rng: Rng): LandmarkSite {
  const { world } = ctx;
  const radius = kind === "volcano" ? 34 : kind === "oasis" ? 27 : kind === "ritual" ? 24 : 22;
  carveChamber(world, cx, cy, radius, rng);
  let cacheX = cx + Math.round(radius * 0.58);
  let cacheY = cy;
  if (kind === "volcano") {
    // One permanent caldera: impassable molten core, broken bedrock rim, and
    // four open overlooks that turn it into a dangerous central meeting place.
    for (let y = cy - 15; y <= cy + 15; y++) for (let x = cx - 15; x <= cx + 15; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const wobble = Math.sin(Math.atan2(dy, dx) * 5 + ctx.seed) * 1.2;
      if (d <= 9 + wobble) world.setRaw(x, y, MAT.LAVA);
      else if (d >= 11 + wobble && d <= 14 + wobble && !(Math.abs(dx) < 3 || Math.abs(dy) < 3)) world.setRaw(x, y, MAT.BEDROCK);
    }
    cacheX = cx + 20;
    cacheY = cy + 3;
  } else if (kind === "ritual") {
    // Fossil teeth, radial runes, and a deliberately broken ritual ring.
    for (let spoke = 0; spoke < 13; spoke++) {
      const angle = (spoke / 13) * Math.PI * 2 + 0.12;
      for (const distance of [9, 15]) {
        if ((spoke + distance) % 7 === 0) continue;
        const x = Math.round(cx + Math.cos(angle) * distance);
        const y = Math.round(cy + Math.sin(angle) * distance);
        world.setRaw(x, y, distance === 15 && spoke % 3 === 0 ? MAT.BEDROCK : MAT.FOSSIL);
      }
    }
    cacheX = cx + 7;
    cacheY = cy + 7;
  } else if (kind === "oasis") {
    for (let y = cy - 11; y <= cy + 11; y++) for (let x = cx - 11; x <= cx + 11; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const wobble = Math.sin(Math.atan2(dy, dx) * 6 + ctx.seed * 0.01) * 1.4;
      if (d <= 7 + wobble) world.setRaw(x, y, MAT.WATER);
      else if (d <= 10 + wobble && (x + y + ctx.seed) % 3 !== 0) world.setRaw(x, y, MAT.MOSS);
    }
    // Ancient vents keep the grotto breathable and visibly alive.
    for (const [ox, oy] of [[-12, 0], [12, 0], [0, -12], [0, 12]] as const) {
      world.setRaw(cx + ox, cy + oy, MAT.VENT);
    }
    cacheX = cx + 15;
    cacheY = cy + 5;
  } else {
    // A damaged rectangular vault contrasts with the organic surrounding rock.
    for (let x = cx - 17; x <= cx + 17; x++) {
      if (Math.abs(x - cx) < 3) continue;
      if ((x + ctx.seed) % 7 !== 0) {
        world.setRaw(x, cy - 13, MAT.FOSSIL);
        world.setRaw(x, cy + 13, MAT.FOSSIL);
      }
    }
    for (let y = cy - 12; y <= cy + 12; y++) {
      if (Math.abs(y - cy) < 3) continue;
      if ((y + ctx.seed) % 6 !== 0) {
        world.setRaw(cx - 17, y, MAT.FOSSIL);
        world.setRaw(cx + 17, y, MAT.FOSSIL);
      }
    }
    for (const [ox, oy] of [[-10, -7], [10, -7], [-10, 7], [10, 7]] as const) {
      world.setRaw(cx + ox, cy + oy, MAT.BEDROCK);
      world.setRaw(cx + ox + 1, cy + oy, MAT.FOSSIL);
    }
    cacheX = cx;
    cacheY = cy;
  }
  // The cache and cardinal approach are always traversable after decoration.
  for (let offset = -2; offset <= 2; offset++) {
    world.setRaw(cacheX + offset, cacheY, MAT.EMPTY);
    world.setRaw(cacheX, cacheY + offset, MAT.EMPTY);
  }
  return { kind, x: cx, y: cy, cacheX, cacheY };
}

/* ---------------- Natural bedrock base anchors ---------------- */

type BedrockKind = "line" | "L" | "U" | "S";

/** Place randomly rotated, organic ridge formations throughout solid rock.
 *  This does not seek tunnels and never fills existing empty cells. Every
 *  painted cell independently respects player/bot spawn clearance. */
function stageBedrockFormations(ctx: Ctx): void {
  const { world, size, bal } = ctx;
  const rng = ctx.rng.fork(67);
  const kinds: BedrockKind[] = ["line", "L", "U", "S"];
  const kindOffset = rng.nextInt(kinds.length);
  const clearance = bal.mapgen.bedrockSpawnClearanceCells;
  const clearance2 = clearance * clearance;
  const eligible = (m: number) => m === MAT.SOFT || m === MAT.DENSE || m === MAT.HARD || m === MAT.UNSTABLE;
  const canPaint = (x: number, y: number): boolean => {
    if (!world.inBounds(x, y) || !eligible(world.get(x, y))) return false;
    for (const s of ctx.spawns) if ((s.x - x) ** 2 + (s.y - y) ** 2 < clearance2) return false;
    return true;
  };

  let placed = 0;
  let guard = bal.mapgen.bedrockFormations * 250;
  while (placed < bal.mapgen.bedrockFormations && guard-- > 0) {
    const cx = rng.range(65, size - 65);
    const cy = rng.range(65, size - 65);
    if (!canPaint(cx, cy)) continue;

    const kind = kinds[(placed + kindOffset) % kinds.length];
    const length = rng.range(30, 58);
    const height = rng.range(20, 42);
    const local = bedrockShapePoints(kind, length, height, rng);
    const angle = rng.nextFloat() * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const points = local.map((p) => ({
      x: cx + p.x * cos - p.y * sin,
      y: cy + p.x * sin + p.y * cos
    }));
    const baseRadius = rng.range(bal.mapgen.bedrockThicknessMinCells, bal.mapgen.bedrockThicknessMaxCells);
    let changed = paintBedrockStroke(
      world,
      points,
      baseRadius,
      rng,
      canPaint
    );
    const spurCount = rng.chance(0.68) ? 1 + (rng.chance(0.24) ? 1 : 0) : 0;
    for (let spur = 0; spur < spurCount; spur++) {
      changed += paintBedrockStroke(
        world,
        bedrockSpurPoints(points, rng),
        Math.max(4, Math.round(baseRadius * randomBetween(rng, 0.48, 0.72))),
        rng,
        canPaint
      );
    }
    if (changed < 80) continue;
    ctx.bedrockFormations.push({ x: cx, y: cy, kind });
    placed++;
  }
}

/* ---------------- Fossil ruins and protected treasure ---------------- */

function stageRuins(ctx: Ctx): void {
  const { world, size, bal } = ctx;
  const rng = ctx.rng.fork(72);
  const wanted = bal.mapgen.ruinCount;
  const clearance2 = bal.treasure.ruinSpawnClearanceCells ** 2;
  let guard = wanted * 500;
  while (ctx.ruins.length < wanted && guard-- > 0) {
    const cx = rng.range(30, size - 30);
    const cy = rng.range(30, size - 30);
    if (ctx.spawns.some((spawn) => (spawn.x - cx) ** 2 + (spawn.y - cy) ** 2 < clearance2)) continue;
    if (ctx.ruins.some((ruin) => (ruin.x - cx) ** 2 + (ruin.y - cy) ** 2 < 70 ** 2)) continue;
    if (ctx.specialSites.some((site) => (site.x - cx) ** 2 + (site.y - cy) ** 2 < 82 ** 2)) continue;
    if (world.get(cx, cy) === MAT.BEDROCK || world.get(cx, cy) === MAT.EMPTY) continue;

    const rx = rng.range(11, 16);
    const ry = rng.range(9, 13);
    const ruinPhase = rng.nextFloat() * Math.PI * 2;
    const entranceSide = rng.nextInt(4);
    let carved = 0;
    for (let y = cy - ry - 2; y <= cy + ry + 2; y++) {
      for (let x = cx - rx - 2; x <= cx + rx + 2; x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const angle = Math.atan2(ny, nx);
        const architecturalWarp = Math.sin(angle * 3 + ruinPhase) * 0.055 + Math.sin(angle * 7 - ruinPhase * 0.7) * 0.025;
        const noise = ((rng.nextU32() % 31) - 15) / 120;
        const d = nx * nx + ny * ny;
        if (d < 0.78 + architecturalWarp + noise && world.get(x, y) !== MAT.BEDROCK) {
          world.setRaw(x, y, MAT.EMPTY);
          carved++;
        } else if (d < 1.13 + architecturalWarp + noise && canHostDeposit(world.get(x, y))) {
          world.setRaw(x, y, MAT.FOSSIL);
        }
      }
    }
    if (carved < 180) continue;

    // Two eroded side chapels stop each site reading as a simple oval.
    const horizontalEntrance = entranceSide === 0 || entranceSide === 2;
    for (const side of [-1, 1]) {
      const alcoveX = cx + (horizontalEntrance ? 0 : side * Math.round(rx * 0.68));
      const alcoveY = cy + (horizontalEntrance ? side * Math.round(ry * 0.68) : 0);
      const alcoveRx = horizontalEntrance ? rng.range(4, 6) : rng.range(3, 5);
      const alcoveRy = horizontalEntrance ? rng.range(3, 5) : rng.range(4, 6);
      for (let oy = -alcoveRy - 1; oy <= alcoveRy + 1; oy++) for (let ox = -alcoveRx - 1; ox <= alcoveRx + 1; ox++) {
        const d = (ox / alcoveRx) ** 2 + (oy / alcoveRy) ** 2;
        const x = alcoveX + ox;
        const y = alcoveY + oy;
        if (d < 0.68 && world.get(x, y) !== MAT.BEDROCK) world.setRaw(x, y, MAT.EMPTY);
        else if (d < 1.08 && canHostDeposit(world.get(x, y))) world.setRaw(x, y, MAT.FOSSIL);
      }
    }

    // A broken eight-piece reliquary surrounds the chest while leaving a wide
    // cardinal cross open for combat and automatic walk-over collection.
    const reliquary = [
      [-3, -2], [-2, -3], [2, -3], [3, -2],
      [3, 2], [2, 3], [-2, 3], [-3, 2]
    ] as const;
    for (let i = 0; i < reliquary.length; i++) {
      if ((i + entranceSide) % 5 === 0) continue;
      const [ox, oy] = reliquary[i];
      if (world.get(cx + ox, cy + oy) === MAT.EMPTY) world.setRaw(cx + ox, cy + oy, MAT.FOSSIL);
    }

    // Layered, chipped columns use dark bedrock feet and pale fossil shafts.
    // Their staggered profiles remain traversable but give the room a readable
    // top-down architectural silhouette.
    for (let column = 0; column < 4; column++) {
      const sx = column % 2 === 0 ? -1 : 1;
      const sy = column < 2 ? -1 : 1;
      const anchorX = cx + sx * rng.range(5, 7);
      const anchorY = cy + sy * rng.range(4, 6);
      const length = rng.range(3, 6);
      const vertical = (column + entranceSide) % 2 === 0;
      for (let i = 0; i < length; i++) {
        if (i === length - 2 && rng.chance(0.45)) continue;
        const x = anchorX + (vertical ? 0 : i * (sx > 0 ? -1 : 1));
        const y = anchorY + (vertical ? i * (sy > 0 ? -1 : 1) : 0);
        if (world.get(x, y) !== MAT.EMPTY) continue;
        world.setRaw(x, y, i === 0 || i === length - 1 ? MAT.BEDROCK : MAT.FOSSIL);
        if (i > 0 && i < length - 1 && rng.chance(0.34)) {
          const trimX = x + (vertical ? sx : 0);
          const trimY = y + (vertical ? 0 : sy);
          if (world.get(trimX, trimY) === MAT.EMPTY) world.setRaw(trimX, trimY, MAT.FOSSIL);
        }
      }
    }

    // Bone splinters and collapsed masonry give every chamber a different
    // history without cluttering the approach to the chest.
    for (let fragment = 0; fragment < rng.range(8, 15); fragment++) {
      const angle = rng.nextFloat() * Math.PI * 2;
      const radius = rng.range(5, Math.max(6, Math.min(rx, ry) - 2));
      const x = Math.round(cx + Math.cos(angle) * radius);
      const y = Math.round(cy + Math.sin(angle) * radius * 0.7);
      if (world.get(x, y) === MAT.EMPTY) world.setRaw(x, y, rng.chance(0.18) ? MAT.BEDROCK : MAT.FOSSIL);
    }

    // Guarantee the treasure itself and a generous four-way approach remain open.
    for (let offset = -2; offset <= 2; offset++) {
      world.setRaw(cx + offset, cy, MAT.EMPTY);
      world.setRaw(cx, cy + offset, MAT.EMPTY);
    }

    const guardians: { x: number; y: number }[] = [];
    for (let i = 0; i < bal.treasure.guardiansPerRuin; i++) {
      const angle = (i / Math.max(1, bal.treasure.guardiansPerRuin)) * Math.PI * 2 + rng.nextFloat();
      guardians.push({ x: Math.round(cx + Math.cos(angle) * 6), y: Math.round(cy + Math.sin(angle) * 5) });
    }
    ctx.ruins.push({ x: cx, y: cy, chestX: cx, chestY: cy, guardians });
  }
}

interface BedrockPoint { x: number; y: number }

/** Create an asymmetric, curved path whose kind is only a loose topology. */
function bedrockShapePoints(kind: BedrockKind, length: number, height: number, rng: Rng): BedrockPoint[] {
  const jitter = (amount: number) => randomBetween(rng, -amount, amount);
  let anchors: BedrockPoint[];

  if (kind === "line") {
    const count = rng.range(5, 8);
    const phase = rng.nextFloat() * Math.PI * 2;
    const bends = randomBetween(rng, 0.8, 1.8);
    const amplitude = randomBetween(rng, 0.12, 0.34) * height;
    anchors = Array.from({ length: count }, (_, i) => {
      const t = i / (count - 1);
      return {
        x: (t - 0.5) * length + jitter(length * 0.035),
        y: Math.sin(phase + t * Math.PI * 2 * bends) * amplitude + jitter(height * 0.1)
      };
    });
  } else if (kind === "L") {
    const cornerX = -length * randomBetween(rng, 0.22, 0.42);
    const cornerY = height * randomBetween(rng, 0.2, 0.44);
    anchors = [
      { x: cornerX + jitter(length * 0.08), y: -height * randomBetween(rng, 0.42, 0.62) },
      { x: cornerX + jitter(length * 0.09), y: -height * randomBetween(rng, 0.02, 0.2) },
      { x: cornerX + jitter(length * 0.07), y: cornerY + jitter(height * 0.07) },
      { x: length * randomBetween(rng, -0.05, 0.18), y: cornerY + jitter(height * 0.1) },
      { x: length * randomBetween(rng, 0.4, 0.62), y: cornerY + jitter(height * 0.13) }
    ];
  } else if (kind === "U") {
    const left = -length * randomBetween(rng, 0.35, 0.57);
    const right = length * randomBetween(rng, 0.35, 0.57);
    const floor = height * randomBetween(rng, 0.28, 0.5);
    anchors = [
      { x: left + jitter(length * 0.06), y: -height * randomBetween(rng, 0.36, 0.62) },
      { x: left + jitter(length * 0.09), y: jitter(height * 0.08) },
      { x: left + jitter(length * 0.06), y: floor + jitter(height * 0.07) },
      { x: jitter(length * 0.1), y: floor + jitter(height * 0.1) },
      { x: right + jitter(length * 0.06), y: floor + jitter(height * 0.07) },
      { x: right + jitter(length * 0.09), y: jitter(height * 0.1) },
      { x: right + jitter(length * 0.07), y: -height * randomBetween(rng, 0.3, 0.64) }
    ];
  } else {
    const count = rng.range(9, 14);
    const phase = randomBetween(rng, -0.35, 0.35);
    const cycles = randomBetween(rng, 0.82, 1.18);
    const lean = jitter(height * 0.32);
    anchors = Array.from({ length: count }, (_, i) => {
      const t = i / (count - 1);
      const envelope = randomBetween(rng, 0.84, 1.12);
      return {
        x: (t - 0.5) * length + jitter(length * 0.035),
        y: Math.sin(phase + t * Math.PI * 2 * cycles) * (height / 2) * envelope + (t - 0.5) * lean + jitter(height * 0.06)
      };
    });
  }

  const mirrorX = rng.chance(0.5) ? -1 : 1;
  const mirrorY = rng.chance(0.5) ? -1 : 1;
  return smoothBedrockPath(anchors.map((p) => ({ x: p.x * mirrorX, y: p.y * mirrorY })), rng.range(2, 3));
}

/** Chaikin subdivision rounds template corners without forcing a perfect arc. */
function smoothBedrockPath(points: BedrockPoint[], passes: number): BedrockPoint[] {
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    const next: BedrockPoint[] = [current[0]];
    for (let i = 0; i + 1 < current.length; i++) {
      const a = current[i];
      const b = current[i + 1];
      next.push(
        { x: a.x * 0.72 + b.x * 0.28, y: a.y * 0.72 + b.y * 0.28 },
        { x: a.x * 0.28 + b.x * 0.72, y: a.y * 0.28 + b.y * 0.72 }
      );
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/** Add a short, tapering side ridge so formations do not read as single tubes. */
function bedrockSpurPoints(points: BedrockPoint[], rng: Rng): BedrockPoint[] {
  const index = rng.range(Math.max(1, Math.floor(points.length * 0.18)), Math.min(points.length - 2, Math.ceil(points.length * 0.82)));
  const anchor = points[index];
  const before = points[index - 1];
  const after = points[index + 1];
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const tx = dx / length;
  const ty = dy / length;
  const side = rng.chance(0.5) ? -1 : 1;
  const nx = -ty * side;
  const ny = tx * side;
  const reach = rng.range(13, 29);
  const skew = randomBetween(rng, -0.42, 0.42) * reach;
  return smoothBedrockPath([
    anchor,
    { x: anchor.x + nx * reach * 0.34 + tx * skew * 0.25, y: anchor.y + ny * reach * 0.34 + ty * skew * 0.25 },
    { x: anchor.x + nx * reach * 0.72 + tx * skew * 0.68, y: anchor.y + ny * reach * 0.72 + ty * skew * 0.68 },
    { x: anchor.x + nx * reach + tx * skew, y: anchor.y + ny * reach + ty * skew }
  ], 2);
}

function randomBetween(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng.nextFloat();
}

function paintBedrockStroke(
  world: World,
  points: { x: number; y: number }[],
  baseRadius: number,
  rng: Rng,
  canPaint: (x: number, y: number) => boolean
): number {
  let changed = 0;
  const lengths = points.slice(0, -1).map((p, i) => Math.max(1, Math.hypot(points[i + 1].x - p.x, points[i + 1].y - p.y)));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const lateralPhaseA = rng.nextFloat() * Math.PI * 2;
  const lateralPhaseB = rng.nextFloat() * Math.PI * 2;
  const lateralCyclesA = randomBetween(rng, 0.7, 1.8);
  const lateralCyclesB = randomBetween(rng, 2.2, 4.6);
  const lateralAmountA = randomBetween(rng, 0.18, 0.48) * baseRadius;
  const lateralAmountB = randomBetween(rng, 0.08, 0.22) * baseRadius;
  const thicknessPhaseA = rng.nextFloat() * Math.PI * 2;
  const thicknessPhaseB = rng.nextFloat() * Math.PI * 2;
  const thicknessCyclesA = randomBetween(rng, 0.65, 1.65);
  const thicknessCyclesB = randomBetween(rng, 2.0, 3.8);
  const thicknessAmountA = randomBetween(rng, 0.22, 0.38) * baseRadius;
  const thicknessAmountB = randomBetween(rng, 0.08, 0.18) * baseRadius;
  let travelled = 0;
  for (let segment = 0; segment + 1 < points.length; segment++) {
    const a = points[segment];
    const b = points[segment + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = lengths[segment];
    // Radius is always at least four cells, so one sample per 1.35 cells
    // overlaps generously while avoiding redundant large-disc raster work.
    const steps = Math.ceil(len / 1.35);
    const nx = -dy / len;
    const ny = dx / len;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const progress = (travelled + t * len) / totalLength;
      const wobble =
        Math.sin(lateralPhaseA + progress * Math.PI * 2 * lateralCyclesA) * lateralAmountA +
        Math.sin(lateralPhaseB + progress * Math.PI * 2 * lateralCyclesB) * lateralAmountB +
        randomBetween(rng, -0.35, 0.35);
      const x = Math.round(a.x + dx * t + nx * wobble);
      const y = Math.round(a.y + dy * t + ny * wobble);
      const radius = Math.max(4, Math.round(
        baseRadius +
        Math.sin(thicknessPhaseA + progress * Math.PI * 2 * thicknessCyclesA) * thicknessAmountA +
        Math.sin(thicknessPhaseB + progress * Math.PI * 2 * thicknessCyclesB) * thicknessAmountB +
        randomBetween(rng, -0.7, 0.7)
      ));
      changed += paintBedrockDisc(world, x, y, radius, rng, canPaint);
    }
    travelled += len;
  }
  return changed;
}

function paintBedrockDisc(
  world: World,
  cx: number,
  cy: number,
  radius: number,
  rng: Rng,
  canPaint: (x: number, y: number) => boolean
): number {
  let changed = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      if (d2 > (radius - 2) ** 2 && rng.chance(d2 > (radius - 1) ** 2 ? 0.52 : 0.2)) continue;
      if (!canPaint(x, y)) continue;
      world.setRaw(x, y, MAT.BEDROCK);
      changed++;
    }
  }
  return changed;
}

/* ---------------- Stage F: vents ---------------- */

function stageVents(ctx: Ctx): void {
  const { world, bal } = ctx;
  const rng = ctx.rng.fork(77);
  // Vents near chambers + near spawns so every spawn can reach breathable air.
  const targets: { x: number; y: number }[] = [
    ...ctx.spawns,
    ...ctx.chambers
  ].slice(0, Math.max(0, bal.mapgen.ventCount - ctx.ventCells.length));
  for (const t of targets) {
    // find empty cell near target with a solid neighbor to mount the vent
    let done = false;
    for (let tries = 0; tries < 200 && !done; tries++) {
      const ang = rng.nextFloat() * Math.PI * 2;
      const d = rng.range(2, 10);
      const x = Math.round(t.x + Math.cos(ang) * d);
      const y = Math.round(t.y + Math.sin(ang) * d);
      if (world.get(x, y) !== MAT.EMPTY) continue;
      world.setRaw(x, y, MAT.VENT);
      ctx.ventCells.push({ x, y });
      done = true;
    }
  }
}

/* ---------------- Stage G: gems ---------------- */

function stageGems(ctx: Ctx): void {
  const { world, size, bal } = ctx;
  const rng = ctx.rng.fork(88);
  let placed = 0;
  let guard = 8000;
  while (placed < bal.mapgen.gemClusters && guard-- > 0) {
    const x = rng.range(16, size - 16);
    const y = rng.range(16, size - 16);
    const m = world.get(x, y);
    if (m !== MAT.SOFT && m !== MAT.DENSE) continue;
    // richer clusters far from spawns
    let minSpawnD = Infinity;
    for (const s of ctx.spawns) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < minSpawnD) minSpawnD = d;
    }
    if (minSpawnD < 30) continue;
    const rich = minSpawnD > 220;
    const r = rich ? rng.range(3, 5) : rng.range(1, 3);
    blob(world, x, y, r, rng, (mm) => (mm === MAT.SOFT || mm === MAT.DENSE || mm === MAT.UNSTABLE ? MAT.GEM : mm));
    placed++;
  }
  // Thousands of isolated common gems break up the large rock fields and
  // make early bomb mining pay off even when it misses a rich cluster.
  placeSingleDeposits(ctx, rng, MAT.GEM, bal.mapgen.singleGemDeposits);
  // Scarcer blue reinforcement crystal unlocks rigid wall construction.
  placed = 0;
  guard = 6000;
  while (placed < bal.mapgen.reinforceGemClusters && guard-- > 0) {
    const x = rng.range(16, size - 16);
    const y = rng.range(16, size - 16);
    const m = world.get(x, y);
    if (m !== MAT.SOFT && m !== MAT.DENSE && m !== MAT.UNSTABLE) continue;
    let minSpawnD = Infinity;
    for (const s of ctx.spawns) minSpawnD = Math.min(minSpawnD, Math.hypot(s.x - x, s.y - y));
    if (minSpawnD < 50) continue;
    const r = rng.range(1, 2);
    blob(world, x, y, r, rng, (mm) =>
      mm === MAT.SOFT || mm === MAT.DENSE || mm === MAT.UNSTABLE ? MAT.REINFORCE_GEM : mm
    );
    placed++;
  }
  // loose gems in chambers
  for (const c of ctx.chambers) {
    const n = rng.range(1, 3);
    for (let i = 0; i < n; i++) {
      const ang = rng.nextFloat() * Math.PI * 2;
      const d = rng.nextFloat() * c.r * 0.7;
      const x = Math.round(c.x + Math.cos(ang) * d);
      const y = Math.round(c.y + Math.sin(ang) * d);
      if (world.get(x, y) === MAT.EMPTY) {
        ctx.looseGems.push({ x, y, kind: rng.chance(0.18) ? "reinforce" : "common" });
      }
    }
  }
}

/* ---------------- Stage G2: crafting ores and fossils ---------------- */

function stageCraftMaterials(ctx: Ctx): void {
  const { bal } = ctx;
  const rng = ctx.rng.fork(89);
  const defs = [
    { mat: MAT.GOLD, singles: bal.mapgen.goldSingles, clusters: bal.mapgen.goldClusters, minR: 1, maxR: 2 },
    { mat: MAT.FOSSIL, singles: bal.mapgen.fossilSingles, clusters: bal.mapgen.fossilClusters, minR: 1, maxR: 3 },
    { mat: MAT.COPPER, singles: bal.mapgen.copperSingles, clusters: bal.mapgen.copperClusters, minR: 2, maxR: 4 },
    { mat: MAT.IRON, singles: bal.mapgen.ironSingles, clusters: bal.mapgen.ironClusters, minR: 2, maxR: 4 },
    { mat: MAT.PLATINUM, singles: bal.mapgen.platinumSingles, clusters: bal.mapgen.platinumClusters, minR: 1, maxR: 2 },
    { mat: MAT.COAL, singles: bal.mapgen.coalSingles, clusters: bal.mapgen.coalClusters, minR: 2, maxR: 5 }
  ];

  // Give every spawn direction several nearby discoveries without putting
  // resources inside the open starting room itself.
  for (const spawn of ctx.spawns) {
    for (const mat of [MAT.GEM, MAT.COPPER, MAT.IRON, MAT.COAL]) {
      placeNearSpawn(ctx, rng, spawn, mat);
      placeNearSpawn(ctx, rng, spawn, mat);
    }
  }

  for (const def of defs) {
    placeSingleDeposits(ctx, rng, def.mat, def.singles);
    let placed = 0;
    let guard = Math.max(1000, def.clusters * 80);
    while (placed < def.clusters && guard-- > 0) {
      const x = rng.range(16, ctx.size - 16);
      const y = rng.range(16, ctx.size - 16);
      if (!canHostDeposit(ctx.world.get(x, y))) continue;
      const changed = blob(ctx.world, x, y, rng.range(def.minR, def.maxR), rng, (mat) =>
        canHostDeposit(mat) ? def.mat : mat
      );
      if (changed > 0) placed++;
    }
  }
}

/* ---------------- Sparse ambient tunnel creatures ---------------- */

function stageAmbientEnemies(ctx: Ctx): void {
  const rng = new Rng(ctx.seed ^ 0xa8b1e17);
  const anchors = [
    ...ctx.ancientTunnels.map(({ x, y }) => ({ x, y })),
    ...ctx.chambers.map(({ x, y }) => ({ x, y }))
  ];
  // Keep the opening economy quiet; creatures belong deeper in the network and
  // should become a discovery rather than immediately override starter gems.
  const spawnClearance2 = Math.max(180, Math.floor(ctx.bal.mapgen.landmarkSpawnClearanceCells * 2.2)) ** 2;
  let guard = ctx.bal.mapgen.ambientEnemies * 240;
  while (ctx.ambientEnemies.length < ctx.bal.mapgen.ambientEnemies && guard-- > 0) {
    const anchor = anchors[rng.nextInt(anchors.length)];
    const angle = rng.nextFloat() * Math.PI * 2;
    const distance = rng.range(0, 28);
    const x = Math.round(anchor.x + Math.cos(angle) * distance);
    const y = Math.round(anchor.y + Math.sin(angle) * distance);
    const worldMargin = Math.min(180, Math.floor(ctx.size * 0.14));
    if (x < worldMargin || y < worldMargin || x >= ctx.size - worldMargin || y >= ctx.size - worldMargin) continue;
    if (!ctx.world.inBounds(x, y) || ctx.world.get(x, y) !== MAT.EMPTY) continue;
    if (ctx.spawns.some((spawn) => (spawn.x - x) ** 2 + (spawn.y - y) ** 2 < spawnClearance2)) continue;
    if (ctx.specialSites.some((site) => (site.cacheX - x) ** 2 + (site.cacheY - y) ** 2 < 24 ** 2)) continue;
    if (ctx.ambientEnemies.some((enemy) => (enemy.x - x) ** 2 + (enemy.y - y) ** 2 < 12 ** 2)) continue;
    const nearestVolcano = ctx.specialSites.find((site) => site.kind === "volcano");
    const volcanic = nearestVolcano !== undefined && (nearestVolcano.x - x) ** 2 + (nearestVolcano.y - y) ** 2 < 170 ** 2;
    const variant: AmbientEnemySpawn["variant"] = volcanic && rng.chance(0.72)
      ? "emberling"
      : rng.chance(0.28) ? "wraith" : "crawler";
    ctx.ambientEnemies.push({ x, y, variant });
  }
}

function placeSingleDeposits(ctx: Ctx, rng: Rng, mat: number, count: number): void {
  let placed = 0;
  let guard = Math.max(1000, count * 30);
  while (placed < count && guard-- > 0) {
    const x = rng.range(8, ctx.size - 8);
    const y = rng.range(8, ctx.size - 8);
    if (!canHostDeposit(ctx.world.get(x, y))) continue;
    ctx.world.setRaw(x, y, mat);
    placed++;
  }
}

function placeNearSpawn(
  ctx: Ctx,
  rng: Rng,
  spawn: { x: number; y: number },
  mat: number
): void {
  for (let tries = 0; tries < 80; tries++) {
    const angle = rng.nextFloat() * Math.PI * 2;
    const distance = rng.range(ctx.bal.mapgen.spawnPocketRadiusCells + 3, ctx.bal.mapgen.spawnPocketRadiusCells + 18);
    const x = Math.round(spawn.x + Math.cos(angle) * distance);
    const y = Math.round(spawn.y + Math.sin(angle) * distance);
    if (!canHostDeposit(ctx.world.get(x, y))) continue;
    ctx.world.setRaw(x, y, mat);
    return;
  }
}

function canHostDeposit(mat: number): boolean {
  return mat === MAT.SOFT || mat === MAT.DENSE || mat === MAT.HARD || mat === MAT.UNSTABLE;
}

/* ---------------- Stage I: validation ---------------- */

function validate(map: GeneratedMap, bal: Balance, playerCount: number): boolean {
  const { world, spawns, chambers } = map;
  if (chambers.length < bal.mapgen.chambersMin) return false;
  if (spawns.length !== playerCount) return false;

  // open-area fraction
  let open = 0;
  for (let i = 0; i < world.mat.length; i++) if (world.mat[i] === MAT.EMPTY) open++;
  const frac = open / world.mat.length;
  if (frac > bal.mapgen.maxOpenFraction || frac < 0.04) return false;

  // every spawn must reach a vent through empty-or-diggable terrain
  for (const s of spawns) {
    if (!canReachVent(world, s.x, s.y)) return false;
  }
  return true;
}

/** BFS treating empty and all miner-diggable deposits as passable. */
function canReachVent(world: World, sx: number, sy: number): boolean {
  const size = world.size;
  const seen = new Set<number>();
  const queue = new Int32Array(65536);
  let head = 0;
  let tail = 0;
  const start = sy * size + sx;
  seen.add(start);
  queue[tail++] = start;
  const passable = (m: number) =>
    m === MAT.EMPTY ||
    m === MAT.SOFT ||
    m === MAT.DENSE ||
    m === MAT.GEM ||
    m === MAT.REINFORCE_GEM ||
    m === MAT.GOLD ||
    m === MAT.FOSSIL ||
    m === MAT.COPPER ||
    m === MAT.IRON ||
    m === MAT.PLATINUM ||
    m === MAT.COAL ||
    m === MAT.UNSTABLE ||
    m === MAT.VENT;
  let steps = 0;
  while (head < tail && steps < 60000) {
    steps++;
    const i = queue[(head++) % queue.length];
    if (world.mat[i] === MAT.VENT) return true;
    const x = i % size;
    const y = (i / size) | 0;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1]
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const ni = ny * size + nx;
      if (seen.has(ni)) continue;
      if (!passable(world.mat[ni])) continue;
      seen.add(ni);
      queue[(tail++) % queue.length] = ni;
      if (tail - head >= queue.length) return true; // huge open reach — fine
    }
  }
  return false;
}

/* ---------------- helpers ---------------- */

function blob(
  world: World,
  cx: number,
  cy: number,
  r: number,
  rng: Rng,
  transform: (m: number) => number
): number {
  let changed = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      if (d2 > (r - 1) * (r - 1) && rng.chance(0.4)) continue; // rough edge
      if (!world.inBounds(x, y)) continue;
      const m = world.get(x, y);
      const nm = transform(m);
      if (nm !== m) {
        world.setRaw(x, y, nm);
        changed++;
      }
    }
  }
  return changed;
}

function blobRing(world: World, cx: number, cy: number, r0: number, r1: number, rng: Rng, mat: number): void {
  for (let y = cy - r1; y <= cy + r1; y++) {
    for (let x = cx - r1; x <= cx + r1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < r0 * r0 || d2 > r1 * r1) continue;
      if (!world.inBounds(x, y)) continue;
      const m = world.get(x, y);
      if (m !== MAT.EMPTY && m !== MAT.VENT) world.setRaw(x, y, mat);
    }
  }
}
