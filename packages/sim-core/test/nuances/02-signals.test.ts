/**
 * Nuance tests N05-N08: signals. Fixtures: crossroads, corridor. Closed by T-09 (N05, N06), T-18 (N07), T-22 (N08).
 */
import { allocateFrameBuffers, defaultSimConfig, SignalState } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { SignalRuntime } from "../../src/runtime/signals.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, saturationMultiplier } from "../fixtures/builders.ts";
import { signalController, signalGroup, signalPhase } from "../fixtures/signals.ts";

describe("N05 red stops, green discharges", () => {
  it("queue grows during red and discharges at ~1800 veh/h/lane during green (±15%)", () => {
    const net = crossroads({ lanes: 1, leftTurnMode: "prohibited", leftPocketM: 0 });
    // 1.5x the ~1.2x-of-capacity estimate: comfortably oversaturated so the queue never empties
    // mid-green, whichever cycle we happen to sample.
    const config = defaultSimConfig({
      demand: { multiplier: saturationMultiplier(net) * 1.5, vehicleBudget: 800, warmupMinutes: 0 },
    });
    const sim = createSimulation({ network: net, config });
    const { runtime, pool } = kernelOf(sim);
    const laneTrack = runtime.laneIndex.get("N.in:0");
    if (laneTrack === undefined) throw new Error("fixture: lane N.in:0 missing");
    const groupIdx = runtime.signalGroupIds.indexOf("sg.N.main");
    expect(groupIdx).toBeGreaterThanOrEqual(0);

    const frame = allocateFrameBuffers(
      pool.capacity,
      runtime.signalGroupIds.length,
      runtime.crosswalkIds.length,
    );
    const stateAt = (): number => sim.writeFrame(frame).signalStates[groupIdx] as number;

    function queueLength(): number {
      let n = 0;
      let i = pool.trackTail[laneTrack as number] as number;
      while (i >= 0) {
        if ((pool.v[i] as number) <= config.metrics.stoppedSpeedMps) n++;
        i = pool.ahead[i] as number;
      }
      return n;
    }

    function occupantIds(): Set<number> {
      const ids = new Set<number>();
      let i = pool.trackTail[laneTrack as number] as number;
      while (i >= 0) {
        ids.add(pool.id[i] as number);
        i = pool.ahead[i] as number;
      }
      return ids;
    }

    function advance(): number {
      sim.step();
      return stateAt();
    }

    // Let the approach saturate over a few cycles before measuring.
    sim.runUntil(300);
    let state = stateAt();

    // --- Red: the queue must grow over a full red phase. ---
    while (state !== SignalState.RED) state = advance();
    const queueAtRedStart = queueLength();
    while (state === SignalState.RED) state = advance();
    const queueAtRedEnd = queueLength();
    expect(queueAtRedEnd).toBeGreaterThan(queueAtRedStart);

    // --- Green: discharge flow across the stop line should approximate saturation flow. Averaged
    // over several green phases: a single ~45 s phase only fits ~19-21 discharges, so +/-1 vehicle
    // is +/-80 veh/h of pure counting noise around the 1800 +/-15% band. ---
    const CYCLES = 8;
    let totalDischarged = 0;
    let totalGreenS = 0;
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      while (state !== SignalState.GREEN) state = advance();
      let prevIds = occupantIds();
      let discharged = 0;
      const greenStart = sim.simTimeS;
      while (state === SignalState.GREEN || state === SignalState.FLASHING_GREEN) {
        state = advance();
        const ids = occupantIds();
        for (const id of prevIds) if (!ids.has(id)) discharged++;
        prevIds = ids;
      }
      totalDischarged += discharged;
      totalGreenS += sim.simTimeS - greenStart;
    }
    const flowVehPerHPerLane = (totalDischarged / totalGreenS) * 3600;
    expect(flowVehPerHPerLane).toBeGreaterThan(1800 * 0.85);
    expect(flowVehPerHPerLane).toBeLessThan(1800 * 1.15);
  });
});

