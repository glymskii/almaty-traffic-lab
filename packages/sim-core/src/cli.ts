// determinism-check: allow-wall-clock
/**
 * Headless runner: `pnpm sim --network <file> --minutes <n> --seed <n> [--bbox small|big]
 * [--start HH:MM] [--scenario <file>] [--json <out>] [--bench] [--quiet]`.
 *
 * Runs `createSimulation` to completion (warm-up + measurement minutes), prints `totals` and the
 * top bottlenecks with their cause breakdown, and optionally writes a `RunSummary` JSON file.
 * `--bench` skips the report (T-19: a `report()` call is not free) and instead times three fresh
 * runs of the stepping loop itself.
 *
 * The functions below are exported so `cli/regress.ts` can build and run the very same
 * (network, config) setup without spawning a second process.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyConfigPatch,
  defaultSimConfig,
  type Network,
  type RunSummary,
  RunSummarySchema,
  type Scenario,
  type SimConfig,
} from "@atl/contracts";
import { applyOverrides } from "@atl/map-data";
import { parseRunArgs, type RunArgs, readNetworkFile, readScenarioFile } from "./cli/args.ts";
import { type BenchRun, printBenchResults, printProgress, printReport } from "./cli/print.ts";
import { createSimulation, type Simulation } from "./simulation.ts";

const USAGE =
  "usage: pnpm sim (--network <file> | --bbox small|big) --minutes <n> [--seed <n>] " +
  "[--start HH:MM] [--scenario <file>] [--json <out>] [--bench] [--quiet]";

export interface RunSetup {
  network: Network;
  config: SimConfig;
  scenarioId?: string;
}

/**
 * Resolves a scenario (if any) into the (network, config) a run starts from: `params` patch the
 * base config, `overrides` are re-applied to the network through `@atl/map-data`'s `applyOverrides`
 * -- the only place that logic lives (docs/CONTRACTS.md "Scenario и overrides").
 */
export function buildRunSetup(opts: {
  network: Network;
  seed: number;
  startMin?: number;
  scenario?: Scenario;
}): RunSetup {
  let config = defaultSimConfig({
    seed: opts.seed,
    ...(opts.startMin === undefined ? {} : { startTimeMin: opts.startMin }),
  });
  const scenario = opts.scenario;
  if (scenario === undefined) return { network: opts.network, config };

  config = applyConfigPatch(config, scenario.params);
  const network =
    scenario.overrides.length > 0
      ? applyOverrides(opts.network, scenario.overrides, config, scenario.id)
      : opts.network;
  return { network, config, scenarioId: scenario.id };
}

interface LoopResult {
  wallMs: number;
  vehiclesMean: number;
  totalS: number;
}

/**
 * Steps `sim` from 0 to `warmup + minutes` in a handful of checkpoints, printing progress on
 * stderr between them (unless `quiet`) and sampling `vehicleCount()` at each checkpoint for the
 * informational `perf.vehiclesMean`. Never calls `report()` -- callers that need one call it once,
 * after this returns (T-19's budget note: a report over a full network is not cheap).
 */
function runLoop(sim: Simulation, config: SimConfig, minutes: number, quiet: boolean): LoopResult {
  const warmupS = config.demand.warmupMinutes * 60;
  const totalS = warmupS + minutes * 60;
  const CHECKPOINTS = 20;
  const checkpointS = Math.max(config.dtS, totalS / CHECKPOINTS);

  const startedAt = performance.now();
  let elapsed = 0;
  let vehicleSum = 0;
  let samples = 0;
  while (elapsed < totalS - 1e-9) {
    const next = Math.min(elapsed + checkpointS, totalS);
    sim.runUntil(next);
    elapsed = next;
    vehicleSum += sim.vehicleCount();
    samples++;
    if (!quiet) {
      if (elapsed <= warmupS) printProgress("прогрев", warmupS > 0 ? elapsed / warmupS : 1);
      else printProgress("прогон", (elapsed - warmupS) / Math.max(1e-9, totalS - warmupS));
    }
  }
  return {
    wallMs: performance.now() - startedAt,
    vehiclesMean: samples > 0 ? vehicleSum / samples : 0,
    totalS,
  };
}

/** Runs `setup` to completion and builds the `RunSummary` (one `report()` call at the end). */
export function runSimulation(
  setup: RunSetup,
  minutes: number,
  quiet: boolean,
): { summary: RunSummary; sim: Simulation } {
  const sim = createSimulation({
    network: setup.network,
    config: setup.config,
    ...(setup.scenarioId === undefined ? {} : { scenarioId: setup.scenarioId }),
  });
  const { wallMs, vehiclesMean, totalS } = runLoop(sim, setup.config, minutes, quiet);
  const report = sim.report();
  const summary = RunSummarySchema.parse({
    networkId: sim.network.meta.networkId,
    scenarioId: sim.scenarioId,
    seed: setup.config.seed,
    simulatedS: sim.simTimeS,
    trajectoryHash: sim.trajectoryHash(),
    totals: report.totals,
    top: report.items,
    perf: {
      wallMs,
      stepsPerS: totalS / setup.config.dtS / (wallMs / 1000),
      vehiclesMean,
    },
  });
  return { summary, sim };
}

/** `--bench`: times the stepping loop alone, with no `report()` call. */
export function runBench(setup: RunSetup, minutes: number): BenchRun {
  const sim = createSimulation({
    network: setup.network,
    config: setup.config,
    ...(setup.scenarioId === undefined ? {} : { scenarioId: setup.scenarioId }),
  });
  const { wallMs, vehiclesMean, totalS } = runLoop(sim, setup.config, minutes, true);
  return { wallMs, vehiclesMean, stepsPerS: totalS / setup.config.dtS / (wallMs / 1000) };
}

async function main(): Promise<void> {
  let args: RunArgs;
  try {
    args = parseRunArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`sim: ${(err as Error).message}`);
    console.error(USAGE);
    process.exit(2);
  }

  const network = readNetworkFile(args.networkPath);
  const scenario =
    args.scenarioPath === undefined ? undefined : readScenarioFile(args.scenarioPath);
  const setup = buildRunSetup({
    network,
    seed: args.seed,
    ...(args.startMin === undefined ? {} : { startMin: args.startMin }),
    ...(scenario === undefined ? {} : { scenario }),
  });

  if (args.bench) {
    const runs: BenchRun[] = [];
    for (let i = 0; i < 3; i++) runs.push(runBench(setup, args.minutes));
    printBenchResults(runs);
    return;
  }

  const { summary } = runSimulation(setup, args.minutes, args.quiet);
  if (!args.quiet) printReport(summary);

  if (args.jsonOutPath !== undefined) {
    mkdirSync(dirname(args.jsonOutPath), { recursive: true });
    writeFileSync(args.jsonOutPath, `${JSON.stringify(summary, null, 2)}\n`);
    if (!args.quiet) console.error(`sim: wrote ${args.jsonOutPath}`);
  }
}

// Only run when this file is the process entry point (`node src/cli.ts`), not when
// `cli/regress.ts` imports `buildRunSetup`/`runSimulation` to reuse the same logic.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`sim: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
