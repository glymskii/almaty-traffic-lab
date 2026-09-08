import { SignalState } from "@atl/contracts";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { laneAxis, sampleAtS } from "../src/geometry/lane-geometry.ts";
import { buildSignalHeadLayouts, createSignalInstances } from "../src/scene/signals.ts";
import { buildSignalizedJunction } from "./fixtures.ts";

describe("buildSignalHeadLayouts", () => {
  const network = buildSignalizedJunction();
  const layouts = buildSignalHeadLayouts(network);

  it("builds one head per vehicle group and skips pedestrian groups", () => {
    // g_ped (pedestrian, index 0) is skipped; g_main (index 1) and g_left_arrow (index 2) are not.
    expect(layouts).toHaveLength(2);
    expect(layouts.map((l) => l.groupId).sort()).toEqual(["g_left_arrow", "g_main"]);
  });

  it("keeps the pedestrian group's slot counted, so later groups keep the global FrameBuffers.signalStates index", () => {
    const main = layouts.find((l) => l.groupId === "g_main");
    const arrow = layouts.find((l) => l.groupId === "g_left_arrow");
    // controller order: g_ped=0, g_main=1, g_left_arrow=2 (state.ts: "controllers in network
    // order, groups in controller order" - pedestrian groups occupy a slot too).
    expect(main?.groupIndex).toBe(1);
    expect(arrow?.groupIndex).toBe(2);
  });

  it("assigns the right kind and arrow side from the group's section", () => {
    const main = layouts.find((l) => l.groupId === "g_main");
    const arrow = layouts.find((l) => l.groupId === "g_left_arrow");
    expect(main?.kind).toBe("main");
    expect(arrow?.kind).toBe("arrow");
    expect(arrow?.side).toBe("left");
  });

  it("places the head at the end of the group's first connector's lane, offset 2 m to the right of the direction of travel", () => {
    const main = layouts.find((l) => l.groupId === "g_main");
    if (!main) throw new Error("g_main head missing");

    const link = network.links.find((l) => l.id === "in");
    if (!link) throw new Error("link 'in' missing");
    const lane = network.lanes.find((l) => l.id === "in:0");
    if (!lane) throw new Error("lane 'in:0' missing");

    const axis = laneAxis(link.geometry, lane.index, link.laneIds.length, lane.widthM);
    const { point, heading } = sampleAtS(axis, lane.endS);
    // right-of-travel = heading rotated -90 degrees: (heading.y, -heading.x).
    const expectedX = point[0] + heading[1] * 2;
    const expectedY = point[1] + -heading[0] * 2;

    expect(main.x).toBeCloseTo(expectedX);
    expect(main.y).toBeCloseTo(expectedY);
  });

  it("throws a clear error for a vehicle group with no connectors (checkNetworkIntegrity should have already rejected this, but stay fail-fast)", () => {
    const broken = buildSignalizedJunction();
    const ctrl = broken.signalControllers[0];
    if (!ctrl) throw new Error("fixture has no controller");
    const group = ctrl.groups.find((g) => g.id === "g_main");
    if (!group) throw new Error("fixture has no g_main");
    group.connectorIds = []; // deliberately corrupt an otherwise-valid fixture for this one test
    expect(() => buildSignalHeadLayouts(broken)).toThrow();
  });
});

