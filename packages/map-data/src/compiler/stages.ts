import type { Network } from "@atl/contracts";
import type { Projection } from "../projection.ts";
import type { AssumptionCollector } from "./assumptions.ts";
import type { CompileOptions } from "./index.ts";
import type { LinkLevel } from "./links.ts";
import type { OsmGraph } from "./osm-graph.ts";
import type { Warn } from "./tags.ts";

/** Shared state of one compilation; later stages mutate `network` in place. */
export interface CompileContext {
  opts: CompileOptions;
  projection: Projection;
  graph: OsmGraph;
  /** Draft network; validated with parseNetwork + checkNetworkIntegrity after the last stage. */
  network: Network;
  linkLevels: Record<string, LinkLevel>;
  assumptions: AssumptionCollector;
  warn: Warn;
}

export interface CompileStage {
  name: string;
  task: string;
  /** Absent until the task that owns the stage lands; the pipeline then skips it with a warning. */
  run?: (ctx: CompileContext) => void;
}

/**
 * Stages after topology + lanes (T-02). Each owning task fills in `run` by importing its module here:
 * intersections, connectors, conflicts, crosswalks, gates, attractors, merges (T-07); signal plans (T-08);
 * bus routes and stops (T-17); buildings, parks, water (T-27); scenario overrides (T-24).
 */
export const LATER_STAGES: CompileStage[] = [
  { name: "intersections", task: "T-07" },
  { name: "signals", task: "T-08" },
  { name: "transit", task: "T-17" },
  { name: "city", task: "T-27" },
  { name: "overrides", task: "T-24" },
];

export function runLaterStages(ctx: CompileContext): void {
  for (const stage of LATER_STAGES) {
    if (stage.run === undefined) {
      ctx.warn(`stage "${stage.name}" (${stage.task}) is not implemented yet; skipped`);
      continue;
    }
    stage.run(ctx);
  }
}
