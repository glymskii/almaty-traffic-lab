import {
  baselineScenario,
  type NetworkOverride,
  type Scenario,
  ScenarioSchema,
} from "@atl/contracts";

/**
 * Scenario CRUD + localStorage persistence (docs/tasks/T-24 п.3). Pure and framework-free on
 * purpose: `state/store.ts` wires this into the zustand store, and the reducer/serialization
 * logic is unit-tested here without touching React (apps/web/test/scenarios.test.ts).
 */

const STORAGE_KEY = "atl.scenarios.v1";

/** The synthetic "no overrides" scenario every network has (contracts: `baselineScenario`). */
export const BASELINE_SCENARIO_ID = "baseline";

function newId(): string {
  // crypto.randomUUID() is available in every browser this app targets and in Node 22's global
  // scope (tests); the fallback only matters for an environment neither of those provide.
  const c: { randomUUID?: () => string } = globalThis.crypto ?? {};
  if (typeof c.randomUUID === "function") return c.randomUUID();
  return `scenario-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Reads every stored scenario, dropping anything that no longer parses as a `Scenario` (a
 * schema change or hand-edited localStorage) instead of failing the whole list. */
export function loadStoredScenarios(): Scenario[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Scenario[] = [];
  for (const entry of parsed) {
    const result = ScenarioSchema.safeParse(entry);
    if (result.success) out.push(result.data);
  }
  return out;
}

export function persistScenarios(scenarios: readonly Scenario[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenarios));
  } catch {
    // Private browsing / storage quota - the scenario still lives in the in-memory store for
    // this session, it just won't survive a reload. Not worth surfacing as an error.
  }
}

/** Scenarios authored against this network, baseline first, in storage order otherwise. */
export function scenariosForNetwork(all: readonly Scenario[], networkId: string): Scenario[] {
  return [baselineScenario(networkId), ...all.filter((s) => s.networkId === networkId)];
}

export function createScenario(name: string, networkId: string, id: string = newId()): Scenario {
  return ScenarioSchema.parse({ id, name, networkId, overrides: [], params: {} });
}

/** Copies overrides and params under a new id; `createdAt`/`updatedAt` are not carried over. */
export function duplicateScenario(source: Scenario, name: string, id: string = newId()): Scenario {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = source;
  return ScenarioSchema.parse({ ...rest, id, name });
}

export function renameScenario(scenario: Scenario, name: string): Scenario {
  return { ...scenario, name, updatedAt: nowIso() };
}

/** Replaces `scenarios[i]` (matched by id) with `updated`, or leaves the list alone if it's gone
 * (e.g. deleted from another tab) - callers read the list back and re-render either way. */
export function replaceScenario(scenarios: readonly Scenario[], updated: Scenario): Scenario[] {
  return scenarios.map((s) => (s.id === updated.id ? updated : s));
}

export function removeScenario(scenarios: readonly Scenario[], id: string): Scenario[] {
  return scenarios.filter((s) => s.id !== id);
}

/** The one field of a `NetworkOverride` that names the entity it edits. */
function overrideRefId(override: NetworkOverride): string {
  switch (override.kind) {
    case "link":
      return override.linkId;
    case "signal":
      return override.nodeId;
    case "bus_stop":
      return override.stopId;
    case "bus_route":
      return override.routeId;
  }
}

/** Identifies "the same override slot" - one scenario holds at most one override per (kind, entity). */
export function overrideKey(kind: NetworkOverride["kind"], refId: string): string {
  return `${kind}:${refId}`;
}

/**
 * Adds `override` to the scenario, replacing any earlier override of the same kind for the same
 * entity (a form's "Применить" always submits the full current state of every field it owns, so
 * replacing - rather than deep-merging - is correct and keeps this simple).
 */
export function upsertOverride(scenario: Scenario, override: NetworkOverride): Scenario {
  const key = overrideKey(override.kind, overrideRefId(override));
  const overrides = scenario.overrides.filter((o) => overrideKey(o.kind, overrideRefId(o)) !== key);
  overrides.push(override);
  return { ...scenario, overrides, updatedAt: nowIso() };
}

export function removeOverride(
  scenario: Scenario,
  kind: NetworkOverride["kind"],
  refId: string,
): Scenario {
  const key = overrideKey(kind, refId);
  return {
    ...scenario,
    overrides: scenario.overrides.filter((o) => overrideKey(o.kind, overrideRefId(o)) !== key),
    updatedAt: nowIso(),
  };
}

export function findOverride(
  scenario: Scenario,
  kind: NetworkOverride["kind"],
  refId: string,
): NetworkOverride | undefined {
  const key = overrideKey(kind, refId);
  return scenario.overrides.find((o) => overrideKey(o.kind, overrideRefId(o)) === key);
}

export function exportScenarioJson(scenario: Scenario): string {
  return JSON.stringify(scenario, null, 2);
}

/**
 * A structured import failure - carries no message of its own so the UI layer (ScenariosTab, the
 * only place that shows it) renders it entirely from `i18n/ru.ts`, `networkId` filled in only for
 * "mismatch" (the ru.ts template needs it).
 */
export class ScenarioImportError extends Error {
  readonly code: "invalid_json" | "invalid_schema" | "network_mismatch";
  readonly networkId: string | undefined;
  constructor(code: ScenarioImportError["code"], networkId?: string) {
    super(code);
    this.code = code;
    this.networkId = networkId;
  }
}

/** Parses and validates an imported scenario file, and rejects one authored for another network -
 * its link/node ids would not resolve against `expectedNetworkId`'s network at all. */
export function parseImportedScenario(json: string, expectedNetworkId: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ScenarioImportError("invalid_json");
  }
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) {
    throw new ScenarioImportError("invalid_schema");
  }
  if (result.data.networkId !== expectedNetworkId) {
    throw new ScenarioImportError("network_mismatch", result.data.networkId);
  }
  return result.data;
}

function nowIso(): string {
  return new Date().toISOString();
}
