import type { Link, MetricsFrame, Network, Point2 } from "@atl/contracts";
import type { SegmentIndex } from "../metrics/segments.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";

/**
 * Segments of one lane taken into an approach (the piece in front of the stop line) or into the
 * head of a downstream stretch. Six 25 m segments are 150 m: long enough to hold the standing part
 * of a queue that matters, short enough that a 600 m link does not average its jam away.
 */
export const GROUP_SEGMENTS_PER_LANE = 6;

export type CandidateKind = "approach" | "mid";

/**
 * A set of segments plus the boundaries of the per-lane runs inside it (`laneOffsets` has one more
 * entry than there are lanes). The runs matter because a queue is a property of a lane, not of a
 * 25 m segment: a segment reports at most its own length, so the standing part is summed along the
 * lane and only then compared with the other lanes.
 */
export interface SegmentRuns {
  readonly segments: Int32Array;
  readonly laneOffsets: Int32Array;
}

/**
 * A place the detector can blame: either the approach of a link to the node it ends at, or the rest
 * of that link ("середина линка"). Built once from the topology and never mutated -- only the
 * windowed numbers behind it change from report to report.
 */
export interface CandidateGroup extends SegmentRuns {
  /** Stable across reports and networks with the same ids: `${linkId}:${nodeId ?? "mid"}`. */
  readonly id: string;
  readonly kind: CandidateKind;
  readonly linkId: string;
  readonly linkIndex: number;
  /** Node the approach ends at; absent for a mid-link group. */
  readonly nodeId?: string;
  readonly title: string;
  /** Camera target: the stop line for an approach, the middle of the stretch for a mid-link group. */
  readonly focus: Point2;
  /**
   * Downstream stretches to test "ниже по потоку свободнее" against, one per exit link (for an
   * approach) or the approach of the same link (for a mid-link group). The one carrying the most
   * flow is the one that decides; an empty list means nothing is downstream (the exit is a gate),
   * which counts as free by definition.
   */
  readonly downstream: readonly DownstreamStretch[];
}

/** One place the traffic of a group flows into, and the segments that measure how free it is. */
export interface DownstreamStretch extends SegmentRuns {
  readonly linkId: string;
}

/** Windowed aggregate of a group over the segments it owns. */
export interface GroupStats {
  /** Vehicle-count weighted mean over the group's segments. */
  speedRatio: number;
  congestedShare: number;
  /** Longest per-lane standing queue in the group: one blocked lane is a queue on its own. */
  queueM: number;
  vcRatio: number;
  delayVehS: number;
  delayPersonS: number;
  /** Window-mean number of vehicles standing on the group, the weight of every mean above. */
  vehicles: number;
}

/**
 * Groups of segments the detector ranks (T-19, docs/ARCHITECTURE.md "Метрики и детектор").
 *
 * Per link: the **approach** is the last `min(6, all)` segments of every lane that reaches the end of
 * the link, i.e. what is standing in front of the stop line across all lanes including pockets and
 * the bus lane; the **mid-link** group is everything else on the link. A pocket shorter than six
 * segments simply contributes fewer of them, which is why the approach is not a fixed rectangle.
 */
