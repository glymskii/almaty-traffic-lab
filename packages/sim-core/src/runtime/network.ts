import type { Network, SegmentDescriptor, VehicleClass } from "@atl/contracts";
import { VEHICLE_CLASS_CODE, VEHICLE_CLASSES } from "@atl/contracts";
import { TurnCode } from "./turns.ts";

/** Number of vehicle classes; class codes come from VEHICLE_CLASS_CODE (car 0, bus 1, trolleybus 2, taxi 3). */
export const CLASS_COUNT = VEHICLE_CLASSES.length;

/** Bit of a vehicle class inside an `allowed` mask. */
export function classBit(cls: VehicleClass): number {
  return 1 << VEHICLE_CLASS_CODE[cls];
}

function allowedMask(allowed: readonly VehicleClass[]): number {
  let mask = 0;
  for (const c of allowed) mask |= classBit(c);
  return mask;
}

export const NodeKindCode = {
  junction: 0,
  signalized: 1,
  merge: 2,
  gate: 3,
  dead_end: 4,
  bend: 5,
} as const;

/** Connector.protection, see contracts/src/network.ts for the semantics of each. */
export const ProtectionCode = {
  protected: 0,
  permissive: 1,
  yield: 2,
  priority: 3,
} as const;

/** Tolerance when deciding that a lane reaches the end of its link (metres). */
const LANE_END_EPS_M = 0.5;

function mustIndex(map: Map<string, number>, id: string, what: string): number {
  const idx = map.get(id);
  if (idx === undefined) throw new Error(`runtime network: ${what} ${id} is not defined`);
  return idx;
}

/**
 * Flat, integer-indexed view of a Network for the hot loops. Built once in createSimulation;
 * never mutated afterwards. String ids are kept only for the boundaries (frames, metrics, reports).
 *
 * Tracks. Lanes and connectors share one index space: lanes occupy [0, laneCount), connectors
 * [laneCount, trackCount). A vehicle is always on exactly one track. On a lane the longitudinal
 * coordinate `s` is measured along the *link* (so all lanes of a link share the scale, pockets keep
 * their `startS/endS`, and a lane change keeps `s`); on a connector `s` runs from 0 to its length.
 *
 * Polylines. Links and connectors keep their geometry in one vertex table (`px/py/pcum`, per-vertex
 * unit direction `segUx/segUy` and heading). A lane is rendered as its link polyline shifted by
 * `trackOffsetM` to the right; position lookup is a cached segment index per vehicle (see `locate`).
 */
export class RuntimeNetwork {
  // ---- ids and lookups (boundary only) ----
  readonly nodeIds: string[];
  readonly linkIds: string[];
  readonly laneIds: string[];
  readonly connectorIds: string[];
  readonly nodeIndex: Map<string, number>;
  readonly linkIndex: Map<string, number>;
  readonly laneIndex: Map<string, number>;
  readonly connectorIndex: Map<string, number>;

  // ---- nodes ----
  readonly nodeCount: number;
  readonly nodeKind: Uint8Array;
  readonly nodeX: Float64Array;
  readonly nodeY: Float64Array;

  // ---- links ----
  readonly linkCount: number;
  readonly linkFrom: Int32Array;
  readonly linkTo: Int32Array;
  readonly linkLengthM: Float64Array;
  readonly linkSpeedMps: Float64Array;
  /** CSR: lanes of a link in leftmost -> rightmost order, as track indices. */
  readonly linkLaneStart: Int32Array;
  readonly linkLaneCount: Int32Array;
  readonly linkLanes: Int32Array;

  // ---- tracks = lanes + connectors ----
  readonly laneCount: number;
  readonly connectorCount: number;
  readonly trackCount: number;
  /** Lane: lane.startS; connector: 0. */
  readonly trackStartS: Float64Array;
  /** Lane: lane.endS; connector: lengthM. */
  readonly trackEndS: Float64Array;
  /** Speed limit on the track, m/s (connector: min of both links). */
  readonly trackSpeedMps: Float64Array;
  /** Polyline index: link index for lanes, linkCount + connector index for connectors. */
  readonly trackPoly: Int32Array;
  /** Lateral offset to the right of the polyline, metres (0 for connectors). */
  readonly trackOffsetM: Float64Array;
  /** Bit mask of admitted classes (see classBit). */
  readonly trackAllowedMask: Uint8Array;
  /** Owning link for lanes, -1 for connectors. */
  readonly trackLink: Int32Array;
  /** [track * CLASS_COUNT + cls] -> next track for a vehicle of that class, -1 = no permitted continuation. */
  readonly trackNextByClass: Int32Array;
  /**
   * 1 for a lane that reaches the end of its link at a gate or dead-end node: a vehicle without a
   * permitted continuation there leaves the network (trip completed). Anywhere else (lane ending
   * mid-link, junction without a permitted connector) such a vehicle is dropped, see README.
   */
  readonly trackIsExit: Uint8Array;