describe("createSignalInstances", () => {
  const network = buildSignalizedJunction();

  function scaleAt(mesh: THREE.InstancedMesh, index: number): THREE.Vector3 {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(index, matrix);
    const scale = new THREE.Vector3();
    matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    return scale;
  }

  function findMesh(object: THREE.Object3D, name: string): THREE.InstancedMesh {
    const mesh = object.children.find((child) => child.name === name);
    if (!(mesh instanceof THREE.InstancedMesh)) throw new Error(`mesh ${name} not found`);
    return mesh;
  }

  function colorAt(mesh: THREE.InstancedMesh, index: number): THREE.Color {
    const color = new THREE.Color();
    mesh.getColorAt(index, color);
    return color;
  }

  it("lights the correct lamp of the 3-lamp main head for each SignalState", () => {
    const signals = createSignalInstances(network);
    const mainLamps = findMesh(signals.object, "main-lamps");
    // one main head in the fixture -> lamps at indices 0 (red), 1 (yellow), 2 (green).
    const OFF = new THREE.Color("#2a2a2a");

    signals.update(new Uint8Array([0, SignalState.RED, SignalState.OFF]), 0);
    expect(colorAt(mainLamps, 0).getHex()).not.toBe(OFF.getHex());
    expect(colorAt(mainLamps, 1).getHex()).toBe(OFF.getHex());
    expect(colorAt(mainLamps, 2).getHex()).toBe(OFF.getHex());

    signals.update(new Uint8Array([0, SignalState.GREEN, SignalState.OFF]), 0);
    expect(colorAt(mainLamps, 0).getHex()).toBe(OFF.getHex());
    expect(colorAt(mainLamps, 2).getHex()).not.toBe(OFF.getHex());

    signals.update(new Uint8Array([0, SignalState.RED_YELLOW, SignalState.OFF]), 0);
    expect(colorAt(mainLamps, 0).getHex()).not.toBe(OFF.getHex());
    expect(colorAt(mainLamps, 1).getHex()).not.toBe(OFF.getHex());
    expect(colorAt(mainLamps, 2).getHex()).toBe(OFF.getHex());
  });

  it("keeps the main head red and yellow lamps visibly different colours from each other", () => {
    const signals = createSignalInstances(network);
    const mainLamps = findMesh(signals.object, "main-lamps");
    signals.update(new Uint8Array([0, SignalState.RED_YELLOW, SignalState.OFF]), 0);
    expect(colorAt(mainLamps, 0).getHex()).not.toBe(colorAt(mainLamps, 1).getHex());
  });

  it("renders the arrow section as its own lamp, off by default and lit green when permitted", () => {
    const signals = createSignalInstances(network);
    const arrowLamps = findMesh(signals.object, "arrow-lamps");
    const OFF = new THREE.Color("#2a2a2a");

    signals.update(new Uint8Array([0, SignalState.RED, SignalState.OFF]), 0);
    expect(colorAt(arrowLamps, 0).getHex()).toBe(OFF.getHex());

    signals.update(new Uint8Array([0, SignalState.RED, SignalState.GREEN]), 0);
    expect(colorAt(arrowLamps, 0).getHex()).not.toBe(OFF.getHex());
  });

  it("flashes the green lamp for FLASHING_GREEN instead of holding it solid", () => {
    const signals = createSignalInstances(network);
    const mainLamps = findMesh(signals.object, "main-lamps");
    const OFF = new THREE.Color("#2a2a2a");

    signals.update(new Uint8Array([0, SignalState.FLASHING_GREEN, SignalState.OFF]), 0); // on-phase
    expect(colorAt(mainLamps, 2).getHex()).not.toBe(OFF.getHex());

    signals.update(new Uint8Array([0, SignalState.FLASHING_GREEN, SignalState.OFF]), 0.75); // off-phase (1 Hz)
    expect(colorAt(mainLamps, 2).getHex()).toBe(OFF.getHex());
  });

  it("builds a visible (non-zero-scale) pole/housing and lamp for every head", () => {
    const signals = createSignalInstances(network);
    const poles = signals.object.children.find((c) => c.name === "signal-poles");
    expect(poles).toBeDefined();
    const mainLamps = findMesh(signals.object, "main-lamps");
    const arrowLamps = findMesh(signals.object, "arrow-lamps");
    expect(scaleAt(mainLamps, 0).length()).toBeGreaterThan(0);
    expect(scaleAt(arrowLamps, 0).length()).toBeGreaterThan(0);
  });
});
