import {
  baselineScenario,
  defaultSimConfig,
  type InitStats,
  type Network,
  type SimConfigPatch,
  VehicleFlag,
} from "@atl/contracts";
import { createSimClient, createSimWorker, createStubSimWorker } from "@atl/sim-worker";
import {
  createInterpolationBuffer,
  type InterpolationBuffer,
  ingestFrame,
  type RenderFrame,
  sampleInterpolated,
} from "../scene/interpolation.ts";

/**
 * Wires apps/web to `@atl/sim-worker` (docs/tasks/T-13): picks the real kernel or
 * `createStubSimWorker` (`?sim=stub` in the URL, T-06's debug flag), owns the interpolation
 * buffer and a "display clock" that turns wall-clock render ticks into a smooth sim-time cursor,
 * and copies every per-frame array the renderer needs (vehicle poses, signal states, pedestrian
 * counts) out of the transferable `FrameBuffers` synchronously inside `onFrame` - the buffer is
 * detached the instant that callback returns (see interpolation.ts's `ingestFrame`).
 */

/** `?sim=stub` swaps in the 500-point placeholder kernel (packages/sim-worker/stub-simulation.ts) until sim-core's signals/pedestrians land. */
export function wantsStubSimulation(search: string): boolean {
  return new URLSearchParams(search).get("sim") === "stub";
}

export interface SimHandle {
  readonly stats: InitStats;
  play(speedFactor: number): void;
  pause(): void;
  /** Resolves once the worker reaches `simTimeS` (warm-up / fast-forward); `onProgress` fires along the way. */
  runUntil(simTimeS: number): Promise<void>;
  onProgress(cb: (simTimeS: number, targetSimTimeS: number) => void): () => void;
  onError(cb: (message: string, fatal: boolean) => void): () => void;
  /** Advances the display clock by `dtS` real seconds (scaled by the last `play` speed) and writes the interpolated pose into `out`. */
  sampleVehicles(dtS: number, out: RenderFrame): void;
  /** Latest values as of the last received frame - signals/pedestrian counts are discrete state, not lerped like position. */
  signalStates(): Uint8Array;
  crosswalkPeds(): Uint8Array;
  dispose(): void;
}

export async function startSim(
  network: Network,
  configPatch: SimConfigPatch = {},
): Promise<SimHandle> {
  const useStub = typeof window !== "undefined" && wantsStubSimulation(window.location.search);
  const client = createSimClient({ createWorker: useStub ? createStubSimWorker : createSimWorker });

  let interpBuf: InterpolationBuffer | undefined;
  let signalStatesLatest = new Uint8Array(0);
  let crosswalkPedsLatest = new Uint8Array(0);
  let latestFrameSimTimeS = 0;
  let displaySimTimeS = 0;
  let speedFactor = 0;

  const offFrame = client.onFrame((ev) => {
    if (!interpBuf) return; // frames only ever arrive after init() resolves below; defensive only
    ingestFrame(interpBuf, ev.frame);
    signalStatesLatest.set(ev.frame.signalStates);
    crosswalkPedsLatest.set(ev.frame.crosswalkPeds);
    latestFrameSimTimeS = ev.simTimeS;
  });

  const stats = await client.init(
    network,
    defaultSimConfig(configPatch),
    baselineScenario(network.meta.networkId),
  );
  interpBuf = createInterpolationBuffer(stats.vehicleCapacity);
  signalStatesLatest = new Uint8Array(stats.signalGroupCount);
  crosswalkPedsLatest = new Uint8Array(stats.crosswalkCount);

  return {
    stats,
    play(factor) {
      speedFactor = factor;
      client.play(factor);
    },
    pause() {
      speedFactor = 0;
      client.pause();
    },
    runUntil: (simTimeS) => client.runUntil(simTimeS),
    onProgress: client.onProgress,
    onError: client.onError,
    sampleVehicles(dtS, out) {
      if (!interpBuf) {
        out.count = 0;
        return;
      }
      // Never extrapolate past the newest data we actually have; if the worker falls behind,
      // display time just holds at the last received frame instead of guessing ahead.
      displaySimTimeS = Math.min(latestFrameSimTimeS, displaySimTimeS + dtS * speedFactor);
      sampleInterpolated(interpBuf, displaySimTimeS, out);
    },
    signalStates: () => signalStatesLatest,
    crosswalkPeds: () => crosswalkPedsLatest,
    dispose() {
      offFrame();
      client.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Stress mode (docs/tasks/T-13 acceptance: "20 000 инстансов при 60 fps ... стресс-режим со стабом")
// ---------------------------------------------------------------------------

/** `?stress=1` bypasses the worker entirely and drives vehicles.ts at full capacity for a manual fps check. */
export function wantsStressMode(search: string): boolean {
  return new URLSearchParams(search).get("stress") === "1";
}

const STRESS_RINGS = 40;
const STRESS_RING_SPACING_M = 6;
const STRESS_MIN_RADIUS_M = 20;
const STRESS_SPEED_RAD_S = 0.05;

/**
 * Fills `out` with `capacity` vehicles arranged in concentric rings, cycling every vehicle class
 * and lighting up brakes/blinkers on a fraction of them - not a Simulation (no @atl/sim-core
 * involved), purely a rendering stress fixture.
 */
export function sampleStressFrame(atSimTimeS: number, out: RenderFrame): void {
  const capacity = out.capacity;
  const perRing = Math.max(1, Math.floor(capacity / STRESS_RINGS));
  for (let i = 0; i < capacity; i++) {
    const ring = Math.floor(i / perRing) % STRESS_RINGS;
    const radius = STRESS_MIN_RADIUS_M + ring * STRESS_RING_SPACING_M;
    const angle =
      (i % perRing) * ((2 * Math.PI) / perRing) +
      atSimTimeS * STRESS_SPEED_RAD_S * (1 + (ring % 3));
    out.id[i] = i;
    out.slot[i] = i;
    out.x[i] = radius * Math.cos(angle);
    out.y[i] = radius * Math.sin(angle);
    out.heading[i] = angle + Math.PI / 2;
    out.speed[i] = 8;
    out.cls[i] = i % 4; // VEHICLE_CLASS_CODE happens to enumerate 0..3, so this cycles every class
    out.flags[i] =
      (i % 7 === 0 ? VehicleFlag.BRAKING : 0) |
      (i % 5 === 0 ? VehicleFlag.BLINKER_LEFT : 0) |
      (i % 11 === 0 ? VehicleFlag.BLINKER_RIGHT : 0);
    out.cause[i] = 0;
  }
  out.count = capacity;
  out.simTimeS = atSimTimeS;
}
