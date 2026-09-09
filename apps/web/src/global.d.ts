export {};

declare global {
  interface Window {
    /**
     * Liveness counter for the Playwright smoke test (docs/tasks/T-30): `scene/renderer.ts`
     * increments it once per rendered frame. Undefined until `createEngine` has mounted at least
     * once; the smoke test polls it instead of reading pixels or hooking into sim internals.
     */
    __atl?: { frames: number };
  }
}
