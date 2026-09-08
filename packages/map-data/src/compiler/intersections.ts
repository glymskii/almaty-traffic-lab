import { buildAttractors } from "./attractors.ts";
import { computeConflicts } from "./conflicts.ts";
import { buildConnectors } from "./connectors.ts";
import { buildCrosswalks } from "./crosswalks.ts";
import { buildGates } from "./gates.ts";
import { applyMergeProtection, applyMerges } from "./merges.ts";
import { buildNodeMovements } from "./movements.ts";
import type { CompileContext } from "./stages.ts";

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
}
