import type { SimConfig } from "@atl/contracts";
import type { CandidateGroup, GroupStats } from "./candidates.ts";

/** `BottleneckThresholdsSchema` has no exported type in the frozen contracts; this is the same shape. */
export type BottleneckThresholds = SimConfig["metrics"]["bottleneck"];

const SECONDS_PER_HOUR = 3600;

/** A candidate that passed the three conditions, with the numbers it passed them on. */
export interface RankedCandidate {
  group: CandidateGroup;
  stats: GroupStats;
  delayVehH: number;
  delayPersonH: number;
}

/**
 * The first three conditions of D11, all read off the group itself: slow, persistently slow, and
 * with a real standing queue rather than a queue that blinks in and out over the window.
 */
export function passesLocalConditions(stats: GroupStats, t: BottleneckThresholds): boolean {
  return (
    stats.speedRatio < t.speedRatioMax &&
    stats.congestedShare >= t.minPersistence &&
    stats.queueM >= t.minQueueM
  );
}

/**
 * The fourth condition: the next stretch downstream is freer than the threshold. This is what
 * separates the head of a jam from the middle of one -- a stretch whose downstream is just as slow
 * is standing in someone else's queue. A group that drains nowhere (its lanes leave the network at
 * a gate) is free downstream by definition.
 */
export function downstreamIsFree(downstreamSpeedRatio: number, t: BottleneckThresholds): boolean {
  return downstreamSpeedRatio >= t.downstreamSpeedRatioMin;
}

/**
 * Ranks by vehicle-hours of delay in the window (D11). Person-hours are computed for every item as
 * well but never reorder anything: the UI sorts by people itself, and a report whose order depended
 * on a hidden switch would make two runs incomparable.
 *
 * Ties are broken by id so that two reports over the same window are byte-identical.
 */
export function rankCandidates(candidates: RankedCandidate[], topN: number): RankedCandidate[] {
  const sorted = candidates.slice().sort((a, b) => {
    if (b.delayVehH !== a.delayVehH) return b.delayVehH - a.delayVehH;
    return a.group.id < b.group.id ? -1 : a.group.id > b.group.id ? 1 : 0;
  });
  return sorted.slice(0, topN);
}

export function toHours(seconds: number): number {
  return seconds > 0 ? seconds / SECONDS_PER_HOUR : 0;
}
