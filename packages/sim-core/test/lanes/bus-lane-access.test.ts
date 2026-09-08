/**
 * Bus-lane access rules (T-10, the lane-level half of N15/N16): a car may enter a dedicated lane
 * only to turn right within `carsMayEnterForRightTurnWithinM`, as a violator, outside the hours the
 * lane is in force, or as a taxi when the scenario allows it. The bus side of these nuances (bus
 * travel times, N14-N16 proper) arrives with T-14.
 */
import { defaultSimConfig, type SimConfigPatch, VehicleFlag } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier, straightRoad } from "../fixtures/builders.ts";

const ARM_LENGTH_M = 300;
const STRAIGHT_LENGTH_M = 1000;
const RIGHT_TURN_WINDOW_M = 50; // BusLaneRuleSchema default

/** East-west bus lane; the right turn from the E/W approach starts in that lane by construction. */
function busLaneNetwork() {
  return crossroads({ busLaneEW: true, lanes: 2 });
}

function run(patch: SimConfigPatch, rightShare = 1) {
  const net = busLaneNetwork();
  const config = defaultSimConfig({
    seed: 1,
    ...patch,
    demand: {
      multiplier: saturationMultiplier(net) * 0.6,
      warmupMinutes: 1,
      vehicleBudget: 3000,
      taxiShare: 0,
      ...patch.demand,
    },
  });
  const s = createSimulation({ network: net, config });
  const k = kernelOf(s);
  k.setTurnShares("E.in", { right: rightShare, through: 1 - rightShare });
  k.setTurnShares("W.in", { right: rightShare, through: 1 - rightShare });
  const busLane = k.runtime.laneIndex.get("E.in:3");
  if (busLane === undefined) throw new Error("fixture: bus lane E.in:3 missing");
  return { s, k, busLane };
}

/**
 * Two general lanes plus a dedicated bus lane running to a gate, with an optional time window on the
 * bus-lane rule. Cars never spawn on a dedicated lane, so anything found there changed into it.
 */
function straightRun(
  patch: SimConfigPatch,
  window?: { activeFromMin: number; activeToMin: number },
) {
  const net = straightRoad({ lanes: 2, busLane: true });
  if (window) {
    for (const lane of net.lanes) if (lane.busLane) lane.busLane = { ...lane.busLane, ...window };
  }
  const config = defaultSimConfig({
    seed: 1,
    ...patch,
    demand: {
      multiplier: saturationMultiplier(net),
      warmupMinutes: 1,
      vehicleBudget: 2000,
      taxiShare: 0,
      ...patch.demand,
    },
  });
  const s = createSimulation({ network: net, config });
  const k = kernelOf(s);
  const busLane = k.runtime.laneIndex.get("l0:2");
  if (busLane === undefined) throw new Error("fixture: bus lane l0:2 missing");
  s.runUntil(60);
  return { s, k, busLane };
}

/** Distance still left to the end of `lane` at the moment each vehicle appeared on it, in metres. */
function entriesOnLane(
  s: ReturnType<typeof createSimulation>,
  k: ReturnType<typeof kernelOf>,
  lane: number,
  untilS: number,
  lengthM = ARM_LENGTH_M,
): { remainingM: number; violator: boolean }[] {
  const pool = k.pool;
  const present = new Set<number>();
  const out: { remainingM: number; violator: boolean }[] = [];
  while (s.simTimeS < untilS) {
    s.step();
    const now = new Set<number>();
    let i = pool.trackTail[lane] as number;
    while (i >= 0) {
      const id = pool.id[i] as number;
      now.add(id);
      if (!present.has(id)) {
        out.push({
          remainingM: lengthM - (pool.s[i] as number),
          violator: ((pool.persistentFlags[i] as number) & VehicleFlag.BUS_LANE_VIOLATOR) !== 0,
        });
      }
      i = pool.ahead[i] as number;
    }
    present.clear();
    for (const id of now) present.add(id);
  }
  return out;
}