  // ---- lanes ----
  /** Position of the lane inside its link (0 = leftmost). */
  readonly lanePos: Int32Array;
  /** Neighbour lane index (same link, pos -1 / pos +1) or -1. Overlap in `s` is checked by `lanesOverlapAt`. */
  readonly laneLeft: Int32Array;
  readonly laneRight: Int32Array;
  /** Lane whose `endS` reaches the end of its link (else it ends mid-link). */
  readonly laneReachesLinkEnd: Uint8Array;
  /** CSR: outgoing connectors of a lane (track indices), in network order. */
  readonly laneConnStart: Int32Array;
  readonly laneConnCount: Int32Array;
  readonly laneConnList: Int32Array;

  // ---- connectors (indexed by connector index, track = laneCount + index) ----
  readonly connFromLane: Int32Array;
  readonly connToLane: Int32Array;
  readonly connViaNode: Int32Array;
  /** Movement the connector performs, see TurnCode (track-indexed; meaningless/0 for lanes). */
  readonly connTurn: Uint8Array;

  // ---- polylines ----
  readonly polyCount: number;
  readonly polyStart: Int32Array;
  readonly polyVertexCount: Int32Array;
  /** polyline length / declared length: converts `s` into distance along the stored vertices. */
  readonly polyScale: Float64Array;
  readonly px: Float64Array;
  readonly py: Float64Array;
  /** Cumulative distance from the first vertex. */
  readonly pcum: Float64Array;
  /** Unit direction and heading of the segment starting at the vertex (last vertex repeats the previous). */
  readonly segUx: Float64Array;
  readonly segUy: Float64Array;
  readonly segAngle: Float64Array;

  // ---- gates ----
  readonly gateCount: number;
  readonly gateIds: string[];
  readonly gateNode: Int32Array;
  readonly gateWeightIn: Float64Array;
  /** Share of the network-wide spawn rate (weightIn over the gates that have entry lanes). */
  readonly gateShare: Float64Array;
  /** CSR: entry lanes of a gate (lanes with startS == 0 of its inbound links, link order then lane order). */
  readonly gateLaneStart: Int32Array;
  readonly gateLaneCount: Int32Array;
  readonly gateLanes: Int32Array;
  /** Number of entry lanes over all gates (capacity estimate for auto demand). */
  readonly entryLaneCount: number;

  // ---- metrics segments (per lane, fixed order; descriptors are frozen) ----
  readonly segments: readonly SegmentDescriptor[];
  readonly laneSegStart: Int32Array;
  readonly laneSegCount: Int32Array;
  readonly laneSegLengthM: Float64Array;

  // ---- signal groups and crosswalks (global order used by frames) ----
  readonly signalGroupIds: string[];
  /** groupId -> index into signalGroupIds (same order); built once, shared with runtime/signals.ts. */
  readonly signalGroupIndex: Map<string, number>;
  /** Global group index -> 1 when the group's section is arrow_left/arrow_right, else 0 (main). */
  readonly groupIsArrow: Uint8Array;
  readonly crosswalkIds: string[];

  // ---- connector signal wiring (track-indexed; meaningless/0 for lanes) ----
  /** Connector's signal group (global index into signalGroupIds), or -1 when unsignalized. */
  readonly connSignalGroup: Int32Array;
  /** Connector's Protection, see ProtectionCode. */
  readonly connProtection: Uint8Array;

