import type { BottleneckItem, NetworkTotals } from "@atl/contracts";

/**
 * Pure A/B comparison math (docs/tasks/T-26 п.3/5): the "Сравнение" tab's totals table and the
 * "новые/исчезнувшие/переехавшие" bottleneck lists, kept framework-free so both are unit-testable
 * against two synthetic `BottleneckReport`s without a store or a worker (see
 * apps/web/test/compareReport.test.ts).
 */

/** The subset of `NetworkTotals` the comparison table shows (docs/tasks/T-26 п.3: "задержки маш-ч
 * и чел-ч, средние скорости по классам, доля E/F"). Order here is the table's row order. */
export const TOTALS_DELTA_KEYS = [
  "delayVehH",
  "delayPersonH",
  "meanSpeedKph",
  "carMeanSpeedKph",
  "busMeanSpeedKph",
  "congestedSegmentShare",
] as const;
export type TotalsDeltaKey = (typeof TOTALS_DELTA_KEYS)[number];

export interface TotalsDeltaRow {
  key: TotalsDeltaKey;
  a: number;
  b: number;
  /** b - a; negative means B is lower than A. */
  delta: number;
}

/** One row per `TOTALS_DELTA_KEYS` entry, in that fixed order. */
export function computeTotalsDelta(a: NetworkTotals, b: NetworkTotals): TotalsDeltaRow[] {
  return TOTALS_DELTA_KEYS.map((key) => ({ key, a: a[key], b: b[key], delta: b[key] - a[key] }));
}

export interface MovedBottleneck {
  nodeId: string;
  a: BottleneckItem;
  b: BottleneckItem;
}

export interface BottleneckDiff {
  /** In B, not matched to anything in A (docs/tasks/T-26 п.3: "новые узкие места"). */
  appeared: BottleneckItem[];
  /** In A, not matched to anything in B ("исчезнувшие"). */
  disappeared: BottleneckItem[];
  /** Same node, different approach link in A vs B ("переехавшие"). */
  moved: MovedBottleneck[];
}

/**
 * Matches by `item.id` (`${linkId}:${approachNodeId ?? "mid"}`, stable across reports/scenarios -
 * docs/tasks/T-19 review, restated in this card's notes) first; whatever is left on each side is
 * then greedily paired up by matching `nodeId` with a different `linkId` ("переехавшие" - the same
 * intersection now has its worst approach elsewhere). Greedy in report order, which is fixed
 * (server-ranked by vehicle-hours) - deterministic for a given pair of reports.
 */
export function diffBottlenecks(
  a: readonly BottleneckItem[],
  b: readonly BottleneckItem[],
): BottleneckDiff {
  const idsA = new Set(a.map((item) => item.id));
  const idsB = new Set(b.map((item) => item.id));
  const onlyInA = a.filter((item) => !idsB.has(item.id));
  const onlyInB = b.filter((item) => !idsA.has(item.id));

  const usedB = new Set<string>();
  const moved: MovedBottleneck[] = [];
  const disappeared: BottleneckItem[] = [];
  for (const itemA of onlyInA) {
    const match =
      itemA.nodeId !== undefined
        ? onlyInB.find(
            (itemB) =>
              !usedB.has(itemB.id) &&
              itemB.nodeId === itemA.nodeId &&
              itemB.linkId !== itemA.linkId,
          )
        : undefined;
    if (match) {
      usedB.add(match.id);
      moved.push({ nodeId: itemA.nodeId as string, a: itemA, b: match });
    } else {
      disappeared.push(itemA);
    }
  }
  const appeared = onlyInB.filter((item) => !usedB.has(item.id));
  return { appeared, disappeared, moved };
}
