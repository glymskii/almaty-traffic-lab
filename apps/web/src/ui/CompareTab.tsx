import type { BottleneckItem } from "@atl/contracts";
import { useState } from "react";
import { ru } from "../i18n/ru.ts";
import {
  type BottleneckDiff,
  computeTotalsDelta,
  diffBottlenecks,
  type TotalsDeltaKey,
} from "../state/compareReport.ts";
import { formatShare, roundHours, roundKph } from "../state/format.ts";
import { BASELINE_SCENARIO_ID, scenariosForNetwork } from "../state/scenarios.ts";
import { NETWORK_IDS, useStore } from "../state/store.ts";

/** Matches BottlenecksTab.tsx's own constant - camera fly-in radius for "Показать" (docs/tasks/T-25). */
const FOCUS_RADIUS_M = 60;
/** How many rows each side's Top-N list shows - the full report already caps at `metrics.topN`. */
const TOP_N_ROWS = 5;

/** Whether a *lower* value of this metric is the improvement (delay, congestion) or a *higher* one
 * is (speed) - purely presentational (which way to colour Δ), so it lives here, not in
 * state/compareReport.ts's pure math. */
const LOWER_IS_BETTER: Record<TotalsDeltaKey, boolean> = {
  delayVehH: true,
  delayPersonH: true,
  meanSpeedKph: false,
  carMeanSpeedKph: false,
  busMeanSpeedKph: false,
  congestedSegmentShare: true,
};

function formatMetric(key: TotalsDeltaKey, value: number): string {
  switch (key) {
    case "delayVehH":
    case "delayPersonH":
      return ru.hoursLabel(roundHours(value));
    case "meanSpeedKph":
    case "carMeanSpeedKph":
    case "busMeanSpeedKph":
      return ru.kphLabel(roundKph(value));
    case "congestedSegmentShare":
      return formatShare(value);
  }
}

function deltaClass(key: TotalsDeltaKey, delta: number): string {
  if (Math.abs(delta) < 1e-9) return "compare-delta neutral";
  const improved = LOWER_IS_BETTER[key] ? delta < 0 : delta > 0;
  return improved ? "compare-delta good" : "compare-delta bad";
}

