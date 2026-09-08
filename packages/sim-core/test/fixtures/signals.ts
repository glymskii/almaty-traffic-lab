/**
 * Thin assembly helpers for `SignalController` fixtures. These just fill in schema defaults
 * consistently; the phase/group topology itself is decided by each builder in builders.ts.
 */

export interface GroupSpec {
  id: string;
  kind: "vehicle" | "pedestrian";
  section?: "main" | "arrow_left" | "arrow_right";
  approachLinkId?: string;
  connectorIds?: string[];
  crosswalkIds?: string[];
}

export function signalGroup(spec: GroupSpec) {
  return {
    id: spec.id,
    kind: spec.kind,
    section: spec.section ?? "main",
    approachLinkId: spec.approachLinkId,
    connectorIds: spec.connectorIds ?? [],
    crosswalkIds: spec.crosswalkIds ?? [],
  };
}

export interface PhaseSpec {
  id: string;
  greenGroupIds: string[];
  greenS: number;
  yellowS?: number;
  allRedS?: number;
}

export function signalPhase(spec: PhaseSpec) {
  return {
    id: spec.id,
    greenGroupIds: spec.greenGroupIds,
    greenS: spec.greenS,
    yellowS: spec.yellowS ?? 3,
    allRedS: spec.allRedS ?? 2,
  };
}

export function signalController(spec: {
  id: string;
  nodeId: string;
  groups: ReturnType<typeof signalGroup>[];
  phases: ReturnType<typeof signalPhase>[];
  leftTurnModes?: Record<
    string,
    "protected" | "permissive" | "protected_permissive" | "prohibited"
  >;
  offsetS?: number;
}) {
  return {
    id: spec.id,
    nodeId: spec.nodeId,
    offsetS: spec.offsetS ?? 0,
    groups: spec.groups,
    phases: spec.phases,
    leftTurnModes: spec.leftTurnModes ?? {},
    pedestrianPhase: true,
  };
}
