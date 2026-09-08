import { checkNetworkIntegrity, type Network } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import {
  approachSegments,
  corridor,
  crossroads,
  mergeRamp,
  saturationMultiplier,
  straightRoad,
  tJunction,
} from "./builders.ts";

/** Every conflict must be mirrored on the other connector, with the priority flipped. */
function assertConflictsSymmetric(net: Network) {
  const byId = new Map(net.connectors.map((c) => [c.id, c]));
  for (const c of net.connectors) {
    for (const cp of c.conflicts) {
      const other = byId.get(cp.otherConnectorId);
      expect(other).toBeDefined();
      if (!other) continue;
      const back = other.conflicts.find((x) => x.otherConnectorId === c.id);
      expect(back, `${other.id} should have a conflict back to ${c.id}`).toBeDefined();
      if (!back) continue;
      const expected =
        cp.priority === "this" ? "other" : cp.priority === "other" ? "this" : "signal";
      expect(back.priority).toBe(expected);
    }
  }
}

/** Every signalized connector must reference a group that exists on its own node's controller. */
function assertSignalGroupsWireUp(net: Network) {
  const ctrlByNode = new Map(net.signalControllers.map((c) => [c.nodeId, c]));
  for (const c of net.connectors) {
    if (c.protection !== "protected" && c.protection !== "permissive") continue;
    expect(c.signalGroupId, `${c.id} (${c.protection}) should have a signalGroupId`).toBeDefined();
    const ctrl = ctrlByNode.get(c.viaNodeId);
    expect(ctrl, `node ${c.viaNodeId} should have a controller`).toBeDefined();
    if (ctrl && c.signalGroupId) {
      expect(ctrl.groups.some((g) => g.id === c.signalGroupId)).toBe(true);
    }
  }
}

