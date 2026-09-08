import {
  CAUSE_COUNT,
  type CauseKey,
  causeCode,
  DELAY_CAUSE_KEYS,
  type MetricsFrame,
} from "@atl/contracts";

/** Causes shown in the panel; anything past the fifth is noise on a 25 m segment. */
export const MAX_CAUSES = 5;

export interface CauseShare {
  cause: CauseKey;
  share: number;
}

/** Cause codes of DELAY_CAUSE_KEYS, resolved once (the array order is the reporting order). */
const DELAY_CAUSE_CODES: readonly number[] = DELAY_CAUSE_KEYS.map((k) => causeCode(k));

/**
 * Why a group is slow: the delay-weighted mix of the ROOT causes of its segments (T-18 already
 * propagated "the car in front" back to the head of the queue), restricted to `DELAY_CAUSE_KEYS`
 * and renormalised over them.
 *
 * Weighting by `delayVehS` and not by segment is the point: a 25 m segment holding one idling car
 * must not outvote the 150 m of stopped queue behind it.
 */
export function causeShares(frame: MetricsFrame, segments: Int32Array): CauseShare[] {
  const weighted = new Float64Array(CAUSE_COUNT);
  let total = 0;
  for (const i of segments) {
    const delay = frame.delayVehS[i] as number;
    if (!(delay > 0)) continue;
    const base = i * CAUSE_COUNT;
    for (const code of DELAY_CAUSE_CODES) {
      const share = frame.causeShare[base + code] as number;
      if (!(share > 0)) continue;
      const w = share * delay;
      weighted[code] = (weighted[code] as number) + w;
      total += w;
    }
  }
  if (!(total > 0)) return [];
  const out: CauseShare[] = [];
  for (let k = 0; k < DELAY_CAUSE_KEYS.length; k++) {
    const code = DELAY_CAUSE_CODES[k] as number;
    const w = weighted[code] as number;
    if (!(w > 0)) continue;
    out.push({ cause: DELAY_CAUSE_KEYS[k] as CauseKey, share: w / total });
  }
  // Descending share, ties broken by the fixed cause order so that the list is deterministic.
  out.sort((a, b) => b.share - a.share);
  return out.slice(0, MAX_CAUSES);
}

/** The cause the recommendation table keys on: the largest share, or undefined when nothing stands out. */
export function dominantCause(causes: readonly CauseShare[]): CauseKey | undefined {
  return causes[0]?.cause;
}
