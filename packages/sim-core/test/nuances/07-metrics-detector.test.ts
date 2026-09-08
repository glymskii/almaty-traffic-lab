/**
 * Nuance tests N23-N24: metrics in people and the detector. Closed by T-18, T-19.
 */
import { CAUSE_COUNT, causeCode, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier, straightRoad } from "../fixtures/builders.ts";

const CAUSE_POCKET_SPILLBACK = causeCode("pocket_spillback");
const WARMUP_MIN = 3;
const RUN_MIN = 10;
/** Share of the north demand that turns left, forced through the kernel (as in N09). */
const LEFT_SHARE = 0.4;

/**
 * Two ways to run the same two-lane street with a bus every 20 seconds: buses mixed into general
 * traffic, or the right lane given to them. Car demand is the same in both and sits just above what
 * a single lane can serve, so the conversion really does cost the cars something.
 */
const BUS_LANE_ROAD_M = 3000;
const BUS_HEADWAY_S = 20;
const BUS_LANE_TRIPS_PER_HOUR = 1800;
const BUS_LANE_WARMUP_MIN = 5;
const BUS_LANE_RUN_MIN = 20;

function busLaneTotals(dedicatedLane: boolean) {
  const busRoute = { headwayPeakS: BUS_HEADWAY_S, headwayOffpeakS: BUS_HEADWAY_S * 2 };
  const network = dedicatedLane
    ? straightRoad({ lengthM: BUS_LANE_ROAD_M, lanes: 1, busLane: true, busRoute })
    : straightRoad({ lengthM: BUS_LANE_ROAD_M, lanes: 2, busRoute });
  const sim = createSimulation({
    network,
    config: defaultSimConfig({
      seed: 1,
      demand: {
        tripsPerHourPeak: BUS_LANE_TRIPS_PER_HOUR,
        warmupMinutes: BUS_LANE_WARMUP_MIN,
        vehicleBudget: 6000,
      },
    }),
  });
  sim.runUntil((BUS_LANE_WARMUP_MIN + BUS_LANE_RUN_MIN) * 60);
  return { totals: sim.report().totals, trips: sim.tripStats() };
}

describe("N23 person metrics", () => {
  it("bus-lane scenario with frequent buses: person-delay lower while vehicle-delay higher than baseline", {
    timeout: 300_000,
  }, () => {
    const mixed = busLaneTotals(false);
    const dedicated = busLaneTotals(true);

    // Both runs really carried the buses they were supposed to carry.
    expect(mixed.trips.byClass.bus.completed).toBeGreaterThan(30);
    expect(dedicated.trips.byClass.bus.completed).toBeGreaterThan(30);

    // Cars pay for the lane: one general lane instead of two, so vehicle-hours of delay go up.
    expect(dedicated.totals.delayVehH).toBeGreaterThan(mixed.totals.delayVehH * 1.1);
    expect(dedicated.trips.byClass.car.meanTripDelayS).toBeGreaterThan(
      mixed.trips.byClass.car.meanTripDelayS,
    );

    // Measured in people the same change is an improvement: the buses stop queueing, and each of
    // them carries dozens of passengers out of the delay.
    expect(dedicated.totals.delayPersonH).toBeLessThan(mixed.totals.delayPersonH * 0.9);
    expect(dedicated.totals.busMeanSpeedKph).toBeGreaterThan(mixed.totals.busMeanSpeedKph);
  });
});

/**
 * The north approach carries all the turning demand and every other arm goes straight, so whatever
 * the detector reports has to be the north approach -- and the cause it reports has to be the one
 * the fixture was built around.
 */
