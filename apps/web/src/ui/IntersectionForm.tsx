import type { LeftTurnMode, Network, NetworkOverride, Scenario } from "@atl/contracts";
import { useState } from "react";
import { ru } from "../i18n/ru.ts";
import { findOverride } from "../state/scenarios.ts";
import { useStore } from "../state/store.ts";

type SignalOverrideSet = Extract<NetworkOverride, { kind: "signal" }>["set"];

const LEFT_TURN_MODES: LeftTurnMode[] = [
  "permissive",
  "protected",
  "protected_permissive",
  "prohibited",
];

interface FormState {
  leftTurnModes: Record<string, LeftTurnMode>;
  cycleS: number;
  offsetS: number;
  pedestrianPhase: boolean;
  greenS: Record<string, number>;
}

function cycleLengthOf(controller: Network["signalControllers"][number]): number {
  return controller.phases.reduce((sum, p) => sum + p.greenS + p.yellowS + p.allRedS, 0);
}

/**
 * Reads the node's current plan for the form's initial values, then layers `override` (this
 * node's *already-saved* `signal` override in the active scenario, if any) on top field by field.
 * Without this, reopening the form for a node the active scenario already overrides - while that
 * scenario hasn't been run yet, so `network`/`controller` still reflect the unmodified baseline -
 * would show the baseline's values and silently replace the saved override with them on the next
 * "Применить" (same failure mode as `LinkForm`'s `initialState`).
 */
function initialState(
  controller: Network["signalControllers"][number],
  override: SignalOverrideSet | undefined,
): FormState {
  const leftTurnModes: Record<string, LeftTurnMode> = {
    ...controller.leftTurnModes,
    ...override?.leftTurnModes,
  };
  const greenS: Record<string, number> = {};
  for (const group of controller.groups) {
    if (group.kind !== "vehicle") continue;
    const phase = controller.phases.find((p) => p.greenGroupIds.includes(group.id));
    greenS[group.id] = phase?.greenS ?? 1;
  }
  return {
    leftTurnModes,
    cycleS: override?.cycleS ?? cycleLengthOf(controller),
    offsetS: override?.offsetS ?? controller.offsetS,
    pedestrianPhase: override?.pedestrianPhase ?? controller.pedestrianPhase,
    greenS: { ...greenS, ...override?.greenS },
  };
}

interface IntersectionFormProps {
  scenario: Scenario;
  nodeId: string;
  network: Network;
}

/** Form for one signalized node's overrides (docs/tasks/T-24 п.2: "клик по узлу signalized"). */
export function IntersectionForm({ scenario, nodeId, network }: IntersectionFormProps) {
  const node = network.nodes.find((n) => n.id === nodeId);
  const controller = network.signalControllers.find((c) => c.nodeId === nodeId);
  const upsertOverride = useStore((s) => s.upsertOverrideInActiveScenario);
  const removeOverride = useStore((s) => s.removeOverrideFromActiveScenario);
  const existingOverride = findOverride(scenario, "signal", nodeId);
  const [form, setForm] = useState<FormState>(() =>
    controller
      ? initialState(
          controller,
          existingOverride?.kind === "signal" ? existingOverride.set : undefined,
        )
      : { leftTurnModes: {}, cycleS: 60, offsetS: 0, pedestrianPhase: true, greenS: {} },
  );

  if (node === undefined) return null;
  if (node.kind !== "signalized" || controller === undefined) {
    return (
      <div className="entity-form">
        <p>{ru.notEditableNode}</p>
      </div>
    );
  }

  const approaches = network.links
    .filter((l) => l.toNodeId === nodeId)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const hasOverride = existingOverride !== undefined;

  const setLeftTurnMode = (linkId: string, mode: LeftTurnMode): void =>
    setForm((prev) => ({ ...prev, leftTurnModes: { ...prev.leftTurnModes, [linkId]: mode } }));
  const setGreenS = (groupId: string, value: number): void =>
    setForm((prev) => ({ ...prev, greenS: { ...prev.greenS, [groupId]: Math.max(1, value) } }));

  const apply = (): void => {
    const override: NetworkOverride = {
      kind: "signal",
      nodeId,
      set: {
        leftTurnModes: form.leftTurnModes,
        cycleS: form.cycleS,
        offsetS: form.offsetS,
        pedestrianPhase: form.pedestrianPhase,
        greenS: form.greenS,
      },
    };
    upsertOverride(override);
  };

  return (
    <div className="entity-form">
      <h4>{ru.intersectionFormTitle(node.name ?? node.id)}</h4>

      {approaches.map((link) => (
        <label className="param-row" key={link.id}>
          <span>
            {ru.intersectionApproach} {link.name ?? link.id}: {ru.intersectionLeftTurnMode}
          </span>
          <select
            value={form.leftTurnModes[link.id] ?? "permissive"}
            onChange={(e) => setLeftTurnMode(link.id, e.target.value as LeftTurnMode)}
          >
            {LEFT_TURN_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {ru.leftTurnModes[mode]}
              </option>
            ))}
          </select>
        </label>
      ))}

      <label className="param-row">
        <span>{ru.intersectionCycle}</span>
        <input
          type="number"
          min={20}
          step={5}
          value={form.cycleS}
          onChange={(e) => setForm((prev) => ({ ...prev, cycleS: Number(e.target.value) }))}
        />
      </label>

      <label className="param-row">
        <span>{ru.intersectionOffset}</span>
        <input
          type="number"
          min={0}
          step={1}
          value={form.offsetS}
          onChange={(e) => setForm((prev) => ({ ...prev, offsetS: Number(e.target.value) }))}
        />
      </label>

      <label className="param-row param-row-checkbox">
        <input
          type="checkbox"
          checked={form.pedestrianPhase}
          onChange={(e) => setForm((prev) => ({ ...prev, pedestrianPhase: e.target.checked }))}
        />
        <span>{ru.intersectionPedestrianPhase}</span>
      </label>

      <h5>{ru.intersectionGreenTitle}</h5>
      {controller.groups
        .filter((g) => g.kind === "vehicle")
        .map((group) => {
          const linkName =
            network.links.find((l) => l.id === group.approachLinkId)?.name ??
            group.approachLinkId ??
            group.id;
          const sectionLabel =
            group.section === "arrow_left" ? ru.sectionArrowLeft : ru.sectionMain;
          return (
            <label className="param-row" key={group.id}>
              <span>
                {linkName} ({sectionLabel})
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={form.greenS[group.id] ?? 1}
                onChange={(e) => setGreenS(group.id, Number(e.target.value))}
              />
            </label>
          );
        })}

      <div className="entity-form-actions">
        <button type="button" className="apply-restart-btn" onClick={apply}>
          {ru.applyOverride}
        </button>
        {hasOverride && (
          <button
            type="button"
            className="reset-override-btn"
            onClick={() => removeOverride("signal", nodeId)}
          >
            {ru.resetOverride}
          </button>
        )}
      </div>
    </div>
  );
}
