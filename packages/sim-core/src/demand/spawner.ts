import type { Rng } from "../rng.ts";

/**
 * Arrivals waiting to enter the network, one Poisson process per origin (T-04, generalised to the
 * OD sources of T-12).
 *
 * `budget` is the remaining integrated intensity until the next arrival in Exp(1) event units, so
 * changing the rate mid-run needs no re-draw. Arrivals that cannot enter (no room on any entry
 * lane, vehicle budget exhausted) wait in `waiting`, capped at `horizonS` seconds of the current
 * rate so that a lower `demand.multiplier` takes effect at once even behind a queue. `counted`
 * remembers how many of them were already reported as spawn waits, so one arrival is counted once.
 */
export class ArrivalQueues {
  readonly budget: Float64Array;
  readonly waiting: Int32Array;
  readonly counted: Int32Array;

  constructor(count: number, shares: Float64Array, rng: Rng) {
    this.budget = new Float64Array(count);
    this.waiting = new Int32Array(count);
    this.counted = new Int32Array(count);
    for (let s = 0; s < count; s++) {
      if ((shares[s] as number) > 0) this.budget[s] = rng.exponential(1);
    }
  }

  /** Advances the process of one origin by `dt` at `ratePerS` and queues whatever arrived. */
  advance(source: number, ratePerS: number, dt: number, horizonS: number, rng: Rng): void {
    let budget = (this.budget[source] as number) - ratePerS * dt;
    let waiting = this.waiting[source] as number;
    while (budget <= 0) {
      waiting++;
      budget += rng.exponential(1);
    }
    this.budget[source] = budget;
    const cap = Math.ceil(ratePerS * horizonS);
    if (waiting > cap) waiting = cap;
    this.waiting[source] = waiting;
    if ((this.counted[source] as number) > waiting) this.counted[source] = waiting;
  }

  /** Removes one arrival that has just entered the network. */
  take(source: number): void {
    this.waiting[source] = (this.waiting[source] as number) - 1;
    if ((this.counted[source] as number) > 0) {
      this.counted[source] = (this.counted[source] as number) - 1;
    }
  }

  /** Arrivals still waiting at this origin that were not reported as spawn waits yet. */
  claimUncounted(source: number): number {
    const uncounted = (this.waiting[source] as number) - (this.counted[source] as number);
    if (uncounted > 0) this.counted[source] = this.waiting[source] as number;
    return uncounted > 0 ? uncounted : 0;
  }

  /** Demand went down: arrivals queued under the old rate must not keep entering. */
  clear(): void {
    this.waiting.fill(0);
    this.counted.fill(0);
  }
}