describe("cars in a bus lane", () => {
  it("enter only inside the right-turn window, and only when they actually turn right", () => {
    const { s, k, busLane } = run({ behavior: { busLaneViolatorShare: 0 } });
    s.runUntil(60);
    const entries = entriesOnLane(s, k, busLane, 600);
    expect(entries.length).toBeGreaterThan(20);
    for (const e of entries) {
      expect(e.remainingM).toBeLessThanOrEqual(RIGHT_TURN_WINDOW_M + 1e-6);
      expect(e.remainingM).toBeGreaterThanOrEqual(0);
    }
    // The right turn from this approach exists only out of the bus lane, so it is actually used.
    expect(k.droppedVehicles).toBe(0);
    expect(s.tripStats().total.completed).toBeGreaterThan(50);
  });

  it("never enter it at all when nobody on the approach turns right", () => {
    const { s, k, busLane } = run({ behavior: { busLaneViolatorShare: 0 } }, 0);
    s.runUntil(60);
    expect(entriesOnLane(s, k, busLane, 600)).toHaveLength(0);
  });

  // The remaining exceptions do not depend on a turn, so they are shown on `straightRoad`, whose
  // bus lane runs to a gate: on the crossroads approach a car going straight would have to leave the
  // bus lane at the stop line anyway (its only through connector feeds the opposite bus lane).
  it("ignore the restriction when they are flagged as violators", () => {
    const { s, k, busLane } = straightRun({ behavior: { busLaneViolatorShare: 1 } });
    const entries = entriesOnLane(s, k, busLane, 600, STRAIGHT_LENGTH_M);
    expect(entries.length).toBeGreaterThan(20);
    for (const e of entries) expect(e.violator).toBe(true);
    // Violators use the whole length of the lane, not just its last 50 m.
    expect(Math.max(...entries.map((e) => e.remainingM))).toBeGreaterThan(RIGHT_TURN_WINDOW_M);
  });

  it("stay out of it when nobody violates and the lane is in force all day", () => {
    const { s, k, busLane } = straightRun({ behavior: { busLaneViolatorShare: 0 } });
    expect(entriesOnLane(s, k, busLane, 600, STRAIGHT_LENGTH_M)).toHaveLength(0);
  });

  it("treat the lane as a general one outside the hours it is in force", () => {
    const inForce = straightRun(
      { behavior: { busLaneViolatorShare: 0 }, startTimeMin: 8 * 60 },
      {
        activeFromMin: 7 * 60,
        activeToMin: 10 * 60,
      },
    );
    expect(inForce.k.lanes.busLaneActive(inForce.busLane, 8 * 60)).toBe(true);
    expect(
      entriesOnLane(inForce.s, inForce.k, inForce.busLane, 600, STRAIGHT_LENGTH_M),
    ).toHaveLength(0);

    const offHours = straightRun(
      { behavior: { busLaneViolatorShare: 0 }, startTimeMin: 14 * 60 },
      {
        activeFromMin: 7 * 60,
        activeToMin: 10 * 60,
      },
    );
    expect(offHours.k.lanes.busLaneActive(offHours.busLane, 14 * 60)).toBe(false);
    const entries = entriesOnLane(offHours.s, offHours.k, offHours.busLane, 600, STRAIGHT_LENGTH_M);
    expect(entries.length).toBeGreaterThan(20);
    for (const e of entries) expect(e.violator).toBe(false);
  });

  it("let taxis in only when the scenario allows it", () => {
    const forbidden = straightRun({
      behavior: { busLaneViolatorShare: 0, taxisAllowedInBusLanes: false },
      demand: { taxiShare: 1 },
    });
    expect(
      entriesOnLane(forbidden.s, forbidden.k, forbidden.busLane, 600, STRAIGHT_LENGTH_M),
    ).toHaveLength(0);

    const allowed = straightRun({
      behavior: { busLaneViolatorShare: 0, taxisAllowedInBusLanes: true },
      demand: { taxiShare: 1 },
    });
    expect(
      entriesOnLane(allowed.s, allowed.k, allowed.busLane, 600, STRAIGHT_LENGTH_M).length,
    ).toBeGreaterThan(20);
  });
});
