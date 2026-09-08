import type { Connector, Link, Network, Point2 } from "@atl/contracts";
import {
  crossZ,
  dot,
  headingAtEnd,
  headingAtStart,
  normalizeVec,
  TURN_MAX_DEG,
} from "../geometry/angles.ts";
import { closestApproach, firstCrossing } from "../geometry/intersect.ts";
import { round } from "../geometry/polyline.ts";
import type { AssumptionCollector } from "./assumptions.ts";
import type { LinkLevel } from "./links.ts";
import type { NodeMovements } from "./movements.ts";
import { HIGHWAY_CLASS_RANK } from "./topology.ts";

/**
 * A left turn and the opposing through/right movement conflict by rule. When the sampled curves
 * do not actually cross (short approaches, wide medians), a closest approach below this distance
 * still counts as a conflict point.
 */
export const RULE_CONFLICT_NEAR_M = 5;

/** Headings this far apart (degrees) count as opposing directions of the same street. */
const OPPOSING_MIN_DEG = TURN_MAX_DEG;

/** Bounds on the junction box radius used to extend movements while looking for crossings. */
const BOX_RADIUS_MIN_M = 2;
const BOX_RADIUS_MAX_M = 25;

type Verdict = "this" | "other";

interface ConnectorContext {
  connector: Connector;
  approach: Link;
  heading: Point2;
  /**
   * The movement plus a stub of the approach lane and of the exit lane, each as long as the
   * junction box radius. Link centrelines run all the way to the node, so the movement itself
   * covers only the offset between lane ends; the stubs put the crossings back where they are.
   */
  path: Point2[];
  /** Distance from the start of `path` to the start of the movement. */
  sOffset: number;
  /** Vertical level of the approach: movements arriving on different levels never meet. */
  layer: number;
}

function layerOf(link: Link, levels: Record<string, LinkLevel>): number {
  return levels[link.id]?.layer ?? 0;
}

function opposing(a: ConnectorContext, b: ConnectorContext): boolean {
  return dot(a.heading, b.heading) < Math.cos((OPPOSING_MIN_DEG * Math.PI) / 180);
}

/**
 * Right of way at an unsignalized node: the major class first, then "a left turn yields to the
 * opposing through or right", then the right-hand rule, then a stable tie-break on ids so the
 * output never depends on iteration order.
 */
function resolvePriority(a: ConnectorContext, b: ConnectorContext): Verdict {
  const rankA = HIGHWAY_CLASS_RANK[a.approach.highwayClass];
  const rankB = HIGHWAY_CLASS_RANK[b.approach.highwayClass];
  if (rankA !== rankB) return rankA < rankB ? "this" : "other";
  if (opposing(a, b)) {
    const aGiving = isTurningAcross(a);
    const bGiving = isTurningAcross(b);
    if (aGiving && !bGiving) return "other";
    if (bGiving && !aGiving) return "this";
  }
  // Right-hand rule: the driver whose partner arrives from the right gives way.
  const cross = crossZ(a.heading, b.heading);
  if (Math.abs(cross) > 1e-6) return cross > 0 ? "other" : "this";
  return a.connector.id < b.connector.id ? "this" : "other";
}

function isTurningAcross(c: ConnectorContext): boolean {
  return c.connector.turn === "left" || c.connector.turn === "uturn";
}

function isStraight(c: ConnectorContext): boolean {
  return c.connector.turn === "through" || c.connector.turn === "right";
}

export interface ConflictInput {
  net: Network;
  byNode: ReadonlyMap<string, NodeMovements>;
  linkLevels: Record<string, LinkLevel>;
  assumptions: AssumptionCollector;
}

/**
 * Conflict points between the movements of one node and the resulting `protection` (card T-07 §3).
 * Movements from the same approach never conflict: they either diverge from a shared lane or run
 * side by side. Links on different levels (a flyover over a street) never conflict either.
 */
