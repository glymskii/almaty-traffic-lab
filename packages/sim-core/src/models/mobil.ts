/**
 * MOBIL lane-change model (Kesting, Treiber, Helbing 2007), as pure functions over accelerations
 * that the caller computes with the IDM (`models/idm.ts`).
 *
 * A change from the current lane to a candidate lane is performed when both hold:
 *
 *  - safety:    a_newFollower(after) >= -b_safe
 *  - incentive: (a_new - a_old) + p * (dA_oldFollower + dA_newFollower) + bias > a_thr
 *
 * where `dA_x = a_x(after) - a_x(before)`, `p` is the driver's politeness and `a_thr` its switching
 * threshold. `bias` is 0 for a discretionary change and grows for a mandatory one (turn lane, bus
 * lane the vehicle must leave, lane that ends): see `mandatoryBias`.
 */

/** Deceleration the new follower may never be forced beyond by a lane change, m/s^2. */
export const MOBIL_SAFE_DECEL_MPS2 = 4;

/**
 * A mandatory change becomes unconditional (bias = +Infinity, "forcing") once the vehicle is this
 * close to the end of its lane: only the safety criterion still applies.
 */
export const MOBIL_FORCE_WITHIN_M = 30;

/** Bias of a mandatory change just outside the forcing zone, m/s^2 (linear ramp from 0). */
export const MOBIL_MAX_MANDATORY_BIAS_MPS2 = 4;

/** Safety criterion: the vehicle that ends up behind the changer must not brake harder than `b_safe`. */
export function mobilSafe(
  aNewFollowerAfter: number,
  safeDecelMps2: number = MOBIL_SAFE_DECEL_MPS2,
): boolean {
  return aNewFollowerAfter >= -safeDecelMps2;
}

/**
 * Incentive of the change, m/s^2: own gain plus the politeness-weighted gain of both followers.
 * Compare against the driver's threshold (`laneChangeThresholdMps2`) minus any mandatory bias.
 */
export function mobilIncentive(
  aOwnAfter: number,
  aOwnBefore: number,
  aOldFollowerAfter: number,
  aOldFollowerBefore: number,
  aNewFollowerAfter: number,
  aNewFollowerBefore: number,
  politeness: number,
): number {
  const own = aOwnAfter - aOwnBefore;
  const others = aOldFollowerAfter - aOldFollowerBefore + (aNewFollowerAfter - aNewFollowerBefore);
  return own + politeness * others;
}

/**
 * Bias added to the incentive of a mandatory change, m/s^2, as a function of the distance left to
 * the end of the lane (or of the link, whichever comes first):
 *
 *   d >= lookahead      -> 0        (the manoeuvre is not urgent yet)
 *   forceWithin < d < lookahead -> linear ramp 0 .. maxBias
 *   d <= forceWithin    -> +Infinity (forcing: only safety still applies)
 */
export function mandatoryBias(
  distanceToEndM: number,
  lookaheadM: number,
  forceWithinM: number = MOBIL_FORCE_WITHIN_M,
  maxBiasMps2: number = MOBIL_MAX_MANDATORY_BIAS_MPS2,
): number {
  if (distanceToEndM <= forceWithinM) return Number.POSITIVE_INFINITY;
  if (distanceToEndM >= lookaheadM) return 0;
  const span = lookaheadM - forceWithinM;
  if (span <= 0) return Number.POSITIVE_INFINITY;
  return (maxBiasMps2 * (lookaheadM - distanceToEndM)) / span;
}
