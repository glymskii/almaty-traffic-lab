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
