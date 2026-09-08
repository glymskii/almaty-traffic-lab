import type { BottleneckItem, SegmentDescriptor } from "@atl/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ru } from "../i18n/ru.ts";
import { buildHeatmapLayer, type HeatmapLayer, speedRatioToColor } from "../scene/heatmap.ts";
import { type BottleneckMarkers, buildBottleneckMarkers } from "../scene/markers.ts";
import { emaStep, formatShare, roundHours, roundMeters } from "../state/format.ts";
import { BASELINE_SCENARIO_ID } from "../state/scenarios.ts";
import { useStore } from "../state/store.ts";
import { CauseBar } from "./CauseBar.tsx";
import { Minimap } from "./Minimap.tsx";
import { Sparkline } from "./Sparkline.tsx";

/**
 * "Узкие места" tab (docs/tasks/T-25): heat-map + rank markers on the 3D scene, a sortable Top-N
 * table with cause breakdown and recommendation actions, a delay sparkline and a minimap. Reads
 * `report.items` straight from the store (docs/tasks/T-25 card notes on T-23: it is already the
 * fresh `BottleneckReport`, no separate subscription needed).
 */

const FOCUS_RADIUS_M = 60;
/** Smooths BottleneckItem.delayVehH/delayPersonH against the ±6%/`windowS/8` saw-tooth (docs/tasks/T-18 review, restated in this card's T-19 notes: "их сглаживай"). */
const DELAY_SMOOTHING_TAU_S = 90;

export type SortKey = "vehH" | "personH";

export interface DisplayBottleneckItem {
  item: BottleneckItem;
  delayVehH: number;
  delayPersonH: number;
}

interface DelayState {
  simTimeS: number;
  vehH: number;
  personH: number;
}

/**
 * Smooths each item's delay fields, keyed by the item's own stable id (`${linkId}:${approachNodeId
 * ?? "mid"}`, docs/contracts) so a rank change across polls doesn't reset the filter for an item
 * that is still there. An id missing from `previous` (new bottleneck) starts from its raw value.
 */
export function smoothBottleneckItems(
  previous: ReadonlyMap<string, DelayState>,
  items: readonly BottleneckItem[],
  simTimeS: number,
): { display: DisplayBottleneckItem[]; next: Map<string, DelayState> } {
  const next = new Map<string, DelayState>();
  const display: DisplayBottleneckItem[] = [];
  for (const item of items) {
    const prev = previous.get(item.id);
    const dtS = prev ? simTimeS - prev.simTimeS : 0;
    const vehH = prev
      ? emaStep(prev.vehH, item.delayVehH, dtS, DELAY_SMOOTHING_TAU_S)
      : item.delayVehH;
    const personH = prev
      ? emaStep(prev.personH, item.delayPersonH, dtS, DELAY_SMOOTHING_TAU_S)
      : item.delayPersonH;
    next.set(item.id, { simTimeS, vehH, personH });
    display.push({ item, delayVehH: vehH, delayPersonH: personH });
  }
  return { display, next };
}

/**
 * Client-side re-sort of the server's fixed Top-N (docs/tasks/T-19 review: `report().items` is
 * always ordered by vehicle-hours; sorting "by people" is a client-only view, not a server feature).
 * `item.rank` itself is never recomputed - it keeps meaning "rank by vehicle-hours" either way.
 */
export function sortReportItems(
  items: readonly DisplayBottleneckItem[],
  sortBy: SortKey,
): DisplayBottleneckItem[] {
  const key = sortBy === "vehH" ? "delayVehH" : "delayPersonH";
  return [...items].sort((a, b) => b[key] - a[key]);
}

function HeatmapLegend() {
  const stops = [1, 0.6, 0.3, 0];
  return (
    <div className="heatmap-legend">
      <span className="heatmap-legend-label">{ru.heatmapLegendFree}</span>
      <div className="heatmap-legend-track">
        {stops.map((ratio) => (
          <span
            key={ratio}
            className="heatmap-legend-swatch"
            style={{ background: speedRatioToColor(ratio).getStyle() }}
          />
        ))}
        <span
          className="heatmap-legend-swatch"
          style={{ background: speedRatioToColor(undefined).getStyle() }}
          title={ru.heatmapLegendNoData}
        />
      </div>
      <span className="heatmap-legend-label">{ru.heatmapLegendCongested}</span>
    </div>
  );
}

