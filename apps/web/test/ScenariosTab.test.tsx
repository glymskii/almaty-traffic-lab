import type { Network } from "@atl/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ru } from "../src/i18n/ru.ts";
import { useStore } from "../src/state/store.ts";
import { ScenariosTab } from "../src/ui/ScenariosTab.tsx";
import type { ViewportHandle } from "../src/Viewport.tsx";
import { buildSignalizedJunction, buildStraightRoad } from "./fixtures.ts";

/**
 * End-to-end (within jsdom, no Three.js/worker) smoke test of the scenario editor's map-object
 * forms (docs/tasks/T-24 п.2/3): the plumbing from `selection`/`viewport.network` in the store,
 * through `ScenariosTab`, to the right form and back into the active scenario's overrides.
 */

const initialState = useStore.getState();

function fakeViewport(network: Network): ViewportHandle {
  return {
    network,
    baseNetwork: network,
    engine: {} as ViewportHandle["engine"],
    rig: {} as ViewportHandle["rig"],
    cityLayers: {} as ViewportHandle["cityLayers"],
    getSim: () => undefined,
    onSimReady: () => () => {},
    setCompareSim: () => {},
  };
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState(initialState, true);
});

afterEach(() => {
  cleanup();
});

describe("ScenariosTab", () => {
  it("shows the baseline hint before any scenario is created", () => {
    render(<ScenariosTab />);
    expect(screen.getByText(ru.scenarioBaselineHint)).toBeTruthy();
  });

  it("creating a scenario selects it as active and shows the select-an-object hint", () => {
    useStore.setState({ viewport: fakeViewport(buildStraightRoad()) });
    render(<ScenariosTab />);
    fireEvent.change(screen.getByPlaceholderText(ru.scenarioNamePlaceholder), {
      target: { value: "A" },
    });
    fireEvent.click(screen.getByText(ru.scenarioCreate));
    expect(useStore.getState().scenarios).toHaveLength(1);
    expect(screen.getByText(ru.scenarioSelectHint)).toBeTruthy();
  });

  it("opens LinkForm for a selected link and 'Применить' writes an override into the active scenario", () => {
    const network = buildStraightRoad({ lengthM: 200 });
    useStore.setState({ viewport: fakeViewport(network) });
    useStore.getState().createScenario("A");
    useStore.getState().setSelection({ kind: "link", id: "l0" });

    render(<ScenariosTab />);
    expect(screen.getByText(ru.linkFormTitle("l0"))).toBeTruthy();
    expect(screen.queryByText(ru.resetOverride)).toBeNull();

    fireEvent.click(screen.getByText(ru.applyOverride));

    const scenario = useStore.getState().scenarios[0];
    expect(scenario?.overrides).toHaveLength(1);
    expect(scenario?.overrides[0]).toMatchObject({ kind: "link", linkId: "l0" });
    // Re-render picks up the store's updated scenario and now offers to reset the override.
    expect(screen.getByText(ru.resetOverride)).toBeTruthy();

    fireEvent.click(screen.getByText(ru.resetOverride));
    expect(useStore.getState().scenarios[0]?.overrides).toEqual([]);
  });

  it("re-opens LinkForm with the scenario's already-saved override, not the (unrun) network's baseline", () => {
    // The active scenario already has an override for l0, but hasn't been "Запущен" yet, so
    // `viewport.network` (below) is still the unmodified baseline - the regression this guards
    // against is the form reading only `network` and silently replacing that saved override with
    // the baseline's values the moment the user hits "Применить" without touching a single field.
    const network = buildStraightRoad({ lanes: 2, lengthM: 200 }); // baseline: 2 lanes, 60 km/h
    useStore.setState({ viewport: fakeViewport(network) });
    useStore.getState().createScenario("A");
    useStore.getState().upsertOverrideInActiveScenario({
      kind: "link",
      linkId: "l0",
      set: { generalLanes: 3, speedLimitKph: 40 },
    });
    useStore.getState().setSelection({ kind: "link", id: "l0" });

    render(<ScenariosTab />);
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider.value).toBe("3");
    expect(screen.getByDisplayValue("40")).toBeTruthy();

    // Applying the untouched form must not clobber the saved override with the baseline's values.
    fireEvent.click(screen.getByText(ru.applyOverride));
    const scenario = useStore.getState().scenarios[0];
    expect(scenario?.overrides[0]).toMatchObject({
      kind: "link",
      linkId: "l0",
      set: expect.objectContaining({ generalLanes: 3, speedLimitKph: 40 }),
    });
  });

  it("opens IntersectionForm for a signalized node and 'Применить' writes a signal override", () => {
    const network = buildSignalizedJunction();
    useStore.setState({ viewport: fakeViewport(network) });
    useStore.getState().createScenario("A");
    useStore.getState().setSelection({ kind: "node", id: "n_c" });

    render(<ScenariosTab />);
    expect(screen.getByText(ru.intersectionFormTitle("n_c"))).toBeTruthy();

    fireEvent.click(screen.getByText(ru.applyOverride));
    const scenario = useStore.getState().scenarios[0];
    expect(scenario?.overrides).toHaveLength(1);
    expect(scenario?.overrides[0]).toMatchObject({ kind: "signal", nodeId: "n_c" });
  });

  it("re-opens IntersectionForm with the scenario's already-saved override, not the (unrun) network's baseline", () => {
    const network = buildSignalizedJunction(); // baseline: leftTurnModes {} -> approach "in" shows "permissive"
    useStore.setState({ viewport: fakeViewport(network) });
    useStore.getState().createScenario("A");
    useStore.getState().upsertOverrideInActiveScenario({
      kind: "signal",
      nodeId: "n_c",
      set: { leftTurnModes: { in: "protected" }, cycleS: 90 },
    });
    useStore.getState().setSelection({ kind: "node", id: "n_c" });

    render(<ScenariosTab />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("protected");
    expect(screen.getByDisplayValue("90")).toBeTruthy();

    fireEvent.click(screen.getByText(ru.applyOverride));
    const scenario = useStore.getState().scenarios[0];
    expect(scenario?.overrides[0]).toMatchObject({
      kind: "signal",
      nodeId: "n_c",
      set: expect.objectContaining({ leftTurnModes: { in: "protected" }, cycleS: 90 }),
    });
  });

  it("shows the not-editable message for a node without a signal controller", () => {
    const network = buildStraightRoad();
    useStore.setState({ viewport: fakeViewport(network) });
    useStore.getState().createScenario("A");
    useStore.getState().setSelection({ kind: "node", id: "n0" });

    render(<ScenariosTab />);
    expect(screen.getByText(ru.notEditableNode)).toBeTruthy();
  });

  it("upsertOverrideInActiveScenario is not reachable while baseline is selected (the editor forms are hidden)", () => {
    const network = buildStraightRoad();
    useStore.setState({ viewport: fakeViewport(network), selection: { kind: "link", id: "l0" } });
    render(<ScenariosTab />);
    expect(screen.queryByText(ru.linkFormTitle("l0"))).toBeNull();
    expect(screen.getByText(ru.scenarioBaselineHint)).toBeTruthy();
  });
});
