import type { Network } from "@atl/contracts";
import { useEffect, useRef, useState } from "react";
import { loadNetwork } from "./data/loadNetwork.ts";
import { ru } from "./i18n/ru.ts";
import { CameraRig } from "./scene/camera.ts";
import {
  buildStreetLabels,
  createLabelRenderer,
  resizeLabelRenderer,
  updateLabelVisibility,
} from "./scene/labels.ts";
import { buildMarkings } from "./scene/markings.ts";
import { createEngine, type Engine } from "./scene/renderer.ts";
import { buildConnectorRibbons, buildRoadSurfaces } from "./scene/roads.ts";
import { disposeObject3D } from "./scene/util.ts";

type Status = "loading" | "ready" | "error";

/** Temporary key to hide the connector overlay (docs/tasks/T-05: "выключается флагом") until T-23 adds a real layer panel. */
const TOGGLE_CONNECTORS_KEY = "KeyC";

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

/** Mounts the Three.js scene into `container` for `network`; returns handles plus a teardown function. */
function mountScene(container: HTMLElement, network: Network): MountedScene {
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

  rig.overview(network, { immediate: true });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === TOGGLE_CONNECTORS_KEY && connectors) {
      connectors.visible = !connectors.visible;
    }
  };
  window.addEventListener("keydown", onKeyDown);

  const unsubscribeFrame = engine.onFrame((dtS) => {
    rig.update(dtS);
    updateLabelVisibility(engine.camera, labels);
    labelRenderer.render(engine.scene, engine.camera);
  });
  const resizeObserver = new ResizeObserver(() => resizeLabelRenderer(labelRenderer, container));
  resizeObserver.observe(container);

  return {
    engine,
    rig,
    cleanup: () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeFrame();
      resizeObserver.disconnect();
      rig.dispose();
      disposeObject3D(roadSurfaces);
      disposeObject3D(markings);
      if (connectors) disposeObject3D(connectors);
      engine.dispose();
      container.removeChild(labelRenderer.domElement);
    },
  };
}

export interface ViewportProps {
  /** Called once the scene is mounted. */
  onReady?: (handle: ViewportHandle) => void;
}

/** Full-screen Three.js canvas: loads the network, then hands it to renderer.ts/roads.ts/markings.ts/labels.ts/camera.ts. */
export function Viewport({ onReady }: ViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("loading");
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
        const scene = mountScene(container, network);
        cleanup = scene.cleanup;
        setStatus("ready");
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
      {status === "error" && <div className="viewport-overlay">{ru.loadError}</div>}
    </div>
  );
}
