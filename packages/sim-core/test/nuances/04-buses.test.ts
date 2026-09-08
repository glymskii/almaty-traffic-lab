/**
 * Nuance tests N14-N17: buses and dedicated lanes. Fixtures: straightRoad, crossroads. Closed by T-14.
 */
import { causeCode, defaultSimConfig, VehicleFlag } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier, straightRoad } from "../fixtures/builders.ts";

const WARMUP_MIN = 3;
const RUN_MIN = 10;
/** BusLaneRuleSchema default for `carsMayEnterForRightTurnWithinM`. */
const RIGHT_TURN_WINDOW_M = 50;

describe("N14 bus lane", () => {
  it("3 general lanes vs 2 general + bus lane: car capacity drops by ~1/3 (±10%)", () => {
    function completedCarTrips(net: ReturnType<typeof straightRoad>): number {
      const config = defaultSimConfig({
        seed: 1,
        demand: {
          multiplier: saturationMultiplier(net),
          warmupMinutes: WARMUP_MIN,
          vehicleBudget: 4000,
        },
      });
      const sim = createSimulation({ network: net, config });
      sim.runUntil((WARMUP_MIN + RUN_MIN) * 60);
      const completed = sim.tripStats().total.completed;
      expect(completed).toBeGreaterThan(100);
      return completed;
    }
    // `saturationMultiplier` already excludes bus lanes from the car-lane count, so both networks
    // saturate their *general-purpose* lanes to the same ~1.2x, same as N02's methodology.
    const threeGeneral = completedCarTrips(straightRoad({ lanes: 3 }));
    const twoPlusBus = completedCarTrips(straightRoad({ lanes: 2, busLane: true }));
    const ratio = twoPlusBus / threeGeneral;
    expect(ratio).toBeGreaterThan((2 / 3) * 0.9);
    expect(ratio).toBeLessThan((2 / 3) * 1.1);
  });

  it("under car congestion, bus travel time is lower with a dedicated bus lane than without", () => {
    // A long, signal-free road: congestion here is density slowing everyone down, not a queue behind
    // a light, so the demand level has to sit well below the point where the shared-lane network's
    // rightmost (bus-entry) lane fills up at the gate and stops admitting buses at all -- 0.6x of the
    // 1.2x-capacity reference `saturationMultiplier` is comfortably on the right side of that cliff
    // while still congesting the road enough to slow a bus stuck in it.
    const LENGTH_M = 2000;
    const HEADWAY_S = 60;
    const RUN_S = (WARMUP_MIN + 22) * 60;
    function busStats(net: ReturnType<typeof straightRoad>) {
      const config = defaultSimConfig({
        seed: 1,
        demand: {
          multiplier: saturationMultiplier(net) * 0.6,
          warmupMinutes: WARMUP_MIN,
          vehicleBudget: 6000,
          taxiShare: 0,
        },
      });
      const sim = createSimulation({ network: net, config });
      sim.runUntil(RUN_S);
      const bus = sim.tripStats().byClass.bus;
      expect(bus.completed).toBeGreaterThan(10);
      return bus;
    }
    const withBusLane = busStats(
      straightRoad({
        lengthM: LENGTH_M,
        lanes: 2,
        busLane: true,
        busRoute: { headwayPeakS: HEADWAY_S, headwayOffpeakS: HEADWAY_S },
      }),
    );
    const withoutBusLane = busStats(
      straightRoad({
        lengthM: LENGTH_M,
        lanes: 3,
        busRoute: { headwayPeakS: HEADWAY_S, headwayOffpeakS: HEADWAY_S },
      }),
    );
    expect(withBusLane.meanTripTimeS).toBeLessThan(withoutBusLane.meanTripTimeS);
    // The delay component isolates the congestion effect from the shared free-flow travel time, and
    // shows it far more starkly (roughly an order of magnitude across seeds) than the raw trip time.
    expect(withBusLane.meanTripDelayS).toBeLessThan(withoutBusLane.meanTripDelayS * 0.5);
  });
});