export function buildCandidates(
  net: Network,
  rt: RuntimeNetwork,
  seg: SegmentIndex,
): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  // The network arrays are searched once here instead of once per link: with a few thousand links
  // a `find` inside the loop would make building the candidates quadratic.
  const linkById = new Map(net.links.map((l) => [l.id, l]));
  const nodeNameById = new Map(net.nodes.map((n) => [n.id, n.name]));
  const approachByLink = new Map<number, SegmentRuns>();
  const headByLink = new Map<number, SegmentRuns>();

  for (let link = 0; link < rt.linkCount; link++) {
    approachByLink.set(link, tailSegments(rt, seg, link));
    headByLink.set(link, headSegments(rt, seg, link));
  }

  for (let link = 0; link < rt.linkCount; link++) {
    const linkId = rt.linkIds[link] as string;
    const approach = approachByLink.get(link) ?? emptyRuns();
    const exits = exitStretches(rt, link, headByLink);
    if (approach.segments.length > 0) {
      const nodeIndex = rt.linkTo[link] as number;
      const nodeId = rt.nodeIds[nodeIndex] as string;
      groups.push({
        id: `${linkId}:${nodeId}`,
        kind: "approach",
        linkId,
        linkIndex: link,
        nodeId,
        title: approachTitle(linkById.get(linkId), nodeNameById.get(nodeId), nodeId),
        focus: pointAlong(linkById.get(linkId), Number.POSITIVE_INFINITY),
        segments: approach.segments,
        laneOffsets: approach.laneOffsets,
        downstream: exits,
      });
    }
    const mid = midSegments(rt, seg, link, approach.segments);
    if (mid.segments.length > 0) {
      // The rest of the link drains into its own approach; only when the link has no approach at
      // all (every lane ends mid-link) does the exit of the junction decide.
      const downstream: DownstreamStretch[] =
        approach.segments.length > 0
          ? [{ linkId, segments: approach.segments, laneOffsets: approach.laneOffsets }]
          : exits;
      groups.push({
        id: `${linkId}:mid`,
        kind: "mid",
        linkId,
        linkIndex: link,
        title: midTitle(linkById.get(linkId), linkId),
        focus: midFocus(linkById.get(linkId), seg, mid.segments),
        segments: mid.segments,
        laneOffsets: mid.laneOffsets,
        downstream,
      });
    }
  }
  return groups;
}

function emptyRuns(): SegmentRuns {
  return { segments: new Int32Array(0), laneOffsets: Int32Array.of(0) };
}

function toRuns(out: number[], offsets: number[]): SegmentRuns {
  offsets.push(out.length);
  return { segments: Int32Array.from(out), laneOffsets: Int32Array.from(offsets) };
}

/** Last `min(6, all)` segments of every lane of `link` that reaches the end of the link. */
function tailSegments(rt: RuntimeNetwork, seg: SegmentIndex, link: number): SegmentRuns {
  const out: number[] = [];
  const offsets: number[] = [];
  const start = rt.linkLaneStart[link] as number;
  const count = rt.linkLaneCount[link] as number;
  for (let k = start; k < start + count; k++) {
    const lane = rt.linkLanes[k] as number;
    if (rt.laneReachesLinkEnd[lane] !== 1) continue;
    const last = seg.lastSegmentOfLane(lane);
    const first = seg.firstSegmentOfLane(lane);
    const from = Math.max(first, last - GROUP_SEGMENTS_PER_LANE + 1);
    offsets.push(out.length);
    for (let s = from; s <= last; s++) out.push(s);
  }
  return toRuns(out, offsets);
}

/** First `min(6, all)` segments of every lane of `link`: the head of a downstream stretch. */
function headSegments(rt: RuntimeNetwork, seg: SegmentIndex, link: number): SegmentRuns {
  const out: number[] = [];
  const offsets: number[] = [];
  const start = rt.linkLaneStart[link] as number;
  const count = rt.linkLaneCount[link] as number;
  for (let k = start; k < start + count; k++) {
    const lane = rt.linkLanes[k] as number;
    const first = seg.firstSegmentOfLane(lane);
    const last = seg.lastSegmentOfLane(lane);
    const to = Math.min(last, first + GROUP_SEGMENTS_PER_LANE - 1);
    offsets.push(out.length);
    for (let s = first; s <= to; s++) out.push(s);
  }
  return toRuns(out, offsets);
}

/** Every segment of `link` that the approach did not take. */
function midSegments(
  rt: RuntimeNetwork,
  seg: SegmentIndex,
  link: number,
  approach: Int32Array,
): SegmentRuns {
  const taken = new Set<number>();
  for (const s of approach) taken.add(s);
  const out: number[] = [];
  const offsets: number[] = [];
  const start = rt.linkLaneStart[link] as number;
  const count = rt.linkLaneCount[link] as number;
  for (let k = start; k < start + count; k++) {
    const lane = rt.linkLanes[k] as number;
    const first = seg.firstSegmentOfLane(lane);
    const last = seg.lastSegmentOfLane(lane);
    let pushed = false;
    for (let s = first; s <= last; s++) {
      if (taken.has(s)) continue;
      if (!pushed) {
        offsets.push(out.length);
        pushed = true;
      }
      out.push(s);
    }
  }
  return toRuns(out, offsets);
}

