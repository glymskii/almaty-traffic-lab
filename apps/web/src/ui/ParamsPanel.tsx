import { ru } from "../i18n/ru.ts";
import { formatShare } from "../state/format.ts";
import { needsRestart, useStore } from "../state/store.ts";

/**
 * Global params (docs/tasks/T-23 п.3). The four runtime-safe sliders match
 * `RUNTIME_SAFE_PARAM_PATHS` exactly and apply on every change via `setParams`; the vehicle
 * budget and the bus-lane taxi toggle only take effect on "Перезапуск с новыми параметрами".
 */
export function ParamsPanel() {
  const runtimeParams = useStore((s) => s.runtimeParams);
  const draftRestartParams = useStore((s) => s.draftRestartParams);
  const appliedRestartParams = useStore((s) => s.appliedRestartParams);
  const setRuntimeParam = useStore((s) => s.setRuntimeParam);
  const setDraftRestartParam = useStore((s) => s.setDraftRestartParam);
  const restart = useStore((s) => s.restart);

  const dirty = needsRestart(appliedRestartParams, draftRestartParams);

  return (
    <section className="params-panel">
      <h3>{ru.paramsTitle}</h3>

      <label className="param-row">
        <span>
          {ru.paramDemandMultiplier}: {runtimeParams.demandMultiplier.toFixed(2)}
        </span>
        <input
          type="range"
          min={0.1}
          max={3}
          step={0.1}
          value={runtimeParams.demandMultiplier}
          onChange={(e) => setRuntimeParam("demandMultiplier", Number(e.target.value))}
        />
      </label>

      <label className="param-row">
        <span>
          {ru.paramNavigatorShare}: {formatShare(runtimeParams.navigatorShare)}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={runtimeParams.navigatorShare}
          onChange={(e) => setRuntimeParam("navigatorShare", Number(e.target.value))}
        />
      </label>

      <label className="param-row">
        <span>
          {ru.paramGridlockDiscipline}: {formatShare(runtimeParams.gridlockDiscipline)}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={runtimeParams.gridlockDiscipline}
          onChange={(e) => setRuntimeParam("gridlockDiscipline", Number(e.target.value))}
        />
      </label>

      <label className="param-row">
        <span>
          {ru.paramBusLaneViolatorShare}: {formatShare(runtimeParams.busLaneViolatorShare)}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={runtimeParams.busLaneViolatorShare}
          onChange={(e) => setRuntimeParam("busLaneViolatorShare", Number(e.target.value))}
        />
      </label>

      <hr />

      <label className="param-row">
        <span>
          {ru.paramVehicleBudget} <em className="restart-badge">{ru.restartRequiredBadge}</em>
        </span>
        <input
          type="number"
          min={1000}
          step={1000}
          value={draftRestartParams.vehicleBudget}
          onChange={(e) => setDraftRestartParam("vehicleBudget", Number(e.target.value))}
        />
      </label>

      <label className="param-row param-row-checkbox">
        <input
          type="checkbox"
          checked={draftRestartParams.taxisAllowedInBusLanes}
          onChange={(e) => setDraftRestartParam("taxisAllowedInBusLanes", e.target.checked)}
        />
        <span>
          {ru.paramTaxisInBusLanes} <em className="restart-badge">{ru.restartRequiredBadge}</em>
        </span>
      </label>

      {dirty && (
        <button type="button" className="apply-restart-btn" onClick={restart}>
          {ru.applyRestartRequired}
        </button>
      )}
    </section>
  );
}