  constructor(net: Network, segmentLengthM: number) {
    // ---- ids ----
    this.nodeIds = net.nodes.map((n) => n.id);
    this.linkIds = net.links.map((l) => l.id);
    this.laneIds = net.lanes.map((l) => l.id);
    this.connectorIds = net.connectors.map((c) => c.id);
    this.nodeIndex = indexOf(this.nodeIds);
    this.linkIndex = indexOf(this.linkIds);
    this.laneIndex = indexOf(this.laneIds);
    this.connectorIndex = indexOf(this.connectorIds);

    // ---- nodes ----
    const nodeCount = net.nodes.length;
    this.nodeCount = nodeCount;
    this.nodeKind = new Uint8Array(nodeCount);
    this.nodeX = new Float64Array(nodeCount);
    this.nodeY = new Float64Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const n = net.nodes[i];
      if (!n) continue;
      this.nodeKind[i] = NodeKindCode[n.kind];
      this.nodeX[i] = n.x;
      this.nodeY[i] = n.y;
    }

    // ---- links ----
    const linkCount = net.links.length;
    this.linkCount = linkCount;
    this.linkFrom = new Int32Array(linkCount);
    this.linkTo = new Int32Array(linkCount);
    this.linkLengthM = new Float64Array(linkCount);
    this.linkSpeedMps = new Float64Array(linkCount);
    this.linkLaneStart = new Int32Array(linkCount);
    this.linkLaneCount = new Int32Array(linkCount);
    let totalLinkLanes = 0;
    for (const l of net.links) totalLinkLanes += l.laneIds.length;
    this.linkLanes = new Int32Array(totalLinkLanes);
    let laneCursor = 0;
    for (let i = 0; i < linkCount; i++) {
      const l = net.links[i];
      if (!l) continue;
      this.linkFrom[i] = mustIndex(this.nodeIndex, l.fromNodeId, "node");
      this.linkTo[i] = mustIndex(this.nodeIndex, l.toNodeId, "node");
      this.linkLengthM[i] = l.lengthM;
      this.linkSpeedMps[i] = l.speedLimitKph / 3.6;
      this.linkLaneStart[i] = laneCursor;
      this.linkLaneCount[i] = l.laneIds.length;
      for (const laneId of l.laneIds) {
        this.linkLanes[laneCursor++] = mustIndex(this.laneIndex, laneId, "lane");
      }
    }

    // ---- polylines: links then connectors ----
    const connectorCount = net.connectors.length;
    const polyCount = linkCount + connectorCount;
    this.polyCount = polyCount;
    this.polyStart = new Int32Array(polyCount);
    this.polyVertexCount = new Int32Array(polyCount);
    this.polyScale = new Float64Array(polyCount);
    let vertexTotal = 0;
    for (const l of net.links) vertexTotal += l.geometry.length;
    for (const c of net.connectors) vertexTotal += c.geometry.length;
    this.px = new Float64Array(vertexTotal);
    this.py = new Float64Array(vertexTotal);
    this.pcum = new Float64Array(vertexTotal);
    this.segUx = new Float64Array(vertexTotal);
    this.segUy = new Float64Array(vertexTotal);
    this.segAngle = new Float64Array(vertexTotal);
    let vertexCursor = 0;
    const addPolyline = (
      p: number,
      geometry: readonly (readonly [number, number])[],
      lengthM: number,
    ) => {
      const start = vertexCursor;
      const count = geometry.length;
      this.polyStart[p] = start;
      this.polyVertexCount[p] = count;
      let cum = 0;
      for (let k = 0; k < count; k++) {
        const pt = geometry[k] as readonly [number, number];
        this.px[start + k] = pt[0];
        this.py[start + k] = pt[1];
        if (k > 0) {
          const prev = geometry[k - 1] as readonly [number, number];
          cum += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
        }
        this.pcum[start + k] = cum;
      }
      let lastUx = 1;
      let lastUy = 0;
      for (let k = 0; k < count - 1; k++) {
        const dx = (this.px[start + k + 1] as number) - (this.px[start + k] as number);
        const dy = (this.py[start + k + 1] as number) - (this.py[start + k] as number);
        const len = Math.hypot(dx, dy);
        if (len > 1e-9) {
          lastUx = dx / len;
          lastUy = dy / len;
        }
        this.segUx[start + k] = lastUx;
        this.segUy[start + k] = lastUy;
        this.segAngle[start + k] = Math.atan2(lastUy, lastUx);
      }
      // The last vertex has no segment of its own: repeat the previous direction so lookups never read garbage.
      this.segUx[start + count - 1] = lastUx;
      this.segUy[start + count - 1] = lastUy;
      this.segAngle[start + count - 1] = Math.atan2(lastUy, lastUx);
      this.polyScale[p] = lengthM > 0 ? cum / lengthM : 0;
      vertexCursor += count;
    };
    for (let i = 0; i < linkCount; i++) {
      const l = net.links[i];
      if (l) addPolyline(i, l.geometry, l.lengthM);
    }
    for (let c = 0; c < connectorCount; c++) {
      const conn = net.connectors[c];
      if (conn) addPolyline(linkCount + c, conn.geometry, conn.lengthM);
    }

