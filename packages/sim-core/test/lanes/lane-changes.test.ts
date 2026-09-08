/**
 * Lane changes in the running simulation (T-10): target lane by the next manoeuvre, entering a
 * pocket only where it exists, the manoeuvre rate limit and the blinker, a lane that ends mid-link,
 * and the `lane_change_wait` / `pocket_spillback` causes.
 */
import { causeCode, defaultSimConfig, type SimConfigPatch, VehicleFlag } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier, straightRoad } from "../fixtures/builders.ts";

const BLINKERS = VehicleFlag.BLINKER_LEFT | VehicleFlag.BLINKER_RIGHT;

function sim(network: Parameters<typeof createSimulation>[0]["network"], patch: SimConfigPatch) {
  return createSimulation({ network, config: defaultSimConfig({ seed: 1, ...patch }) });
}

describe("a lane that ends before its link does", () => {
  /** straightRoad whose right lane stops at 600 m: every vehicle on it must merge left in time. */
  function endingLane() {
    const net = straightRoad({ lanes: 2 });
    const lane = net.lanes[1];
    if (!lane) throw new Error("fixture: straightRoad(lanes: 2) has two lanes");
    lane.endS = 600;
    return net;
  }

  it("always empties before endS: no vehicle is dropped and none passes the end of the lane", () => {
    const s = sim(endingLane(), {
      demand: { tripsPerHourPeak: 2400, warmupMinutes: 0, vehicleBudget: 500 },
    });
    const { pool, runtime } = kernelOf(s);
    const shortLane = runtime.laneIndex.get("l0:1");
    if (shortLane === undefined) throw new Error("fixture: lane l0:1 missing");
    let seenOnShortLane = 0;
    let maxSOnShortLane = 0;
    while (s.simTimeS < 600) {
      s.step();
      let i = pool.trackTail[shortLane] as number;
      while (i >= 0) {
        seenOnShortLane++;
        maxSOnShortLane = Math.max(maxSOnShortLane, pool.s[i] as number);
        i = pool.ahead[i] as number;
      }
    }
    expect(seenOnShortLane).toBeGreaterThan(1000); // the lane was really used
    expect(maxSOnShortLane).toBeLessThanOrEqual(600);
    expect(kernelOf(s).droppedVehicles).toBe(0);
    const st = s.tripStats();
    expect(st.total.completed).toBeGreaterThan(100);
    expect(st.total.spawned).toBe(st.total.completed + st.total.active);
  });

  it("reports lane_change_wait for a vehicle braking for a merge it cannot make yet", () => {
    const s = sim(endingLane(), {
      // Saturated: the left lane is full, so merges have to wait for a gap.
      demand: { tripsPerHourPeak: 4000, warmupMinutes: 0, vehicleBudget: 500 },
    });
    const { pool } = kernelOf(s);
    const wait = causeCode("lane_change_wait");
    let waits = 0;
    while (s.simTimeS < 600) {
      s.step();
      for (let i = 0; i < pool.highWater; i++) {
        if ((pool.track[i] as number) < 0) continue;
        if ((pool.cause[i] as number) === wait) waits++;
      }
    }
    expect(waits).toBeGreaterThan(0);
  });
});

