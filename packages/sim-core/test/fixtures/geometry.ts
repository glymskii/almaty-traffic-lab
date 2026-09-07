/**
 * Pure 2D geometry helpers for synthetic network builders (builders.ts). Right-hand-traffic
 * convention throughout: for a heading vector `dir`, "right" is `dir` rotated -90 deg (clockwise).
 * x = east, y = north, matching the project's local metric coordinates (see CLAUDE.md).
 */

export type Vec2 = [number, number];

/** Default lane width, matches `Lane.widthM` default in packages/contracts/src/network.ts. */
export const LANE_WIDTH_M = 3.5;

export function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function scale(a: Vec2, k: number): Vec2 {
  return [a[0] * k, a[1] * k];
}

export function vecLength(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}

export function normalize(a: Vec2): Vec2 {
  const l = vecLength(a);
  if (l < 1e-9) return [0, 0];
  return [a[0] / l, a[1] / l];
}

/** Unit vector for an angle in degrees, counter-clockwise from +x (east). */
export function fromAngleDeg(deg: number): Vec2 {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

/** Right-hand-traffic offset direction: heading rotated -90 deg (clockwise). */
export function rightOf(dir: Vec2): Vec2 {
  return normalize([dir[1], -dir[0]]);
}

/** Left-hand offset direction: heading rotated +90 deg (counter-clockwise). */
export function leftOf(dir: Vec2): Vec2 {
  return normalize([-dir[1], dir[0]]);
}

/**
 * Lateral offset of lane `index` (0 = leftmost) from its link's centreline, in the direction of
 * travel. Mirrors the formula in docs/CONTRACTS.md ("Конвенция геометрии полос").
 */
export function lateralOffsetM(index: number, totalLanes: number, widthM = LANE_WIDTH_M): number {
  return (index - (totalLanes - 1) / 2) * widthM;
}

function endpointsOf(geometry: readonly Vec2[]): { first: Vec2; last: Vec2 } {
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  if (!first || !last) throw new Error("geometry needs at least 2 points");
  return { first, last };
}

/**
 * World position of a lane's centreline at the start or end of a straight link, offset from the
 * link's own geometry by the lane's lateral position.
 */
export function laneEndpoint(
  geometry: readonly Vec2[],
  laneIndex: number,
  totalLanes: number,
  atEnd: boolean,
  widthM = LANE_WIDTH_M,
): Vec2 {
  const { first, last } = endpointsOf(geometry);
  const dir = normalize(sub(last, first));
  const off = scale(rightOf(dir), lateralOffsetM(laneIndex, totalLanes, widthM));
  return add(atEnd ? last : first, off);
}

/** Cubic Bezier from p0 (tangent t0) to p3 (tangent t3), sampled into `samples` points. */
export function cubicBezierPolyline(p0: Vec2, t0: Vec2, p3: Vec2, t3: Vec2, samples = 8): Vec2[] {
  const pull = Math.max(vecLength(sub(p3, p0)) / 3, 1);
  const dir0 = normalize(t0);
  const dir3 = normalize(t3);
  const p1 = add(p0, scale(dir0, pull));
  const p2 = sub(p3, scale(dir3, pull));
  const points: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    points.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return points;
}

/** Total length of a polyline (sum of segment lengths). */
export function polylineLen(points: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    len += vecLength(sub(cur, prev));
  }
  return len;
}

export interface PolylineCrossing {
  /** Distance along polyline `a` to the crossing point. */
  sA: number;
  /** Distance along polyline `b` to the crossing point. */
  sB: number;
}

/** Proper intersection of two open segments (excludes touching at endpoints). */
function segmentCrossing(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): { t: number; u: number } | null {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(denom) < 1e-9) return null;
  const diff = sub(p3, p1);
  const t = (diff[0] * d2[1] - diff[1] * d2[0]) / denom;
  const u = (diff[0] * d1[1] - diff[1] * d1[0]) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { t, u };
}

/**
 * First point (smallest distance along `a`) where polylines `a` and `b` genuinely cross, or
 * `null` if they never do. Used to derive geometric conflict points between connectors.
 */
export function firstCrossing(a: readonly Vec2[], b: readonly Vec2[]): PolylineCrossing | null {
  let best: PolylineCrossing | null = null;
  let sA = 0;
  for (let i = 0; i < a.length - 1; i++) {
    const a0 = a[i];
    const a1 = a[i + 1];
    if (!a0 || !a1) continue;
    const segLenA = vecLength(sub(a1, a0));
    let sB = 0;
    for (let j = 0; j < b.length - 1; j++) {
      const b0 = b[j];
      const b1 = b[j + 1];
      if (!b0 || !b1) continue;
      const segLenB = vecLength(sub(b1, b0));
      const hit = segmentCrossing(a0, a1, b0, b1);
      if (hit) {
        const candidate = { sA: sA + hit.t * segLenA, sB: sB + hit.u * segLenB };
        if (!best || candidate.sA < best.sA) best = candidate;
      }
      sB += segLenB;
    }
    sA += segLenA;
  }
  return best;
}
