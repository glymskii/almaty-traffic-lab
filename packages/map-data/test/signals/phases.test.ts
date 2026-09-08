import { checkNetworkIntegrity, cycleLengthS, defaultSimConfig } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { buildNodeMovements } from "../../src/compiler/movements.ts";
import { buildGroups } from "../../src/signals/groups.ts";
import { buildAxes } from "../../src/signals/phases.ts";
import { compile, localSnapshot } from "../compiler/helpers.ts";
import { controllerOf } from "./helpers.ts";

const timing = defaultSimConfig().signals;

/** A signalized cross of a primary street (east-west) and a tertiary one (north-south). */
const cross = compile(
  localSnapshot(
    { 1: [-300, 0], 2: [0, 0], 3: [300, 0], 4: [0, 300], 5: [0, -300] },
    [
      { id: 100, tags: { highway: "primary", name: "Западная", lanes: "4" }, nodes: [1, 2] },
      { id: 101, tags: { highway: "primary", name: "Восточная", lanes: "4" }, nodes: [2, 3] },
      { id: 200, tags: { highway: "tertiary", name: "Северная", lanes: "2" }, nodes: [4, 2] },
      { id: 201, tags: { highway: "tertiary", name: "Южная", lanes: "2" }, nodes: [2, 5] },
    ],
    { 2: { highway: "traffic_signals" } },
  ),
).network;

/** Three arms 120 deg apart: no pair is opposite enough to make a street. */
const star = compile(
  localSnapshot(
    { 1: [0, 0], 2: [300, 0], 3: [-150, 260], 4: [-150, -260] },
    [
      { id: 100, tags: { highway: "secondary", name: "Восточная", lanes: "2" }, nodes: [1, 2] },
      { id: 101, tags: { highway: "secondary", name: "Северная", lanes: "2" }, nodes: [1, 3] },
      { id: 102, tags: { highway: "secondary", name: "Южная", lanes: "2" }, nodes: [1, 4] },
    ],
    { 1: { highway: "traffic_signals" } },
  ),
).network;

describe("axes of a node", () => {
  it("pairs opposite arms into one street and puts the busier one first", () => {
    const movements = buildNodeMovements(cross).get("n2");
    expect(movements).toBeDefined();
    if (movements === undefined) return;
    const groups = buildGroups(cross, movements, timing, {}, true);
    const axes = buildAxes(movements, groups.approaches);
    expect(axes).toHaveLength(2);
    expect(axes.map((a) => a.armNeighbourIds.length)).toEqual([2, 2]);
    // primary (class factor 1.2) outranks tertiary (0.7), so it takes the first phase.
    expect(axes[0]?.criticalY).toBeGreaterThan(axes[1]?.criticalY ?? 0);
    const ctrl = controllerOf(cross, "n2");
    expect(ctrl.phases.length).toBeGreaterThanOrEqual(2);
    expect(checkNetworkIntegrity(cross)).toEqual([]);
  });

  it("gives an arm without an opposite partner an axis of its own", () => {
    const movements = buildNodeMovements(star).get("n1");
    expect(movements).toBeDefined();
    if (movements === undefined) return;
    const groups = buildGroups(star, movements, timing, {}, true);
    const axes = buildAxes(movements, groups.approaches);
    expect(axes).toHaveLength(3);
    expect(axes.every((a) => a.armNeighbourIds.length === 1)).toBe(true);
    // One phase per approach, as the card asks for a node where no axis stands out.
    const ctrl = controllerOf(star, "n1");
    expect(
      ctrl.phases.filter((p) => p.greenGroupIds.some((id) => id.endsWith(".main"))),
    ).toHaveLength(3);
    expect(cycleLengthS(ctrl)).toBeGreaterThanOrEqual(40);
    expect(checkNetworkIntegrity(star)).toEqual([]);
  });
});
