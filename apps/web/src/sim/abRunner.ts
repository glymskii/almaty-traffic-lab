import type { Network, NetworkOverride, SimConfigPatch } from "@atl/contracts";
import { defaultSimConfig } from "@atl/contracts";
import { applyOverrides } from "@atl/map-data/overrides";
import { type SimHandle, startSim } from "./client.ts";

/**
 * Owns the second worker for A/B comparison (docs/tasks/T-26 п.1): "два SimClient с одним сидом,
 * общий контроль времени... смена сценария B пересоздаёт только B". `simA` is the app's existing
 * main sim (already running, already warmed up, driven by the normal transport controls before
 * comparison ever starts) - this module never creates or disposes it, only reads its clock and
 * calls play/pause on it as part of the sync rule below. `simB` is entirely owned here.
 */

export type AbSide = "a" | "b";
export type AbStatus = "idle" | "starting" | "ready" | "error";

/** docs/tasks/T-26 п.1: "если один отстаёт более чем на 5 с, второй ставится на паузу до выравнивания". */
export const AB_SYNC_LAG_S = 5;
const AB_SYNC_TICK_MS = 500;

/** The only surface `stepAbSync` needs from a running sim - small enough that tests can pass a
 * plain object that just records calls instead of a real `SimHandle`/worker. */
export interface AbClock {
  simTimeS(): number;
  play(speedFactor: number): void;
  pause(): void;
}

export interface AbSyncState {
  /** Which side the sync loop itself paused to let the other catch up, or undefined if neither is
   * sync-paused right now. Distinct from a *global* pause (the transport controls stopping both
   * deliberately) - `stepAbSync` is a no-op while `playing` is false. */
  pausedSide: AbSide | undefined;
}

export function createAbSyncState(): AbSyncState {
  return { pausedSide: undefined };
}

/**
 * One reconciliation step, meant to be called on a fixed interval while both sides are playing.
 * Pure apart from calling `play`/`pause` on the clocks it's given - `apps/web/test/abRunner.test.ts`
 * exercises it with fake clocks that just record which calls happened, so the interval-driven loop
 * that calls this in `createAbRunner` needs no test of its own.
 */
export function stepAbSync(
  clocks: Record<AbSide, AbClock>,
  state: AbSyncState,
  playing: boolean,
  speedFactor: number,
): AbSyncState {
  if (!playing) return state; // transport controls already paused both; nothing to reconcile here
  const diff = clocks.a.simTimeS() - clocks.b.simTimeS(); // positive: A is ahead of B

  if (state.pausedSide === "a") {
    if (diff <= AB_SYNC_LAG_S) {
      clocks.a.play(speedFactor);
      return { pausedSide: undefined };
    }
    return state;
  }
  if (state.pausedSide === "b") {
    if (-diff <= AB_SYNC_LAG_S) {
      clocks.b.play(speedFactor);
      return { pausedSide: undefined };
    }
    return state;
  }
  if (diff > AB_SYNC_LAG_S) {
    clocks.a.pause();
    return { pausedSide: "a" };
  }
  if (-diff > AB_SYNC_LAG_S) {
    clocks.b.pause();
    return { pausedSide: "b" };
  }
  return state;
}

function clockOf(handle: SimHandle): AbClock {
  return {
    simTimeS: () => handle.latestFrameMeta().simTimeS,
    play: (factor) => handle.play(factor),
    pause: () => handle.pause(),
  };
}

export interface AbRunnerCallbacks {
  onStatusChange?: (status: AbStatus) => void;
  /** Fires every time a (re)started B finishes warm-up and starts playing. */
  onBReady?: (sim: SimHandle) => void;
}

export interface AbRunner {
  /** (Re)compiles and (re)starts B only, from `baseNetwork` + `overrides` - A is untouched
   * (docs/tasks/T-26 п.1: "смена сценария B пересоздаёт только B"). Warms up to the same
   * `demand.warmupMinutes` point A itself warmed up to, then joins the sync loop. */
  startB(overrides: readonly NetworkOverride[], scenarioId: string): Promise<void>;
  getSimB(): SimHandle | undefined;
  /** Mirrors the transport controls' play/pause onto B and resets sync-pause bookkeeping - call
   * this from the same place that calls `simA.play()/.pause()`. */
  setPlaying(playing: boolean, speedFactor: number): void;
  setSpeedFactor(speedFactor: number): void;
  dispose(): void;
}

export function createAbRunner(
  baseNetwork: Network,
  configPatch: SimConfigPatch,
  simA: SimHandle,
  callbacks: AbRunnerCallbacks = {},
): AbRunner {
  const warmupEndS = defaultSimConfig(configPatch).demand.warmupMinutes * 60;
  const clockA = clockOf(simA);

  let simB: SimHandle | undefined;
  let disposed = false;
  let generation = 0; // guards a stale startB() resolving after a newer call, or after dispose()
  let syncState = createAbSyncState();
  let playing = true;
  let speedFactor = 1;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function startTimer(): void {
    stopTimer();
    timer = setInterval(() => {
      if (!simB) return;
      syncState = stepAbSync({ a: clockA, b: clockOf(simB) }, syncState, playing, speedFactor);
    }, AB_SYNC_TICK_MS);
  }

  async function startB(overrides: readonly NetworkOverride[], scenarioId: string): Promise<void> {
    const myGeneration = ++generation;
    stopTimer();
    syncState = createAbSyncState();
    const previous = simB;
    simB = undefined;
    previous?.dispose();
    callbacks.onStatusChange?.("starting");

    const network =
      overrides.length > 0
        ? applyOverrides(baseNetwork, overrides, defaultSimConfig(configPatch), scenarioId)
        : baseNetwork;
    try {
      const handle = await startSim(network, configPatch);
      if (disposed || myGeneration !== generation) {
        handle.dispose();
        return;
      }
      await handle.runUntil(warmupEndS);
      if (disposed || myGeneration !== generation) {
        handle.dispose();
        return;
      }
      if (playing) handle.play(speedFactor);
      simB = handle;
      startTimer();
      callbacks.onBReady?.(handle);
      callbacks.onStatusChange?.("ready");
    } catch (error) {
      if (!disposed && myGeneration === generation) callbacks.onStatusChange?.("error");
      throw error;
    }
  }

  return {
    startB,
    getSimB: () => simB,
    setPlaying(next, factor) {
      playing = next;
      speedFactor = factor;
      syncState = createAbSyncState();
      if (!simB) return;
      if (next) simB.play(factor);
      else simB.pause();
    },
    setSpeedFactor(factor) {
      speedFactor = factor;
      if (playing) simB?.play(factor);
    },
    dispose() {
      disposed = true;
      generation++;
      stopTimer();
      simB?.dispose();
      simB = undefined;
    },
  };
}
