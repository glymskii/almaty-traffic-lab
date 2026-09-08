import type { BottleneckItem, BottleneckReport, Network, Recommendation } from "@atl/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ru } from "../src/i18n/ru.ts";
import { useStore } from "../src/state/store.ts";
import {
  BottlenecksTab,
  type DisplayBottleneckItem,
  smoothBottleneckItems,
  sortReportItems,
} from "../src/ui/BottlenecksTab.tsx";
import type { ViewportHandle } from "../src/Viewport.tsx";
import { buildStraightRoad } from "./fixtures.ts";

/**
 * Pure-logic tests (docs/tasks/T-25 п.6: "сортировка/фильтрация отчёта") plus a light render smoke
 * test of the tab itself, mirroring ScenariosTab.test.tsx's `fakeViewport` pattern - no Three.js
 * scene is actually drawn, but `engine.scene`/`engine.camera`/`rig.focus` need to be real enough for
 * BottlenecksTab's scene-wiring effect (heat-map/marker mount) not to throw.
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
    causes: [
      { cause: "signal_red", share: 0.6 },
      { cause: "gridlock", share: 0.3 },
    ],
    recommendations: [],
    focus: [10, 20],
    ...overrides,
  };
}

function buildReport(items: BottleneckItem[], simTimeS = 0): BottleneckReport {
  return {
    simTimeS,
    timeOfDayMin: 480,
    windowS: 300,
    totals: {
      vehiclesActive: 100,
      vehiclesCompleted: 50,
      delayVehH: 20,
      delayPersonH: 30,
      meanSpeedKph: 25,
      carMeanSpeedKph: 25,
      busMeanSpeedKph: 20,
      stoppedShare: 0.1,
      congestedSegmentShare: 0.2,
    },
    items,
  };
}

describe("smoothBottleneckItems", () => {
  it("takes the first sample for a new item as-is", () => {
    const { display } = smoothBottleneckItems(new Map(), [buildItem({ delayVehH: 10 })], 0);
    expect(display).toEqual([{ item: expect.anything(), delayVehH: 10, delayPersonH: 15 }]);
  });

  it("smooths a jump for an item seen before, keyed by its stable id", () => {
    const first = smoothBottleneckItems(new Map(), [buildItem({ id: "a", delayVehH: 10 })], 0);
    const second = smoothBottleneckItems(first.next, [buildItem({ id: "a", delayVehH: 40 })], 30);
    expect(second.display[0]?.delayVehH).toBeGreaterThan(10);
    expect(second.display[0]?.delayVehH).toBeLessThan(40);
  });

  it("a bottleneck that drops out of the report and reappears starts fresh, not from stale state", () => {
    const first = smoothBottleneckItems(new Map(), [buildItem({ id: "a", delayVehH: 10 })], 0);
    const droppedOut = smoothBottleneckItems(first.next, [], 30);
    const reappeared = smoothBottleneckItems(
      droppedOut.next,
      [buildItem({ id: "a", delayVehH: 90 })],
      60,
    );
    expect(reappeared.display[0]?.delayVehH).toBe(90);
  });
});

describe("sortReportItems", () => {
  const display: DisplayBottleneckItem[] = [
    { item: buildItem({ id: "a", rank: 1 }), delayVehH: 30, delayPersonH: 5 },
    { item: buildItem({ id: "b", rank: 2 }), delayVehH: 10, delayPersonH: 50 },
  ];

  it("sorts by vehicle-hours descending", () => {
    expect(sortReportItems(display, "vehH").map((d) => d.item.id)).toEqual(["a", "b"]);
  });

  it("sorts by person-hours descending, without touching the server-assigned rank", () => {
    const sorted = sortReportItems(display, "personH");
    expect(sorted.map((d) => d.item.id)).toEqual(["b", "a"]);
    expect(sorted.map((d) => d.item.rank)).toEqual([2, 1]);
  });
});

function fakeViewport(network: Network): ViewportHandle {
  return {
    network,
    engine: {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
    } as unknown as ViewportHandle["engine"],
    rig: { focus: vi.fn(), overview: vi.fn() } as unknown as ViewportHandle["rig"],
    cityLayers: {} as ViewportHandle["cityLayers"],
    getSim: () => undefined,
    onSimReady: () => () => {},
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

describe("BottlenecksTab", () => {
  it("shows an explicit hint before the first report arrives", () => {
    render(<BottlenecksTab />);
    expect(screen.getByText(ru.bottlenecksEmpty)).toBeTruthy();
  });

  it("shows an explicit hint when the report has no bottlenecks", () => {
    useStore.setState({ report: buildReport([]) });
    render(<BottlenecksTab />);
    expect(screen.getByText(ru.bottlenecksNoItems)).toBeTruthy();
  });

  it("lists items sorted by vehicle-hours by default and re-sorts by person-hours on click", () => {
    useStore.setState({
      report: buildReport([
        buildItem({ id: "a", rank: 1, title: "A", delayVehH: 30, delayPersonH: 5 }),
        buildItem({ id: "b", rank: 2, title: "B", delayVehH: 10, delayPersonH: 50 }),
      ]),
    });
    render(<BottlenecksTab />);

    const titlesInOrder = () => screen.getAllByText(/^[AB]$/).map((el) => el.textContent);
    expect(titlesInOrder()).toEqual(["A", "B"]);

    fireEvent.click(screen.getByText(ru.bottlenecksSortPersonH));
    expect(titlesInOrder()).toEqual(["B", "A"]);
  });

  it("expanding a row with no recommendations shows the explicit empty state (docs/tasks/T-19 review: this is normal, not a bug)", () => {
    useStore.setState({
      report: buildReport([buildItem({ title: "Без сценария", recommendations: [] })]),
    });
    render(<BottlenecksTab />);
    fireEvent.click(screen.getByText("Без сценария"));
    expect(screen.getByText(ru.bottlenecksNoRecommendations)).toBeTruthy();
  });

  it("expanding a row renders its cause labels from contracts' CAUSES.ru", () => {
    useStore.setState({
      report: buildReport([
        buildItem({
          title: "С причинами",
          causes: [{ cause: "signal_red", share: 0.6 }],
        }),
      ]),
    });
    render(<BottlenecksTab />);
    fireEvent.click(screen.getByText("С причинами"));
    expect(screen.getByText("Красный сигнал")).toBeTruthy();
  });

  it("'Применить в сценарии' on a baseline scenario creates one and writes the recommendation's overrides into it", () => {
    const network = buildStraightRoad({ lengthM: 200 });
    useStore.setState({ viewport: fakeViewport(network) });
    const recommendation: Recommendation = {
      kind: "add_left_pocket",
      label: "Добавить карман левого поворота",
      overrides: [{ kind: "link", linkId: "l0", set: { leftPocketLengthM: 30 } }],
    };
    useStore.setState({
      report: buildReport([
        buildItem({ title: "Рекомендация", recommendations: [recommendation] }),
      ]),
    });
    render(<BottlenecksTab />);
    fireEvent.click(screen.getByText("Рекомендация"));
    fireEvent.click(screen.getByText(ru.bottlenecksApply));

    const scenarios = useStore.getState().scenarios;
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]?.overrides).toEqual(recommendation.overrides);
    expect(screen.getByText(ru.bottlenecksApplied(scenarios[0]?.name ?? ""))).toBeTruthy();
  });

  it("'Показать' flies the camera to the item's focus point", () => {
    const network = buildStraightRoad({ lengthM: 200 });
    const viewport = fakeViewport(network);
    useStore.setState({ viewport });
    useStore.setState({
      report: buildReport([buildItem({ title: "Показать меня", focus: [12, 34] })]),
    });
    render(<BottlenecksTab />);
    fireEvent.click(screen.getByText("Показать меня"));
    fireEvent.click(screen.getByText(ru.bottlenecksShow));

    expect(viewport.rig.focus).toHaveBeenCalledWith(12, 34, expect.any(Number));
  });
});
