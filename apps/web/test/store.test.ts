import { RUNTIME_SAFE_PARAM_PATHS } from "@atl/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildConfigPatch,
  flattenedRuntimeSafePaths,
  needsRestart,
  runtimeSafePatchFor,
  useStore,
} from "../src/state/store.ts";

const initialState = useStore.getState();

beforeEach(() => {
  // The store is a module-level singleton; give every test a clean slate.
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
});
