import { checkNetworkIntegrity, type Network, type Point2, parseNetwork } from "@atl/contracts";
import { laneAxis, offsetPolyline, sampleAtS } from "../geometry/lane-geometry.ts";

/**
 * A small hand-built T-junction, shown when no compiled network is available under
 * /networks (see loadNetwork.ts). Not derived from OSM - it exists purely to exercise every
 * renderer feature: a left-turn pocket that opens mid-link, a dedicated bus lane, a signalized
 * stop line, zebra crosswalks and through/left/right turn arrows.
 *
 * Layout: a west-east main road ("Демонстрационный проспект") crosses a south minor road
 * ("Демонстрационный переулок") at a signalized centre node. Nodes are points, so approach and
 * departure links stop NODE_RADIUS_M short of the centre - that gap is the intersection footprint
 * connectors are drawn across (otherwise a laterally-aligned through movement would compute a
 * zero-length connector, which the schema rejects).
 */

const LANE_WIDTH_M = 3.5;
const NODE_RADIUS_M = 10;

const N_W: Point2 = [-200, 0];
const N_E: Point2 = [200, 0];
const N_S: Point2 = [0, -160];
const N_C: Point2 = [0, 0];
const WEST_EDGE: Point2 = [-NODE_RADIUS_M, 0];
const EAST_EDGE: Point2 = [NODE_RADIUS_M, 0];
const SOUTH_EDGE: Point2 = [0, -NODE_RADIUS_M];

/** Offset a two-way street's raw centreline to one direction's own carriageway (half its total width, per docs/CONTRACTS.md). */
function carriageway(raw: Point2[], laneCount: number): Point2[] {
  return offsetPolyline(raw, (laneCount * LANE_WIDTH_M) / 2);
}

/** Where lane `index` (of `laneCount`) meets arc-length `s` of its link - used to build connector geometry that lines up with the rendered lanes. */
function laneEndpoint(linkGeometry: Point2[], index: number, laneCount: number, s: number): Point2 {
  return sampleAtS(laneAxis(linkGeometry, index, laneCount, LANE_WIDTH_M), s).point;
}

