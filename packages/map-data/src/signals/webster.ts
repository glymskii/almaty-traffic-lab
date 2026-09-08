import type { HighwayClass, SignalTiming } from "@atl/contracts";

/**
 * Webster's method for a fixed-time plan (card T-08 §1). Demand is assumed, not measured: the
 * compiler has no counts, so an approach is credited with `APPROACH_FLOW_PER_LANE_VPH` per through
 * lane, scaled by the class of the street.
 */

/** Assumed hourly demand of one through lane of an approach. */
export const APPROACH_FLOW_PER_LANE_VPH = 400;

/** Class multiplier on the assumed approach demand. `*_link` inherits its base class. */
export const CLASS_FLOW_FACTOR: Record<HighwayClass, number> = {
  trunk: 1.5,
  trunk_link: 1.5,
  primary: 1.2,
  primary_link: 1.2,
  secondary: 1.0,
  secondary_link: 1.0,
  tertiary: 0.7,
  tertiary_link: 0.7,
  residential: 0.4,
  unclassified: 0.4,
  living_street: 0.4,
  service: 0.4,
};

/** Lower bound of the cycle; the upper bound is `SignalTiming.maxCycleS`. */
export const MIN_CYCLE_S = 40;
/** Σy above this is treated as saturation, otherwise Webster's cycle would blow up or go negative. */
export const MAX_FLOW_RATIO_SUM = 0.9;
/** A protected left lead phase gets this share of the cycle, clamped to [10, 15] s (card T-08 §1). */
export const ARROW_GREEN_SHARE = 0.15;
export const ARROW_GREEN_MIN_S = 10;
export const ARROW_GREEN_MAX_S = 15;
/** Walking speed used to size a pedestrian-only phase (matches `PedestrianConfig.walkSpeedMps`). */
export const PEDESTRIAN_WALK_SPEED_MPS = 1.3;
/** Upper bound of a pedestrian-only phase, so one long zebra cannot eat the whole cycle. */
export const PEDESTRIAN_GREEN_MAX_S = 30;

/** Assumed demand of one approach, veh/h. */
export function approachFlowVph(highwayClass: HighwayClass, throughLanes: number): number {
  return APPROACH_FLOW_PER_LANE_VPH * throughLanes * CLASS_FLOW_FACTOR[highwayClass];
}

/** Flow ratio y = q / (s · n). Approaches without a through lane cannot carry the phase. */
export function flowRatio(flowVph: number, saturationVphPerLane: number, lanes: number): number {
  if (lanes <= 0 || saturationVphPerLane <= 0) return 0;
  return flowVph / (saturationVphPerLane * lanes);
}

/** Green of a protected left lead phase: 10..15 s, ~15 % of the cycle. */
export function arrowGreenS(cycleS: number): number {
  const raw = Math.round(cycleS * ARROW_GREEN_SHARE);
  return Math.min(ARROW_GREEN_MAX_S, Math.max(ARROW_GREEN_MIN_S, raw));
}

/** Green of a pedestrian-only phase: long enough to cross the widest zebra of the node. */
export function pedestrianGreenS(longestCrosswalkM: number, minGreenS: number): number {
  const walk = Math.ceil(longestCrosswalkM / PEDESTRIAN_WALK_SPEED_MPS);
  return Math.min(PEDESTRIAN_GREEN_MAX_S, Math.max(Math.ceil(minGreenS), walk));
}

/** One phase as Webster sees it: either a critical movement to serve, or a fixed-length insert. */
export interface PhaseDemand {
  /** Critical flow ratio of the phase; ignored when `fixedGreenS` is set. */
  criticalY: number;
  /** Arrow and pedestrian phases do not take part in the proportional split. */
  fixedGreenS?: number;
  /** Lost time of this phase: yellow + all-red. */
  lostS: number;
}

export interface WebsterPlan {
  /** Σ(green + yellow + allRed); equals the clamped Webster cycle unless minimum greens grew it. */
  cycleS: number;
  /** Green of every phase, in the input order; integers. */
  greensS: number[];
  /** Webster cycle before the minimum greens were enforced. */
  websterCycleS: number;
  /** Σy over the phases that took part in the split. */
  flowRatioSum: number;
}

/**
 * Webster: C = (1.5·L + 5) / (1 − Σy) clamped to [MIN_CYCLE_S, maxCycleS]; the green left after the
 * lost time and the fixed inserts is split proportionally to y with a floor of `minGreenS`. When
 * the floors do not fit, the cycle grows past the clamp rather than starving a phase.
 */
export function websterPlan(phases: readonly PhaseDemand[], timing: SignalTiming): WebsterPlan {
  const lostS = phases.reduce((sum, p) => sum + p.lostS, 0);
  const split: number[] = [];
  let flowRatioSum = 0;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (phase === undefined || phase.fixedGreenS !== undefined) continue;
    split.push(i);
    flowRatioSum += phase.criticalY;
  }
  const capped = Math.min(flowRatioSum, MAX_FLOW_RATIO_SUM);
  const raw = (1.5 * lostS + 5) / (1 - capped);
  const websterCycleS = Math.round(raw);
  const cycleS = Math.min(timing.maxCycleS, Math.max(MIN_CYCLE_S, websterCycleS));

  const greensS = phases.map((p) => Math.round(p.fixedGreenS ?? 0));
  const fixed = greensS.reduce((sum, g) => sum + g, 0);
  const minGreenS = Math.max(1, Math.ceil(timing.minGreenS));
  const available = cycleS - lostS - fixed;
  const weights = split.map((i) => Math.max(0, phases[i]?.criticalY ?? 0));
  const shares = distributeInt(available, weights, minGreenS);
  for (let k = 0; k < split.length; k++) {
    const i = split[k];
    const share = shares[k];
    if (i !== undefined && share !== undefined) greensS[i] = share;
  }
  const total = greensS.reduce((sum, g) => sum + g, 0) + lostS;
  return { cycleS: total, greensS, websterCycleS, flowRatioSum };
}

/**
 * Split `total` into `weights.length` integers, each at least `minEach`, proportional to the
 * weights. Deterministic: the rounding remainder goes to the largest fractional parts, ties by
 * index. When the minimums do not fit into `total`, everyone still gets `minEach`.
 */
export function distributeInt(
  total: number,
  weights: readonly number[],
  minEach: number,
): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const extra = Math.max(0, Math.floor(total - minEach * n));
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (sum > 0 ? (extra * w) / sum : extra / n));
  const out = raw.map((r) => Math.floor(r));
  let rest = extra - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  while (rest > 0) {
    for (const entry of order) {
      if (rest <= 0) break;
      out[entry.i] = (out[entry.i] ?? 0) + 1;
      rest -= 1;
    }
  }
  return out.map((v) => v + minEach);
}
