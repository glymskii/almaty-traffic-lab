import {
  type BottleneckReport,
  defaultSimConfig,
  type NetworkOverride,
  RUNTIME_SAFE_PARAM_PATHS,
  type Scenario,
  type SimConfigPatch,
} from "@atl/contracts";
import { create } from "zustand";
import { type AbRunner, type AbSide, type AbStatus, createAbRunner } from "../sim/abRunner.ts";
import type { SimHandle } from "../sim/client.ts";
import type { Status, ViewportHandle } from "../Viewport.tsx";
import {
  BASELINE_SCENARIO_ID,
  duplicateScenario as copyScenario,
  loadStoredScenarios,
  createScenario as makeScenario,
  parseImportedScenario,
  persistScenarios,
  removeOverride,
  removeScenario as removeScenarioFromList,
  renameScenario as renameScenarioRecord,
  replaceScenario,
  upsertOverride,
} from "./scenarios.ts";

export type { Scenario } from "@atl/contracts";

/**
 * Global UI store (docs/tasks/T-23 п.1: "состояние через лёгкий стор"). Zustand is the one new
 * dependency the card allows; everything else here is plain, pure, and unit-testable without
 * React (see apps/web/test/store.test.ts).
 */

// ---------------------------------------------------------------------------
// Networks (docs/tasks/T-05/T-02 review: files are named by bbox preset id, not by the UI key).
// Duplicated from packages/map-data/src/bboxes.ts rather than imported: that package's barrel
// also re-exports the OSM importer and compiler, which pull in node:fs/node:crypto - fine for the
// map-data package's own Node-only CLIs and tests, but not something to hand to Vite's browser
// bundle just for two id strings.
// ---------------------------------------------------------------------------
export type NetworkKey = "small" | "big";
export const NETWORK_IDS: Record<NetworkKey, string> = {
  small: "almaty-abay-small",
  big: "almaty-center-big",
};

export type TabKey = "overview" | "bottlenecks" | "scenarios" | "compare";
export const SPEED_FACTORS = [1, 2, 5, 10] as const;
export type SpeedFactor = (typeof SPEED_FACTORS)[number];

/** Exactly `RUNTIME_SAFE_PARAM_PATHS` (packages/contracts/src/sim-config.ts), applied via `setParams` with no restart. */
export interface RuntimeSafeParams {
  demandMultiplier: number;
  navigatorShare: number;
  gridlockDiscipline: number;
  busLaneViolatorShare: number;
}

/** Changing these only takes effect after "Перезапуск" (docs/tasks/T-23 п.3). */
export interface RestartParams {
  vehicleBudget: number;
  taxisAllowedInBusLanes: boolean;
}

const DEFAULTS = defaultSimConfig();

const initialRuntimeParams: RuntimeSafeParams = {
  demandMultiplier: DEFAULTS.demand.multiplier,
  navigatorShare: DEFAULTS.demand.navigatorShare,
  gridlockDiscipline: DEFAULTS.behavior.gridlockDiscipline,
  busLaneViolatorShare: DEFAULTS.behavior.busLaneViolatorShare,
};
const initialRestartParams: RestartParams = {
  vehicleBudget: DEFAULTS.demand.vehicleBudget,
  taxisAllowedInBusLanes: DEFAULTS.behavior.taxisAllowedInBusLanes,
};

/** docs/tasks/T-23 п.2: preset start times for the "Утро"/"День"/"Вечер" buttons. */
export const TIME_PRESETS = {
  morning: 8 * 60,
  midday: 14 * 60,
  evening: 18 * 60 + 30,
} as const;
export type TimePresetKey = keyof typeof TIME_PRESETS;

/** Builds the `SimConfigPatch` a fresh Viewport mount is initialised with, from the store's params. */
export function buildConfigPatch(p: {
  startTimeMin: number;
  runtime: RuntimeSafeParams;
  restart: RestartParams;
}): SimConfigPatch {
  return {
    startTimeMin: p.startTimeMin,
    demand: {
      multiplier: p.runtime.demandMultiplier,
      navigatorShare: p.runtime.navigatorShare,
      vehicleBudget: p.restart.vehicleBudget,
    },
    behavior: {
      gridlockDiscipline: p.runtime.gridlockDiscipline,
      busLaneViolatorShare: p.runtime.busLaneViolatorShare,
      taxisAllowedInBusLanes: p.restart.taxisAllowedInBusLanes,
    },
  };
}

