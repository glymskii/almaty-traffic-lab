import type { Network, SimConfigPatch } from "@atl/contracts";
import { defaultSimConfig } from "@atl/contracts";
import { useEffect, useRef, useState } from "react";
import { loadNetwork } from "./data/loadNetwork.ts";
import { ru } from "./i18n/ru.ts";
import { CameraRig } from "./scene/camera.ts";
import { buildCityLayers, type CityLayers } from "./scene/city.ts";
import { createRenderFrame } from "./scene/interpolation.ts";
import {
  buildStreetLabels,
  createLabelRenderer,
  resizeLabelRenderer,
  updateLabelVisibility,
} from "./scene/labels.ts";
import { buildMarkings } from "./scene/markings.ts";
import { createPedestrianInstances } from "./scene/pedestrians.ts";
import { applyTimeOfDay, createEngine, type Engine } from "./scene/renderer.ts";
import { buildConnectorRibbons, buildRoadSurfaces } from "./scene/roads.ts";
import { createSignalInstances } from "./scene/signals.ts";
import { createTimeOfDaySample, sampleTimeOfDay } from "./scene/time-of-day.ts";
import { disposeObject3D } from "./scene/util.ts";
import { createVehicleInstances } from "./scene/vehicles.ts";
import { type SimHandle, sampleStressFrame, startSim, wantsStressMode } from "./sim/client.ts";

export type Status = "loading" | "warming-up" | "ready" | "error";

/** Temporary key to hide the connector overlay (docs/tasks/T-05: "выключается флагом") until T-23 adds a real layer panel. */
const TOGGLE_CONNECTORS_KEY = "KeyC";
/** docs/tasks/T-13 acceptance check: `?stress=1` drives vehicles.ts at this many instances without a worker. */
const STRESS_VEHICLE_CAPACITY = 20000;

/**
 * Fires a value to subscribers exactly once - `onSimReady` needs this because the sim (T-13's
 * `SimHandle`) appears asynchronously after warm-up, not at mount time, and every panel that
 * wants it (TimeBar, Hud) mounts before that happens; a late `subscribe` call still gets the
 * value immediately once it has fired (docs/tasks/T-23 review notes on T-13).
 */
