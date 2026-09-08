/** T-12: OD demand, the hourly profile, warm-up, live travel times and determinism. */
import { DEFAULT_DEMAND_PROFILE, defaultSimConfig, VehicleFlag } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { tripRatePerS } from "../../src/demand/profile.ts";
import { createSimulation, kernelOf, type Simulation } from "../../src/simulation.ts";
import { corridor, crossroads, saturationMultiplier } from "../fixtures/builders.ts";

const NETWORK = crossroads({ leftTurnMode: "permissive" });

function sim(patch: Record<string, unknown> = {}, seed = 1, startTimeMin = 480): Simulation {
  const config = defaultSimConfig({
    seed,
    startTimeMin,
    demand: {
      multiplier: saturationMultiplier(NETWORK) * 0.5,
      warmupMinutes: 2,
      vehicleBudget: 4000,
      ...patch,
    },
  });
  return createSimulation({ network: NETWORK, config });
}

describe("OD model", () => {
  it("takes its origins and destinations from the gates and never sends a trip to its own gate", () => {
    const { od, runtime } = kernelOf(sim());
    expect(od.sourceCount).toBe(4);
    expect(od.destCount).toBe(4);
    expect(Array.from(od.destIsGate)).toEqual([1, 1, 1, 1]);
    // Every source keeps the entry lanes of its own gate.
    for (let s = 0; s < od.sourceCount; s++) {
      expect(od.sourceLaneCount[s]).toBeGreaterThan(0);
      const start = od.sourceLaneStart[s] as number;
      const lane = od.sourceLanes[start] as number;
      const link = runtime.trackLink[lane] as number;
      expect(runtime.linkFrom[link]).toBe(od.sourceNode[s]);
    }
    let shareTotal = 0;
    for (let s = 0; s < od.sourceCount; s++) shareTotal += od.sourceShare[s] as number;
    expect(shareTotal).toBeCloseTo(1, 9);
  });

  it("routes every trip to its gate: nothing is dropped and the trips complete", () => {
    const s = sim();
    s.runUntil(12 * 60);
    const stats = s.tripStats();
    expect(kernelOf(s).droppedVehicles).toBe(0);
    expect(stats.total.completed).toBeGreaterThan(200);
    // Some trips cross the junction the wrong way after missing a turn lane and are re-aimed; that
    // is a repair, not a leak, so it must stay a minority.
    expect(kernelOf(s).retargetedTrips).toBeLessThan(stats.total.spawned * 0.5);
  });
});

describe("hourly profile", () => {
  it("scales the spawn rate: 03:00 puts far fewer vehicles in than 08:00", () => {
    const night = sim({ warmupMinutes: 0 }, 1, 180);
    const morning = sim({ warmupMinutes: 0 }, 1, 480);
    night.runUntil(10 * 60);
    morning.runUntil(10 * 60);
    const nightIn = night.tripStats().total.spawned;
    const morningIn = morning.tripStats().total.spawned;
    expect(morningIn).toBeGreaterThan(0);
    // Profile 0.02 at 03:00 against 1.0 at 08:00; entry-lane capacity caps the morning, so the
    // assertion is deliberately loose in that direction.
    expect(nightIn).toBeLessThan(morningIn * 0.2);
  });

  it("tripRatePerS multiplies the peak rate by the profile and the runtime multiplier", () => {
    const demand = { hourlyProfile: DEFAULT_DEMAND_PROFILE, multiplier: 2 };
    expect(tripRatePerS(3600, demand, 8)).toBeCloseTo(2 * (DEFAULT_DEMAND_PROFILE[8] as number), 9);
    expect(tripRatePerS(3600, demand, 3)).toBeCloseTo(2 * (DEFAULT_DEMAND_PROFILE[3] as number), 9);
  });
});

describe("warm-up", () => {
  it("counts no trip that started before the end of warmupMinutes", () => {
    const s = sim({ warmupMinutes: 5 });
    s.runUntil(5 * 60);
    expect(s.tripStats().total.spawned).toBe(0);
    expect(s.tripStats().total.completed).toBe(0);
    expect(s.vehicleCount()).toBeGreaterThan(0); // the network is warm, the statistics are empty
    s.runUntil(12 * 60);
    expect(s.tripStats().total.spawned).toBeGreaterThan(0);
    expect(s.tripStats().total.completed).toBeGreaterThan(0);
  });
});

describe("navigators", () => {
  it("measures link travel times and only builds the live forest when someone uses it", () => {
    const quiet = sim({ navigatorShare: 0 });
    quiet.runUntil(3 * 60);
    let navigators = 0;
    const quietPool = kernelOf(quiet).pool;
    for (let i = 0; i < quietPool.highWater; i++) {
      if (((quietPool.persistentFlags[i] as number) & VehicleFlag.NAVIGATOR) !== 0) navigators++;
    }
    expect(navigators).toBe(0);

    const s = sim({ navigatorShare: 1 });
    s.runUntil(10 * 60);
    const { pool, liveTravelS, routingGraph, runtime } = kernelOf(s);
    let withFlag = 0;
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      if (((pool.persistentFlags[i] as number) & VehicleFlag.NAVIGATOR) !== 0) withFlag++;
    }
    expect(withFlag).toBe(s.vehicleCount());
    // A signalized approach really costs more than its free-flow time.
    const approach = runtime.linkIndex.get("N.in") as number;
    expect(liveTravelS[approach]).toBeGreaterThan(routingGraph.freeTravelS[approach] as number);
  });
});

describe("determinism with routes", () => {
  it("same seed, same network, same trajectory hash; a different seed differs", () => {
    const a = sim();
    const b = sim();
    const c = sim({}, 2);
    a.runUntil(240);
    b.runUntil(240);
    c.runUntil(240);
    expect(a.trajectoryHash()).toBe(b.trajectoryHash());
    expect(a.trajectoryHash()).not.toBe(c.trajectoryHash());
  });

  it("a navigator rebuild does not depend on when the trees happen to be rebuilt twice", () => {
    const network = corridor({ intersections: 3, parallelStreet: true });
    const config = defaultSimConfig({
      seed: 4,
      demand: { tripsPerHourPeak: 2000, warmupMinutes: 1, vehicleBudget: 2000, navigatorShare: 1 },
    });
    const a = createSimulation({ network, config });
    a.runUntil(300);
    const before = a.trajectoryHash();
    kernelOf(a).rebuildLiveTrees();
    kernelOf(a).rebuildLiveTrees();
    expect(a.trajectoryHash()).toBe(before);
  });
});
