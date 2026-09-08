import { bootstrapWorker } from "./worker-bootstrap.ts";

/** Worker entry point for the browser. One instance = one simulation, using @atl/sim-core. */
bootstrapWorker();
