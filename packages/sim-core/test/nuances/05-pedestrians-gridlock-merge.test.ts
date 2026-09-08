/**
 * Nuance tests N18-N20: pedestrians, gridlock, merges. Fixtures: crossroads, mergeRamp. Closed by T-15 (N18), T-11 + T-21 (N19), T-16 (N20).
 */
import {
  CAUSE_COUNT,
  causeCode,
  defaultSimConfig,
  type Network,
  type SimConfigPatch,
} from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { TurnCode } from "../../src/runtime/turns.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, mergeRamp, tJunction } from "../fixtures/builders.ts";

const TRIPS_PER_HOUR = 2400;
const WARMUP_S = 120;
const END_S = 720;
/** Busy enough that a crosswalk sees a walker most cycles, without dominating the run. */
const BUSY_PEDESTRIAN_PROFILE = new Array(24).fill(900);

/**
 * Throughput of the north-south through movements (the cross direction) over the measurement
 * window, plus the causes every vehicle in the network reported while it ran.
 *
 * `blockedExit` chokes the east exit down to a 60 m stub behind an all-but-permanently red signal,
 * so the east-bound traffic backs up out of the stub and into the junction box. Everything goes
 * straight ahead, so the only thing that can stop the cross direction is a car standing in the box.
 */
