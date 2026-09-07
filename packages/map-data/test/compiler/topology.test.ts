import { checkNetworkIntegrity } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import {
  compile,
  lanesOf,
  linkById,
  linkIds,
  localSnapshot,
  MINI_HALF_WIDTH_M,
  nodeById,
  nodeIds,
} from "./helpers.ts";

const residential = (name: string) => ({ highway: "residential", name });

describe("topology: splitting and merging", () => {
  it("merges degree-2 nodes with identical attributes and keeps a bend where the name changes", () => {
    const snap = localSnapshot({ 1: [-300, 0], 2: [-100, 0], 3: [100, 0], 4: [300, 0] }, [
      { id: 1, tags: residential("Первая"), nodes: [1, 2] },
      { id: 2, tags: residential("Первая"), nodes: [2, 3] },
      { id: 3, tags: residential("Вторая"), nodes: [3, 4] },
    ]);
    const net = compile(snap).network;
    expect(nodeIds(net)).toEqual(["n1", "n3", "n4"]);
    expect(nodeById(net, "n1").kind).toBe("dead_end");
    expect(nodeById(net, "n3").kind).toBe("bend");
    expect(nodeById(net, "n3").name).toBe("Вторая × Первая");
    expect(nodeById(net, "n4").kind).toBe("dead_end");
    expect(linkIds(net)).toEqual(["w1_0_f", "w1_0_b", "w3_0_f", "w3_0_b"]);
    const merged = linkById(net, "w1_0_f");
    expect(merged.osmWayIds).toEqual([1, 2]);
    expect(merged.lengthM).toBeCloseTo(400, 0);
    expect(merged.fromNodeId).toBe("n1");
    expect(merged.toNodeId).toBe("n3");
  });

  it("does not merge across a lane-count change, a layer change or a bridge", () => {
    const snap = localSnapshot({ 1: [-300, 0], 2: [-100, 0], 3: [100, 0], 4: [300, 0] }, [
      { id: 1, tags: { ...residential("Улица"), lanes: "2" }, nodes: [1, 2] },
      { id: 2, tags: { ...residential("Улица"), lanes: "4" }, nodes: [2, 3] },
      {
        id: 3,
        tags: { ...residential("Улица"), lanes: "4", bridge: "yes", layer: "1" },
        nodes: [3, 4],
      },
    ]);
    const report = compile(snap);
    const net = report.network;
    expect(nodeIds(net)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(nodeById(net, "n2").kind).toBe("bend");
    expect(nodeById(net, "n3").kind).toBe("bend");
    expect(lanesOf(net, linkById(net, "w1_0_f"))).toHaveLength(1);
    expect(lanesOf(net, linkById(net, "w2_0_f"))).toHaveLength(2);
    expect(report.linkLevels).toEqual({
      w3_0_f: { layer: 1, bridge: true, tunnel: false },
      w3_0_b: { layer: 1, bridge: true, tunnel: false },
    });
  });

  it("does not create a node where ways cross without a shared OSM node (different layers)", () => {
    const snap = localSnapshot({ 1: [-200, 0], 2: [200, 0], 3: [0, -200], 4: [0, 200] }, [
      { id: 1, tags: { ...residential("Низ"), layer: "-1", tunnel: "yes" }, nodes: [1, 2] },
      { id: 2, tags: residential("Верх"), nodes: [3, 4] },
    ]);
    const net = compile(snap).network;
    expect(nodeIds(net)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(net.links).toHaveLength(4);
  });

  it("splits where two ways share a node and names the junction A × B", () => {
    const snap = localSnapshot({ 1: [-200, 0], 2: [0, 0], 3: [200, 0], 4: [0, 200] }, [
      { id: 1, tags: { highway: "secondary", name: "Главная" }, nodes: [1, 2, 3] },
      { id: 2, tags: residential("Боковая"), nodes: [4, 2] },
    ]);
    const net = compile(snap).network;
    expect(nodeById(net, "n2").kind).toBe("junction");
    expect(nodeById(net, "n2").name).toBe("Главная × Боковая");
    expect(linkIds(net)).toEqual(["w1_0_f", "w1_0_b", "w1_1_f", "w1_1_b", "w2_0_f", "w2_0_b"]);
    expect(linkById(net, "w1_0_f").toNodeId).toBe("n2");
    expect(linkById(net, "w1_1_f").fromNodeId).toBe("n2");
  });

  it("turns a roundabout into one-way links and never lets a link start where it ends", () => {
    const snap = localSnapshot({ 1: [-20, 0], 2: [0, 20], 3: [20, 0], 4: [0, -20], 5: [-200, 0] }, [
      { id: 1, tags: { highway: "tertiary", junction: "roundabout" }, nodes: [1, 2, 3, 4, 1] },
      { id: 2, tags: { highway: "tertiary", name: "Подъезд" }, nodes: [5, 1] },
    ]);
    const net = compile(snap).network;
    expect(checkNetworkIntegrity(net)).toEqual([]);
    const ring = net.links.filter((l) => l.osmWayIds.includes(1));
    expect(ring).toHaveLength(2);
    expect(ring.every((l) => l.id.endsWith("_f"))).toBe(true);
    expect(ring.every((l) => l.fromNodeId !== l.toNodeId)).toBe(true);
    expect(nodeById(net, "n1").kind).toBe("junction");
    expect(nodeById(net, "n3").kind).toBe("bend");
  });

  it("reverses oneway=-1 ways and reads the backward lane tags for them", () => {
    const snap = localSnapshot({ 1: [-200, 0], 2: [200, 0] }, [
      { id: 1, tags: { highway: "tertiary", oneway: "-1", "lanes:backward": "2" }, nodes: [1, 2] },
    ]);
    const net = compile(snap).network;
    expect(linkIds(net)).toEqual(["w1_0_f"]);
    const link = linkById(net, "w1_0_f");
    expect(link.fromNodeId).toBe("n2");
    expect(link.toNodeId).toBe("n1");
    expect(link.geometry[0]?.[0]).toBeCloseTo(200, 0);
    expect(lanesOf(net, link)).toHaveLength(2);
    expect(link.provenance.laneIds).toBe("osm");
  });
});

describe("topology: bbox boundary", () => {
  it("creates a gate-to-gate link for a way that cuts through the bbox with both ends outside", () => {
    const snap = localSnapshot({ 1: [-600, -100], 2: [600, 100] }, [
      { id: 7, tags: residential("Сквозная"), nodes: [1, 2] },
    ]);
    const net = compile(snap).network;
    expect(nodeIds(net)).toEqual(["ng7_0", "ng7_1"]);
    expect(net.nodes.every((n) => n.kind === "gate")).toBe(true);
    expect(nodeById(net, "ng7_0").x).toBeCloseTo(-MINI_HALF_WIDTH_M, 0);
    expect(nodeById(net, "ng7_1").x).toBeCloseTo(MINI_HALF_WIDTH_M, 0);
    // The chord of the diagonal between the two vertical edges: 811 m wide, 1:6 slope.
    const chord = 2 * MINI_HALF_WIDTH_M * (Math.hypot(1200, 200) / 1200);
    expect(linkById(net, "w7_0_f").lengthM).toBeCloseTo(chord, 0);
    expect(linkById(net, "w7_0_f").geometry).toHaveLength(2);
  });

  it("splits a way that leaves and re-enters the bbox into separate pieces", () => {
    const snap = localSnapshot(
      { 1: [-600, 0], 2: [-200, 0], 3: [0, 700], 4: [200, 0], 5: [600, 0] },
      [{ id: 7, tags: residential("Зигзаг"), nodes: [1, 2, 3, 4, 5] }],
    );
    const net = compile(snap).network;
    // Four boundary crossings; the inner OSM nodes 2 and 4 are plain geometry, not nodes.
    expect(nodeIds(net)).toEqual(["ng7_0", "ng7_1", "ng7_2", "ng7_3"]);
    expect(net.nodes.every((n) => n.kind === "gate")).toBe(true);
    expect(linkIds(net)).toEqual(["w7_0_f", "w7_0_b", "w7_1_f", "w7_1_b"]);
    expect(linkById(net, "w7_0_f").fromNodeId).toBe("ng7_0");
    expect(linkById(net, "w7_0_f").toNodeId).toBe("ng7_1");
    expect(linkById(net, "w7_1_f").fromNodeId).toBe("ng7_2");
    expect(linkById(net, "w7_1_f").toNodeId).toBe("ng7_3");
    expect(net.links.every((l) => l.fromNodeId !== l.toNodeId)).toBe(true);
  });

  it("uses the OSM node itself as the gate when it sits exactly on the boundary", () => {
    const snap = localSnapshot({ 1: [600, 0], 2: [MINI_HALF_WIDTH_M, 0], 3: [0, 0] }, [
      { id: 7, tags: residential("Граница"), nodes: [1, 2, 3] },
    ]);
    const net = compile(snap).network;
    expect(nodeIds(net)).toEqual(["n2", "n3"]);
    expect(nodeById(net, "n2").kind).toBe("gate");
    expect(nodeById(net, "n3").kind).toBe("dead_end");
  });

  it("ignores ways entirely outside the bbox and non-road ways", () => {
    const snap = localSnapshot({ 1: [-900, -900], 2: [-700, -900], 3: [0, 0], 4: [100, 0] }, [
      { id: 1, tags: residential("Далеко"), nodes: [1, 2] },
      { id: 2, tags: { highway: "footway" }, nodes: [3, 4] },
      { id: 3, tags: { highway: "service" }, nodes: [3, 4] },
      { id: 4, tags: { highway: "residential", area: "yes" }, nodes: [3, 4, 3] },
    ]);
    const net = compile(snap).network;
    expect(net.nodes).toEqual([]);
    expect(net.links).toEqual([]);
  });
});

describe("topology: traffic signals", () => {
  const cross = {
    1: [-300, 0] as [number, number],
    2: [300, 0] as [number, number],
    3: [0, -300] as [number, number],
    4: [0, 300] as [number, number],
    5: [0, 0] as [number, number],
    // signal nodes on the southern approach, 8 m and 12 m before the junction
    6: [0, -8] as [number, number],
    7: [0, -12] as [number, number],
    // a mid-block signal 150 m along the northern arm
    8: [0, 150] as [number, number],
  };
  const signal = { highway: "traffic_signals" };

  it("folds signal nodes within 15 m into the junction, keeps distant ones as signalized bends", () => {
    const snap = localSnapshot(
      cross,
      [
        { id: 1, tags: { highway: "primary", name: "Абая" }, nodes: [1, 5, 2] },
        { id: 2, tags: { highway: "secondary", name: "Сейфуллина" }, nodes: [3, 7, 6, 5, 8, 4] },
      ],
      { 6: signal, 7: { ...signal, "traffic_signals:direction": "forward" }, 8: signal },
    );
    const report = compile(snap);
    const net = report.network;
    expect(nodeById(net, "n5").kind).toBe("signalized");
    expect(nodeById(net, "n5").name).toBe("Абая × Сейфуллина");
    expect(nodeIds(net)).not.toContain("n6");
    expect(nodeIds(net)).not.toContain("n7");
    expect(nodeById(net, "n8").kind).toBe("signalized");
    expect(nodeById(net, "n8").provenance).toEqual({ kind: "osm" });
    // South approach is one link from n3 to n5 (the signal nodes merged into the geometry).
    const south = net.links.find((l) => l.fromNodeId === "n3" && l.toNodeId === "n5");
    expect(south).toBeDefined();
    expect(south?.lengthM).toBeCloseTo(300, 0);
    expect(checkNetworkIntegrity(net)).toEqual([]);
  });

  it("keeps a traffic_signals tag on the junction node itself", () => {
    const snap = localSnapshot(
      cross,
      [
        { id: 1, tags: { highway: "primary" }, nodes: [1, 5, 2] },
        { id: 2, tags: { highway: "secondary" }, nodes: [3, 5, 4] },
      ],
      { 5: signal },
    );
    const net = compile(snap).network;
    expect(nodeById(net, "n5").kind).toBe("signalized");
    expect(nodeById(net, "n5").name).toBeUndefined();
  });
});
