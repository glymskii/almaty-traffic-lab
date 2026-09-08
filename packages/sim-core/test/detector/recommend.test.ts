/**
 * T-19: the "dominant cause -> scenario" table. Every entry is exercised directly, without a run:
 * the rules only depend on the network and on which cause won, so a full simulation would only make
 * the table slower to test, not better covered.
 */
import {
  allocateMetricsFrame,
  type CauseKey,
  defaultSimConfig,
  type MetricsFrame,
  type Network,
  NetworkOverrideSchema,
  type SimConfig,
} from "@atl/contracts";
import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  type CandidateGroup,
  type GroupStats,
} from "../../src/detector/candidates.ts";
import { RecommendationContext, recommendFor } from "../../src/detector/recommend.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, straightRoad } from "../fixtures/builders.ts";

const BASE_STATS: GroupStats = {
  speedRatio: 0.1,
  congestedShare: 0.9,
  queueM: 90,
  vcRatio: 0.95,
  delayVehS: 3600,
  delayPersonS: 5400,
  vehicles: 20,
};

interface Harness {
  ctx: RecommendationContext;
  frame: MetricsFrame;
  cfg: SimConfig;
  groups: Map<string, CandidateGroup>;
}

function harness(network: Network): Harness {
  const cfg = defaultSimConfig({ seed: 1 });
  const sim = createSimulation({ network, config: cfg });
  const k = kernelOf(sim);
  const groups = buildCandidates(network, k.runtime, k.segmentIndex);
  return {
    ctx: new RecommendationContext(network, k.runtime, k.segmentIndex),
    frame: allocateMetricsFrame(k.segmentIndex.segmentCount, cfg.metrics.windowS),
    cfg,
    groups: new Map(groups.map((g) => [g.id, g])),
  };
}

function ask(
  h: Harness,
  groupId: string,
  cause: CauseKey,
  stats: Partial<GroupStats> = {},
  extra: { downstreamLinkId?: string; rankByLinkId?: Map<string, number> } = {},
) {
  const group = h.groups.get(groupId);
  expect(group).toBeDefined();
  if (group === undefined) throw new Error(groupId);
  return recommendFor(h.ctx, {
    group,
    stats: { ...BASE_STATS, ...stats },
    cause,
    frame: h.frame,
    cfg: h.cfg,
    downstreamLinkId: extra.downstreamLinkId,
    rankByLinkId: extra.rankByLinkId ?? new Map<string, number>(),
  });
}

