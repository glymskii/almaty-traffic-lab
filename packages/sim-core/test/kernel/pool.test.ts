import { describe, expect, it } from "vitest";
import { VehiclePool } from "../../src/runtime/vehicles.ts";

function order(pool: VehiclePool, track: number): number[] {
  const out: number[] = [];
  let i = pool.trackTail[track] as number;
  while (i >= 0) {
    out.push(i);
    i = pool.ahead[i] as number;
  }
  return out;
}

describe("VehiclePool", () => {
  it("allocates compact slots with increasing ids and recycles released ones", () => {
    const pool = new VehiclePool(3, 1);
    expect(pool.alloc()).toBe(0);
    expect(pool.alloc()).toBe(1);
    expect(pool.alloc()).toBe(2);
    expect(pool.alloc()).toBe(-1);
    expect(pool.activeCount).toBe(3);
    expect(pool.highWater).toBe(3);
    expect(Array.from(pool.id)).toEqual([1, 2, 3]);
    pool.release(1);
    expect(pool.freeCount).toBe(1);
    expect(pool.track[1]).toBe(-1);
    expect(pool.alloc()).toBe(1);
    expect(pool.id[1]).toBe(4);
  });

  it("keeps per-track lists ordered by s from tail to head", () => {
    const pool = new VehiclePool(8, 2);
    const positions = [50, 10, 30, 20, 40];
    for (const s of positions) {
      const i = pool.alloc();
      pool.s[i] = s;
      pool.insert(0, i);
    }
    expect(order(pool, 0).map((i) => pool.s[i])).toEqual([10, 20, 30, 40, 50]);
    expect(pool.trackHead[0]).toBe(0);
    expect(pool.trackTail[0]).toBe(1);
    expect(pool.ahead[pool.trackHead[0] as number]).toBe(-1);
    expect(pool.behind[pool.trackTail[0] as number]).toBe(-1);
    expect(order(pool, 1)).toEqual([]);

    pool.remove(2); // s = 30
    expect(order(pool, 0).map((i) => pool.s[i])).toEqual([10, 20, 40, 50]);
    pool.remove(0); // head
    expect(pool.trackHead[0]).toBe(4);
    pool.remove(1); // tail
    expect(pool.trackTail[0]).toBe(3);
    expect(order(pool, 0).map((i) => pool.s[i])).toEqual([20, 40]);
  });

  it("repairs an inverted order with sortTrack", () => {
    const pool = new VehiclePool(8, 1);
    for (const s of [10, 20, 30, 40]) {
      const i = pool.alloc();
      pool.s[i] = s;
      pool.insert(0, i);
    }
    pool.s[0] = 35; // the old tail jumps past two vehicles
    pool.s[3] = 5; // the old head falls behind everyone
    pool.sortTrack(0);
    expect(order(pool, 0).map((i) => pool.s[i])).toEqual([5, 20, 30, 35]);
    expect(pool.behind[pool.trackTail[0] as number]).toBe(-1);
    expect(pool.ahead[pool.trackHead[0] as number]).toBe(-1);
    // Every link is symmetric.
    for (const i of order(pool, 0)) {
      const a = pool.ahead[i] as number;
      const b = pool.behind[i] as number;
      if (a >= 0) expect(pool.behind[a]).toBe(i);
      if (b >= 0) expect(pool.ahead[b]).toBe(i);
    }
  });
});
