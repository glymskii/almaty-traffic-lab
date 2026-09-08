import type { RoutingGraph } from "./graph.ts";

/** `nextLink[link]` when the destination is reached at the end of `link` itself. */
export const ROUTE_ARRIVE = -1;
/** `nextLink[link]` when no permitted path from `link` to the destination exists. */
export const ROUTE_UNREACHABLE = -2;

/**
 * Binary min-heap over link indices with lazy deletion (a link may be pushed several times; the
 * stale copies are dropped when popped, see `buildBackwardTree`). Allocated once and reused for
 * every tree, so building a whole forest allocates nothing.
 *
 * Ties on the key are broken by link index. Without that, two runs of the same Dijkstra could pop
 * equally distant links in a different order and produce two different (equally good) trees.
 */
export class LinkHeap {
  private readonly link: Int32Array;
  private readonly key: Float64Array;
  private size = 0;
  /** Key of the element returned by the last `pop()`. */
  poppedKey = 0;

  constructor(capacity: number) {
    this.link = new Int32Array(capacity);
    this.key = new Float64Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(link: number, key: number): void {
    let i = this.size++;
    this.link[i] = link;
    this.key[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Smallest element, or -1 when empty; its key lands in `poppedKey`. */
  pop(): number {
    if (this.size === 0) return -1;
    const top = this.link[0] as number;
    this.poppedKey = this.key[0] as number;
    this.size--;
    if (this.size > 0) {
      this.link[0] = this.link[this.size] as number;
      this.key[0] = this.key[this.size] as number;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < this.size && this.less(l, best)) best = l;
        if (r < this.size && this.less(r, best)) best = r;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const ka = this.key[a] as number;
    const kb = this.key[b] as number;
    if (ka !== kb) return ka < kb;
    return (this.link[a] as number) < (this.link[b] as number);
  }

  private swap(a: number, b: number): void {
    const l = this.link[a] as number;
    const k = this.key[a] as number;
    this.link[a] = this.link[b] as number;
    this.key[a] = this.key[b] as number;
    this.link[b] = l;
    this.key[b] = k;
  }
}

/**
 * Backward Dijkstra over `graph`, producing the "next link" tree of one destination.
 *
 * `dist[L]` is the cost of driving from the start of link `L` to the destination node; the seeds
 * are the links that end at that node, whose cost is their own traversal. Relaxation walks the
 * *incoming* edges, so one pass covers every link that can still reach the destination.
 *
 * Fills `nextLink` (`ROUTE_ARRIVE` on a seed, `ROUTE_UNREACHABLE` where no path exists) and uses
 * `dist` and `heap` as scratch. Nothing is allocated.
 */
export function buildBackwardTree(
  graph: RoutingGraph,
  seedLinks: Int32Array,
  seedStart: number,
  seedCount: number,
  linkCostS: Float64Array,
  edgeCostS: Float64Array,
  dist: Float64Array,
  nextLink: Int32Array,
  heap: LinkHeap,
): void {
  dist.fill(Number.POSITIVE_INFINITY);
  nextLink.fill(ROUTE_UNREACHABLE);
  heap.clear();
  for (let k = 0; k < seedCount; k++) {
    const l = seedLinks[seedStart + k] as number;
    const cost = linkCostS[l] as number;
    if (cost < (dist[l] as number)) {
      dist[l] = cost;
      nextLink[l] = ROUTE_ARRIVE;
      heap.push(l, cost);
    }
  }
  for (;;) {
    const l = heap.pop();
    if (l < 0) break;
    const d = heap.poppedKey;
    if (d > (dist[l] as number)) continue; // stale copy
    const start = graph.inStart[l] as number;
    const end = graph.inStart[l + 1] as number;
    for (let k = start; k < end; k++) {
      const e = graph.inEdges[k] as number;
      const from = graph.edgeFrom[e] as number;
      const cand = d + (edgeCostS[e] as number);
      if (cand < (dist[from] as number)) {
        dist[from] = cand;
        nextLink[from] = l;
        heap.push(from, cand);
      }
    }
  }
}
