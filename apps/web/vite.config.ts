import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  // jsdom only backs the React smoke tests (TimeBar); the pure-logic test files run fine under it too.
  test: { environment: "jsdom" },
});
