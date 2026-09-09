import { useEffect } from "react";
import { ru } from "../i18n/ru.ts";
import { formatClock } from "../state/format.ts";
import { SPEED_FACTORS, type SpeedFactor, type TimePresetKey, useStore } from "../state/store.ts";

const PRESET_KEYS: TimePresetKey[] = ["morning", "midday", "evening"];
const PRESET_LABELS: Record<TimePresetKey, string> = {
  morning: ru.presetMorning,
  midday: ru.presetMidday,
  evening: ru.presetEvening,
};

/** Form fields (ScenariosTab et al.) keep their own Tab-based focus order - only hijack the key for
 * the A/B toggle when focus isn't inside one (docs/tasks/T-26 п.2). */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.hasAttribute("contenteditable")
  );
}

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
  const simB = useStore((s) => s.simB);
  const abSelected = useStore((s) => s.abSelected);
  const abStatus = useStore((s) => s.abStatus);
  const setAbSelected = useStore((s) => s.setAbSelected);

  const controlsDisabled = status !== "ready";
  // The toggle only makes sense once B exists and has finished warming up (docs/tasks/T-26 п.1/2).
  const abReady = simB !== undefined && abStatus === "ready";

  useEffect(() => {
    if (!abReady) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // `.key` as well as `.code`: some automated/assistive input dispatches a KeyboardEvent with
      // `.key === "Tab"` but an empty `.code` (observed with this project's own browser-automation
      // tooling) - checking both keeps the shortcut working everywhere a real Tab key does.
      if ((event.code !== "Tab" && event.key !== "Tab") || isTypingTarget(document.activeElement)) {
        return;
      }
      event.preventDefault();
      setAbSelected(abSelected === "a" ? "b" : "a");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [abReady, abSelected, setAbSelected]);

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

      {simB !== undefined &&
        (abReady ? (
          <div className="ab-toggle-group" title={ru.abToggleHint}>
            <button
              type="button"
              className={abSelected === "a" ? "ab-toggle-btn active" : "ab-toggle-btn"}
              onClick={() => setAbSelected("a")}
            >
              {ru.abToggleA}
            </button>
            <button
              type="button"
              className={abSelected === "b" ? "ab-toggle-btn active" : "ab-toggle-btn"}
              onClick={() => setAbSelected("b")}
            >
              {ru.abToggleB}
            </button>
          </div>
        ) : (
          <span className="ab-toggle-starting">{ru.abStarting}</span>
        ))}

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
