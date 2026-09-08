import { createStubSimulation } from "./stub-simulation.ts";
import { bootstrapWorker } from "./worker-bootstrap.ts";

/**
 * Debug-only worker entry point running StubSimulation instead of the real kernel. Used by
 * apps/web's /?debug=worker page until T-04/T-13 land; not for production use.
 */
bootstrapWorker(createStubSimulation);