describe("N15 right-turn entry", () => {
  it("right-turning cars enter the bus lane only within carsMayEnterForRightTurnWithinM of the stop line", () => {
    // Same fixture as the lane-level tests in test/lanes/bus-lane-access.test.ts: this closes the
    // nuance end-to-end through the running simulation, on top of that unit-level coverage (T-10 note).
    const net = crossroads({ busLaneEW: true, lanes: 2 });
    const config = defaultSimConfig({
      seed: 1,
      behavior: { busLaneViolatorShare: 0 },
      demand: {
        multiplier: saturationMultiplier(net) * 0.6,
        warmupMinutes: 1,
        vehicleBudget: 3000,
        taxiShare: 0,
      },
    });
    const sim = createSimulation({ network: net, config });
    const k = kernelOf(sim);
    k.setTurnShares("E.in", { right: 1 });
    k.setTurnShares("W.in", { right: 1 });
    const busLane = k.runtime.laneIndex.get("E.in:3"); // pocket(0) + 2 general(1,2) + bus(3)
    if (busLane === undefined) throw new Error("fixture: bus lane E.in:3 missing");
    sim.runUntil(60);
    let seen = 0;
    while (sim.simTimeS < 660) {
      sim.step();
      for (let i = k.pool.trackTail[busLane] as number; i >= 0; i = k.pool.ahead[i] as number) {
        const remainingM = (k.runtime.trackEndS[busLane] as number) - (k.pool.s[i] as number);
        expect(remainingM).toBeLessThanOrEqual(RIGHT_TURN_WINDOW_M + 1e-6);
        expect(remainingM).toBeGreaterThanOrEqual(0);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(50);
  });
});

describe("N16 violators", () => {
  function scenario(violatorShare: number) {
    const net = straightRoad({
      lanes: 2,
      busLane: true,
      busRoute: { headwayPeakS: 90, headwayOffpeakS: 90 },
    });
    const config = defaultSimConfig({
      seed: 1,
      behavior: { busLaneViolatorShare: violatorShare },
      demand: {
        multiplier: saturationMultiplier(net) * 1.3,
        warmupMinutes: WARMUP_MIN,
        vehicleBudget: 4000,
        taxiShare: 0,
      },
    });
    const sim = createSimulation({ network: net, config });
    const k = kernelOf(sim);
    const busLane = k.runtime.laneIndex.get("l0:2");
    if (busLane === undefined) throw new Error("fixture: bus lane l0:2 missing");
    let sawViolator = false;
    while (sim.simTimeS < (WARMUP_MIN + RUN_MIN) * 60) {
      sim.step();
      for (let i = k.pool.trackTail[busLane] as number; i >= 0; i = k.pool.ahead[i] as number) {
        if (((k.pool.persistentFlags[i] as number) & VehicleFlag.BUS_LANE_VIOLATOR) !== 0) {
          sawViolator = true;
        }
      }
    }
    const bus = sim.tripStats().byClass.bus;
    return { meanTripTimeS: bus.meanTripTimeS, completed: bus.completed, sawViolator };
  }

  it("busLaneViolatorShare 0.3 raises bus travel time versus 0; violators carry BUS_LANE_VIOLATOR", () => {
    const clean = scenario(0);
    const withViolators = scenario(0.3);
    expect(clean.completed).toBeGreaterThan(0);
    expect(withViolators.completed).toBeGreaterThan(0);
    expect(clean.sawViolator).toBe(false);
    expect(withViolators.sawViolator).toBe(true);
    expect(withViolators.meanTripTimeS).toBeGreaterThan(clean.meanTripTimeS);
  });
});

describe("N17 in-lane bus stop", () => {
  /** Total (follower, step) observations carrying `behind_stopped_bus` while one bus dwells once. */
  function behindStoppedBusCount(kind: "in_lane" | "bay"): number {
    const net = straightRoad({
      lanes: 1,
      busStop: { s: 500, kind },
      busRoute: { headwayPeakS: 400, headwayOffpeakS: 400 },
    });
    const config = defaultSimConfig({
      seed: 1,
      behavior: { busDwellS: { mean: 30, sd: 0, min: 30, max: 30 }, busDwellPeakFactor: 1 },
      demand: {
        multiplier: saturationMultiplier(net) * 0.5,
        warmupMinutes: 1,
        vehicleBudget: 2000,
        taxiShare: 0,
      },
    });
    const sim = createSimulation({ network: net, config });
    const k = kernelOf(sim);
    sim.runUntil(400); // the route's headway: guarantees the one bus has spawned
    let count = 0;
    while (sim.simTimeS < 900) {
      sim.step();
      for (let i = 0; i < k.pool.highWater; i++) {
        if ((k.pool.track[i] as number) < 0) continue;
        if ((k.pool.busRoute[i] as number) >= 0) continue; // the bus itself, not a follower
        if ((k.pool.cause[i] as number) === causeCode("behind_stopped_bus")) count++;
      }
    }
    return count;
  }

  it("in_lane produces cause behind_stopped_bus on the lane; bay does not", () => {
    expect(behindStoppedBusCount("in_lane")).toBeGreaterThan(0);
    expect(behindStoppedBusCount("bay")).toBe(0);
  });
});
