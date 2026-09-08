import { checkNetworkIntegrity, type Network, parseNetwork } from "@atl/contracts";

/**
 * Small synthetic networks for scene/*.test.ts. Mirrors the shape of
 * packages/sim-core/test/fixtures/builders.ts's `straightRoad`, kept local so apps/web's tests
 * don't reach into another package's test-only file.
 */

const ALL = ["car", "bus", "trolleybus", "taxi"];
const PT = ["bus", "trolleybus"];

export interface StraightRoadOptions {
  lengthM?: number;
  /** General lanes, excluding any pocket/bus lane. */
  lanes?: number;
  /** Adds a left-turn pocket at index 0, opening at `startS`. */
  pocket?: { startS: number };
  /** Adds a rightmost dedicated bus lane. */
  busLane?: boolean;
  endNodeKind?: "gate" | "signalized";
  /** Override a general lane's turns by its index; defaults to ["through"]. */
  turnsByIndex?: Record<number, string[]>;
}

/** gate -> one straight link -> gate|signalized. */
export function buildStraightRoad(opts: StraightRoadOptions = {}): Network {
  const lengthM = opts.lengthM ?? 200;
  const laneCount = opts.lanes ?? 2;
  const endNodeKind = opts.endNodeKind ?? "gate";

  const laneIds: string[] = [];
  const lanes = [];
  for (let i = 0; i < laneCount; i++) {
    const id = `l0:${i}`;
    laneIds.push(id);
    if (opts.pocket && i === 0) {
      lanes.push({
        id,
        linkId: "l0",
        index: i,
        startS: opts.pocket.startS,
        endS: lengthM,
        kind: "turn_pocket",
        allowed: ALL,
        turns: ["left"],
      });
    } else {
      lanes.push({
        id,
        linkId: "l0",
        index: i,
        startS: 0,
        endS: lengthM,
        kind: "general",
        allowed: ALL,
        turns: opts.turnsByIndex?.[i] ?? ["through"],
      });
    }
  }
  if (opts.busLane) {
    const id = `l0:${laneCount}`;
    laneIds.push(id);
    lanes.push({
      id,
      linkId: "l0",
      index: laneCount,
      startS: 0,
      endS: lengthM,
      kind: "bus",
      allowed: PT,
      turns: ["through"],
      busLane: { allowed: PT },
    });
  }

  const gates = [
    { id: "g0", nodeId: "n0", inLinkIds: ["l0"], weightIn: 1, weightOut: 0 },
    ...(endNodeKind === "gate"
      ? [{ id: "g1", nodeId: "n1", outLinkIds: ["l0"], weightIn: 0, weightOut: 1 }]
      : []),
  ];

  const raw = {
    meta: {
      schemaVersion: 1,
      networkId: "test-straight-road",
      bboxId: "synthetic",
      bbox: { south: 0, west: 0, north: 0, east: 0 },
      origin: { lat: 43.24, lon: 76.92 },
      generatedAt: "2026-01-01T00:00:00Z",
      generator: "apps/web test fixture",
    },
    nodes: [
      { id: "n0", x: 0, y: 0, kind: "gate" },
      { id: "n1", x: lengthM, y: 0, kind: endNodeKind },
    ],
    links: [
      {
        id: "l0",
        fromNodeId: "n0",
        toNodeId: "n1",
        highwayClass: "secondary",
        geometry: [
          [0, 0],
          [lengthM, 0],
        ],
        lengthM,
        speedLimitKph: 60,
        laneIds,
      },
    ],
    lanes,
    connectors: [],
    gates,
  };

  const network = parseNetwork(raw);
  const errors = checkNetworkIntegrity(network);
  if (errors.length > 0) throw new Error(`test fixture invalid:\n${errors.join("\n")}`);
  return network;
}

/**
 * gate `n_in` -> signalized `n_c`, with a through movement to gate `n_out` and a left-turn-pocket
 * movement to gate `n_left`. The controller has three signal groups, in this order (so tests can
 * check global-index alignment, docs/tasks/T-13): a pedestrian group (index 0, no rendered head),
 * a main-section vehicle group ("g_main", index 1) and an arrow_left vehicle group
 * ("g_left", index 2) - plus one unsignalized crosswalk not tied to any group. For scene/*.test.ts
 * that need a network with signals/crosswalks but don't care about the demo T-junction's specific
 * layout (src/data/demo-network.ts).
 */
