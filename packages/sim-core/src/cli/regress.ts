/**
 * Regression runner: `pnpm sim:regress` replays every `data/golden/*.json` case (network, seed,
 * minutes) and compares the result against the recorded expectation; `pnpm sim:golden`
 * (re)creates them by actually running the simulation and recording its current output as truth.
 *
 * A golden file mixes the run spec and the expectation on purpose (self-contained, one file per
 * case). `totals` are compared with a 5% relative tolerance (T-18: the windowed numbers wobble a
 * few percent depending on exactly when `report()` lands); `top` only compares the first three
 * `id`s, exactly (T-19: `delayVehH` itself is not stable enough to freeze, but which bottleneck
 * comes out on top is). `trajectoryHash` is only compared with `--strict`, since it is sensitive
 * to anything at all changing in the stepping order.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { BottleneckItem, NetworkTotals } from "@atl/contracts";
import { buildRunSetup, runSimulation } from "../cli.ts";
import { fromRepoRoot, readNetworkFile, readScenarioFile } from "./args.ts";

const GOLDEN_DIR = fromRepoRoot("data/golden");
/** Falls back to this synthetic fixture when the small-square network has not been compiled. */
const CROSSROADS_NETWORK_REL = "data/golden/crossroads.network.json";
const SMALL_SQUARE_NETWORK_REL = "data/networks/almaty-abay-small.network.json.gz";
const DEFAULT_SEED = 1;
const DEFAULT_MINUTES = 10;
const TOTALS_TOLERANCE = 0.05;

/** Absolute floor added to the 5% relative tolerance so a near-zero expectation isn't unfairly tight. */
const TOTALS_ABS_FLOOR: Partial<Record<keyof NetworkTotals, number>> = {
  vehiclesActive: 2,
  vehiclesCompleted: 2,
  delayVehH: 0.05,
  delayPersonH: 0.1,
  meanSpeedKph: 0.5,
  carMeanSpeedKph: 0.5,
  busMeanSpeedKph: 0.5,
  stoppedShare: 0.01,
  congestedSegmentShare: 0.01,
};

interface GoldenTopEntry {
  rank: number;
  id: string;
  /** Largest cause share at generation time; informational, not part of the comparison. */
  dominantCause: string;
}

interface GoldenCase {
  id: string;
  description?: string;
  /** Path to the network file, relative to the repository root. */
  network: string;
  seed: number;
  minutes: number;
  /** Path to a Scenario JSON file, relative to the repository root. */
  scenario?: string;
  totals: NetworkTotals;
  top: GoldenTopEntry[];
  trajectoryHash: string;
}

function listGoldenFiles(): string[] {
  if (!existsSync(GOLDEN_DIR)) return [];
  return readdirSync(GOLDEN_DIR)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".network.json"))
    .sort()
    .map((name) => `${GOLDEN_DIR}/${name}`);
}

function loadGoldenCase(path: string): GoldenCase {
  return JSON.parse(readFileSync(path, "utf8")) as GoldenCase;
}

function withinTolerance(expected: number, actual: number, floor: number): boolean {
  return Math.abs(actual - expected) <= Math.max(TOTALS_TOLERANCE * Math.abs(expected), floor);
}

function compareTotals(expected: NetworkTotals, actual: NetworkTotals): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(expected) as (keyof NetworkTotals)[]) {
    const e = expected[key];
    const a = actual[key];
    if (!withinTolerance(e, a, TOTALS_ABS_FLOOR[key] ?? 0)) {
      mismatches.push(`totals.${key}: expected ${e}, got ${a}`);
    }
  }
  return mismatches;
}

/** Only the first three ranks, exactly, in order (T-19 note: ids are stable, raw numbers are not). */
function compareTop(expected: GoldenTopEntry[], actual: readonly BottleneckItem[]): string[] {
  const n = Math.max(expected.length, actual.length, 0);
  const mismatches: string[] = [];
  for (let i = 0; i < Math.min(3, n); i++) {
    const e = expected[i]?.id;
    const a = actual[i]?.id;
    if (e !== a) mismatches.push(`top[${i}].id: expected ${e ?? "—"}, got ${a ?? "—"}`);
  }
  return mismatches;
}

