/**
 * Argv parsing and file I/O shared by `cli.ts` and `cli/regress.ts`. No simulation logic here.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { type Network, parseNetwork, type Scenario, ScenarioSchema } from "@atl/contracts";
import { getBBox } from "@atl/map-data";

/** Tiny argv parser: `--key value`, `--flag`. Mirrors `@atl/map-data`'s `cli/args.ts`. */
export function parseArgv(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

/** Repository root; this file lives in packages/sim-core/src/cli. */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** CLI paths are relative to the repository root, whatever pnpm's working directory is. */
export function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/** Reads a `Network` from a `.json` or `.json.gz` file (same format `@atl/map-data` compiles). */
export function readNetworkFile(path: string): Network {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return parseNetwork(JSON.parse(text));
}

/** Reads and validates a `Scenario` JSON file. */
export function readScenarioFile(path: string): Scenario {
  const raw = readFileSync(path, "utf8");
  return ScenarioSchema.parse(JSON.parse(raw));
}

/** "HH:MM" -> minutes since midnight. Throws on a malformed string. */
export function parseTimeOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid --start "${hhmm}"; expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid --start "${hhmm}"; expected HH:MM`);
  return h * 60 + min;
}

/** `--network <path>` or `--bbox small|big` (synonym for `data/networks/<id>.network.json.gz`). */
export function resolveNetworkPath(args: Record<string, string | boolean>): string {
  const network = args.network;
  if (typeof network === "string") return fromRepoRoot(network);
  const bbox = args.bbox;
  if (typeof bbox === "string") {
    const preset = getBBox(bbox);
    return fromRepoRoot(`data/networks/${preset.id}.network.json.gz`);
  }
  throw new Error("specify --network <file> or --bbox small|big");
}

export interface RunArgs {
  networkPath: string;
  seed: number;
  minutes: number;
  startMin?: number;
  scenarioPath?: string;
  jsonOutPath?: string;
  bench: boolean;
  quiet: boolean;
}

/** Parses and validates the arguments of the main `pnpm sim` entry point. */
export function parseRunArgs(argv: string[]): RunArgs {
  const args = parseArgv(argv);
  const networkPath = resolveNetworkPath(args);

  const minutesRaw = args.minutes;
  if (typeof minutesRaw !== "string") throw new Error("specify --minutes <n>");
  const minutes = Number(minutesRaw);
  if (!(minutes > 0)) throw new Error(`invalid --minutes "${minutesRaw}"`);

  const seedRaw = args.seed;
  const seed = seedRaw === undefined ? 1 : Number(seedRaw);
  if (!Number.isInteger(seed)) throw new Error(`invalid --seed "${String(seedRaw)}"`);

  const startMin = typeof args.start === "string" ? parseTimeOfDay(args.start) : undefined;
  const scenarioPath = typeof args.scenario === "string" ? fromRepoRoot(args.scenario) : undefined;
  const jsonOutPath = typeof args.json === "string" ? fromRepoRoot(args.json) : undefined;

  return {
    networkPath,
    seed,
    minutes,
    ...(startMin === undefined ? {} : { startMin }),
    ...(scenarioPath === undefined ? {} : { scenarioPath }),
    ...(jsonOutPath === undefined ? {} : { jsonOutPath }),
    bench: args.bench === true,
    quiet: args.quiet === true,
  };
}
