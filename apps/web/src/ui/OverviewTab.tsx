import { useEffect, useMemo, useState } from "react";
import { ru } from "../i18n/ru.ts";
import { computeAssumptionShares } from "../state/assumptions.ts";
import { formatShare } from "../state/format.ts";
import { type NetworkKey, useStore } from "../state/store.ts";
import { ParamsPanel } from "./ParamsPanel.tsx";

/** Focus radius (m) for the "приблизить к трафику" preset - the network's local origin is the bbox centre. */
const CLOSE_UP_RADIUS_M = 120;

const NETWORK_OPTIONS: { key: NetworkKey; label: string }[] = [
  { key: "small", label: ru.networkSmall },
  { key: "big", label: ru.networkBig },
];

/** "Обзор" tab (docs/tasks/T-23 п.1/5/6): network picker, camera presets, global params, assumption legend. */
export function OverviewTab() {
  const networkKey = useStore((s) => s.networkKey);
  const setNetworkKey = useStore((s) => s.setNetworkKey);
  const viewport = useStore((s) => s.viewport);

  // Layer switches (docs/tasks/T-27 §2). Kept as local component state, not in the global store:
  // a network switch remounts Viewport with fresh city-layer groups (default visible), and this
  // effect re-applies whatever the switches currently show onto that new `viewport` right away.
  const [buildingsVisible, setBuildingsVisible] = useState(true);
  const [greeneryVisible, setGreeneryVisible] = useState(true);
  useEffect(() => {
    if (!viewport) return;
    viewport.cityLayers.buildings.visible = buildingsVisible;
    viewport.cityLayers.greenery.visible = greeneryVisible;
  }, [viewport, buildingsVisible, greeneryVisible]);

  const shares = useMemo(
    () => (viewport ? computeAssumptionShares(viewport.network) : []),
    [viewport],
  );

  return (
    <div className="overview-tab">
      <section className="network-picker">
        <label>
          <span>{ru.networkLabel}</span>
          <select value={networkKey} onChange={(e) => setNetworkKey(e.target.value as NetworkKey)}>
            {NETWORK_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <div className="camera-buttons">
          <button
            type="button"
            disabled={!viewport}
            onClick={() => viewport?.rig.overview(viewport.network)}
          >
            {ru.cameraOverview}
          </button>
          <button
            type="button"
            disabled={!viewport}
            onClick={() => viewport?.rig.focus(0, 0, CLOSE_UP_RADIUS_M)}
          >
            {ru.cameraCloseUp}
          </button>
        </div>
      </section>

      <section className="layer-toggles">
        <h3>{ru.layersTitle}</h3>
        <label className="param-row param-row-checkbox">
          <input
            type="checkbox"
            checked={buildingsVisible}
            onChange={(e) => setBuildingsVisible(e.target.checked)}
          />
          <span>{ru.layerBuildings}</span>
        </label>
        <label className="param-row param-row-checkbox">
          <input
            type="checkbox"
            checked={greeneryVisible}
            onChange={(e) => setGreeneryVisible(e.target.checked)}
          />
          <span>{ru.layerGreenery}</span>
        </label>
      </section>

      <ParamsPanel />

      <section className="legend">
        <h3>{ru.legendTitle}</h3>
        <p className="legend-intro">{ru.legendIntro}</p>
        {shares.length === 0 ? (
          <p className="legend-empty">{ru.legendEmpty}</p>
        ) : (
          <ul className="legend-list">
            {shares.map((entry) => (
              <li key={entry.kind} className="legend-item">
                <span className="legend-item-label">{ru.assumptionKinds[entry.kind]}</span>
                <div className="legend-bar-track">
                  <div className="legend-bar-fill" style={{ width: formatShare(entry.share) }} />
                </div>
                <span className="legend-item-value">{formatShare(entry.share)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