/**
 * One stretch per link the connectors of `link` lead to. A lane whose only continuation is out of
 * the network contributes nothing, so a link that only feeds a gate ends up with an empty list.
 */
function exitStretches(
  rt: RuntimeNetwork,
  link: number,
  headByLink: Map<number, SegmentRuns>,
): DownstreamStretch[] {
  const exitLinks: number[] = [];
  const seen = new Set<number>();
  const start = rt.linkLaneStart[link] as number;
  const count = rt.linkLaneCount[link] as number;
  for (let k = start; k < start + count; k++) {
    const lane = rt.linkLanes[k] as number;
    const connStart = rt.laneConnStart[lane] as number;
    const connCount = rt.laneConnCount[lane] as number;
    for (let c = connStart; c < connStart + connCount; c++) {
      // `laneConnList` holds TRACK indices; the connector-indexed tables need the offset removed.
      const conn = (rt.laneConnList[c] as number) - rt.laneCount;
      const toLane = rt.connToLane[conn] as number;
      const toLink = rt.trackLink[toLane] as number;
      if (toLink < 0 || toLink === link || seen.has(toLink)) continue;
      seen.add(toLink);
      exitLinks.push(toLink);
    }
  }
  const out: DownstreamStretch[] = [];
  for (const exit of exitLinks) {
    const head = headByLink.get(exit);
    if (head !== undefined && head.segments.length > 0)
      out.push({
        linkId: rt.linkIds[exit] as string,
        segments: head.segments,
        laneOffsets: head.laneOffsets,
      });
  }
  return out;
}

/**
 * Folds the window into the numbers the three bottleneck conditions are tested against.
 * Means are weighted by the vehicles that stood on each segment: a jammed pocket next to two empty
 * through lanes must not be averaged into "the approach flows".
 */
export function aggregate(frame: MetricsFrame, seg: SegmentIndex, runs: SegmentRuns): GroupStats {
  const segments = runs.segments;
  const offsets = runs.laneOffsets;
  let weight = 0;
  let speed = 0;
  let congested = 0;
  let queueM = 0;
  let vcRatio = 0;
  let delayVehS = 0;
  let delayPersonS = 0;
  for (let lane = 0; lane + 1 < offsets.length; lane++) {
    const from = offsets[lane] as number;
    const to = offsets[lane + 1] as number;
    // The standing part of one lane spans several 25 m segments and each of them reports at most
    // its own length, so a lane's queue is the sum along it -- and lanes are then compared, not
    // added: one blocked lane next to a running one is still a 100 m queue.
    let laneQueueM = 0;
    for (let k = from; k < to; k++) {
      const i = segments[k] as number;
      // density is veh per lane-km averaged over the window, so this is the mean occupancy in vehicles.
      const w = (frame.density[i] as number) * ((seg.segLengthM[i] as number) / 1000);
      weight += w;
      speed += w * (frame.speedRatio[i] as number);
      congested += w * (frame.congestedShare[i] as number);
      laneQueueM += frame.queueM[i] as number;
      const vc = frame.vcRatio[i] as number;
      if (vc > vcRatio) vcRatio = vc;
      delayVehS += frame.delayVehS[i] as number;
      delayPersonS += frame.delayPersonS[i] as number;
    }
    if (laneQueueM > queueM) queueM = laneQueueM;
  }
  // An empty stretch is free by definition; without the guard it would read as speedRatio 0 and
  // pass the "slower than 30 % of free flow" test with no traffic on it at all.
  const speedRatio = weight > 0 ? clamp01(speed / weight) : 1;
  const congestedShare = weight > 0 ? clamp01(congested / weight) : 0;
  return { speedRatio, congestedShare, queueM, vcRatio, delayVehS, delayPersonS, vehicles: weight };
}