function reportWithLeftHeavyNorth(opts: {
  network: ReturnType<typeof crossroads>;
  multiplier: number;
  tripsPerHourPeak?: number;
  leftShare: number;
}) {
  const sim = createSimulation({
    network: opts.network,
    config: defaultSimConfig({
      seed: 1,
      demand: {
        ...(opts.tripsPerHourPeak === undefined ? {} : { tripsPerHourPeak: opts.tripsPerHourPeak }),
        multiplier: opts.multiplier,
        warmupMinutes: WARMUP_MIN,
        vehicleBudget: 4000,
      },
    }),
  });
  kernelOf(sim).setTurnShares("N.in", { left: opts.leftShare, through: 1 - opts.leftShare });
  for (const dir of ["E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });
  sim.runUntil((WARMUP_MIN + RUN_MIN) * 60);
  return sim.report();
}

describe("N24 detector root cause", () => {
  it("a short pocket against heavy left demand puts pocket_spillback on top of the north approach", {
    timeout: 120_000,
  }, () => {
    const network = crossroads({ leftPocketM: 40, leftTurnMode: "protected" });
    const report = reportWithLeftHeavyNorth({
      network,
      multiplier: saturationMultiplier(network) * 1.2,
      leftShare: LEFT_SHARE,
    });
    const top = report.items[0];
    expect(top?.id).toBe("N.in:center");
    expect(top?.causes[0]?.cause).toBe("pocket_spillback");
    expect(top?.causes[0]?.share).toBeGreaterThan(0.4);
    // The fix the table proposes is the one a traffic engineer would reach for first.
    expect(top?.recommendations.map((r) => r.kind)).toContain("extend_left_pocket");
  });

  it("a permissive left with no pocket puts gap_left_turn on top of the same approach", {
    timeout: 120_000,
  }, () => {
    const report = reportWithLeftHeavyNorth({
      network: crossroads({ leftPocketM: 0, leftTurnMode: "permissive", greenSplitNS: 0.7 }),
      tripsPerHourPeak: 3000,
      multiplier: 1,
      leftShare: 0.5,
    });
    const top = report.items[0];
    expect(top?.id).toBe("N.in:center");
    expect(top?.causes[0]?.cause).toBe("gap_left_turn");
    expect(top?.causes[0]?.share).toBeGreaterThan(0.4);
    expect(top?.recommendations.map((r) => r.kind)).toEqual([
      "add_left_arrow",
      "prohibit_left_turn",
    ]);
  });

  it("queue members inherit the root cause of the queue head (root-cause propagation)", () => {
    // N09's fixture: a 40 m pocket against 40 % left-turning demand overflows, and the left-turners
    // that no longer fit stop in the through lane. Only the one vehicle at the mouth of the pocket
    // reports `pocket_spillback` itself -- everybody queued behind it says "the car in front". The
    // whole point of root-cause propagation is that the delay still lands on the pocket.
    const network = crossroads({ leftPocketM: 40, leftTurnMode: "protected" });
    const config = defaultSimConfig({
      seed: 1,
      demand: {
        multiplier: saturationMultiplier(network) * 1.2,
        warmupMinutes: WARMUP_MIN,
        vehicleBudget: 4000,
      },
    });
    const sim = createSimulation({ network, config });
    for (const dir of ["N", "E", "S", "W"]) {
      kernelOf(sim).setTurnShares(`${dir}.in`, { left: LEFT_SHARE, through: 1 - LEFT_SHARE });
    }
    sim.runUntil((WARMUP_MIN + RUN_MIN) * 60);

    const metrics = sim.writeMetrics();
    let bestShare = 0;
    let bestDelayS = 0;
    let approachSegments = 0;
    for (const seg of sim.segments()) {
      if (seg.linkId !== "N.in") continue;
      approachSegments++;
      const delay = metrics.delayVehS[seg.index] as number;
      if (delay <= 0) continue;
      const share = metrics.causeShare[seg.index * CAUSE_COUNT + CAUSE_POCKET_SPILLBACK] as number;
      if (share > bestShare) {
        bestShare = share;
        bestDelayS = delay;
      }
    }
    expect(approachSegments).toBeGreaterThan(0);
    // The through lane just upstream of the pocket is where the inherited cause piles up.
    expect(bestShare).toBeGreaterThanOrEqual(0.8);
    expect(bestDelayS).toBeGreaterThan(0);
  });
});
