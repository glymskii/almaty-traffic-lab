/** T-10 acceptance: 5000 vehicles that keep changing lanes still step well inside the budget. */
import { defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { straightRoad } from "../fixtures/builders.ts";

describe("performance with lane changes", () => {
  it("steps 5000 vehicles on a multi-lane straightRoad in under 8 ms", { timeout: 30_000 }, () => {
    // 20 lanes x 10 km near capacity: the widest neighbourhood the lane-change stage ever walks.
    const s = createSimulation({
      network: straightRoad({ lengthM: 10000, lanes: 20 }),
      config: defaultSimConfig({
        demand: { tripsPerHourPeak: 36000, warmupMinutes: 0, vehicleBudget: 8000 },
      }),
    });
    while (s.vehicleCount() < 5000 && s.simTimeS < 1200) s.step();
    expect(s.vehicleCount()).toBeGreaterThanOrEqual(5000);

    const { pool } = kernelOf(s);
    const trackBefore = new Int32Array(pool.capacity);
    trackBefore.set(pool.track);
    const steps = 100;
    const t0 = performance.now();
    for (let k = 0; k < steps; k++) s.step();
    const perStepMs = (performance.now() - t0) / steps;

    let changed = 0;
    for (let i = 0; i < pool.highWater; i++) {
      const before = trackBefore[i] as number;
      if (before >= 0 && (pool.track[i] as number) >= 0 && (pool.track[i] as number) !== before) {
        changed++;
      }
    }
    expect(changed).toBeGreaterThan(50); // vehicles really were changing lanes while we measured
    expect(perStepMs).toBeLessThan(8);
  });
});
