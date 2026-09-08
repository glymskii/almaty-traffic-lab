/**
 * Unit tests of the precomputed signal-group state machine (T-09). NUANCES N05/N06 live in
 * test/nuances/02-signals.test.ts; this file covers the table's internal contract: offsetS shift,
 * multi-controller/group ordering, and wiring the table onto RuntimeNetwork's connector indices.
 */
import { SignalState } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { RuntimeNetwork } from "../../src/runtime/network.ts";
import { SignalRuntime } from "../../src/runtime/signals.ts";
import { crossroads } from "../fixtures/builders.ts";
import { signalController, signalGroup, signalPhase } from "../fixtures/signals.ts";

const TIMING = { flashingGreenS: 3, redYellowS: 2 };
const DT = 0.1;

function twoPhaseController(offsetS = 0) {
  return signalController({
    id: "c",
    nodeId: "n",
    offsetS,
    groups: [
      signalGroup({ id: "gA", kind: "vehicle" }),
      signalGroup({ id: "gB", kind: "vehicle" }),
    ],
    phases: [
      signalPhase({ id: "pA", greenGroupIds: ["gA"], greenS: 20, yellowS: 3, allRedS: 2 }),
      signalPhase({ id: "pB", greenGroupIds: ["gB"], greenS: 20, yellowS: 3, allRedS: 2 }),
    ],
  });
}

describe("SignalRuntime", () => {
  it("offsetS shifts the whole table by the same amount", () => {
    const plain = new SignalRuntime([twoPhaseController(0)], DT, TIMING);
    const shifted = new SignalRuntime([twoPhaseController(10)], DT, TIMING);
    // cycle = (20+3+2)*2 = 50; sampling every 2 s should agree once offset by 10 s.
    for (let t = 0; t < 50; t += 2) {
      expect(shifted.stateAt(0, t + 10)).toBe(plain.stateAt(0, t));
      expect(shifted.stateAt(1, t + 10)).toBe(plain.stateAt(1, t));
    }
  });

  it("negative and multi-cycle times wrap correctly", () => {
    const sr = new SignalRuntime([twoPhaseController(0)], DT, TIMING);
    expect(sr.stateAt(0, -50)).toBe(sr.stateAt(0, 0));
    expect(sr.stateAt(0, 173)).toBe(sr.stateAt(0, 173 - 3 * 50));
  });

  it("orders groups controller-by-controller, matching RuntimeNetwork.signalGroupIds", () => {
    const c1 = twoPhaseController(0);
    const c2 = signalController({
      id: "c2",
      nodeId: "n2",
      groups: [signalGroup({ id: "gC", kind: "vehicle" })],
      phases: [signalPhase({ id: "p", greenGroupIds: ["gC"], greenS: 10 })],
    });
    const sr = new SignalRuntime([c1, c2], DT, TIMING);
    // Global order: gA=0, gB=1 (controller c1), gC=2 (controller c2).
    expect(sr.groupCount).toBe(3);
    expect(sr.stateAt(2, 0)).toBe(SignalState.GREEN);
  });

  it("network.ts wires connSignalGroup/connProtection consistently with signalGroupIds", () => {
    const net = crossroads({ leftTurnMode: "protected" });
    const rt = new RuntimeNetwork(net, 25);
    let signalizedConnectors = 0;
    for (let t = rt.laneCount; t < rt.trackCount; t++) {
      const g = rt.connSignalGroup[t] as number;
      if (g < 0) continue;
      signalizedConnectors++;
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThan(rt.signalGroupIds.length);
      const groupId = rt.signalGroupIds[g];
      expect(rt.signalGroupIndex.get(groupId as string)).toBe(g);
    }
    expect(signalizedConnectors).toBeGreaterThan(0);
    // Arrow groups are flagged correctly from the network's own group sections.
    const arrowGroupIdx = rt.signalGroupIds.indexOf("sg.N.arrow");
    expect(arrowGroupIdx).toBeGreaterThanOrEqual(0);
    expect(rt.groupIsArrow[arrowGroupIdx]).toBe(1);
    const mainGroupIdx = rt.signalGroupIds.indexOf("sg.N.main");
    expect(rt.groupIsArrow[mainGroupIdx]).toBe(0);
  });
});
