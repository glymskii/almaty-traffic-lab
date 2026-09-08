import { buildAttractors } from "./attractors.ts";
import { computeConflicts } from "./conflicts.ts";
import { buildConnectors } from "./connectors.ts";
import { buildCrosswalks } from "./crosswalks.ts";
import { buildGates } from "./gates.ts";
import { applyMergeProtection, applyMerges } from "./merges.ts";
import { buildNodeMovements, type NodeMovements, sourceLanes } from "./movements.ts";
import type { CompileContext } from "./stages.ts";

/** How many dead lanes the warning names before it stops listing them. */
const DEAD_LANE_SAMPLE = 5;

/**
 * Lanes that reach a junction but received no movement: OSM marks them for a turn the node does
 * not offer (a left pocket at a node whose cross street is one-way the other way). Traffic must
 * never be steered into such a lane, so the compiler reports them for T-11 and T-25.
 */
function warnDeadLanes(byNode: ReadonlyMap<string, NodeMovements>, ctx: CompileContext): void {
  const used = new Set(ctx.network.connectors.map((c) => c.fromLaneId));
  const dead: string[] = [];
  for (const movements of byNode.values()) {
    if (movements.node.kind === "gate") continue;
    for (const approach of movements.approaches)
      for (const lane of sourceLanes(approach)) if (!used.has(lane.id)) dead.push(lane.id);
  }
  if (dead.length === 0) return;
  dead.sort();
  const sample = dead.slice(0, DEAD_LANE_SAMPLE).join(", ");
  const rest = dead.length > DEAD_LANE_SAMPLE ? `, ... (${dead.length} in total)` : "";
  ctx.warn(
    `intersections: ${dead.length} lane(s) reach a junction with no permitted movement; ` +
      `no vehicle may end up in them: ${sample}${rest}`,
  );
}

/**
 * Compiler stage "intersections" (T-07): lane-to-lane movements, conflict points and right of way,
 * merges, zebras, gates and attractors. Runs after topology and lanes (T-02) and before the signal
 * plans (T-08), which overwrite `protection` and `signalGroupId` on signalized nodes.
 */
export function runIntersections(ctx: CompileContext): void {
  const net = ctx.network;
  const byNode = buildNodeMovements(net);
  // Merges rewrite lane turns and open acceleration lanes, so they must precede the movements.
  const merges = applyMerges({ net, byNode, assumptions: ctx.assumptions, warn: ctx.warn });
  net.connectors = buildConnectors(net, byNode);
  computeConflicts({ net, byNode, linkLevels: ctx.linkLevels, assumptions: ctx.assumptions });
  applyMergeProtection(net, merges);
  net.crosswalks = buildCrosswalks({
    net,
    byNode,
    graph: ctx.graph,
    assumptions: ctx.assumptions,
  });
  net.gates = buildGates({ net, byNode, assumptions: ctx.assumptions, warn: ctx.warn });
  net.attractors = buildAttractors({
    net,
    byNode,
    snapshot: ctx.opts.snapshot,
    projection: ctx.projection,
    assumptions: ctx.assumptions,
  });
  warnDeadLanes(byNode, ctx);
}
