import { describe, expect, it } from "vitest";
import {
  allocateFrameBuffers,
  applyConfigPatch,
  baselineScenario,
  CAUSE_COUNT,
  CAUSES,
  checkNetworkIntegrity,
  cycleLengthS,
  defaultSimConfig,
  frameTransferList,
  losFromVc,
  parseNetwork,
  ScenarioSchema,
} from "../src/index.ts";

/** Smallest consistent network: gate -> 200 m link with one lane -> gate. */
function tinyNetwork() {
  return {
    meta: {
      schemaVersion: 1,
      networkId: "tiny",
      bboxId: "synthetic",
      bbox: { south: 0, west: 0, north: 0, east: 0 },
      origin: { lat: 43.24, lon: 76.92 },
      generatedAt: "2026-01-01T00:00:00Z",
      generator: "test",
    },
    nodes: [
      { id: "n0", x: 0, y: 0, kind: "gate" },
      { id: "n1", x: 200, y: 0, kind: "gate" },
    ],
    links: [
      {
        id: "l0",
        fromNodeId: "n0",
        toNodeId: "n1",
        highwayClass: "secondary",
        geometry: [
          [0, 0],
          [200, 0],
        ],
        lengthM: 200,
        speedLimitKph: 60,
        laneIds: ["l0:0"],
      },
    ],
    lanes: [
      {
        id: "l0:0",
        linkId: "l0",
        index: 0,
        startS: 0,
        endS: 200,
        kind: "general",
        allowed: ["car", "bus", "trolleybus", "taxi"],
        turns: ["through"],
      },
    ],
    connectors: [],
    gates: [
      { id: "g0", nodeId: "n0", inLinkIds: ["l0"], weightIn: 1, weightOut: 0 },
      { id: "g1", nodeId: "n1", outLinkIds: ["l0"], weightIn: 0, weightOut: 1 },
    ],
  };
}

describe("network contract", () => {
  it("parses a minimal network and applies defaults", () => {
    const net = parseNetwork(tinyNetwork());
    expect(net.lanes[0]?.widthM).toBe(3.5);
    expect(net.buildings).toEqual([]);
    expect(checkNetworkIntegrity(net)).toEqual([]);
  });

  it("reports referential errors instead of throwing", () => {
    const raw = tinyNetwork();
    const link0 = raw.links[0];
    if (!link0) throw new Error("fixture has no links");
    link0.toNodeId = "missing";
    const net = parseNetwork(raw);
    const errors = checkNetworkIntegrity(net);
    expect(errors.some((e) => e.includes("toNodeId missing"))).toBe(true);
  });

  it("computes cycle length from phases", () => {
    expect(
      cycleLengthS({
        phases: [
          { id: "p1", greenGroupIds: ["a"], greenS: 30, yellowS: 3, allRedS: 2 },
          { id: "p2", greenGroupIds: ["b"], greenS: 25, yellowS: 3, allRedS: 2 },
        ],
      }),
    ).toBe(65);
  });
});

describe("sim config contract", () => {
  it("fills every default", () => {
    const cfg = defaultSimConfig();
    expect(cfg.dtS).toBe(0.1);
    expect(cfg.demand.vehicleBudget).toBe(20000);
    expect(cfg.driver.timeHeadwayS.mean).toBe(1.2);
    expect(cfg.vehicleClasses.bus.occupancyPeak).toBe(40);
    expect(cfg.metrics.bottleneck.speedRatioMax).toBe(0.3);
  });

  it("applies deep patches without losing siblings", () => {
    const cfg = applyConfigPatch(defaultSimConfig(), { demand: { multiplier: 1.5 } });
    expect(cfg.demand.multiplier).toBe(1.5);
    expect(cfg.demand.vehicleBudget).toBe(20000);
  });

  it("rejects invalid values", () => {
    expect(() => defaultSimConfig({ behavior: { gridlockDiscipline: 2 } })).toThrow();
  });
});

describe("scenario contract", () => {
  it("baseline has no overrides", () => {
    const s = baselineScenario("tiny");
    expect(s.overrides).toEqual([]);
    expect(ScenarioSchema.parse(s).id).toBe("baseline");
  });

  it("validates typed overrides", () => {
    const s = ScenarioSchema.parse({
      id: "s1",
      name: "Стрелка налево",
      networkId: "tiny",
      overrides: [{ kind: "signal", nodeId: "n5", set: { leftTurnModes: { l1: "protected" } } }],
    });
    expect(s.overrides[0]?.kind).toBe("signal");
  });
});

describe("causes and buffers", () => {
  it("cause codes are dense and stable", () => {
    for (const [i, c] of CAUSES.entries()) expect(c.code).toBe(i);
    expect(CAUSE_COUNT).toBe(CAUSES.length);
  });

  it("frame buffers transfer every array", () => {
    const f = allocateFrameBuffers(10, 4, 2);
    expect(frameTransferList(f).length).toBe(10);
    expect(f.signalStates.length).toBe(4);
  });

  it("maps V/C to LOS", () => {
    expect(losFromVc(0.2)).toBe("A");
    expect(losFromVc(0.95)).toBe("E");
    expect(losFromVc(1.2)).toBe("F");
  });
});
