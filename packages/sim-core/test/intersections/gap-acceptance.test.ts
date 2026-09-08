/**
 * Gap acceptance and gridlock occupancy (T-11), unit level: `IntersectionRuntime` is driven with a
 * hand-placed vehicle pool on the unsignalized T-junction, where the right of way of every crossing
 * is a plain `this`/`other` pair. The end-to-end behaviour lives in the nuance tests (N10-N12, N19).
 */
import { defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { IntersectionRuntime } from "../../src/runtime/intersections.ts";
import { RuntimeNetwork } from "../../src/runtime/network.ts";
import { VehiclePool } from "../../src/runtime/vehicles.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, tJunction } from "../fixtures/builders.ts";

const SEGMENT_M = 25;
const STOPPED_MPS = defaultSimConfig().metrics.stoppedSpeedMps;
const NO_SIGNALS = new Uint8Array(0);

const net = tJunction();
const rt = new RuntimeNetwork(net, SEGMENT_M);

function trackOf(id: string): number {
  const c = rt.connectorIndex.get(id);
  if (c === undefined) throw new Error(`fixture: connector ${id} missing`);
  return rt.laneCount + c;
}

/** Puts one vehicle on `track` at `s` with speed `v`; returns its pool slot. */
function place(pool: VehiclePool, track: number, s: number, v: number, lengthM = 4.5): number {
  const i = pool.alloc();
  pool.s[i] = s;
  pool.v[i] = v;
  pool.length[i] = lengthM;
  pool.nextTrack[i] = -1;
  pool.insert(track, i);
  return i;
}

function fresh(): { pool: VehiclePool; ir: IntersectionRuntime } {
  return { pool: new VehiclePool(64, rt.trackCount), ir: new IntersectionRuntime(net, rt) };
}

/** The entry of `t`'s conflict list that describes its crossing with `other`. */
function entryOf(ir: IntersectionRuntime, t: number, other: number): number {
  const start = ir.conflicts.conflictStart[t] as number;
  const count = ir.conflicts.conflictCount[t] as number;
  for (let k = start; k < start + count; k++) {
    if ((ir.conflicts.conflictOther[k] as number) === other) return k;
  }
  throw new Error("fixture: the two movements do not conflict");
}

describe("who gives way", () => {
  const minorLeft = trackOf("S.in:0>W.out:0");
  const mainThrough = trackOf("W.in:0>E.out:0");
  const mainLeft = trackOf("E.in:0>S.out:0");

  it("makes the minor movement yield at every point and the main through at none", () => {
    const { pool, ir } = fresh();
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    const all = (t: number): number[] => {
      const start = ir.conflicts.conflictStart[t] as number;
      const count = ir.conflicts.conflictCount[t] as number;
      return Array.from(ir.mustYield.subarray(start, start + count));
    };
    expect(all(minorLeft).every((v) => v === 1)).toBe(true);
    expect(all(mainThrough).every((v) => v === 0)).toBe(true);
  });

  it("makes a priority movement yield where the point says the other side has right of way", () => {
    const { pool, ir } = fresh();
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    // The main left is `protection: priority`, yet it gives way to the opposing main through and
    // keeps right of way over the minor left: only ConflictPoint.priority decides.
    expect(ir.mustYield[entryOf(ir, mainLeft, mainThrough)]).toBe(1);
    expect(ir.mustYield[entryOf(ir, mainLeft, minorLeft)]).toBe(0);
    expect(ir.mustYield[entryOf(ir, minorLeft, mainLeft)]).toBe(1);
  });
});

describe("time to the conflict point", () => {
  const minorLeft = trackOf("S.in:0>W.out:0");
  const mainThrough = trackOf("W.in:0>E.out:0");

  it("is infinite while nobody is coming", () => {
    const { pool, ir } = fresh();
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    expect(ir.threatTimeS[entryOf(ir, minorLeft, mainThrough)]).toBe(Number.POSITIVE_INFINITY);
    expect(ir.pointOccupied[entryOf(ir, minorLeft, mainThrough)]).toBe(0);
  });

  it("is the remaining distance over the speed of the nearest priority vehicle", () => {
    const { pool, ir } = fresh();
    const k = entryOf(ir, minorLeft, mainThrough);
    const sOther = ir.conflicts.conflictSOther[k] as number;
    place(pool, mainThrough, sOther - 12, 8);
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    expect(ir.threatTimeS[k]).toBeCloseTo(12 / 8, 9);
    // A vehicle that has already passed the point is no threat any more.
    const { pool: pool2, ir: ir2 } = fresh();
    place(pool2, mainThrough, sOther + 8, 8);
    ir2.update(pool2, NO_SIGNALS, STOPPED_MPS);
    expect(ir2.threatTimeS[k]).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts a vehicle that is still on the feeding lane and committed to the movement", () => {
    const { pool, ir } = fresh();
    const k = entryOf(ir, minorLeft, mainThrough);
    const sOther = ir.conflicts.conflictSOther[k] as number;
    const lane = rt.connFromLane[mainThrough - rt.laneCount] as number;
    const laneEnd = rt.trackEndS[lane] as number;
    const i = place(pool, lane, laneEnd - 10, 10);
    pool.nextTrack[i] = mainThrough;
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    expect(ir.threatTimeS[k]).toBeCloseTo((10 + sOther) / 10, 9);
    // The same vehicle heading somewhere else is not a threat on this movement.
    pool.nextTrack[i] = -1;
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    expect(ir.threatTimeS[k]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("occupancy and gridlock", () => {
  const minorLeft = trackOf("S.in:0>W.out:0");
  const mainThrough = trackOf("W.in:0>E.out:0");

  it("marks the point occupied while a body covers it", () => {
    const { pool, ir } = fresh();
    const k = entryOf(ir, minorLeft, mainThrough);
    const sOther = ir.conflicts.conflictSOther[k] as number;
    place(pool, mainThrough, sOther + 1, 6);
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    expect(ir.pointOccupied[k]).toBe(1);
    expect(ir.pointJammed[k]).toBe(0); // it is crossing, not stuck
  });

  it("calls it a jam only when the vehicle is stopped and its own exit has no room", () => {
    const exitLane = rt.connToLane[mainThrough - rt.laneCount] as number;
    const { pool, ir } = fresh();
    const k = entryOf(ir, minorLeft, mainThrough);
    const sOther = ir.conflicts.conflictSOther[k] as number;
    place(pool, mainThrough, sOther, 0);
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    // Stopped on the point but the exit is empty: it will move on, so it is not a lock.
    expect(ir.pointOccupied[k]).toBe(1);
    expect(ir.pointJammed[k]).toBe(0);
    expect(ir.exitFreeM[mainThrough]).toBe(Number.POSITIVE_INFINITY);

    // Now block the exit with a standing vehicle right at its start.
    place(pool, exitLane, 4.5, 0);
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    expect(ir.exitFreeM[mainThrough]).toBeCloseTo(0, 9);
    expect(ir.pointJammed[k]).toBe(1);
  });

  it("reports the exit as free while its last vehicle is still moving", () => {
    const { pool, ir } = fresh();
    const exitLane = rt.connToLane[mainThrough - rt.laneCount] as number;
    place(pool, exitLane, 4.5, 5);
    ir.update(pool, NO_SIGNALS, STOPPED_MPS);
    expect(ir.exitFreeM[mainThrough]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("a signalized crossing", () => {
  it("never lets a permissive movement give way to one the controller is holding at red", () => {
    const signalized = crossroads({ leftPocketM: 0, leftTurnMode: "permissive" });
    const srt = new RuntimeNetwork(signalized, SEGMENT_M);
    const ir = new IntersectionRuntime(signalized, srt);
    const pool = new VehiclePool(16, srt.trackCount);
    const left = srt.laneCount + (srt.connectorIndex.get("N.in:0>E.out:0") as number);
    const opposing = srt.laneCount + (srt.connectorIndex.get("S.in:0>N.out:0") as number);
    const start = ir.conflicts.conflictStart[left] as number;
    const count = ir.conflicts.conflictCount[left] as number;
    let k = -1;
    for (let m = start; m < start + count; m++) {
      if ((ir.conflicts.conflictOther[m] as number) === opposing) k = m;
    }
    expect(k).toBeGreaterThanOrEqual(0);

    const green = new Uint8Array(srt.signalGroupIds.length).fill(2 /* GREEN */);
    ir.update(pool, green, STOPPED_MPS);
    expect(ir.mustYield[k]).toBe(1); // the permissive left waits for the opposing through
    const red = new Uint8Array(srt.signalGroupIds.length); // RED = 0
    ir.update(pool, red, STOPPED_MPS);
    expect(ir.mustYield[k]).toBe(0);
  });
});

describe("no two vehicles on the same conflict point", () => {
  it("holds over a busy signalized junction", () => {
    const network = crossroads({ leftPocketM: 0, leftTurnMode: "permissive" });
    const config = defaultSimConfig({
      seed: 7,
      demand: { tripsPerHourPeak: 2400, warmupMinutes: 1, vehicleBudget: 2000 },
    });
    const sim = createSimulation({ network, config });
    const { runtime, pool, intersections } = kernelOf(sim);
    const cf = intersections.conflicts;
    const ZONE_M = 2;

    /** True while some vehicle of `track` covers coordinate `sPoint` on it. */
    const covers = (track: number, sPoint: number): boolean => {
      for (let i = pool.trackTail[track] as number; i >= 0; i = pool.ahead[i] as number) {
        const s = pool.s[i] as number;
        if (s >= sPoint - ZONE_M && s - (pool.length[i] as number) <= sPoint + ZONE_M) return true;
      }
      return false;
    };

    let shared = 0;
    sim.runUntil(60);
    while (sim.simTimeS < 420) {
      sim.step();
      for (let t = runtime.laneCount; t < runtime.trackCount; t++) {
        if ((pool.trackTail[t] as number) < 0) continue;
        const start = cf.conflictStart[t] as number;
        const count = cf.conflictCount[t] as number;
        for (let k = start; k < start + count; k++) {
          const other = cf.conflictOther[k] as number;
          if (other < t) continue; // each crossing is stored on both sides; check it once
          if ((pool.trackTail[other] as number) < 0) continue;
          if (
            covers(t, cf.conflictSThis[k] as number) &&
            covers(other, cf.conflictSOther[k] as number)
          ) {
            shared++;
          }
        }
      }
    }
    expect(shared).toBe(0);
  }, 60000);
});
