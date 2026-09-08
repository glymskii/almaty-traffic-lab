import type { NetworkOverride, Scenario } from "@atl/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BASELINE_SCENARIO_ID,
  createScenario,
  duplicateScenario,
  exportScenarioJson,
  findOverride,
  loadStoredScenarios,
  overrideKey,
  parseImportedScenario,
  persistScenarios,
  removeOverride,
  removeScenario,
  renameScenario,
  replaceScenario,
  ScenarioImportError,
  scenariosForNetwork,
  upsertOverride,
} from "../src/state/scenarios.ts";

const NETWORK_ID = "almaty-abay-small";

const linkOverride: NetworkOverride = {
  kind: "link",
  linkId: "l0",
  set: { generalLanes: 3 },
};

beforeEach(() => {
  localStorage.clear();
});

describe("createScenario / duplicateScenario / renameScenario", () => {
  it("creates an empty scenario for a network", () => {
    const s = createScenario("Час пик", NETWORK_ID, "s1");
    expect(s).toMatchObject({ id: "s1", name: "Час пик", networkId: NETWORK_ID, overrides: [] });
  });

  it("duplicates overrides under a new id, dropping timestamps", () => {
    const source = upsertOverride(createScenario("A", NETWORK_ID, "s1"), linkOverride);
    const copy = duplicateScenario(source, "A (копия)", "s2");
    expect(copy.id).toBe("s2");
    expect(copy.name).toBe("A (копия)");
    expect(copy.overrides).toEqual(source.overrides);
    expect(copy.createdAt).toBeUndefined();
    expect(copy.updatedAt).toBeUndefined();
  });

  it("renames a scenario and stamps updatedAt", () => {
    const s = createScenario("A", NETWORK_ID, "s1");
    const renamed = renameScenario(s, "B");
    expect(renamed.name).toBe("B");
    expect(renamed.updatedAt).toBeDefined();
    expect(s.name).toBe("A"); // the source is untouched
  });
});

describe("overrides: upsert / remove / find", () => {
  it("adds a new override", () => {
    const s = createScenario("A", NETWORK_ID, "s1");
    const out = upsertOverride(s, linkOverride);
    expect(out.overrides).toEqual([linkOverride]);
  });

  it("replaces an override for the same (kind, entity) instead of appending", () => {
    const s = upsertOverride(createScenario("A", NETWORK_ID, "s1"), linkOverride);
    const updated: NetworkOverride = { kind: "link", linkId: "l0", set: { speedLimitKph: 40 } };
    const out = upsertOverride(s, updated);
    expect(out.overrides).toEqual([updated]);
  });

  it("keeps overrides for different entities independent", () => {
    const other: NetworkOverride = { kind: "link", linkId: "l1", set: { generalLanes: 2 } };
    let s = createScenario("A", NETWORK_ID, "s1");
    s = upsertOverride(s, linkOverride);
    s = upsertOverride(s, other);
    expect(s.overrides).toHaveLength(2);
    expect(findOverride(s, "link", "l0")).toEqual(linkOverride);
    expect(findOverride(s, "link", "l1")).toEqual(other);
  });

  it("removes an override by kind + entity id", () => {
    const s = upsertOverride(createScenario("A", NETWORK_ID, "s1"), linkOverride);
    const out = removeOverride(s, "link", "l0");
    expect(out.overrides).toEqual([]);
  });

  it("keys signal/bus_stop/bus_route overrides by their own id field", () => {
    expect(overrideKey("signal", "center")).toBe("signal:center");
    expect(overrideKey("bus_stop", "stop0")).toBe("bus_stop:stop0");
    expect(overrideKey("bus_route", "route0")).toBe("bus_route:route0");
  });
});

describe("scenariosForNetwork", () => {
  it("always includes the baseline scenario first, then scenarios of that network", () => {
    const a = createScenario("A", NETWORK_ID, "s1");
    const b = createScenario("B", "other-network", "s2");
    const list = scenariosForNetwork([a, b], NETWORK_ID);
    expect(list.map((s) => s.id)).toEqual([BASELINE_SCENARIO_ID, "s1"]);
  });
});

describe("localStorage persistence", () => {
  it("round-trips through persistScenarios / loadStoredScenarios", () => {
    const s = upsertOverride(createScenario("A", NETWORK_ID, "s1"), linkOverride);
    persistScenarios([s]);
    expect(loadStoredScenarios()).toEqual([s]);
  });

  it("returns an empty list when nothing is stored", () => {
    expect(loadStoredScenarios()).toEqual([]);
  });

  it("drops entries that no longer validate instead of failing the whole read", () => {
    localStorage.setItem(
      "atl.scenarios.v1",
      JSON.stringify([{ id: "broken" /* missing required fields */ }]),
    );
    expect(loadStoredScenarios()).toEqual([]);
  });

  it("replaceScenario / removeScenario update the stored list by id", () => {
    const a = createScenario("A", NETWORK_ID, "s1");
    const b = createScenario("B", NETWORK_ID, "s2");
    const renamedA = renameScenario(a, "A2");
    expect(replaceScenario([a, b], renamedA)).toEqual([renamedA, b]);
    expect(removeScenario([a, b], "s1")).toEqual([b]);
  });
});

describe("export / import", () => {
  it("exports valid, re-importable JSON", () => {
    const s = upsertOverride(createScenario("A", NETWORK_ID, "s1"), linkOverride);
    const json = exportScenarioJson(s);
    expect(parseImportedScenario(json, NETWORK_ID)).toEqual(s);
  });

  it("rejects a scenario authored for a different network", () => {
    const s = createScenario("A", "other-network", "s1");
    try {
      parseImportedScenario(exportScenarioJson(s), NETWORK_ID);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioImportError);
      expect((error as ScenarioImportError).code).toBe("network_mismatch");
      expect((error as ScenarioImportError).networkId).toBe("other-network");
    }
  });

  it("rejects invalid JSON and a value that doesn't match the schema", () => {
    expect(() => parseImportedScenario("not json", NETWORK_ID)).toThrow(ScenarioImportError);
    expect(() => parseImportedScenario("{}", NETWORK_ID)).toThrow(ScenarioImportError);
  });
});

describe("baselineScenario stays synthetic", () => {
  it("is not something loadStoredScenarios ever returns on its own", () => {
    const s: Scenario = createScenario("A", NETWORK_ID, "s1");
    persistScenarios([s]);
    expect(loadStoredScenarios().some((x) => x.id === BASELINE_SCENARIO_ID)).toBe(false);
  });
});
