import { ru } from "../i18n/ru.ts";
import { formatFps, roundHours, roundKph, rtFactorLevel } from "../state/format.ts";
import { useStore } from "../state/store.ts";

/** Top-right overlay (docs/tasks/T-23 п.4): active/budget vehicles, rtFactor, fps, mean speed, windowed delay. */
export function Hud() {
  const vehiclesActive = useStore((s) => s.vehiclesActive);
  const vehicleCapacity = useStore((s) => s.vehicleCapacity);
  const rtFactor = useStore((s) => s.rtFactor);
  const fps = useStore((s) => s.fps);
  const report = useStore((s) => s.report);
  const status = useStore((s) => s.status);

  const level = rtFactorLevel(rtFactor);
  const meanSpeed = report ? ru.kphLabel(roundKph(report.totals.meanSpeedKph)) : ru.hudNoData;
  const delay = report ? ru.hoursLabel(roundHours(report.totals.delayPersonH)) : ru.hudNoData;

  if (status !== "ready") return null;

  return (
    <div className="hud">
      <div className="hud-row">
        <span className="hud-label">{ru.hudVehicles}</span>
        <span className="hud-value">
          {vehiclesActive} {ru.hudOfBudget} {vehicleCapacity}
        </span>
      </div>
      <div
        className={`hud-row hud-rt-${level}`}
        title={level !== "ok" ? ru.hudRtFactorHint : undefined}
      >
        <span className="hud-label">{ru.hudRtFactor}</span>
        <span className="hud-value">{rtFactor.toFixed(2)}</span>
      </div>
      <div className="hud-row">
        <span className="hud-label">{ru.hudFps}</span>
        <span className="hud-value">{formatFps(fps)}</span>
      </div>
      <div className="hud-row">
        <span className="hud-label">{ru.hudAvgSpeed}</span>
        <span className="hud-value">{meanSpeed}</span>
      </div>
      <div className="hud-row">
        <span className="hud-label">
          {ru.hudDelaySuffix} ({ru.minutesLabel(report ? Math.round(report.windowS / 60) : 0)})
        </span>
        <span className="hud-value">{delay}</span>
      </div>
    </div>
  );
}
