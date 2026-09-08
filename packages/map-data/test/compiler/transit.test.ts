import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkNetworkIntegrity, defaultSimConfig, parseNetwork } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { getBBox } from "../../src/bboxes.ts";
import { compileNetwork } from "../../src/compiler/index.ts";
import { readSnapshotFile } from "../../src/compiler/write.ts";
import type { OsmElement } from "../../src/importer/index.ts";
import { compile, FIXED_TIME, linkById, localSnapshot } from "./helpers.ts";

/**
 * A straight residential street split at intersections into three OSM ways: 501-502 (way 510),
 * 503-502 (way 520, drawn the *opposite* way from the route), 503-504 (way 530). A `highway=bus_stop`
 * node sits 10 m to the right of way 530's eastbound carriageway.
 */
function threeWaySnapshot() {
  const nodes = {
    501: [-200, 200] as [number, number],
    502: [-100, 200] as [number, number],
    503: [0, 200] as [number, number],
    504: [100, 200] as [number, number],
    505: [50, 190] as [number, number],
  };
  const ways = [
    { id: 510, tags: { highway: "residential", name: "Route St A" }, nodes: [501, 502] },
    { id: 520, tags: { highway: "residential", name: "Route St B" }, nodes: [503, 502] },
    { id: 530, tags: { highway: "residential", name: "Route St C" }, nodes: [503, 504] },
  ];
  const nodeTags = { 505: { highway: "bus_stop", name: "Test Stop" } };
  const snapshot = localSnapshot(nodes, ways, nodeTags);
  const relation: OsmElement = {
    type: "relation",
    id: 999,
    tags: { type: "route", route: "bus", ref: "77", name: "Test Line" },
    members: [
      { type: "way", ref: 510, role: "forward" },
      { type: "way", ref: 520, role: "backward" },
      { type: "way", ref: 530, role: "" },
    ],
  };
  snapshot.elements.push(relation);
  return snapshot;
}

