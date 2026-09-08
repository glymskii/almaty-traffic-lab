import { baselineScenario, defaultSimConfig, parseNetwork } from "@atl/contracts";
import type { FrameEvent } from "@atl/sim-worker";
import { createSimClient, createStubSimWorker } from "@atl/sim-worker";
import { useEffect, useRef, useState } from "react";

/**
 * T-06 acceptance check: proves the worker + client protocol moves data end to end, using
 * StubSimulation (the real kernel lands in T-04, the real renderer in T-13). Reached via
 * /?debug=worker; not part of the normal app shell and safe to delete once T-13 lands.
 */

const CANVAS_SIZE = 560;
const METERS_TO_PIXELS = CANVAS_SIZE / 600;

function buildDebugNetwork() {
  return parseNetwork({
    meta: {
      schemaVersion: 1,
      networkId: "debug-worker-stub",
      bboxId: "debug",
      bbox: { south: 0, west: 0, north: 0, east: 0 },
      origin: { lat: 43.24, lon: 76.92 },
      generatedAt: "2026-01-01T00:00:00Z",
      generator: "debug-worker-view",
    },
    nodes: [],
    links: [],
    lanes: [],
    connectors: [],
  });
}

export function DebugWorkerView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("подключение к воркеру...");

  useEffect(() => {
    // Never construct the Worker's URL here: it must be built inside @atl/sim-worker itself
    // (see create-worker.ts) or it silently fails to start once Vite bundles for production.
    const client = createSimClient({ createWorker: createStubSimWorker, frameRateHz: 30 });

    const offError = client.onError((message, fatal) => {
      setStatus(`ошибка${fatal ? " (fatal)" : ""}: ${message}`);
    });

    const offFrame = client.onFrame((ev: FrameEvent) => {
      setStatus(
        `t=${ev.simTimeS.toFixed(1)} с · машин: ${ev.vehicleCount} · rtFactor=${ev.rtFactor.toFixed(2)}`,
      );
      const canvas = canvasRef.current;
      const ctx2d = canvas?.getContext("2d");
      if (!ctx2d || !canvas) return;
      ctx2d.fillStyle = "#0b1220";
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      ctx2d.fillStyle = "#5eead4";
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      for (let i = 0; i < ev.frame.count; i++) {
        const x = cx + (ev.frame.x[i] ?? 0) * METERS_TO_PIXELS;
        const y = cy - (ev.frame.y[i] ?? 0) * METERS_TO_PIXELS;
        ctx2d.beginPath();
        ctx2d.arc(x, y, 2, 0, Math.PI * 2);
        ctx2d.fill();
      }
    });

    client
      .init(
        buildDebugNetwork(),
        defaultSimConfig({ dtS: 0.1 }),
        baselineScenario("debug-worker-stub"),
      )
      .then(() => {
        setStatus("готово, запуск...");
        client.play(20);
      })
      .catch((err: unknown) => {
        setStatus(`не удалось инициализировать: ${String(err)}`);
      });

    return () => {
      offError();
      offFrame();
      client.dispose();
    };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>T-06: воркер + StubSimulation</h1>
      <p style={{ opacity: 0.7, maxWidth: 560 }}>
        Временная страница для проверки протокола sim-worker (init/play/frame/returnFrame) до
        появления реального ядра (T-04) и рендера (T-13). Уберётся вместе с ними.
      </p>
      <p>{status}</p>
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        style={{ background: "#0b1220", borderRadius: 8 }}
      />
    </main>
  );
}
