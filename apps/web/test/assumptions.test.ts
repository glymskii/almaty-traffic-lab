import { parseNetwork } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { computeAssumptionShares } from "../src/state/assumptions.ts";

/**
 * Minimal network exercising every category `computeAssumptionShares` derives from provenance:
 * one attribute of each kind is "default", one sibling is "osm" (or omitted), so every share
 * lands strictly between 0 and 1 and the arithmetic (not just presence) is checked.
 */
function fixtureNetwork() {
  return parseNetwork({
    meta: {
      schemaVersion: 1,
      networkId: "test",
      bboxId: "test",
      bbox: { south: 0, west: 0, north: 1, east: 1 },
      origin: { lat: 0, lon: 0 },
      generatedAt: "2026-01-01T00:00:00.000Z",
      generator: "test",
    },
    nodes: [
      { id: "n0", x: 0, y: 0, kind: "gate" },
      { id: "n1", x: 100, y: 0, kind: "junction" },
      { id: "n2", x: 200, y: 0, kind: "merge" },
    ],
    links: [
      {
        id: "lkA",
        fromNodeId: "n0",
        toNodeId: "n1",
        highwayClass: "residential",
        geometry: [
          [0, 0],
          [100, 0],
        ],
        lengthM: 100,
        speedLimitKph: 40,
        laneIds: ["lkA:0"],
        provenance: { speedLimitKph: "default", laneIds: "osm" },
      },
      {
        id: "lkB",
        fromNodeId: "n1",
        toNodeId: "n2",
        highwayClass: "residential",
        geometry: [
          [100, 0],
          [200, 0],
        ],
        lengthM: 100,
        speedLimitKph: 40,
        laneIds: ["lkB:0", "lkB:1", "lkB:2"],
        provenance: { speedLimitKph: "osm", laneIds: "default" },
      },
    ],
    lanes: [
      {
        id: "lkA:0",
        linkId: "lkA",
        index: 0,
        startS: 0,
        endS: 100,
        kind: "general",
        allowed: ["car"],
        turns: ["through"],
        provenance: { turns: "default" },
      },
      {
        id: "lkB:0",
        linkId: "lkB",
        index: 0,
        startS: 60,
        endS: 100,
        kind: "turn_pocket",
        allowed: ["car"],
        turns: ["left"],
        provenance: { turns: "osm", startS: "default" },
      },
      {
        id: "lkB:1",
        linkId: "lkB",
        index: 1,
        startS: 0,
        endS: 100,
        kind: "general",
        allowed: ["car"],
        turns: ["through"],
        provenance: { turns: "osm" },
      },
      {
        id: "lkB:2",
        linkId: "lkB",
        index: 2,
        startS: 0,
        endS: 100,
        kind: "bus",
        allowed: ["bus"],
        turns: ["through"],
        busLane: { allowed: ["bus"] },
        provenance: { turns: "osm", busLaneHours: "default" },
      },
    ],
    connectors: [
      {
        id: "cA",
        fromLaneId: "lkA:0",
        toLaneId: "lkB:1",
        viaNodeId: "n1",
        turn: "through",
        geometry: [
          [95, 0],
          [105, 0],
        ],
        lengthM: 10,
        protection: "priority",
        provenance: { protection: "default" },
      },
      {
        id: "cB",
        fromLaneId: "lkA:0",
        toLaneId: "lkB:0",
        viaNodeId: "n1",
        turn: "left",
        geometry: [
          [95, 0],
          [100, 5],
        ],
        lengthM: 10,
        protection: "yield",
      },
    ],
    crosswalks: [
      {
        id: "xw0",
        nodeId: "n1",
        geometry: [
          [95, -5],
          [95, 5],
        ],
        lengthM: 10,
        provenance: { geometry: "default" },
      },
    ],
    gates: [
      {
        id: "g0",
        nodeId: "n0",
        inLinkIds: ["lkA"],
        weightIn: 1,
        weightOut: 0,
        provenance: { weightIn: "default" },
      },
      { id: "g1", nodeId: "n2", outLinkIds: ["lkB"], weightIn: 0, weightOut: 1 },
    ],
    attractors: [
      {
        id: "a0",
        x: 50,
        y: 0,
        nodeId: "n1",
        kind: "office",
        weightIn: 1,
        weightOut: 1,
        provenance: { weightIn: "default" },
      },
    ],
  });
}

