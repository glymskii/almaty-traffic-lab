import type { Phase, SignalTiming } from "@atl/contracts";
import type { NodeMovements } from "../compiler/movements.ts";
import { signedAngleDeg } from "../geometry/angles.ts";
import { type ApproachPlan, AXIS_OPPOSITE_MIN_DEG, type GroupPlan } from "./groups.ts";
import { arrowGreenS, type PhaseDemand, pedestrianGreenS, websterPlan } from "./webster.ts";

/** One street of the node: two opposite arms, or a single arm that has no partner. */
export interface Axis {
  /** Neighbour ids of the arms, ascending. */
  armNeighbourIds: string[];
  approaches: ApproachPlan[];
  /** Largest flow ratio among the approaches; decides both the phase order and the split. */
  criticalY: number;
}

/**
 * Arms grouped into axes (card T-08 §1): two arms more than 150 deg apart are one street, an arm
 * without such a partner is an axis of its own — that is what turns a T-junction into "main
 * street, then the stem" instead of one phase per approach.
 */
export function buildAxes(movements: NodeMovements, plans: readonly ApproachPlan[]): Axis[] {
  const arms = movements.arms;
  const partner = new Map<string, string>();
  const taken = new Set<string>();
  for (const arm of arms) {
    if (taken.has(arm.neighbourId)) continue;
    let best: string | undefined;
    let bestAngle = AXIS_OPPOSITE_MIN_DEG;
    for (const other of arms) {
      if (other.neighbourId === arm.neighbourId || taken.has(other.neighbourId)) continue;
      const angle = Math.abs(signedAngleDeg(arm.direction, other.direction));
      if (angle > bestAngle) {
        best = other.neighbourId;
        bestAngle = angle;
      }
    }
    taken.add(arm.neighbourId);
    if (best === undefined) continue;
    taken.add(best);
    partner.set(arm.neighbourId, best);
    partner.set(best, arm.neighbourId);
  }

  const axes: Axis[] = [];
  const placed = new Set<string>();
  for (const arm of arms) {
    if (placed.has(arm.neighbourId)) continue;
    const ids = [arm.neighbourId];
    const other = partner.get(arm.neighbourId);
    if (other !== undefined) ids.push(other);
    ids.sort();
    for (const id of ids) placed.add(id);
    const approaches = plans.filter((p) => ids.includes(p.neighbourId));
    let criticalY = 0;
    for (const p of approaches) criticalY = Math.max(criticalY, p.flowRatio);
    axes.push({ armNeighbourIds: ids, approaches, criticalY });
  }
  // Busiest street first, then a stable tie-break so the plan does not depend on arm order.
  axes.sort((a, b) => {
    if (b.criticalY !== a.criticalY) return b.criticalY - a.criticalY;
    const ax = a.armNeighbourIds[0] ?? "";
    const bx = b.armNeighbourIds[0] ?? "";
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
  return axes;
}

/** A phase before Webster has given it a length. */
interface PhaseDraft {
  kind: "through" | "arrow" | "pedestrian";
  greenGroupIds: string[];
  criticalY: number;
  /** Pedestrian-only phase: crossing time, known before the cycle is. */
  pedestrianGreenS?: number;
}

export interface PhasePlan {
  phases: Phase[];
  cycleS: number;
  /** Σy of the phases that took part in Webster's split, for the compile report. */
  flowRatioSum: number;
}

/**
 * Phase order (card T-08 §1): per axis, the protected lefts of that axis first, then its through
 * and right movements together with the pedestrian groups of the *other* axes — a zebra across an
 * arm is parallel to the traffic of the streets that do not use that arm. A node whose arms make
 * up a single axis (a degree-2 pedestrian signal, a bend with a light) gets one vehicle phase.
 * Pedestrian groups that no vehicle phase can carry get a dedicated phase at the end.
 */
export function buildPhases(
  movements: NodeMovements,
  groups: GroupPlan,
  timing: SignalTiming,
): PhasePlan {
  const axes = buildAxes(movements, groups.approaches).filter((ax) => ax.approaches.length > 0);
  // One phase per axis; a node with a single axis serves both its directions at once.
  const bundles: Axis[][] =
    axes.length <= 1 ? (axes.length === 0 ? [] : [axes]) : axes.map((a) => [a]);
  const drafts: PhaseDraft[] = [];
  const greened = new Set<string>();

  for (const bundle of bundles) {
    const armIds = new Set(bundle.flatMap((ax) => ax.armNeighbourIds));
    const approaches = bundle.flatMap((ax) => ax.approaches);
    const arrowIds = approaches
      .map((p) => p.arrow?.id)
      .filter((id): id is string => id !== undefined);
    if (arrowIds.length > 0) {
      drafts.push({ kind: "arrow", greenGroupIds: arrowIds, criticalY: 0 });
      for (const id of arrowIds) greened.add(id);
    }
    const mainIds = approaches
      .map((p) => p.main?.id)
      .filter((id): id is string => id !== undefined);
    // A protected_permissive left also runs during the main green: same arrow, permissive service.
    for (const p of approaches)
      if (p.leftTurnMode === "protected_permissive" && p.arrow !== undefined)
        mainIds.push(p.arrow.id);
    const pedIds = groups.pedestrians
      .filter((p) => !armIds.has(p.armNeighbourId))
      .map((p) => p.group.id);
    const greenGroupIds = [...mainIds, ...pedIds];
    if (greenGroupIds.length === 0) continue;
    for (const id of greenGroupIds) greened.add(id);
    let criticalY = 0;
    for (const ax of bundle) criticalY = Math.max(criticalY, ax.criticalY);
    drafts.push({ kind: "through", greenGroupIds, criticalY });
  }

  const orphanPed = groups.pedestrians.filter((p) => !greened.has(p.group.id));
  if (orphanPed.length > 0) {
    let longest = 0;
    for (const p of orphanPed) longest = Math.max(longest, p.crosswalk.lengthM);
    drafts.push({
      kind: "pedestrian",
      greenGroupIds: orphanPed.map((p) => p.group.id),
      criticalY: 0,
      pedestrianGreenS: pedestrianGreenS(longest, timing.minGreenS),
    });
  }

  const yellowS = timing.defaultYellowS;
  const allRedS = timing.defaultAllRedS;
  // The arrow green is a share of the cycle, so Webster runs twice: once to learn the cycle,
  // once with the arrow greens fixed to a real number of seconds.
  const demands = (arrowS: number): PhaseDemand[] =>
    drafts.map((d) => {
      const fixed = d.kind === "arrow" ? arrowS : d.pedestrianGreenS;
      return {
        criticalY: d.criticalY,
        lostS: yellowS + allRedS,
        ...(fixed === undefined ? {} : { fixedGreenS: fixed }),
      };
    });
  const probe = websterPlan(demands(0), timing);
  const plan = websterPlan(demands(arrowGreenS(probe.cycleS)), timing);

  const phases: Phase[] = drafts.map((d, i) => ({
    id: `${movements.node.id}.ctrl.p${i}`,
    greenGroupIds: d.greenGroupIds,
    greenS: plan.greensS[i] ?? Math.ceil(timing.minGreenS),
    yellowS,
    allRedS,
  }));
  return { phases, cycleS: plan.cycleS, flowRatioSum: plan.flowRatioSum };
}
