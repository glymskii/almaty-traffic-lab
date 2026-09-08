import { ru } from "./i18n/ru.ts";
import { Viewport } from "./Viewport.tsx";

/**
 * Full-screen 3D scene (see src/scene/) with a thin top bar. T-23 adds the HUD and side panels
 * around this same Viewport.
 */
export function App() {
  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="top-bar-title">{ru.appTitle}</span>
        <span className="top-bar-attribution">{ru.attribution}</span>
      </header>
      <Viewport />
    </div>
  );
}