describe("synthetic builders", () => {
  it("straightRoad is a valid network", () => {
    const net = straightRoad({
      lanes: 3,
      busLane: true,
      busStop: { s: 500, kind: "in_lane" },
      busRoute: { headwayPeakS: 300, headwayOffpeakS: 600 },
    });
    expect(net.lanes).toHaveLength(4);
    expect(net.lanes[3]?.kind).toBe("bus");
    expect(net.busRoutes[0]?.stopIds).toEqual(["stop0"]);
  });

  describe("crossroads", () => {
    it("default options: valid, 16 connectors (2 through + 1 left + 1 right per approach)", () => {
      const net = crossroads();
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.connectors).toHaveLength(16);
      assertConflictsSymmetric(net);
      assertSignalGroupsWireUp(net);
      expect(net.connectors.some((c) => c.conflicts.length > 0)).toBe(true);
    });

    it.each([40, 120])(
      "leftPocketM: %i produces a turn_pocket lane opening before the stop line",
      (m) => {
        const net = crossroads({ leftPocketM: m });
        expect(checkNetworkIntegrity(net)).toEqual([]);
        const pocket = net.lanes.find((l) => l.linkId === "N.in" && l.kind === "turn_pocket");
        expect(pocket).toBeDefined();
        expect(pocket?.startS).toBeCloseTo(300 - m);
        expect(pocket?.endS).toBeCloseTo(300);
      },
    );

    it("leftPocketM: 0 puts left on the leftmost through lane (turns: left+through)", () => {
      const net = crossroads({ leftPocketM: 0, leftTurnMode: "permissive" });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.lanes.some((l) => l.linkId === "N.in" && l.kind === "turn_pocket")).toBe(false);
      const leftmost = net.lanes.find((l) => l.linkId === "N.in" && l.index === 0);
      expect(leftmost?.turns).toEqual(expect.arrayContaining(["left", "through"]));
      const left = net.connectors.find((c) => c.fromLaneId === leftmost?.id && c.turn === "left");
      expect(left?.protection).toBe("permissive");
    });

    it("leftTurnMode: prohibited creates no left connectors", () => {
      const net = crossroads({ leftTurnMode: "prohibited" });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.connectors.some((c) => c.turn === "left")).toBe(false);
      const ctrl = net.signalControllers[0];
      expect(ctrl?.leftTurnModes["N.in"]).toBe("prohibited");
    });

    it("leftTurnMode: protected gives left its own protected arrow group and a leading phase", () => {
      const net = crossroads({ leftTurnMode: "protected" });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      const ctrl = net.signalControllers[0];
      expect(ctrl).toBeDefined();
      if (!ctrl) return;
      const nLeft = net.connectors.find(
        (c) => c.turn === "left" && c.fromLaneId.startsWith("N.in"),
      );
      expect(nLeft?.protection).toBe("protected");
      const arrowGroup = ctrl.groups.find((g) => g.id === nLeft?.signalGroupId);
      expect(arrowGroup?.section).toBe("arrow_left");
      const lead = ctrl.phases.find((p) => p.id === "ph.ns.lead");
      expect(lead?.greenGroupIds).toContain(arrowGroup?.id);
      const main = ctrl.phases.find((p) => p.id === "ph.ns");
      expect(main?.greenGroupIds).not.toContain(arrowGroup?.id);
    });

    it("leftTurnMode: protected_permissive keeps the arrow green through the main phase too", () => {
      const net = crossroads({ leftTurnMode: "protected_permissive" });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      const ctrl = net.signalControllers[0];
      expect(ctrl).toBeDefined();
      if (!ctrl) return;
      const nLeft = net.connectors.find(
        (c) => c.turn === "left" && c.fromLaneId.startsWith("N.in"),
      );
      expect(nLeft?.protection).toBe("permissive");
      const lead = ctrl.phases.find((p) => p.id === "ph.ns.lead");
      const main = ctrl.phases.find((p) => p.id === "ph.ns");
      expect(lead?.greenGroupIds).toContain(nLeft?.signalGroupId);
      expect(main?.greenGroupIds).toContain(nLeft?.signalGroupId);
    });

    it("busLaneEW adds a rightmost bus lane on E/W only, carrying the right turn", () => {
      const net = crossroads({ busLaneEW: true });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.connectors).toHaveLength(18); // 16 + bus-through on E and W
      const busLaneE = net.lanes.find((l) => l.linkId === "E.in" && l.kind === "bus");
      expect(busLaneE).toBeDefined();
      expect(busLaneE?.turns).toEqual(expect.arrayContaining(["through", "right"]));
      expect(net.lanes.some((l) => l.linkId === "N.in" && l.kind === "bus")).toBe(false);
      const rightFromBus = net.connectors.find(
        (c) => c.fromLaneId === busLaneE?.id && c.turn === "right",
      );
      expect(rightFromBus).toBeDefined();
    });

    it("crosswalks add a pedestrian group per arm, wired to real exiting connectors", () => {
      const net = crossroads({ crosswalks: true });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.crosswalks).toHaveLength(4);
      for (const cw of net.crosswalks) {
        expect(cw.connectorIds.length).toBeGreaterThan(0);
        expect(cw.signalGroupId).toBeDefined();
      }
      const ctrl = net.signalControllers[0];
      const pedGroups = ctrl?.groups.filter((g) => g.kind === "pedestrian") ?? [];
      expect(pedGroups).toHaveLength(4);
    });

    it.each([0.4, 0.6])("greenSplitNS %s scales the NS/EW main phase durations", (split) => {
      const net = crossroads({ greenSplitNS: split, cycleS: 100 });
      const ctrl = net.signalControllers[0];
      const ns = ctrl?.phases.find((p) => p.id === "ph.ns");
      const ew = ctrl?.phases.find((p) => p.id === "ph.ew");
      expect(ns?.greenS).toBeCloseTo(100 * split);
      expect(ew?.greenS).toBeCloseTo(100 * (1 - split));
    });
  });

  describe("tJunction", () => {
    it("unsignalized (default): minor yields, main has priority, 8 connectors", () => {
      const net = tJunction();
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.signalControllers).toHaveLength(0);
      expect(net.connectors).toHaveLength(8);
      assertConflictsSymmetric(net);
      const minor = net.connectors.filter((c) => c.fromLaneId.startsWith("S.in"));
      const main = net.connectors.filter(
        (c) => c.fromLaneId.startsWith("E.in") || c.fromLaneId.startsWith("W.in"),
      );
      expect(minor.every((c) => c.protection === "yield")).toBe(true);
      expect(main.every((c) => c.protection === "priority")).toBe(true);
      // no through movement continues onto the minor road (it dead-ends the other way)
      expect(
        net.connectors.some((c) => c.turn === "through" && c.fromLaneId.startsWith("S.in")),
      ).toBe(false);
    });

    it("signalized: protected connectors with a 2-phase controller", () => {
      const net = tJunction({ signalized: true });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.nodes.find((n) => n.id === "center")?.kind).toBe("signalized");
      expect(net.signalControllers).toHaveLength(1);
      expect(net.connectors.every((c) => c.protection === "protected")).toBe(true);
      assertSignalGroupsWireUp(net);
      assertConflictsSymmetric(net);
    });
  });

  describe("mergeRamp", () => {
    it("default (no accel lane): ramp yields directly into the rightmost main lane", () => {
      const net = mergeRamp();
      expect(checkNetworkIntegrity(net)).toEqual([]);
      const mergeConn = net.connectors.find((c) => c.turn === "merge");
      expect(mergeConn?.protection).toBe("yield");
      expect(mergeConn?.toLaneId).toBe("main.after:1");
      expect(mergeConn?.conflicts).toHaveLength(1);
      assertConflictsSymmetric(net);
      expect(net.connectors.filter((c) => c.turn === "through")).toHaveLength(2);
    });

    it("accelLaneM > 0 adds a tapering lane with turns: [merge]", () => {
      const net = mergeRamp({ accelLaneM: 200, mainLengthM: 1500 });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      const accel = net.lanes.find((l) => l.id === "main.after:2");
      expect(accel).toBeDefined();
      expect(accel?.startS).toBe(0);
      expect(accel?.endS).toBe(200);
      expect(accel?.endS).toBeLessThan(1000); // < afterLengthM (1500 - 500)
      expect(accel?.turns).toEqual(["merge"]);
      const mergeConn = net.connectors.find((c) => c.turn === "merge");
      expect(mergeConn?.toLaneId).toBe("main.after:2");
    });
  });

  describe("corridor", () => {
    it("default: 4 signalized intersections sharing the EW backbone", () => {
      const net = corridor();
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(net.signalControllers).toHaveLength(4);
      expect(net.signalControllers.every((c) => c.offsetS === 0)).toBe(true);
      assertConflictsSymmetric(net);
      assertSignalGroupsWireUp(net);
      // intersections share backbone links: 2 end gates + 2 cross-street gates per intersection
      expect(net.gates).toHaveLength(2 + 2 * 4);
    });

    it("offsetsS feeds each intersection's controller.offsetS", () => {
      const net = corridor({ offsetsS: [0, 10, 20, 30] });
      const byNode = new Map(net.signalControllers.map((c) => [c.nodeId, c.offsetS]));
      expect(byNode.get("j0")).toBe(0);
      expect(byNode.get("j1")).toBe(10);
      expect(byNode.get("j2")).toBe(20);
      expect(byNode.get("j3")).toBe(30);
    });

    it("parallelStreet adds a residential street T-joined to every cross street", () => {
      const net = corridor({ parallelStreet: true, intersections: 3 });
      expect(checkNetworkIntegrity(net)).toEqual([]);
      assertConflictsSymmetric(net);
      for (let i = 0; i < 3; i++) {
        const node = net.nodes.find((n) => n.id === `j${i}.N.gate`);
        expect(node?.kind).toBe("junction");
      }
      expect(net.nodes.some((n) => n.id === "res.gate.w")).toBe(true);
      expect(net.nodes.some((n) => n.id === "res.gate.e")).toBe(true);
      expect(net.gates.some((g) => g.id === "g.res.w")).toBe(true);
      expect(net.gates.some((g) => g.id === "g.res.e")).toBe(true);
      // no gate was created for the cross-street stubs that now T-join the residential street
      expect(net.gates.some((g) => g.nodeId === "j0.N.gate")).toBe(false);
    });
  });

  describe("test helpers", () => {
    it("saturationMultiplier returns a positive finite number for every fixture", () => {
      for (const net of [straightRoad(), crossroads(), tJunction(), mergeRamp(), corridor()]) {
        const m = saturationMultiplier(net);
        expect(Number.isFinite(m)).toBe(true);
        expect(m).toBeGreaterThan(0);
      }
    });

    it("saturationMultiplier is lower for the axis with less green time", () => {
      const netEven = crossroads({ greenSplitNS: 0.5 });
      const netStarvedEW = crossroads({ greenSplitNS: 0.8 }); // EW gets little green
      expect(saturationMultiplier(netStarvedEW)).toBeLessThan(saturationMultiplier(netEven));
    });

    it("approachSegments slices a link into segmentLengthM chunks, tagging the last one", () => {
      const net = straightRoad({ lengthM: 120 });
      const segs = approachSegments(net, "l0", 25);
      const lane0 = segs.filter((s) => s.laneId === "l0:0");
      expect(lane0).toHaveLength(5); // 25*4 + 20
      expect(lane0[0]?.startS).toBe(0);
      expect(lane0[lane0.length - 1]?.endS).toBeCloseTo(120);
      expect(lane0[lane0.length - 1]?.approachNodeId).toBe("n1");
      expect(lane0[0]?.approachNodeId).toBeUndefined();
    });
  });
});
