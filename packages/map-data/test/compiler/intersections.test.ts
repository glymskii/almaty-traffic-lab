import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Connector,
  checkNetworkIntegrity,
  defaultSimConfig,
  type Network,
} from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { getBBox } from "../../src/bboxes.ts";
import { describeApproach } from "../../src/compiler/describe.ts";
import { GATE_CLASS_WEIGHT } from "../../src/compiler/gates.ts";
import { compileNetwork } from "../../src/compiler/index.ts";
import { ACCELERATION_LANE_M } from "../../src/compiler/merges.ts";
import { buildNodeMovements } from "../../src/compiler/movements.ts";
import { readSnapshotFile } from "../../src/compiler/write.ts";
import { compile, compileMini, FIXED_TIME, lanesOf, linkById, localSnapshot } from "./helpers.ts";

function connectorsAt(net: Network, nodeId: string): Connector[] {
  return net.connectors.filter((c) => c.viaNodeId === nodeId);
}

function byId(net: Network): Map<string, Connector> {
  return new Map(net.connectors.map((c) => [c.id, c] as const));
}

/** Every conflict is recorded on both connectors, with mirrored priorities and swapped positions. */
function asymmetries(net: Network): string[] {
  const index = byId(net);
  const bad: string[] = [];
  for (const c of net.connectors) {
    for (const cp of c.conflicts) {
      const other = index.get(cp.otherConnectorId);
      const back = other?.conflicts.find((x) => x.otherConnectorId === c.id);
      if (back === undefined) {
        bad.push(`${c.id} -> ${cp.otherConnectorId} has no return record`);
        continue;
      }
      const expected =
        cp.priority === "signal" ? "signal" : cp.priority === "this" ? "other" : "this";
      if (back.priority !== expected)
        bad.push(`${c.id} <-> ${cp.otherConnectorId}: ${cp.priority} vs ${back.priority}`);
      if (Math.abs(back.sThisM - cp.sOtherM) > 0.02 || Math.abs(back.sOtherM - cp.sThisM) > 0.02)
        bad.push(`${c.id} <-> ${cp.otherConnectorId}: positions do not match`);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Signalized 2x2 crossroads: two tertiary streets, two lanes per direction.
// tertiary is outside POCKET_DEFAULT_CLASSES, so no rule pocket muddies the counts.
// ---------------------------------------------------------------------------

const crossroads = compile(
  localSnapshot(
    { 1: [-300, 0], 2: [0, 0], 3: [300, 0], 4: [0, 300], 5: [0, -300] },
    [
      { id: 100, tags: { highway: "tertiary", name: "Западная", lanes: "4" }, nodes: [1, 2] },
      { id: 101, tags: { highway: "tertiary", name: "Восточная", lanes: "4" }, nodes: [2, 3] },
      { id: 200, tags: { highway: "tertiary", name: "Северная", lanes: "4" }, nodes: [4, 2] },
      { id: 201, tags: { highway: "tertiary", name: "Южная", lanes: "4" }, nodes: [2, 5] },
    ],
    { 2: { highway: "traffic_signals" } },
  ),
).network;

describe("connectors on a 2x2 crossroads", () => {
  it("builds every permitted manoeuvre of every approach and nothing else", () => {
    const at = connectorsAt(crossroads, "n2");
    // 4 approaches x (2 through + 1 left + 1 right); no u-turns, no movement back down the arm.
    expect(at).toHaveLength(16);
    const byTurn = at.reduce<Record<string, number>>((acc, c) => {
      acc[c.turn] = (acc[c.turn] ?? 0) + 1;
      return acc;
    }, {});
    expect(byTurn).toEqual({ through: 8, left: 4, right: 4 });
    expect(new Set(at.map((c) => c.id)).size).toBe(at.length);
  });

  it("keeps through movements at the same distance from the right kerb", () => {
    // The west approach has lanes [left,through] and [through,right]; lane 0 -> lane 0, lane 1 -> lane 1.
    expect(byId(crossroads).has("w100_0_f:0>w101_0_f:0")).toBe(true);
    expect(byId(crossroads).has("w100_0_f:1>w101_0_f:1")).toBe(true);
    expect(byId(crossroads).has("w100_0_f:0>w101_0_f:1")).toBe(false);
  });

  it("turns left from the leftmost lane into the leftmost lane and right from kerb to kerb", () => {
    const left = byId(crossroads).get("w100_0_f:0>w200_0_b:0");
    expect(left?.turn).toBe("left");
    const right = byId(crossroads).get("w100_0_f:1>w201_0_f:1");
    expect(right?.turn).toBe("right");
  });

  it("samples every movement into 12 points and reports a positive length", () => {
    for (const c of connectorsAt(crossroads, "n2")) {
      expect(c.geometry).toHaveLength(12);
      expect(c.lengthM).toBeGreaterThan(0);
    }
  });

  it("records conflicts symmetrically and leaves the verdict to the controller", () => {
    expect(asymmetries(crossroads)).toEqual([]);
    const at = connectorsAt(crossroads, "n2");
    expect(at.some((c) => c.conflicts.length > 0)).toBe(true);
    for (const c of at) for (const cp of c.conflicts) expect(cp.priority).toBe("signal");
  });

  it("puts a zebra across every arm and cross-links it with the movements that use it", () => {
    expect(crossroads.crosswalks).toHaveLength(4);
    for (const cw of crossroads.crosswalks) {
      expect(cw.nodeId).toBe("n2");
      // Two directions of two lanes each.
      expect(cw.lengthM).toBeCloseTo(14, 5);
      expect(cw.geometry).toHaveLength(2);
      // The intersections stage leaves the zebra groupless; the signals stage (T-08) fills it in.
      expect(cw.signalGroupId).toBeDefined();
      expect(cw.connectorIds).toHaveLength(4);
      for (const cid of cw.connectorIds)
        expect(byId(crossroads).get(cid)?.crosswalkIds).toContain(cw.id);
    }
  });
});

// ---------------------------------------------------------------------------
// A fork: one street splits into two arms that both classify as "through".
// ---------------------------------------------------------------------------

describe("nodes with two exits of the same turn kind", () => {
  const fork = compile(
    localSnapshot({ 1: [-300, 0], 2: [0, 0], 3: [300, 90], 4: [300, -90] }, [
      { id: 100, tags: { highway: "tertiary", name: "Общая", lanes: "2" }, nodes: [1, 2] },
      { id: 101, tags: { highway: "tertiary", name: "Левая ветвь", lanes: "2" }, nodes: [2, 3] },
      { id: 102, tags: { highway: "tertiary", name: "Правая ветвь", lanes: "2" }, nodes: [2, 4] },
    ]),
  ).network;

  it("feeds both branches of a fork, not only the straighter one", () => {
    const entered = new Set(fork.connectors.map((c) => c.toLaneId.split(":")[0]));
    expect(entered.has("w101_0_f")).toBe(true);
    expect(entered.has("w102_0_f")).toBe(true);
    const fromWest = fork.connectors.filter((c) => c.fromLaneId.startsWith("w100_0_f"));
    expect(fromWest.map((c) => c.turn)).toEqual(["through", "through"]);
  });

  it("lets a lane marked merge_to_left in OSM be reached by ordinary traffic", () => {
    const withMergeLane = compile(
      localSnapshot({ 1: [-300, 0], 2: [0, 0], 3: [300, 0], 4: [0, -300] }, [
        { id: 100, tags: { highway: "tertiary", name: "Главная" }, nodes: [1, 2] },
        {
          id: 101,
          tags: {
            highway: "tertiary",
            name: "Главная",
            oneway: "yes",
            lanes: "1",
            "turn:lanes": "merge_to_left",
          },
          nodes: [2, 3],
        },
        { id: 200, tags: { highway: "residential", name: "Боковая" }, nodes: [2, 4] },
      ]),
    ).network;
    expect(lanesOf(withMergeLane, linkById(withMergeLane, "w101_0_f")).map((l) => l.turns)).toEqual(
      [["merge"]],
    );
    expect(withMergeLane.connectors.some((c) => c.toLaneId === "w101_0_f:0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsignalized T-junction: a residential street meets a secondary street.
// ---------------------------------------------------------------------------

const tJunction = compile(
  localSnapshot({ 1: [-300, 0], 2: [0, 0], 3: [300, 0], 4: [0, -400] }, [
    { id: 100, tags: { highway: "secondary", name: "Главная" }, nodes: [1, 2] },
    { id: 101, tags: { highway: "secondary", name: "Главная" }, nodes: [2, 3] },
    { id: 200, tags: { highway: "residential", name: "Минорная" }, nodes: [2, 4] },
  ]),
).network;

describe("priorities on an unsignalized T-junction", () => {
  it("gives the main street right of way over both minor movements", () => {
    const index = byId(tJunction);
    const minorLeft = index.get("w200_0_b:0>w100_0_b:0");
    const minorRight = index.get("w200_0_b:0>w101_0_f:1");
    expect(minorLeft?.turn).toBe("left");
    expect(minorRight?.turn).toBe("right");
    for (const c of [minorLeft, minorRight]) {
      expect(c?.protection).toBe("yield");
      expect(c?.conflicts.every((x) => x.priority === "other")).toBe(true);
      expect(c?.conflicts.length).toBeGreaterThan(0);
    }
    const mainThrough = index.get("w100_0_f:0>w101_0_f:0");
    expect(mainThrough?.protection).toBe("priority");
    expect(mainThrough?.conflicts.every((x) => x.priority === "this")).toBe(true);
  });

  it("makes the left turn from the main street yield to the oncoming through", () => {
    const left = byId(tJunction).get("w101_0_b:0>w200_0_f:0");
    expect(left?.turn).toBe("left");
    expect(left?.protection).toBe("yield");
    expect(left?.conflicts.map((c) => c.otherConnectorId)).toContain("w100_0_f:0>w101_0_f:0");
  });

  it("records no signal verdicts and stays symmetric", () => {
    expect(asymmetries(tJunction)).toEqual([]);
    for (const c of tJunction.connectors)
      for (const cp of c.conflicts) expect(cp.priority).not.toBe("signal");
  });

  it("leaves an unsignalized junction without zebras unless OSM marks a crossing", () => {
    expect(tJunction.crosswalks).toEqual([]);
  });
});

describe("zebras from highway=crossing", () => {
  const withCrossing = compile(
    localSnapshot(
      { 1: [-300, 0], 2: [0, 0], 3: [300, 0], 4: [0, -400], 9: [20, 0] },
      [
        { id: 100, tags: { highway: "secondary", name: "Главная" }, nodes: [1, 2] },
        { id: 101, tags: { highway: "secondary", name: "Главная" }, nodes: [2, 3] },
        { id: 200, tags: { highway: "residential", name: "Минорная" }, nodes: [2, 4] },
      ],
      { 9: { highway: "crossing" } },
    ),
  ).network;

  it("adds unsignalized zebras to a junction with a tagged crossing within 30 m", () => {
    expect(withCrossing.crosswalks).toHaveLength(3);
    for (const cw of withCrossing.crosswalks) {
      expect(cw.nodeId).toBe("n2");
      expect(cw.signalGroupId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Merge: a trunk_link ramp joins a one-way trunk carriageway from the right.
// ---------------------------------------------------------------------------

const merge = compile(
  localSnapshot({ 1: [-300, 0], 2: [0, 0], 3: [400, 0], 4: [-200, -70] }, [
    {
      id: 100,
      tags: { highway: "trunk", name: "Аль-Фараби", oneway: "yes", lanes: "2" },
      nodes: [1, 2],
    },
    {
      id: 101,
      tags: { highway: "trunk", name: "Аль-Фараби", oneway: "yes", lanes: "3" },
      nodes: [2, 3],
    },
    { id: 200, tags: { highway: "trunk_link", oneway: "yes" }, nodes: [4, 2] },
  ]),
).network;

describe("merges", () => {
  it("marks the node and turns the ramp into a merging movement", () => {
    expect(merge.nodes.find((n) => n.id === "n2")?.kind).toBe("merge");
    const ramp = lanesOf(merge, linkById(merge, "w200_0_f"));
    expect(ramp.map((l) => l.turns)).toEqual([["merge"]]);
    const connector = byId(merge).get("w200_0_f:0>w101_0_f:2");
    expect(connector?.turn).toBe("merge");
    expect(connector?.protection).toBe("yield");
  });

  it("keeps the carriageway it joins on priority", () => {
    for (const c of connectorsAt(merge, "n2"))
      if (c.turn !== "merge") expect(c.protection).toBe("priority");
  });

  it("opens an acceleration lane where the carriageway gains a lane", () => {
    const out = linkById(merge, "w101_0_f");
    const lanes = lanesOf(merge, out);
    expect(lanes).toHaveLength(3);
    const acceleration = lanes[2];
    expect(acceleration?.endS).toBe(Math.min(ACCELERATION_LANE_M, out.lengthM));
    expect(acceleration?.endS).toBeLessThan(out.lengthM);
    expect(acceleration?.turns).toEqual(["merge"]);
    expect(acceleration?.provenance.endS).toBe("default");
    // Through traffic keeps its lanes and never runs into the acceleration lane.
    expect(byId(merge).has("w100_0_f:1>w101_0_f:2")).toBe(false);
    expect(byId(merge).has("w100_0_f:1>w101_0_f:1")).toBe(true);
  });

  it("keeps a ramp that would cross the oncoming carriageway as a plain junction", () => {
    const fromLeft = compile(
      localSnapshot({ 1: [-300, 0], 2: [0, 0], 3: [400, 0], 4: [-200, 70] }, [
        { id: 100, tags: { highway: "trunk", name: "Аль-Фараби", lanes: "4" }, nodes: [1, 2] },
        { id: 101, tags: { highway: "trunk", name: "Аль-Фараби", lanes: "6" }, nodes: [2, 3] },
        { id: 200, tags: { highway: "trunk_link", oneway: "yes" }, nodes: [4, 2] },
      ]),
    );
    expect(fromLeft.network.nodes.find((n) => n.id === "n2")?.kind).toBe("junction");
    expect(fromLeft.warnings.some((w) => w.includes("across oncoming traffic"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Levels: two streets that share a node but sit on different layers.
// ---------------------------------------------------------------------------

describe("levels", () => {
  const build = (bridgeTags: Record<string, string>) =>
    compile(
      localSnapshot({ 1: [-300, 0], 2: [0, 0], 3: [300, 0], 4: [0, 300], 5: [0, -300] }, [
        { id: 100, tags: { highway: "tertiary", name: "Нижняя", lanes: "4" }, nodes: [1, 2] },
        { id: 101, tags: { highway: "tertiary", name: "Нижняя", lanes: "4" }, nodes: [2, 3] },
        {
          id: 200,
          tags: { highway: "tertiary", name: "Эстакада", lanes: "4", ...bridgeTags },
          nodes: [4, 2],
        },
        {
          id: 201,
          tags: { highway: "tertiary", name: "Эстакада", lanes: "4", ...bridgeTags },
          nodes: [2, 5],
        },
      ]),
    ).network;

  it("a flyover does not conflict with the street underneath", () => {
    const ground = build({});
    const flyover = build({ bridge: "yes", layer: "1" });
    const crossStreet = (net: Network) =>
      net.connectors
        .filter((c) => c.fromLaneId.startsWith("w100_0_f") || c.fromLaneId.startsWith("w101_0_b"))
        .flatMap((c) => c.conflicts.map((x) => x.otherConnectorId))
        .filter((id) => id.startsWith("w200_") || id.startsWith("w201_"));
    expect(crossStreet(ground).length).toBeGreaterThan(0);
    expect(crossStreet(flyover)).toEqual([]);
    expect(asymmetries(flyover)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gates, attractors and approach descriptions on the mini fixture.
// ---------------------------------------------------------------------------

describe("gates, attractors and descriptions", () => {
  const report = compileMini();
  const net = report.network;

  it("emits one gate per boundary node with class-and-lane weights", () => {
    expect(net.gates.map((g) => g.id)).toEqual([
      "ng100_0.gate",
      "ng101_0.gate",
      "ng200_0.gate",
      "ng200_1.gate",
      "ng302_0.gate",
    ]);
    const west = net.gates.find((g) => g.id === "ng100_0.gate");
    // Two lanes of primary in each direction.
    expect(west?.weightIn).toBeCloseTo(GATE_CLASS_WEIGHT.primary * 2, 5);
    expect(west?.weightOut).toBeCloseTo(GATE_CLASS_WEIGHT.primary * 2, 5);
    expect(west?.inLinkIds).toEqual(["w100_0_f"]);
    expect(west?.outLinkIds).toEqual(["w100_0_b"]);
    expect(west?.provenance).toEqual({ weightIn: "default", weightOut: "default" });
    // A one-way street only feeds traffic in one direction.
    expect(net.gates.find((g) => g.id === "ng200_0.gate")?.weightOut).toBe(0);
    const residential = net.gates.find((g) => g.id === "ng302_0.gate");
    expect(residential?.weightIn).toBeCloseTo(GATE_CLASS_WEIGHT.residential, 5);
  });

  it("turns a cul-de-sac into a small residential attractor", () => {
    expect(net.attractors).toHaveLength(1);
    const deadEnd = net.attractors[0];
    expect(deadEnd?.nodeId).toBe("n6");
    expect(deadEnd?.kind).toBe("residential");
    expect(deadEnd?.weightIn).toBeCloseTo(0.05, 5);
    expect(deadEnd?.provenance.weightIn).toBe("default");
  });

  it("names the direction an approach comes from", () => {
    expect(describeApproach(net, "w100_0_f")).toBe("подход с запада");
    expect(describeApproach(net, "w100_0_b")).toBe("подход с востока");
    expect(describeApproach(net, "w200_0_f")).toBe("подход с севера");
    expect(() => describeApproach(net, "nope")).toThrow();
  });

  it("stays byte-identical across two compilations", () => {
    const again = compileMini().network;
    expect(JSON.stringify(again.connectors)).toBe(JSON.stringify(net.connectors));
    expect(JSON.stringify(again.crosswalks)).toBe(JSON.stringify(net.crosswalks));
    expect(JSON.stringify(again.gates)).toBe(JSON.stringify(net.gates));
    expect(JSON.stringify(again.attractors)).toBe(JSON.stringify(net.attractors));
  });
});

describe("attractors from POIs", () => {
  it("attaches a mall to the nearest junction and skips POIs further than 250 m", () => {
    const snapshot = localSnapshot({ 1: [-300, 0], 2: [0, 0], 3: [300, 0], 4: [0, -300] }, [
      { id: 100, tags: { highway: "secondary", name: "Главная" }, nodes: [1, 2] },
      { id: 101, tags: { highway: "secondary", name: "Главная" }, nodes: [2, 3] },
      { id: 200, tags: { highway: "residential", name: "Минорная" }, nodes: [2, 4] },
    ]);
    const near = { type: "way" as const, id: 900, tags: { shop: "mall", name: "ЦУМ" } };
    snapshot.elements.push({ ...near, center: { lat: 43.2351, lon: 76.9151 } });
    snapshot.elements.push({
      type: "node",
      id: 901,
      lat: 43.2305,
      lon: 76.9105,
      tags: { amenity: "hospital", name: "Больница" },
    });
    const net = compile(snapshot).network;
    const mall = net.attractors.find((a) => a.id === "poi.w900");
    expect(mall?.kind).toBe("mall");
    expect(mall?.name).toBe("ЦУМ");
    expect(mall?.nodeId).toBe("n2");
    expect(mall?.weightIn).toBe(3);
    expect(mall?.provenance).toEqual({
      x: "osm",
      y: "osm",
      weightIn: "default",
      weightOut: "default",
    });
    expect(net.attractors.some((a) => a.id === "poi.n901")).toBe(false);
  });
});

describe("gates on a junction that sits on the bbox boundary", () => {
  it("keeps the gate but never births traffic on a stub shorter than 5 m", () => {
    const report = compile(
      localSnapshot({ 1: [-300, 0], 2: [405.2, 0], 3: [410, 0], 4: [405.2, -200] }, [
        { id: 100, tags: { highway: "primary", name: "Абая" }, nodes: [1, 2, 3] },
        { id: 200, tags: { highway: "residential", name: "Боковая" }, nodes: [2, 4] },
      ]),
    );
    const gate = report.network.gates.find((g) => g.id === "ng100_0.gate");
    expect(gate?.weightIn).toBe(0);
    expect(gate?.weightOut).toBe(0);
    expect(report.warnings.some((w) => w.includes("no traffic is born or removed here"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance on the real snapshot.
// ---------------------------------------------------------------------------

const SMALL_SNAPSHOT = fileURLToPath(
  new URL("../../../../data/osm/almaty-abay-small/snapshot.json.gz", import.meta.url),
);

describe("intersections on the small Almaty snapshot", () => {
  it.skipIf(!existsSync(SMALL_SNAPSHOT))(
    "connects every junction, keeps conflicts symmetric and puts zebras on the signals",
    () => {
      const startedAt = performance.now();
      const report = compileNetwork({
        bbox: getBBox("small"),
        snapshot: readSnapshotFile(SMALL_SNAPSHOT),
        config: defaultSimConfig(),
        generatedAt: FIXED_TIME,
      });
      const elapsedMs = performance.now() - startedAt;
      const net = report.network;
      expect(checkNetworkIntegrity(net)).toEqual([]);
      expect(elapsedMs).toBeLessThan(5000);

      const byNode = buildNodeMovements(net);
      const withConnectors = new Set(net.connectors.map((c) => c.viaNodeId));
      const junctions = net.nodes.filter(
        (n) => n.kind !== "gate" && (byNode.get(n.id)?.degree ?? 0) >= 3,
      );
      expect(junctions.length).toBeGreaterThan(100);
      expect(junctions.filter((n) => !withConnectors.has(n.id))).toEqual([]);

      expect(asymmetries(net)).toEqual([]);
      expect(net.connectors.some((c) => c.conflicts.length > 0)).toBe(true);

      const zebraNodes = new Set(net.crosswalks.map((c) => c.nodeId));
      const signalized = net.nodes.filter((n) => n.kind === "signalized");
      expect(signalized.length).toBeGreaterThan(40);
      const covered = signalized.filter((n) => zebraNodes.has(n.id)).length;
      expect(covered / signalized.length).toBeGreaterThanOrEqual(0.9);

      expect(net.gates).toHaveLength(net.nodes.filter((n) => n.kind === "gate").length);
      expect(net.gates.some((g) => g.weightIn > 0)).toBe(true);
      expect(net.attractors.some((a) => a.kind !== "residential")).toBe(true);

      // Movements on different levels never conflict (bridges over streets, card T-07 criteria).
      const laneLink = new Map(net.lanes.map((l) => [l.id, l.linkId] as const));
      const layerOf = (laneId: string) => report.linkLevels[laneLink.get(laneId) ?? ""]?.layer ?? 0;
      const index = byId(net);
      for (const c of net.connectors)
        for (const cp of c.conflicts) {
          const other = index.get(cp.otherConnectorId);
          if (other === undefined) continue;
          expect(layerOf(c.fromLaneId)).toBe(layerOf(other.fromLaneId));
        }
    },
  );
});
