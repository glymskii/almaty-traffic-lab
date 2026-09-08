import { describe, expect, it } from "vitest";
import { buildStopLines, buildTurnArrows } from "../src/scene/markings.ts";
import { buildStraightRoad } from "./fixtures.ts";

function totalVertices(geometries: ReturnType<typeof buildTurnArrows>): number {
  return geometries.reduce((sum, geometry) => sum + (geometry.attributes.position?.count ?? 0), 0);
}

describe("buildTurnArrows", () => {
  it("paints one arrow (a stem quad + a head triangle) for a single-turn lane", () => {
    const network = buildStraightRoad({ lanes: 1, turnsByIndex: { 0: ["through"] } });
    const geometries = buildTurnArrows(network);
    expect(geometries).toHaveLength(2);
    expect(totalVertices(geometries)).toBe(4 + 3);
  });

  it("paints one arrow per permitted turn on the same lane", () => {
    const network = buildStraightRoad({ lanes: 1, turnsByIndex: { 0: ["through", "right"] } });
    const geometries = buildTurnArrows(network);
    expect(geometries).toHaveLength(4);
    expect(totalVertices(geometries)).toBe(2 * (4 + 3));
  });

  it("skips turns with no standard pavement arrow (merge/diverge)", () => {
    const network = buildStraightRoad({ lanes: 1, turnsByIndex: { 0: ["merge"] } });
    expect(buildTurnArrows(network)).toHaveLength(0);
  });

  it("paints the left-turn arrow for a pocket lane that opens late", () => {
    const network = buildStraightRoad({ lengthM: 200, lanes: 2, pocket: { startS: 150 } });
    // lane 0 is the pocket (turns: ["left"]), lane 1 is a plain through lane
    const geometries = buildTurnArrows(network);
    expect(totalVertices(geometries)).toBe(2 * (4 + 3));
  });
});

describe("buildStopLines", () => {
  it("draws a stop line for every lane reaching a signalized node", () => {
    const network = buildStraightRoad({ lanes: 2, endNodeKind: "signalized" });
    const geometries = buildStopLines(network);
    expect(geometries).toHaveLength(2);
    for (const geometry of geometries) expect(geometry.attributes.position?.count).toBe(4);
  });

  it("draws nothing before an unsignalized gate", () => {
    const network = buildStraightRoad({ lanes: 2, endNodeKind: "gate" });
    expect(buildStopLines(network)).toHaveLength(0);
  });
});
