import { describe, expect, it } from "vitest";
import { bboxCentre, getBBox } from "../src/bboxes.ts";
import { createProjection } from "../src/projection.ts";

describe("projection", () => {
  it("round-trips within millimetres", () => {
    const origin = bboxCentre(getBBox("big"));
    const proj = createProjection(origin);
    const p = { lat: 43.2402, lon: 76.9205 };
    const local = proj.toLocal(p);
    const back = proj.toLonLat(local);
    expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-9);
    expect(Math.abs(back.lon - p.lon)).toBeLessThan(1e-9);
  });

  it("puts north up and east right", () => {
    const proj = createProjection({ lat: 43.24, lon: 76.92 });
    const north = proj.toLocal({ lat: 43.25, lon: 76.92 });
    const east = proj.toLocal({ lat: 43.24, lon: 76.93 });
    expect(north[1]).toBeGreaterThan(1000);
    expect(Math.abs(north[0])).toBeLessThan(1e-6);
    expect(east[0]).toBeGreaterThan(700);
    expect(east[0]).toBeLessThan(900);
  });

  it("knows both presets", () => {
    expect(getBBox("small").tilesPerSide).toBe(1);
    expect(getBBox("big").id).toBe("almaty-center-big");
    expect(() => getBBox("nope")).toThrow();
  });
});