function createOnceEmitter<T>(): {
  emit: (value: T) => void;
  subscribe: (cb: (value: T) => void) => () => void;
} {
  // Boxed so `undefined` can be a legitimate emitted value without being confused with "not yet emitted".
  let box: { value: T } | undefined;
  const listeners = new Set<(value: T) => void>();
  return {
    emit(next) {
      if (box) return;
      box = { value: next };
      for (const cb of listeners) cb(next);
      listeners.clear();
    },
    subscribe(cb) {
      if (box) {
        cb(box.value);
        return () => {};
      }
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Handed to `onReady` once the scene is mounted, so panels (T-23) can drive the camera, toggle layers or subscribe to frames without reaching into Viewport's internals. */
export interface ViewportHandle {
  engine: Engine;
  rig: CameraRig;
  network: Network;
  /** "Здания"/"Зелень и вода" layer groups (docs/tasks/T-27 §2) - the Обзор tab toggles `.visible` directly. */
  cityLayers: CityLayers;
  /** Synchronous snapshot; undefined before warm-up finishes (prefer `onSimReady` unless polling). */
  getSim: () => SimHandle | undefined;
  /** Calls back once, when the sim becomes playable (immediately if it already is). */
  onSimReady: (cb: (sim: SimHandle) => void) => () => void;
}

interface MountedScene {
  engine: Engine;
  rig: CameraRig;
  cityLayers: CityLayers;
  getSim: () => SimHandle | undefined;
  onSimReady: (cb: (sim: SimHandle) => void) => () => void;
  cleanup: () => void;
}

/** Mounts the Three.js scene into `container` for `network`, starts the simulation and wires its frames into the vehicle/signal/pedestrian instances; returns handles plus a teardown function. */
function mountScene(
  container: HTMLElement,
  network: Network,
  configPatch: SimConfigPatch,
  onStatus: (status: Status, progress?: number) => void,
): MountedScene {
  const engine = createEngine(container);
  const labelRenderer = createLabelRenderer(container);
  const rig = new CameraRig(engine.camera, engine.controls);

  const roadSurfaces = buildRoadSurfaces(network);
  const markings = buildMarkings(network);
  const connectors = buildConnectorRibbons(network);
  engine.scene.add(roadSurfaces);
  engine.scene.add(markings);
  if (connectors) engine.scene.add(connectors);

  const cityLayers = buildCityLayers(network);
  engine.scene.add(cityLayers.buildings);
  engine.scene.add(cityLayers.greenery);

  const labels = buildStreetLabels(network);
  for (const label of labels) engine.scene.add(label.object);

  const signals = createSignalInstances(network);
  const pedestrians = createPedestrianInstances(network);
  engine.scene.add(signals.object);
  engine.scene.add(pedestrians.object);

  rig.overview(network, { immediate: true });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === TOGGLE_CONNECTORS_KEY && connectors) {
      connectors.visible = !connectors.visible;
    }
  };
  window.addEventListener("keydown", onKeyDown);

  const stress = wantsStressMode(window.location.search);
  // Placeholder capacity=1 vehicle instances until the real `vehicleCapacity` arrives from the
  // worker's `ready` message below (docs/tasks/T-13: "Ёмкость = vehicleCapacity из ready") - the
  // render loop only calls `vehicles.update` once `sim` is set, so these are never drawn.
  let vehicles = createVehicleInstances(stress ? STRESS_VEHICLE_CAPACITY : 1);
  let renderFrame = createRenderFrame(stress ? STRESS_VEHICLE_CAPACITY : 1);
  engine.scene.add(vehicles.object);

  let sim: SimHandle | undefined;
  let disposed = false;
  const simReady = createOnceEmitter<SimHandle>();

  // Sky/light/headlights by time of day (docs/tasks/T-27 §3). Derived from `simTimeS` rather than
  // reading `FrameMeta.timeOfDayMin` directly: that field starts life hard-coded to 0 (midnight) in
  // sim/client.ts's placeholder, before the worker's first `frame` message ever arrives, which
  // `?? initialTimeOfDayMin` cannot catch (0 is not nullish) - `simTimeS` has no such placeholder
  // ambiguity (0 elapsed really does mean "still at the configured start time", matching the
  // fallback exactly), and mirrors SimClock.timeOfDayMin's own `(startTimeMin + simTimeS / 60) % 1440`.
  const timeOfDaySample = createTimeOfDaySample();
  const initialTimeOfDayMin = defaultSimConfig(configPatch).startTimeMin;

  const unsubscribeFrame = engine.onFrame((dtS) => {
    rig.update(dtS);
    updateLabelVisibility(engine.camera, labels);
    labelRenderer.render(engine.scene, engine.camera);

    const timeOfDayMin = sim
      ? (initialTimeOfDayMin + sim.latestFrameMeta().simTimeS / 60) % 1440
      : initialTimeOfDayMin;
    sampleTimeOfDay(timeOfDayMin, timeOfDaySample);
    applyTimeOfDay(engine, timeOfDaySample);
    vehicles.setHeadlightIntensity(timeOfDaySample.headlight);

    if (stress) {
      sampleStressFrame(renderFrame.simTimeS + dtS, renderFrame);
      vehicles.update(renderFrame);
      return;
    }
    if (!sim) return;
    sim.sampleVehicles(dtS, renderFrame);
    vehicles.update(renderFrame);
    signals.update(sim.signalStates(), renderFrame.simTimeS);
    pedestrians.update(sim.crosswalkPeds());
  });

  const resizeObserver = new ResizeObserver(() => resizeLabelRenderer(labelRenderer, container));
  resizeObserver.observe(container);

  if (stress) {
    onStatus("ready");
  } else {
    onStatus("warming-up", 0);
    startSim(network, configPatch)
      .then((handle) => {
        if (disposed) {
          handle.dispose();
          return;
        }
        sim = handle;
        handle.onError((message, fatal) => {
          if (fatal) onStatus("error");
          else console.error(`sim error: ${message}`);
        });

        // Swap the placeholder capacity=1 instances for the real one now that it's known.
        engine.scene.remove(vehicles.object);
        disposeObject3D(vehicles.object);
        vehicles = createVehicleInstances(handle.stats.vehicleCapacity);
        renderFrame = createRenderFrame(handle.stats.vehicleCapacity);
        engine.scene.add(vehicles.object);

        const offProgress = handle.onProgress((simTimeS, targetSimTimeS) => {
          onStatus("warming-up", targetSimTimeS > 0 ? simTimeS / targetSimTimeS : 1);
        });
        const warmupEndS = defaultSimConfig(configPatch).demand.warmupMinutes * 60;
        handle
          .runUntil(warmupEndS)
          .then(() => {
            offProgress();
            if (disposed) return;
            handle.play(1);
            onStatus("ready");
            // Only announced once warm-up is done and the sim is actually playable - emitting at
            // assignment time (above) would let a subscriber call play()/pause() before runUntil
            // finishes, which the worker's state machine rejects (docs/tasks/T-23 review notes).
            simReady.emit(handle);
          })
          .catch(() => offProgress());
      })
      .catch((error: unknown) => {
        console.error("Viewport: failed to start the simulation", error);
        onStatus("error");
      });
  }

  return {
    engine,
    rig,
    cityLayers,
    getSim: () => sim,
    onSimReady: simReady.subscribe,
    cleanup: () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeFrame();
      resizeObserver.disconnect();
      rig.dispose();
      disposeObject3D(roadSurfaces);
      disposeObject3D(markings);
      if (connectors) disposeObject3D(connectors);
      disposeObject3D(cityLayers.buildings);
      disposeObject3D(cityLayers.greenery);
      disposeObject3D(vehicles.object);
      disposeObject3D(signals.object);
      disposeObject3D(pedestrians.object);
      engine.dispose();
      container.removeChild(labelRenderer.domElement);
      sim?.dispose();
    },
  };
}

