import { MAT, MAT_HP, isSolidMat } from "./materials";
import { hash2 } from "./rng";

export interface CellChange {
  x: number;
  y: number;
  mat: number;
}

/** Chunked destructible terrain. Materials in a flat Uint8Array; per-cell
 *  accumulated dig damage in a parallel array (not networked). Chunk
 *  revisions bump on every mutation for sync/repair. */
export class World {
  readonly size: number;
  readonly chunkSize: number;
  readonly chunksPerSide: number;
  readonly mat: Uint8Array;
  readonly dmg: Uint8Array;
  readonly revisions: Uint32Array;

  constructor(size: number, chunkSize: number, trackDamage = true) {
    this.size = size;
    this.chunkSize = chunkSize;
    this.chunksPerSide = Math.ceil(size / chunkSize);
    this.mat = new Uint8Array(size * size);
    // Client mirrors never apply dig damage locally; omitting this buffer saves
    // 16 MiB per browser on a 4096² world.
    this.dmg = new Uint8Array(trackDamage ? size * size : 0);
    this.revisions = new Uint32Array(this.chunksPerSide * this.chunksPerSide);
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return MAT.HARD;
    return this.mat[this.idx(x, y)];
  }

  isSolid(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    return isSolidMat(this.mat[this.idx(x, y)]);
  }

  chunkIndexOf(x: number, y: number): number {
    const cx = (x / this.chunkSize) | 0;
    const cy = (y / this.chunkSize) | 0;
    return cy * this.chunksPerSide + cx;
  }

  /** Raw set without revision bump — generation only. */
  setRaw(x: number, y: number, m: number): void {
    if (!this.inBounds(x, y)) return;
    this.mat[this.idx(x, y)] = m;
  }

  /** Mutation with revision bump. Returns the change record. */
  set(x: number, y: number, m: number): CellChange | null {
    if (!this.inBounds(x, y)) return null;
    const i = this.idx(x, y);
    if (this.mat[i] === m) return null;
    this.mat[i] = m;
    if (this.dmg.length) this.dmg[i] = 0;
    this.revisions[this.chunkIndexOf(x, y)]++;
    return { x, y, mat: m };
  }

  /** FNV-1a checksum of chunk material bytes. */
  chunkChecksum(cx: number, cy: number): number {
    let h = 0x811c9dc5;
    const x0 = cx * this.chunkSize;
    const y0 = cy * this.chunkSize;
    for (let y = y0; y < y0 + this.chunkSize; y++) {
      const row = y * this.size;
      for (let x = x0; x < x0 + this.chunkSize; x++) {
        h ^= this.mat[row + x];
        h = Math.imul(h, 0x01000193);
      }
    }
    return h >>> 0;
  }

  worldChecksum(): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.mat.length; i++) {
      h ^= this.mat[i];
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** Simple RLE encoding of chunk materials (runs of [count u8, mat u8]). */
  encodeChunkRLE(cx: number, cy: number): Uint8Array {
    const out: number[] = [];
    const x0 = cx * this.chunkSize;
    const y0 = cy * this.chunkSize;
    let runMat = -1;
    let runLen = 0;
    const flush = () => {
      while (runLen > 0) {
        const n = Math.min(runLen, 255);
        out.push(n, runMat);
        runLen -= n;
      }
    };
    for (let y = y0; y < y0 + this.chunkSize; y++) {
      const row = y * this.size;
      for (let x = x0; x < x0 + this.chunkSize; x++) {
        const m = this.mat[row + x];
        if (m === runMat) runLen++;
        else {
          flush();
          runMat = m;
          runLen = 1;
        }
      }
    }
    flush();
    return Uint8Array.from(out);
  }

  decodeChunkRLE(cx: number, cy: number, data: Uint8Array, revision: number): void {
    const x0 = cx * this.chunkSize;
    const y0 = cy * this.chunkSize;
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < data.length; i += 2) {
      let n = data[i];
      const m = data[i + 1];
      while (n-- > 0) {
        this.mat[(y0 + y) * this.size + (x0 + x)] = m;
        x++;
        if (x === this.chunkSize) {
          x = 0;
          y++;
        }
      }
    }
    this.revisions[cy * this.chunksPerSide + cx] = revision;
  }
}

export interface DigResult {
  cleared: CellChange[];
  gemCellsCleared: number;
  reinforceGemCellsCleared: number;
  goldCellsCleared: number;
  fossilCellsCleared: number;
  copperCellsCleared: number;
  ironCellsCleared: number;
  platinumCellsCleared: number;
  coalCellsCleared: number;
  unstableCleared: { x: number; y: number }[];
  hitSolid: boolean;
}

