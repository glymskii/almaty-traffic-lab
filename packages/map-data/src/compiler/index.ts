import type { Network, NetworkOverride, SimConfig } from "@atl/contracts";
import type { BBoxPreset } from "../bboxes.ts";
import type { OsmSnapshot } from "../importer/index.ts";

export interface CompileOptions {
  bbox: BBoxPreset;
  snapshot: OsmSnapshot;
  /** Signal plan generator and defaults read timing constants from here. */
  config: SimConfig;
  /** Scenario overrides applied after generation. */
  overrides?: NetworkOverride[];
  /** Fixed value for meta.generatedAt so output is byte-stable across runs (tests, regression). */
  generatedAt?: string;
}

export interface CompileReport {
  network: Network;
  /** Human-readable assumptions made ("default" provenance), grouped by kind, for the UI legend and QA. */
  assumptions: { kind: string; count: number; example: string }[];
  warnings: string[];
}

/**
 * OSM snapshot -> Network. Pipeline (each stage is a task, see docs/PLAN.md):
 *   topology (T-02) -> lanes & speeds (T-02) -> intersections, connectors, conflicts, crosswalks, gates, attractors (T-07)
 *   -> signal plans (T-08) -> bus routes & stops (T-17) -> city layers (T-27) -> overrides (T-24) -> integrity check.
 */
export function compileNetwork(_opts: CompileOptions): CompileReport {
  throw new Error("not implemented: see docs/tasks/T-02-compiler-topology.md");
}

/** Re-apply scenario overrides to an already compiled network (used by the UI; must be deterministic). */
export function applyOverrides(
  _network: Network,
  _overrides: NetworkOverride[],
  _config: SimConfig,
): Network {
  throw new Error("not implemented: see docs/tasks/T-24-scenario-editor.md");
}
