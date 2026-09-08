/**
 * Nuance tests N25-N27: runtime parameters, invariants, performance. Closed by T-04/T-06 (N25), T-21 (N26), T-28 (N27).
 */
import { defaultSimConfig, RUNTIME_SAFE_PARAM_PATHS } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation } from "../../src/simulation.ts";
import { straightRoad } from "../fixtures/builders.ts";

describe("N25 runtime parameters", () => {
  it("setParams with a RUNTIME_SAFE path applies immediately; any other path throws", () => {
    const sim = createSimulation({
      network: straightRoad(),
      config: defaultSimConfig({ seed: 1, demand: { tripsPerHourPeak: 1200, warmupMinutes: 0 } }),
    });
    sim.runUntil(120);
    const spawnedBefore = sim.tripStats().total.spawned;
    expect(spawnedBefore).toBeGreaterThan(20);

    // Safe path: the new multiplier is visible at once and drives the very next spawns.
    expect(RUNTIME_SAFE_PARAM_PATHS).toContain("demand.multiplier");
    sim.setParams({ demand: { multiplier: 0 } });
    expect(sim.config.demand.multiplier).toBe(0);
    sim.runUntil(240);
    expect(sim.tripStats().total.spawned).toBe(spawnedBefore);
    sim.setParams({ demand: { multiplier: 2 }, behavior: { gridlockDiscipline: 1 } });
    expect(sim.config.demand.multiplier).toBe(2);
    expect(sim.config.behavior.gridlockDiscipline).toBe(1);
    sim.runUntil(360);
    expect(sim.tripStats().total.spawned).toBeGreaterThan(spawnedBefore + 20);

    // Unsafe paths throw and leave the config untouched, even when mixed with a safe one.
    const snapshot = JSON.stringify(sim.config);
    expect(() => sim.setParams({ seed: 2 })).toThrow(/seed/);
    expect(() => sim.setParams({ dtS: 0.05 })).toThrow(/dtS/);
    expect(() => sim.setParams({ demand: { multiplier: 1, tripsPerHourPeak: 10 } })).toThrow(
      /demand\.tripsPerHourPeak/,
    );
    expect(() => sim.setParams({ metrics: { windowS: 10 } })).toThrow(/metrics\.windowS/);
    expect(JSON.stringify(sim.config)).toBe(snapshot);
  });

  it("a lower multiplier takes effect behind a queue: after multiplier 0 no more than a lane's capacity enters", () => {
    const sim = createSimulation({
      network: straightRoad({ lanes: 1 }),
      config: defaultSimConfig({ seed: 1, demand: { tripsPerHourPeak: 4000, warmupMinutes: 0 } }),
    });
    sim.runUntil(300);
    expect(sim.tripStats().spawnWaits).toBeGreaterThan(0); // the entry is saturated
    const before = sim.tripStats().total.spawned;
    sim.setParams({ demand: { multiplier: 0 } });
    sim.runUntil(360);
    const entered = sim.tripStats().total.spawned - before;
    expect(entered).toBeLessThanOrEqual(1800 / 60);
  });
});

describe("N26 invariants", () => {
  it.todo(
    "10 sim-minutes of saturated crossroads: no vehicle overlap, no NaN, no negative gap (debugInvariants on)",
  );
});

describe("N27 performance", () => {
  it.todo(
    "20 000 vehicles: mean step time <= 30 ms on the reference machine (benchmark, run separately)",
  );
});