export function computeConflicts(input: ConflictInput): void {
  const { net, byNode, linkLevels } = input;
  const linkById = new Map(net.links.map((l) => [l.id, l] as const));
  const laneLink = new Map(net.lanes.map((l) => [l.id, l.linkId] as const));
  const nodeKind = new Map(net.nodes.map((n) => [n.id, n.kind] as const));

  const byNodeConnectors = new Map<string, ConnectorContext[]>();
  for (const connector of net.connectors) {
    const approach = linkById.get(laneLink.get(connector.fromLaneId) ?? "");
    const exit = linkById.get(laneLink.get(connector.toLaneId) ?? "");
    if (approach === undefined || exit === undefined) continue;
    const radius = boxRadius(byNode.get(connector.viaNodeId));
    const heading = headingAtEnd(approach.geometry);
    const ctx: ConnectorContext = {
      connector,
      approach,
      heading,
      path: extendPath(connector.geometry, heading, headingAtStart(exit.geometry), radius),
      sOffset: radius,
      layer: layerOf(approach, linkLevels),
    };
    const list = byNodeConnectors.get(connector.viaNodeId);
    if (list === undefined) byNodeConnectors.set(connector.viaNodeId, [ctx]);
    else list.push(ctx);
  }

  const mustYield = new Set<string>();
  for (const [nodeId, list] of byNodeConnectors) {
    const signalized = nodeKind.get(nodeId) === "signalized";
    for (let i = 0; i < list.length; i++) {
      const a = list[i] as ConnectorContext;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j] as ConnectorContext;
        if (a.approach.id === b.approach.id) continue;
        if (a.layer !== b.layer) continue;
        const hit = crossingOf(a, b);
        if (hit === undefined) continue;
        const verdict = resolvePriority(a, b);
        mustYield.add(verdict === "other" ? a.connector.id : b.connector.id);
        const sA = clampS(hit.sA - a.sOffset, a.connector.lengthM);
        const sB = clampS(hit.sB - b.sOffset, b.connector.lengthM);
        const priority = signalized ? "signal" : verdict;
        const mirrored = signalized ? "signal" : verdict === "this" ? "other" : "this";
        a.connector.conflicts.push({
          otherConnectorId: b.connector.id,
          sThisM: sA,
          sOtherM: sB,
          priority,
        });
        b.connector.conflicts.push({
          otherConnectorId: a.connector.id,
          sThisM: sB,
          sOtherM: sA,
          priority: mirrored,
        });
      }
    }
  }

  for (const connector of net.connectors) {
    connector.protection = mustYield.has(connector.id) ? "yield" : "priority";
    if (connector.conflicts.length > 0)
      input.assumptions.add("connector_priority_default", connector.id);
    connector.conflicts.sort((x, y) =>
      x.otherConnectorId < y.otherConnectorId
        ? -1
        : x.otherConnectorId > y.otherConnectorId
          ? 1
          : 0,
    );
  }
}

/** Half the width of the widest street meeting at the node: how far the junction box reaches. */
function boxRadius(movements: NodeMovements | undefined): number {
  let widest = 0;
  for (const arm of movements?.arms ?? []) widest = Math.max(widest, arm.widthM);
  return Math.min(Math.max(widest / 2, BOX_RADIUS_MIN_M), BOX_RADIUS_MAX_M);
}

function extendPath(
  geometry: readonly Point2[],
  inHeading: Point2,
  outHeading: Point2,
  radius: number,
): Point2[] {
  const first = geometry[0] as Point2;
  const last = geometry[geometry.length - 1] as Point2;
  const hIn = normalizeVec(inHeading);
  const hOut = normalizeVec(outHeading);
  return [
    [first[0] - hIn[0] * radius, first[1] - hIn[1] * radius],
    ...geometry.map((p) => [p[0], p[1]] as Point2),
    [last[0] + hOut[0] * radius, last[1] + hOut[1] * radius],
  ];
}

function clampS(s: number, lengthM: number): number {
  return round(Math.max(0, Math.min(s, lengthM)));
}

/** Geometric crossing, or the rule-based conflict of a left turn with the opposing traffic. */
function crossingOf(
  a: ConnectorContext,
  b: ConnectorContext,
): { sA: number; sB: number } | undefined {
  const hit = firstCrossing(a.path, b.path);
  if (hit !== undefined) return hit;
  if (!opposing(a, b)) return undefined;
  const ruled = (isTurningAcross(a) && isStraight(b)) || (isTurningAcross(b) && isStraight(a));
  if (!ruled) return undefined;
  const near = closestApproach(a.path, b.path);
  if (near === undefined || near.distM > RULE_CONFLICT_NEAR_M) return undefined;
  return { sA: near.sA, sB: near.sB };
}
