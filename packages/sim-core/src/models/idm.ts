/**
 * Intelligent Driver Model (Treiber, Hennecke, Helbing 2000).
 *
 *   a = aMax * [ 1 - (v / v0)^delta - (s* / gap)^2 ]
 *   s* = s0 + max(0, v*T + v*dv / (2*sqrt(aMax*b)))
 *
 * `dv = v - vLeader` (positive when closing in), `gap` is the bumper-to-bumper distance to the leader.
 * With `gap = +Infinity` the interaction term vanishes and the free-road acceleration is returned.
 */
export const IDM_DELTA = 4;

/** Below this gap (metres) the interaction term is evaluated as if the gap were this large, to avoid infinities. */
const MIN_GAP_M = 0.01;

/** Physical limit of braking, m/s^2: the model never returns a deceleration stronger than this. */
export const IDM_MAX_DECEL = 8;

export function idmAcceleration(
  v: number,
  v0: number,
  dv: number,
  gap: number,
  timeHeadwayS: number,
  minGapM: number,
  maxAccel: number,
  comfortDecel: number,
): number {
  const free = idmFreeAcceleration(v, v0, maxAccel);
  if (gap === Number.POSITIVE_INFINITY) return free;
  const g = gap > MIN_GAP_M ? gap : MIN_GAP_M;
  const dynamic = v * timeHeadwayS + (v * dv) / (2 * Math.sqrt(maxAccel * comfortDecel));
  const sStar = minGapM + (dynamic > 0 ? dynamic : 0);
  const ratio = sStar / g;
  const a = free - maxAccel * ratio * ratio;
  return a < -IDM_MAX_DECEL ? -IDM_MAX_DECEL : a;
}

/** Free-road part of the IDM: aMax * (1 - (v/v0)^4), clamped at -IDM_MAX_DECEL. `v0` must be positive. */
export function idmFreeAcceleration(v: number, v0: number, maxAccel: number): number {
  const r = v / v0;
  const r2 = r * r;
  const a = maxAccel * (1 - r2 * r2);
  return a < -IDM_MAX_DECEL ? -IDM_MAX_DECEL : a;
}