describe("computeAssumptionShares", () => {
  const shares = computeAssumptionShares(fixtureNetwork());
  const byKind = new Map(shares.map((s) => [s.kind, s]));

  it("computes a link-level share (speed limit: 1 of 2 links default)", () => {
    expect(byKind.get("speed_limit_default")).toEqual({
      kind: "speed_limit_default",
      count: 1,
      total: 2,
      share: 0.5,
    });
  });

  it("computes a link-level share (lane count: 1 of 2 links default)", () => {
    expect(byKind.get("lane_count_default")).toEqual({
      kind: "lane_count_default",
      count: 1,
      total: 2,
      share: 0.5,
    });
  });

  it("computes a lane-level share (turns: 1 of 4 lanes default)", () => {
    expect(byKind.get("turns_default")).toEqual({
      kind: "turns_default",
      count: 1,
      total: 4,
      share: 0.25,
    });
  });

  it("scopes the pocket share to turn-pocket lanes only", () => {
    expect(byKind.get("left_pocket_default")).toEqual({
      kind: "left_pocket_default",
      count: 1,
      total: 1,
      share: 1,
    });
  });

  it("scopes the bus-lane-hours share to bus lanes only", () => {
    expect(byKind.get("bus_lane_hours_default")).toEqual({
      kind: "bus_lane_hours_default",
      count: 1,
      total: 1,
      share: 1,
    });
  });

  it("scores merge nodes against their own population, not every node (no OSM-sourced merge kind exists)", () => {
    expect(byKind.get("merge_node_default")).toEqual({
      kind: "merge_node_default",
      count: 1,
      total: 1,
      share: 1,
    });
  });

  it("computes connector priority share (1 of 2 connectors default)", () => {
    expect(byKind.get("connector_priority_default")).toEqual({
      kind: "connector_priority_default",
      count: 1,
      total: 2,
      share: 0.5,
    });
  });

  it("computes crosswalk/gate/attractor shares from their single entities", () => {
    expect(byKind.get("crosswalk_default")).toEqual({
      kind: "crosswalk_default",
      count: 1,
      total: 1,
      share: 1,
    });
    expect(byKind.get("gate_weight_default")).toEqual({
      kind: "gate_weight_default",
      count: 1,
      total: 2,
      share: 0.5,
    });
    expect(byKind.get("attractor_weight_default")).toEqual({
      kind: "attractor_weight_default",
      count: 1,
      total: 1,
      share: 1,
    });
  });

  it("omits acceleration_lane_default when no lane ever gained a generated section", () => {
    expect(byKind.has("acceleration_lane_default")).toBe(false);
  });

  it("omits categories whose population is empty (e.g. a network with no gates/crosswalks)", () => {
    const bare = parseNetwork({
      meta: {
        schemaVersion: 1,
        networkId: "bare",
        bboxId: "bare",
        bbox: { south: 0, west: 0, north: 1, east: 1 },
        origin: { lat: 0, lon: 0 },
        generatedAt: "2026-01-01T00:00:00.000Z",
        generator: "test",
      },
      nodes: [
        { id: "n0", x: 0, y: 0, kind: "junction" },
        { id: "n1", x: 100, y: 0, kind: "junction" },
      ],
      links: [
        {
          id: "lkA",
          fromNodeId: "n0",
          toNodeId: "n1",
          highwayClass: "residential",
          geometry: [
            [0, 0],
            [100, 0],
          ],
          lengthM: 100,
          speedLimitKph: 40,
          laneIds: ["lkA:0"],
          provenance: { speedLimitKph: "default" },
        },
      ],
      lanes: [
        {
          id: "lkA:0",
          linkId: "lkA",
          index: 0,
          startS: 0,
          endS: 100,
          kind: "general",
          allowed: ["car"],
          turns: ["through"],
        },
      ],
      connectors: [],
    });
    const bareShares = new Map(computeAssumptionShares(bare).map((s) => [s.kind, s]));
    expect(bareShares.get("speed_limit_default")).toEqual({
      kind: "speed_limit_default",
      count: 1,
      total: 1,
      share: 1,
    });
    for (const emptyKind of [
      "left_pocket_default",
      "bus_lane_hours_default",
      "connector_priority_default",
      "crosswalk_default",
      "gate_weight_default",
      "attractor_weight_default",
    ] as const) {
      expect(bareShares.has(emptyKind)).toBe(false);
    }
  });
});
