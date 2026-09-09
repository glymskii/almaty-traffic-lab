import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  test: {
    // jsdom only backs the React smoke tests (TimeBar); the pure-logic test files run fine under
    // it too. `e2e/` (docs/tasks/T-30) is Playwright's own suite, run via `pnpm e2e` - its
    // `*.spec.ts` files would otherwise match vitest's default include glob too and fail (a
    // Playwright `test()` call outside the Playwright runner throws).
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
