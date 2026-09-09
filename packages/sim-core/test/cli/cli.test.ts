/**
 * T-20: end-to-end smoke test for `src/cli.ts`, spawned as a real process (the way `pnpm sim` and
 * the future CI regression job run it), not imported -- this is the only test that actually
 * exercises argv parsing, file I/O and the `node src/cli.ts` entry-point guard.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunSummarySchema } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { crossroads } from "../fixtures/builders.ts";

const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

describe("headless CLI (cli.ts)", () => {
  it("runs a synthetic network for 2 minutes and writes a RunSummary the contract accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "atl-sim-cli-"));
    const networkPath = join(dir, "network.json");
    const jsonPath = join(dir, "summary.json");
    writeFileSync(networkPath, JSON.stringify(crossroads()));

    try {
      const stdout = execFileSync(
        process.execPath,
        [CLI_PATH, "--network", networkPath, "--minutes", "2", "--seed", "1", "--json", jsonPath],
        // stderr carries the warm-up/measurement progress line; ignore it so it doesn't clutter
        // the test runner's output (execFileSync inherits stderr by default).
        { encoding: "utf8", timeout: 55_000, stdio: ["ignore", "pipe", "ignore"] },
      );

      expect(stdout).toContain("totals:");
      expect(stdout).toContain("top");

      const summary = RunSummarySchema.parse(JSON.parse(readFileSync(jsonPath, "utf8")));
      expect(summary.networkId).toBe("crossroads");
      expect(summary.scenarioId).toBe("baseline");
      expect(summary.seed).toBe(1);
      // Warm-up (default 10 min) + the 2 requested minutes.
      expect(summary.simulatedS).toBeCloseTo(12 * 60, 6);
      expect(summary.trajectoryHash.length).toBeGreaterThan(0);
      expect(summary.totals.vehiclesActive).toBeGreaterThanOrEqual(0);
      expect(summary.top.length).toBeLessThanOrEqual(10);
      for (let i = 0; i < summary.top.length; i++) {
        expect(summary.top[i]?.rank).toBe(i + 1);
      }
      expect(summary.perf?.wallMs).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits with a usage error (code 2) when neither --network nor --bbox is given", () => {
    expect.assertions(1);
    try {
      execFileSync(process.execPath, [CLI_PATH, "--minutes", "1"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      expect((err as { status: number }).status).toBe(2);
    }
  });
});
