import { buildNodeMovements } from "../compiler/movements.ts";
import type { CompileContext } from "../compiler/stages.ts";
import { generateController } from "./generate.ts";

export type { ControllerOptions, ControllerReport } from "./generate.ts";
export { generateController, protectedConnectorIds } from "./generate.ts";
export type { ApproachPlan, GroupPlan, PedestrianPlan } from "./groups.ts";
export {
  AXIS_OPPOSITE_MIN_DEG,
  arrowGroupId,
  buildGroups,
  controllerId,
  defaultLeftTurnMode,
  mainGroupId,
  PROTECTED_LEFT_OPPOSING_LANES,
  pedestrianGroupId,
} from "./groups.ts";
export type { Axis } from "./phases.ts";
export { buildAxes, buildPhases } from "./phases.ts";
export type { SignalOverrideSet } from "./regenerate.ts";
export { regenerateController } from "./regenerate.ts";
export {
  APPROACH_FLOW_PER_LANE_VPH,
  ARROW_GREEN_MAX_S,
  ARROW_GREEN_MIN_S,
  approachFlowVph,
  arrowGreenS,
  CLASS_FLOW_FACTOR,
  flowRatio,
  MAX_FLOW_RATIO_SUM,
  MIN_CYCLE_S,
  websterPlan,
} from "./webster.ts";

/**
 * Compiler stage "signals" (T-08): a fixed-time controller for every `signalized` node, assigning
 * `signalGroupId` and `protection` to its connectors and `signalGroupId` to its zebras. Runs after
 * intersections (T-07), which leaves those connectors as `yield` with signal-resolved conflicts.
 */
export function runSignals(ctx: CompileContext): void {
  const net = ctx.network;
  const timing = ctx.opts.config.signals;
  const byNode = buildNodeMovements(net);
  const withoutController: string[] = [];
  let saturated = 0;

  for (const node of net.nodes) {
    if (node.kind !== "signalized") continue;
    const movements = byNode.get(node.id);
    const report = generateController(net, node.id, timing, {
      ...(movements === undefined ? {} : { movements }),
    });
    if (report === undefined) {
      withoutController.push(node.id);
      continue;
    }
    if (report.flowRatioSum >= 1) saturated += 1;
    // The report counts controllers under `signal_plan_default` and the distribution of
    // left-turn handling under the four `left_turn_*_default` kinds (card T-08 §3).
    ctx.assumptions.add("signal_plan_default", report.controller.id);
    for (const [linkId, mode] of Object.entries(report.defaultLeftTurnModes))
      ctx.assumptions.add(`left_turn_${mode}_default`, linkId);
  }

  if (saturated > 0)
    ctx.warn(
      `signals: ${saturated} controller(s) are assumed saturated (sum of flow ratios >= 1); ` +
        "their cycle is capped at maxCycleS",
    );
  if (withoutController.length > 0)
    ctx.warn(
      `signals: ${withoutController.length} signalized node(s) carry no vehicle movement and got ` +
        `no controller: ${withoutController.slice(0, 5).join(", ")}`,
    );
}