/**
 * The minimal patch for one runtime-safe slider, in the same shape `RUNTIME_SAFE_PARAM_PATHS`
 * describes ("demand.multiplier", ...) - a store test asserts the two stay in lockstep.
 */
export function runtimeSafePatchFor(
  key: keyof RuntimeSafeParams,
  value: RuntimeSafeParams[typeof key],
): SimConfigPatch {
  switch (key) {
    case "demandMultiplier":
      return { demand: { multiplier: value } };
    case "navigatorShare":
      return { demand: { navigatorShare: value } };
    case "gridlockDiscipline":
      return { behavior: { gridlockDiscipline: value } };
    case "busLaneViolatorShare":
      return { behavior: { busLaneViolatorShare: value } };
  }
}

/** True while a restart-required control differs from what the running sim was actually started with. */
export function needsRestart(applied: RestartParams, draft: RestartParams): boolean {
  return (
    applied.vehicleBudget !== draft.vehicleBudget ||
    applied.taxisAllowedInBusLanes !== draft.taxisAllowedInBusLanes
  );
}

// ---------------------------------------------------------------------------
// Scenarios (docs/tasks/T-24). `activeScenarioId` is what the "Сценарии" tab edits (a draft, in
// the T-23 sense); `appliedScenarioId` is what the *running* sim was last (re)started with -
// exactly the `appliedRestartParams`/`draftRestartParams` split above, reused rather than
// reinvented (T-23 review notes). Editing an override writes straight into the active scenario's
// data (localStorage) - only "Запустить" ever restarts the sim, via the very same fold the other
// three restart paths use.
// ---------------------------------------------------------------------------

/** Node or link the user last clicked on the map, for `ScenariosTab` to open the right form. */
export type MapSelection = { kind: "node"; id: string } | { kind: "link"; id: string };

// ---------------------------------------------------------------------------
// HUD polling (docs/tasks/T-23 п.4): the worker already pushes a BottleneckReport every
// `metrics.windowS`; requesting one on a shorter, fixed cadence keeps the HUD's average speed and
// windowed delay reasonably fresh without inventing a second protocol message.
// ---------------------------------------------------------------------------
const REPORT_POLL_INTERVAL_MS = 3000;
/** How often (in accumulated render seconds) the HUD's fps/rtFactor/vehicle count are refreshed. */
const HUD_UPDATE_INTERVAL_S = 0.5;

// ---------------------------------------------------------------------------
// A/B comparison (docs/tasks/T-26). "A" is always whatever the app's one main sim/viewport is
// already running (`sim`/`report` above, tied to `appliedScenarioId`) - comparison only ever adds
// a second background worker for scenario "B", owned by `abRunner` (sim/abRunner.ts) and mirrored
// into `simB`/`reportB` here. `abSelected` is the time bar's A/B toggle (Tab key): it decides which
// side's frames `viewport.setCompareSim` feeds into the 3D scene and which side BottlenecksTab's
// heat-map/Топ-N read, but never which side is "running" - both keep simulating regardless.
// ---------------------------------------------------------------------------
export type { AbSide, AbStatus };

export interface StoreState {
  activeTab: TabKey;
  networkKey: NetworkKey;
  startTimeMin: number;
  runtimeParams: RuntimeSafeParams;
  /** What the *running* sim was actually last (re)started with - the source of truth for `needsRestart`. */
  appliedRestartParams: RestartParams;
  /** What the controls currently show - may differ from `appliedRestartParams` until "Перезапуск". */
  draftRestartParams: RestartParams;
  speedFactor: SpeedFactor;
  playing: boolean;
  status: Status;
  warmupProgress: number;
  /** Bumped to force Viewport to unmount/remount (see ui/App.tsx's `key={restartToken}`). */
  restartToken: number;

  /** Every stored scenario (all networks - `scenariosForNetwork` filters for the current one). */
  scenarios: Scenario[];
  /** Scenario the "Сценарии" tab is editing; "baseline" is the synthetic no-overrides scenario. */
  activeScenarioId: string;
  /** Scenario the *running* sim was last (re)started with. */
  appliedScenarioId: string;
  /** Node/link last clicked on the map, for the scenario editor's forms. */
  selection: MapSelection | undefined;