    // ---- tracks ----
    const laneCount = net.lanes.length;
    const trackCount = laneCount + connectorCount;
    this.laneCount = laneCount;
    this.connectorCount = connectorCount;
    this.trackCount = trackCount;
    this.trackStartS = new Float64Array(trackCount);
    this.trackEndS = new Float64Array(trackCount);
    this.trackSpeedMps = new Float64Array(trackCount);
    this.trackPoly = new Int32Array(trackCount);
    this.trackOffsetM = new Float64Array(trackCount);
    this.trackAllowedMask = new Uint8Array(trackCount);
    this.trackLink = new Int32Array(trackCount).fill(-1);
    this.trackNextByClass = new Int32Array(trackCount * CLASS_COUNT).fill(-1);
    this.trackIsExit = new Uint8Array(trackCount);

    this.lanePos = new Int32Array(laneCount);
    this.laneLeft = new Int32Array(laneCount).fill(-1);
    this.laneRight = new Int32Array(laneCount).fill(-1);
    this.laneReachesLinkEnd = new Uint8Array(laneCount);

    for (let i = 0; i < laneCount; i++) {
      const lane = net.lanes[i];
      if (!lane) continue;
      const link = mustIndex(this.linkIndex, lane.linkId, "link");
      this.trackStartS[i] = lane.startS;
      this.trackEndS[i] = lane.endS;
      this.trackSpeedMps[i] = this.linkSpeedMps[link] as number;
      this.trackPoly[i] = link;
      this.trackAllowedMask[i] = allowedMask(lane.allowed);
      this.trackLink[i] = link;
      this.lanePos[i] = lane.index;
      const reachesEnd = lane.endS >= (this.linkLengthM[link] as number) - LANE_END_EPS_M;
      this.laneReachesLinkEnd[i] = reachesEnd ? 1 : 0;
      const toKind = this.nodeKind[this.linkTo[link] as number] as number;
      this.trackIsExit[i] =
        reachesEnd && (toKind === NodeKindCode.gate || toKind === NodeKindCode.dead_end) ? 1 : 0;
    }
    // Lateral offsets and neighbours from the link's lane order.
    for (let l = 0; l < linkCount; l++) {
      const link = net.links[l];
      if (!link) continue;
      const start = this.linkLaneStart[l] as number;
      const count = this.linkLaneCount[l] as number;
      let total = 0;
      for (let k = 0; k < count; k++) {
        const lane = net.lanes[this.linkLanes[start + k] as number];
        total += lane ? lane.widthM : 3.5;
      }
      let acc = 0;
      for (let k = 0; k < count; k++) {
        const laneIdx = this.linkLanes[start + k] as number;
        const lane = net.lanes[laneIdx];
        const w = lane ? lane.widthM : 3.5;
        this.trackOffsetM[laneIdx] = acc + w / 2 - total / 2;
        acc += w;
        if (k > 0) this.laneLeft[laneIdx] = this.linkLanes[start + k - 1] as number;
        if (k < count - 1) this.laneRight[laneIdx] = this.linkLanes[start + k + 1] as number;
      }
    }

