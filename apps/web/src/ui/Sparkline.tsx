import type { BottleneckReport } from "@atl/contracts";
import { useEffect, useRef } from "react";
import { ru } from "../i18n/ru.ts";
import { emaStep } from "../state/format.ts";

/**
 * Delay trend + active-bottleneck count widget (docs/tasks/T-25 п.4): a canvas-2D sparkline of the
 * sum of `report.items[].delayVehH` (the same "active bottlenecks" the table lists, not the whole
 * network's cumulative `totals.delayVehH`) over the last 30 minutes, smoothed against the
 * docs/tasks/T-18 review's ±6%/`windowS/8` saw-tooth (same `emaStep` the table's delay column uses,
 * see `BottlenecksTab.tsx`'s `smoothBottleneckItems`).
 */

const HISTORY_SPAN_S = 30 * 60;
const SMOOTHING_TAU_S = 90;

export interface DelaySample {
  simTimeS: number;
  value: number;
}

export interface DelayHistory {
  samples: DelaySample[];
  smoothed: number | undefined;
}

export function createDelayHistory(): DelayHistory {
  return { samples: [], smoothed: undefined };
}

/** Pure: appends one sample (mutates nothing, returns the next history) - a report poll's raw sum of delayVehH in, a pruned+smoothed history out. */
export function pushDelaySample(
  history: DelayHistory,
  simTimeS: number,
  rawVehH: number,
): DelayHistory {
  const last = history.samples[history.samples.length - 1];
  const dtS = last ? simTimeS - last.simTimeS : 0;
  const smoothed = emaStep(history.smoothed, rawVehH, dtS, SMOOTHING_TAU_S);
  const samples = [...history.samples, { simTimeS, value: smoothed }].filter(
    (s) => simTimeS - s.simTimeS <= HISTORY_SPAN_S,
  );
  return { samples, smoothed };
}

function drawSparkline(canvas: HTMLCanvasElement, history: DelayHistory): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const samples = history.samples;
  if (samples.length < 2) return;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    min = Math.min(min, s.value);
    max = Math.max(max, s.value);
  }
  if (max - min < 1e-6) {
    min -= 0.5;
    max += 0.5;
  }
  const firstT = samples[0]?.simTimeS ?? 0;
  const lastT = samples[samples.length - 1]?.simTimeS ?? firstT;
  const spanT = Math.max(1e-6, lastT - firstT);

  ctx.beginPath();
  samples.forEach((s, i) => {
    const x = ((s.simTimeS - firstT) / spanT) * width;
    const y = height - ((s.value - min) / (max - min)) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#d5893a";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const lastSample = samples[samples.length - 1];
  if (lastSample) {
    const x = width;
    const y = height - ((lastSample.value - min) / (max - min)) * height;
    ctx.beginPath();
    ctx.arc(x - 1.5, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = "#d5893a";
    ctx.fill();
  }
}

export interface SparklineProps {
  report: BottleneckReport | undefined;
}

const CANVAS_WIDTH = 240;
const CANVAS_HEIGHT = 40;

/** Redraws whenever a new `report` arrives (the store's poll cadence, docs/tasks/T-23 `REPORT_POLL_INTERVAL_MS`); keeps its own history across re-renders via a ref, not store state. */
export function Sparkline({ report }: SparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<DelayHistory>(createDelayHistory());

  useEffect(() => {
    if (!report) return;
    const rawVehH = report.items.reduce((sum, item) => sum + item.delayVehH, 0);
    historyRef.current = pushDelaySample(historyRef.current, report.simTimeS, rawVehH);
    if (canvasRef.current) drawSparkline(canvasRef.current, historyRef.current);
  }, [report]);

  return (
    <div className="bottleneck-summary">
      <div className="bottleneck-summary-sparkline">
        <span className="bottleneck-summary-title">{ru.sparklineTitle}</span>
        <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
      </div>
      <div className="bottleneck-summary-count">
        <span className="bottleneck-summary-count-value">{report?.items.length ?? 0}</span>
        <span className="bottleneck-summary-count-label">{ru.activeBottlenecksLabel}</span>
      </div>
    </div>
  );
}
