import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkNetworkIntegrity,
  cycleLengthS,
  defaultSimConfig,
  type Network,
  parseNetwork,
} from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { getBBox } from "../../src/bboxes.ts";
import { compileNetwork } from "../../src/compiler/index.ts";
import { buildNodeMovements } from "../../src/compiler/movements.ts";
import { readSnapshotFile } from "../../src/compiler/write.ts";
import { generateController } from "../../src/signals/generate.ts";
import { arrowGroupId, mainGroupId } from "../../src/signals/groups.ts";
import { MIN_CYCLE_S } from "../../src/signals/webster.ts";
import { FIXED_TIME } from "../compiler/helpers.ts";
import {
  connectorsAt,
  controllerOf,
  crossroads,
  pedestrianConflictsInPhases,
  protectedConflictsInPhases,
  stripControllers,
  tJunction,
} from "./helpers.ts";

const timing = defaultSimConfig().signals;

/** T-03 fixture stripped of its hand-written plan, then replanned by the generator. */
function replan(net: Network): Network {
  const stripped = stripControllers(net);
  const report = generateController(stripped, "center", timing);
  expect(report).toBeDefined();
  return stripped;
}

describe("crossroads with left pockets", () => {
  const net = replan(crossroads({ crosswalks: true }));
  const ctrl = controllerOf(net, "center");

  it("passes the integrity check with a plan built from scratch", () => {
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("gives every approach a protected left with an arrow section", () => {
    expect(ctrl.leftTurnModes).toEqual({
      "E.in": "protected",
      "N.in": "protected",
      "S.in": "protected",
      "W.in": "protected",
    });
    const arrows = ctrl.groups.filter((g) => g.section === "arrow_left");
    expect(arrows.map((g) => g.id).sort()).toEqual(
      ["E.in", "N.in", "S.in", "W.in"].map(arrowGroupId),
    );
    for (const g of arrows) expect(g.connectorIds.length).toBeGreaterThan(0);
    // A right turn never gets a section of its own; it rides the main group of its approach.
    expect(ctrl.groups.some((g) => g.section === "arrow_right")).toBe(false);
  });

  it("leads each axis with its arrows and then serves through + right", () => {
    expect(ctrl.phases).toHaveLength(4);
    const sections = new Map(ctrl.groups.map((g) => [g.id, g.section] as const));
    const kinds = ctrl.phases.map((p) =>
      p.greenGroupIds.every((id) => sections.get(id) === "arrow_left") ? "arrow" : "through",
    );
    expect(kinds).toEqual(["arrow", "through", "arrow", "through"]);
    for (const p of ctrl.phases.filter((_, i) => kinds[i] === "arrow"))
      expect(p.greenS).toBeGreaterThanOrEqual(10);
    for (const p of ctrl.phases.filter((_, i) => kinds[i] === "arrow"))
      expect(p.greenS).toBeLessThanOrEqual(15);
  });

  it("keeps the cycle inside [40, maxCycleS] and every green above minGreenS", () => {
    const cycle = cycleLengthS(ctrl);
    expect(cycle).toBeGreaterThanOrEqual(MIN_CYCLE_S);
    expect(cycle).toBeLessThanOrEqual(timing.maxCycleS);
    for (const p of ctrl.phases) expect(p.greenS).toBeGreaterThanOrEqual(timing.minGreenS);
  });

  it("makes every movement protected because no phase releases a conflicting pair", () => {
    const at = connectorsAt(net, "center");
    expect(at).toHaveLength(16);
    expect(at.every((c) => c.protection === "protected")).toBe(true);
    expect(protectedConflictsInPhases(net, ctrl)).toEqual([]);
  });

  it("greens the zebras of one axis with the through traffic of the other", () => {
    const ped = ctrl.groups.filter((g) => g.kind === "pedestrian");
    expect(ped).toHaveLength(4);
    for (const cw of net.crosswalks) expect(cw.signalGroupId).toBeDefined();
    const nsThrough = ctrl.phases.find((p) => p.greenGroupIds.includes(mainGroupId("N.in")));
    expect(nsThrough?.greenGroupIds).toContain(`sg.cw.E.ped`);
    expect(nsThrough?.greenGroupIds).toContain(`sg.cw.W.ped`);
    expect(nsThrough?.greenGroupIds).not.toContain(`sg.cw.N.ped`);
    // No phase walks pedestrians across a zebra a through movement of the same phase drives over.
    expect(pedestrianConflictsInPhases(net, ctrl)).toEqual([]);
    // Pedestrians never walk during a protected-left phase.
    const arrowPhases = ctrl.phases.filter((p) =>
      p.greenGroupIds.some((id) => id === arrowGroupId("N.in")),
    );
    for (const p of arrowPhases)
      expect(p.greenGroupIds.some((id) => id.endsWith(".ped"))).toBe(false);
  });
});

describe("crossroads without left pockets", () => {
  const net = replan(crossroads({ leftPocketM: 0, crosswalks: true }));
  const ctrl = controllerOf(net, "center");

  it("keeps the left permissive in the main section and uses two phases", () => {
    expect(Object.values(ctrl.leftTurnModes)).toEqual([
      "permissive",
      "permissive",
      "permissive",
      "permissive",
    ]);
    expect(ctrl.groups.some((g) => g.section === "arrow_left")).toBe(false);
    expect(ctrl.phases).toHaveLength(2);
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });

  it("downgrades exactly the movements that share a green with a conflicting one", () => {
    const at = connectorsAt(net, "center");
    const permissive = at.filter((c) => c.protection === "permissive");
    expect(permissive.every((c) => c.turn === "left" || c.turn === "right")).toBe(true);
    expect(at.filter((c) => c.turn === "through").every((c) => c.protection === "protected")).toBe(
      true,
    );
    expect(protectedConflictsInPhases(net, ctrl)).toEqual([]);
  });
});

describe("crossroads without a pedestrian phase", () => {
  it("creates no pedestrian group and leaves the zebras unsignalized", () => {
    const net = stripControllers(crossroads({ crosswalks: true }));
    const report = generateController(net, "center", timing, { pedestrianPhase: false });
    expect(report?.controller.pedestrianPhase).toBe(false);
    expect(report?.controller.groups.every((g) => g.kind === "vehicle")).toBe(true);
    for (const cw of net.crosswalks) expect(cw.signalGroupId).toBeUndefined();
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
  });
});

describe("signalized T-junction", () => {
  const net = replan(tJunction({ signalized: true }));
  const ctrl = controllerOf(net, "center");

  it("serves the main street in one phase and the stem in the other", () => {
    expect(checkNetworkIntegrity(parseNetwork(net))).toEqual([]);
    expect(ctrl.phases).toHaveLength(2);
    const [main, stem] = ctrl.phases;
    expect(main?.greenGroupIds.sort()).toEqual([mainGroupId("E.in"), mainGroupId("W.in")]);
    expect(stem?.greenGroupIds).toEqual([mainGroupId("S.in")]);
  });

  it("marks the approach with no left movement as prohibited", () => {
    // W arrives from the west; the junction offers it only "through" and "right".
    expect(ctrl.leftTurnModes["W.in"]).toBe("prohibited");
    expect(ctrl.leftTurnModes["E.in"]).toBe("permissive");
    expect(ctrl.leftTurnModes["S.in"]).toBe("permissive");
  });

  it("protects the stem, which is alone in its phase", () => {
    const stemConnectors = connectorsAt(net, "center").filter((c) =>
      c.fromLaneId.startsWith("S.in"),
    );
    expect(stemConnectors.length).toBeGreaterThan(0);
    expect(stemConnectors.every((c) => c.protection === "protected")).toBe(true);
    expect(protectedConflictsInPhases(net, ctrl)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance on the real snapshot.
// ---------------------------------------------------------------------------

const SMALL_SNAPSHOT = fileURLToPath(
  new URL("../../../../data/osm/almaty-abay-small/snapshot.json.gz", import.meta.url),
);

describe("signal plans on the small Almaty snapshot", () => {
  it.skipIf(!existsSync(SMALL_SNAPSHOT))(
    "gives every signalized node a plan with a 40..120 s cycle and no released conflict",
    () => {
      const net = compileNetwork({
        bbox: getBBox("small"),
        snapshot: readSnapshotFile(SMALL_SNAPSHOT),
        config: defaultSimConfig(),
        generatedAt: FIXED_TIME,
      }).network;
      expect(checkNetworkIntegrity(net)).toEqual([]);

      const signalized = net.nodes.filter((n) => n.kind === "signalized");
      expect(signalized.length).toBeGreaterThan(60);
      const withPlan = new Set(net.signalControllers.map((c) => c.nodeId));
      expect(signalized.filter((n) => !withPlan.has(n.id))).toEqual([]);

      for (const ctrl of net.signalControllers) {
        const cycle = cycleLengthS(ctrl);
        expect(cycle).toBeGreaterThanOrEqual(MIN_CYCLE_S);
        expect(cycle).toBeLessThanOrEqual(timing.maxCycleS);
        expect(protectedConflictsInPhases(net, ctrl)).toEqual([]);
        // Odd and lopsided nodes: the arm a through movement leaves by may belong to another axis,
        // so a zebra it crosses must not be green with it (review note of T-08).
        expect(pedestrianConflictsInPhases(net, ctrl)).toEqual([]);
      }
    },
  );

  it.skipIf(!existsSync(SMALL_SNAPSHOT))(
    "plans the degree-2 pedestrian signals as vehicles / pedestrians",
    () => {
      const net = compileNetwork({
        bbox: getBBox("small"),
        snapshot: readSnapshotFile(SMALL_SNAPSHOT),
        config: defaultSimConfig(),
        generatedAt: FIXED_TIME,
      }).network;
      const byNode = buildNodeMovements(net);
      const deg2 = net.nodes.filter(
        (n) => n.kind === "signalized" && (byNode.get(n.id)?.degree ?? 0) === 2,
      );
      expect(deg2.length).toBeGreaterThan(0);
      for (const node of deg2) {
        const ctrl = controllerOf(net, node.id);
        expect(ctrl.phases).toHaveLength(2);
        const [vehicles, pedestrians] = ctrl.phases;
        const kindOf = new Map(ctrl.groups.map((g) => [g.id, g.kind] as const));
        expect(vehicles?.greenGroupIds.every((id) => kindOf.get(id) === "vehicle")).toBe(true);
        expect(pedestrians?.greenGroupIds.every((id) => kindOf.get(id) === "pedestrian")).toBe(
          true,
        );
      }
    },
  );
});
