import { SCHEMA_VERSION } from "@atl/contracts";
import { DebugWorkerView } from "./DebugWorkerView.tsx";

/**
 * Shell placeholder. T-05 replaces it with the full-screen canvas, T-23 with the real layout:
 * 3D canvas (T-05/T-13) + HUD + panels (T-24/T-25/T-26). Attribution stays mandatory (ODbL).
 */
export function App() {
  if (new URLSearchParams(window.location.search).get("debug") === "worker") {
    return <DebugWorkerView />;
  }
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Almaty Traffic Lab</h1>
      <p style={{ opacity: 0.7 }}>
        Скелет приложения. Схема сети v{SCHEMA_VERSION}. План работ: docs/PLAN.md.
      </p>
      <footer style={{ position: "fixed", bottom: 8, right: 12, fontSize: 12, opacity: 0.6 }}>
        © OpenStreetMap contributors, ODbL
      </footer>
    </main>
  );
}
