/**
 * Human-readable formatting for the headless runner. Pure functions (arrays of lines) plus thin
 * `console.log`/`process.stderr.write` wrappers, so `cli/regress.ts` can reuse the formatting
 * without re-printing the whole report for every golden case.
 */
import { type BottleneckItem, CAUSES, type NetworkTotals, type RunSummary } from "@atl/contracts";

const CAUSE_RU = new Map<string, string>(CAUSES.map((c) => [c.key, c.ru]));

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

export function formatTotals(totals: NetworkTotals): string[] {
  return [
    "totals:",
    `  активных машин............ ${totals.vehiclesActive}`,
    `  завершённых поездок....... ${totals.vehiclesCompleted}`,
    `  задержка, маш-ч........... ${fmt(totals.delayVehH)}`,
    `  задержка, чел-ч........... ${fmt(totals.delayPersonH)}`,
    `  средняя скорость, км/ч.... ${fmt(totals.meanSpeedKph)} (авто ${fmt(totals.carMeanSpeedKph)}, автобусы ${fmt(totals.busMeanSpeedKph)})`,
    // T-18: meanSpeedKph is biased upward in a jam (only trips that finished count), so these two
    // ratios -- honest even when the network is gridlocked -- are always printed alongside it.
    `  доля стоящих машин........ ${pct(totals.stoppedShare)}`,
    `  сегментов в заторе (E/F).. ${pct(totals.congestedSegmentShare)}`,
  ];
}

function causesLine(item: BottleneckItem): string {
  if (item.causes.length === 0) return "—";
  return item.causes.map((c) => `${CAUSE_RU.get(c.cause) ?? c.cause} ${pct(c.share)}`).join(", ");
}

function recommendationsLine(item: BottleneckItem): string {
  if (item.recommendations.length === 0) return "—";
  return item.recommendations.map((r) => r.label).join("; ");
}

export function formatTopN(items: readonly BottleneckItem[]): string[] {
  if (items.length === 0) return ["top: узких мест не обнаружено"];
  const lines = [`top (${items.length}):`];
  for (const item of items) {
    lines.push(
      `  #${item.rank} ${item.title}`,
      `      задержка ${fmt(item.delayVehH)} маш-ч / ${fmt(item.delayPersonH)} чел-ч` +
        `, LOS ${item.los}, V/C ${fmt(item.vcRatio, 2)}`,
      `      причины: ${causesLine(item)}`,
      `      рекомендации: ${recommendationsLine(item)}`,
    );
  }
  return lines;
}

export function formatSummaryHeader(summary: RunSummary): string[] {
  return [
    `network ${summary.networkId}, scenario ${summary.scenarioId}, seed ${summary.seed}`,
    `simulated ${fmt(summary.simulatedS / 60, 1)} min, trajectoryHash ${summary.trajectoryHash}`,
  ];
}

export function formatPerf(perf: NonNullable<RunSummary["perf"]>): string {
  return `perf: ${fmt(perf.stepsPerS, 0)} шагов/с, ${fmt(perf.vehiclesMean, 0)} машин в среднем, ${fmt(perf.wallMs, 0)} мс`;
}

export function printReport(summary: RunSummary): void {
  for (const line of formatSummaryHeader(summary)) console.log(line);
  for (const line of formatTotals(summary.totals)) console.log(line);
  for (const line of formatTopN(summary.top)) console.log(line);
  if (summary.perf) console.log(formatPerf(summary.perf));
}

/** Warm-up / measurement progress on stderr; overwrites the same line. */
export function printProgress(phase: "прогрев" | "прогон", doneFrac: number): void {
  const shown = Math.min(100, Math.round(doneFrac * 100));
  process.stderr.write(`\r${phase}: ${shown}%${shown >= 100 ? "\n" : ""}`);
}

export interface BenchRun {
  wallMs: number;
  stepsPerS: number;
  vehiclesMean: number;
}

export function printBenchResults(runs: readonly BenchRun[]): void {
  console.log(`bench (${runs.length} прогона):`);
  runs.forEach((r, i) => {
    console.log(
      `  #${i + 1}: ${fmt(r.stepsPerS, 0)} шагов/с, ${fmt(r.vehiclesMean, 0)} машин в среднем, ${fmt(r.wallMs, 0)} мс`,
    );
  });
  const mean = (pick: (r: BenchRun) => number) =>
    runs.reduce((a, r) => a + pick(r), 0) / runs.length;
  console.log(
    `  среднее: ${fmt(
      mean((r) => r.stepsPerS),
      0,
    )} шагов/с, ${fmt(
      mean((r) => r.vehiclesMean),
      0,
    )} машин`,
  );
}
