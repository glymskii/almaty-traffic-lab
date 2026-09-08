import type { Point2 } from "@atl/contracts";

/** A point where two polylines meet, given as the distance along each of them. */
export interface PolylineCrossing {
  sA: number;
  sB: number;
}

export interface PolylineApproach extends PolylineCrossing {
  distM: number;
}

/** Proper crossing of two open segments; endpoint touches do not count. */
function segmentCrossing(
  p1: Point2,
  p2: Point2,
  p3: Point2,
  p4: Point2,
): { t: number; u: number } | undefined {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return undefined;
  const dx = p3[0] - p1[0];
  const dy = p3[1] - p1[1];
  const t = (dx * d2y - dy * d2x) / denom;
  const u = (dx * d1y - dy * d1x) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return undefined;
  return { t, u };
}

/** First point (smallest distance along `a`) where the polylines genuinely cross. */
export function firstCrossing(
  a: readonly Point2[],
  b: readonly Point2[],
): PolylineCrossing | undefined {
  let best: PolylineCrossing | undefined;
  let sA = 0;
  for (let i = 0; i < a.length - 1; i++) {
    const a0 = a[i] as Point2;
    const a1 = a[i + 1] as Point2;
    const lenA = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
    let sB = 0;
    for (let j = 0; j < b.length - 1; j++) {
      const b0 = b[j] as Point2;
      const b1 = b[j + 1] as Point2;
      const lenB = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
      const hit = segmentCrossing(a0, a1, b0, b1);
      if (hit !== undefined) {
        const cand = { sA: sA + hit.t * lenA, sB: sB + hit.u * lenB };
        if (best === undefined || cand.sA < best.sA) best = cand;
      }
      sB += lenB;
    }
    sA += lenA;
  }
  return best;
}

/** Closest point of `p` on polyline `b`: distance to it and the arc length along `b`. */
function closestOnPolyline(p: Point2, b: readonly Point2[]): { s: number; dist: number } {
  let bestDist = Number.POSITIVE_INFINITY;
  let bestS = 0;
  let s = 0;
  for (let j = 0; j < b.length - 1; j++) {
    const b0 = b[j] as Point2;
    const b1 = b[j + 1] as Point2;
    const dx = b1[0] - b0[0];
    const dy = b1[1] - b0[1];
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - b0[0]) * dx + (p[1] - b0[1]) * dy) / len2));
    const dist = Math.hypot(p[0] - (b0[0] + t * dx), p[1] - (b0[1] + t * dy));
    if (dist < bestDist) {
      bestDist = dist;
      bestS = s + t * Math.sqrt(len2);
    }
    s += Math.sqrt(len2);
  }
  return { s: bestS, dist: bestDist };
}

/**
 * Closest approach of two polylines, sampled at their vertices. Used for movement pairs that must
 * conflict by rule (a left turn against the opposing through) even when the sampled curves happen
 * not to cross.
 */
export function closestApproach(
  a: readonly Point2[],
  b: readonly Point2[],
): PolylineApproach | undefined {
  let best: PolylineApproach | undefined;
  const consider = (sA: number, sB: number, distM: number) => {
    if (best === undefined || distM < best.distM) best = { sA, sB, distM };
  };
  let sA = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Point2;
    if (i > 0) {
      const prev = a[i - 1] as Point2;
      sA += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    }
    const hit = closestOnPolyline(p, b);
    consider(sA, hit.s, hit.dist);
  }
  let sB = 0;
  for (let i = 0; i < b.length; i++) {
    const p = b[i] as Point2;
    if (i > 0) {
      const prev = b[i - 1] as Point2;
      sB += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    }
    const hit = closestOnPolyline(p, a);
    consider(hit.s, sB, hit.dist);
  }
  return best;
}