export function buildSignalizedJunction(): Network {
  const raw = {
    meta: {
      schemaVersion: 1,
      networkId: "test-signalized-junction",
      bboxId: "synthetic",
      bbox: { south: 0, west: 0, north: 0, east: 0 },
      origin: { lat: 43.24, lon: 76.92 },
      generatedAt: "2026-01-01T00:00:00Z",
      generator: "apps/web test fixture",
    },
    nodes: [
      { id: "n_in", x: 0, y: 0, kind: "gate" },
      { id: "n_c", x: 100, y: 0, kind: "signalized" },
      { id: "n_out", x: 200, y: 0, kind: "gate" },
      { id: "n_left", x: 100, y: -100, kind: "gate" },
    ],
    links: [
      {
        id: "in",
        fromNodeId: "n_in",
        toNodeId: "n_c",
        highwayClass: "secondary",
        geometry: [
          [0, 0],
          [100, 0],
        ],
        lengthM: 100,
        speedLimitKph: 50,
        laneIds: ["in:0", "in:1"],
      },
      {
        id: "out_through",
        fromNodeId: "n_c",
        toNodeId: "n_out",
        highwayClass: "secondary",
        geometry: [
          [100, 0],
          [200, 0],
        ],
        lengthM: 100,
        speedLimitKph: 50,
        laneIds: ["out_through:0"],
      },
      {
        id: "out_left",
        fromNodeId: "n_c",
        toNodeId: "n_left",
        highwayClass: "secondary",
        geometry: [
          [100, 0],
          [100, -100],
        ],
        lengthM: 100,
        speedLimitKph: 50,
        laneIds: ["out_left:0"],
      },
    ],
    lanes: [
      {
        id: "in:0",
        linkId: "in",
        index: 0,
        startS: 0,
        endS: 100,
        kind: "general",
        allowed: ALL,
        turns: ["through"],
      },
      {
        id: "in:1",
        linkId: "in",
        index: 1,
        startS: 60,
        endS: 100,
        kind: "turn_pocket",
        allowed: ALL,
        turns: ["left"],
      },
      {
        id: "out_through:0",
        linkId: "out_through",
        index: 0,
        startS: 0,
        endS: 100,
        kind: "general",
        allowed: ALL,
        turns: ["through"],
      },
      {
        id: "out_left:0",
        linkId: "out_left",
        index: 0,
        startS: 0,
        endS: 100,
        kind: "general",
        allowed: ALL,
        turns: ["through"],
      },
    ],
    connectors: [
      {
        id: "c_through",
        fromLaneId: "in:0",
        toLaneId: "out_through:0",
        viaNodeId: "n_c",
        turn: "through",
        geometry: [
          [99, 1],
          [101, -1],
        ],
        lengthM: 3,
        signalGroupId: "g_main",
        protection: "protected",
      },
      {
        id: "c_left",
        fromLaneId: "in:1",
        toLaneId: "out_left:0",
        viaNodeId: "n_c",
        turn: "left",
        geometry: [
          [98, -1],
          [99, -3],
        ],
        lengthM: 3,
        signalGroupId: "g_left_arrow",
        protection: "protected",
      },
    ],
    crosswalks: [
      {
        id: "cw_signalized",
        nodeId: "n_c",
        geometry: [
          [95, -8],
          [95, 8],
        ],
        lengthM: 16,
        signalGroupId: "g_ped",
      },
      {
        id: "cw_zebra",
        nodeId: "n_c",
        geometry: [
          [105, -8],
          [105, 8],
        ],
        lengthM: 16,
      },
    ],
    signalControllers: [
      {
        id: "n_c.ctrl",
        nodeId: "n_c",
        groups: [
          { id: "g_ped", kind: "pedestrian", crosswalkIds: ["cw_signalized"] },
          {
            id: "g_main",
            kind: "vehicle",
            section: "main",
            connectorIds: ["c_through"],
            approachLinkId: "in",
          },
          {
            id: "g_left_arrow",
            kind: "vehicle",
            section: "arrow_left",
            connectorIds: ["c_left"],
            approachLinkId: "in",
          },
        ],
        phases: [
          { id: "n_c.ctrl.p0", greenGroupIds: ["g_main"], greenS: 30 },
          { id: "n_c.ctrl.p1", greenGroupIds: ["g_left_arrow"], greenS: 10 },
          { id: "n_c.ctrl.p2", greenGroupIds: ["g_ped"], greenS: 15 },
        ],
      },
    ],
    gates: [
      { id: "g_in", nodeId: "n_in", inLinkIds: ["in"], weightIn: 1, weightOut: 0 },
      { id: "g_out", nodeId: "n_out", outLinkIds: ["out_through"], weightIn: 0, weightOut: 1 },
      { id: "g_out_left", nodeId: "n_left", outLinkIds: ["out_left"], weightIn: 0, weightOut: 1 },
    ],
  };

  const network = parseNetwork(raw);
  const errors = checkNetworkIntegrity(network);
  if (errors.length > 0) throw new Error(`test fixture invalid:\n${errors.join("\n")}`);
  return network;
}
