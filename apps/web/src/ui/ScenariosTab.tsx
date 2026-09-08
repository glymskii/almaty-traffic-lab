import type { ChangeEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { ru } from "../i18n/ru.ts";
import {
  BASELINE_SCENARIO_ID,
  exportScenarioJson,
  ScenarioImportError,
  scenariosForNetwork,
} from "../state/scenarios.ts";
import { NETWORK_IDS, useStore } from "../state/store.ts";
import { IntersectionForm } from "./IntersectionForm.tsx";
import { LinkForm } from "./LinkForm.tsx";

/** Triggers a browser file save for the exported scenario JSON. */
function downloadJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function importErrorMessage(error: unknown): string {
  if (error instanceof ScenarioImportError) {
    return error.code === "network_mismatch"
      ? ru.scenarioImportError.networkMismatch(error.networkId ?? "?")
      : ru.scenarioImportError[error.code];
  }
  return ru.scenarioImportError.invalid_json;
}

/**
 * "Сценарии" tab (docs/tasks/T-24 п.3): scenario list with create/copy/rename/delete, the active
 * (being-edited) scenario, "Запустить" to recompile + restart with it, JSON export/import, and -
 * once a scenario is selected - the node/link form for whatever was last clicked on the map
 * (state/store.ts's `selection`, set by Viewport's click handler).
 */
export function ScenariosTab() {
  const networkKey = useStore((s) => s.networkKey);
  const networkId = NETWORK_IDS[networkKey];
  const allScenarios = useStore((s) => s.scenarios);
  const activeScenarioId = useStore((s) => s.activeScenarioId);
  const appliedScenarioId = useStore((s) => s.appliedScenarioId);
  const selection = useStore((s) => s.selection);
  const viewport = useStore((s) => s.viewport);
  const setActiveScenarioId = useStore((s) => s.setActiveScenarioId);
  const runActiveScenario = useStore((s) => s.runActiveScenario);
  const createScenario = useStore((s) => s.createScenario);
  const duplicateScenario = useStore((s) => s.duplicateScenario);
  const renameScenario = useStore((s) => s.renameScenario);
  const deleteScenario = useStore((s) => s.deleteScenario);
  const importScenario = useStore((s) => s.importScenario);

  const scenarios = useMemo(
    () => scenariosForNetwork(allScenarios, networkId),
    [allScenarios, networkId],
  );
  const active = scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0];

  const [newName, setNewName] = useState("");
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (active === undefined) return null; // scenariosForNetwork always includes baseline; unreachable

  const handleImportFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    file
      .text()
      .then((text) => {
        importScenario(text);
        setImportError(undefined);
      })
      .catch((error: unknown) => setImportError(importErrorMessage(error)));
  };

  return (
    <div className="scenarios-tab">
      <section className="scenario-list">
        <h3>{ru.scenariosTitle}</h3>
        <ul className="scenario-items">
          {scenarios.map((s) => (
            <li
              key={s.id}
              className={s.id === activeScenarioId ? "scenario-item active" : "scenario-item"}
            >
              <button
                type="button"
                className="scenario-item-name"
                onClick={() => setActiveScenarioId(s.id)}
              >
                {s.name}
              </button>
              {s.id === appliedScenarioId && (
                <span className="scenario-running-badge">{ru.scenarioRunningBadge}</span>
              )}
              {s.id !== BASELINE_SCENARIO_ID && (
                <span className="scenario-item-actions">
                  <button type="button" onClick={() => duplicateScenario(s.id, `${s.name} (2)`)}>
                    {ru.scenarioDuplicate}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const name = window.prompt(ru.scenarioRenamePrompt, s.name);
                      if (name?.trim()) renameScenario(s.id, name.trim());
                    }}
                  >
                    {ru.scenarioRename}
                  </button>
                  <button type="button" onClick={() => deleteScenario(s.id)}>
                    {ru.scenarioDelete}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="scenario-create-row">
          <input
            value={newName}
            placeholder={ru.scenarioNamePlaceholder}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            type="button"
            disabled={newName.trim().length === 0}
            onClick={() => {
              createScenario(newName.trim());
              setNewName("");
            }}
          >
            {ru.scenarioCreate}
          </button>
        </div>
      </section>

      <section className="scenario-actions">
        <button
          type="button"
          className="apply-restart-btn run-scenario-btn"
          onClick={runActiveScenario}
        >
          {ru.scenarioRun}
        </button>
        <p className="scenario-run-hint">{ru.scenarioRunHint}</p>
        <div className="scenario-io-row">
          <button
            type="button"
            onClick={() => downloadJson(`${active.id}.scenario.json`, exportScenarioJson(active))}
          >
            {ru.scenarioExport}
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            {ru.scenarioImport}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="scenario-file-input"
            onChange={handleImportFile}
          />
        </div>
        {importError !== undefined && <p className="scenario-import-error">{importError}</p>}
      </section>

      <section className="scenario-editor">
        {active.id === BASELINE_SCENARIO_ID ? (
          <p className="scenario-hint">{ru.scenarioBaselineHint}</p>
        ) : viewport === undefined ? null : selection === undefined ? (
          <p className="scenario-hint">{ru.scenarioSelectHint}</p>
        ) : selection.kind === "node" ? (
          <IntersectionForm
            key={selection.id}
            scenario={active}
            nodeId={selection.id}
            network={viewport.network}
          />
        ) : (
          <LinkForm
            key={selection.id}
            scenario={active}
            linkId={selection.id}
            network={viewport.network}
          />
        )}
      </section>
    </div>
  );
}