export function createDemoNetwork(): Network {
  const wIn = carriageway([N_W, WEST_EDGE], 2);
  const wOut = carriageway([WEST_EDGE, N_W], 2);
  const eIn = carriageway([N_E, EAST_EDGE], 3);
  const eOut = carriageway([EAST_EDGE, N_E], 3);
  const sIn = carriageway([N_S, SOUTH_EDGE], 2);
  const sOut = carriageway([SOUTH_EDGE, N_S], 2);

  const ALL = ["car", "bus", "trolleybus", "taxi"];
  const PT = ["bus", "trolleybus"];

  const links = [
    {
      id: "w_in",
      fromNodeId: "n_w",
      toNodeId: "n_c",
      name: "Демонстрационный проспект",
      highwayClass: "primary",
      geometry: wIn,
      lengthM: 190,
      speedLimitKph: 60,
      laneIds: ["w_in:0", "w_in:1"],
    },
    {
      id: "w_out",
      fromNodeId: "n_c",
      toNodeId: "n_w",
      name: "Демонстрационный проспект",
      highwayClass: "primary",
      geometry: wOut,
      lengthM: 190,
      speedLimitKph: 60,
      laneIds: ["w_out:0", "w_out:1"],
    },
    {
      id: "e_in",
      fromNodeId: "n_e",
      toNodeId: "n_c",
      name: "Демонстрационный проспект",
      highwayClass: "primary",
      geometry: eIn,
      lengthM: 190,
      speedLimitKph: 60,
      laneIds: ["e_in:0", "e_in:1", "e_in:2"],
    },
    {
      id: "e_out",
      fromNodeId: "n_c",
      toNodeId: "n_e",
      name: "Демонстрационный проспект",
      highwayClass: "primary",
      geometry: eOut,
      lengthM: 190,
      speedLimitKph: 60,
      laneIds: ["e_out:0", "e_out:1", "e_out:2"],
    },
    {
      id: "s_in",
      fromNodeId: "n_s",
      toNodeId: "n_c",
      name: "Демонстрационный переулок",
      highwayClass: "residential",
      geometry: sIn,
      lengthM: 150,
      speedLimitKph: 40,
      laneIds: ["s_in:0", "s_in:1"],
    },
    {
      id: "s_out",
      fromNodeId: "n_c",
      toNodeId: "n_s",
      name: "Демонстрационный переулок",
      highwayClass: "residential",
      geometry: sOut,
      lengthM: 150,
      speedLimitKph: 40,
      laneIds: ["s_out:0", "s_out:1"],
    },
  ];

  const lanes = [
    {
      id: "w_in:0",
      linkId: "w_in",
      index: 0,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },
    {
      id: "w_in:1",
      linkId: "w_in",
      index: 1,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through", "right"],
    },

    {
      id: "e_in:0",
      linkId: "e_in",
      index: 0,
      startS: 140,
      endS: 190,
      kind: "turn_pocket",
      allowed: ALL,
      turns: ["left"],
    },
    {
      id: "e_in:1",
      linkId: "e_in",
      index: 1,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },
    {
      id: "e_in:2",
      linkId: "e_in",
      index: 2,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },

    {
      id: "s_in:0",
      linkId: "s_in",
      index: 0,
      startS: 0,
      endS: 150,
      kind: "general",
      allowed: ALL,
      turns: ["left"],
    },
    {
      id: "s_in:1",
      linkId: "s_in",
      index: 1,
      startS: 0,
      endS: 150,
      kind: "general",
      allowed: ALL,
      turns: ["right"],
    },

    {
      id: "w_out:0",
      linkId: "w_out",
      index: 0,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },
    {
      id: "w_out:1",
      linkId: "w_out",
      index: 1,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },

    {
      id: "e_out:0",
      linkId: "e_out",
      index: 0,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },
    {
      id: "e_out:1",
      linkId: "e_out",
      index: 1,
      startS: 0,
      endS: 190,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },
    {
      id: "e_out:2",
      linkId: "e_out",
      index: 2,
      startS: 0,
      endS: 190,
      kind: "bus",
      allowed: PT,
      turns: ["through"],
      busLane: { allowed: PT },
    },

    {
      id: "s_out:0",
      linkId: "s_out",
      index: 0,
      startS: 0,
      endS: 150,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },
    {
      id: "s_out:1",
      linkId: "s_out",
      index: 1,
      startS: 0,
      endS: 150,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    },
  ];

  const movement = (
    id: string,
    from: { geometry: Point2[]; index: number; laneCount: number; endS: number; laneId: string },
    to: { geometry: Point2[]; index: number; laneCount: number; laneId: string },
    turn: string,
    signalGroupId: string,
  ) => {
    const start = laneEndpoint(from.geometry, from.index, from.laneCount, from.endS);
    const end = laneEndpoint(to.geometry, to.index, to.laneCount, 0);
    const geometry = [start, end];
    return {
      id,
      fromLaneId: from.laneId,
      toLaneId: to.laneId,
      viaNodeId: "n_c",
      turn,
      geometry,
      lengthM: Math.hypot(end[0] - start[0], end[1] - start[1]),
      signalGroupId,
      protection: "protected",
    };
  };

  const connectors = [
    movement(
      "c1",
      { geometry: wIn, index: 0, laneCount: 2, endS: 190, laneId: "w_in:0" },
      { geometry: eOut, index: 0, laneCount: 3, laneId: "e_out:0" },
      "through",
      "g_main",
    ),
    movement(
      "c2",
      { geometry: wIn, index: 1, laneCount: 2, endS: 190, laneId: "w_in:1" },
      { geometry: eOut, index: 1, laneCount: 3, laneId: "e_out:1" },
      "through",
      "g_main",
    ),
    movement(
      "c3",
      { geometry: wIn, index: 1, laneCount: 2, endS: 190, laneId: "w_in:1" },
      { geometry: sOut, index: 1, laneCount: 2, laneId: "s_out:1" },
      "right",
      "g_main",
    ),
    movement(
      "c4",
      { geometry: eIn, index: 1, laneCount: 3, endS: 190, laneId: "e_in:1" },
      { geometry: wOut, index: 0, laneCount: 2, laneId: "w_out:0" },
      "through",
      "g_main",
    ),
    movement(
      "c5",
      { geometry: eIn, index: 2, laneCount: 3, endS: 190, laneId: "e_in:2" },
      { geometry: wOut, index: 1, laneCount: 2, laneId: "w_out:1" },
      "through",
      "g_main",
    ),
    movement(
      "c6",
      { geometry: eIn, index: 0, laneCount: 3, endS: 190, laneId: "e_in:0" },
      { geometry: sOut, index: 0, laneCount: 2, laneId: "s_out:0" },
      "left",
      "g_main",
    ),
    movement(
      "c7",
      { geometry: sIn, index: 0, laneCount: 2, endS: 150, laneId: "s_in:0" },
      { geometry: wOut, index: 1, laneCount: 2, laneId: "w_out:1" },
      "left",
      "g_minor",
    ),
    movement(
      "c8",
      { geometry: sIn, index: 1, laneCount: 2, endS: 150, laneId: "s_in:1" },
      { geometry: eOut, index: 0, laneCount: 3, laneId: "e_out:0" },
      "right",
      "g_minor",
    ),
  ].map((c, i) => ({ ...c, protection: i < 6 ? "protected" : "permissive" }));

  const nodes = [
    { id: "n_w", x: N_W[0], y: N_W[1], kind: "gate" },
    { id: "n_e", x: N_E[0], y: N_E[1], kind: "gate" },
    { id: "n_s", x: N_S[0], y: N_S[1], kind: "gate" },
    { id: "n_c", x: N_C[0], y: N_C[1], kind: "signalized" },
  ];

  const signalControllers = [
    {
      id: "n_c.ctrl",
      nodeId: "n_c",
      groups: [
        { id: "g_main", kind: "vehicle", connectorIds: ["c1", "c2", "c3", "c4", "c5", "c6"] },
        { id: "g_minor", kind: "vehicle", connectorIds: ["c7", "c8"], approachLinkId: "s_in" },
      ],
      phases: [
        { id: "n_c.ctrl.p0", greenGroupIds: ["g_main"], greenS: 30 },
        { id: "n_c.ctrl.p1", greenGroupIds: ["g_minor"], greenS: 15 },
      ],
      leftTurnModes: { e_in: "permissive" },
      pedestrianPhase: false,
    },
  ];

  const crosswalks = [
    {
      id: "cw_west",
      nodeId: "n_c",
      geometry: [[-NODE_RADIUS_M, -7] as Point2, [-NODE_RADIUS_M, 7] as Point2],
      lengthM: 14,
    },
    {
      id: "cw_south",
      nodeId: "n_c",
      geometry: [[-7, -NODE_RADIUS_M] as Point2, [7, -NODE_RADIUS_M] as Point2],
      lengthM: 14,
    },
  ];

  const gates = [
    {
      id: "g_w",
      nodeId: "n_w",
      inLinkIds: ["w_in"],
      outLinkIds: ["w_out"],
      weightIn: 1,
      weightOut: 1,
    },
    {
      id: "g_e",
      nodeId: "n_e",
      inLinkIds: ["e_in"],
      outLinkIds: ["e_out"],
      weightIn: 1,
      weightOut: 1,
    },
    {
      id: "g_s",
      nodeId: "n_s",
      inLinkIds: ["s_in"],
      outLinkIds: ["s_out"],
      weightIn: 1,
      weightOut: 1,
    },
  ];

  const raw = {
    meta: {
      schemaVersion: 1,
      networkId: "demo-t-junction",
      bboxId: "demo",
      bbox: { south: 0, west: 0, north: 0, east: 0 },
      origin: { lat: 43.24, lon: 76.92 },
      generatedAt: "2026-01-01T00:00:00Z",
      generator: "apps/web demo-network",
    },
    nodes,
    links,
    lanes,
    connectors,
    crosswalks,
    signalControllers,
    gates,
  };

  const network = parseNetwork(raw);
  const errors = checkNetworkIntegrity(network);
  if (errors.length > 0) throw new Error(`demo network invalid:\n${errors.join("\n")}`);
  return network;
}
