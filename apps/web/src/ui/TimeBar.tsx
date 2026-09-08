import { ru } from "../i18n/ru.ts";
import { formatClock } from "../state/format.ts";
import { SPEED_FACTORS, type SpeedFactor, type TimePresetKey, useStore } from "../state/store.ts";

const PRESET_KEYS: TimePresetKey[] = ["morning", "midday", "evening"];
const PRESET_LABELS: Record<TimePresetKey, string> = {
  morning: ru.presetMorning,
  midday: ru.presetMidday,
  evening: ru.presetEvening,
};

/** Bottom bar (docs/tasks/T-23 п.2): play/pause, speed 1x/2x/5x/10x, sim clock, time-of-day presets, restart. */
export function TimeBar() {
  const playing = useStore((s) => s.playing);
  const speedFactor = useStore((s) => s.speedFactor);
  const status = useStore((s) => s.status);
  const warmupProgress = useStore((s) => s.warmupProgress);
  const timeOfDayMinDisplay = useStore((s) => s.timeOfDayMinDisplay);
  const togglePlay = useStore((s) => s.togglePlay);
  const setSpeedFactor = useStore((s) => s.setSpeedFactor);
  const restart = useStore((s) => s.restart);
  const applyTimePreset = useStore((s) => s.applyTimePreset);

  const controlsDisabled = status !== "ready";

  return (
    <div className="time-bar-inner">
      <button
        type="button"
        onClick={togglePlay}
        disabled={controlsDisabled}
        className="time-bar-play"
      >
        {playing ? ru.pause : ru.play}
      </button>

      <div className="speed-group">
        {SPEED_FACTORS.map((factor) => (
          <button
            key={factor}
            type="button"
            className={factor === speedFactor ? "speed-btn active" : "speed-btn"}
            disabled={controlsDisabled}
            onClick={() => setSpeedFactor(factor as SpeedFactor)}
          >
            {ru.speedFactorLabel(factor)}
          </button>
        ))}
      </div>

      <span className="time-clock">
        {ru.clockLabel}: {formatClock(timeOfDayMinDisplay)}
      </span>

      <div className="preset-group">
        {PRESET_KEYS.map((preset) => (
          <button key={preset} type="button" onClick={() => applyTimePreset(preset)}>
            {PRESET_LABELS[preset]}
          </button>
        ))}
      </div>

      <button type="button" className="restart-btn" onClick={restart}>
        {ru.restart}
      </button>

      {status === "warming-up" && (
        <div
          className="warmup-bar"
          role="progressbar"
          aria-valuenow={Math.round(warmupProgress * 100)}
        >
          <span className="warmup-bar-label">
            {ru.warmupProgressLabel} {Math.round(warmupProgress * 100)}%
          </span>
          <div className="warmup-bar-track">
            <div
              className="warmup-bar-fill"
              style={{ width: `${Math.round(warmupProgress * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
