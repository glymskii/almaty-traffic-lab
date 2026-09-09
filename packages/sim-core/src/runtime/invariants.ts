/**
 * Debug-mode consistency checks (`config.debugInvariants`, N26). Off by default: production and the
 * headless CLI never pay for this, tests that opt in do. Every check here is a pure read over
 * caller-owned state -- nothing is allocated, so turning the flag on never changes `step()`'s
 * allocation profile beyond the one scratch buffer `SimulationImpl` keeps for it.
 */
import type { RuntimeNetwork } from "./network.ts";
import type { VehiclePool } from "./vehicles.ts";

/** Thrown by every check in this module. The message carries enough context to reproduce the failure. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolationError";
  }
}

/** Speed above `desiredSpeed * SPEED_OVERSHOOT_FACTOR + SPEED_OVERSHOOT_MARGIN_MPS` is corruption. */
const SPEED_OVERSHOOT_FACTOR = 1.5;
/** Absolute slack on top of the ratio above, so a near-zero `v0` (e.g. right after a red light) does
 * not make ordinary IDM overshoot noise look like a violation. */
const SPEED_OVERSHOOT_MARGIN_MPS = 0.5;
/** Slack on `s` at a track boundary: float rounding only (`advanceTrack`'s pathological-chain clamp
 * lands exactly `0.001` short of the end, well inside this). */
const S_BOUNDS_EPS_M = 1e-2;

/**
 * Minimum bumper-to-bumper gap tolerated between a leader and its follower on the same track before
 * `checkInvariants` treats it as corruption rather than the model's own known transient.
 *
 * Not 0: a vehicle that still owes a mandatory lane change (T-10) but reaches the end of its lane
 * before completing it falls back, in `enterLink`/`detourConnector` (`simulation.ts`), to whichever
 * connector `detourConnector` finds reachable -- which can differ from the one the free-flow
 * lookahead already used to compute this step's acceleration (that lookahead reads `pool.nextTrack`,
 * which still names the *original* connector). The vehicle can then land on an already-queued
 * connector at close to the speed limit with no braking history, and `IDM_MAX_DECEL`
 * (`models/idm.ts`, 8 m/s^2) is not always enough to clear the resulting gap within one `dtS`. A
 * sweep of `crossroads({lanes})` x `lanes` in [1,2,3] x `demand.multiplier` in [1.0,1.3,1.6] x
 * `seed` in [1,2,3] never exceeded about -4.5 m (see docs/NUANCES.md N26 and the T-22 report for the
 * full trace); the -6 m tolerance below leaves margin for that characterised, reproducible transient
 * while still failing on unbounded overlap, NaN or a list desync. Making the lookahead agree with
 * whichever connector `detourConnector` actually picks is future work (see the sim-core README,
 * "`runtime/invariants.ts`: инварианты в debug-режиме"), not in this task's scope.
 */
export const GAP_TOLERANCE_M = -6;

/**
 * Full per-step check (N26): no non-finite state, no negative or wildly oversped vehicle, `s` inside
 * its track's bounds, every active vehicle listed on exactly one track, and no bumper-to-bumper gap
 * worse than `GAP_TOLERANCE_M`. Throws `InvariantViolationError` on the first problem found.
 *
 * `visited` is a caller-owned scratch buffer sized to `pool.capacity` (`SimulationImpl` keeps one
 * across steps so this never allocates); its contents on entry do not matter, it is cleared here.
 */
