/** Pure formatting/threshold helpers for TimeBar and Hud - kept free of React so they are trivial to unit test. */

const MINUTES_PER_DAY = 1440;

/** "08:00" from minutes-since-midnight, wrapping into 0..1440 (a run can cross midnight). */
export function formatClock(timeOfDayMin: number): string {
  const wrapped = ((timeOfDayMin % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = Math.floor(wrapped % 60);
  return `${pad2(hours)}:${pad2(minutes)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** docs/tasks/T-23: "rtFactor (жёлтый < 0.8, красный < 0.5)". */
export type RtFactorLevel = "ok" | "warn" | "danger";
export function rtFactorLevel(rtFactor: number): RtFactorLevel {
  if (rtFactor < 0.5) return "danger";
  if (rtFactor < 0.8) return "warn";
  return "ok";
}

/** Rounds km/h to a whole number for the HUD (m/s stays internal per CLAUDE.md "Координаты и единицы"); unit text lives in i18n/ru.ts. */
export function roundKph(kph: number): number {
  return Math.round(kph);
}

/** Rounds hours to one decimal for the HUD's windowed delay; unit text lives in i18n/ru.ts. */
export function roundHours(hours: number): number {
  return Math.round(hours * 10) / 10;
}

export function formatFps(fps: number): string {
  return `${Math.round(fps)}`;
}

export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function roundMeters(m: number): number {
  return Math.round(m);
}

/**
 * Time-based exponential smoothing step: `previous` decays toward `next` over `tauS` (the time
 * constant, same units as `dtS`). Used against docs/tasks/T-18's review finding that
 * `delayVehS`/`delayPersonS` (and anything derived from them, like `BottleneckItem.delayVehH`/
 * `delayPersonH`) saw-tooth ±6% every `windowS / 8` - "не показывайте абсолютную задержку без
 * сглаживания" (T-25 card notes). `previous === undefined` or a non-positive `dtS` (first sample,
 * or a clock that didn't advance) snaps straight to `next` instead of smoothing from nothing.
 */
export function emaStep(
  previous: number | undefined,
  next: number,
  dtS: number,
  tauS: number,
): number {
  if (previous === undefined || dtS <= 0) return next;
  const alpha = 1 - Math.exp(-dtS / tauS);
  return previous + alpha * (next - previous);
}
