/**
 * Nuance tests N25-N27: runtime parameters, invariants, performance. Closed by T-04/T-06 (N25), T-21 (N26), T-28 (N27).
 */
import { defaultSimConfig, RUNTIME_SAFE_PARAM_PATHS, VehicleFlag } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { GAP_TOLERANCE_M } from "../../src/runtime/invariants.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier, straightRoad } from "../fixtures/builders.ts";

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

  /**
   * Both `behavior.gridlockDiscipline` and `behavior.busLaneViolatorShare` are per-driver traits
   * drawn once at spawn (`place()`/`placeBus()`, simulation.ts) from whatever `this.cfg.behavior`
   * holds *at that moment* -- and `setParams` replaces `this.cfg` wholesale. So a vehicle already on
   * the road keeps the value it was drawn with for its whole trip; only a vehicle spawned after the
   * change ever sees the new one. `chance(0)`/`chance(1)` are exact (never below/always below 1), so
   * this does not need many samples or a tolerance to be a clean test.
   */
  it("gridlockDiscipline resamples only for vehicles spawned after setParams; existing ones keep theirs", () => {
    const network = straightRoad({ lengthM: 2000, lanes: 1 });
    const config = defaultSimConfig({
      seed: 1,
      behavior: { gridlockDiscipline: 0 },
      demand: { tripsPerHourPeak: 600, warmupMinutes: 0 },
    });
    const sim = createSimulation({ network, config });
    const { pool, gridlockDisciplined } = kernelOf(sim);

    sim.runUntil(60);
    const before = new Map<number, number>();
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      before.set(pool.id[i] as number, gridlockDisciplined[i] as number);
    }
    expect(before.size).toBeGreaterThan(0);
    for (const disc of before.values()) expect(disc).toBe(0);

    sim.setParams({ behavior: { gridlockDiscipline: 1 } });
    sim.runUntil(120);

    let survivors = 0;
    let freshlySpawned = 0;
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      const id = pool.id[i] as number;
      const disc = gridlockDisciplined[i] as number;
      const wasBefore = before.get(id);
      if (wasBefore !== undefined) {
        survivors++;
        expect(disc).toBe(wasBefore); // untouched by the parameter change
      } else {
        freshlySpawned++;
        expect(disc).toBe(1); // drawn under the new value
      }
    }
    expect(survivors).toBeGreaterThan(0);
    expect(freshlySpawned).toBeGreaterThan(0);
  });

  it("busLaneViolatorShare resamples only for vehicles spawned after setParams; existing ones keep theirs", () => {
    const network = straightRoad({ lengthM: 2000, lanes: 1 });
    const config = defaultSimConfig({
      seed: 2,
      behavior: { busLaneViolatorShare: 0 },
      demand: { tripsPerHourPeak: 600, warmupMinutes: 0 },
    });
    const sim = createSimulation({ network, config });
    const { pool } = kernelOf(sim);
    const isViolator = (i: number) =>
      ((pool.persistentFlags[i] as number) & VehicleFlag.BUS_LANE_VIOLATOR) !== 0;

    sim.runUntil(60);
    const before = new Map<number, boolean>();
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      before.set(pool.id[i] as number, isViolator(i));
    }
    expect(before.size).toBeGreaterThan(0);
    for (const violator of before.values()) expect(violator).toBe(false);

    sim.setParams({ behavior: { busLaneViolatorShare: 1 } });
    sim.runUntil(120);

    let survivors = 0;
    let freshlySpawned = 0;
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      const id = pool.id[i] as number;
      const violator = isViolator(i);
      const wasBefore = before.get(id);
      if (wasBefore !== undefined) {
        survivors++;
        expect(violator).toBe(wasBefore); // untouched by the parameter change
      } else {
        freshlySpawned++;
        expect(violator).toBe(true); // drawn under the new value (cars and taxis only, both spawn here)
      }
    }
    expect(survivors).toBeGreaterThan(0);
    expect(freshlySpawned).toBeGreaterThan(0);
  });
});

describe("N26 invariants", () => {
  /**
   * `checkInvariants` (`runtime/invariants.ts`) now does the actual checking, wired into `step()`
   * behind `config.debugInvariants`; this test only has to run 10 saturated sim-minutes with the
   * flag on and confirm the engine raises nothing. `GAP_TOLERANCE_M` (imported above, not redefined
   * here) is why a merely negative bumper gap does not fail this test on its own -- see that
   * module's doc comment and docs/NUANCES.md (N26) for the characterised, reproducible transient
   * (a mandatory-lane-change fallback landing on a different connector than the free-flow lookahead
   * used) it accounts for.
   */
  const RUN_S = 600;

  it("10 sim-minutes of saturated crossroads with debugInvariants: true raises no exception", () => {
    const net = crossroads();
    const config = defaultSimConfig({
      seed: 1,
      demand: {
        multiplier: saturationMultiplier(net) * 1.3,
        warmupMinutes: 0,
        vehicleBudget: 6000,
      },
      debugInvariants: true,
    });
    const sim = createSimulation({ network: net, config });
    expect(config.debugInvariants).toBe(true);
    expect(GAP_TOLERANCE_M).toBeLessThan(0);

    expect(() => sim.runUntil(RUN_S)).not.toThrow();

    expect(sim.simTimeS).toBeGreaterThanOrEqual(RUN_S);
    expect(kernelOf(sim).droppedVehicles).toBe(0);
  }, 30_000);

  it("debugInvariants: false (default) never runs the check, same trajectory either way while healthy", () => {
    function run(debugInvariants: boolean) {
      const net = crossroads();
      const config = defaultSimConfig({
        seed: 2,
        demand: { tripsPerHourPeak: 1800, warmupMinutes: 1, vehicleBudget: 2000 },
        debugInvariants,
      });
      const sim = createSimulation({ network: net, config });
      sim.runUntil(180);
      return sim;
    }
    expect(defaultSimConfig().debugInvariants).toBe(false);
    const off = run(false);
    const on = run(true);
    // The checks are read-only: turning them on changes nothing about the simulated trajectory.
    expect(on.trajectoryHash()).toBe(off.trajectoryHash());
    expect(on.tripStats()).toEqual(off.tripStats());
  });
});

describe("N27 performance", () => {
  it.todo(
    "20 000 vehicles: mean step time <= 30 ms on the reference machine (benchmark, run separately)",
  );
});
