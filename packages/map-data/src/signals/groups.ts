import type {
  Connector,
  Crosswalk,
  LeftTurnMode,
  Network,
  SignalGroup,
  SignalTiming,
} from "@atl/contracts";
import type { Approach, Arm, NodeMovements } from "../compiler/movements.ts";
import { sourceLanes } from "../compiler/movements.ts";
import { dot, normalizeVec, signedAngleDeg } from "../geometry/angles.ts";
import { approachFlowVph, flowRatio } from "./webster.ts";

/** Two arms whose directions differ by more than this form one axis (card T-08 §1). */
export const AXIS_OPPOSITE_MIN_DEG = 150;
/** A protected left is only offered when the opposing approach has at least this many through lanes. */
export const PROTECTED_LEFT_OPPOSING_LANES = 2;

export function controllerId(nodeId: string): string {
  return `${nodeId}.ctrl`;
}

/** Group ids are derived from the entity they serve, so they survive a regeneration unchanged. */
export function mainGroupId(linkId: string): string {
  return `sg.${linkId}.main`;
}

export function arrowGroupId(linkId: string): string {
  return `sg.${linkId}.arrow_left`;
}

export function pedestrianGroupId(crosswalkId: string): string {
  return `sg.${crosswalkId}.ped`;
}

/** Everything the phase builder and Webster need about one incoming link of a signalized node. */
export interface ApproachPlan {
  approach: Approach;
  linkId: string;
  /** Node at the far end of the approach; identifies the arm this approach belongs to. */
  neighbourId: string;
  leftTurnMode: LeftTurnMode;
  /** Whether the mode came from the default rule (provenance `default`) or from an override. */
  leftTurnModeIsDefault: boolean;
  /** Lanes that reach the node and may go straight on. */
  throughLanes: number;
  /** Assumed demand of the approach, veh/h. */
  flowVph: number;
  /** Webster's y = q / (s · n). */
  flowRatio: number;
  /** Absent when every movement of the approach is a protected left or a prohibited one. */
  main?: SignalGroup;
  arrow?: SignalGroup;
  /** Left connectors of a `prohibited` approach: no group, `protection: yield` (card T-08 §2). */
  prohibitedConnectorIds: string[];
}

/** Vehicle groups of one approach, main before arrow. */
export function approachGroups(plan: ApproachPlan): SignalGroup[] {
  const out: SignalGroup[] = [];
  if (plan.main !== undefined) out.push(plan.main);
  if (plan.arrow !== undefined) out.push(plan.arrow);
  return out;
}

export interface PedestrianPlan {
  crosswalk: Crosswalk;
  /** Arm the zebra lies across; pedestrians here walk parallel to the other axes. */
  armNeighbourId: string;
  group: SignalGroup;
}

/** A left turn shares the main group only while it is permissive; otherwise it gets an arrow. */
function usesArrow(mode: LeftTurnMode): boolean {
  return mode === "protected" || mode === "protected_permissive";
}

/** Arm of `movements` whose direction is more than AXIS_OPPOSITE_MIN_DEG away from `arm`. */
export function oppositeArm(arm: Arm, movements: NodeMovements): Arm | undefined {
  let best: Arm | undefined;
  let bestAngle = AXIS_OPPOSITE_MIN_DEG;
  for (const other of movements.arms) {
    if (other.neighbourId === arm.neighbourId) continue;
    const angle = Math.abs(signedAngleDeg(arm.direction, other.direction));
    if (angle > bestAngle) {
      best = other;
      bestAngle = angle;
    }
  }
  return best;
}

function armOf(movements: NodeMovements, neighbourId: string): Arm | undefined {
  return movements.arms.find((a) => a.neighbourId === neighbourId);
}

/** Lanes of an approach that reach the node and are marked for a through movement. */
export function throughLaneCount(approach: Approach): number {
  return sourceLanes(approach).filter((l) => l.turns.includes("through")).length;
}

/**
 * Default left-turn handling of an approach (card T-08 §1): no left movement at all is
 * `prohibited`; a left pocket facing an opposing approach with two or more through lanes deserves
 * a protected arrow; everything else stays permissive.
 */
export function defaultLeftTurnMode(
  approach: Approach,
  movements: NodeMovements,
  hasLeftConnector: boolean,
): LeftTurnMode {
  if (!hasLeftConnector) return "prohibited";
  const hasPocket = approach.lanes.some((l) => l.kind === "turn_pocket");
  if (!hasPocket) return "permissive";
  const arm = armOf(movements, approach.neighbourId);
  const facing = arm === undefined ? undefined : oppositeArm(arm, movements);
  if (facing === undefined) return "permissive";
  let opposingThrough = 0;
  for (const other of movements.approaches)
    if (other.neighbourId === facing.neighbourId)
      opposingThrough = Math.max(opposingThrough, throughLaneCount(other));
  return opposingThrough >= PROTECTED_LEFT_OPPOSING_LANES ? "protected" : "permissive";
}