describe("manoeuvre timing", () => {
  it("keeps a vehicle in its new lane for at least 2 s and shows a blinker meanwhile", () => {
    const s = sim(straightRoad({ lanes: 3 }), {
      demand: { tripsPerHourPeak: 3000, warmupMinutes: 0, vehicleBudget: 500 },
    });
    const { pool } = kernelOf(s);
    const lastChangeS = new Map<number, number>();
    const lastTrack = new Map<number, number>();
    let changes = 0;
    let blinkerSteps = 0;
    let blinkerWithoutChange = 0;
    while (s.simTimeS < 300) {
      s.step();
      for (let i = 0; i < pool.highWater; i++) {
        const t = pool.track[i] as number;
        if (t < 0) continue;
        const id = pool.id[i] as number;
        const before = lastTrack.get(id);
        lastTrack.set(id, t);
        const blinking = ((pool.flags[i] as number) & BLINKERS) !== 0;
        if (blinking) blinkerSteps++;
        if (before === undefined || before === t) {
          if (blinking && (lastChangeS.get(id) ?? Number.NEGATIVE_INFINITY) < s.simTimeS - 2)
            blinkerWithoutChange++;
          continue;
        }
        changes++;
        const previous = lastChangeS.get(id);
        // One change per 2 s per vehicle (LANE_CHANGE_DURATION_S).
        if (previous !== undefined) expect(s.simTimeS - previous).toBeGreaterThanOrEqual(2 - 1e-9);
        lastChangeS.set(id, s.simTimeS);
      }
    }
    expect(changes).toBeGreaterThan(20);
    expect(blinkerSteps).toBeGreaterThan(0);
    expect(blinkerWithoutChange).toBe(0); // the blinker only burns during the manoeuvre
  });
});

describe("turn pockets", () => {
  function pocketRun(leftPocketM: number) {
    const net = crossroads({ leftPocketM });
    const s = sim(net, {
      demand: {
        multiplier: saturationMultiplier(net) * 1.2,
        warmupMinutes: 3,
        vehicleBudget: 4000,
      },
    });
    const k = kernelOf(s);
    for (const dir of ["N", "E", "S", "W"])
      k.setTurnShares(`${dir}.in`, { left: 0.4, through: 0.6 });
    return { s, k, net };
  }

  it("lets a vehicle into the pocket only where the pocket exists (s >= startS)", () => {
    const { s, k } = pocketRun(60);
    const { pool, runtime } = k;
    const pocket = runtime.laneIndex.get("N.in:0");
    if (pocket === undefined) throw new Error("fixture: pocket lane N.in:0 missing");
    const startS = runtime.trackStartS[pocket] as number;
    expect(startS).toBeCloseTo(240, 6); // armLengthM 300 - pocket 60
    let occupants = 0;
    let minS = Number.POSITIVE_INFINITY;
    s.runUntil(3 * 60);
    while (s.simTimeS < 8 * 60) {
      s.step();
      let i = pool.trackTail[pocket] as number;
      while (i >= 0) {
        occupants++;
        minS = Math.min(minS, pool.s[i] as number);
        i = pool.ahead[i] as number;
      }
    }
    expect(occupants).toBeGreaterThan(100);
    expect(minS).toBeGreaterThanOrEqual(startS);
    expect(k.droppedVehicles).toBe(0);
  });

  it("stops a left-turner in the through lane when the pocket is full (pocket_spillback)", () => {
    const { s, k } = pocketRun(40);
    const { pool, runtime } = k;
    const pocket = runtime.laneIndex.get("N.in:0");
    if (pocket === undefined) throw new Error("fixture: pocket lane N.in:0 missing");
    const startS = runtime.trackStartS[pocket] as number;
    const spillback = causeCode("pocket_spillback");
    let events = 0;
    let worstOvershootM = Number.NEGATIVE_INFINITY;
    s.runUntil(3 * 60);
    while (s.simTimeS < 13 * 60) {
      s.step();
      for (let i = 0; i < pool.highWater; i++) {
        const t = pool.track[i] as number;
        if (t < 0 || (pool.cause[i] as number) !== spillback) continue;
        events++;
        // The vehicle waits in its own lane, at the level where the pocket opens.
        expect(t).not.toBe(pocket);
        worstOvershootM = Math.max(worstOvershootM, (pool.s[i] as number) - startS);
        expect(pool.v[i] as number).toBeLessThan(15);
      }
    }
    expect(events).toBeGreaterThan(0);
    // The cause is decided before integration, so `s` is read one step (< 1.5 m) further along.
    expect(worstOvershootM).toBeLessThan(2);
  });
});
