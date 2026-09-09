import { expect, test } from "@playwright/test";

/**
 * docs/tasks/T-30 acceptance check: the built app mounts a canvas, renders at least 10 frames
 * within 15s, and logs nothing to the console. `window.__atl.frames` (scene/renderer.ts) is the
 * liveness signal - it needs no pixel reading and no sim/worker internals, so this stays a plain
 * "does it come up at all" smoke test rather than a behavioural one.
 */
const MIN_FRAMES = 10;
const FRAMES_TIMEOUT_MS = 15_000;

test("app boots, renders frames and stays quiet in the console", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log("[DEBUG console:error]", message.text());
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    console.log("[DEBUG pageerror]", error.message, error.stack);
    consoleErrors.push(error.message);
  });

  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeVisible();

  await expect
    .poll(
      async () => {
        const f = await page.evaluate(() => window.__atl?.frames ?? 0);
        console.log(`[DEBUG] t=${Date.now()} frames=${f}`);
        return f;
      },
      { timeout: FRAMES_TIMEOUT_MS, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(MIN_FRAMES);

  expect(consoleErrors).toEqual([]);
});