/** Connectors of the node, grouped by the incoming link they start from, in id order. */
function connectorsByApproach(
  net: Network,
  nodeId: string,
): { byLink: Map<string, Connector[]>; all: Connector[] } {
  const linkOfLane = new Map(net.lanes.map((l) => [l.id, l.linkId] as const));
  const byLink = new Map<string, Connector[]>();
  const all: Connector[] = [];
  for (const c of net.connectors) {
    if (c.viaNodeId !== nodeId) continue;
    all.push(c);
    const linkId = linkOfLane.get(c.fromLaneId);
    if (linkId === undefined) continue;
    const list = byLink.get(linkId);
    if (list === undefined) byLink.set(linkId, [c]);
    else list.push(c);
  }
  return { byLink, all };
}

export interface GroupPlan {
  approaches: ApproachPlan[];
  pedestrians: PedestrianPlan[];
  /** All connectors of the node, in id order. */
  connectors: Connector[];
}

/**
 * Signal groups of one node (card T-08 §1): a `main` group per approach carrying through, right,
 * u-turn and — while the left is permissive — left movements, plus an `arrow_left` group when the
 * left is protected. Right turns never get an own section. Pedestrian groups are one per zebra.
 */
export function buildGroups(
  net: Network,
  movements: NodeMovements,
  timing: SignalTiming,
  forcedModes: Readonly<Record<string, LeftTurnMode>>,
  pedestrianPhase: boolean,
): GroupPlan {
  const nodeId = movements.node.id;
  const { byLink, all } = connectorsByApproach(net, nodeId);
  const approaches: ApproachPlan[] = [];
  for (const approach of movements.approaches) {
    const connectors = byLink.get(approach.link.id) ?? [];
    if (connectors.length === 0) continue;
    const left = connectors.filter((c) => c.turn === "left" || c.turn === "uturn");
    const forced = forcedModes[approach.link.id];
    const leftTurnMode =
      forced ??
      defaultLeftTurnMode(
        approach,
        movements,
        left.some((c) => c.turn === "left"),
      );
    const arrowIds = usesArrow(leftTurnMode) ? left.map((c) => c.id) : [];
    const prohibitedConnectorIds = leftTurnMode === "prohibited" ? left.map((c) => c.id) : [];
    const withArrow = new Set([...arrowIds, ...prohibitedConnectorIds]);
    const mainIds = connectors.map((c) => c.id).filter((id) => !withArrow.has(id));
    if (mainIds.length === 0 && arrowIds.length === 0) continue;
    const throughLanes = throughLaneCount(approach);
    const flowVph = approachFlowVph(approach.link.highwayClass, Math.max(1, throughLanes));
    approaches.push({
      approach,
      linkId: approach.link.id,
      neighbourId: approach.neighbourId,
      leftTurnMode,
      leftTurnModeIsDefault: forced === undefined,
      throughLanes,
      flowVph,
      flowRatio: flowRatio(flowVph, timing.saturationFlowVehPerHPerLane, Math.max(1, throughLanes)),
      ...(mainIds.length > 0
        ? {
            main: {
              id: mainGroupId(approach.link.id),
              kind: "vehicle" as const,
              section: "main" as const,
              approachLinkId: approach.link.id,
              connectorIds: mainIds,
              crosswalkIds: [],
            },
          }
        : {}),
      ...(arrowIds.length > 0
        ? {
            arrow: {
              id: arrowGroupId(approach.link.id),
              kind: "vehicle" as const,
              section: "arrow_left" as const,
              approachLinkId: approach.link.id,
              connectorIds: arrowIds,
              crosswalkIds: [],
            },
          }
        : {}),
      prohibitedConnectorIds,
    });
  }

  const pedestrians: PedestrianPlan[] = [];
  if (pedestrianPhase) {
    for (const crosswalk of net.crosswalks) {
      if (crosswalk.nodeId !== nodeId) continue;
      pedestrians.push({
        crosswalk,
        armNeighbourId: crosswalkArm(crosswalk, movements),
        group: {
          id: pedestrianGroupId(crosswalk.id),
          kind: "pedestrian",
          section: "main",
          connectorIds: [],
          crosswalkIds: [crosswalk.id],
        },
      });
    }
  }
  return { approaches, pedestrians, connectors: all };
}

/** Arm a zebra lies across: the one whose direction the zebra's midpoint follows from the node. */
function crosswalkArm(crosswalk: Crosswalk, movements: NodeMovements): string {
  const first = crosswalk.geometry[0];
  const last = crosswalk.geometry[crosswalk.geometry.length - 1];
  if (first === undefined || last === undefined) return movements.arms[0]?.neighbourId ?? "";
  const dir = normalizeVec([
    (first[0] + last[0]) / 2 - movements.node.x,
    (first[1] + last[1]) / 2 - movements.node.y,
  ]);
  let best = movements.arms[0]?.neighbourId ?? "";
  let bestDot = Number.NEGATIVE_INFINITY;
  for (const arm of movements.arms) {
    const d = dot(dir, normalizeVec(arm.direction));
    if (d > bestDot) {
      bestDot = d;
      best = arm.neighbourId;
    }
  }
  return best;
}