/** Total window flow over a stretch: how the detector picks which exit actually carries the traffic. */
export function stretchFlow(frame: MetricsFrame, segments: Int32Array): number {
  let flow = 0;
  for (const i of segments) flow += frame.flow[i] as number;
  return flow;
}

function clamp01(v: number): number {
  if (!(v > 0)) return 0;
  return v > 1 ? 1 : v;
}

/**
 * Where an approach comes from, in the genitive case, indexed like `compassIndex`
 * (0 = east ... 7 = south-east). The same wording `map-data`'s `describeApproach` produces (T-07);
 * sim-core cannot import it, so it derives the direction from the link geometry itself.
 */
const APPROACH_FROM_RU: readonly string[] = [
  "востока",
  "северо-востока",
  "севера",
  "северо-запада",
  "запада",
  "юго-запада",
  "юга",
  "юго-востока",
];

/** Compass sector an approach arrives from: 0 = east, 2 = north, 4 = west, 6 = south. */
export function approachDirectionRu(net: Network, linkId: string): string {
  return directionOf(net.links.find((l) => l.id === linkId));
}

function directionOf(link: Link | undefined): string {
  if (link === undefined) return "";
  const g = link.geometry;
  let ux = 0;
  let uy = 0;
  for (let i = g.length - 2; i >= 0; i--) {
    const a = g[i] as Point2;
    const b = g[i + 1] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) {
      // Negated: the direction the approach comes FROM, not the one it travels towards.
      ux = -dx / len;
      uy = -dy / len;
      break;
    }
  }
  const deg = (Math.atan2(uy, ux) * 180) / Math.PI;
  const sector = ((Math.round(deg / 45) % 8) + 8) % 8;
  return APPROACH_FROM_RU[sector] ?? "";
}

function approachTitle(
  link: Link | undefined,
  nodeName: string | undefined,
  nodeId: string,
): string {
  const place = nodeName ?? link?.name ?? nodeId;
  return `${place}, подход с ${directionOf(link)}`;
}

function midTitle(link: Link | undefined, linkId: string): string {
  return `${link?.name ?? linkId}, участок`;
}

/** Point at coordinate `s` on the link centreline; `s` beyond the ends is clamped. */
export function pointAlongLink(net: Network, linkId: string, s: number): Point2 {
  return pointAlong(
    net.links.find((l) => l.id === linkId),
    s,
  );
}

function pointAlong(link: Link | undefined, s: number): Point2 {
  if (link === undefined) return [0, 0];
  const g = link.geometry;
  if (g.length === 0) return [0, 0];
  const first = g[0] as Point2;
  if (g.length === 1 || !(s > 0)) return [first[0], first[1]];
  let total = 0;
  for (let i = 0; i + 1 < g.length; i++) {
    const a = g[i] as Point2;
    const b = g[i + 1] as Point2;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  // `s` is measured on the declared link length; the polyline may be a hair longer or shorter.
  const target = Math.min(total, (s / link.lengthM) * total);
  let walked = 0;
  for (let i = 0; i + 1 < g.length; i++) {
    const a = g[i] as Point2;
    const b = g[i + 1] as Point2;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 0) continue;
    if (walked + len >= target) {
      const t = (target - walked) / len;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += len;
  }
  const last = g[g.length - 1] as Point2;
  return [last[0], last[1]];
}

/** Middle of a mid-link stretch: the group has no stop line to point the camera at. */
function midFocus(link: Link | undefined, seg: SegmentIndex, segments: Int32Array): Point2 {
  let minS = Number.POSITIVE_INFINITY;
  let maxS = 0;
  for (const i of segments) {
    const endS = seg.segEndS[i] as number;
    const startS = endS - (seg.segLengthM[i] as number);
    if (startS < minS) minS = startS;
    if (endS > maxS) maxS = endS;
  }
  if (!Number.isFinite(minS)) return pointAlong(link, (link?.lengthM ?? 0) / 2);
  return pointAlong(link, (minS + maxS) / 2);
}