describe("N06 local signal sequence", () => {
  // Minimal 2-phase controller: group "gA" is green in phase 1, red the rest of the cycle except the
  // redYellowS window right before its own next green (docs/ARCHITECTURE.md "Светофоры").
  const TIMING = { flashingGreenS: 3, redYellowS: 2 };
  const ctrl = signalController({
    id: "c",
    nodeId: "n",
    groups: [
      signalGroup({ id: "gA", kind: "vehicle" }),
      signalGroup({ id: "gB", kind: "vehicle" }),
    ],
    phases: [
      signalPhase({ id: "pA", greenGroupIds: ["gA"], greenS: 20, yellowS: 3, allRedS: 2 }),
      signalPhase({ id: "pB", greenGroupIds: ["gB"], greenS: 20, yellowS: 3, allRedS: 2 }),
    ],
  });
  const sr = new SignalRuntime([ctrl], 0.1, TIMING);
  const gA = 0;
  // cycle = (20 + 3 + 2) * 2 = 50 s.

  it("group state timeline is GREEN -> FLASHING_GREEN (3 s) -> YELLOW -> RED -> RED_YELLOW (2 s) -> GREEN", () => {
    expect(sr.stateAt(gA, 0)).toBe(SignalState.GREEN);
    expect(sr.stateAt(gA, 16.9)).toBe(SignalState.GREEN);
    expect(sr.stateAt(gA, 17.1)).toBe(SignalState.FLASHING_GREEN); // last 3 s of green: [17, 20)
    expect(sr.stateAt(gA, 19.9)).toBe(SignalState.FLASHING_GREEN);
    expect(sr.stateAt(gA, 20.1)).toBe(SignalState.YELLOW); // [20, 23)
    expect(sr.stateAt(gA, 22.9)).toBe(SignalState.YELLOW);
    expect(sr.stateAt(gA, 23.1)).toBe(SignalState.RED); // own allRed, then all of phase B
    expect(sr.stateAt(gA, 40)).toBe(SignalState.RED);
    expect(sr.stateAt(gA, 47.9)).toBe(SignalState.RED); // still red just before its own red-yellow
    expect(sr.stateAt(gA, 48.1)).toBe(SignalState.RED_YELLOW); // [48, 50)
    expect(sr.stateAt(gA, 49.9)).toBe(SignalState.RED_YELLOW);
    expect(sr.stateAt(gA, 50.0)).toBe(SignalState.GREEN); // wraps into the next cycle
  });

  it("arrow sections report OFF, never RED, outside their green", () => {
    const arrowCtrl = signalController({
      id: "c2",
      nodeId: "n",
      groups: [
        signalGroup({ id: "main", kind: "vehicle", section: "main" }),
        signalGroup({ id: "arrow", kind: "vehicle", section: "arrow_left" }),
      ],
      phases: [
        signalPhase({ id: "p1", greenGroupIds: ["arrow"], greenS: 10, yellowS: 3, allRedS: 2 }),
        signalPhase({ id: "p2", greenGroupIds: ["main"], greenS: 30, yellowS: 3, allRedS: 2 }),
      ],
    });
    const arrowSr = new SignalRuntime([arrowCtrl], 0.1, TIMING);
    const arrowIdx = 1;
    expect(arrowSr.stateAt(arrowIdx, 0)).toBe(SignalState.GREEN);
    expect(arrowSr.stateAt(arrowIdx, 7.1)).toBe(SignalState.FLASHING_GREEN); // last 3 s: [7, 10)
    expect(arrowSr.stateAt(arrowIdx, 10.1)).toBe(SignalState.OFF); // own yellow/allRed window
    expect(arrowSr.stateAt(arrowIdx, 20)).toBe(SignalState.OFF); // main's green
    expect(arrowSr.stateAt(arrowIdx, 48)).toBe(SignalState.OFF); // where a red-yellow window would be
    const cycleS = 10 + 3 + 2 + 30 + 3 + 2;
    for (let t = 0; t < cycleS; t += 0.5) {
      const state = arrowSr.stateAt(arrowIdx, t);
      expect(state).not.toBe(SignalState.RED);
      expect(state).not.toBe(SignalState.RED_YELLOW);
      expect(state).not.toBe(SignalState.YELLOW);
    }
  });
});

describe("N07 green split", () => {
  /**
   * Windowed vehicle-delay on each axis of a saturated crossroads with the given NS green share.
   * Demand is deliberately taken from one reference network so that both runs load the junction
   * exactly the same way: `saturationMultiplier` itself reads the green share, so asking each
   * network for its own multiplier would change the demand along with the split.
   */
  function axisDelaysS(greenSplitNS: number, multiplier: number): { ns: number; ew: number } {
    const network = crossroads({
      lanes: 1,
      leftTurnMode: "prohibited",
      leftPocketM: 0,
      greenSplitNS,
    });
    const config = defaultSimConfig({
      demand: { multiplier, warmupMinutes: 3, vehicleBudget: 4000 },
    });
    const sim = createSimulation({ network, config });
    sim.runUntil((3 + 10) * 60);
    const metrics = sim.writeMetrics();
    const segments = sim.segments();
    let ns = 0;
    let ew = 0;
    for (const seg of segments) {
      const delay = metrics.delayVehS[seg.index] as number;
      if (seg.linkId === "N.in" || seg.linkId === "S.in") ns += delay;
      else if (seg.linkId === "E.in" || seg.linkId === "W.in") ew += delay;
    }
    expect(ns).toBeGreaterThan(0);
    expect(ew).toBeGreaterThan(0);
    return { ns, ew };
  }

  it("moving green from the EW axis to the NS axis moves the delay with it", () => {
    const reference = crossroads({ lanes: 1, leftTurnMode: "prohibited", leftPocketM: 0 });
    const multiplier = saturationMultiplier(reference) * 1.2;
    const nsShort = axisDelaysS(0.4, multiplier);
    const nsLong = axisDelaysS(0.6, multiplier);
    // More green for NS: its approaches wait less, the EW approaches wait more. Monotone in both
    // directions, which is the whole point of the nuance.
    expect(nsLong.ns).toBeLessThan(nsShort.ns);
    expect(nsLong.ew).toBeGreaterThan(nsShort.ew);
    // ... and the axis with the short green is the one that suffers in each run.
    expect(nsShort.ns).toBeGreaterThan(nsShort.ew);
    expect(nsLong.ew).toBeGreaterThan(nsLong.ns);
  });
});

describe("N08 green wave", () => {
  it.todo(
    "corridor offsets = spacing / speed give fewer stops per vehicle than zero offsets (≥25% fewer)",
  );
});