  viewport: ViewportHandle | undefined;
  sim: SimHandle | undefined;
  report: BottleneckReport | undefined;

  /** Scenario B's own sim/report (docs/tasks/T-26); undefined until a comparison is started. */
  simB: SimHandle | undefined;
  reportB: BottleneckReport | undefined;
  /** Which scenario id `simB` was (re)started with, if any - `applyRecommendationToScenarioB`
   * reuses this scenario instead of piling up a new one per recommendation click. */
  compareScenarioBId: string | undefined;
  /** The time bar's A/B toggle (Tab key) - which side's frames the 3D scene/heat-map/Топ-N read. */
  abSelected: AbSide;
  abStatus: AbStatus;

  fps: number;
  vehiclesActive: number;
  vehicleCapacity: number;
  rtFactor: number;
  timeOfDayMinDisplay: number;

  setActiveTab(tab: TabKey): void;
  setNetworkKey(key: NetworkKey): void;
  applyTimePreset(preset: TimePresetKey): void;
  restart(): void;
  setSpeedFactor(factor: SpeedFactor): void;
  togglePlay(): void;
  setRuntimeParam<K extends keyof RuntimeSafeParams>(key: K, value: RuntimeSafeParams[K]): void;
  setDraftRestartParam<K extends keyof RestartParams>(key: K, value: RestartParams[K]): void;
  setStatus(status: Status, progress?: number): void;
  bindViewport(handle: ViewportHandle): void;

  setSelection(selection: MapSelection | undefined): void;
  setActiveScenarioId(id: string): void;
  runActiveScenario(): void;
  createScenario(name: string): void;
  duplicateScenario(id: string, name: string): void;
  renameScenario(id: string, name: string): void;
  deleteScenario(id: string): void;
  upsertOverrideInActiveScenario(override: NetworkOverride): void;
  removeOverrideFromActiveScenario(kind: NetworkOverride["kind"], refId: string): void;
  importScenario(json: string): void;

  /** Starts (or restarts) scenario B's background sim from that scenario's current overrides. */
  startComparisonWithScenario(scenarioId: string): void;
  /** Tears down B and returns the A/B toggle to "a"; A is never affected. */
  stopComparison(): void;
  setAbSelected(side: AbSide): void;
  /** "Применить рекомендацию в Б" (docs/tasks/T-26 п.4): writes `overrides` into the dedicated B
   * scenario (creating one on first use, named `label`, reusing it on later calls so recommendations
   * accumulate instead of replacing each other) and (re)starts comparison with it. */
  applyRecommendationToScenarioB(overrides: NetworkOverride[], label: string): void;
}

/** Cleans up the previous mount's subscriptions/timers before `bindViewport` attaches new ones. */
let unbindPrevious: (() => void) | undefined;

/**
 * The comparison's own instance + subscriptions (docs/tasks/T-26), module-scoped like
 * `unbindPrevious` above for the same reason: `useStore` is a singleton the whole app shares, so
 * there is exactly one A/B comparison in flight at a time, and it must be torn down before a new
 * one starts (a fresh recommendation applied to B) or whenever the *main* Viewport remounts (a
 * network switch, "Перезапуск", a new "Запустить" scenario) - `abRunner`'s `simA`/`baseNetwork`
 * would otherwise point at a Viewport instance that no longer exists.
 */
let abRunner: AbRunner | undefined;
let offReportB: (() => void) | undefined;
let reportTimerB: ReturnType<typeof setInterval> | undefined;

function disposeComparison(): void {
  offReportB?.();
  offReportB = undefined;
  if (reportTimerB !== undefined) clearInterval(reportTimerB);
  reportTimerB = undefined;
  abRunner?.dispose();
  abRunner = undefined;
}

/**
 * The one place that remounts Viewport (T-23 review notes: every restart path must fold the draft
 * restart params the same way, or one of them will silently revert an unapplied change). Every
 * action that forces a fresh network load - a network switch, a time preset, "Перезапуск", and
 * T-24's "Запустить" scenario - calls this instead of repeating the two fields inline.
 */
