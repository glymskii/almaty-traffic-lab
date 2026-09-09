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
    console.log(`[DEBUG console:${message.type()}]`, message.text());
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    console.log("[DEBUG pageerror]", error.message, error.stack);
    consoleErrors.push(error.message);
  });

  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeVisible();

  const glInfo = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { canvas: false };
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { canvas: true, gl: false };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      canvas: true,
      gl: true,
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      isContextLost: gl.isContextLost(),
    };
  });
  console.log("[DEBUG glInfo]", JSON.stringify(glInfo));

  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(2000);
    const frames = await page.evaluate(() => window.__atl?.frames ?? 0);
    console.log(`[DEBUG frames] t=${(i + 1) * 2}s frames=${frames}`);
  }

  await expect
    .poll(() => page.evaluate(() => window.__atl?.frames ?? 0), { timeout: FRAMES_TIMEOUT_MS })
    .toBeGreaterThanOrEqual(MIN_FRAMES);

  expect(consoleErrors).toEqual([]);
});