/** Deterministic circular brush: applies damage to diggable cells inside
 *  radius; cells whose accumulated damage exceeds material HP become EMPTY. */
export function applyDigBrush(
  world: World,
  cxCell: number,
  cyCell: number,
  radiusCells: number,
  damage: number,
  canDig: (mat: number) => boolean
): DigResult {
  const res: DigResult = {
    cleared: [],
    gemCellsCleared: 0,
    reinforceGemCellsCleared: 0,
    goldCellsCleared: 0,
    fossilCellsCleared: 0,
    copperCellsCleared: 0,
    ironCellsCleared: 0,
    platinumCellsCleared: 0,
    coalCellsCleared: 0,
    unstableCleared: [],
    hitSolid: false
  };
  const r = radiusCells;
  const x0 = Math.max(0, Math.floor(cxCell - r));
  const x1 = Math.min(world.size - 1, Math.ceil(cxCell + r));
  const y0 = Math.max(0, Math.floor(cyCell - r));
  const y1 = Math.min(world.size - 1, Math.ceil(cyCell + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cxCell;
      const dy = y + 0.5 - cyCell;
      // edge noise: ±0.7 cells so tunnels look rough, not perfect circles
      const noise = ((hash2(x, y, 0x5eed) % 141) - 70) / 100;
      const effR = r + noise;
      if (dx * dx + dy * dy > effR * effR) continue;
      const i = world.idx(x, y);
      const m = world.mat[i];
      if (m === MAT.EMPTY) continue;
      if (!canDig(m)) {
        res.hitSolid = true;
        continue;
      }
      res.hitSolid = true;
      const hp = MAT_HP[m] ?? 255;
      if (hp >= 255) continue;
      const nd = world.dmg[i] + damage;
      if (nd >= hp) {
        if (m === MAT.GEM) res.gemCellsCleared++;
        if (m === MAT.REINFORCE_GEM) res.reinforceGemCellsCleared++;
        if (m === MAT.GOLD) res.goldCellsCleared++;
        if (m === MAT.FOSSIL) res.fossilCellsCleared++;
        if (m === MAT.COPPER) res.copperCellsCleared++;
        if (m === MAT.IRON) res.ironCellsCleared++;
        if (m === MAT.PLATINUM) res.platinumCellsCleared++;
        if (m === MAT.COAL) res.coalCellsCleared++;
        if (m === MAT.UNSTABLE) res.unstableCleared.push({ x, y });
        const ch = world.set(x, y, MAT.EMPTY);
        if (ch) res.cleared.push(ch);
      } else {
        world.dmg[i] = nd;
      }
    }
  }
  return res;
}

/** Fill a disc with a material (rubble placement, collapse application). */
export function fillDisc(
  world: World,
  cxCell: number,
  cyCell: number,
  radiusCells: number,
  mat: number,
  filter: (existing: number, x: number, y: number) => boolean
): CellChange[] {
  const changes: CellChange[] = [];
  const r = radiusCells;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cxCell - r));
  const x1 = Math.min(world.size - 1, Math.ceil(cxCell + r));
  const y0 = Math.max(0, Math.floor(cyCell - r));
  const y1 = Math.min(world.size - 1, Math.ceil(cyCell + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cxCell;
      const dy = y + 0.5 - cyCell;
      if (dx * dx + dy * dy > r2) continue;
      const existing = world.mat[world.idx(x, y)];
      if (!filter(existing, x, y)) continue;
      const ch = world.set(x, y, mat);
      if (ch) changes.push(ch);
    }
  }
  return changes;
}

/** Grid line-of-sight between two cell-coordinate points.
 *  Samples the line segment at fine intervals so cells touched by the ray
 *  (including diagonal passes) are checked. The start and end cells are
 *  never treated as solid blockers. */
export function hasLineOfSight(world: World, x0: number, y0: number, x1: number, y1: number): boolean {
  const fx0 = Math.floor(x0);
  const fy0 = Math.floor(y0);
  const fx1 = Math.floor(x1);
  const fy1 = Math.floor(y1);
  if (fx0 === fx1 && fy0 === fy1) return true;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(dist * 1.5); // oversample so diagonals are caught
  let lastCx = fx0;
  let lastCy = fy0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sx = x0 + (x1 - x0) * t;
    const sy = y0 + (y1 - y0) * t;
    const cx = Math.floor(sx);
    const cy = Math.floor(sy);
    if (cx !== lastCx || cy !== lastCy) {
      if ((cx !== fx0 || cy !== fy0) && (cx !== fx1 || cy !== fy1) && world.isSolid(cx, cy)) return false;
    }
    lastCx = cx;
    lastCy = cy;
  }
  return true;
}