describe("detector recommendations", () => {
  it("offers a protected arrow and a ban when left-turners cannot find a gap", () => {
    const h = harness(crossroads({ leftPocketM: 0, leftTurnMode: "permissive" }));
    const recs = ask(h, "N.in:center", "gap_left_turn");
    expect(recs.map((r) => r.kind)).toEqual(["add_left_arrow", "prohibit_left_turn"]);
    const [arrow, ban] = recs;
    expect(arrow?.overrides[0]).toEqual({
      kind: "signal",
      nodeId: "center",
      set: { leftTurnModes: { "N.in": "protected" } },
    });
    expect(ban?.overrides[0]).toEqual({
      kind: "signal",
      nodeId: "center",
      set: { leftTurnModes: { "N.in": "prohibited" } },
    });
  });

  it("extends the existing pocket by 60 m on spillback", () => {
    const h = harness(crossroads({ leftPocketM: 40, leftTurnMode: "protected" }));
    const recs = ask(h, "N.in:center", "pocket_spillback");
    expect(recs.map((r) => r.kind)).toEqual(["extend_left_pocket"]);
    expect(recs[0]?.overrides[0]).toEqual({
      kind: "link",
      linkId: "N.in",
      set: { leftPocketLengthM: 100 },
    });
    expect(recs[0]?.label).toContain("100");
  });

  it("adds green to a loaded approach on red, and nothing to one that is not loaded", () => {
    const h = harness(crossroads({ cycleS: 90, greenSplitNS: 0.5 }));
    const loaded = ask(h, "N.in:center", "signal_red", { vcRatio: 1.1 });
    expect(loaded.map((r) => r.kind)).toEqual(["rebalance_green"]);
    const override = loaded[0]?.overrides[0];
    expect(override?.kind).toBe("signal");
    if (override?.kind === "signal") {
      const greens = Object.values(override.set.greenS ?? {});
      expect(greens.length).toBe(1);
      expect(greens[0] as number).toBeGreaterThan(10);
    }
    // Under the V/C floor a red light is just a red light, not a bottleneck to retime.
    expect(ask(h, "N.in:center", "signal_red", { vcRatio: 0.5 })).toEqual([]);
  });

  it("gives the arrow section its own green when the additional section is the binding constraint", () => {
    const h = harness(crossroads({ leftPocketM: 60, leftTurnMode: "protected" }));
    const recs = ask(h, "N.in:center", "arrow_off");
    expect(recs.map((r) => r.kind)).toEqual(["rebalance_green"]);
    expect(recs[0]?.label).toContain("доп. секции");
  });

  it("moves an in-lane stop into a bay when the queue is behind a dwelling bus", () => {
    const h = harness(
      straightRoad({
        lanes: 2,
        busStop: { s: 500, kind: "in_lane" },
        busRoute: { headwayPeakS: 60, headwayOffpeakS: 120 },
      }),
    );
    const recs = ask(h, "l0:n1", "behind_stopped_bus");
    expect(recs.map((r) => r.kind)).toEqual(["bus_stop_bay"]);
    expect(recs[0]?.overrides[0]).toEqual({
      kind: "bus_stop",
      stopId: "stop0",
      set: { kind: "bay" },
    });
  });

  it("narrows the hours of a bus lane that almost no bus uses", () => {
    const network = straightRoad({
      lanes: 2,
      busLane: true,
      busRoute: { headwayPeakS: 600, headwayOffpeakS: 1200 },
    });
    const h = harness(network);
    // The window saw no buses at all on the dedicated lane.
    const recs = ask(h, "l0:n1", "signal_red", { vcRatio: 0.5 });
    expect(recs.map((r) => r.kind)).toEqual(["bus_lane_hours"]);
    const override = recs[0]?.overrides[0];
    expect(override?.kind).toBe("link");
    if (override?.kind === "link") {
      expect(override.set.busLane?.activeFromMin).toBe(7 * 60);
      expect(override.set.busLane?.activeToMin).toBe(20 * 60);
    }

    // A busy dedicated lane keeps its hours.
    const busy = h.groups.get("l0:n1");
    expect(busy).toBeDefined();
    if (busy !== undefined) for (const i of busy.segments) h.frame.flow[i] = 90;
    expect(ask(h, "l0:n1", "signal_red", { vcRatio: 0.5 })).toEqual([]);
  });

  it("answers gridlock, merges and downstream jams without touching the network", () => {
    const h = harness(crossroads());
    const gridlock = ask(h, "N.in:center", "gridlock");
    expect(gridlock.map((r) => r.kind)).toEqual(["discipline_enforcement"]);
    expect(gridlock[0]?.overrides).toEqual([]);
    expect(gridlock[0]?.label).toContain("gridlockDiscipline");

    const merge = ask(h, "N.in:center", "merge_yield");
    expect(merge.map((r) => r.kind)).toEqual(["ramp_metering"]);
    expect(merge[0]?.overrides).toEqual([]);

    const spill = ask(
      h,
      "N.in:center",
      "downstream_spillback",
      {},
      {
        downstreamLinkId: "S.out",
        rankByLinkId: new Map([["S.out", 3]]),
      },
    );
    expect(spill.map((r) => r.kind)).toEqual(["none"]);
    expect(spill[0]?.label).toContain("#3");
    // Without an item to point at, the hint stays generic instead of inventing a rank.
    const orphan = ask(h, "N.in:center", "downstream_spillback", {}, { downstreamLinkId: "S.out" });
    expect(orphan[0]?.label).not.toContain("#");
  });

  it("leaves causes the table has no answer for without a recommendation", () => {
    const h = harness(crossroads());
    expect(ask(h, "N.in:center", "lane_change_wait")).toEqual([]);
    expect(ask(h, "N.in:center", "yield_priority")).toEqual([]);
  });

  it("emits overrides that the scenario schema accepts", () => {
    const h = harness(crossroads({ leftPocketM: 40, leftTurnMode: "permissive" }));
    const causes: CauseKey[] = ["gap_left_turn", "pocket_spillback", "signal_red", "arrow_off"];
    let parsed = 0;
    for (const cause of causes) {
      for (const rec of ask(h, "N.in:center", cause, { vcRatio: 1.2 })) {
        for (const override of rec.overrides) {
          expect(() => NetworkOverrideSchema.parse(override)).not.toThrow();
          parsed++;
        }
      }
    }
    expect(parsed).toBeGreaterThan(3);
  });
});
