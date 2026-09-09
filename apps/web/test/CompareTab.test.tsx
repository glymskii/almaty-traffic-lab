import type { BottleneckItem, BottleneckReport } from "@atl/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ru } from "../src/i18n/ru.ts";
import type { SimHandle } from "../src/sim/client.ts";
import { useStore } from "../src/state/store.ts";
import { CompareTab } from "../src/ui/CompareTab.tsx";
import type { ViewportHandle } from "../src/Viewport.tsx";

/**
 * Light smoke test (docs/tasks/T-26 п.3), mirroring BottlenecksTab.test.tsx's style: no Three.js
 * scene or real worker, just the store wired to plain fakes.
 */

function buildItem(overrides: Partial<BottleneckItem> = {}): BottleneckItem {
  return {
    rank: 1,
    id: "l0:mid",
    segmentIndices: [0],
    linkId: "l0",
    title: "Тестовый участок",
    delayVehH: 10,
    delayPersonH: 15,
    speedRatio: 0.2,
    queueM: 80,
    vcRatio: 0.9,
    los: "E",
    persistence: 0.9,
    causes: [],
    recommendations: [],
    focus: [10, 20],
    ...overrides,
  };
}

function buildReport(
  items: BottleneckItem[],
  overrides: Partial<BottleneckReport> = {},
): BottleneckReport {
  return {
    simTimeS: 600,
    timeOfDayMin: 480,
    windowS: 300,
    totals: {
      vehiclesActive: 100,
      vehiclesCompleted: 50,
      delayVehH: 40,
      delayPersonH: 60,
      meanSpeedKph: 20,
      carMeanSpeedKph: 20,
      busMeanSpeedKph: 18,
      stoppedShare: 0.3,
      congestedSegmentShare: 0.4,
    },
    items,
    ...overrides,
  };
}

const initialState = useStore.getState();

beforeEach(() => {
  localStorage.clear();
  useStore.setState(initialState, true);
});

afterEach(() => {
  cleanup();
});

describe("CompareTab", () => {
  it("shows a hint instead of the picker before A's own sim is ready", () => {
    render(<CompareTab />);
    expect(screen.getByText(ru.compareNotReady)).toBeTruthy();
  });

  it("shows the picker and 'not started' hint once A is ready but B hasn't been started", () => {
    useStore.setState({ sim: {} as SimHandle, report: buildReport([]) });
    render(<CompareTab />);
    expect(screen.getByText(ru.compareNotStarted)).toBeTruthy();
    expect(screen.getByText(ru.compareStart)).toBeTruthy();
  });

  it("'Запустить сравнение' calls startComparisonWithScenario with the selected scenario", () => {
    useStore.setState({ sim: {} as SimHandle, report: buildReport([]) });
    useStore.getState().createScenario("Сценарий Б");
    const scenarioId = useStore.getState().scenarios[0]?.id as string;
    const spy = vi.fn();
    useStore.setState({ startComparisonWithScenario: spy });

    render(<CompareTab />);
    fireEvent.click(screen.getByText(ru.compareStart));
    expect(spy).toHaveBeenCalledWith(scenarioId);
  });

  it("shows the totals table and diff lists once both reports are ready", () => {
    const shared = buildItem({ id: "keep:mid", title: "Осталось" });
    const onlyInB = buildItem({ id: "new:mid", title: "Новое узкое место" });
    useStore.setState({
      sim: {} as SimHandle,
      report: buildReport([shared], { totals: { ...buildReport([]).totals, delayVehH: 40 } }),
      simB: {} as SimHandle,
      reportB: buildReport([shared, onlyInB], {
        totals: { ...buildReport([]).totals, delayVehH: 18 },
      }),
      abStatus: "ready",
    });

    render(<CompareTab />);
    expect(screen.getByText(ru.compareMetricLabels.delayVehH)).toBeTruthy();
    // A's 40h vs B's 18h - a negative (improving) delta.
    expect(screen.getByText("-22 ч")).toBeTruthy();
    // Appears both in B's Top-N list and in the "новые в Б" diff list.
    expect(screen.getAllByText("Новое узкое место").length).toBeGreaterThan(0);
  });

  it("'Показать' switches the A/B toggle to B and flies the camera to the item", () => {
    const focus = vi.fn();
    const setCompareSim = vi.fn();
    const item = buildItem({ title: "Куда лететь", focus: [12, 34] });
    const viewport = {
      rig: { focus } as unknown as ViewportHandle["rig"],
      setCompareSim,
    } as unknown as ViewportHandle;
    useStore.setState({
      sim: {} as SimHandle,
      report: buildReport([]),
      simB: {} as SimHandle,
      reportB: buildReport([item]),
      abStatus: "ready",
      viewport,
    });

    render(<CompareTab />);
    // Appears both in B's Top-N list and in the "новые в Б" diff list (A has no items at all).
    fireEvent.click(screen.getAllByText("Куда лететь")[0] as HTMLElement);
    expect(focus).toHaveBeenCalledWith(12, 34, expect.any(Number));
    expect(useStore.getState().abSelected).toBe("b");
  });
});