function runGoldenCase(golden: GoldenCase, strict: boolean): string[] {
  const network = readNetworkFile(fromRepoRoot(golden.network));
  const scenario =
    golden.scenario === undefined ? undefined : readScenarioFile(fromRepoRoot(golden.scenario));
  const setup = buildRunSetup({
    network,
    seed: golden.seed,
    ...(scenario === undefined ? {} : { scenario }),
  });
  const { summary } = runSimulation(setup, golden.minutes, true);

  const mismatches = [
    ...compareTotals(golden.totals, summary.totals),
    ...compareTop(golden.top, summary.top),
  ];
  if (strict && golden.trajectoryHash !== summary.trajectoryHash) {
    mismatches.push(
      `trajectoryHash: expected ${golden.trajectoryHash}, got ${summary.trajectoryHash}`,
    );
  }
  return mismatches;
}

function runRegression(strict: boolean): boolean {
  const files = listGoldenFiles();
  if (files.length === 0) {
    console.error(`sim:regress: no golden cases in ${GOLDEN_DIR}; run "pnpm sim:golden" first`);
    return false;
  }
  let allOk = true;
  for (const file of files) {
    // One broken or stale case (a missing network file, a hand-edited golden JSON) must not hide
    // the result of every other case, so it is reported as a failure, not a crash of the batch.
    let id = file;
    let mismatches: string[];
    try {
      const golden = loadGoldenCase(file);
      id = golden.id;
      mismatches = runGoldenCase(golden, strict);
    } catch (err) {
      mismatches = [err instanceof Error ? err.message : String(err)];
    }
    const ok = mismatches.length === 0;
    allOk = allOk && ok;
    console.log(`${ok ? "OK  " : "FAIL"} ${id}`);
    for (const m of mismatches) console.log(`     ${m}`);
  }
  return allOk;
}

/**
 * (Re)creates the default golden case: the small square if it has been compiled, otherwise the
 * `crossroads()` synthetic fixture, serialized once to `data/golden/crossroads.network.json` so
 * later regression runs don't need `test/fixtures/builders.ts` at all.
 */
async function writeDefaultGolden(): Promise<void> {
  mkdirSync(GOLDEN_DIR, { recursive: true });

  let id: string;
  let networkRel: string;
  if (existsSync(fromRepoRoot(SMALL_SQUARE_NETWORK_REL))) {
    id = "small-square";
    networkRel = SMALL_SQUARE_NETWORK_REL;
  } else {
    id = "crossroads";
    networkRel = CROSSROADS_NETWORK_REL;
    const { crossroads } = await import("../../test/fixtures/builders.ts");
    writeFileSync(fromRepoRoot(networkRel), `${JSON.stringify(crossroads(), null, 2)}\n`);
  }

  const network = readNetworkFile(fromRepoRoot(networkRel));
  const setup = buildRunSetup({ network, seed: DEFAULT_SEED });
  const { summary } = runSimulation(setup, DEFAULT_MINUTES, true);

  const golden: GoldenCase = {
    id,
    network: networkRel,
    seed: DEFAULT_SEED,
    minutes: DEFAULT_MINUTES,
    totals: summary.totals,
    top: summary.top.slice(0, 3).map((item) => ({
      rank: item.rank,
      id: item.id,
      dominantCause: item.causes[0]?.cause ?? "none",
    })),
    trajectoryHash: summary.trajectoryHash,
  };
  const outPath = fromRepoRoot(`data/golden/${id}.json`);
  writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(
    `sim:golden: wrote ${outPath} (network ${networkRel}, seed ${DEFAULT_SEED}, ${DEFAULT_MINUTES} min)`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--write")) {
    await writeDefaultGolden();
    return;
  }
  const ok = runRegression(argv.includes("--strict"));
  process.exit(ok ? 0 : 1);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`sim:regress: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
