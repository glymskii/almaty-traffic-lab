import type { ReactNode } from "react";

export interface LayoutProps {
  /** Full-screen canvas (Viewport). */
  viewport: ReactNode;
  /** Left panel: tab switcher + active tab content (docs/tasks/T-23 п.1). */
  sidePanel: ReactNode;
  /** Bottom bar: play/pause, speed, clock, presets, restart. */
  timeBar: ReactNode;
  /** Top-right overlay: vehicle counts, rtFactor, fps, speed, delay. */
  hud: ReactNode;
  /** Tooltip layer over the canvas (raycast on hover). */
  tooltip: ReactNode;
  /** ODbL attribution corner. */
  attribution: ReactNode;
}

/** Pure chrome: canvas fills the screen, a side panel sits on top of it, HUD/tooltip float over it, TimeBar docks to the bottom. */
export function Layout({ viewport, sidePanel, timeBar, hud, tooltip, attribution }: LayoutProps) {
  return (
    <div className="app-shell">
      <div className="canvas-layer">{viewport}</div>
      <aside className="side-panel">{sidePanel}</aside>
      <div className="hud-layer">{hud}</div>
      {tooltip}
      <div className="attribution-corner">{attribution}</div>
      <footer className="time-bar">{timeBar}</footer>
    </div>
  );
}