function foldRestart(
  state: Pick<StoreState, "draftRestartParams" | "restartToken">,
  extra: Partial<StoreState> = {},
): Partial<StoreState> {
  return {
    appliedRestartParams: state.draftRestartParams,
    restartToken: state.restartToken + 1,
    ...extra,
  };
}

export const useStore = create<StoreState>()((set, get) => ({
  activeTab: "overview",
  networkKey: "small",
  startTimeMin: DEFAULTS.startTimeMin,
  runtimeParams: initialRuntimeParams,
  appliedRestartParams: initialRestartParams,
  draftRestartParams: initialRestartParams,
  speedFactor: 1,
  playing: true,
  status: "loading",
  warmupProgress: 0,
  restartToken: 0,

  scenarios: loadStoredScenarios(),
  activeScenarioId: BASELINE_SCENARIO_ID,
  appliedScenarioId: BASELINE_SCENARIO_ID,
  selection: undefined,

  viewport: undefined,
  sim: undefined,
  report: undefined,
  simB: undefined,
  reportB: undefined,
  compareScenarioBId: undefined,
  abSelected: "a",
  abStatus: "idle",
  fps: 0,
  vehiclesActive: 0,
  vehicleCapacity: initialRestartParams.vehicleBudget,
  rtFactor: 1,
  timeOfDayMinDisplay: DEFAULTS.startTimeMin,

  setActiveTab: (tab) => set({ activeTab: tab }),

  setNetworkKey: (key) => {
    // Switching networks always remounts Viewport (a fresh network load), so fold any pending
    // restart-required draft in the same way applyTimePreset/restart() do - otherwise a vehicle
    // budget/taxi-lane change the user made but hadn't applied yet would be silently dropped by
    // the remount, and ParamsPanel would still show "Применить и перезапустить" as if nothing had
    // just restarted. A scenario is authored against one network, so switching networks also
    // drops back to baseline - the old scenario's link/node ids would not resolve here at all.
    set((state) =>
      foldRestart(state, {
        networkKey: key,
        activeScenarioId: BASELINE_SCENARIO_ID,
        appliedScenarioId: BASELINE_SCENARIO_ID,
        selection: undefined,
      }),
    );
  },

  applyTimePreset: (preset) => {
    set((state) => foldRestart(state, { startTimeMin: TIME_PRESETS[preset] }));
  },

  restart: () => {
    set((state) => foldRestart(state));
  },

  setSpeedFactor: (factor) => {
    set({ speedFactor: factor });
    if (get().playing) get().sim?.play(factor);
    abRunner?.setSpeedFactor(factor);
  },

  togglePlay: () => {
    const { playing, sim, speedFactor } = get();
    const next = !playing;
    set({ playing: next });
    if (sim) {
      if (next) sim.play(speedFactor);
      else sim.pause();
    }
    // Comparison's own transport mirror (docs/tasks/T-26 п.1: "команда play обоим") - resets the
    // sync loop's own pause bookkeeping too, since a deliberate global pause/resume is not the same
    // event as the two sides drifting apart.
    abRunner?.setPlaying(next, speedFactor);
  },

  setRuntimeParam: (key, value) => {
    set((state) => ({ runtimeParams: { ...state.runtimeParams, [key]: value } }));
    get().sim?.setParams(runtimeSafePatchFor(key, value));
  },

  setDraftRestartParam: (key, value) => {
    set((state) => ({ draftRestartParams: { ...state.draftRestartParams, [key]: value } }));
  },

  setStatus: (status, progress) => {
    set({ status, ...(progress !== undefined ? { warmupProgress: progress } : {}) });
  },

  bindViewport: (handle) => {
    unbindPrevious?.();
    // A fresh Viewport mount invalidates any running comparison: `abRunner` holds A's old
    // `SimHandle` and `baseNetwork`, neither of which exist anymore (network switch, "Перезапуск",
    // a new "Запустить" scenario all remount Viewport - see ui/App.tsx's `key={restartToken}`).
    disposeComparison();
    set({
      viewport: handle,
      sim: undefined,
      report: undefined,
      simB: undefined,
      reportB: undefined,
      abSelected: "a",
      abStatus: "idle",
      fps: 0,
      vehiclesActive: 0,
      rtFactor: 1,
    });

    let fpsAccumS = 0;
    let fpsFrames = 0;
    let hudAccumS = 0;
    const offEngineFrame = handle.engine.onFrame((dtS) => {
      fpsAccumS += dtS;
      fpsFrames += 1;
      hudAccumS += dtS;
      if (hudAccumS < HUD_UPDATE_INTERVAL_S) return;
      hudAccumS = 0;
      const sim = get().sim;
      const meta = sim?.latestFrameMeta();
      set({
        fps: fpsAccumS > 0 ? fpsFrames / fpsAccumS : 0,
        vehiclesActive: meta?.vehicleCount ?? 0,
        vehicleCapacity: sim?.stats.vehicleCapacity ?? get().vehicleCapacity,
        rtFactor: meta?.rtFactor ?? get().rtFactor,
        timeOfDayMinDisplay: meta?.timeOfDayMin ?? get().timeOfDayMinDisplay,
      });
      fpsAccumS = 0;
      fpsFrames = 0;
    });

    let offReport: (() => void) | undefined;
    let reportTimer: ReturnType<typeof setInterval> | undefined;
    const offSimReady = handle.onSimReady((sim) => {
      set({ sim, vehicleCapacity: sim.stats.vehicleCapacity });
      // Viewport already called play(1) right before announcing readiness; only re-issue play/pause
      // if the user changed the transport controls while warm-up was still running.
      const { playing, speedFactor } = get();
      if (!playing) sim.pause();
      else if (speedFactor !== 1) sim.play(speedFactor);

      sim.requestReport();
      reportTimer = setInterval(() => sim.requestReport(), REPORT_POLL_INTERVAL_MS);
      offReport = sim.onReport((report) => set({ report }));
    });

    unbindPrevious = () => {
      offEngineFrame();
      offSimReady();
      offReport?.();
      if (reportTimer) clearInterval(reportTimer);
    };
  },

  setSelection: (selection) => set({ selection }),

  setActiveScenarioId: (id) => set({ activeScenarioId: id, selection: undefined }),

  runActiveScenario: () => {
    // Same fold as every other restart path (see `foldRestart`); the actual recompile with
    // overrides happens inside Viewport once it remounts with the new `appliedScenarioId`.
    set((state) => foldRestart(state, { appliedScenarioId: state.activeScenarioId }));
  },

  createScenario: (name) => {
    const networkId = NETWORK_IDS[get().networkKey];
    const scenario = makeScenario(name, networkId);
    const scenarios = [...get().scenarios, scenario];
    persistScenarios(scenarios);
    set({ scenarios, activeScenarioId: scenario.id });
  },

  duplicateScenario: (id, name) => {
    const source = get().scenarios.find((s) => s.id === id);
    if (source === undefined) return;
    const copy = copyScenario(source, name);
    const scenarios = [...get().scenarios, copy];
    persistScenarios(scenarios);
    set({ scenarios, activeScenarioId: copy.id });
  },

  renameScenario: (id, name) => {
    const source = get().scenarios.find((s) => s.id === id);
    if (source === undefined) return;
    const scenarios = replaceScenario(get().scenarios, renameScenarioRecord(source, name));
    persistScenarios(scenarios);
    set({ scenarios });
  },

  deleteScenario: (id) => {
    if (id === BASELINE_SCENARIO_ID) return;
    const scenarios = removeScenarioFromList(get().scenarios, id);
    persistScenarios(scenarios);
    set((state) => ({
      scenarios,
      activeScenarioId:
        state.activeScenarioId === id ? BASELINE_SCENARIO_ID : state.activeScenarioId,
      appliedScenarioId:
        state.appliedScenarioId === id ? BASELINE_SCENARIO_ID : state.appliedScenarioId,
    }));
  },

  upsertOverrideInActiveScenario: (override) => {
    const { activeScenarioId } = get();
    if (activeScenarioId === BASELINE_SCENARIO_ID) return;
    const source = get().scenarios.find((s) => s.id === activeScenarioId);
    if (source === undefined) return;
    const scenarios = replaceScenario(get().scenarios, upsertOverride(source, override));
    persistScenarios(scenarios);
    set({ scenarios });
  },

  removeOverrideFromActiveScenario: (kind, refId) => {
    const { activeScenarioId } = get();
    if (activeScenarioId === BASELINE_SCENARIO_ID) return;
    const source = get().scenarios.find((s) => s.id === activeScenarioId);
    if (source === undefined) return;
    const scenarios = replaceScenario(get().scenarios, removeOverride(source, kind, refId));
    persistScenarios(scenarios);
    set({ scenarios });
  },

  importScenario: (json) => {
    const networkId = NETWORK_IDS[get().networkKey];
    const imported = parseImportedScenario(json, networkId);
    // An imported scenario keeps its own id: importing the same file twice updates it in place
    // instead of piling up duplicates.
    const exists = get().scenarios.some((s) => s.id === imported.id);
    const scenarios = exists
      ? replaceScenario(get().scenarios, imported)
      : [...get().scenarios, imported];
    persistScenarios(scenarios);
    set({ scenarios, activeScenarioId: imported.id });
  },

  startComparisonWithScenario: (scenarioId) => {
    const { viewport } = get();
    const simA = viewport?.getSim();
    if (!viewport || !simA) return; // A isn't warmed up/playable yet - nothing to compare against
    const overrides = get().scenarios.find((s) => s.id === scenarioId)?.overrides ?? [];

    set({ compareScenarioBId: scenarioId, abStatus: "starting" });
    if (!abRunner) {
      const { startTimeMin, runtimeParams, appliedRestartParams } = get();
      const configPatch = buildConfigPatch({
        startTimeMin,
        runtime: runtimeParams,
        restart: appliedRestartParams,
      });
      abRunner = createAbRunner(viewport.baseNetwork, configPatch, simA, {
        onStatusChange: (status) => set({ abStatus: status }),
        onBReady: (sim) => {
          offReportB?.();
          if (reportTimerB !== undefined) clearInterval(reportTimerB);
          set({ simB: sim, reportB: undefined });
          if (get().abSelected === "b") viewport.setCompareSim(sim);
          sim.requestReport();
          reportTimerB = setInterval(() => sim.requestReport(), REPORT_POLL_INTERVAL_MS);
          offReportB = sim.onReport((report) => set({ reportB: report }));
        },
      });
    }
    abRunner.startB(overrides, scenarioId).catch((error: unknown) => {
      console.error("Comparison: failed to start scenario B", error);
    });
  },

  stopComparison: () => {
    disposeComparison();
    get().viewport?.setCompareSim(undefined);
    set({
      simB: undefined,
      reportB: undefined,
      abSelected: "a",
      abStatus: "idle",
      compareScenarioBId: undefined,
    });
  },

  setAbSelected: (side) => {
    set({ abSelected: side });
    const { viewport, simB } = get();
    viewport?.setCompareSim(side === "b" ? simB : undefined);
  },

  applyRecommendationToScenarioB: (overrides, label) => {
    const networkId = NETWORK_IDS[get().networkKey];
    const existing = get().scenarios.find((s) => s.id === get().compareScenarioBId);
    let scenario = existing ?? makeScenario(label, networkId);
    for (const override of overrides) scenario = upsertOverride(scenario, override);
    const scenarios = get().scenarios.some((s) => s.id === scenario.id)
      ? replaceScenario(get().scenarios, scenario)
      : [...get().scenarios, scenario];
    persistScenarios(scenarios);
    set({ scenarios });
    get().startComparisonWithScenario(scenario.id);
  },
}));

/** `RUNTIME_SAFE_PARAM_PATHS` is a frozen contract; assert `runtimeSafePatchFor` still covers exactly those paths. */
export function flattenedRuntimeSafePaths(): string[] {
  const keys: (keyof RuntimeSafeParams)[] = [
    "demandMultiplier",
    "navigatorShare",
    "gridlockDiscipline",
    "busLaneViolatorShare",
  ];
  const paths: string[] = [];
  for (const key of keys) {
    const patch = runtimeSafePatchFor(key, 0);
    if (patch.demand) for (const field of Object.keys(patch.demand)) paths.push(`demand.${field}`);
    if (patch.behavior) {
      for (const field of Object.keys(patch.behavior)) paths.push(`behavior.${field}`);
    }
  }
  return paths;
}

export { RUNTIME_SAFE_PARAM_PATHS };
