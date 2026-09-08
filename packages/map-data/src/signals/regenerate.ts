import type { Network, NetworkOverride, Phase, SignalTiming } from "@atl/contracts";
import { type ControllerOptions, type ControllerReport, generateController } from "./generate.ts";
import { distributeInt } from "./webster.ts";

/** The editable part of a `signal` scenario override (contracts export the union, not the member). */
export type SignalOverrideSet = Extract<NetworkOverride, { kind: "signal" }>["set"];

/**
 * Rebuilds the plan of one node under a scenario override (card T-08 §2). `leftTurnModes` and
 * `pedestrianPhase` change the groups and phases, so the plan is generated from scratch; `cycleS`
 * then stretches the greens to that cycle, `greenS` overrides individual phases (a phase takes the
 * largest value asked for by the groups it serves) and `offsetS` shifts the cycle start.
 *
 * The result is written into `net` exactly as `generateController` writes it, so the network still
 * passes `checkNetworkIntegrity`.
 */
export function regenerateController(
  net: Network,
  nodeId: string,
  set: SignalOverrideSet,
  cfg: SignalTiming,
  opts: Omit<ControllerOptions, "leftTurnModes" | "pedestrianPhase" | "offsetS"> = {},
): ControllerReport | undefined {
  const report = generateController(net, nodeId, cfg, {
    ...opts,
    ...(set.leftTurnModes === undefined ? {} : { leftTurnModes: set.leftTurnModes }),
    ...(set.pedestrianPhase === undefined ? {} : { pedestrianPhase: set.pedestrianPhase }),
    ...(set.offsetS === undefined ? {} : { offsetS: set.offsetS }),
  });
  if (report === undefined) return undefined;
  const { controller } = report;
  if (set.cycleS !== undefined) controller.phases = scaleToCycle(controller.phases, set.cycleS);
  if (set.greenS !== undefined) controller.phases = applyGreens(controller.phases, set.greenS);
  const provenance = { ...controller.provenance };
  if (set.leftTurnModes !== undefined) provenance.leftTurnModes = "manual";
  if (set.cycleS !== undefined || set.greenS !== undefined) provenance.phases = "manual";
  if (set.offsetS !== undefined) provenance.offsetS = "manual";
  controller.provenance = provenance;
  return { ...report, cycleS: cycleOf(controller.phases) };
}

function cycleOf(phases: readonly Phase[]): number {
  let total = 0;
  for (const p of phases) total += p.greenS + p.yellowS + p.allRedS;
  return total;
}

/** Stretches the greens so the cycle becomes `cycleS`; every phase keeps at least one second. */
function scaleToCycle(phases: readonly Phase[], cycleS: number): Phase[] {
  const lost = phases.reduce((sum, p) => sum + p.yellowS + p.allRedS, 0);
  const target = Math.max(phases.length, Math.round(cycleS - lost));
  const greens = distributeInt(
    target,
    phases.map((p) => p.greenS),
    1,
  );
  return phases.map((p, i) => ({ ...p, greenS: greens[i] ?? p.greenS }));
}

/** A phase serving several groups takes the largest green asked for by any of them. */
function applyGreens(phases: readonly Phase[], greenS: Readonly<Record<string, number>>): Phase[] {
  return phases.map((phase) => {
    let wanted: number | undefined;
    for (const id of phase.greenGroupIds) {
      const value = greenS[id];
      if (value === undefined) continue;
      wanted = wanted === undefined ? value : Math.max(wanted, value);
    }
    return wanted === undefined ? { ...phase } : { ...phase, greenS: Math.max(1, wanted) };
  });
}
