import type { Point2 } from "@atl/contracts";

/** Axis-aligned rectangle in local metres. */
export interface Rect {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function pointInRect(p: Point2, r: Rect): boolean {
  return p[0] >= r.xmin && p[0] <= r.xmax && p[1] >= r.ymin && p[1] <= r.ymax;
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function lerp(a: Point2, b: Point2, t: number): Point2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Liang–Barsky clipping. Returns the parameter interval [t0, t1] (0..1) of segment a→b that lies
 * inside the rectangle, or undefined when the segment misses it entirely.
 */
export function clipSegmentToRect(a: Point2, b: Point2, r: Rect): [number, number] | undefined {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - r.xmin],
    [dx, r.xmax - a[0]],
    [-dy, a[1] - r.ymin],
    [dy, r.ymax - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return undefined;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return undefined;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

/** Drops consecutive points closer than `epsM`. Keeps the first point; keeps the last point when distinct. */
export function dedupePolyline(points: readonly Point2[], epsM = 1e-3): Point2[] {
  const out: Point2[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev !== undefined && distance(prev, p) < epsM) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

function perpendicularDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return distance(p, a);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Douglas–Peucker simplification. Always keeps the first and the last point. Iterative (no recursion depth issues). */
export function simplifyPolyline(points: readonly Point2[], epsilonM: number): Point2[] {
  const n = points.length;
  if (n <= 2) return points.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (range === undefined) break;
    const [start, end] = range;
    if (end - start < 2) continue;
    const a = points[start] as Point2;
    const b = points[end] as Point2;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i] as Point2, a, b);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > epsilonM && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  const out: Point2[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i] === 1) {
      const p = points[i] as Point2;
      out.push([p[0], p[1]]);
    }
  }
  return out;
}

/**
 * Parallel offset of a polyline. `d > 0` shifts to the right of the direction of travel
 * (x = east, y = north, so "right" of a northbound line is east). Vertices use the bisector
 * of the adjacent segment normals with the miter limited to 2·d so sharp bends do not spike.
 */
export function offsetPolyline(points: readonly Point2[], d: number): Point2[] {
  const n = points.length;
  if (n < 2 || d === 0) return points.map((p) => [p[0], p[1]]);
  const nx: number[] = [];
  const ny: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i] as Point2;
    const b = points[i + 1] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    nx.push(dy / len);
    ny.push(-dx / len);
  }
  const out: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i] as Point2;
    let ox: number;
    let oy: number;
    if (i === 0) {
      ox = nx[0] as number;
      oy = ny[0] as number;
    } else if (i === n - 1) {
      ox = nx[n - 2] as number;
      oy = ny[n - 2] as number;
    } else {
      const ax = nx[i - 1] as number;
      const ay = ny[i - 1] as number;
      const bx = nx[i] as number;
      const by = ny[i] as number;
      const sx = ax + bx;
      const sy = ay + by;
      const sl = Math.hypot(sx, sy);
      if (sl < 1e-6) {
        ox = bx;
        oy = by;
      } else {
        const ux = sx / sl;
        const uy = sy / sl;
        const cosHalf = ux * bx + uy * by;
        const scale = 1 / Math.max(cosHalf, 0.5);
        ox = ux * scale;
        oy = uy * scale;
      }
    }
    out.push([p[0] + ox * d, p[1] + oy * d]);
  }
  return out;
}

/** Rounds coordinates to centimetres for compact, byte-stable JSON. */
export function roundPolyline(points: readonly Point2[], decimals = 2): Point2[] {
  const f = 10 ** decimals;
  return points.map((p) => [Math.round(p[0] * f) / f, Math.round(p[1] * f) / f]);
}

export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