function crossFlow(opts: { blockedExit: boolean; gridlockDiscipline: number }) {
  const network = crossroads({
    leftTurnMode: "protected",
    ...(opts.blockedExit ? { blockedExit: { dir: "E" as const, lengthM: 60 } } : {}),
  });
  const config = defaultSimConfig({
    seed: 1,
    behavior: { gridlockDiscipline: opts.gridlockDiscipline },
    demand: { tripsPerHourPeak: TRIPS_PER_HOUR, warmupMinutes: 2, vehicleBudget: 3000 },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  for (const dir of ["N", "E", "S", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { through: 1 });

  const cross: number[] = [];
  for (let c = 0; c < runtime.connectorCount; c++) {
    const t = runtime.laneCount + c;
    const id = runtime.connectorIds[c] as string;
    const northSouth = id.startsWith("N.in:") || id.startsWith("S.in:");
    if (northSouth && (runtime.connTurn[t] as number) === TurnCode.through) cross.push(t);
  }
  expect(cross.length).toBeGreaterThan(0);

  const seen = new Set<number>();
  const causes = new Float64Array(CAUSE_COUNT);
  sim.runUntil(WARMUP_S);
  while (sim.simTimeS < END_S) {
    sim.step();
    for (const t of cross) {
      for (let i = pool.trackTail[t] as number; i >= 0; i = pool.ahead[i] as number) {
        seen.add(pool.id[i] as number);
      }
    }
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      const code = pool.cause[i] as number;
      causes[code] = (causes[code] as number) + 1;
    }
  }
  expect(kernelOf(sim).droppedVehicles).toBe(0);
  return { crossFlow: seen.size, causes };
}

/**
 * Right-turning flow from N and S: with `crosswalks: true` those movements share their outgoing arm's
 * zebra with pedestrians that get their own green exactly while N/S traffic does (the crossroads
 * fixture's ped groups sit on the *opposite* axis of each vehicle phase, see `test/fixtures/builders.ts`).
 * Turn shares force every N/S trip to turn right, so every vehicle counted here actually crosses one.
 */
function rightTurnFlow(pedestriansEnabled: boolean, seed = 1) {
  const network = crossroads({ crosswalks: true, leftTurnMode: "protected" });
  const config = defaultSimConfig({
    seed,
    pedestrians: { enabled: pedestriansEnabled, hourlyRatePerCrosswalk: BUSY_PEDESTRIAN_PROFILE },
    demand: { tripsPerHourPeak: TRIPS_PER_HOUR, warmupMinutes: 2, vehicleBudget: 3000 },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  for (const dir of ["N", "S"]) kernelOf(sim).setTurnShares(`${dir}.in`, { right: 1 });

  const rightTurns: number[] = [];
  for (let c = 0; c < runtime.connectorCount; c++) {
    const t = runtime.laneCount + c;
    const id = runtime.connectorIds[c] as string;
    const fromMinorAxis = id.startsWith("N.in:") || id.startsWith("S.in:");
    if (fromMinorAxis && (runtime.connTurn[t] as number) === TurnCode.right) rightTurns.push(t);
  }
  expect(rightTurns.length).toBeGreaterThan(0);

  const seen = new Set<number>();
  const causes = new Float64Array(CAUSE_COUNT);
  sim.runUntil(WARMUP_S);
  while (sim.simTimeS < END_S) {
    sim.step();
    for (const t of rightTurns) {
      for (let i = pool.trackTail[t] as number; i >= 0; i = pool.ahead[i] as number) {
        seen.add(pool.id[i] as number);
      }
    }
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      const code = pool.cause[i] as number;
      causes[code] = (causes[code] as number) + 1;
    }
  }
  return { flow: seen.size, causes };
}

describe("N18 pedestrian yield", () => {
  const withPeds = rightTurnFlow(true);
  const withoutPeds = rightTurnFlow(false);

  it("crosswalks with pedestrian flow lower right-turn throughput; cause pedestrian_yield present", () => {
    expect(withPeds.causes[causeCode("pedestrian_yield")] as number).toBeGreaterThan(0);
    expect(withPeds.flow).toBeLessThan(withoutPeds.flow);
  }, 60000);

  it("pedestrians.enabled = false restores right-turn throughput", () => {
    expect(withoutPeds.causes[causeCode("pedestrian_yield")] as number).toBe(0);
    expect(withoutPeds.flow).toBeGreaterThan(0);
  });
});

describe("N18 unregulated crosswalk (tJunction)", () => {
  it("forces the minor-road turning stream to yield with no signal group at all", () => {
    const network = tJunction({ crosswalkOnDir: "S" });
    const config = defaultSimConfig({
      seed: 3,
      pedestrians: { enabled: true, hourlyRatePerCrosswalk: BUSY_PEDESTRIAN_PROFILE },
      demand: { tripsPerHourPeak: TRIPS_PER_HOUR, warmupMinutes: 1, vehicleBudget: 2000 },
    });
    const sim = createSimulation({ network, config });
    const { pool } = kernelOf(sim);
    // Send the main-road traffic onto the minor arm so it actually crosses cw.S.
    for (const dir of ["E", "W"]) kernelOf(sim).setTurnShares(`${dir}.in`, { left: 1, right: 1 });

    let sawYield = false;
    sim.runUntil(60);
    while (sim.simTimeS < 360 && !sawYield) {
      sim.step();
      for (let i = 0; i < pool.highWater; i++) {
        if ((pool.track[i] as number) < 0) continue;
        if ((pool.cause[i] as number) === causeCode("pedestrian_yield")) sawYield = true;
      }
    }
    expect(sawYield).toBe(true);
  }, 30000);
});

describe("N18 determinism", () => {
  function run(seed: number) {
    const network = crossroads({ crosswalks: true });
    const config = defaultSimConfig({
      seed,
      pedestrians: { enabled: true, hourlyRatePerCrosswalk: BUSY_PEDESTRIAN_PROFILE },
      demand: { tripsPerHourPeak: TRIPS_PER_HOUR, warmupMinutes: 1, vehicleBudget: 1000 },
    } satisfies SimConfigPatch);
    const sim = createSimulation({ network, config });
    sim.runUntil(300);
    return sim;
  }

  it("same seed + network + config => identical trajectoryHash with pedestrians running", () => {
    const a = run(11);
    const b = run(11);
    expect(a.trajectoryHash()).toBe(b.trajectoryHash());
    expect(a.tripStats()).toEqual(b.tripStats());
  });
});

describe("N19 gridlock", () => {
  const free = crossFlow({ blockedExit: false, gridlockDiscipline: 0 });
  const undisciplined = crossFlow({ blockedExit: true, gridlockDiscipline: 0 });
  const disciplined = crossFlow({ blockedExit: true, gridlockDiscipline: 1 });

  it("gridlockDiscipline 0 with a blocked exit lets cars stop inside the intersection; cross flow drops, cause gridlock", () => {
    expect(free.crossFlow).toBeGreaterThan(100); // the reference junction really moves traffic
    expect(undisciplined.crossFlow).toBeLessThan(free.crossFlow * 0.5);
    expect(undisciplined.causes[causeCode("gridlock")] as number).toBeGreaterThan(0);
    expect(free.causes[causeCode("gridlock")] as number).toBe(0);
  }, 60000);

  it("gridlockDiscipline 1 keeps the intersection clear; cross flow unaffected", () => {
    expect(disciplined.crossFlow).toBeGreaterThanOrEqual(free.crossFlow * 0.95);
    expect(disciplined.causes[causeCode("gridlock")] as number).toBe(0);
    // Discipline is what keeps the box clear: the drivers wait in front of the full exit instead.
    expect(disciplined.causes[causeCode("downstream_spillback")] as number).toBeGreaterThan(0);
  }, 60000);
});

/**
 * `mergeRamp()` takes no demand-split option, so a "high ramp flow" scenario biases the OD weights
 * directly on the parsed network: `weightIn` only steers how the fixed total trip rate is split
 * between the two entry gates, and mutating it after `mergeRamp()` returns is the only way to do
 * that without touching the T-03 builder.
 */
function biasGateWeights(network: Network, weights: Partial<Record<string, number>>): void {
  for (const gate of network.gates) {
    const weight = weights[gate.id];
    if (weight !== undefined) gate.weightIn = weight;
  }
}

const CAUSE_MERGE_YIELD = causeCode("merge_yield");

/**
 * Mainline speed 500 m and 100 m upstream of the merge node (`main.before` is fixed at exactly
 * 500 m by the fixture), plus how often a ramp vehicle reports `merge_yield`, under a ramp flow four
 * times the mainline's own inbound share. Two full lanes keep the mainline itself under capacity, so
 * any slowdown near the merge is the ramp's doing, not plain oversaturation of the road.
 */
function mergeMainlineFlow(seed: number) {
  const network = mergeRamp(); // default: 2 main lanes, no acceleration lane (bare yield).
  biasGateWeights(network, { "g.ramp": 4, "g.w": 1 });
  const config = defaultSimConfig({
    seed,
    demand: { tripsPerHourPeak: 1800, warmupMinutes: 2, vehicleBudget: 3000 },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  const beforeLink = runtime.linkIndex.get("main.before");
  const beforeLanes: number[] = [];
  for (let l = 0; l < runtime.laneCount; l++) {
    if (runtime.trackLink[l] === beforeLink) beforeLanes.push(l);
  }
  expect(beforeLanes.length).toBeGreaterThan(0);

  const near = { speedSum: 0, n: 0 }; // last 100 m before the merge node
  const far = { speedSum: 0, n: 0 }; // first 100 m after the gate, 500 m before the merge
  let mergeYieldSamples = 0;
  const WARMUP_S = 120;
  const END_S = 900;
  sim.runUntil(WARMUP_S);
  while (sim.simTimeS < END_S) {
    sim.step();
    for (const t of beforeLanes) {
      for (let i = pool.trackTail[t] as number; i >= 0; i = pool.ahead[i] as number) {
        const s = pool.s[i] as number;
        const v = pool.v[i] as number;
        if (s >= 400) {
          near.speedSum += v;
          near.n++;
        } else if (s <= 100) {
          far.speedSum += v;
          far.n++;
        }
      }
    }
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      if ((pool.cause[i] as number) === CAUSE_MERGE_YIELD) mergeYieldSamples++;
    }
  }
  expect(near.n).toBeGreaterThan(0);
  expect(far.n).toBeGreaterThan(0);
  return {
    nearSpeed: near.speedSum / near.n,
    farSpeed: far.speedSum / far.n,
    mergeYieldSamples,
  };
}

/**
 * Average time from spawn to reaching the merge connector for every vehicle that comes off the ramp,
 * under a mainline that carries 20x the ramp's own inbound share on a single lane: gaps in it are
 * scarce, so the acceptance criterion of T-16 item 2 -- an acceleration lane gives the ramp more room
 * than a bare yield straight into that traffic -- shows up as a shorter average wait, the direct
 * counterpart of "greater throughput" for an on-ramp that is not the whole network's bottleneck.
 */
function rampMergeDelayS(accelLaneM: number, seed: number): number {
  const network = mergeRamp({ accelLaneM, mainLanes: 1 });
  biasGateWeights(network, { "g.ramp": 1, "g.w": 20 });
  const config = defaultSimConfig({
    seed,
    demand: { tripsPerHourPeak: 1800, warmupMinutes: 2, vehicleBudget: 3000 },
  });
  const sim = createSimulation({ network, config });
  const { runtime, pool } = kernelOf(sim);
  let mergeTrack = -1;
  for (let c = 0; c < runtime.connectorCount; c++) {
    if ((runtime.connTurn[runtime.laneCount + c] as number) === TurnCode.merge) {
      mergeTrack = runtime.laneCount + c;
    }
  }
  expect(mergeTrack).toBeGreaterThanOrEqual(0);

  const seen = new Set<number>();
  let delaySumS = 0;
  const WARMUP_S = 120;
  const END_S = 900;
  sim.runUntil(WARMUP_S);
  while (sim.simTimeS < END_S) {
    sim.step();
    for (let i = pool.trackTail[mergeTrack] as number; i >= 0; i = pool.ahead[i] as number) {
      const id = pool.id[i] as number;
      if (seen.has(id)) continue;
      seen.add(id);
      delaySumS += sim.simTimeS - (pool.spawnTimeS[i] as number);
    }
  }
  expect(seen.size).toBeGreaterThan(0);
  return delaySumS / seen.size;
}

describe("N20 merge yield", () => {
  it("high ramp flow lowers mainline speed near the merge; cause merge_yield is reported on the ramp", () => {
    const { nearSpeed, farSpeed, mergeYieldSamples } = mergeMainlineFlow(1);
    expect(nearSpeed).toBeLessThan(farSpeed);
    expect(mergeYieldSamples).toBeGreaterThan(0);
  });

  it("accelLaneM: 200 gets ramp vehicles through the merge faster than a bare yield (accelLaneM: 0)", () => {
    const withAccelLane = rampMergeDelayS(200, 4);
    const bareYield = rampMergeDelayS(0, 4);
    expect(withAccelLane).toBeLessThan(bareYield);
  });

  it("determinism: same seed + network + config => identical trajectoryHash", () => {
    function run() {
      const network = mergeRamp({ accelLaneM: 200 });
      biasGateWeights(network, { "g.ramp": 4, "g.w": 1 });
      const config = defaultSimConfig({
        seed: 9,
        demand: { tripsPerHourPeak: 1800, warmupMinutes: 2, vehicleBudget: 3000 },
      } satisfies SimConfigPatch);
      const sim = createSimulation({ network, config });
      sim.runUntil(600);
      return sim;
    }
    const a = run();
    const b = run();
    expect(a.trajectoryHash()).toBe(b.trajectoryHash());
    expect(a.tripStats()).toEqual(b.tripStats());
  });
});
