import {
  allocateMetricsFrame,
  type BottleneckItem,
  type BottleneckReport,
  losFromVc,
  type MetricsFrame,
  type Network,
  type NetworkTotals,
  type SimConfig,
} from "@atl/contracts";
import type { MetricsAccumulators } from "../metrics/accumulators.ts";
import type { SegmentIndex } from "../metrics/segments.ts";
import type { RuntimeNetwork } from "../runtime/network.ts";
import {
  aggregate,
  buildCandidates,
  type CandidateGroup,
  type GroupStats,
  stretchFlow,
} from "./candidates.ts";
import { causeShares, dominantCause } from "./explain.ts";
import {
  downstreamIsFree,
  passesLocalConditions,
  type RankedCandidate,
  rankCandidates,
  toHours,
} from "./rank.ts";
import { RecommendationContext, recommendFor } from "./recommend.ts";

/**
 * Bottleneck detector (T-19, D11, docs/ARCHITECTURE.md "Метрики и детектор").
 *
 * Built once next to the metrics window and reused by every `report()`: the candidate groups are
 * topology and never change, and the frame it folds the window into is owned by the detector, so a
 * report costs one pass over the segments plus a sort of the survivors -- not a fresh 3.5 MB frame.
 */
export class BottleneckDetector {
  private readonly seg: SegmentIndex;
  private readonly groups: CandidateGroup[];
  private readonly recommendations: RecommendationContext;
  private frame: MetricsFrame;
  /** Scratch reused across reports; `report()` allocates nothing per segment. */
  private readonly survivors: RankedCandidate[] = [];
  private readonly downstreamLinkOf = new Map<string, string>();

  constructor(net: Network, rt: RuntimeNetwork, seg: SegmentIndex, windowS: number) {
    this.seg = seg;
    this.groups = buildCandidates(net, rt, seg);
    this.recommendations = new RecommendationContext(net, rt, seg);
    this.frame = allocateMetricsFrame(seg.segmentCount, windowS);
  }

  /**
   * Ranked bottlenecks over the current window. The window is folded into the detector's own frame,
   * so the numbers here are exactly the ones `writeMetrics` hands the main thread.
   */
  run(
    cfg: SimConfig,
    simTimeS: number,
    timeOfDayMin: number,
    totals: NetworkTotals,
    window: MetricsAccumulators,
  ): BottleneckReport {
    const windowS = cfg.metrics.windowS;
    if (this.frame.windowS !== windowS) {
      this.frame = allocateMetricsFrame(this.seg.segmentCount, windowS);
    }
    const frame = this.frame;
    frame.simTimeS = simTimeS;
    frame.timeOfDayMin = timeOfDayMin;
    frame.windowS = windowS;
    frame.segmentCount = this.seg.segmentCount;
    window.write(frame);

    const thresholds = cfg.metrics.bottleneck;
    const survivors = this.survivors;
    survivors.length = 0;
    this.downstreamLinkOf.clear();
    for (const group of this.groups) {
      const stats = aggregate(frame, this.seg, group);
      // Cheapest tests first: most groups in a healthy network never come close, and only the ones
      // that do are worth walking the exits of.
      if (!passesLocalConditions(stats, thresholds)) continue;
      const downstream = this.downstreamOf(frame, group);
      if (downstream.linkId !== undefined) this.downstreamLinkOf.set(group.id, downstream.linkId);
      if (!downstreamIsFree(downstream.speedRatio, thresholds)) continue;
      survivors.push({
        group,
        stats,
        delayVehH: toHours(stats.delayVehS),
        delayPersonH: toHours(stats.delayPersonS),
      });
    }

    const ranked = rankCandidates(survivors, cfg.metrics.topN);
    // A `downstream_spillback` item points at the item that actually holds the traffic up, so the
    // ranks of every link in the report must be known before the recommendations are built.
    const rankByLinkId = new Map<string, number>();
    for (let i = 0; i < ranked.length; i++) {
      const linkId = (ranked[i] as RankedCandidate).group.linkId;
      if (!rankByLinkId.has(linkId)) rankByLinkId.set(linkId, i + 1);
    }

    const items: BottleneckItem[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i] as RankedCandidate;
      const causes = causeShares(frame, c.group.segments);
      const cause = dominantCause(causes);
      const recommendations = recommendFor(this.recommendations, {
        group: c.group,
        stats: c.stats,
        cause,
        frame,
        cfg,
        downstreamLinkId: this.downstreamLinkOf.get(c.group.id),
        rankByLinkId,
      });
      items.push(buildItem(i + 1, c, causes, recommendations));
    }

    return { simTimeS, timeOfDayMin, windowS, totals, items };
  }

  /**
   * How free the next stretch is. Among the links this group drains into, the one carrying the most
   * flow decides; a group that drains nowhere (its lanes leave the network at a gate) is downstream-
   * free by definition, otherwise the last approach before every gate would be filtered out.
   */
  private downstreamOf(
    frame: MetricsFrame,
    group: CandidateGroup,
  ): { speedRatio: number; linkId: string | undefined } {
    let bestFlow = -1;
    let best: GroupStats | undefined;
    let bestLinkId: string | undefined;
    for (const stretch of group.downstream) {
      const flow = stretchFlow(frame, stretch.segments);
      if (flow <= bestFlow) continue;
      bestFlow = flow;
      best = aggregate(frame, this.seg, stretch);
      bestLinkId = stretch.linkId;
    }
    return { speedRatio: best === undefined ? 1 : best.speedRatio, linkId: bestLinkId };
  }
}

function buildItem(
  rank: number,
  c: RankedCandidate,
  causes: ReturnType<typeof causeShares>,
  recommendations: BottleneckItem["recommendations"],
): BottleneckItem {
  const { group, stats } = c;
  return {
    rank,
    id: group.id,
    segmentIndices: Array.from(group.segments),
    linkId: group.linkId,
    ...(group.nodeId === undefined ? {} : { nodeId: group.nodeId }),
    title: group.title,
    delayVehH: c.delayVehH,
    delayPersonH: c.delayPersonH,
    speedRatio: stats.speedRatio,
    queueM: stats.queueM,
    vcRatio: stats.vcRatio,
    los: losFromVc(stats.vcRatio),
    persistence: stats.congestedShare,
    causes,
    recommendations,
    focus: [group.focus[0], group.focus[1]],
  };
}
