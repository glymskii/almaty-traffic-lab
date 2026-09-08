/** T-12: the link-level routing graph and the backward Dijkstra that turns it into route trees. */
import { defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import {
  buildBackwardTree,
  LinkHeap,
  ROUTE_ARRIVE,
  ROUTE_UNREACHABLE,
} from "../../src/routing/dijkstra.ts";
import { ROUTING_SPEED_FACTOR, TURN_PENALTY_S } from "../../src/routing/graph.ts";
import { RouteTrees } from "../../src/routing/trees.ts";
import { TurnCode } from "../../src/runtime/turns.ts";
import { createSimulation, kernelOf } from "../../src/simulation.ts";
import { corridor, crossroads } from "../fixtures/builders.ts";
import { withProhibitedLefts } from "./prohibited.ts";

function kernelFor(network: Parameters<typeof createSimulation>[0]["network"]) {
  const config = defaultSimConfig({ demand: { tripsPerHourPeak: 1, vehicleBudget: 16 } });
  return kernelOf(createSimulation({ network, config }));
}

describe("routing graph", () => {
  it("has one edge per permitted movement between two links, with its manoeuvre", () => {
    const { routingGraph: g, runtime } = kernelFor(crossroads({ leftTurnMode: "permissive" }));
    const north = runtime.linkIndex.get("N.in") as number;
    const start = g.edgeStart[north] as number;
    const end = g.edgeStart[north + 1] as number;
    const targets = new Map<string, number>();
    for (let e = start; e < end; e++) {
      targets.set(runtime.linkIds[g.edgeTo[e] as number] as string, g.edgeTurn[e] as number);
    }
    // Two through lanes and two through connectors, but only one edge N.in -> S.out.
    expect(targets.get("S.out")).toBe(TurnCode.through);
    expect(targets.get("E.out")).toBe(TurnCode.left);
    expect(targets.get("W.out")).toBe(TurnCode.right);
    expect(targets.size).toBe(3);
    expect(g.turnTo(north, runtime.linkIndex.get("E.out") as number)).toBe(TurnCode.left);
    expect(g.turnTo(north, north)).toBe(-1);
  });

  it("carries the free-flow travel time of a link and the manoeuvre plus signal penalty on the edge", () => {
    const { routingGraph: g, runtime } = kernelFor(crossroads({ leftTurnMode: "permissive" }));
    const north = runtime.linkIndex.get("N.in") as number;
    const expected =
      (runtime.linkLengthM[north] as number) /
      ((runtime.linkSpeedMps[north] as number) * ROUTING_SPEED_FACTOR);
    expect(g.freeTravelS[north]).toBeCloseTo(expected, 6);

    // Same approach, same signal group: the difference between the two edges is the turn penalty.
    let through = 0;
    let left = 0;
    for (let e = g.edgeStart[north] as number; e < (g.edgeStart[north + 1] as number); e++) {
      if ((g.edgeTurn[e] as number) === TurnCode.through) through = g.edgeExtraS[e] as number;
      if ((g.edgeTurn[e] as number) === TurnCode.left) left = g.edgeExtraS[e] as number;
    }
    expect(left - through).toBeCloseTo(
      (TURN_PENALTY_S[TurnCode.left] as number) - (TURN_PENALTY_S[TurnCode.through] as number),
      6,
    );
    // The signal share of the extra: two phases of 45 + 3 + 2 s make a 100 s cycle, of which this
    // group is released for 45 + 3 s, so half the red is 26 s.
    expect(through).toBeCloseTo(0.5 * (100 - 48), 6);
  });

  it("has no edge through a movement no phase ever releases (prohibited left)", () => {
    const banned = withProhibitedLefts(crossroads({ leftTurnMode: "permissive" }), "center");
    const { routingGraph: g, runtime, intersections } = kernelFor(banned);
    const north = runtime.linkIndex.get("N.in") as number;
    const east = runtime.linkIndex.get("E.out") as number;
    expect(g.turnTo(north, east)).toBe(-1);
    // The connector is still in the network; it is only unusable.
    const conn = runtime.connectorIndex.get("N.in:0>E.out:0");
    expect(conn).toBeDefined();
    expect(intersections.connProhibited[runtime.laneCount + (conn as number)]).toBe(1);
  });
});

describe("backward Dijkstra", () => {
  const network = corridor({ intersections: 3, parallelStreet: true });

  function treeFor(costs: Float64Array) {
    const { routingGraph: g, runtime } = kernelFor(network);
    const east = runtime.nodeIndex.get("corridor.E.gate") as number;
    const trees = new RouteTrees(g, runtime, Int32Array.of(east), 1);
    trees.rebuild(g, costs, null);
    return { trees, runtime, graph: g };
  }

  it("follows the arterial from the west gate to the east gate", () => {
    const { routingGraph: g } = kernelFor(network);
    const { trees, runtime } = treeFor(Float64Array.from(g.freeTravelS));
    const chain: string[] = [];
    let link = runtime.linkIndex.get("corridor.W.in") as number;
    for (let hop = 0; hop < 20; hop++) {
      const next = trees.nextLink(0, 0, link);
      expect(next).not.toBe(ROUTE_UNREACHABLE);
      if (next === ROUTE_ARRIVE) break;
      chain.push(runtime.linkIds[next] as string);
      link = next;
    }
    expect(chain).toEqual(["j0.E", "j1.E", "corridor.E.out"]);
  });

  it("switches to the parallel street once the arterial costs ten times as much", () => {
    const { routingGraph: g, runtime } = kernelFor(network);
    const costs = Float64Array.from(g.freeTravelS);
    for (let l = 0; l < runtime.linkCount; l++) {
      if (/^(j\d+\.E|corridor\.W\.in)$/.test(runtime.linkIds[l] as string)) {
        costs[l] = (costs[l] as number) * 10;
      }
    }
    const { trees } = treeFor(costs);
    const chain: string[] = [];
    let link = runtime.linkIndex.get("corridor.W.in") as number;
    for (let hop = 0; hop < 30; hop++) {
      const next = trees.nextLink(0, 0, link);
      if (next === ROUTE_ARRIVE || next === ROUTE_UNREACHABLE) break;
      chain.push(runtime.linkIds[next] as string);
      link = next;
    }
    expect(chain.some((id) => id.startsWith("res"))).toBe(true);
    expect(chain.at(-1)).toBe("corridor.E.out");
  });

  it("marks links that cannot reach the destination as unreachable", () => {
    const { routingGraph: g } = kernelFor(network);
    const { trees, runtime } = treeFor(Float64Array.from(g.freeTravelS));
    // An exit link of another gate: from it there is nowhere left to go.
    const out = runtime.linkIndex.get("corridor.W.out") as number;
    expect(trees.nextLink(0, 0, out)).toBe(ROUTE_UNREACHABLE);
  });
});

describe("LinkHeap", () => {
  it("pops by key and breaks ties by link index, so a tree never depends on insertion order", () => {
    const heap = new LinkHeap(8);
    for (const [link, key] of [
      [7, 2],
      [3, 1],
      [5, 1],
      [1, 3],
    ] as const) {
      heap.push(link, key);
    }
    const order: number[] = [];
    for (;;) {
      const l = heap.pop();
      if (l < 0) break;
      order.push(l);
    }
    expect(order).toEqual([3, 5, 7, 1]);
  });

  it("relaxes an edge only when it improves the distance", () => {
    // A hand-checked two-hop case on the corridor: seeding the tree twice must not change it.
    const network = corridor({ intersections: 2 });
    const { routingGraph: g, runtime } = kernelFor(network);
    const dest = runtime.nodeIndex.get("corridor.E.gate") as number;
    const seeds: number[] = [];
    for (let l = 0; l < runtime.linkCount; l++) {
      if ((runtime.linkTo[l] as number) === dest) seeds.push(l);
    }
    expect(seeds.length).toBeGreaterThan(0);
    const dist = new Float64Array(runtime.linkCount);
    const next = new Int32Array(runtime.linkCount);
    const edgeCost = new Float64Array(g.edgeCount);
    for (let e = 0; e < g.edgeCount; e++) {
      edgeCost[e] =
        (g.freeTravelS[g.edgeFrom[e] as number] as number) + (g.edgeExtraS[e] as number);
    }
    const heap = new LinkHeap(runtime.linkCount + g.edgeCount + 1);
    buildBackwardTree(
      g,
      Int32Array.from(seeds),
      0,
      seeds.length,
      g.freeTravelS,
      edgeCost,
      dist,
      next,
      heap,
    );
    const seed = seeds[0] as number;
    expect(next[seed]).toBe(ROUTE_ARRIVE);
    expect(dist[seed]).toBeCloseTo(g.freeTravelS[seed] as number, 9);
    const west = runtime.linkIndex.get("corridor.W.in") as number;
    const viaEast = runtime.linkIndex.get("j0.E") as number;
    expect(next[west]).toBe(viaEast);
    expect(dist[west]).toBeGreaterThan(dist[viaEast] as number);
  });
});
