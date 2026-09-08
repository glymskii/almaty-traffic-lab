import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildConnectorRibbons, buildRoadSurfaces } from "../src/scene/roads.ts";
import { buildStraightRoad } from "./fixtures.ts";

function findMesh(group: ReturnType<typeof buildRoadSurfaces>, name: string) {
  return group.children.find((child) => child.name === name);
}

describe("buildRoadSurfaces", () => {
  it("builds one merged quad per general lane and no other surface classes", () => {
    const network = buildStraightRoad({ lanes: 2 });
    const group = buildRoadSurfaces(network);

    expect(group.children.map((child) => child.name)).toEqual(["surface-general"]);

    const mesh = findMesh(group, "surface-general");
    const geometry = (mesh as THREE.Mesh).geometry;
    // 2 lanes x (2-point centreline -> 4 vertices per quad strip)
    expect(geometry.attributes.position?.count).toBe(8);
    // 2 lanes x 2 triangles x 3 indices
    expect(geometry.index?.count).toBe(12);
  });

  it("gives a bus lane and a turn pocket their own surface classes", () => {
    const network = buildStraightRoad({ lanes: 2, pocket: { startS: 150 }, busLane: true });
    const group = buildRoadSurfaces(network);

    expect(new Set(group.children.map((child) => child.name))).toEqual(
      new Set(["surface-general", "surface-turn_pocket", "surface-bus"]),
    );
  });

  it("only builds the pocket's pavement where the pocket actually exists (startS..lengthM)", () => {
    const network = buildStraightRoad({ lengthM: 200, lanes: 2, pocket: { startS: 150 } });
    const group = buildRoadSurfaces(network);
    const pocketMesh = findMesh(group, "surface-turn_pocket") as THREE.Mesh;

    const positions = pocketMesh.geometry.attributes.position;
    if (!positions) throw new Error("pocket mesh has no position attribute");
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    // the road runs along +x, so x doubles as arc-length s here - the pocket's pavement should
    // start at its own startS (150), not at 0, which is what makes it visually narrow the road
    // for s < 150 and widen it again once the pocket opens.
    expect(minX).toBeCloseTo(150);
    expect(maxX).toBeCloseTo(200);
  });
});

describe("buildConnectorRibbons", () => {
  it("returns null when the network has no connectors", () => {
    const network = buildStraightRoad({ lanes: 2 });
    expect(buildConnectorRibbons(network)).toBeNull();
  });
});
