// determinism-check: allow-wall-clock
/**
 * Headless runner: `pnpm sim --network data/networks/<id>.network.json.gz --minutes 10 --seed 1 [--scenario file] [--json out]`
 * Prints totals and the top-N bottlenecks with cause breakdown; writes a RunSummary when --json is given.
 * Implemented in T-20 (uses createSimulation; no rendering).
 */
console.error("sim CLI not implemented yet: see docs/tasks/T-20-cli-runner.md");
process.exit(2);