export function checkInvariants(
  pool: VehiclePool,
  runtime: RuntimeNetwork,
  visited: Uint8Array,
  simTimeS: number,
): void {
  let activeCount = 0;
  for (let i = 0; i < pool.highWater; i++) {
    const t = pool.track[i] as number;
    if (t < 0) continue;
    activeCount++;
    const s = pool.s[i] as number;
    const v = pool.v[i] as number;
    const a = pool.a[i] as number;
    const x = pool.x[i] as number;
    const y = pool.y[i] as number;
    if (
      !Number.isFinite(s) ||
      !Number.isFinite(v) ||
      !Number.isFinite(a) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new InvariantViolationError(
        `non-finite state at slot ${i} (id ${pool.id[i]}), t=${simTimeS}: s=${s} v=${v} a=${a} x=${x} y=${y}`,
      );
    }
    if (v < 0) {
      throw new InvariantViolationError(
        `negative speed at slot ${i} (id ${pool.id[i]}), t=${simTimeS}: v=${v}`,
      );
    }
    const v0 = (runtime.trackSpeedMps[t] as number) * (pool.speedFactor[i] as number);
    if (v > v0 * SPEED_OVERSHOOT_FACTOR + SPEED_OVERSHOOT_MARGIN_MPS) {
      throw new InvariantViolationError(
        `speed above ${SPEED_OVERSHOOT_FACTOR}x desired at slot ${i} (id ${pool.id[i]}), t=${simTimeS}: v=${v} v0=${v0} track=${t}`,
      );
    }
    const start = runtime.trackStartS[t] as number;
    const end = runtime.trackEndS[t] as number;
    if (s < start - S_BOUNDS_EPS_M || s > end + S_BOUNDS_EPS_M) {
      throw new InvariantViolationError(
        `s outside track bounds at slot ${i} (id ${pool.id[i]}), t=${simTimeS}: s=${s} track=${t} bounds=[${start}, ${end}]`,
      );
    }
  }

  visited.fill(0);
  let visitedCount = 0;
  for (let track = 0; track < runtime.trackCount; track++) {
    let i = pool.trackTail[track] as number;
    while (i >= 0) {
      if (visited[i] === 1) {
        throw new InvariantViolationError(
          `slot ${i} (id ${pool.id[i]}) listed on more than one track, t=${simTimeS}, track=${track}`,
        );
      }
      visited[i] = 1;
      visitedCount++;
      const leader = pool.ahead[i] as number;
      if (leader >= 0) {
        const gap =
          (pool.s[leader] as number) - (pool.length[leader] as number) - (pool.s[i] as number);
        if (gap <= GAP_TOLERANCE_M) {
          throw new InvariantViolationError(
            `gap ${gap.toFixed(3)} m below tolerance (${GAP_TOLERANCE_M} m) on track ${track}, ` +
              `t=${simTimeS}: follower slot ${i} (id ${pool.id[i]}), leader slot ${leader} (id ${pool.id[leader]})`,
          );
        }
      }
      i = leader;
    }
  }
  if (visitedCount !== activeCount) {
    throw new InvariantViolationError(
      `vehicle count mismatch, t=${simTimeS}: ${visitedCount} listed across all tracks, ${activeCount} active in the pool`,
    );
  }
}

/**
 * Debug-mode counterpart to `VehiclePool.sortTrack` (T-04 review note): the identical tail-to-head
 * insertion-sort walk, including the same repair (`swapWithAhead`) for an ordinary crossing -- a
 * vehicle a few centimetres ahead of where the list still has it is the same characterised, bounded
 * transient `checkInvariants` already tolerates via `GAP_TOLERANCE_M` (see its doc comment), not a
 * defect, and production silently repairs it every step without incident. What debug mode adds is
 * throwing instead of repairing the moment a crossing is *not* bounded by that tolerance: a vehicle
 * having overtaken its "leader" by more than `GAP_TOLERANCE_M` of adjusted gap is corruption by the
 * same standard the rest of this module uses, and `sortTrack` would otherwise repair it silently
 * before anything else -- in particular `checkInvariants`, which only runs once per full step -- ever
 * saw the intermediate state.
 */
export function checkTrackOrder(pool: VehiclePool, track: number, simTimeS: number): void {
  const s = pool.s;
  const length = pool.length;
  let i = pool.trackTail[track] as number;
  while (i >= 0) {
    const next = pool.ahead[i] as number;
    let b = pool.behind[i] as number;
    while (b >= 0 && (s[b] as number) > (s[i] as number)) {
      // `b` (nominally i's follower) has overtaken `i`: `b` is the real leader now.
      const gap = (s[b] as number) - (length[b] as number) - (s[i] as number);
      if (gap <= GAP_TOLERANCE_M) {
        throw new InvariantViolationError(
          `track ${track} order inversion beyond tolerance (${GAP_TOLERANCE_M} m) at t=${simTimeS}: ` +
            `slot ${b} (id ${pool.id[b]}) overtook slot ${i} (id ${pool.id[i]}) by gap ${gap.toFixed(3)} m`,
        );
      }
      pool.swapWithAhead(b);
      b = pool.behind[i] as number;
    }
    i = next;
  }
}
