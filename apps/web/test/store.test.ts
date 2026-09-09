import { RUNTIME_SAFE_PARAM_PATHS } from "@atl/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConfigPatch,
  flattenedRuntimeSafePaths,
  needsRestart,
  runtimeSafePatchFor,
  useStore,
} from "../src/state/store.ts";

const initialState = useStore.getState();

beforeEach(() => {
  // The store is a module-level singleton; give every test a clean slate. Scenario actions also
  // write to localStorage, so that needs clearing too or a later test would see a leftover write.
  localStorage.clear();
  useStore.setState(initialState, true);
});

describe("runtimeSafePatchFor", () => {
  it("covers exactly the paths RUNTIME_SAFE_PARAM_PATHS lists (frozen contract)", () => {
    expect(new Set(flattenedRuntimeSafePaths())).toEqual(new Set(RUNTIME_SAFE_PARAM_PATHS));
  });

  it("builds a minimal single-field SimConfigPatch", () => {
    expect(runtimeSafePatchFor("demandMultiplier", 1.5)).toEqual({ demand: { multiplier: 1.5 } });
    expect(runtimeSafePatchFor("busLaneViolatorShare", 0.2)).toEqual({
      behavior: { busLaneViolatorShare: 0.2 },
    });
  });
});

describe("buildConfigPatch", () => {
  it("assembles startTimeMin, demand and behavior from the store's params", () => {
    const patch = buildConfigPatch({
      startTimeMin: 840,
      runtime: {
        demandMultiplier: 1.2,
        navigatorShare: 0.4,
        gridlockDiscipline: 0.6,
        busLaneViolatorShare: 0.1,
      },
      restart: { vehicleBudget: 15000, taxisAllowedInBusLanes: true },
    });
    expect(patch).toEqual({
      startTimeMin: 840,
      demand: { multiplier: 1.2, navigatorShare: 0.4, vehicleBudget: 15000 },
      behavior: {
        gridlockDiscipline: 0.6,
        busLaneViolatorShare: 0.1,
        taxisAllowedInBusLanes: true,
      },
    });
  });
});

describe("needsRestart", () => {
  it("is false when the draft matches what the sim was started with", () => {
    const p = { vehicleBudget: 20000, taxisAllowedInBusLanes: false };
    expect(needsRestart(p, { ...p })).toBe(false);
  });

  it("is true once either restart-required field diverges", () => {
    const applied = { vehicleBudget: 20000, taxisAllowedInBusLanes: false };
    expect(needsRestart(applied, { ...applied, vehicleBudget: 25000 })).toBe(true);
    expect(needsRestart(applied, { ...applied, taxisAllowedInBusLanes: true })).toBe(true);
  });
});

describe("useStore actions", () => {
  it("setActiveTab switches the side panel tab", () => {
    useStore.getState().setActiveTab("bottlenecks");
    expect(useStore.getState().activeTab).toBe("bottlenecks");
  });

  it("togglePlay flips playing even with no sim bound yet", () => {
    const before = useStore.getState().playing;
    useStore.getState().togglePlay();
    expect(useStore.getState().playing).toBe(!before);
  });

  it("setSpeedFactor updates speedFactor without a sim to notify", () => {
    useStore.getState().setSpeedFactor(5);
    expect(useStore.getState().speedFactor).toBe(5);
  });

  it("setRuntimeParam updates the corresponding field", () => {
    useStore.getState().setRuntimeParam("navigatorShare", 0.42);
    expect(useStore.getState().runtimeParams.navigatorShare).toBe(0.42);
  });

  it("setDraftRestartParam only touches the draft, leaving appliedRestartParams alone", () => {
    const appliedBefore = useStore.getState().appliedRestartParams;
    useStore.getState().setDraftRestartParam("vehicleBudget", 5000);
    expect(useStore.getState().draftRestartParams.vehicleBudget).toBe(5000);
    expect(useStore.getState().appliedRestartParams).toBe(appliedBefore);
  });

  it("restart() applies the draft and bumps restartToken", () => {
    useStore.getState().setDraftRestartParam("taxisAllowedInBusLanes", true);
    const tokenBefore = useStore.getState().restartToken;
    useStore.getState().restart();
    const state = useStore.getState();
    expect(state.restartToken).toBe(tokenBefore + 1);
    expect(state.appliedRestartParams.taxisAllowedInBusLanes).toBe(true);
  });

  it("applyTimePreset sets startTimeMin from TIME_PRESETS and bumps restartToken", () => {
    const tokenBefore = useStore.getState().restartToken;
    useStore.getState().applyTimePreset("evening");
    const state = useStore.getState();
    expect(state.startTimeMin).toBe(18 * 60 + 30);
    expect(state.restartToken).toBe(tokenBefore + 1);
  });

  it("setNetworkKey switches networks and bumps restartToken", () => {
    const tokenBefore = useStore.getState().restartToken;
    useStore.getState().setNetworkKey("big");
    const state = useStore.getState();
    expect(state.networkKey).toBe("big");
    expect(state.restartToken).toBe(tokenBefore + 1);
  });

  it("setNetworkKey also applies a pending restart-required draft, like applyTimePreset/restart() do", () => {
    // Regression: the network switch remounts Viewport (a fresh load) same as the other two
    // restart paths, so a vehicle-budget/taxi-lane edit still sitting in the draft must not be
    // silently dropped by it, and the "needs restart" badge must not stay lit afterwards.
    useStore.getState().setDraftRestartParam("vehicleBudget", 5000);
    useStore.getState().setNetworkKey("big");
    const state = useStore.getState();
    expect(state.appliedRestartParams.vehicleBudget).toBe(5000);
    expect(needsRestart(state.appliedRestartParams, state.draftRestartParams)).toBe(false);
  });

  it("setNetworkKey drops the scenario selection back to baseline (a scenario belongs to one network)", () => {
    useStore.getState().createScenario("A");
    expect(useStore.getState().activeScenarioId).not.toBe("baseline");
    useStore.getState().setNetworkKey("big");
    const state = useStore.getState();
    expect(state.activeScenarioId).toBe("baseline");
    expect(state.appliedScenarioId).toBe("baseline");
  });
});

