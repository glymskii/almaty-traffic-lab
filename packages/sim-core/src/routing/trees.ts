import type { RuntimeNetwork } from "../runtime/network.ts";
import { buildBackwardTree, LinkHeap, ROUTE_UNREACHABLE } from "./dijkstra.ts";
import type { RoutingGraph } from "./graph.ts";

/**
 * Number of perturbed copies of the static forest (T-12, "шум водителя"). Every driver is assigned
 * one copy at spawn, so two drivers with the same origin and destination do not necessarily take
 * the same street: the flow spreads over parallel routes instead of collapsing onto one.
 */
export const ROUTE_COPIES = 5;

/**
 * A forest of "next link" trees: `nextLink(copy, dest, link)` is the link a driver of tree copy
 * `copy` heading for destination `dest` takes after `link` (`ROUTE_ARRIVE` when the destination is
 * the end of `link`, `ROUTE_UNREACHABLE` when there is no path).
 *
 * Storage is one `Int32Array` of `copies * destCount * linkCount`, the layout the hot path wants
 * (one indexed read per link entry, no map, no allocation). The seeds of every destination -- the
 * links that end at its node -- are computed once in the constructor.
 */
export class RouteTrees {
  readonly copies: number;
  readonly destCount: number;
  readonly linkCount: number;

  private readonly next: Int32Array;
  private readonly dist: Float64Array;
  private readonly edgeCost: Float64Array;
  private readonly heap: LinkHeap;
  private readonly seedStart: Int32Array;
  private readonly seedCount: Int32Array;
  private readonly seedLinks: Int32Array;

  constructor(graph: RoutingGraph, rt: RuntimeNetwork, destNodes: Int32Array, copies: number) {
    this.copies = copies;
    this.destCount = destNodes.length;
    this.linkCount = graph.linkCount;
    this.next = new Int32Array(copies * this.destCount * this.linkCount);
    this.dist = new Float64Array(this.linkCount);
    this.edgeCost = new Float64Array(graph.edgeCount);
    this.heap = new LinkHeap(this.linkCount + graph.edgeCount + 1);

    this.seedStart = new Int32Array(this.destCount);
    this.seedCount = new Int32Array(this.destCount);
    const nodeToDest = new Map<number, number>();
    for (let d = 0; d < this.destCount; d++) nodeToDest.set(destNodes[d] as number, d);
    for (let l = 0; l < this.linkCount; l++) {
      const d = nodeToDest.get(rt.linkTo[l] as number);
      if (d !== undefined) this.seedCount[d] = (this.seedCount[d] as number) + 1;
    }
    let cursor = 0;
    for (let d = 0; d < this.destCount; d++) {
      this.seedStart[d] = cursor;
      cursor += this.seedCount[d] as number;
      this.seedCount[d] = 0;
    }
    this.seedLinks = new Int32Array(cursor);
    for (let l = 0; l < this.linkCount; l++) {
      const d = nodeToDest.get(rt.linkTo[l] as number);
      if (d === undefined) continue;
      const slot = (this.seedStart[d] as number) + (this.seedCount[d] as number);
      this.seedLinks[slot] = l;
      this.seedCount[d] = (this.seedCount[d] as number) + 1;
    }
    this.next.fill(ROUTE_UNREACHABLE);
  }

  /**
   * Rebuilds every tree from the given per-link cost (free-flow for the static forest, the live
   * EMA for the navigator one). `noise` is `copies * edgeCount` multipliers in [-x, +x] applied to
   * the edge costs of each copy, or null for an unperturbed single-copy forest.
   */
  rebuild(graph: RoutingGraph, linkCostS: Float64Array, noise: Float64Array | null): void {
    const edgeCount = graph.edgeCount;
    const linkCount = this.linkCount;
    for (let copy = 0; copy < this.copies; copy++) {
      const noiseBase = copy * edgeCount;
      for (let e = 0; e < edgeCount; e++) {
        const base =
          (linkCostS[graph.edgeFrom[e] as number] as number) + (graph.edgeExtraS[e] as number);
        this.edgeCost[e] = noise === null ? base : base * (1 + (noise[noiseBase + e] as number));
      }
      for (let d = 0; d < this.destCount; d++) {
        const offset = (copy * this.destCount + d) * linkCount;
        buildBackwardTree(
          graph,
          this.seedLinks,
          this.seedStart[d] as number,
          this.seedCount[d] as number,
          linkCostS,
          this.edgeCost,
          this.dist,
          this.next.subarray(offset, offset + linkCount),
          this.heap,
        );
      }
    }
  }

  nextLink(copy: number, dest: number, link: number): number {
    return this.next[(copy * this.destCount + dest) * this.linkCount + link] as number;
  }
}
