import {
  checkNetworkIntegrity,
  defaultSimConfig,
  type Network,
  type NetworkOverride,
  parseNetwork,
} from "@atl/contracts";
import { crossroads, straightRoad } from "@atl/sim-core/test-fixtures";
import { describe, expect, it } from "vitest";
import { applyOverrides } from "../../src/compiler/overrides.ts";

const config = defaultSimConfig();

function laneById(net: Network, id: string) {
  const lane = net.lanes.find((l) => l.id === id);
  if (lane === undefined) throw new Error(`no lane ${id}`);
  return lane;
}

function linkById(net: Network, id: string) {
  const link = net.links.find((l) => l.id === id);
  if (link === undefined) throw new Error(`no link ${id}`);
  return link;
}

describe("applyOverrides: link", () => {
  it("changes the general lane count of a link and rebuilds its lanes 1:1", () => {
    const base = straightRoad({ lanes: 2 });
    const overrides: NetworkOverride[] = [{ kind: "link", linkId: "l0", set: { generalLanes: 3 } }];
    const out = applyOverrides(base, overrides, config);
    const link = linkById(out, "l0");
    expect(link.laneIds).toEqual(["l0:0", "l0:1", "l0:2"]);
    expect(link.laneIds.every((id, i) => laneById(out, id).index === i)).toBe(true);
    expect(link.provenance.laneIds).toBe("manual");
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("does not touch lanes when only speedLimitKph changes", () => {
    const base = straightRoad({ lanes: 2, speedLimitKph: 60 });
    const out = applyOverrides(base, [{ kind: "link", linkId: "l0", set: { speedLimitKph: 40 } }]);
    const link = linkById(out, "l0");
    expect(link.speedLimitKph).toBe(40);
    expect(link.laneIds).toEqual(base.links[0]?.laneIds);
    expect(link.provenance.speedLimitKph).toBe("manual");
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("extends a left-turn pocket at a signalized node and refreshes its connectors/zebras", () => {
    const base = crossroads({ leftPocketM: 60, crosswalks: true });
    const before = base.links.find((l) => l.id === "N.in");
    if (before === undefined) throw new Error("no N.in");
    const beforePocket = base.lanes.find((l) => l.linkId === "N.in" && l.kind === "turn_pocket");
    expect(beforePocket?.startS).toBeCloseTo(before.lengthM - 60, 5);

    const out = applyOverrides(base, [
      { kind: "link", linkId: "N.in", set: { leftPocketLengthM: 120 } },
    ]);
    const link = linkById(out, "N.in");
    const pocket = out.lanes.find((l) => l.linkId === "N.in" && l.kind === "turn_pocket");
    expect(pocket).toBeDefined();
    expect(pocket?.startS).toBeCloseTo(link.lengthM - 120, 5);
    // Connectors and zebras at both ends were rebuilt to point at the (unchanged-id) lanes.
    expect(out.connectors.some((c) => c.fromLaneId === pocket?.id)).toBe(true);
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("removing a left pocket (length 0) folds the left turn back into the leftmost through lane", () => {
    const base = crossroads({ leftPocketM: 60 });
    const out = applyOverrides(base, [
      { kind: "link", linkId: "N.in", set: { leftPocketLengthM: 0 } },
    ]);
    const link = linkById(out, "N.in");
    expect(out.lanes.some((l) => l.linkId === "N.in" && l.kind === "turn_pocket")).toBe(false);
    const leftmost = laneById(out, link.laneIds[0] as string);
    expect(leftmost.turns).toContain("left");
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("adds a right-turn pocket, taking the right turn out of the general lane next to it", () => {
    const base = crossroads({ leftPocketM: 0, busLaneEW: false });
    const before = linkById(base, "E.in");
    const out = applyOverrides(base, [
      { kind: "link", linkId: "E.in", set: { rightPocketLengthM: 50 } },
    ]);
    const link = linkById(out, "E.in");
    expect(link.laneIds).toHaveLength(before.laneIds.length + 1);
    const pocketId = link.laneIds[link.laneIds.length - 1] as string;
    const pocket = laneById(out, pocketId);
    expect(pocket.kind).toBe("turn_pocket");
    expect(pocket.turns).toEqual(["right"]);
    expect(pocket.startS).toBeCloseTo(link.lengthM - 50, 5);
    const beforePocketGeneral = laneById(out, link.laneIds[link.laneIds.length - 2] as string);
    expect(beforePocketGeneral.turns).not.toContain("right");
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("adds a bus lane and removing it again drops the lane and its connectors", () => {
    const withoutBus = crossroads({ leftPocketM: 0, busLaneEW: false });
    const added = applyOverrides(withoutBus, [
      { kind: "link", linkId: "E.in", set: { busLane: {} } },
    ]);
    const addedLink = linkById(added, "E.in");
    const busLaneId = addedLink.laneIds[addedLink.laneIds.length - 1] as string;
    expect(laneById(added, busLaneId).kind).toBe("bus");
    expect(added.connectors.some((c) => c.fromLaneId === busLaneId)).toBe(true);
    expect(checkNetworkIntegrity(parseNetwork(added))).toEqual([]);

    const withBus = crossroads({ leftPocketM: 0, busLaneEW: true });
    const oldBusLaneId = linkById(withBus, "E.in").laneIds.slice(-1)[0] as string;
    const removed = applyOverrides(withBus, [
      { kind: "link", linkId: "E.in", set: { busLane: null } },
    ]);
    expect(removed.lanes.some((l) => l.id === oldBusLaneId)).toBe(false);
    expect(
      removed.connectors.some((c) => c.fromLaneId === oldBusLaneId || c.toLaneId === oldBusLaneId),
    ).toBe(false);
    expect(checkNetworkIntegrity(parseNetwork(removed))).toEqual([]);
  });

  it("merges bus lane hour edits onto the existing rule instead of resetting it", () => {
    const base = crossroads({ leftPocketM: 0, busLaneEW: true });
    const out = applyOverrides(base, [
      {
        kind: "link",
        linkId: "E.in",
        set: { busLane: { activeFromMin: 420, activeToMin: 600 } },
      },
    ]);
    const link = linkById(out, "E.in");
    const bus = laneById(out, link.laneIds[link.laneIds.length - 1] as string);
    expect(bus.busLane?.activeFromMin).toBe(420);
    expect(bus.busLane?.activeToMin).toBe(600);
    expect(bus.busLane?.allowed).toEqual(["bus", "trolleybus"]);
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("throws on an unknown linkId", () => {
    const base = straightRoad();
    expect(() =>
      applyOverrides(base, [{ kind: "link", linkId: "nope", set: { generalLanes: 2 } }]),
    ).toThrow();
  });
});

describe("applyOverrides: signal", () => {
  it("adds a protected left-turn arrow at a signalized node", () => {
    const base = crossroads({ leftPocketM: 60 });
    const out = applyOverrides(base, [
      {
        kind: "signal",
        nodeId: "center",
        set: {
          leftTurnModes: {
            "N.in": "protected",
            "S.in": "protected",
            "E.in": "protected",
            "W.in": "protected",
          },
        },
      },
    ]);
    const ctrl = out.signalControllers.find((c) => c.nodeId === "center");
    expect(ctrl).toBeDefined();
    expect(ctrl?.groups.some((g) => g.section === "arrow_left")).toBe(true);
    expect(ctrl?.leftTurnModes["N.in"]).toBe("protected");
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("a prohibited left keeps its (real) connectors, but yielding and out of every group", () => {
    const base = crossroads({ leftPocketM: 60 });
    const out = applyOverrides(base, [
      { kind: "signal", nodeId: "center", set: { leftTurnModes: { "N.in": "prohibited" } } },
    ]);
    const lefts = out.connectors.filter(
      (c) => c.turn === "left" && c.fromLaneId.startsWith("N.in"),
    );
    expect(lefts.length).toBeGreaterThan(0);
    for (const c of lefts) {
      expect(c.signalGroupId).toBeUndefined();
      expect(c.protection).toBe("yield");
    }
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("a link override at the same node keeps the scenario's manual signal settings", () => {
    const base = crossroads({ leftPocketM: 0 });
    const out = applyOverrides(base, [
      { kind: "signal", nodeId: "center", set: { cycleS: 100 } },
      { kind: "link", linkId: "N.in", set: { generalLanes: 3 } },
    ]);
    const ctrl = out.signalControllers.find((c) => c.nodeId === "center");
    expect(ctrl?.provenance.phases).toBe("manual");
    const cycle = (ctrl?.phases ?? []).reduce((s, p) => s + p.greenS + p.yellowS + p.allRedS, 0);
    expect(cycle).toBe(100);
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("throws on a node with no controller", () => {
    const base = straightRoad();
    expect(() =>
      applyOverrides(base, [{ kind: "signal", nodeId: "n0", set: { cycleS: 60 } }]),
    ).toThrow();
  });
});

describe("applyOverrides: bus_stop / bus_route", () => {
  it("changes a bus stop's kind", () => {
    const base = straightRoad({ busLane: true, busStop: { s: 500, kind: "in_lane" } });
    const out = applyOverrides(base, [{ kind: "bus_stop", stopId: "stop0", set: { kind: "bay" } }]);
    const stop = out.busStops.find((s) => s.id === "stop0");
    expect(stop?.kind).toBe("bay");
    expect(stop?.provenance.kind).toBe("manual");
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("edits a route's headways", () => {
    const base = straightRoad({
      busLane: true,
      busStop: { s: 500, kind: "in_lane" },
      busRoute: { headwayPeakS: 300, headwayOffpeakS: 600 },
    });
    const out = applyOverrides(base, [
      { kind: "bus_route", routeId: "route0", set: { headwayPeakS: 240 } },
    ]);
    const route = out.busRoutes.find((r) => r.id === "route0");
    expect(route?.headwayPeakS).toBe(240);
    expect(route?.headwayOffpeakS).toBe(600);
    expect(route?.provenance.headwayPeakS).toBe("manual");
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });

  it("enabled: false removes the route", () => {
    const base = straightRoad({
      busLane: true,
      busStop: { s: 500, kind: "in_lane" },
      busRoute: { headwayPeakS: 300, headwayOffpeakS: 600 },
    });
    const out = applyOverrides(base, [
      { kind: "bus_route", routeId: "route0", set: { enabled: false } },
    ]);
    expect(out.busRoutes).toHaveLength(0);
    expect(checkNetworkIntegrity(parseNetwork(out))).toEqual([]);
  });
});

describe("applyOverrides: determinism and idempotency", () => {
  const overrides: NetworkOverride[] = [
    { kind: "link", linkId: "N.in", set: { leftPocketLengthM: 100, generalLanes: 3 } },
    {
      kind: "signal",
      nodeId: "center",
      set: { leftTurnModes: { "N.in": "protected" }, cycleS: 90 },
    },
  ];

  it("gives byte-identical output for two independent runs on the same input", () => {
    const base = crossroads({ leftPocketM: 60, crosswalks: true });
    const a = applyOverrides(base, overrides, config);
    const b = applyOverrides(base, overrides, config);
    expect(a).toEqual(b);
  });

  it("re-applying the same overrides on the result changes nothing further", () => {
    const base = crossroads({ leftPocketM: 60, crosswalks: true });
    const once = applyOverrides(base, overrides, config);
    const twice = applyOverrides(once, overrides, config);
    expect(twice).toEqual(once);
  });

  it("does not mutate the input network", () => {
    const base = crossroads({ leftPocketM: 60 });
    const before = structuredClone(base);
    applyOverrides(base, overrides, config);
    expect(base).toEqual(before);
  });
});

describe("applyOverrides: scenario id", () => {
  it("suffixes meta.networkId with the scenario id when given", () => {
    const base = straightRoad();
    const out = applyOverrides(base, [], config, "rush-hour");
    expect(out.meta.networkId).toBe(`${base.meta.networkId}+rush-hour`);
  });

  it("leaves meta.networkId untouched when no scenario id is given", () => {
    const base = straightRoad();
    const out = applyOverrides(base, [], config);
    expect(out.meta.networkId).toBe(base.meta.networkId);
  });
});
