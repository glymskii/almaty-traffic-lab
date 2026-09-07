import { describe, expect, it } from "vitest";
import { Rng } from "../src/rng.ts";

describe("Rng", () => {
  it("is reproducible for the same seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it("differs across seeds", () => {
    expect(new Rng(1).nextU32()).not.toBe(new Rng(2).nextU32());
  });

  it("forks independent streams deterministically", () => {
    const a = new Rng(7).fork(3);
    const b = new Rng(7).fork(3);
    const c = new Rng(7).fork(4);
    expect(a.nextU32()).toBe(b.nextU32());
    expect(a.nextU32()).not.toBe(c.nextU32());
  });

  it("samples truncated normals inside bounds with the right mean", () => {
    const rng = new Rng(3);
    const d = { mean: 1.2, sd: 0.3, min: 0.6, max: 2.5 };
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = rng.sample(d);
      expect(v).toBeGreaterThanOrEqual(d.min);
      expect(v).toBeLessThanOrEqual(d.max);
      sum += v;
    }
    expect(Math.abs(sum / n - d.mean)).toBeLessThan(0.02);
  });

  it("float is uniform on [0,1)", () => {
    const rng = new Rng(11);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100000; i++) buckets[Math.floor(rng.float() * 10)]++;
    for (const b of buckets) expect(Math.abs(b - 10000)).toBeLessThan(600);
  });
});