function TopNList({
  title,
  items,
  onShow,
}: {
  title: string;
  items: readonly BottleneckItem[];
  onShow: (item: BottleneckItem) => void;
}) {
  return (
    <div className="compare-topn">
      <h4 className="bottleneck-section-title">{title}</h4>
      {items.length === 0 ? (
        <p className="bottlenecks-empty">{ru.compareNoDiffItems}</p>
      ) : (
        <ul className="compare-topn-list">
          {items.slice(0, TOP_N_ROWS).map((item) => (
            <li key={item.id} className="compare-topn-row">
              <span className="bottleneck-rank">{item.rank}</span>
              <button type="button" className="compare-topn-title" onClick={() => onShow(item)}>
                {item.title}
              </button>
              <span>{ru.hoursLabel(roundHours(item.delayVehH))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DiffList({
  title,
  items,
  onShow,
}: {
  title: string;
  items: readonly BottleneckItem[];
  onShow: (item: BottleneckItem) => void;
}) {
  return (
    <div className="compare-diff-group">
      <h4 className="bottleneck-section-title">{title}</h4>
      {items.length === 0 ? (
        <p className="bottlenecks-empty">{ru.compareNoDiffItems}</p>
      ) : (
        <ul className="compare-diff-list">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className="compare-topn-title" onClick={() => onShow(item)}>
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MovedList({
  moved,
  onShow,
}: {
  moved: BottleneckDiff["moved"];
  onShow: (item: BottleneckItem) => void;
}) {
  return (
    <div className="compare-diff-group">
      <h4 className="bottleneck-section-title">{ru.compareMoved}</h4>
      {moved.length === 0 ? (
        <p className="bottlenecks-empty">{ru.compareNoDiffItems}</p>
      ) : (
        <ul className="compare-diff-list">
          {moved.map((pair) => (
            <li key={pair.b.id}>
              <button type="button" className="compare-topn-title" onClick={() => onShow(pair.b)}>
                {pair.b.title}
              </button>
              <span className="compare-moved-from">{ru.compareMovedFrom(pair.a.title)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "Сравнение" tab (docs/tasks/T-26): scenario B picker + start/stop, a totals A/B/Δ table, Top-N
 * side by side, and the appeared/disappeared/moved bottleneck lists. "A" is always whatever the
 * app's main sim is already running (`report`) - this tab only ever manages B
 * (`startComparisonWithScenario`/`stopComparison`, `state/store.ts`), which runs alongside it in a
 * second worker synchronised by `sim/abRunner.ts`.
 */
export function CompareTab() {
  const networkKey = useStore((s) => s.networkKey);
  const networkId = NETWORK_IDS[networkKey];
  const scenarios = useStore((s) => s.scenarios);
  const sim = useStore((s) => s.sim);
  const report = useStore((s) => s.report);
  const simB = useStore((s) => s.simB);
  const reportB = useStore((s) => s.reportB);
  const abStatus = useStore((s) => s.abStatus);
  const abSelected = useStore((s) => s.abSelected);
  const compareScenarioBId = useStore((s) => s.compareScenarioBId);
  const viewport = useStore((s) => s.viewport);
  const startComparisonWithScenario = useStore((s) => s.startComparisonWithScenario);
  const stopComparison = useStore((s) => s.stopComparison);
  const setAbSelected = useStore((s) => s.setAbSelected);

  const candidateScenarios = scenariosForNetwork(scenarios, networkId).filter(
    (s) => s.id !== BASELINE_SCENARIO_ID,
  );
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(
    compareScenarioBId ?? candidateScenarios[0]?.id ?? "",
  );

  const showItem = (item: BottleneckItem): void => {
    if (!viewport) return;
    if (abSelected !== "b") setAbSelected("b");
    viewport.rig.focus(item.focus[0], item.focus[1], FOCUS_RADIUS_M);
  };

  if (!sim) {
    return (
      <div className="compare-tab">
        <p className="bottlenecks-empty">{ru.compareNotReady}</p>
      </div>
    );
  }

  return (
    <div className="compare-tab">
      <p className="compare-intro">{ru.compareIntro}</p>

      <section className="compare-controls">
        <label className="compare-scenario-picker">
          <span>{ru.compareScenarioBLabel}</span>
          <select
            value={selectedScenarioId}
            onChange={(e) => setSelectedScenarioId(e.target.value)}
            disabled={candidateScenarios.length === 0}
          >
            {candidateScenarios.length === 0 && (
              <option value="">{ru.compareScenarioBPlaceholder}</option>
            )}
            {candidateScenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="apply-restart-btn"
          disabled={selectedScenarioId === ""}
          onClick={() => startComparisonWithScenario(selectedScenarioId)}
        >
          {simB === undefined ? ru.compareStart : ru.compareRestart}
        </button>
        {simB !== undefined && (
          <button type="button" onClick={stopComparison}>
            {ru.compareStop}
          </button>
        )}
      </section>

      {simB === undefined ? (
        <p className="bottlenecks-empty">{ru.compareNotStarted}</p>
      ) : abStatus !== "ready" || !reportB || !report ? (
        <p className="bottlenecks-empty">{ru.compareStarting}</p>
      ) : (
        <>
          <table className="compare-totals-table">
            <thead>
              <tr>
                <th>{ru.compareColMetric}</th>
                <th>{ru.compareColA}</th>
                <th>{ru.compareColB}</th>
                <th>{ru.compareColDelta}</th>
              </tr>
            </thead>
            <tbody>
              {computeTotalsDelta(report.totals, reportB.totals).map((row) => (
                <tr key={row.key}>
                  <td>{ru.compareMetricLabels[row.key]}</td>
                  <td>{formatMetric(row.key, row.a)}</td>
                  <td>{formatMetric(row.key, row.b)}</td>
                  <td className={deltaClass(row.key, row.delta)}>
                    {row.delta >= 0 ? "+" : ""}
                    {formatMetric(row.key, row.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="compare-topn-row-group">
            <TopNList title={ru.compareTopNTitleA} items={report.items} onShow={showItem} />
            <TopNList title={ru.compareTopNTitleB} items={reportB.items} onShow={showItem} />
          </section>

          <section className="compare-diff-section">
            <h3 className="bottleneck-section-title">{ru.compareDiffTitle}</h3>
            {(() => {
              const diff = diffBottlenecks(report.items, reportB.items);
              return (
                <>
                  <DiffList title={ru.compareAppeared} items={diff.appeared} onShow={showItem} />
                  <DiffList
                    title={ru.compareDisappeared}
                    items={diff.disappeared}
                    onShow={showItem}
                  />
                  <MovedList moved={diff.moved} onShow={showItem} />
                </>
              );
            })()}
          </section>
        </>
      )}
    </div>
  );
}