    // ---- connectors ----
    this.connFromLane = new Int32Array(connectorCount);
    this.connToLane = new Int32Array(connectorCount);
    this.connViaNode = new Int32Array(connectorCount);
    this.connTurn = new Uint8Array(trackCount);
    this.laneConnStart = new Int32Array(laneCount);
    this.laneConnCount = new Int32Array(laneCount);
    this.laneConnList = new Int32Array(connectorCount);
    for (let c = 0; c < connectorCount; c++) {
      const conn = net.connectors[c];
      if (!conn) continue;
      const from = mustIndex(this.laneIndex, conn.fromLaneId, "lane");
      const to = mustIndex(this.laneIndex, conn.toLaneId, "lane");
      this.connFromLane[c] = from;
      this.connToLane[c] = to;
      this.connViaNode[c] = mustIndex(this.nodeIndex, conn.viaNodeId, "node");
      const t = laneCount + c;
      this.connTurn[t] = TurnCode[conn.turn];
      this.trackStartS[t] = 0;
      this.trackEndS[t] = conn.lengthM;
      this.trackSpeedMps[t] = Math.min(
        this.trackSpeedMps[from] as number,
        this.trackSpeedMps[to] as number,
      );
      this.trackPoly[t] = linkCount + c;
      this.trackOffsetM[t] = 0;
      this.trackAllowedMask[t] = this.trackAllowedMask[to] as number;
      this.laneConnCount[from] = (this.laneConnCount[from] as number) + 1;
    }
    let connCursor = 0;
    for (let i = 0; i < laneCount; i++) {
      this.laneConnStart[i] = connCursor;
      connCursor += this.laneConnCount[i] as number;
      this.laneConnCount[i] = 0; // reused as a fill cursor below
    }
    for (let c = 0; c < connectorCount; c++) {
      const from = this.connFromLane[c] as number;
      const slot = (this.laneConnStart[from] as number) + (this.laneConnCount[from] as number);
      this.laneConnList[slot] = laneCount + c;
      this.laneConnCount[from] = (this.laneConnCount[from] as number) + 1;
    }
    // Next track per class: lane -> first connector whose target admits the class; connector -> its target lane.
    for (let i = 0; i < laneCount; i++) {
      const start = this.laneConnStart[i] as number;
      const count = this.laneConnCount[i] as number;
      for (let cls = 0; cls < CLASS_COUNT; cls++) {
        const bit = 1 << cls;
        let next = -1;
        for (let k = 0; k < count; k++) {
          const t = this.laneConnList[start + k] as number;
          if (((this.trackAllowedMask[t] as number) & bit) !== 0) {
            next = t;
            break;
          }
        }
        this.trackNextByClass[i * CLASS_COUNT + cls] = next;
      }
    }
    for (let c = 0; c < connectorCount; c++) {
      const t = laneCount + c;
      for (let cls = 0; cls < CLASS_COUNT; cls++) {
        this.trackNextByClass[t * CLASS_COUNT + cls] = this.connToLane[c] as number;
      }
    }

    // ---- gates ----
    const gateCount = net.gates.length;
    this.gateCount = gateCount;
    this.gateIds = net.gates.map((g) => g.id);
    this.gateNode = new Int32Array(gateCount);
    this.gateWeightIn = new Float64Array(gateCount);
    this.gateShare = new Float64Array(gateCount);
    this.gateLaneStart = new Int32Array(gateCount);
    this.gateLaneCount = new Int32Array(gateCount);
    const gateLaneList: number[] = [];
    for (let g = 0; g < gateCount; g++) {
      const gate = net.gates[g];
      if (!gate) continue;
      this.gateNode[g] = mustIndex(this.nodeIndex, gate.nodeId, "node");
      this.gateWeightIn[g] = gate.weightIn;
      this.gateLaneStart[g] = gateLaneList.length;
      for (const linkId of gate.inLinkIds) {
        const l = mustIndex(this.linkIndex, linkId, "link");
        const start = this.linkLaneStart[l] as number;
        const count = this.linkLaneCount[l] as number;
        for (let k = 0; k < count; k++) {
          const laneIdx = this.linkLanes[start + k] as number;
          if ((this.trackStartS[laneIdx] as number) <= 0) gateLaneList.push(laneIdx);
        }
      }
      this.gateLaneCount[g] = gateLaneList.length - (this.gateLaneStart[g] as number);
    }
    this.gateLanes = Int32Array.from(gateLaneList);
    this.entryLaneCount = gateLaneList.length;
    let weightTotal = 0;
    for (let g = 0; g < gateCount; g++) {
      if ((this.gateLaneCount[g] as number) > 0) weightTotal += this.gateWeightIn[g] as number;
    }
    for (let g = 0; g < gateCount; g++) {
      this.gateShare[g] =
        weightTotal > 0 && (this.gateLaneCount[g] as number) > 0
          ? (this.gateWeightIn[g] as number) / weightTotal
          : 0;
    }

