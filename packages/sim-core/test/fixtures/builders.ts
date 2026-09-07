import {
  checkNetworkIntegrity,
  type Network,
  type NetworkOverride,
  parseNetwork,
  type VehicleClass,
} from "@atl/contracts";

/**
 * Synthetic mini-networks for nuance tests (docs/NUANCES.md). Every builder returns a Network that
 * passes parseNetwork + checkNetworkIntegrity. Builders are deterministic and dependency-free.
 * `straightRoad` is implemented here as the reference example; the others are T-03.
 */

const ALL: VehicleClass[] = ["car", "bus", "trolleybus", "taxi"];
const PT: VehicleClass[] = ["bus", "trolleybus"];

function meta(networkId: string) {
  return {
    schemaVersion: 1 as const,
    networkId,
    bboxId: "synthetic",
    bbox: { south: 0, west: 0, north: 0, east: 0 },
    origin: { lat: 43.24, lon: 76.92 },
    generatedAt: "2026-01-01T00:00:00Z",
    generator: "synthetic-builders",
  };
}

export interface StraightRoadOptions {
  lengthM?: number;
  /** General lanes, excluding the bus lane. */
  lanes?: number;
  speedLimitKph?: number;
  /** Adds a rightmost dedicated bus lane. */
  busLane?: boolean;
  /** Places a bus stop at this position on the rightmost lane. */
  busStop?: { s: number; kind: "in_lane" | "bay" };
  /** Adds a single bus route over the road with these headways. */
  busRoute?: { headwayPeakS: number; headwayOffpeakS: number };
}

/** gate -> one directed link -> gate. Baseline for speed-limit, lane-count, bus-lane and bus-stop tests. */
export function straightRoad(opts: StraightRoadOptions = {}): Network {
  const lengthM = opts.lengthM ?? 1000;
  const lanes = opts.lanes ?? 2;
  const speed = opts.speedLimitKph ?? 60;
  const laneIds: string[] = [];
  const laneDefs = [];
  for (let i = 0; i < lanes; i++) {
    const id = `l0:${i}`;
    laneIds.push(id);
    laneDefs.push({
      id,
      linkId: "l0",
      index: i,
      startS: 0,
      endS: lengthM,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    });
  }
  if (opts.busLane) {
    const id = `l0:${lanes}`;
    laneIds.push(id);
    laneDefs.push({
      id,
      linkId: "l0",
      index: lanes,
      startS: 0,
      endS: lengthM,
      kind: "bus",
      allowed: PT,
      turns: ["through"],
      busLane: { allowed: PT },
    });
  }
  const rightmost = laneIds[laneIds.length - 1] as string;
  const busStops = opts.busStop
    ? [{ id: "stop0", linkId: "l0", laneId: rightmost, s: opts.busStop.s, kind: opts.busStop.kind }]
    : [];
  const busRoutes = opts.busRoute
    ? [
        {
          id: "route0",
          ref: "1",
          kind: "bus",
          linkIds: ["l0"],
          stopIds: busStops.map((s) => s.id),
          headwayPeakS: opts.busRoute.headwayPeakS,
          headwayOffpeakS: opts.busRoute.headwayOffpeakS,
          entryNodeId: "n0",
          exitNodeId: "n1",
        },
      ]
    : [];

  return finish({
    meta: meta("straight-road"),
    nodes: [
      { id: "n0", x: 0, y: 0, kind: "gate" },
      { id: "n1", x: lengthM, y: 0, kind: "gate" },
    ],
    links: [
      {
        id: "l0",
        fromNodeId: "n0",
        toNodeId: "n1",
        name: "Тестовая",
        highwayClass: "secondary",
        geometry: [
          [0, 0],
          [lengthM, 0],
        ],
        lengthM,
        speedLimitKph: speed,
        laneIds,
      },
    ],
    lanes: laneDefs,
    connectors: [],
    gates: [
      { id: "g0", nodeId: "n0", inLinkIds: ["l0"], weightIn: 1, weightOut: 0 },
      { id: "g1", nodeId: "n1", outLinkIds: ["l0"], weightIn: 0, weightOut: 1 },
    ],
    busStops,
    busRoutes,
  });
}

export interface CrossroadsOptions {
  /** Approach length from gate to stop line, per arm. */
  armLengthM?: number;
  /** General through lanes per approach. */
  lanes?: number;
  /** Left-turn pocket length per approach; 0 = no pocket (left turns share the leftmost through lane). */
  leftPocketM?: number;
  leftTurnMode?: "protected" | "permissive" | "protected_permissive" | "prohibited";
  /** Bus lane on the east-west street. */
  busLaneEW?: boolean;
  /** Pedestrian crosswalks on all arms with a pedestrian phase. */
  crosswalks?: boolean;
  /** Fixed-time plan. When omitted the builder emits a simple 2-phase plan (NS / EW) plus arrows if protected. */
  cycleS?: number;
  greenSplitNS?: number;
}

/** Four-arm signalized intersection with gates at each arm end. The workhorse fixture. T-03. */
export function crossroads(_opts: CrossroadsOptions = {}): Network {
  throw new Error("not implemented: see docs/tasks/T-03-synthetic-builders.md");
}

export interface TJunctionOptions {
  armLengthM?: number;
  lanes?: number;
  /** Unsignalized: minor road yields. Signalized: 2-phase plan. */
  signalized?: boolean;
}

/** Main road with a minor road joining from the south. T-03. */
export function tJunction(_opts: TJunctionOptions = {}): Network {
  throw new Error("not implemented: see docs/tasks/T-03-synthetic-builders.md");
}

export interface MergeRampOptions {
  mainLanes?: number;
  mainLengthM?: number;
  /** Length of the acceleration lane after the merge node; 0 = ramp ends at the node (yield). */
  accelLaneM?: number;
}

/** Trunk road with a ramp joining at a merge node (Al-Farabi style). T-03. */
export function mergeRamp(_opts: MergeRampOptions = {}): Network {
  throw new Error("not implemented: see docs/tasks/T-03-synthetic-builders.md");
}

export interface CorridorOptions {
  intersections?: number;
  spacingM?: number;
  lanes?: number;
  /** Offsets for green wave; omitted = all zero. */
  offsetsS?: number[];
  /** Parallel residential street one block away (for navigator re-routing tests). */
  parallelStreet?: boolean;
}

/** Arterial with N signalized crossroads in a row. T-03. */
export function corridor(_opts: CorridorOptions = {}): Network {
  throw new Error("not implemented: see docs/tasks/T-03-synthetic-builders.md");
}

/** Convenience: apply overrides to a synthetic network (delegates to map-data once T-24 lands). */
export function withOverrides(_net: Network, _overrides: NetworkOverride[]): Network {
  throw new Error("not implemented: see docs/tasks/T-24-scenario-editor.md");
}

/** Validate strictly; builders must never emit inconsistent networks. */
export function finish(raw: unknown): Network {
  const net = parseNetwork(raw);
  const errors = checkNetworkIntegrity(net);
  if (errors.length > 0) throw new Error(`synthetic network invalid:\n${errors.join("\n")}`);
  return net;
}
