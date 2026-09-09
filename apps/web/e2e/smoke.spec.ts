import { expect, test } from "@playwright/test";

/**
 * docs/tasks/T-30 acceptance check: the built app mounts a canvas, renders a handful of frames,
 * and logs nothing to the console. `window.__atl.frames` (scene/renderer.ts) is the liveness
 * signal - it needs no pixel reading and no sim/worker internals, so this stays a plain "does it
 * come up at all" smoke test rather than a behavioural one.
 *
 * MIN_FRAMES/FRAMES_TIMEOUT_MS and the `--enable-unsafe-swiftshader` launch flag below (see
 * playwright.config.ts) are sized for GitHub Actions' software-rendered Chromium, which without
 * that flag never gets a WebGL context at all, and even with it renders far fewer frames per
 * second than a real GPU - see "Заметки после ревью" in docs/tasks/T-30-ci-smoke-deploy.md.
 */
const MIN_FRAMES = 3;
const FRAMES_TIMEOUT_MS = 25_000;

test("app boots, renders frames and stays quiet in the console", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => window.__atl?.frames ?? 0), {
      timeout: FRAMES_TIMEOUT_MS,
      intervals: [250],
    })
    .toBeGreaterThanOrEqual(MIN_FRAMES);

  expect(consoleErrors).toEqual([]);
});
