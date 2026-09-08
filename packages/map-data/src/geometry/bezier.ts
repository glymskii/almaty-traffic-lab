import type { Point2 } from "@atl/contracts";
import { normalizeVec, perpRight } from "./angles.ts";

/** Points sampled along a connector curve (card T-07 §2: "длина по 12 точкам"). */
export const CONNECTOR_SAMPLES = 12;

/**
 * Cubic Bezier from `p0` (leaving along `t0`) to `p3` (arriving along `t3`), sampled into
 * `samples` points. Control points sit one third of the chord along the tangents, so a movement
 * between two nearly coincident lane ends stays short instead of looping.
 */
export function cubicBezierPolyline(
  p0: Point2,
  t0: Point2,
  p3: Point2,
  t3: Point2,
  samples = CONNECTOR_SAMPLES,
): Point2[] {
  const pull = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 3;
  const d0 = normalizeVec(t0);
  const d3 = normalizeVec(t3);
  const p1: Point2 = [p0[0] + d0[0] * pull, p0[1] + d0[1] * pull];
  const p2: Point2 = [p3[0] - d3[0] * pull, p3[1] - d3[1] * pull];
  const out: Point2[] = [];
  const last = Math.max(samples - 1, 1);
  for (let i = 0; i < samples; i++) {
    const t = i / last;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return out;
}

/**
 * Lateral offset of lane `index` (0 = leftmost) from its link centreline, positive to the right
 * of travel. Mirrors docs/CONTRACTS.md, "Конвенция геометрии полос".
 */
export function lateralOffsetM(index: number, total: number, widthM: number): number {
  return (index - (total - 1) / 2) * widthM;
}

/** Centre of lane `index` at a point on the link centreline where the link heads along `heading`. */
export function laneCentrePoint(
  centre: Point2,
  heading: Point2,
  index: number,
  total: number,
  widthM: number,
): Point2 {
  const right = perpRight(normalizeVec(heading));
  const off = lateralOffsetM(index, total, widthM);
  return [centre[0] + right[0] * off, centre[1] + right[1] * off];
}
