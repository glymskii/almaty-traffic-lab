/**
 * Nuance tests N09-N13: left turns, pockets, additional sections. Fixture: crossroads. Closed by T-10, T-11, T-12, T-22.
 */
import { CAUSE_COUNT, causeCode, defaultSimConfig, SignalState } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { TurnCode } from "../../src/runtime/turns.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier } from "../fixtures/builders.ts";
import { withProhibitedLefts } from "../routing/prohibited.ts";

const WARMUP_MIN = 3;
const RUN_MIN = 10;
/** Share of the approach demand that turns left, forced through the kernel until routing (T-12). */
const LEFT_SHARE = 0.4;

/**
 * Vehicles that crossed the intersection on a through movement from the north approach over the
 * measurement window. Counting occupants of the through connectors is the pre-metrics (T-18) way to
 * measure a movement's throughput.
 */
function throughFlowFromNorth(leftPocketM: number): number {
  // Protected lefts on purpose: this measures what the pocket length does, and a permissive left at
  // this demand and this left share simply has no gaps left to accept (N10/N11 cover that side).
  const network = crossroads({ leftPocketM, leftTurnMode: "protected" });
  const config = defaultSimConfig({
    seed: 1,
    demand: {
      multiplier: saturationMultiplier(network) * 1.2,
      warmupMinutes: WARMUP_MIN,
      vehicleBudget: 4000,
    },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  for (const dir of ["N", "E", "S", "W"]) {
    kernelOf(sim).setTurnShares(`${dir}.in`, { left: LEFT_SHARE, through: 1 - LEFT_SHARE });
  }
  const throughTracks: number[] = [];
  for (let c = 0; c < runtime.connectorCount; c++) {
    const track = runtime.laneCount + c;
    const id = runtime.connectorIds[c] as string;
    if (id.startsWith("N.in:") && (runtime.connTurn[track] as number) === TurnCode.through) {
      throughTracks.push(track);
    }
  }
  expect(throughTracks.length).toBeGreaterThan(0);

  const seen = new Set<number>();
  sim.runUntil(WARMUP_MIN * 60);
  while (sim.simTimeS < (WARMUP_MIN + RUN_MIN) * 60) {
    sim.step();
    for (const track of throughTracks) {
      let i = pool.trackTail[track] as number;
      while (i >= 0) {
        seen.add(pool.id[i] as number);
        i = pool.ahead[i] as number;
      }
    }
  }
  expect(kernelOf(sim).droppedVehicles).toBe(0);
  return seen.size;
}

describe("N09 pocket spillback", () => {
  it("with high left demand a 40 m pocket yields lower through throughput than a 120 m pocket", () => {
    const short = throughFlowFromNorth(40);
    const long = throughFlowFromNorth(120);
    expect(short).toBeGreaterThan(50); // both configurations really move traffic
    expect(long).toBeGreaterThan(50);
    // The short pocket overflows: left-turners wait in the through lane and hold it up.
    expect(short).toBeLessThan(long * 0.95);
  });

  it.todo("root cause pocket_spillback share on the affected approach > 20% (needs T-18 metrics)");
});

/**
 * Left lane of the north approach against its neighbour, with `leftShare` of the north demand
 * turning left and every other approach going straight ahead. Returns the mean delay index
 * (`1 - v/v_free`) of each of the two lanes, the through throughput each of them pushes across the
 * junction, and the causes reported on the left connector itself.
 */
function leftLaneVsNeighbour(leftShare: number) {
  const network = crossroads({ leftPocketM: 0, leftTurnMode: "permissive" });
  const config = defaultSimConfig({
    seed: 3,
    demand: {
      multiplier: saturationMultiplier(network) * 0.5,
      warmupMinutes: 2,
      vehicleBudget: 3000,
    },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  kernelOf(sim).setTurnShares(
    "N.in",
    leftShare > 0 ? { left: leftShare, through: 1 - leftShare } : { through: 1 },
  );
  for (const dir of ["E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });
  const trackOf = (id: string): number =>
    runtime.laneCount + (runtime.connectorIndex.get(id) as number);
  const lanes = [
    runtime.laneIndex.get("N.in:0") as number,
    runtime.laneIndex.get("N.in:1") as number,
  ];
  const throughs = [trackOf("N.in:0>S.out:0"), trackOf("N.in:1>S.out:1")];
  const leftTrack = leftShare > 0 ? trackOf("N.in:0>E.out:0") : -1;

  const delaySum = [0, 0];
  const samples = [0, 0];
  const crossed = [new Set<number>(), new Set<number>()];
  const leftCauses = new Float64Array(CAUSE_COUNT);
  sim.runUntil(120);
  while (sim.simTimeS < 720) {
    sim.step();
    for (const [n, lane] of lanes.entries()) {
      for (let i = pool.trackTail[lane] as number; i >= 0; i = pool.ahead[i] as number) {
        const vFree = (runtime.trackSpeedMps[lane] as number) * (pool.speedFactor[i] as number);
        delaySum[n] = (delaySum[n] as number) + Math.max(0, 1 - (pool.v[i] as number) / vFree);
        samples[n] = (samples[n] as number) + 1;
      }
    }
    for (const [n, t] of throughs.entries()) {
      for (let i = pool.trackTail[t] as number; i >= 0; i = pool.ahead[i] as number) {
        (crossed[n] as Set<number>).add(pool.id[i] as number);
      }
    }
    if (leftTrack >= 0) {
      for (let i = pool.trackTail[leftTrack] as number; i >= 0; i = pool.ahead[i] as number) {
        const code = pool.cause[i] as number;
        leftCauses[code] = (leftCauses[code] as number) + 1;
      }
    }
  }
  expect(kernelOf(sim).droppedVehicles).toBe(0);
  return {
    delayLeftLane: (delaySum[0] as number) / (samples[0] as number),
    delayNeighbour: (delaySum[1] as number) / (samples[1] as number),
    throughFromLeftLane: (crossed[0] as Set<number>).size,
    throughFromNeighbour: (crossed[1] as Set<number>).size,
    leftCauses,
  };
}

describe("N10 permissive left without pocket", () => {
  it("left-turners waiting for gaps block the leftmost through lane; dominant cause gap_left_turn", () => {
    const withLeft = leftLaneVsNeighbour(0.3);
    const noLeft = leftLaneVsNeighbour(0);

    // The left lane is the slower one, and only because of the left turns: with the same demand
    // going straight ahead the two lanes are within a few percent of each other.
    expect(withLeft.delayLeftLane).toBeGreaterThan(withLeft.delayNeighbour * 1.1);
    expect(noLeft.delayLeftLane).toBeLessThan(noLeft.delayNeighbour * 1.1);

    // The through traffic that has to share the lane barely gets across, while the neighbour lane
    // (which the through traffic escapes into) carries more than it does without the left turns.
    expect(withLeft.throughFromLeftLane).toBeLessThan(withLeft.throughFromNeighbour * 0.2);
    expect(noLeft.throughFromLeftLane).toBeGreaterThan(noLeft.throughFromNeighbour * 0.8);

    // Waiting for a gap is what the left-turners are doing, and it dominates every other reason.
    const causes = withLeft.leftCauses;
    const gap = causes[causeCode("gap_left_turn")] as number;
    let total = 0;
    for (let c = 0; c < CAUSE_COUNT; c++) total += causes[c] as number;
    expect(gap / total).toBeGreaterThan(0.5);
    for (let c = 0; c < CAUSE_COUNT; c++) {
      if (c !== causeCode("gap_left_turn")) expect(causes[c] as number).toBeLessThan(gap);
    }
  }, 60000);
});

/**
 * Mean delay of the north approach's left-turners (approach lanes plus the left connector) and of
 * the opposing through movement from the south, in seconds per vehicle that used the movement.
 */
function leftAndOpposingDelay(opts: {
  leftTurnMode: "permissive" | "protected";
  cycleS: number;
  greenSplitNS: number;
  leftShare: number;
  tripsPerHourPeak: number;
  minutes: number;
}) {
  const network = crossroads({
    leftTurnMode: opts.leftTurnMode,
    cycleS: opts.cycleS,
    greenSplitNS: opts.greenSplitNS,
  });
  const config = defaultSimConfig({
    seed: 1,
    demand: {
      tripsPerHourPeak: opts.tripsPerHourPeak,
      warmupMinutes: WARMUP_MIN,
      vehicleBudget: 3000,
    },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  kernelOf(sim).setTurnShares("N.in", { left: opts.leftShare, through: 1 - opts.leftShare });
  for (const dir of ["E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });

  const northLanes = new Set<number>();
  const southLanes = new Set<number>();
  for (const id of runtime.laneIds) {
    if (id.startsWith("N.in:")) northLanes.add(runtime.laneIndex.get(id) as number);
    if (id.startsWith("S.in:")) southLanes.add(runtime.laneIndex.get(id) as number);
  }
  const leftTrack = runtime.laneCount + (runtime.connectorIndex.get("N.in:0>E.out:0") as number);
  const opposing = new Set<number>();
  for (let c = 0; c < runtime.connectorCount; c++) {
    const t = runtime.laneCount + c;
    const id = runtime.connectorIds[c] as string;
    if (id.startsWith("S.in:") && (runtime.connTurn[t] as number) === TurnCode.through) {
      opposing.add(t);
    }
  }

  let leftDelayS = 0;
  let opposingDelayS = 0;
  const leftSeen = new Set<number>();
  const opposingSeen = new Set<number>();
  const dt = config.dtS;
  sim.runUntil(WARMUP_MIN * 60);
  while (sim.simTimeS < (WARMUP_MIN + opts.minutes) * 60) {
    sim.step();
    for (let i = 0; i < pool.highWater; i++) {
      const t = pool.track[i] as number;
      if (t < 0) continue;
      const vFree = (runtime.trackSpeedMps[t] as number) * (pool.speedFactor[i] as number);
      const d = dt * Math.max(0, 1 - (pool.v[i] as number) / vFree);
      const turn = pool.intendedTurn[i] as number;
      if (turn === TurnCode.left && northLanes.has(t)) leftDelayS += d;
      if (t === leftTrack) {
        leftDelayS += d;
        leftSeen.add(pool.id[i] as number);
      }
      if (turn === TurnCode.through && southLanes.has(t)) opposingDelayS += d;
      if (opposing.has(t)) {
        opposingDelayS += d;
        opposingSeen.add(pool.id[i] as number);
      }
    }
  }
  expect(leftSeen.size).toBeGreaterThan(0);
  expect(opposingSeen.size).toBeGreaterThan(0);
  return {
    leftDelayS: leftDelayS / leftSeen.size,
    opposingDelayS: opposingDelayS / opposingSeen.size,
  };
}

describe("N11 protected arrow", () => {
  it("protected mode gives lower left-turn delay than permissive at the same demand", () => {
    // Same demand and the same cycle length on both sides (the arrow phases of the protected plan
    // are paid for out of its own main greens), so only the way the left is served differs.
    const permissive = leftAndOpposingDelay({
      leftTurnMode: "permissive",
      cycleS: 90,
      greenSplitNS: 0.5,
      leftShare: 0.15,
      tripsPerHourPeak: 4500,
      minutes: 10,
    });
    const protectedPlan = leftAndOpposingDelay({
      leftTurnMode: "protected",
      cycleS: 56,
      greenSplitNS: 0.5,
      leftShare: 0.15,
      tripsPerHourPeak: 4500,
      minutes: 10,
    });
    expect(protectedPlan.leftDelayS).toBeLessThan(permissive.leftDelayS * 0.8);
  }, 60000);

  it("protected mode does not increase opposing through delay at low left demand", () => {
    // Both plans run a 134 s cycle and give the north-south main green the same share of it, so the
    // arrow section is the only difference the opposing through can feel.
    const permissive = leftAndOpposingDelay({
      leftTurnMode: "permissive",
      cycleS: 124,
      greenSplitNS: 0.5,
      leftShare: 0.1,
      tripsPerHourPeak: 1200,
      minutes: 15,
    });
    const protectedPlan = leftAndOpposingDelay({
      leftTurnMode: "protected",
      cycleS: 90,
      greenSplitNS: 0.689,
      leftShare: 0.1,
      tripsPerHourPeak: 1200,
      minutes: 15,
    });
    expect(protectedPlan.opposingDelayS).toBeLessThan(permissive.opposingDelayS * 1.15);
  }, 60000);
});

describe("N12 arrow off = prohibited", () => {
  it("during main green with the arrow OFF no left-turn vehicle enters the intersection; cause arrow_off appears", () => {
    const network = crossroads({ leftTurnMode: "protected" });
    const config = defaultSimConfig({
      seed: 2,
      demand: { tripsPerHourPeak: 2400, warmupMinutes: 1, vehicleBudget: 2000 },
    });
    const sim = createSimulation({ network, config });
    const { runtime, pool, signals } = kernelOf(sim);
    kernelOf(sim).setTurnShares("N.in", { left: 0.3, through: 0.7 });
    for (const dir of ["E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });
    const leftTrack = runtime.laneCount + (runtime.connectorIndex.get("N.in:0>E.out:0") as number);
    const arrow = runtime.signalGroupIds.indexOf("sg.N.arrow");
    const main = runtime.signalGroupIds.indexOf("sg.N.main");
    expect(arrow).toBeGreaterThanOrEqual(0);
    expect(main).toBeGreaterThanOrEqual(0);

    let onConnector = new Set<number>();
    let enteredWhileOff = 0;
    let arrowOffCause = 0;
    let mainGreenArrowOffSteps = 0;
    sim.runUntil(60);
    while (sim.simTimeS < 420) {
      sim.step();
      const arrowState = signals.groupState[arrow] as number;
      const arrowOn = arrowState === SignalState.GREEN || arrowState === SignalState.FLASHING_GREEN;
      const mainState = signals.groupState[main] as number;
      if (!arrowOn && mainState === SignalState.GREEN) mainGreenArrowOffSteps++;
      const now = new Set<number>();
      for (let i = pool.trackTail[leftTrack] as number; i >= 0; i = pool.ahead[i] as number) {
        const id = pool.id[i] as number;
        now.add(id);
        if (!arrowOn && !onConnector.has(id)) enteredWhileOff++;
      }
      onConnector = now;
      for (let i = 0; i < pool.highWater; i++) {
        if ((pool.track[i] as number) < 0) continue;
        if ((pool.cause[i] as number) === causeCode("arrow_off")) arrowOffCause++;
      }
    }
    expect(mainGreenArrowOffSteps).toBeGreaterThan(0); // the situation really occurs
    expect(enteredWhileOff).toBe(0);
    expect(arrowOffCause).toBeGreaterThan(0);
  }, 60000);
});

describe("N13 prohibited left", () => {
  /**
   * Runs a crossroads whose left turns are banned and reports how often a vehicle was seen on a
   * left connector, together with the trip counters. `keepConnectors` decides how the ban is
   * expressed: the builder can leave the movement out of the network altogether, or the signal
   * generator can keep it and give it no signal group (T-08), which is the case routing has to
   * walk around rather than merely not find.
   */
  function runWithoutLefts(keepConnectors: boolean) {
    const base = crossroads({ leftPocketM: 60, leftTurnMode: "permissive" });
    const network = keepConnectors
      ? withProhibitedLefts(base, "center")
      : crossroads({ leftPocketM: 60, leftTurnMode: "prohibited" });
    const config = defaultSimConfig({
      seed: 5,
      demand: {
        multiplier: saturationMultiplier(network) * 0.5,
        warmupMinutes: 2,
        vehicleBudget: 4000,
      },
    });
    const sim = createSimulation({ network, config });
    const { runtime, pool, intersections } = kernelOf(sim);
    const leftTracks: number[] = [];
    for (let c = 0; c < runtime.connectorCount; c++) {
      const t = runtime.laneCount + c;
      if ((runtime.connViaNode[c] as number) !== (runtime.nodeIndex.get("center") as number)) {
        continue;
      }
      if ((runtime.connTurn[t] as number) === TurnCode.left) leftTracks.push(t);
    }
    let onLeft = 0;
    let intendingLeft = 0;
    sim.runUntil(2 * 60);
    while (sim.simTimeS < 12 * 60) {
      sim.step();
      for (const t of leftTracks) {
        for (let i = pool.trackTail[t] as number; i >= 0; i = pool.ahead[i] as number) onLeft++;
      }
      for (let i = 0; i < pool.highWater; i++) {
        if ((pool.track[i] as number) < 0) continue;
        if ((pool.intendedTurn[i] as number) === TurnCode.left) intendingLeft++;
      }
    }
    return {
      leftTracks,
      onLeft,
      intendingLeft,
      prohibited: leftTracks.filter((t) => intersections.connProhibited[t] === 1).length,
      dropped: kernelOf(sim).droppedVehicles,
      stats: sim.tripStats(),
    };
  }

  it("no vehicle uses a left connector and no route even intends one, yet the trips complete", () => {
    const kept = runWithoutLefts(true);
    // The movements really are still in the network, and really are impassable.
    expect(kept.leftTracks.length).toBeGreaterThan(0);
    expect(kept.prohibited).toBe(kept.leftTracks.length);
    expect(kept.onLeft).toBe(0);
    expect(kept.intendingLeft).toBe(0);
    expect(kept.dropped).toBe(0);
    expect(kept.stats.total.completed).toBeGreaterThan(100);

    // The same ban expressed by leaving the connectors out: the trips still complete, and the
    // left-bound demand goes to the destinations it can still reach.
    const removed = runWithoutLefts(false);
    expect(removed.leftTracks.length).toBe(0);
    expect(removed.dropped).toBe(0);
    expect(removed.stats.total.completed).toBeGreaterThan(100);
  }, 60000);
});