describe("useStore scenario actions (docs/tasks/T-24)", () => {
  it("createScenario adds one for the current network and selects it as active", () => {
    useStore.getState().createScenario("Час пик");
    const state = useStore.getState();
    expect(state.scenarios).toHaveLength(1);
    expect(state.scenarios[0]?.name).toBe("Час пик");
    expect(state.scenarios[0]?.networkId).toBe("almaty-abay-small");
    expect(state.activeScenarioId).toBe(state.scenarios[0]?.id);
  });

  it("persists created scenarios to localStorage", () => {
    useStore.getState().createScenario("A");
    const id = useStore.getState().scenarios[0]?.id;
    const stored = JSON.parse(localStorage.getItem("atl.scenarios.v1") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(id);
  });

  it("duplicateScenario copies overrides under a new id and selects the copy", () => {
    useStore.getState().createScenario("A");
    const sourceId = useStore.getState().scenarios[0]?.id as string;
    useStore
      .getState()
      .upsertOverrideInActiveScenario({ kind: "link", linkId: "l0", set: { generalLanes: 3 } });
    useStore.getState().duplicateScenario(sourceId, "A (копия)");
    const state = useStore.getState();
    expect(state.scenarios).toHaveLength(2);
    const copy = state.scenarios.find((s) => s.id === state.activeScenarioId);
    expect(copy?.name).toBe("A (копия)");
    expect(copy?.overrides).toEqual(state.scenarios[0]?.overrides);
  });

  it("renameScenario updates the name in place without changing which scenario is active", () => {
    useStore.getState().createScenario("A");
    const id = useStore.getState().scenarios[0]?.id as string;
    useStore.getState().setActiveScenarioId("baseline");
    useStore.getState().renameScenario(id, "B");
    const state = useStore.getState();
    expect(state.scenarios.find((s) => s.id === id)?.name).toBe("B");
    expect(state.activeScenarioId).toBe("baseline");
  });

  it("deleteScenario removes it and falls back to baseline if it was selected", () => {
    useStore.getState().createScenario("A");
    const id = useStore.getState().scenarios[0]?.id as string;
    useStore.getState().deleteScenario(id);
    const state = useStore.getState();
    expect(state.scenarios).toHaveLength(0);
    expect(state.activeScenarioId).toBe("baseline");
  });

  it("deleteScenario refuses to delete the baseline id", () => {
    useStore.getState().deleteScenario("baseline");
    expect(useStore.getState().scenarios).toHaveLength(0);
  });

  it("upsertOverrideInActiveScenario is a no-op while baseline is active", () => {
    useStore
      .getState()
      .upsertOverrideInActiveScenario({ kind: "link", linkId: "l0", set: { generalLanes: 3 } });
    expect(useStore.getState().scenarios).toHaveLength(0);
  });

  it("upsertOverrideInActiveScenario writes into the active scenario and persists it", () => {
    useStore.getState().createScenario("A");
    useStore
      .getState()
      .upsertOverrideInActiveScenario({ kind: "link", linkId: "l0", set: { generalLanes: 3 } });
    const scenario = useStore.getState().scenarios[0];
    expect(scenario?.overrides).toEqual([{ kind: "link", linkId: "l0", set: { generalLanes: 3 } }]);
  });

  it("removeOverrideFromActiveScenario drops a previously added override", () => {
    useStore.getState().createScenario("A");
    useStore
      .getState()
      .upsertOverrideInActiveScenario({ kind: "link", linkId: "l0", set: { generalLanes: 3 } });
    useStore.getState().removeOverrideFromActiveScenario("link", "l0");
    expect(useStore.getState().scenarios[0]?.overrides).toEqual([]);
  });

  it("runActiveScenario applies the draft scenario and bumps restartToken (same fold as restart())", () => {
    useStore.getState().createScenario("A");
    const activeId = useStore.getState().activeScenarioId;
    const tokenBefore = useStore.getState().restartToken;
    useStore.getState().setDraftRestartParam("vehicleBudget", 5000);
    useStore.getState().runActiveScenario();
    const state = useStore.getState();
    expect(state.appliedScenarioId).toBe(activeId);
    expect(state.restartToken).toBe(tokenBefore + 1);
    expect(state.appliedRestartParams.vehicleBudget).toBe(5000);
  });

  it("importScenario validates the network id and adds/selects the scenario", () => {
    useStore.getState().createScenario("A");
    const json = JSON.stringify({
      id: "imported-1",
      name: "Imported",
      networkId: "almaty-abay-small",
      overrides: [],
      params: {},
    });
    useStore.getState().importScenario(json);
    const state = useStore.getState();
    expect(state.scenarios).toHaveLength(2);
    expect(state.activeScenarioId).toBe("imported-1");
  });

  it("importScenario throws (and changes nothing) for a scenario authored on another network", () => {
    const json = JSON.stringify({
      id: "imported-1",
      name: "Imported",
      networkId: "some-other-network",
      overrides: [],
      params: {},
    });
    expect(() => useStore.getState().importScenario(json)).toThrow();
    expect(useStore.getState().scenarios).toHaveLength(0);
  });

  it("setSelection stores the clicked map object", () => {
    useStore.getState().setSelection({ kind: "link", id: "l0" });
    expect(useStore.getState().selection).toEqual({ kind: "link", id: "l0" });
  });
});

describe("useStore A/B comparison actions (docs/tasks/T-26)", () => {
  it("startComparisonWithScenario is a no-op before Viewport/A's sim exist", () => {
    useStore.getState().startComparisonWithScenario("some-scenario");
    const state = useStore.getState();
    expect(state.simB).toBeUndefined();
    expect(state.abStatus).toBe("idle");
  });

  it("setAbSelected updates the toggle and forwards the pick to viewport.setCompareSim", () => {
    const setCompareSim = vi.fn();
    useStore.setState({
      viewport: { setCompareSim } as unknown as ReturnType<typeof useStore.getState>["viewport"],
    });
    useStore.getState().setAbSelected("b");
    expect(useStore.getState().abSelected).toBe("b");
    expect(setCompareSim).toHaveBeenCalledWith(undefined); // simB isn't running in this test
  });

  it("stopComparison resets every A/B field even with no comparison running", () => {
    useStore.setState({ abSelected: "b", abStatus: "starting", compareScenarioBId: "x" });
    useStore.getState().stopComparison();
    const state = useStore.getState();
    expect(state.simB).toBeUndefined();
    expect(state.reportB).toBeUndefined();
    expect(state.abSelected).toBe("a");
    expect(state.abStatus).toBe("idle");
    expect(state.compareScenarioBId).toBeUndefined();
  });

  it("applyRecommendationToScenarioB writes into a dedicated scenario without touching activeScenarioId/appliedScenarioId", () => {
    const override = { kind: "link", linkId: "l0", set: { generalLanes: 3 } } as const;
    useStore.getState().applyRecommendationToScenarioB([override], "Сравнение: Улица l0");
    const state = useStore.getState();
    expect(state.scenarios).toHaveLength(1);
    expect(state.scenarios[0]?.name).toBe("Сравнение: Улица l0");
    expect(state.scenarios[0]?.overrides).toEqual([override]);
    // Unlike BottlenecksTab's `applyRecommendation` (which edits activeScenarioId), this path is
    // entirely separate from the "Сценарии" tab's own editing target.
    expect(state.activeScenarioId).toBe("baseline");
    expect(state.appliedScenarioId).toBe("baseline");
  });

  it("applyRecommendationToScenarioB reuses the existing B scenario (by compareScenarioBId) instead of creating a new one each time", () => {
    const first = { kind: "link", linkId: "l0", set: { generalLanes: 3 } } as const;
    useStore.getState().applyRecommendationToScenarioB([first], "Сравнение: Первая");
    const scenarioId = useStore.getState().scenarios[0]?.id as string;
    // Simulates startComparisonWithScenario having actually run and recorded which scenario B is
    // (skipped here since it needs a real Viewport/sim - see the no-op test above).
    useStore.setState({ compareScenarioBId: scenarioId });

    const second = { kind: "link", linkId: "l1", set: { speedLimitKph: 40 } } as const;
    useStore.getState().applyRecommendationToScenarioB([second], "Сравнение: Вторая");
    const state = useStore.getState();
    expect(state.scenarios).toHaveLength(1); // still one scenario, not two
    expect(state.scenarios[0]?.id).toBe(scenarioId);
    expect(state.scenarios[0]?.overrides).toEqual([first, second]);
  });
});
