/**
 * T-19: the candidate groups the detector ranks. Topology only -- how a link is cut into "approach"
 * and "середина линка", which lanes end up in which group, and where each group drains to.
 */
import { defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import {
  approachDirectionRu,
  buildCandidates,
  GROUP_SEGMENTS_PER_LANE,
} from "../../src/detector/candidates.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { crossroads, straightRoad } from "../fixtures/builders.ts";

function groupsOf(network: Parameters<typeof createSimulation>[0]["network"]) {
  const sim = createSimulation({ network, config: defaultSimConfig({ seed: 1 }) });
  const k = kernelOf(sim);
  return { sim, groups: buildCandidates(network, k.runtime, k.segmentIndex) };
}

describe("detector candidates", () => {
  it("splits a link into the approach in front of the node and the rest of the link", () => {
    const network = straightRoad({ lengthM: 1000, lanes: 2 });
    const { sim, groups } = groupsOf(network);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const approach = byId.get("l0:n1");
    const mid = byId.get("l0:mid");
    expect(approach).toBeDefined();
    expect(mid).toBeDefined();
    if (approach === undefined || mid === undefined) return;

    // 1000 m / 25 m = 40 segments per lane, 2 lanes: the last six of each go into the approach.
    expect(approach.segments.length).toBe(2 * GROUP_SEGMENTS_PER_LANE);
    expect(mid.segments.length).toBe(2 * 40 - approach.segments.length);
    expect(approach.laneOffsets.length).toBe(3); // two lanes plus the closing offset
    expect(approach.nodeId).toBe("n1");
    expect(mid.nodeId).toBeUndefined();

    // Together they cover every segment of the link exactly once.
    const all = new Set([...approach.segments, ...mid.segments]);
    expect(all.size).toBe(sim.segments().length);
  });

  it("treats a link that only feeds a gate as downstream-free and a mid-link group as draining into its own approach", () => {
    const network = straightRoad({ lengthM: 500, lanes: 1 });
    const { groups } = groupsOf(network);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const approach = byId.get("l0:n1");
    const mid = byId.get("l0:mid");
    expect(approach?.downstream).toEqual([]); // nothing past the gate
    expect(mid?.downstream.map((d) => d.linkId)).toEqual(["l0"]);
    expect(mid?.downstream[0]?.segments).toEqual(approach?.segments);
  });

  it("lists every exit link of a signalized approach as a downstream stretch", () => {
    const network = crossroads({ leftPocketM: 60 });
    const { groups } = groupsOf(network);
    const approach = groups.find((g) => g.id === "N.in:center");
    expect(approach).toBeDefined();
    // The north approach turns left onto the east exit, goes straight to the south exit and turns
    // right onto the west exit.
    expect(approach?.downstream.map((d) => d.linkId).sort()).toEqual(["E.out", "S.out", "W.out"]);
    // The 60 m pocket only reaches back two segments, so it contributes fewer than six.
    const laneRuns = (approach?.laneOffsets.length ?? 1) - 1;
    expect(laneRuns).toBe(3); // pocket + two through lanes
    expect(approach?.segments.length).toBeLessThan(3 * GROUP_SEGMENTS_PER_LANE);
  });

  it("names the direction an approach comes from the way the compiler does", () => {
    const network = crossroads();
    expect(approachDirectionRu(network, "N.in")).toBe("севера");
    expect(approachDirectionRu(network, "S.in")).toBe("юга");
    expect(approachDirectionRu(network, "E.in")).toBe("востока");
    expect(approachDirectionRu(network, "W.in")).toBe("запада");
  });

  it("puts the focus of an approach on its stop line", () => {
    const network = crossroads({ armLengthM: 300 });
    const { groups } = groupsOf(network);
    const north = groups.find((g) => g.id === "N.in:center");
    expect(north).toBeDefined();
    if (north === undefined) return;
    // The north arm runs down the +y axis into the junction box; the stop line is the link end,
    // one carriageway to the left of the arm axis (the two directions are separate links).
    expect(Math.abs(north.focus[0])).toBeLessThan(12);
    expect(north.focus[1]).toBeGreaterThan(0);
    expect(north.focus[1]).toBeLessThan(60);
    // ...and nowhere near the gate the approach starts at.
    expect(north.focus[1]).toBeLessThan(300);
  });
});
