import type {
  BottleneckReport,
  FrameBuffers,
  MetricsFrame,
  Network,
  SegmentDescriptor,
  SimConfig,
  SimConfigPatch,
} from "@atl/contracts";
import { allocateMetricsFrame, causeCode, VEHICLE_CLASS_CODE } from "@atl/contracts";
import type { CreateSimulationOptions, Simulation, TripClassStats, TripStats } from "@atl/sim-core";

/**
 * Placeholder Simulation: 500 points moving on a circle, positions a pure function of simTimeS
 * (deterministic, no per-step state to drift). Stands in for @atl/sim-core's createSimulation
 * until T-04 lands, so the worker protocol and the renderer have something to draw (T-13).
 */

const STUB_VEHICLE_COUNT = 500;
const STUB_RADIUS_M = 220;
const STUB_SPEED_MPS = 9;
const STUB_FREE_FLOW_CAUSE = causeCode("free_flow");
const STUB_CAR_CLASS = VEHICLE_CLASS_CODE.car;

class StubSimulationImpl implements Simulation {
  readonly network: Network;
  readonly config: SimConfig;
  readonly scenarioId: string;
  simTimeS = 0;
  timeOfDayMin: number;

  private readonly omega = STUB_SPEED_MPS / STUB_RADIUS_M;

  constructor(opts: CreateSimulationOptions) {
    this.network = opts.network;
    this.config = opts.config;
    this.scenarioId = opts.scenarioId ?? "stub";
    this.timeOfDayMin = opts.config.startTimeMin;
  }

  step(): void {
    this.simTimeS += this.config.dtS;
    this.timeOfDayMin = (this.config.startTimeMin + this.simTimeS / 60) % 1440;
  }

  runUntil(targetSimTimeS: number): void {
    while (this.simTimeS < targetSimTimeS) this.step();
  }

  vehicleCount(): number {
    return STUB_VEHICLE_COUNT;
  }

  writeFrame(frame: FrameBuffers): FrameBuffers {
    const n = Math.min(STUB_VEHICLE_COUNT, frame.capacity);
    frame.count = n;
    frame.simTimeS = this.simTimeS;
    for (let i = 0; i < n; i++) {
      const theta0 = (2 * Math.PI * i) / STUB_VEHICLE_COUNT;
      const angle = theta0 + this.omega * this.simTimeS;
      frame.id[i] = i;
      frame.x[i] = STUB_RADIUS_M * Math.cos(angle);
      frame.y[i] = STUB_RADIUS_M * Math.sin(angle);
      frame.heading[i] = angle + Math.PI / 2;
      frame.speed[i] = STUB_SPEED_MPS;
      frame.cls[i] = STUB_CAR_CLASS;
      frame.flags[i] = 0;
      frame.cause[i] = STUB_FREE_FLOW_CAUSE;
    }
    frame.signalStates.fill(0);
    frame.crosswalkPeds.fill(0);
    return frame;
  }

  segments(): SegmentDescriptor[] {
    return [];
  }

  signalGroupIds(): string[] {
    return [];
  }

  crosswalkIds(): string[] {
    return [];
  }

  writeMetrics(frame?: MetricsFrame): MetricsFrame {
    const f = frame ?? allocateMetricsFrame(0, this.config.metrics.windowS);
    f.simTimeS = this.simTimeS;
    f.timeOfDayMin = this.timeOfDayMin;
    return f;
  }

  report(): BottleneckReport {
    return {
      simTimeS: this.simTimeS,
      timeOfDayMin: this.timeOfDayMin,
      windowS: this.config.metrics.windowS,
      totals: {
        vehiclesActive: STUB_VEHICLE_COUNT,
        vehiclesCompleted: 0,
        delayVehH: 0,
        delayPersonH: 0,
        meanSpeedKph: STUB_SPEED_MPS * 3.6,
        carMeanSpeedKph: STUB_SPEED_MPS * 3.6,
        busMeanSpeedKph: 0,
        stoppedShare: 0,
        congestedSegmentShare: 0,
      },
      items: [],
    };
  }

  setParams(_patch: SimConfigPatch): void {
    // No tunable parameters in the stub; accepted and ignored.
  }

  trajectoryHash(): string {
    return `stub:${this.simTimeS.toFixed(3)}`;
  }

  tripStats(): TripStats {
    const empty: TripClassStats = {
      spawned: 0,
      completed: 0,
      active: 0,
      meanTripTimeS: 0,
      meanTripDelayS: 0,
      meanStops: 0,
      personDelayS: 0,
    };
    return {
      simTimeS: this.simTimeS,
      spawnWaits: 0,
      total: { ...empty, active: STUB_VEHICLE_COUNT },
      byClass: {
        car: { ...empty, active: STUB_VEHICLE_COUNT },
        bus: empty,
        trolleybus: empty,
        taxi: empty,
      },
    };
  }
}

export function createStubSimulation(opts: CreateSimulationOptions): Simulation {
  return new StubSimulationImpl(opts);
}
