/**
 * Bus-stop dwelling (T-14): a bus reaching `stop.s` holds at `v = 0` under `bus_dwell` for the
 * sampled duration, then either resumes at once (`in_lane`, never left its lane's ordered list) or
 * rejoins the list once there is room (`bay`, which leaves it while dwelling). Car demand is zeroed
 * so a single scheduled bus can be tracked in isolation.
 */
import { causeCode, defaultSimConfig, type SimConfigPatch, VehicleFlag } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { straightRoad } from "../fixtures/builders.ts";

/** Long enough that one route only ever has a single bus in flight over the test's time budget. */
const HEADWAY_S = 300;
const DWELL_S = 20;

function oneBusSim(busStop: { s: number; kind: "in_lane" | "bay" }, patch: SimConfigPatch = {}) {
  const net = straightRoad({
    lanes: 2,
    busStop,
    busRoute: { headwayPeakS: HEADWAY_S, headwayOffpeakS: HEADWAY_S },
  });
  const config = defaultSimConfig({
    seed: 1,
    ...patch,
    behavior: {
      busDwellS: { mean: DWELL_S, sd: 0, min: DWELL_S, max: DWELL_S },
      busDwellPeakFactor: 1,
      ...patch.behavior,
    },
    demand: { multiplier: 0, warmupMinutes: 0, vehicleBudget: 200, ...patch.demand },
  });
  const sim = createSimulation({ network: net, config });
  return { sim, k: kernelOf(sim) };
}

/**
 * Slot of the first bus placed on the route, caught the moment it spawns. Jumping straight to a later
 * time and scanning for `busRoute >= 0` is not safe: a bus that already finished its trip frees its
 * slot without resetting `busRoute`, so a stale slot could be picked up instead of a live one.
 */
function firstBusSlot(
  sim: ReturnType<typeof createSimulation>,
  k: ReturnType<typeof kernelOf>,
): number {
  const pool = k.pool;
  for (let n = 0; n < 100000; n++) {
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) >= 0 && (pool.busRoute[i] as number) >= 0) return i;
    }
    sim.step();
  }
  throw new Error("no bus spawned");
}

function isDwelling(k: ReturnType<typeof kernelOf>, slot: number): boolean {
  return ((k.pool.persistentFlags[slot] as number) & VehicleFlag.DWELLING) !== 0;
}

function laneContains(k: ReturnType<typeof kernelOf>, lane: number, id: number): boolean {
  const pool = k.pool;
  for (let i = pool.trackTail[lane] as number; i >= 0; i = pool.ahead[i] as number) {
    if ((pool.id[i] as number) === id) return true;
  }
  return false;
}

/** Advances at most `maxSteps` steps until `pred` holds, failing loudly instead of looping forever. */
function stepUntil(
  sim: ReturnType<typeof createSimulation>,
  pred: () => boolean,
  maxSteps = 5000,
): void {
  for (let n = 0; n < maxSteps; n++) {
    if (pred()) return;
    sim.step();
  }
  throw new Error("stepUntil: condition never became true");
}

describe("N17 in_lane bus stop", () => {
  it("holds the bus at v=0 under cause bus_dwell, stays the lane's leader, and resumes at once", () => {
    const { sim, k } = oneBusSim({ s: 500, kind: "in_lane" });
    const pool = k.pool;
    const slot = firstBusSlot(sim, k);
    const id = pool.id[slot] as number;
    stepUntil(sim, () => isDwelling(k, slot));
    const dwellStart = sim.simTimeS;
    expect(pool.v[slot]).toBe(0);
    expect(pool.cause[slot]).toBe(causeCode("bus_dwell"));
    const lane = pool.track[slot] as number;
    expect(lane).toBeGreaterThanOrEqual(0);
    expect(laneContains(k, lane, id)).toBe(true); // in_lane never leaves the ordered list

    stepUntil(sim, () => !isDwelling(k, slot));
    expect(sim.simTimeS - dwellStart).toBeCloseTo(DWELL_S, 0);
    expect(pool.track[slot]).toBe(lane); // resumed on the same lane at once
  });
});

describe("bay bus stop", () => {
  it("leaves the lane's ordered list while dwelling and rejoins once the dwell ends", () => {
    const { sim, k } = oneBusSim({ s: 500, kind: "bay" });
    const pool = k.pool;
    const slot = firstBusSlot(sim, k);
    const id = pool.id[slot] as number;
    stepUntil(sim, () => isDwelling(k, slot));
    const dwellStart = sim.simTimeS;
    const lane = pool.track[slot] as number;
    expect(pool.v[slot]).toBe(0);
    expect(pool.cause[slot]).toBe(causeCode("bus_dwell"));
    // `track[slot]` still names the lane (so position/rendering stay put), but the ordered list --
    // what other vehicles actually see as an obstacle -- no longer contains it.
    expect(laneContains(k, lane, id)).toBe(false);

    stepUntil(sim, () => !isDwelling(k, slot));
    expect(sim.simTimeS - dwellStart).toBeCloseTo(DWELL_S, 0);
    expect(laneContains(k, lane, id)).toBe(true);
  });
});

describe("BusStopRuntime dwell duration", () => {
  it("scales by busDwellPeakFactor during a peak hour", () => {
    const peak = oneBusSim(
      { s: 500, kind: "in_lane" },
      { startTimeMin: 8 * 60, peakHours: [8], behavior: { busDwellPeakFactor: 2 } },
    );
    const slotP = firstBusSlot(peak.sim, peak.k);
    stepUntil(peak.sim, () => isDwelling(peak.k, slotP));
    const startP = peak.sim.simTimeS;
    stepUntil(peak.sim, () => !isDwelling(peak.k, slotP));
    expect(peak.sim.simTimeS - startP).toBeCloseTo(DWELL_S * 2, 0);

    const offpeak = oneBusSim(
      { s: 500, kind: "in_lane" },
      { startTimeMin: 14 * 60, peakHours: [8], behavior: { busDwellPeakFactor: 2 } },
    );
    const slotO = firstBusSlot(offpeak.sim, offpeak.k);
    stepUntil(offpeak.sim, () => isDwelling(offpeak.k, slotO));
    const startO = offpeak.sim.simTimeS;
    stepUntil(offpeak.sim, () => !isDwelling(offpeak.k, slotO));
    expect(offpeak.sim.simTimeS - startO).toBeCloseTo(DWELL_S, 0);
  });
});
