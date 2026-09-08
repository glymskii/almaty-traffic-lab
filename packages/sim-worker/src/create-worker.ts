/**
 * Constructs the real browser Worker running worker.ts (@atl/sim-core kernel).
 *
 * `new Worker(new URL(specifier, import.meta.url), options)` is a pattern Vite recognizes and
 * bundles statically (its own chunk, properly transpiled) ONLY when written as one inline
 * expression, exactly like this. Splitting it (`const url = new URL(...); new Worker(url, ...)`)
 * or reaching across a package boundary with a relative path both defeat that static detection:
 * `vite dev` serves the file straight from disk regardless and hides the problem, but
 * `vite build` then falls back to inlining the raw, untranspiled .ts source as a `data:` URL,
 * and the worker never starts. That is why this call must live here, unmodified, and why
 * consumers must go through this factory instead of constructing the Worker themselves (it is
 * also a `packages/<name>` -> `@atl/<name>` boundary crossing either way, CLAUDE.md rule 8).
 */
export function createSimWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

/** Debug-only: StubSimulation instead of the real kernel (see apps/web's /?debug=worker). Same caveat as createSimWorker applies to this exact call shape. */
export function createStubSimWorker(): Worker {
  return new Worker(new URL("./worker-stub.ts", import.meta.url), { type: "module" });
}