export interface ViewportProps {
  /** Bbox preset id (packages/map-data/src/bboxes.ts); defaults to the small square. */
  networkId?: string;
  /**
   * Applied once at init (T-23's "Перезапуск"/time presets/restart-required params remount this
   * component with a new `key` rather than hot-swapping the running sim - see src/state/store.ts).
   */
  configPatch?: SimConfigPatch;
  /** Called once the scene is mounted. */
  onReady?: (handle: ViewportHandle) => void;
  /** Mirrors the overlay status shown inside the canvas, for panels outside it (TimeBar's warm-up bar). */
  onStatus?: (status: Status, progress?: number) => void;
}

/** Full-screen Three.js canvas: loads the network, mounts the scene and drives it from the simulation (see sim/client.ts). */
export function Viewport({ networkId, configPatch, onReady, onStatus }: ViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [progress, setProgress] = useState(0);
  // Read via refs inside the mount effect so a fresh prop identity each render doesn't re-run the
  // (expensive, network-loading) effect below - restarting deliberately goes through remounting
  // this component with a new `key` from the parent, not through changing these mid-mount.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const networkIdRef = useRef(networkId);
  const configPatchRef = useRef(configPatch);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const reportStatus = (nextStatus: Status, nextProgress?: number): void => {
      if (cancelled) return;
      setStatus(nextStatus);
      if (nextProgress !== undefined) setProgress(nextProgress);
      onStatusRef.current?.(nextStatus, nextProgress);
    };

    loadNetwork(networkIdRef.current)
      .then((network) => {
        if (cancelled) return;
        const scene = mountScene(container, network, configPatchRef.current ?? {}, reportStatus);
        cleanup = scene.cleanup;
        onReadyRef.current?.({
          engine: scene.engine,
          rig: scene.rig,
          network,
          cityLayers: scene.cityLayers,
          getSim: scene.getSim,
          onSimReady: scene.onSimReady,
        });
      })
      .catch((error: unknown) => {
        console.error("Viewport: failed to load the network", error);
        reportStatus("error");
      });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div ref={containerRef} className="viewport">
      {status === "loading" && <div className="viewport-overlay">{ru.loadingNetwork}</div>}
      {status === "warming-up" && (
        <div className="viewport-overlay">{`${ru.warmingUp} ${Math.round(progress * 100)}%`}</div>
      )}
      {status === "error" && <div className="viewport-overlay">{ru.loadError}</div>}
    </div>
  );
}
