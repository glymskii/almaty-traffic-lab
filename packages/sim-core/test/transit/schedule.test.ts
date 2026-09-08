/**
 * Bus scheduling (T-14): headway-based spawning, peak vs off-peak headway, and the entry-lane
 * preference (bus lane if the first link has one, else the rightmost lane). Car demand is zeroed
 * (`demand.multiplier: 0`) throughout so only scheduled transit moves.
 */
import { defaultSimConfig, type SimConfigPatch } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { straightRoad } from "../fixtures/builders.ts";

function noCarDemand(patch: SimConfigPatch = {}): SimConfigPatch {
  return {
    ...patch,
    demand: { multiplier: 0, warmupMinutes: 0, vehicleBudget: 300, ...patch.demand },
  };
}

describe("BusScheduleRuntime headway", () => {
  it("spawns close to 3600/headway buses per hour", () => {
    // Not an exact divisor of 3600, so the count over the window depends on the random offset: it is
    // one of two adjacent integers, never fixed regardless of where the offset happens to fall.
    const headway = 190;
    const net = straightRoad({ busRoute: { headwayPeakS: headway, headwayOffpeakS: headway } });
    const base = Math.floor(3600 / headway);
    for (const seed of [1, 2, 3]) {
      const config = defaultSimConfig({ seed, ...noCarDemand() });
      const sim = createSimulation({ network: net, config });
      sim.runUntil(3600);
      const count = sim.tripStats().byClass.bus.spawned;
      expect(count).toBeGreaterThanOrEqual(base);
      expect(count).toBeLessThanOrEqual(base + 1);
    }
  });

  it("draws a random offset for the first departure, different from seed to seed", () => {
    const net = straightRoad({ busRoute: { headwayPeakS: 300, headwayOffpeakS: 300 } });
    function firstSpawnTimeS(seed: number): number {
      const config = defaultSimConfig({ seed, ...noCarDemand() });
      const sim = createSimulation({ network: net, config });
      while (sim.tripStats().byClass.bus.spawned === 0) sim.step();
      return sim.simTimeS;
    }
    expect(firstSpawnTimeS(1)).not.toBeCloseTo(firstSpawnTimeS(2), 0);
  });

  it("uses headwayPeakS during a peak hour and headwayOffpeakS otherwise", () => {
    const net = straightRoad({ busRoute: { headwayPeakS: 60, headwayOffpeakS: 3600 } });
    const runFrom = (startTimeMin: number) => {
      const config = defaultSimConfig({
        seed: 1,
        startTimeMin,
        peakHours: [8],
        ...noCarDemand(),
      });
      const sim = createSimulation({ network: net, config });
      sim.runUntil(10 * 60);
      return sim.tripStats().byClass.bus.spawned;
    };
    // 10 minutes at a 60 s peak headway: about 10 departures, minus at most one at each edge.
    expect(runFrom(8 * 60)).toBeGreaterThan(5);
    // Off-peak headway is an hour: at most the single random offset can land inside 10 minutes.
    expect(runFrom(14 * 60)).toBeLessThanOrEqual(1);
  });

  /**
   * Slot of the first bus placed on a scheduled route, caught the moment it spawns (not by jumping to
   * some later time and hoping one is still active -- it may already have finished its trip and freed
   * the slot, which does not reset `busRoute`).
   */
  function firstBusSlot(sim: ReturnType<typeof createSimulation>): number {
    const pool = kernelOf(sim).pool;
    for (let n = 0; n < 100000; n++) {
      for (let i = 0; i < pool.highWater; i++) {
        if ((pool.track[i] as number) >= 0 && (pool.busRoute[i] as number) >= 0) return i;
      }
      sim.step();
    }
    throw new Error("no bus spawned");
  }

  it("places the entry bus on its dedicated lane when the first link has one, else the rightmost lane", () => {
    const withBusLane = straightRoad({
      lanes: 2,
      busLane: true,
      busRoute: { headwayPeakS: 300, headwayOffpeakS: 300 },
    });
    const simA = createSimulation({
      network: withBusLane,
      config: defaultSimConfig({ seed: 1, ...noCarDemand() }),
    });
    const kA = kernelOf(simA);
    const busLaneA = kA.runtime.laneIndex.get("l0:2") as number;
    const slotA = firstBusSlot(simA);
    expect(kA.pool.track[slotA]).toBe(busLaneA);

    const noBusLane = straightRoad({
      lanes: 2,
      busRoute: { headwayPeakS: 300, headwayOffpeakS: 300 },
    });
    const simB = createSimulation({
      network: noBusLane,
      config: defaultSimConfig({ seed: 1, ...noCarDemand() }),
    });
    const kB = kernelOf(simB);
    const rightmostB = kB.runtime.laneIndex.get("l0:1") as number; // rightmost of 2 general lanes
    const slotB = firstBusSlot(simB);
    expect(kB.pool.track[slotB]).toBe(rightmostB);
  });
});
