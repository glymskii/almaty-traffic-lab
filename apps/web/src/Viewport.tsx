import type { Network } from "@atl/contracts";
import { defaultSimConfig } from "@atl/contracts";
import { useEffect, useRef, useState } from "react";
import { loadNetwork } from "./data/loadNetwork.ts";
import { ru } from "./i18n/ru.ts";
import { CameraRig } from "./scene/camera.ts";
import { createRenderFrame } from "./scene/interpolation.ts";
import {
  buildStreetLabels,
  createLabelRenderer,
  resizeLabelRenderer,
  updateLabelVisibility,
} from "./scene/labels.ts";
import { buildMarkings } from "./scene/markings.ts";
import { createPedestrianInstances } from "./scene/pedestrians.ts";
import { createEngine, type Engine } from "./scene/renderer.ts";
import { buildConnectorRibbons, buildRoadSurfaces } from "./scene/roads.ts";
import { createSignalInstances } from "./scene/signals.ts";
import { disposeObject3D } from "./scene/util.ts";
import { createVehicleInstances } from "./scene/vehicles.ts";
import { type SimHandle, sampleStressFrame, startSim, wantsStressMode } from "./sim/client.ts";

type Status = "loading" | "warming-up" | "ready" | "error";

/** Temporary key to hide the connector overlay (docs/tasks/T-05: "выключается флагом") until T-23 adds a real layer panel. */
const TOGGLE_CONNECTORS_KEY = "KeyC";
/** docs/tasks/T-13 acceptance check: `?stress=1` drives vehicles.ts at this many instances without a worker. */
const STRESS_VEHICLE_CAPACITY = 20000;

/** Handed to `onReady` once the scene is mounted, so panels (T-23) can drive the camera, toggle layers or subscribe to frames without reaching into Viewport's internals. */
export interface ViewportHandle {
  engine: Engine;
  rig: CameraRig;
  network: Network;
}

interface MountedScene {
  engine: Engine;
  rig: CameraRig;
  cleanup: () => void;
}

/** Mounts the Three.js scene into `container` for `network`, starts the simulation and wires its frames into the vehicle/signal/pedestrian instances; returns handles plus a teardown function. */
function mountScene(
  container: HTMLElement,
  network: Network,
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

  const unsubscribeFrame = engine.onFrame((dtS) => {
    rig.update(dtS);
    updateLabelVisibility(engine.camera, labels);
    labelRenderer.render(engine.scene, engine.camera);

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
    startSim(network)
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
        const warmupEndS = defaultSimConfig().demand.warmupMinutes * 60;
        handle
          .runUntil(warmupEndS)
          .then(() => {
            offProgress();
            if (disposed) return;
            handle.play(1);
            onStatus("ready");
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
    cleanup: () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeFrame();
      resizeObserver.disconnect();
      rig.dispose();
      disposeObject3D(roadSurfaces);
      disposeObject3D(markings);
      if (connectors) disposeObject3D(connectors);
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
  /** Called once the scene is mounted. */
  onReady?: (handle: ViewportHandle) => void;
}

/** Full-screen Three.js canvas: loads the network, mounts the scene and drives it from the simulation (see sim/client.ts). */
export function Viewport({ onReady }: ViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [progress, setProgress] = useState(0);
  // Read via a ref inside the mount effect so a fresh `onReady` identity each render doesn't
  // re-run the (expensive, network-loading) effect below.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    loadNetwork()
      .then((network) => {
        if (cancelled) return;
        const scene = mountScene(container, network, (nextStatus, nextProgress) => {
          if (cancelled) return;
          setStatus(nextStatus);
          if (nextProgress !== undefined) setProgress(nextProgress);
        });
        cleanup = scene.cleanup;
        onReadyRef.current?.({ engine: scene.engine, rig: scene.rig, network });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Viewport: failed to load the network", error);
        setStatus("error");
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
