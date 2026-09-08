import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkNetworkIntegrity, defaultSimConfig, type Point2, parseNetwork } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { bboxCentre, getBBox } from "../../src/bboxes.ts";
import { compileNetwork } from "../../src/compiler/index.ts";
import { readSnapshotFile } from "../../src/compiler/write.ts";
import type { OsmElement, OsmSnapshot } from "../../src/importer/index.ts";
import { createProjection } from "../../src/projection.ts";
import { compile, FIXED_TIME, localSnapshot, MINI_BBOX } from "./helpers.ts";

/** A closed rectangular ring, `[x, y]` local metres, node ids assigned from `firstId`. */
function rectWay(firstId: number, cx: number, cy: number, halfW: number, halfH: number) {
  const corners: [number, [number, number]][] = [
    [firstId, [cx - halfW, cy - halfH]],
    [firstId + 1, [cx + halfW, cy - halfH]],
    [firstId + 2, [cx + halfW, cy + halfH]],
    [firstId + 3, [cx - halfW, cy + halfH]],
  ];
  return { corners, nodeIds: [firstId, firstId + 1, firstId + 2, firstId + 3, firstId] };
}

/** One straight residential road (T-02's stages need at least one link to run cleanly) plus a
 * handful of building/park/water/waterway ways, none of which carry a `highway` tag so
 * `buildOsmGraph` never sees them (docs/tasks/T-27 §1: these layers are read straight off the raw
 * snapshot, not the driveable graph). */
function cityFixtureSnapshot(): OsmSnapshot {
  const nodes: Record<number, [number, number]> = { 1: [-50, 0], 2: [50, 0] };
  const ways: { id: number; tags: Record<string, string>; nodes: number[] }[] = [
    { id: 900, tags: { highway: "residential", name: "Test St" }, nodes: [1, 2] },
  ];

  const addRect = (
    wayId: number,
    firstNodeId: number,
    cx: number,
    cy: number,
    tags: Record<string, string>,
  ) => {
    const { corners, nodeIds } = rectWay(firstNodeId, cx, cy, 5, 5);
    for (const [id, p] of corners) nodes[id] = p;
    ways.push({ id: wayId, tags, nodes: nodeIds });
  };

  // Buildings: one per height-resolution rule (card §1).
  addRect(910, 11, 105, 105, { building: "yes", "building:levels": "5" }); // osm, 5*3=15
  addRect(911, 21, 135, 105, { building: "house", height: "8.5" }); // osm, explicit height wins over type
  addRect(912, 31, 165, 105, { building: "apartments" }); // default, type lookup: 15
  addRect(913, 41, 195, 105, { building: "house" }); // default, type lookup: 6
  addRect(914, 51, 225, 105, { building: "yes" }); // default, generic: 9

  // A near-collinear extra vertex 0.3 m off one edge of an otherwise clean 20x20 rectangle -
  // simplifyPolyline(1 m) must drop it.
  nodes[61] = [250, 100];
  nodes[62] = [260, 100.3];
  nodes[63] = [270, 100];
  nodes[64] = [270, 120];
  nodes[65] = [250, 120];
  ways.push({
    id: 915,
    tags: { building: "yes" },
    nodes: [61, 62, 63, 64, 65, 61],
  });

  // Areas.
  addRect(920, 71, 105, 145, { leisure: "park" });
  addRect(921, 81, 135, 145, { natural: "water" });
  addRect(922, 91, 165, 145, { landuse: "grass" }); // also kind "park"

  // Waterways: standalone ways only (route relations grouping them are ignored - see city.ts docblock).
  nodes[101] = [-100, 100];
  nodes[102] = [-90, 110];
  nodes[103] = [-80, 125];
  ways.push({ id: 930, tags: { waterway: "stream" }, nodes: [101, 102, 103] }); // no width -> default 6
  nodes[111] = [-100, 150];
  nodes[112] = [-90, 160];
  ways.push({ id: 931, tags: { waterway: "river", width: "12" }, nodes: [111, 112] });
  // Not a recognised waterway class - must be ignored.
  nodes[121] = [-100, 200];
  nodes[122] = [-90, 200];
  ways.push({ id: 932, tags: { waterway: "ditch" }, nodes: [121, 122] });

  // A building that is both standalone (way 70) and (falsely) listed as an outer member of a
  // relation, alongside one genuinely new outer ring (member 71, no standalone way of its own) -
  // the relation must not double-count way 70.
  addRect(70, 201, 305, 105, { building: "yes" });

  return localSnapshot(nodes, ways);
}

function makeDedupRelation(): OsmElement {
  const proj = createProjection(bboxCentre(MINI_BBOX));
  const ring = (cx: number, cy: number, halfW: number, halfH: number) =>
    [
      [cx - halfW, cy - halfH],
      [cx + halfW, cy - halfH],
      [cx + halfW, cy + halfH],
      [cx - halfW, cy + halfH],
      [cx - halfW, cy - halfH],
    ].map((p) => proj.toLonLat(p as Point2));
  return {
    type: "relation",
    id: 8001,
    tags: { type: "multipolygon", building: "yes" },
    members: [
      { type: "way", ref: 70, role: "outer", geometry: ring(305, 105, 5, 5) },
      { type: "way", ref: 71, role: "outer", geometry: ring(325, 105, 5, 5) },
    ],
  };
}

