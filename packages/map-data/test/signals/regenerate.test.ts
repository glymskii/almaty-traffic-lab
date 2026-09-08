import {
  checkNetworkIntegrity,
  cycleLengthS,
  defaultSimConfig,
  type Network,
  parseNetwork,
} from "@atl/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { generateController } from "../../src/signals/generate.ts";
import { arrowGroupId, mainGroupId } from "../../src/signals/groups.ts";
import { regenerateController } from "../../src/signals/regenerate.ts";
import { connectorsAt, controllerOf, crossroads, stripControllers } from "./helpers.ts";

const timing = defaultSimConfig().signals;

/** A permissive crossroads with zebras: no arrow section until an override asks for one. */
function baseline(): Network {
  const net = stripControllers(crossroads({ leftPocketM: 0, crosswalks: true }));
  generateController(net, "center", timing);
  return net;
}

describe("regenerateController", () => {
  let net: Network;
  beforeEach(() => {
    net = baseline();
  });

  it("adds an arrow_left group and a lead phase when the left becomes protected", () => {
    const before = controllerOf(net, "center");
    expect(before.groups.some((g) => g.section === "arrow_left")).toBe(false);
    expect(before.phases).toHaveLength(2);

    const report = regenerateController(
      net,
      "center",
      {
        leftTurnModes: {
          "N.in": "protected",
          "S.in": "protected",
          "E.in": "protected",
          "W.in": "protected",
        },
      },
      timing,
    );
    expect(report).toBeDefined();
    const after = controllerOf(net, "center");
    expect(
      after.groups
        .filter((g) => g.section === "arrow_left")
        .map((g) => g.id)
        .sort(),
    ).toEqual(["E.in", "N.in", "S.in", "W.in"].map(arrowGroupId));
    expect(after.phases).toHaveLength(4);
    expect(after.leftTurnModes["N.in"]).toBe("protected");
    expect(after.provenance.leftTurnModes).toBe("manual");

    // The left connectors moved out of the main section into the arrow one.
    const arrow = after.groups.find((g) => g.id === arrowGroupId("N.in"));
    const main = after.groups.find((g) => g.id === mainGroupId("N.in"));
    expect(arrow?.connectorIds.length).toBeGreaterThan(0);
    for (const id of arrow?.connectorIds ?? []) expect(main?.connectorIds).not.toContain(id);
    for (const id of arrow?.connectorIds ?? [])
      expect(net.connectors.find((c) => c.id === id)?.signalGroupId).toBe(arrow?.id);
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("scales the greens to the requested cycle and keeps every phase positive", () => {
    regenerateController(net, "center", { cycleS: 100 }, timing);
    const ctrl = controllerOf(net, "center");
    expect(cycleLengthS(ctrl)).toBe(100);
    for (const p of ctrl.phases) expect(p.greenS).toBeGreaterThan(0);
    expect(ctrl.provenance.phases).toBe("manual");
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("applies greenS per group on top of the cycle", () => {
    regenerateController(
      net,
      "center",
      { cycleS: 100, greenS: { [mainGroupId("N.in")]: 55 } },
      timing,
    );
    const ctrl = controllerOf(net, "center");
    const ns = ctrl.phases.find((p) => p.greenGroupIds.includes(mainGroupId("N.in")));
    expect(ns?.greenS).toBe(55);
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("shifts the cycle start", () => {
    regenerateController(net, "center", { offsetS: 17 }, timing);
    const ctrl = controllerOf(net, "center");
    expect(ctrl.offsetS).toBe(17);
    expect(ctrl.provenance.offsetS).toBe("manual");
  });

  it("drops the pedestrian groups and unsignalizes the zebras", () => {
    regenerateController(net, "center", { pedestrianPhase: false }, timing);
    const ctrl = controllerOf(net, "center");
    expect(ctrl.pedestrianPhase).toBe(false);
    expect(ctrl.groups.some((g) => g.kind === "pedestrian")).toBe(false);
    for (const cw of net.crosswalks) expect(cw.signalGroupId).toBeUndefined();
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("leaves a prohibited left without a group, so no phase can release it", () => {
    regenerateController(net, "center", { leftTurnModes: { "N.in": "prohibited" } }, timing);
    const ctrl = controllerOf(net, "center");
    expect(ctrl.leftTurnModes["N.in"]).toBe("prohibited");
    const lefts = connectorsAt(net, "center").filter(
      (c) => c.turn === "left" && c.fromLaneId.startsWith("N.in"),
    );
    expect(lefts.length).toBeGreaterThan(0);
    for (const c of lefts) {
      expect(c.signalGroupId).toBeUndefined();
      expect(c.protection).toBe("yield");
    }
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("replaces the plan instead of adding a second controller to the node", () => {
    regenerateController(net, "center", { cycleS: 90 }, timing);
    regenerateController(net, "center", { cycleS: 70 }, timing);
    expect(net.signalControllers.filter((c) => c.nodeId === "center")).toHaveLength(1);
    expect(cycleLengthS(controllerOf(net, "center"))).toBe(70);
  });
});
