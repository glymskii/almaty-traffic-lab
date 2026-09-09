import { defineConfig, devices } from "@playwright/test";

/**
 * docs/tasks/T-30: one Playwright smoke test against a production build. `webServer` builds the
 * app and serves it with `vite preview` (not `vite dev`) so the test exercises the same static
 * bundle Vercel deploys, then tears the server down after the run - no compiled network is
 * required (`src/data/loadNetwork.ts` falls back to the built-in demo network when
 * `data/networks/` is empty, which `predev`/`prebuild`'s copy step already handles).
 *
 * `channel: "chromium"` pins the full Chrome binary Playwright installs alongside its lightweight
 * "headless shell" (both come from `playwright install chromium`) and skips that shell. Measured
 * locally: the headless shell throttles requestAnimationFrame on this WebGL canvas to ~1-2 fps
 * (a GPU-readback stall logged as "GPU stall due to ReadPixels" on every frame), which alone makes
 * the "≥ 10 frames in 15s" acceptance check flaky; the full browser's headless mode renders this
 * page at 30+ fps with no such stall.
 */
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm run build && pnpm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } }],
});
