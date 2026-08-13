/** Deterministic PRNG (sfc32-like, integer state). Separate streams should
 *  be created per subsystem (mapgen, loot, collapse) per the spec. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // splitmix-style seeding
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 8; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (this.a + this.b) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.d = (this.d + 1) >>> 0;
    const r = (t + this.d) >>> 0;
    this.c = (this.c + r) >>> 0;
    return r;
  }

  /** [0, n) */
  nextInt(n: number): number {
    return this.nextU32() % n;
  }

  /** [min, max] inclusive */
  range(min: number, max: number): number {
    return min + this.nextInt(max - min + 1);
  }

  /** [0,1) float — for generation weighting only, never for network logic */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  chance(p: number): boolean {
    return this.nextU32() < p * 4294967296;
  }

  fork(label: number): Rng {
    return new Rng((this.nextU32() ^ Math.imul(label, 0x9e3779b1)) >>> 0);
  }
}

/** Deterministic 2D hash for value noise (mapgen + cosmetic variation). */
export function hash2(x: number, y: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Bilinear value noise in [0,1). */
export function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = hash2(x0, y0, seed) / 4294967296;
  const v10 = hash2(x0 + 1, y0, seed) / 4294967296;
  const v01 = hash2(x0, y0 + 1, seed) / 4294967296;
  const v11 = hash2(x0 + 1, y0 + 1, seed) / 4294967296;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

export function fbm(x: number, y: number, seed: number): number {
  return (
    valueNoise(x, y, 96, seed) * 0.5 +
    valueNoise(x, y, 40, seed ^ 0x1234) * 0.3 +
    valueNoise(x, y, 16, seed ^ 0xabcd) * 0.2
  );
}