describe("city stage: buildings", () => {
  const snapshot = cityFixtureSnapshot();
  snapshot.elements.push(makeDedupRelation());
  const report = compile(snapshot);
  const net = report.network;
  const buildingById = new Map(net.buildings.map((b) => [b.id, b]));

  it("passes checkNetworkIntegrity", () => {
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("building:levels x 3, provenance osm", () => {
    const b = buildingById.get("bld.w910");
    expect(b?.heightM).toBe(15);
    expect(b?.provenance).toEqual({ heightM: "osm" });
  });

  it("an explicit height tag wins over the building-type lookup, provenance osm", () => {
    const b = buildingById.get("bld.w911");
    expect(b?.heightM).toBe(8.5);
    expect(b?.provenance).toEqual({ heightM: "osm" });
  });

  it("building=apartments with neither height nor levels defaults to 15 m", () => {
    const b = buildingById.get("bld.w912");
    expect(b?.heightM).toBe(15);
    expect(b?.provenance).toEqual({ heightM: "default" });
  });

  it("building=house with neither height nor levels defaults to 6 m", () => {
    const b = buildingById.get("bld.w913");
    expect(b?.heightM).toBe(6);
    expect(b?.provenance).toEqual({ heightM: "default" });
  });

  it("any other building=* value defaults to 9 m", () => {
    const b = buildingById.get("bld.w914");
    expect(b?.heightM).toBe(9);
    expect(b?.provenance).toEqual({ heightM: "default" });
  });

  it("simplifies a footprint's near-collinear vertex within 1 m", () => {
    const b = buildingById.get("bld.w915");
    expect(b).toBeDefined();
    expect(b?.footprint).toHaveLength(4);
    const xs = (b?.footprint ?? []).map((p) => p[0]).sort((a, c) => a - c);
    const ys = (b?.footprint ?? []).map((p) => p[1]).sort((a, c) => a - c);
    expect(xs[0]).toBeCloseTo(250, 0);
    expect(xs[3]).toBeCloseTo(270, 0);
    expect(ys[0]).toBeCloseTo(100, 0);
    expect(ys[3]).toBeCloseTo(120, 0);
  });

  it("counts a way that is both standalone and a relation's outer member only once", () => {
    expect(buildingById.has("bld.w70")).toBe(true);
    // The relation has two outer members: ref 70 (already a standalone building, skipped) and
    // ref 71 (genuinely new). Only the new one is added, and it is not reused for the skipped slot.
    const fromRelation = net.buildings.filter((b) => b.id.startsWith("bld.r8001."));
    expect(fromRelation).toHaveLength(1);
    expect(fromRelation[0]?.id).toBe("bld.r8001.0");
    expect(fromRelation[0]?.provenance).toEqual({ heightM: "default" });
  });

  it("every footprint has at least 3 vertices (PolygonSchema)", () => {
    for (const b of net.buildings) expect(b.footprint.length).toBeGreaterThanOrEqual(3);
  });
});

describe("city stage: areas and waterways", () => {
  const report = compile(cityFixtureSnapshot());
  const net = report.network;

  it("leisure=park and landuse=grass both become kind 'park'; natural=water becomes 'water'", () => {
    const kinds = new Map(net.areas.map((a) => [a.id, a.kind]));
    expect(kinds.get("area.w920")).toBe("park");
    expect(kinds.get("area.w921")).toBe("water");
    expect(kinds.get("area.w922")).toBe("park");
  });

  it("a waterway with no width tag defaults to 6 m", () => {
    const stream = net.waterways.find((w) => w.id === "wway.w930");
    expect(stream?.widthM).toBe(6);
    expect(stream?.polyline.length).toBeGreaterThanOrEqual(2);
  });

  it("a waterway's width tag is read in metres", () => {
    const river = net.waterways.find((w) => w.id === "wway.w931");
    expect(river?.widthM).toBe(12);
  });

  it("ignores a waterway class outside river/stream/canal", () => {
    expect(net.waterways.some((w) => w.id === "wway.w932")).toBe(false);
  });
});

const SMALL_SNAPSHOT = fileURLToPath(
  new URL("../../../../data/osm/almaty-abay-small/snapshot.json.gz", import.meta.url),
);

describe("city stage on the small Almaty snapshot (T-01 output)", () => {
  it.skipIf(!existsSync(SMALL_SNAPSHOT))(
    "recognisable city layers: hundreds of buildings, parks/water, a handful of waterways",
    () => {
      const bbox = getBBox("small");
      const snapshot = readSnapshotFile(SMALL_SNAPSHOT);
      const config = defaultSimConfig();
      const report = compileNetwork({ bbox, snapshot, config, generatedAt: FIXED_TIME });
      const net = report.network;
      expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
      expect(net.buildings.length).toBeGreaterThan(1000);
      expect(net.areas.some((a) => a.kind === "park")).toBe(true);
      expect(net.areas.some((a) => a.kind === "water")).toBe(true);
      expect(net.waterways.length).toBeGreaterThan(0);
      for (const b of net.buildings) expect(b.heightM).toBeGreaterThan(0);
      console.log(
        `small bbox: ${net.buildings.length} buildings, ${net.areas.length} areas, ${net.waterways.length} waterways`,
      );
    },
  );
});
