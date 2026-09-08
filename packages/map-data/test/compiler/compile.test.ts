import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNetworkIntegrity, defaultSimConfig, type Point2, parseNetwork } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { getBBox } from "../../src/bboxes.ts";
import { compileNetwork } from "../../src/compiler/index.ts";
import {
  gzipNetwork,
  readNetworkFile,
  readSnapshotFile,
  serializeNetwork,
  writeCompileOutputs,
} from "../../src/compiler/write.ts";
import {
  compileMini,
  FIXED_TIME,
  lanesOf,
  linkById,
  linkIds,
  MINI_HALF_HEIGHT_M,
  MINI_HALF_WIDTH_M,
  nodeById,
  nodeIds,
} from "./helpers.ts";

describe("compileNetwork on the mini fixture", () => {
  const report = compileMini();
  const net = report.network;

  it("passes parseNetwork and checkNetworkIntegrity", () => {
    expect(checkNetworkIntegrity(parseNetwork(JSON.parse(serializeNetwork(net))))).toEqual([]);
    expect(net.meta.generatedAt).toBe(FIXED_TIME);
    expect(net.meta.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(net.meta.osmSnapshotAt).toBe("2026-08-31T12:00:00Z");
    // Movements, zebras, gates and attractors come from the intersections stage (T-07).
    expect(net.connectors.length).toBeGreaterThan(0);
    expect(net.crosswalks.length).toBeGreaterThan(0);
    expect(net.gates).toHaveLength(5);
  });

  it("creates the expected nodes: junction, dead end and five gates", () => {
    expect(nodeIds(net)).toEqual([
      "n2",
      "n6",
      "ng100_0",
      "ng101_0",
      "ng200_0",
      "ng200_1",
      "ng302_0",
    ]);
    const centre = nodeById(net, "n2");
    expect(centre.kind).toBe("signalized");
    expect(centre.name).toBe("Проспект Абая × Сейфуллина");
    expect(centre.osmNodeId).toBe(2);
    expect(centre.provenance).toEqual({ kind: "osm" });
    expect(nodeById(net, "n6").kind).toBe("dead_end");
    expect(nodeById(net, "n6").name).toBe("Тимирязева");
    for (const id of ["ng100_0", "ng101_0", "ng200_0", "ng200_1", "ng302_0"]) {
      const g = nodeById(net, id);
      expect(g.kind).toBe("gate");
      const onVertical = Math.abs(Math.abs(g.x) - MINI_HALF_WIDTH_M) < 0.2;
      const onHorizontal = Math.abs(Math.abs(g.y) - MINI_HALF_HEIGHT_M) < 0.2;
      expect(onVertical || onHorizontal).toBe(true);
    }
    expect(nodeById(net, "ng100_0").x).toBeCloseTo(-MINI_HALF_WIDTH_M, 0);
    expect(nodeById(net, "ng100_0").name).toBe("Проспект Абая");
    // The traffic_signals node 10 m north of the junction is folded into it.
    expect(net.nodes.some((n) => n.osmNodeId === 9)).toBe(false);
  });

  it("creates one link per direction with the centreline shifted right", () => {
    expect(linkIds(net)).toEqual([
      "w100_0_f",
      "w100_0_b",
      "w101_0_f",
      "w101_0_b",
      "w200_0_f",
      "w200_1_f",
      "w301_0_f",
      "w301_0_b",
    ]);
    const east = linkById(net, "w100_0_f");
    expect(east.fromNodeId).toBe("ng100_0");
    expect(east.toNodeId).toBe("n2");
    expect(east.lengthM).toBeCloseTo(MINI_HALF_WIDTH_M, 0);
    for (const p of east.geometry) expect(p[1]).toBeCloseTo(-3.5, 1);
    const west = linkById(net, "w100_0_b");
    expect(west.fromNodeId).toBe("n2");
    expect(west.toNodeId).toBe("ng100_0");
    for (const p of west.geometry) expect(p[1]).toBeCloseTo(3.5, 1);
    const south = linkById(net, "w200_0_f");
    expect(south.fromNodeId).toBe("ng200_0");
    expect(south.toNodeId).toBe("n2");
    for (const p of south.geometry) expect(p[0]).toBeCloseTo(0, 1);
    expect(south.lengthM).toBeCloseTo(MINI_HALF_HEIGHT_M, 0);
    const merged = linkById(net, "w301_0_f");
    expect(merged.fromNodeId).toBe("n6");
    expect(merged.toNodeId).toBe("ng302_0");
    expect(merged.osmWayIds).toEqual([301, 302]);
    expect(merged.name).toBe("Тимирязева");
    expect(merged.highwayClass).toBe("residential");
    expect(net.lanes).toHaveLength(18);
  });

  it("resolves lane counts, speeds, turns, the pocket and the bus lane", () => {
    const east = linkById(net, "w100_0_f");
    const eastLanes = lanesOf(net, east);
    expect(eastLanes).toHaveLength(2);
    expect(eastLanes[0]?.kind).toBe("turn_pocket");
    expect(eastLanes[0]?.turns).toEqual(["left"]);
    expect(eastLanes[0]?.startS).toBeCloseTo(east.lengthM - 80, 0);
    expect(eastLanes[0]?.endS).toBe(east.lengthM);
    expect(eastLanes[1]?.kind).toBe("general");
    expect(eastLanes[1]?.turns).toEqual(["through"]);
    expect(east.speedLimitKph).toBe(60);

    const westLanes = lanesOf(net, linkById(net, "w100_0_b"));
    expect(westLanes.map((l) => l.turns)).toEqual([
      ["left", "through"],
      ["through", "right"],
    ]);
    expect(westLanes.every((l) => l.startS === 0)).toBe(true);

    expect(linkById(net, "w101_0_f").speedLimitKph).toBe(60);
    const toCentreFromEast = lanesOf(net, linkById(net, "w101_0_b"));
    expect(toCentreFromEast.map((l) => l.kind)).toEqual(["turn_pocket", "general", "general"]);
    expect(toCentreFromEast[0]?.startS).toBeCloseTo(linkById(net, "w101_0_b").lengthM - 60, 0);
    // The rule pocket widens the carriageway: three lanes centred on a centreline 5.25 m off the axis.
    for (const p of linkById(net, "w101_0_b").geometry) expect(p[1]).toBeCloseTo(5.25, 1);
    for (const p of linkById(net, "w101_0_f").geometry) expect(p[1]).toBeCloseTo(-3.5, 1);
    expect(toCentreFromEast.map((l) => l.turns)).toEqual([
      ["left"],
      ["through"],
      ["through", "right"],
    ]);

    const south = linkById(net, "w200_0_f");
    expect(south.speedLimitKph).toBe(40);
    const southLanes = lanesOf(net, south);
    expect(southLanes.map((l) => l.kind)).toEqual(["turn_pocket", "general", "general", "bus"]);
    const bus = southLanes[3];
    expect(bus?.allowed).toEqual(["bus", "trolleybus"]);
    expect(bus?.busLane).toEqual({
      allowed: ["bus", "trolleybus"],
      activeFromMin: 0,
      activeToMin: 1440,
      carsMayEnterForRightTurnWithinM: 50,
    });
    expect(bus?.turns).toEqual(["through", "right"]);
    const southOut = lanesOf(net, linkById(net, "w200_1_f"));
    expect(southOut.map((l) => l.kind)).toEqual(["general", "general", "bus"]);

    const residential = linkById(net, "w301_0_f");
    expect(residential.speedLimitKph).toBe(40);
    expect(lanesOf(net, residential).map((l) => l.turns)).toEqual([["left", "through", "right"]]);
  });

  it("marks provenance and groups assumptions", () => {
    expect(linkById(net, "w100_0_f").provenance).toEqual({
      speedLimitKph: "default",
      laneIds: "osm",
    });
    expect(linkById(net, "w101_0_f").provenance).toEqual({ speedLimitKph: "osm", laneIds: "osm" });
    // A pocket added by rule is one lane more than OSM says.
    expect(linkById(net, "w101_0_b").provenance).toEqual({
      speedLimitKph: "osm",
      laneIds: "default",
    });
    expect(linkById(net, "w200_0_f").provenance).toEqual({
      speedLimitKph: "osm",
      laneIds: "default",
    });
    expect(linkById(net, "w301_0_b").provenance).toEqual({
      speedLimitKph: "default",
      laneIds: "default",
    });
    const eastLanes = lanesOf(net, linkById(net, "w100_0_f"));
    expect(eastLanes[0]?.provenance).toEqual({ turns: "osm", startS: "default" });
    expect(eastLanes[1]?.provenance).toEqual({ turns: "osm" });
    const southLanes = lanesOf(net, linkById(net, "w200_0_f"));
    expect(southLanes[0]?.provenance).toEqual({ turns: "default", startS: "default" });
    expect(southLanes[3]?.provenance).toEqual({
      turns: "default",
      busLane: "osm",
      busLaneHours: "default",
    });

    const byKind = Object.fromEntries(report.assumptions.map((a) => [a.kind, a]));
    expect(byKind.speed_limit_default?.count).toBe(4);
    expect(byKind.speed_limit_default?.example).toBe("w100_0_f (Проспект Абая)");
    expect(byKind.lane_count_default?.count).toBe(2);
    expect(byKind.left_pocket_default?.count).toBe(2);
    expect(byKind.pocket_length_default?.count).toBe(1);
    expect(byKind.bus_lane_hours_default?.count).toBe(2);
    expect(byKind.bus_lane_position_assumed).toBeUndefined();
    expect(byKind.turns_default?.count).toBe(16);
    // Signals stage: one controller on the only signalized node, one left-turn mode per approach.
    expect(byKind.signal_plan_default?.count).toBe(1);
    expect(byKind.left_turn_permissive_default?.count).toBe(2);
    expect(byKind.left_turn_prohibited_default?.count).toBe(1);
    expect(report.stats).toMatchObject({
      nodes: 7,
      links: 8,
      lanes: 18,
      speedDefaultShare: 0.5,
      laneCountDefaultShare: 0.5,
      busLanes: 2,
      pockets: 3,
    });
    expect(report.stats.nodesByKind).toEqual({
      junction: 0,
      signalized: 1,
      merge: 0,
      gate: 5,
      dead_end: 1,
      bend: 0,
    });
    // The "stage not implemented" notices plus the dead-lane diagnostic of the intersections
    // stage: the left pocket of w100_0_f has no left exit because the cross street is one-way.
    // The footway and the service road are ignored silently.
    expect(report.warnings.filter((w) => !w.includes("not implemented"))).toEqual([
      "intersections: 2 lane(s) reach a junction with no permitted movement; " +
        "no vehicle may end up in them: w100_0_f:0, w301_0_b:0",
    ]);
    expect(report.warnings).toHaveLength(4);
    expect(report.linkLevels).toEqual({});
  });

  it("maps every OSM way to its links in order along the way", () => {
    expect(report.wayLinks).toEqual({
      100: { forward: ["w100_0_f"], backward: ["w100_0_b"] },
      101: { forward: ["w101_0_f"], backward: ["w101_0_b"] },
      200: { forward: ["w200_0_f", "w200_1_f"], backward: [] },
      301: { forward: ["w301_0_f"], backward: ["w301_0_b"] },
      302: { forward: ["w301_0_f"], backward: ["w301_0_b"] },
    });
  });

  it("keeps the lanes of opposite directions on their own side of the way axis", () => {
    // Lane i of a link is centred (i - (N - 1) / 2) · w to the right of the link geometry
    // (docs/CONTRACTS.md), so the two directions of a street tile without overlap only when their
    // geometries are at least (N_f + N_b) · w / 2 apart.
    const LANE_W = 3.5;
    const pointToSegment = (p: Point2, a: Point2, b: Point2): number => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t =
        l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    };
    const separation = (from: Point2[], to: Point2[]): number => {
      const mid = from[Math.floor(from.length / 2)] ?? from[0] ?? [0, 0];
      let best = Number.POSITIVE_INFINITY;
      for (let i = 1; i < to.length; i++)
        best = Math.min(best, pointToSegment(mid, to[i - 1] ?? [0, 0], to[i] ?? [0, 0]));
      return best;
    };
    for (const base of ["w100_0", "w101_0", "w301_0"]) {
      const forward = linkById(net, `${base}_f`);
      const backward = linkById(net, `${base}_b`);
      const needed = ((forward.laneIds.length + backward.laneIds.length) * LANE_W) / 2;
      expect(separation(forward.geometry, backward.geometry)).toBeGreaterThanOrEqual(needed - 0.05);
      expect(separation(backward.geometry, forward.geometry)).toBeGreaterThanOrEqual(needed - 0.05);
    }
  });

  it("is deterministic: two compilations give identical JSON and gzip bytes", () => {
    const again = compileMini().network;
    expect(serializeNetwork(again)).toBe(serializeNetwork(net));
    expect(gzipNetwork(again).equals(gzipNetwork(net))).toBe(true);
  });

  it("writes the network and the assumptions report and reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "atl-compile-"));
    const paths = {
      networkPath: join(dir, "mini.network.json.gz"),
      assumptionsPath: join(dir, "mini.assumptions.json"),
    };
    writeCompileOutputs(report, paths);
    const back = readNetworkFile(paths.networkPath);
    expect(serializeNetwork(back)).toBe(serializeNetwork(net));
    const doc = JSON.parse(readFileSync(paths.assumptionsPath, "utf8"));
    expect(doc.bboxId).toBe("mini");
    expect(doc.stats.links).toBe(8);
    expect(doc.assumptions).toEqual(report.assumptions);
  });
});