    // ---- metrics segments ----
    const segments: SegmentDescriptor[] = [];
    this.laneSegStart = new Int32Array(laneCount);
    this.laneSegCount = new Int32Array(laneCount);
    this.laneSegLengthM = new Float64Array(laneCount);
    for (let i = 0; i < laneCount; i++) {
      const lane = net.lanes[i];
      if (!lane) continue;
      const link = this.trackLink[i] as number;
      const linkObj = net.links[link];
      const lengthM = lane.endS - lane.startS;
      const n = Math.max(1, Math.round(lengthM / segmentLengthM));
      const piece = lengthM / n;
      this.laneSegStart[i] = segments.length;
      this.laneSegCount[i] = n;
      this.laneSegLengthM[i] = piece;
      const freeFlowSpeedMps = this.trackSpeedMps[i] as number;
      for (let k = 0; k < n; k++) {
        const startS = lane.startS + k * piece;
        const endS = k === n - 1 ? lane.endS : lane.startS + (k + 1) * piece;
        const isApproach = k === n - 1 && this.laneReachesLinkEnd[i] === 1 && linkObj !== undefined;
        const seg: SegmentDescriptor = {
          index: segments.length,
          laneId: lane.id,
          linkId: lane.linkId,
          startS,
          endS,
          freeFlowSpeedMps,
        };
        if (isApproach && linkObj) seg.approachNodeId = linkObj.toNodeId;
        segments.push(Object.freeze(seg));
      }
    }
    this.segments = segments;

    // ---- signal groups and crosswalks ----
    this.signalGroupIds = [];
    this.signalGroupIndex = new Map();
    const groupIsArrow: number[] = [];
    for (const ctrl of net.signalControllers) {
      for (const g of ctrl.groups) {
        this.signalGroupIndex.set(g.id, this.signalGroupIds.length);
        this.signalGroupIds.push(g.id);
        groupIsArrow.push(g.section === "main" ? 0 : 1);
      }
    }
    this.groupIsArrow = Uint8Array.from(groupIsArrow);
    this.crosswalkIds = net.crosswalks.map((c) => c.id);

    // ---- connector signal wiring ----
    this.connSignalGroup = new Int32Array(trackCount).fill(-1);
    this.connProtection = new Uint8Array(trackCount);
    for (let c = 0; c < connectorCount; c++) {
      const conn = net.connectors[c];
      if (!conn) continue;
      const t = laneCount + c;
      this.connProtection[t] = ProtectionCode[conn.protection];
      if (conn.signalGroupId !== undefined) {
        this.connSignalGroup[t] = mustIndex(
          this.signalGroupIndex,
          conn.signalGroupId,
          "signal group",
        );
      }
    }
  }

  /** True when lanes `a` and `b` (same link) both exist at coordinate `s`. */
  lanesOverlapAt(a: number, b: number, s: number): boolean {
    return (
      s >= Math.max(this.trackStartS[a] as number, this.trackStartS[b] as number) &&
      s <= Math.min(this.trackEndS[a] as number, this.trackEndS[b] as number)
    );
  }

  /**
   * Vertex slot `k` (absolute index into px/py/pcum) of the polyline segment containing distance `d`
   * along polyline `p`, starting the search from a cached segment `hint` (relative to the polyline).
   * Returns the relative segment index; callers keep it as the next hint.
   */
  locate(p: number, d: number, hint: number): number {
    const start = this.polyStart[p] as number;
    const last = (this.polyVertexCount[p] as number) - 2; // last segment index
    if (last < 0) return 0;
    let seg = hint < 0 ? 0 : hint > last ? last : hint;
    while (seg < last && d >= (this.pcum[start + seg + 1] as number)) seg++;
    while (seg > 0 && d < (this.pcum[start + seg] as number)) seg--;
    return seg;
  }

  /** Distance along the stored polyline for a vehicle coordinate `s` on a track. */
  polyDistance(track: number, s: number): number {
    return s * (this.polyScale[this.trackPoly[track] as number] as number);
  }
}

function indexOf(ids: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) map.set(ids[i] as string, i);
  return map;
}
