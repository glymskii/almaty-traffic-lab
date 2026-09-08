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
import { createEngine } from "./scene/renderer.ts";
import { buildConnectorRibbons, buildRoadSurfaces } from "./scene/roads.ts";

type Status = "loading" | "ready" | "error";

/** Mounts the Three.js scene into `container` for `network` and returns a function that tears it all down again. */
function mountScene(container: HTMLElement, network: Network): () => void {
  const engine = createEngine(container);
  const labelRenderer = createLabelRenderer(container);
  const rig = new CameraRig(engine.camera, engine.controls);

  engine.scene.add(buildRoadSurfaces(network));
  engine.scene.add(buildMarkings(network));
  const connectors = buildConnectorRibbons(network);
  if (connectors) engine.scene.add(connectors);

  const labels = buildStreetLabels(network);
  for (const label of labels) engine.scene.add(label.object);

  rig.overview(network);

  const unsubscribeFrame = engine.onFrame((dtS) => {
    rig.update(dtS);
    updateLabelVisibility(engine.camera, labels);
    labelRenderer.render(engine.scene, engine.camera);
  });
  const resizeObserver = new ResizeObserver(() => resizeLabelRenderer(labelRenderer, container));
  resizeObserver.observe(container);

  return () => {
    unsubscribeFrame();
    resizeObserver.disconnect();
    rig.dispose();
    engine.dispose();
    container.removeChild(labelRenderer.domElement);
  };
}

/** Full-screen Three.js canvas: loads the network, then hands it to renderer.ts/roads.ts/markings.ts/labels.ts/camera.ts. */
export function Viewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    loadNetwork()
      .then((network) => {
        if (cancelled) return;
        cleanup = mountScene(container, network);
        setStatus("ready");
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