export function BottlenecksTab() {
  const report = useStore((s) => s.report);
  const viewport = useStore((s) => s.viewport);
  const createScenario = useStore((s) => s.createScenario);
  const upsertOverrideInActiveScenario = useStore((s) => s.upsertOverrideInActiveScenario);

  const [sortBy, setSortBy] = useState<SortKey>("vehH");
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [heatmapOn, setHeatmapOn] = useState(true);
  const [appliedByKey, setAppliedByKey] = useState<Record<string, string>>({});
  const [display, setDisplay] = useState<DisplayBottleneckItem[]>([]);

  const delayStateRef = useRef<Map<string, DelayState>>(new Map());
  useEffect(() => {
    if (!report) {
      setDisplay([]);
      return;
    }
    const { display: next, next: nextState } = smoothBottleneckItems(
      delayStateRef.current,
      report.items,
      report.simTimeS,
    );
    delayStateRef.current = nextState;
    setDisplay(next);
  }, [report]);

  const sorted = useMemo(() => sortReportItems(display, sortBy), [display, sortBy]);

  // --- 3D scene wiring: heat-map overlay + rank markers, one mount per Viewport instance. ---
  // `markers` is state (not a ref) so the report/selection effect below has a real, tracked
  // dependency to key off - it must re-run in the same commit `markers` is (re)created, not only
  // when `report`/`selectedId` next change (a ref wouldn't give useEffect anything to react to).
  const [markers, setMarkers] = useState<BottleneckMarkers | undefined>(undefined);
  const heatmapRef = useRef<HeatmapLayer | undefined>(undefined);
  const segmentsRef = useRef<readonly SegmentDescriptor[] | undefined>(undefined);
  const speedRatioRef = useRef<Float32Array | undefined>(undefined);
  const heatmapOnRef = useRef(heatmapOn);
  heatmapOnRef.current = heatmapOn;

  useEffect(() => {
    if (!viewport) return;
    let disposed = false;
    let heatmap: HeatmapLayer | undefined;
    let offMetrics: (() => void) | undefined;

    const newMarkers = buildBottleneckMarkers((item) => {
      setSelectedId(item.id);
      setExpandedId(item.id);
      viewport.rig.focus(item.focus[0], item.focus[1], FOCUS_RADIUS_M);
    });
    viewport.engine.scene.add(newMarkers.group);
    setMarkers(newMarkers);

    const offSimReady = viewport.onSimReady((sim) => {
      if (disposed) return;
      heatmap = buildHeatmapLayer(viewport.network, sim.stats.segments);
      heatmap.setVisible(heatmapOnRef.current);
      viewport.engine.scene.add(heatmap.mesh);
      heatmapRef.current = heatmap;
      segmentsRef.current = sim.stats.segments;
      speedRatioRef.current = new Float32Array(sim.stats.segments.length);

      // The transferable MetricsFrame buffer is handed back to the worker right after this
      // callback returns (see @atl/sim-worker's client.ts) - copy speedRatio out synchronously,
      // both for the heat-map's own recolour below and for Minimap's independent redraw timer.
      offMetrics = sim.onMetrics((frame) => {
        speedRatioRef.current?.set(frame.speedRatio);
        heatmapRef.current?.setSpeedRatios(speedRatioRef.current);
      });
    });

    return () => {
      disposed = true;
      offSimReady();
      offMetrics?.();
      viewport.engine.scene.remove(newMarkers.group);
      newMarkers.dispose();
      if (heatmap) {
        viewport.engine.scene.remove(heatmap.mesh);
        heatmap.dispose();
      }
      setMarkers(undefined);
      heatmapRef.current = undefined;
      segmentsRef.current = undefined;
      speedRatioRef.current = undefined;
    };
  }, [viewport]);

  // Rebuilds markers from the raw (server-ranked) report whenever it changes, or the selection does.
  useEffect(() => {
    markers?.update(report?.items ?? [], selectedId);
  }, [markers, report, selectedId]);

  useEffect(() => {
    heatmapRef.current?.setVisible(heatmapOn);
  }, [heatmapOn]);

  const showItem = (item: BottleneckItem): void => {
    setSelectedId(item.id);
    setExpandedId(item.id);
    viewport?.rig.focus(item.focus[0], item.focus[1], FOCUS_RADIUS_M);
  };

  const applyRecommendation = (item: BottleneckItem, recIndex: number): void => {
    const rec = item.recommendations[recIndex];
    if (!rec || rec.overrides.length === 0) return;
    if (useStore.getState().activeScenarioId === BASELINE_SCENARIO_ID) {
      createScenario(ru.bottlenecksNewScenarioName(item.title));
    }
    for (const override of rec.overrides) upsertOverrideInActiveScenario(override);
    const state = useStore.getState();
    const scenario = state.scenarios.find((s) => s.id === state.activeScenarioId);
    setAppliedByKey((prev) => ({ ...prev, [`${item.id}:${recIndex}`]: scenario?.name ?? "" }));
  };

  if (!report) {
    return (
      <div className="bottlenecks-tab">
        <p className="bottlenecks-empty">{ru.bottlenecksEmpty}</p>
      </div>
    );
  }

  return (
    <div className="bottlenecks-tab">
      <Sparkline report={report} />

      <section className="heatmap-controls">
        <label className="param-row param-row-checkbox">
          <input
            type="checkbox"
            checked={heatmapOn}
            onChange={(e) => setHeatmapOn(e.target.checked)}
          />
          <span>{ru.heatmapToggle}</span>
        </label>
        {heatmapOn && <HeatmapLegend />}
      </section>

      {sorted.length === 0 ? (
        <p className="bottlenecks-empty">{ru.bottlenecksNoItems}</p>
      ) : (
        <>
          <div className="bottlenecks-sort">
            <button
              type="button"
              className={sortBy === "vehH" ? "sort-btn active" : "sort-btn"}
              onClick={() => setSortBy("vehH")}
            >
              {ru.bottlenecksSortVehH}
            </button>
            <button
              type="button"
              className={sortBy === "personH" ? "sort-btn active" : "sort-btn"}
              onClick={() => setSortBy("personH")}
            >
              {ru.bottlenecksSortPersonH}
            </button>
          </div>

          <ul className="bottleneck-list">
            {sorted.map(({ item, delayVehH, delayPersonH }) => {
              const delayHours = sortBy === "vehH" ? delayVehH : delayPersonH;
              const expanded = expandedId === item.id;
              return (
                <li
                  key={item.id}
                  className={item.id === selectedId ? "bottleneck-row selected" : "bottleneck-row"}
                >
                  <button
                    type="button"
                    className="bottleneck-row-header"
                    onClick={() => setExpandedId(expanded ? undefined : item.id)}
                  >
                    <span className="bottleneck-rank">{item.rank}</span>
                    <span className="bottleneck-title">{item.title}</span>
                    <span className="bottleneck-delay">
                      {ru.hoursLabel(roundHours(delayHours))}
                    </span>
                    <span className={`los-badge los-${item.los}`}>
                      {item.los} · {ru.bottlenecksVcLabel} {item.vcRatio.toFixed(2)}
                    </span>
                  </button>

                  {expanded && (
                    <div className="bottleneck-row-details">
                      <div className="bottleneck-metrics-row">
                        <span>
                          {ru.bottlenecksQueueLabel}: {ru.metersLabel(roundMeters(item.queueM))}
                        </span>
                        <span>
                          {ru.bottlenecksSpeedRatioLabel}: {formatShare(item.speedRatio)}
                        </span>
                        <span>
                          {ru.bottlenecksPersistenceLabel}: {formatShare(item.persistence)}
                        </span>
                        <button type="button" className="show-btn" onClick={() => showItem(item)}>
                          {ru.bottlenecksShow}
                        </button>
                      </div>

                      <h4 className="bottleneck-section-title">{ru.bottlenecksCausesTitle}</h4>
                      <CauseBar causes={item.causes} />

                      <h4 className="bottleneck-section-title">
                        {ru.bottlenecksRecommendationsTitle}
                      </h4>
                      {item.recommendations.length === 0 ? (
                        <p className="bottlenecks-empty">{ru.bottlenecksNoRecommendations}</p>
                      ) : (
                        <ul className="recommendation-list">
                          {item.recommendations.map((rec, recIndex) => {
                            const key = `${item.id}:${recIndex}`;
                            const appliedTo = appliedByKey[key];
                            return (
                              <li key={key} className="recommendation-item">
                                <span className="recommendation-label">{rec.label}</span>
                                <div className="recommendation-actions">
                                  <button
                                    type="button"
                                    disabled={rec.overrides.length === 0}
                                    title={
                                      rec.overrides.length === 0
                                        ? ru.bottlenecksApplyDisabledHint
                                        : undefined
                                    }
                                    onClick={() => applyRecommendation(item, recIndex)}
                                  >
                                    {ru.bottlenecksApply}
                                  </button>
                                  <button
                                    type="button"
                                    className="show-btn"
                                    onClick={() => showItem(item)}
                                  >
                                    {ru.bottlenecksShow}
                                  </button>
                                </div>
                                {appliedTo !== undefined && (
                                  <p className="recommendation-applied">
                                    {ru.bottlenecksApplied(appliedTo)}
                                  </p>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <Minimap viewport={viewport} segmentsRef={segmentsRef} speedRatioRef={speedRatioRef} />
    </div>
  );
}
