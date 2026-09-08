import type { Point2 } from "@atl/contracts";

/**
 * Pure 2D geometry helpers for the lane convention in docs/CONTRACTS.md ("Конвенция геометрии
 * полос"): lane `i` of `N` is the link's axial geometry offset to the right, in the direction of
 * travel, by `(i - (N-1)/2) * widthM`. No THREE.js or DOM here so this stays fast to unit-test.
 */

function sub(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}

/** Vector sum, exported for arrow/marking placement in markings.ts. */
export function addPoints(a: Point2, b: Point2): Point2 {
  return [a[0] + b[0], a[1] + b[1]];
}

/** Scalar multiple, exported for arrow/marking placement in markings.ts. */
export function scalePoint(a: Point2, s: number): Point2 {
  return [a[0] * s, a[1] * s];
}

function length(a: Point2): number {
  return Math.hypot(a[0], a[1]);
}

function normalize(a: Point2): Point2 {
  const l = length(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : [1, 0];
}

/** Rotate a unit vector counter-clockwise by `angleRad` (CLAUDE.md: angles CCW from +x). */
export function rotateVector(v: Point2, angleRad: number): Point2 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return [v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos];
}

/** Right-hand perpendicular of a heading vector (map plane: x = east, y = north). */
function rightOf(heading: Point2): Point2 {
  return [heading[1], -heading[0]];
}

/** Lateral offset (m) of lane `index` of `laneCount` from the link's axial geometry; positive = right. */
export function laneLateralOffsetM(index: number, laneCount: number, widthM: number): number {
  return (index - (laneCount - 1) / 2) * widthM;
}

/** Lateral offset (m) of one edge of lane `index`, for divider lines drawn between/around lanes. */
export function laneEdgeOffsetM(
  index: number,
  laneCount: number,
  widthM: number,
  side: "left" | "right",
): number {
  const center = laneLateralOffsetM(index, laneCount, widthM);
  return side === "left" ? center - widthM / 2 : center + widthM / 2;
}

/**
 * Offset a polyline by a constant perpendicular distance (positive = right of travel direction).
 * Interior vertices use a miter join, clamped so sharp angles don't produce spikes.
 */
export function offsetPolyline(points: readonly Point2[], offsetM: number): Point2[] {
  if (points.length < 2) throw new Error("offsetPolyline: need at least 2 points");
  if (offsetM === 0) return points.map((p): Point2 => [p[0], p[1]]);

  const segmentDirs: Point2[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segmentDirs.push(normalize(sub(points[i + 1] as Point2, points[i] as Point2)));
  }

  const out: Point2[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = segmentDirs[i - 1];
    const next = segmentDirs[i];
    const around =
      prev !== undefined && next !== undefined ? addPoints(prev, next) : (prev ?? next);
    const avgDir = normalize(around as Point2);
    const miterNormal = rightOf(avgDir);
    const segNormal = rightOf((next ?? prev) as Point2);
    const cosHalfAngle = miterNormal[0] * segNormal[0] + miterNormal[1] * segNormal[1];
    const MIN_COS = 0.2;
    const miterScale = 1 / Math.max(Math.abs(cosHalfAngle), MIN_COS);
    out.push(addPoints(points[i] as Point2, scalePoint(miterNormal, offsetM * miterScale)));
  }
  return out;
}

export interface PolylineSample {
  point: Point2;
  /** Unit tangent in the direction of travel. */
  heading: Point2;
}

/** Position and heading at arc-length `s` along `points` (clamped to the polyline's own extent). */
export function sampleAtS(points: readonly Point2[], s: number): PolylineSample {
  if (points.length < 2) throw new Error("sampleAtS: need at least 2 points");
  const clamped = Math.max(0, s);
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as Point2;
    const b = points[i + 1] as Point2;
    const segLen = length(sub(b, a));
    const isLastSegment = i === points.length - 2;
    if (clamped <= acc + segLen || isLastSegment) {
      const heading = normalize(sub(b, a));
      const t = segLen > 1e-9 ? Math.min(1, Math.max(0, (clamped - acc) / segLen)) : 0;
      return { point: addPoints(a, scalePoint(heading, t * segLen)), heading };
    }
    acc += segLen;
  }
  const a = points[0] as Point2;
  const b = points[1] as Point2;
  return { point: a, heading: normalize(sub(b, a)) };
}

/** Sub-polyline of `points` between arc-lengths `[startS, endS]`, including interpolated endpoints. */
export function slicePolyline(points: readonly Point2[], startS: number, endS: number): Point2[] {
  const out: Point2[] = [sampleAtS(points, startS).point];
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as Point2;
    const b = points[i + 1] as Point2;
    const segLen = length(sub(b, a));
    const vertexS = acc + segLen;
    if (vertexS > startS && vertexS < endS) out.push(b);
    acc = segLen + acc;
  }
  out.push(sampleAtS(points, endS).point);
  return out;
}

/** Convenience: the lane-`index` centreline over the full link geometry (before slicing to startS/endS). */
export function laneAxis(
  linkGeometry: readonly Point2[],
  index: number,
  laneCount: number,
  widthM: number,
): Point2[] {
  return offsetPolyline(linkGeometry, laneLateralOffsetM(index, laneCount, widthM));
}
