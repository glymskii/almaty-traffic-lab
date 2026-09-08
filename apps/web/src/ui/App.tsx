import { useMemo } from "react";
import { ru } from "../i18n/ru.ts";
import { buildConfigPatch, NETWORK_IDS, type TabKey, useStore } from "../state/store.ts";
import { Viewport } from "../Viewport.tsx";
import { Hud } from "./Hud.tsx";
import { Layout } from "./Layout.tsx";
import { OverviewTab } from "./OverviewTab.tsx";
import { ScenariosTab } from "./ScenariosTab.tsx";
import { TimeBar } from "./TimeBar.tsx";
import { Tooltip } from "./Tooltip.tsx";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: ru.tabOverview },
  { key: "bottlenecks", label: ru.tabBottlenecks },
  { key: "scenarios", label: ru.tabScenarios },
  { key: "compare", label: ru.tabCompare },
];

/** The remaining two tabs are built in later tasks; T-23 wired up navigation, T-24 fills in "Сценарии". */
const STUB_TASK_ID: Partial<Record<TabKey, string>> = {
  bottlenecks: "T-25",
  compare: "T-26",
};

function SidePanel() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const stubTaskId = STUB_TASK_ID[activeTab];

  return (
    <div className="side-panel-inner">
      <div className="side-panel-title">{ru.appTitle}</div>
      <div className="tab-bar" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === activeTab}
            className={tab.key === activeTab ? "tab-btn active" : "tab-btn"}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {activeTab === "overview" && <OverviewTab />}
        {activeTab === "scenarios" && <ScenariosTab />}
        {stubTaskId !== undefined && <p className="tab-stub">{ru.comingSoon(stubTaskId)}</p>}
      </div>
    </div>
  );
}

/**
 * Top-level composition (docs/tasks/T-23): wires the store to `Viewport` and lays out the panels
 * around it. Restarting (network switch, time presets, "Перезапуск") remounts `Viewport` via
 * `key={restartToken}` instead of teaching it to hot-swap a running sim - see state/store.ts.
 */
export function App() {
  const restartToken = useStore((s) => s.restartToken);
  const networkKey = useStore((s) => s.networkKey);
  const startTimeMin = useStore((s) => s.startTimeMin);
  const runtimeParams = useStore((s) => s.runtimeParams);
  const appliedRestartParams = useStore((s) => s.appliedRestartParams);
  const scenarios = useStore((s) => s.scenarios);
  const appliedScenarioId = useStore((s) => s.appliedScenarioId);
  const bindViewport = useStore((s) => s.bindViewport);
  const setStatus = useStore((s) => s.setStatus);
  const setSelection = useStore((s) => s.setSelection);

  const configPatch = useMemo(
    () => buildConfigPatch({ startTimeMin, runtime: runtimeParams, restart: appliedRestartParams }),
    [startTimeMin, runtimeParams, appliedRestartParams],
  );
  // "baseline" (the synthetic no-overrides scenario, docs/tasks/T-24) is never in `scenarios`, so
  // this is undefined for it - Viewport then renders the network exactly as compiled, no override
  // pass at all.
  const appliedScenario = scenarios.find((s) => s.id === appliedScenarioId);

  return (
    <Layout
      viewport={
        <Viewport
          key={restartToken}
          networkId={NETWORK_IDS[networkKey]}
          configPatch={configPatch}
          scenarioOverrides={appliedScenario?.overrides}
          scenarioId={appliedScenario?.id}
          onReady={bindViewport}
          onStatus={setStatus}
          onSelect={setSelection}
        />
      }
      sidePanel={<SidePanel />}
      timeBar={<TimeBar />}
      hud={<Hud />}
      tooltip={<Tooltip />}
      attribution={<span>{ru.attribution}</span>}
    />
  );
}
