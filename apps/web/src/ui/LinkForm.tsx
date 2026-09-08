import type { Network, NetworkOverride, Scenario } from "@atl/contracts";
import { useState } from "react";
import { ru } from "../i18n/ru.ts";
import { findOverride } from "../state/scenarios.ts";
import { useStore } from "../state/store.ts";

type LinkOverrideSet = Extract<NetworkOverride, { kind: "link" }>["set"];

/** minutes-of-day (0..1440) <-> "HH:MM" for the bus lane hour inputs. */
function minToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMin(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

interface FormState {
  generalLanes: number;
  speedLimitKph: number;
  leftPocketLengthM: number;
  rightPocketLengthM: number;
  busLaneEnabled: boolean;
  busLaneFromMin: number;
  busLaneToMin: number;
  busLaneEntryM: number;
}

/**
 * Reads the link's current shape from the network for the form's initial values (docs/tasks/T-24
 * п.2), then layers `override` (this link's *already-saved* override in the active scenario, if
 * any) on top field by field. Without this, reopening the form for a link the active scenario
 * already overrides - while that scenario hasn't been run yet, so `network` is still the
 * unmodified baseline - would show the network's pre-override values and silently replace the
 * saved override with them on the next "Применить".
 */
function initialState(
  network: Network,
  linkId: string,
  override: LinkOverrideSet | undefined,
): FormState {
  const link = network.links.find((l) => l.id === linkId);
  const lanes = network.lanes.filter((l) => l.linkId === linkId);
  const leftPocket = lanes.find((l) => l.kind === "turn_pocket" && l.turns.includes("left"));
  const rightPocket = lanes.find(
    (l) => l.kind === "turn_pocket" && l !== leftPocket && l.turns.includes("right"),
  );
  const busLane = lanes.find((l) => l.kind === "bus");
  const generalLanes = lanes.filter((l) => l !== leftPocket && l !== rightPocket && l !== busLane);
  const lengthM = link?.lengthM ?? 0;

  const networkBusLaneEnabled = busLane !== undefined;
  const busLaneEnabled =
    override?.busLane === null
      ? false
      : override?.busLane !== undefined
        ? true
        : networkBusLaneEnabled;

  return {
    generalLanes: override?.generalLanes ?? Math.max(1, generalLanes.length),
    speedLimitKph: override?.speedLimitKph ?? link?.speedLimitKph ?? 60,
    leftPocketLengthM:
      override?.leftPocketLengthM ?? (leftPocket ? Math.round(lengthM - leftPocket.startS) : 0),
    rightPocketLengthM:
      override?.rightPocketLengthM ?? (rightPocket ? Math.round(lengthM - rightPocket.startS) : 0),
    busLaneEnabled,
    busLaneFromMin: override?.busLane?.activeFromMin ?? busLane?.busLane?.activeFromMin ?? 0,
    busLaneToMin: override?.busLane?.activeToMin ?? busLane?.busLane?.activeToMin ?? 1440,
    busLaneEntryM:
      override?.busLane?.carsMayEnterForRightTurnWithinM ??
      busLane?.busLane?.carsMayEnterForRightTurnWithinM ??
      50,
  };
}

interface LinkFormProps {
  scenario: Scenario;
  linkId: string;
  network: Network;
}

/** Form for one link's overrides (docs/tasks/T-24 п.2: "клик по линку"). Re-mounted (fresh state)
 * whenever the selected link changes - see ScenariosTab's `key={selection.id}`. */
export function LinkForm({ scenario, linkId, network }: LinkFormProps) {
  const link = network.links.find((l) => l.id === linkId);
  const upsertOverride = useStore((s) => s.upsertOverrideInActiveScenario);
  const removeOverride = useStore((s) => s.removeOverrideFromActiveScenario);
  const existingOverride = findOverride(scenario, "link", linkId);
  const [form, setForm] = useState<FormState>(() =>
    initialState(
      network,
      linkId,
      existingOverride?.kind === "link" ? existingOverride.set : undefined,
    ),
  );

  if (link === undefined) return null;
  const hasOverride = existingOverride !== undefined;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const apply = (): void => {
    const override: NetworkOverride = {
      kind: "link",
      linkId,
      set: {
        generalLanes: form.generalLanes,
        speedLimitKph: form.speedLimitKph,
        leftPocketLengthM: form.leftPocketLengthM,
        rightPocketLengthM: form.rightPocketLengthM,
        busLane: form.busLaneEnabled
          ? {
              activeFromMin: form.busLaneFromMin,
              activeToMin: form.busLaneToMin,
              carsMayEnterForRightTurnWithinM: form.busLaneEntryM,
            }
          : null,
      },
    };
    upsertOverride(override);
  };

  return (
    <div className="entity-form">
      <h4>{ru.linkFormTitle(link.name ?? link.id)}</h4>

      <label className="param-row">
        <span>
          {ru.linkFormGeneralLanes}: {form.generalLanes}
        </span>
        <input
          type="range"
          min={1}
          max={6}
          step={1}
          value={form.generalLanes}
          onChange={(e) => set("generalLanes", Number(e.target.value))}
        />
      </label>

      <label className="param-row">
        <span>{ru.linkFormSpeedLimit}</span>
        <input
          type="number"
          min={5}
          step={5}
          value={form.speedLimitKph}
          onChange={(e) => set("speedLimitKph", Number(e.target.value))}
        />
      </label>

      <label className="param-row">
        <span>{ru.linkFormLeftPocket}</span>
        <input
          type="number"
          min={0}
          step={10}
          value={form.leftPocketLengthM}
          onChange={(e) => set("leftPocketLengthM", Number(e.target.value))}
        />
      </label>

      <label className="param-row">
        <span>{ru.linkFormRightPocket}</span>
        <input
          type="number"
          min={0}
          step={10}
          value={form.rightPocketLengthM}
          onChange={(e) => set("rightPocketLengthM", Number(e.target.value))}
        />
      </label>

      <label className="param-row param-row-checkbox">
        <input
          type="checkbox"
          checked={form.busLaneEnabled}
          onChange={(e) => set("busLaneEnabled", e.target.checked)}
        />
        <span>{ru.linkFormBusLane}</span>
      </label>

      {form.busLaneEnabled && (
        <div className="bus-lane-fields">
          <label className="param-row">
            <span>{ru.linkFormBusLaneFrom}</span>
            <input
              type="time"
              value={minToTime(form.busLaneFromMin)}
              onChange={(e) => set("busLaneFromMin", timeToMin(e.target.value))}
            />
          </label>
          <label className="param-row">
            <span>{ru.linkFormBusLaneTo}</span>
            <input
              type="time"
              value={minToTime(form.busLaneToMin)}
              onChange={(e) => set("busLaneToMin", timeToMin(e.target.value))}
            />
          </label>
          <label className="param-row">
            <span>{ru.linkFormBusLaneEntry}</span>
            <input
              type="number"
              min={0}
              step={10}
              value={form.busLaneEntryM}
              onChange={(e) => set("busLaneEntryM", Number(e.target.value))}
            />
          </label>
        </div>
      )}

      <div className="entity-form-actions">
        <button type="button" className="apply-restart-btn" onClick={apply}>
          {ru.applyOverride}
        </button>
        {hasOverride && (
          <button
            type="button"
            className="reset-override-btn"
            onClick={() => removeOverride("link", linkId)}
          >
            {ru.resetOverride}
          </button>
        )}
      </div>
    </div>
  );
}
