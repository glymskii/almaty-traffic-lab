import type { Distribution } from "@atl/contracts";

/**
 * Deterministic PRNG: xoshiro128** seeded through splitmix32.
 * The only source of randomness allowed in sim-core. `fork()` derives independent streams
 * so that adding a random draw in one subsystem does not change the sequence of another.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform 32-bit integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** Bernoulli trial. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty array");
    return items[this.int(items.length)] as T;
  }

  /** Standard normal via Box-Muller. */
  normal(mean = 0, sd = 1): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return mean + sd * v;
    }
    let u1 = this.float();
    while (u1 <= 1e-12) u1 = this.float();
    const u2 = this.float();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    this.spareNormal = r * Math.sin(theta);
    return mean + sd * r * Math.cos(theta);
  }

  /** Truncated normal by clamping (bias is acceptable for driver heterogeneity). */
  sample(d: Distribution): number {
    const v = this.normal(d.mean, d.sd);
    return Math.min(d.max, Math.max(d.min, v));
  }

  /** Exponential inter-arrival time for a Poisson process with the given rate (events per second). */
  exponential(ratePerS: number): number {
    if (ratePerS <= 0) return Number.POSITIVE_INFINITY;
    let u = this.float();
    while (u <= 1e-12) u = this.float();
    return -Math.log(u) / ratePerS;
  }

  /** Independent child stream. Same parent state + same label => same child. */
  fork(label: number): Rng {
    return new Rng((this.nextU32() ^ Math.imul(label + 1, 0x9e3779b9)) >>> 0);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
