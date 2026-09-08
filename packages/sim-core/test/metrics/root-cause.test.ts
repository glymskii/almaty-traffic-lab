/**
 * T-18: root-cause propagation along a queue (docs/ARCHITECTURE.md, "Причины и распространение
 * корневой причины"). A vehicle that only blames the car in front must end up carrying the reason
 * the head of its queue is standing.
 */
import { causeCode, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { MAX_ROOT_DEPTH, RootCauseResolver } from "../../src/metrics/rootCause.ts";
import { VehiclePool } from "../../src/runtime/vehicles.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier, straightRoad } from "../fixtures/builders.ts";

const CAUSE_LEADER = causeCode("leader");
const CAUSE_SIGNAL_RED = causeCode("signal_red");
const STOPPED_MPS = 0.5;

/** Oversaturated single-lane crossroads: the north approach queues through most of every cycle. */
function saturatedCrossroads() {
  const network = crossroads({ lanes: 1, leftTurnMode: "prohibited", leftPocketM: 0 });
  const sim = createSimulation({
    network,
    config: defaultSimConfig({
      demand: {
        multiplier: saturationMultiplier(network) * 1.5,
        vehicleBudget: 800,
        warmupMinutes: 0,
      },
    }),
  });
  sim.runUntil(300);
  return { sim, ...kernelOf(sim) };
}

describe("root cause propagation", () => {
  it("keeps every vehicle's own cause when nothing is queueing", () => {
    const sim = createSimulation({
      network: straightRoad(),
      config: defaultSimConfig({ demand: { tripsPerHourPeak: 900 } }),
    });
    sim.runUntil(200);
    const { pool } = kernelOf(sim);
    let seen = 0;
    for (let i = 0; i < pool.highWater; i++) {
      if ((pool.track[i] as number) < 0) continue;
      seen++;
      // In free flow nobody is held up, so nothing is inherited.
      expect(pool.rootCause[i]).toBe(pool.cause[i]);
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("hands the reason the queue head is standing to everyone behind it", () => {
    const { sim, runtime, pool } = saturatedCrossroads();
    const lane = runtime.laneIndex.get("N.in:0") as number;
    let queuesChecked = 0;
    let followersChecked = 0;
    for (let step = 0; step < 2000; step++) {
      sim.step();
      const head = pool.trackHead[lane] as number;
      if (head < 0) continue;
      if ((pool.v[head] as number) > STOPPED_MPS) continue;
      if ((pool.cause[head] as number) !== CAUSE_SIGNAL_RED) continue;
      expect(pool.rootCause[head]).toBe(CAUSE_SIGNAL_RED);
      queuesChecked++;
      // Everyone standing behind a head held at a red light inherits `signal_red`, however deep.
      // The chain ends where a vehicle stops blaming its leader, or where that leader is rolling
      // again -- then it really is the leader, not the light, that binds.
      let leader = head;
      for (let i = pool.behind[head] as number; i >= 0; i = pool.behind[i] as number) {
        if ((pool.cause[i] as number) !== CAUSE_LEADER) break;
        if ((pool.v[leader] as number) > STOPPED_MPS) break;
        expect(pool.rootCause[i]).toBe(CAUSE_SIGNAL_RED);
        followersChecked++;
        leader = i;
      }
    }
    expect(queuesChecked).toBeGreaterThan(100);
    expect(followersChecked).toBeGreaterThan(1000);
  });

  it("propagates across the lane -> connector -> lane boundary", () => {
    // The head of an approach lane has no leader in its own list: its leader stands on the
    // connector ahead, so the chain has to cross the track boundary to find a real cause. A choked
    // exit (N19's fixture) with no gridlock discipline is what really parks cars inside the box.
    const network = crossroads({
      lanes: 1,
      leftTurnMode: "prohibited",
      leftPocketM: 0,
      blockedExit: { dir: "E" },
    });
    const sim = createSimulation({
      network,
      config: defaultSimConfig({
        demand: {
          multiplier: saturationMultiplier(network) * 1.5,
          vehicleBudget: 800,
          warmupMinutes: 0,
        },
        behavior: { gridlockDiscipline: 0 },
      }),
    });
    sim.runUntil(300);
    const { runtime, pool } = kernelOf(sim);
    let crossed = 0;
    for (let step = 0; step < 2000; step++) {
      sim.step();
      for (let c = 0; c < runtime.connectorCount; c++) {
        const track = runtime.laneCount + c;
        const tail = pool.trackTail[track] as number;
        if (tail < 0) continue;
        if ((pool.v[tail] as number) > STOPPED_MPS) continue;
        const head = pool.trackHead[runtime.connFromLane[c] as number] as number;
        if (head < 0 || (pool.cause[head] as number) !== CAUSE_LEADER) continue;
        expect(pool.rootCause[head]).toBe(pool.rootCause[tail]);
        crossed++;
      }
    }
    expect(crossed).toBeGreaterThan(0);
  });

  it("stops inheriting after MAX_ROOT_DEPTH vehicles", () => {
    // A hand-built standing queue on one lane: only the first MAX_ROOT_DEPTH followers of the head
    // may carry its cause, everyone further back falls back to their own.
    const sim = createSimulation({
      network: straightRoad({ lengthM: 4000, lanes: 1 }),
      config: defaultSimConfig(),
    });
    const { runtime } = kernelOf(sim);
    const lane = runtime.laneIndex.get("l0:0") as number;
    const count = MAX_ROOT_DEPTH + 20;
    const pool = new VehiclePool(count, runtime.trackCount);
    for (let k = 0; k < count; k++) {
      const i = pool.alloc();
      pool.s[i] = 10 + k * 7;
      pool.v[i] = 0;
      pool.speedFactor[i] = 1;
      pool.nextTrack[i] = -1;
      pool.cause[i] = k === count - 1 ? CAUSE_SIGNAL_RED : CAUSE_LEADER;
      pool.insert(lane, i);
    }
    new RootCauseResolver(runtime, pool.capacity).resolve(pool, STOPPED_MPS);

    let depth = 0;
    for (let i = pool.trackHead[lane] as number; i >= 0; i = pool.behind[i] as number) {
      const expected = depth <= MAX_ROOT_DEPTH ? CAUSE_SIGNAL_RED : CAUSE_LEADER;
      expect(pool.rootCause[i]).toBe(expected);
      depth++;
    }
    expect(depth).toBe(count);
  });
});
