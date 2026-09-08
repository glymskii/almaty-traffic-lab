import type { Network } from "@atl/contracts";
import { finish } from "../fixtures/builders.ts";

const ALL = ["car", "bus", "trolleybus", "taxi"] as const;
const PT = ["bus", "trolleybus"] as const;

function meta(networkId: string) {
  return {
    schemaVersion: 1 as const,
    networkId,
    bboxId: "synthetic",
    bbox: { south: 0, west: 0, north: 0, east: 0 },
    origin: { lat: 43.24, lon: 76.92 },
    generatedAt: "2026-01-01T00:00:00Z",
    generator: "kernel-tests",
  };
}

/**
 * gate n0 -> link l0 (500 m) -> junction n1 -> connector c0 (10 m) -> link l1 (500 m) -> gate n2.
 * One lane per link. With `busOnlySecondLink` the second link admits only public transport,
 * so cars have no permitted connector and leave the network at the end of l0.
 */
export function twoLinkRoad(opts: { busOnlySecondLink?: boolean } = {}): Network {
  const allowed1 = opts.busOnlySecondLink ? PT : ALL;
  return finish({
    meta: meta("two-link-road"),
    nodes: [
      { id: "n0", x: 0, y: 0, kind: "gate" },
      { id: "n1", x: 505, y: 0, kind: "junction" },
      { id: "n2", x: 1010, y: 0, kind: "gate" },
    ],
    links: [
      {
        id: "l0",
        fromNodeId: "n0",
        toNodeId: "n1",
        highwayClass: "secondary",
        geometry: [
          [0, 0],
          [500, 0],
        ],
        lengthM: 500,
        speedLimitKph: 60,
        laneIds: ["l0:0"],
      },
      {
        id: "l1",
        fromNodeId: "n1",
        toNodeId: "n2",
        highwayClass: "secondary",
        geometry: [
          [510, 0],
          [1010, 0],
        ],
        lengthM: 500,
        speedLimitKph: 40,
        laneIds: ["l1:0"],
      },
    ],
    lanes: [
      {
        id: "l0:0",
        linkId: "l0",
        index: 0,
        startS: 0,
        endS: 500,
        kind: "general",
        allowed: ALL,
        turns: ["through"],
      },
      {
        id: "l1:0",
        linkId: "l1",
        index: 0,
        startS: 0,
        endS: 500,
        kind: opts.busOnlySecondLink ? "bus" : "general",
        allowed: allowed1,
        turns: ["through"],
        ...(opts.busOnlySecondLink ? { busLane: { allowed: PT } } : {}),
      },
    ],
    connectors: [
      {
        id: "c0",
        fromLaneId: "l0:0",
        toLaneId: "l1:0",
        viaNodeId: "n1",
        turn: "through",
        geometry: [
          [500, 0],
          [510, 0],
        ],
        lengthM: 10,
        protection: "priority",
      },
    ],
    gates: [
      { id: "g0", nodeId: "n0", inLinkIds: ["l0"], weightIn: 1, weightOut: 0 },
      { id: "g1", nodeId: "n2", outLinkIds: ["l1"], weightIn: 0, weightOut: 1 },
    ],
  });
}

/** gate -> one two-lane link that goes 500 m east and then 500 m north -> gate. */
export function bentRoad(): Network {
  return finish({
    meta: meta("bent-road"),
    nodes: [
      { id: "n0", x: 0, y: 0, kind: "gate" },
      { id: "n1", x: 500, y: 500, kind: "gate" },
    ],
    links: [
      {
        id: "l0",
        fromNodeId: "n0",
        toNodeId: "n1",
        highwayClass: "secondary",
        geometry: [
          [0, 0],
          [500, 0],
          [500, 500],
        ],
        lengthM: 1000,
        speedLimitKph: 60,
        laneIds: ["l0:0", "l0:1"],
      },
    ],
    lanes: [0, 1].map((i) => ({
      id: `l0:${i}`,
      linkId: "l0",
      index: i,
      startS: 0,
      endS: 1000,
      kind: "general",
      allowed: ALL,
      turns: ["through"],
    })),
    connectors: [],
    gates: [
      { id: "g0", nodeId: "n0", inLinkIds: ["l0"], weightIn: 1, weightOut: 0 },
      { id: "g1", nodeId: "n1", outLinkIds: ["l0"], weightIn: 0, weightOut: 1 },
    ],
  });
}
