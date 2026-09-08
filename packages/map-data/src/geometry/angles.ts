import type { Point2, TurnKind } from "@atl/contracts";

/** |angle| up to this is a through movement (card T-07 §1). */
export const THROUGH_MAX_DEG = 30;
/** |angle| above this is a u-turn; between the two bounds it is a left or a right turn. */
export const TURN_MAX_DEG = 150;

const RAD_TO_DEG = 180 / Math.PI;

export function normalizeVec(v: Point2): Point2 {
  const len = Math.hypot(v[0], v[1]);
  if (len < 1e-9) return [0, 0];
  return [v[0] / len, v[1] / len];
}

export function negate(v: Point2): Point2 {
  return [-v[0], -v[1]];
}

export function dot(a: Point2, b: Point2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** z of the 2D cross product: > 0 when `b` points counter-clockwise (to the left) of `a`. */
export function crossZ(a: Point2, b: Point2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/** `v` rotated by -90 deg: the right-hand side of a vehicle heading along `v`. */
export function perpRight(v: Point2): Point2 {
  return [v[1], -v[0]];
}

function headingBetween(points: readonly Point2[], from: number, step: number): Point2 {
  for (let i = from; i >= 0 && i < points.length - 1; i += step) {
    const a = points[i] as Point2;
    const b = points[i + 1] as Point2;
    const h = normalizeVec([b[0] - a[0], b[1] - a[1]]);
    if (h[0] !== 0 || h[1] !== 0) return h;
  }
  return [1, 0];
}

/** Direction of travel at the end of a polyline (last non-degenerate segment). */
export function headingAtEnd(points: readonly Point2[]): Point2 {
  return headingBetween(points, points.length - 2, -1);
}

/** Direction of travel at the start of a polyline (first non-degenerate segment). */
export function headingAtStart(points: readonly Point2[]): Point2 {
  return headingBetween(points, 0, 1);
}

/** Angle from `from` to `to` in degrees, counter-clockwise positive, in (-180, 180]. */
export function signedAngleDeg(from: Point2, to: Point2): number {
  return Math.atan2(crossZ(from, to), dot(from, to)) * RAD_TO_DEG;
}

/** Turn kind of a movement that arrives along one heading and leaves along another (card T-07 §1). */
export function classifyTurn(deltaDeg: number): TurnKind {
  if (Math.abs(deltaDeg) <= THROUGH_MAX_DEG) return "through";
  if (deltaDeg > THROUGH_MAX_DEG && deltaDeg <= TURN_MAX_DEG) return "left";
  if (deltaDeg < -THROUGH_MAX_DEG && deltaDeg >= -TURN_MAX_DEG) return "right";
  return "uturn";
}

/** Ideal angle of a turn kind, used to pick the best exit when several fit the same kind. */
export function idealAngleDeg(turn: TurnKind): number {
  if (turn === "left") return 90;
  if (turn === "right") return -90;
  if (turn === "uturn") return 180;
  return 0;
}

/** 0 = east, 1 = north-east, 2 = north, ... 7 = south-east. */
export function compassIndex(v: Point2): number {
  const deg = Math.atan2(v[1], v[0]) * RAD_TO_DEG;
  return ((Math.round(deg / 45) % 8) + 8) % 8;
}