const SMALL_SNAPSHOT = fileURLToPath(
  new URL("../../../../data/osm/almaty-abay-small/snapshot.json.gz", import.meta.url),
);

describe("compileNetwork on the small Almaty snapshot (T-01 output)", () => {
  it.skipIf(!existsSync(SMALL_SNAPSHOT))(
    "compiles, validates, is deterministic and defaults about 45% of speed limits",
    () => {
      const bbox = getBBox("small");
      const snapshot = readSnapshotFile(SMALL_SNAPSHOT);
      const config = defaultSimConfig();
      const startedAt = performance.now();
      const report = compileNetwork({ bbox, snapshot, config, generatedAt: FIXED_TIME });
      const elapsedMs = performance.now() - startedAt;
      const net = report.network;
      expect(checkNetworkIntegrity(parseNetwork(JSON.parse(serializeNetwork(net))))).toEqual([]);
      expect(net.links.length).toBeGreaterThan(500);
      expect(net.nodes.filter((n) => n.kind === "signalized").length).toBeGreaterThan(40);
      expect(net.nodes.filter((n) => n.kind === "gate").length).toBeGreaterThan(10);
      expect(net.lanes.filter((l) => l.kind === "bus").length).toBeGreaterThan(0);
      expect(report.stats.speedDefaultShare).toBeGreaterThan(0.3);
      expect(report.stats.speedDefaultShare).toBeLessThan(0.9);
      expect(elapsedMs).toBeLessThan(5000);
      const again = compileNetwork({ bbox, snapshot, config, generatedAt: FIXED_TIME }).network;
      expect(serializeNetwork(again)).toBe(serializeNetwork(net));
      console.log(
        `small bbox: ${report.stats.nodes} nodes, ${report.stats.links} links, ${report.stats.lanes} lanes; ` +
          `speed defaults ${Math.round(report.stats.speedDefaultShare * 100)}%; ` +
          `${report.warnings.length} warnings; ${Math.round(elapsedMs)} ms`,
      );
      for (const a of report.assumptions)
        console.log(`  ${a.kind}: ${a.count} (e.g. ${a.example})`);
    },
  );
});