describe("transit stage: relation with one backward way member", () => {
  const report = compile(threeWaySnapshot());
  const net = report.network;

  it("passes checkNetworkIntegrity", () => {
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("restores travel direction from the running node, honouring the backward member", () => {
    expect(net.busRoutes).toHaveLength(1);
    const route = net.busRoutes[0];
    // way 520 is drawn 503->502; the route travels 502->503, so its *backward* link is used.
    expect(route?.linkIds).toEqual(["w510_0_f", "w520_0_b", "w530_0_f"]);
    expect(route?.entryNodeId).toBe(linkById(net, "w510_0_f").fromNodeId);
    expect(route?.exitNodeId).toBe(linkById(net, "w530_0_f").toNodeId);
    expect(route?.entryNodeId).toBe("n501");
    expect(route?.exitNodeId).toBe("n504");
  });

  it("fills ref, kind and name from the relation's tags", () => {
    const route = net.busRoutes[0];
    expect(route?.id).toBe("route.r999");
    expect(route?.ref).toBe("77");
    expect(route?.name).toBe("Test Line");
    expect(route?.kind).toBe("bus");
    expect(route?.osmRelationId).toBe(999);
  });

  it("defaults both headways when the relation has no interval tags", () => {
    const route = net.busRoutes[0];
    expect(route?.headwayPeakS).toBe(480);
    expect(route?.headwayOffpeakS).toBe(900);
    expect(route?.provenance).toEqual({ headwayPeakS: "default", headwayOffpeakS: "default" });
  });

  it("attaches the bus_stop node to the right-hand carriageway it projects onto", () => {
    expect(net.busStops).toHaveLength(1);
    const stop = net.busStops[0];
    const link = linkById(net, "w530_0_f");
    expect(stop?.linkId).toBe(link.id);
    expect(stop?.laneId).toBe(link.laneIds[link.laneIds.length - 1]);
    expect(stop?.s).toBeCloseTo(50, 0);
    expect(stop?.kind).toBe("in_lane");
    expect(stop?.provenance).toEqual({ kind: "default" });
    expect(stop?.osmNodeId).toBe(505);
    expect(net.busRoutes[0]?.stopIds).toEqual([stop?.id]);
  });
});

/**
 * Two chains on the same street, separated by a `highway=footway` (not a road, so it has no
 * compiled link): A (701-702-703, shorter) then a gap, then B (704-705-706, longer). The relation
 * also carries `interval`/`interval:peak` tags and a `bus_bay` stop on the kept chain; a second
 * bus_stop sits on the discarded chain, and a one-way relation has too few links to become a route.
 */
function gapSnapshot() {
  const nodes = {
    701: [-350, -200] as [number, number],
    702: [-250, -200] as [number, number],
    703: [-150, -200] as [number, number],
    704: [-50, -200] as [number, number],
    705: [150, -200] as [number, number],
    706: [350, -200] as [number, number],
    707: [-300, -210] as [number, number],
    708: [50, -210] as [number, number],
  };
  const ways = [
    { id: 710, tags: { highway: "residential", name: "Gap A1" }, nodes: [701, 702] },
    { id: 720, tags: { highway: "residential", name: "Gap A2" }, nodes: [702, 703] },
    { id: 750, tags: { highway: "footway" }, nodes: [703, 704] },
    { id: 730, tags: { highway: "residential", name: "Gap B1" }, nodes: [704, 705] },
    { id: 740, tags: { highway: "residential", name: "Gap B2" }, nodes: [705, 706] },
  ];
  const nodeTags = {
    707: { highway: "bus_stop", name: "Stop on the discarded piece" },
    708: { highway: "bus_stop", bus_bay: "yes", name: "Bay stop" },
  };
  const snapshot = localSnapshot(nodes, ways, nodeTags);
  const truncated: OsmElement = {
    type: "relation",
    id: 996,
    tags: {
      type: "route",
      route: "trolleybus",
      ref: "5",
      interval: "12 minutes",
      "interval:peak": "6",
    },
    members: [
      { type: "way", ref: 710, role: "" },
      { type: "way", ref: 720, role: "" },
      { type: "way", ref: 750, role: "" },
      { type: "way", ref: 730, role: "" },
      { type: "way", ref: 740, role: "" },
    ],
  };
  const tooShort: OsmElement = {
    type: "relation",
    id: 995,
    tags: { type: "route", route: "bus", ref: "6" },
    members: [{ type: "way", ref: 710, role: "" }],
  };
  snapshot.elements.push(truncated, tooShort);
  return snapshot;
}

describe("transit stage: a gap keeps only the longest piece", () => {
  const report = compile(gapSnapshot());
  const net = report.network;

  it("passes checkNetworkIntegrity", () => {
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("truncates the route to the piece past the footway, dropping the shorter one", () => {
    expect(net.busRoutes).toHaveLength(1);
    const route = net.busRoutes[0];
    expect(route?.linkIds).toEqual(["w730_0_f", "w740_0_f"]);
    expect(route?.entryNodeId).toBe("n704");
    expect(route?.exitNodeId).toBe("n706");
    expect(route?.kind).toBe("trolleybus");
  });

  it("discards a relation whose usable path is under two links", () => {
    expect(net.busRoutes.some((r) => r.osmRelationId === 995)).toBe(false);
  });

  it("parses interval/interval:peak tags as osm-provenance headways", () => {
    const route = net.busRoutes[0];
    expect(route?.headwayPeakS).toBe(360);
    expect(route?.headwayOffpeakS).toBe(720);
    expect(route?.provenance).toEqual({ headwayPeakS: "osm", headwayOffpeakS: "osm" });
  });

  it("marks a bus_bay stop as kind bay with osm provenance", () => {
    const bay = net.busStops.find((s) => s.osmNodeId === 708);
    expect(bay?.linkId).toBe("w730_0_f");
    expect(bay?.kind).toBe("bay");
    expect(bay?.provenance).toEqual({ kind: "osm" });
  });

  it("still attaches a stop on the discarded piece, but no route lists it", () => {
    const orphan = net.busStops.find((s) => s.osmNodeId === 707);
    expect(orphan?.linkId).toBe("w710_0_f");
    expect(orphan?.kind).toBe("in_lane");
    for (const route of net.busRoutes) expect(route.stopIds).not.toContain(orphan?.id);
  });
});

const SMALL_SNAPSHOT = fileURLToPath(
  new URL("../../../../data/osm/almaty-abay-small/snapshot.json.gz", import.meta.url),
);

describe("transit stage on the small Almaty snapshot (T-01 output)", () => {
  it.skipIf(!existsSync(SMALL_SNAPSHOT))(
    "compiles at least 25 routes and attaches at least 60 stops, all passing integrity",
    () => {
      const bbox = getBBox("small");
      const snapshot = readSnapshotFile(SMALL_SNAPSHOT);
      const config = defaultSimConfig();
      const report = compileNetwork({ bbox, snapshot, config, generatedAt: FIXED_TIME });
      const net = report.network;
      expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
      expect(net.busRoutes.length).toBeGreaterThanOrEqual(25);
      expect(net.busStops.length).toBeGreaterThanOrEqual(60);
      for (const route of net.busRoutes) expect(route.linkIds.length).toBeGreaterThanOrEqual(2);
      // Every stop sits on some route-tagged street, and a lane exists to receive it.
      for (const stop of net.busStops) {
        const link = linkById(net, stop.linkId);
        expect(link.laneIds).toContain(stop.laneId);
      }
      console.log(
        `small bbox: ${net.busRoutes.length} bus routes, ${net.busStops.length} bus stops`,
      );
    },
  );
});
