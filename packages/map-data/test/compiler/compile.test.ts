import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNetworkIntegrity, defaultSimConfig, parseNetwork } from "@atl/contracts";
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
    expect(net.connectors).toEqual([]);
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
    expect(report.stats).toMatchObject({
      nodes: 7,
      links: 8,
      lanes: 18,
      speedDefaultShare: 0.5,
      laneCountDefaultShare: 0.25,
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
    // Only the "stage not implemented" notices; the footway and the service road are ignored silently.
    expect(report.warnings.filter((w) => !w.includes("not implemented"))).toEqual([]);
    expect(report.warnings).toHaveLength(5);
    expect(report.linkLevels).toEqual({});
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
      // Real coverage of maxspeed in the small square is ~34% of ways (T-01 snapshot), so ~66% of links
      // get a default speed; the card's original "~45%" was a way-count estimate over major roads only.
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
