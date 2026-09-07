import { VEHICLE_CLASS_CODE } from "@atl/contracts";
import { describe, expect, it } from "vitest";
import { CLASS_COUNT, classBit, RuntimeNetwork } from "../../src/runtime/network.ts";
import { straightRoad } from "../fixtures/builders.ts";
import { bentRoad, twoLinkRoad } from "./networks.ts";

describe("RuntimeNetwork", () => {
  it("indexes a straight road: lanes, offsets, neighbours, gates, segments", () => {
    const rt = new RuntimeNetwork(straightRoad({ lanes: 2 }), 25);
    expect(rt.laneCount).toBe(2);
    expect(rt.connectorCount).toBe(0);
    expect(rt.trackCount).toBe(2);
    expect(rt.trackSpeedMps[0]).toBeCloseTo(60 / 3.6, 10);
    expect(rt.trackStartS[1]).toBe(0);
    expect(rt.trackEndS[1]).toBe(1000);
    // Lane 0 is leftmost: driving east it sits north of the centreline (offset to the right is negative).
    expect(rt.trackOffsetM[0]).toBeCloseTo(-1.75, 10);
    expect(rt.trackOffsetM[1]).toBeCloseTo(1.75, 10);
    expect(rt.laneLeft[0]).toBe(-1);
    expect(rt.laneRight[0]).toBe(1);
    expect(rt.laneLeft[1]).toBe(0);
    expect(rt.laneRight[1]).toBe(-1);
    expect(rt.lanesOverlapAt(0, 1, 500)).toBe(true);
    expect(rt.trackAllowedMask[0]).toBe(0b1111);
    // No connectors: every class leaves the network at the end of the lane.
    for (let c = 0; c < CLASS_COUNT; c++) expect(rt.trackNextByClass[c]).toBe(-1);
    // Gate g0 feeds both lanes and takes the whole spawn rate; g1 is exit-only.
    expect(rt.gateCount).toBe(2);
    expect(rt.gateLaneCount[0]).toBe(2);
    expect(rt.gateLaneCount[1]).toBe(0);
    expect(rt.gateShare[0]).toBe(1);
    expect(rt.gateShare[1]).toBe(0);
    expect(rt.entryLaneCount).toBe(2);
    // 1000 m / 25 m = 40 segments per lane, the last one approaches n1.
    expect(rt.segments).toHaveLength(80);
    expect(rt.laneSegStart[1]).toBe(40);
    expect(rt.segments[39]).toMatchObject({
      index: 39,
      laneId: "l0:0",
      linkId: "l0",
      startS: 975,
      endS: 1000,
      approachNodeId: "n1",
    });
    expect(rt.segments[38]?.approachNodeId).toBeUndefined();
    expect(rt.segments[0]?.freeFlowSpeedMps).toBeCloseTo(60 / 3.6, 10);
    expect(rt.signalGroupIds).toEqual([]);
    expect(rt.crosswalkIds).toEqual([]);
  });

  it("rounds segment counts so that pieces stay close to the configured length", () => {
    const rt = new RuntimeNetwork(straightRoad({ lanes: 1, lengthM: 110 }), 25);
    expect(rt.laneSegCount[0]).toBe(4);
    expect(rt.laneSegLengthM[0]).toBeCloseTo(27.5, 10);
    expect(rt.segments.map((s) => s.endS)).toEqual([27.5, 55, 82.5, 110]);
  });

  it("keeps a bus lane out of the car mask", () => {
    const rt = new RuntimeNetwork(straightRoad({ lanes: 1, busLane: true }), 25);
    expect((rt.trackAllowedMask[1] as number) & classBit("car")).toBe(0);
    expect((rt.trackAllowedMask[1] as number) & classBit("bus")).not.toBe(0);
    expect(rt.gateLaneCount[0]).toBe(2);
  });

  it("links lanes through connectors and filters the next track by class", () => {
    const rt = new RuntimeNetwork(twoLinkRoad(), 25);
    expect(rt.trackCount).toBe(3);
    const conn = 2;
    expect(rt.laneConnCount[0]).toBe(1);
    expect(rt.laneConnList[0]).toBe(conn);
    expect(rt.trackStartS[conn]).toBe(0);
    expect(rt.trackEndS[conn]).toBe(10);
    expect(rt.trackSpeedMps[conn]).toBeCloseTo(40 / 3.6, 10);
    expect(rt.trackLink[conn]).toBe(-1);
    for (let c = 0; c < CLASS_COUNT; c++) {
      expect(rt.trackNextByClass[0 * CLASS_COUNT + c]).toBe(conn);
      expect(rt.trackNextByClass[conn * CLASS_COUNT + c]).toBe(1);
      expect(rt.trackNextByClass[1 * CLASS_COUNT + c]).toBe(-1);
    }
    expect(rt.entryLaneCount).toBe(1);

    const busOnly = new RuntimeNetwork(twoLinkRoad({ busOnlySecondLink: true }), 25);
    expect(busOnly.trackNextByClass[0 * CLASS_COUNT + VEHICLE_CLASS_CODE.car]).toBe(-1);
    expect(busOnly.trackNextByClass[0 * CLASS_COUNT + VEHICLE_CLASS_CODE.taxi]).toBe(-1);
    expect(busOnly.trackNextByClass[0 * CLASS_COUNT + VEHICLE_CLASS_CODE.bus]).toBe(2);
  });

  it("locates polyline segments from a cached hint in both directions", () => {
    const rt = new RuntimeNetwork(bentRoad(), 25);
    expect(Array.from(rt.pcum.slice(0, 3))).toEqual([0, 500, 1000]);
    expect(rt.polyScale[0]).toBeCloseTo(1, 10);
    expect(rt.locate(0, 250, 0)).toBe(0);
    expect(rt.locate(0, 700, 0)).toBe(1);
    expect(rt.locate(0, 700, 1)).toBe(1);
    expect(rt.locate(0, 100, 1)).toBe(0);
    expect(rt.locate(0, 1200, 0)).toBe(1); // beyond the end: clamp to the last segment
    expect(rt.segAngle[0]).toBeCloseTo(0, 10);
    expect(rt.segAngle[1]).toBeCloseTo(Math.PI / 2, 10);
    expect(rt.segAngle[2]).toBeCloseTo(Math.PI / 2, 10); // last vertex repeats the previous direction
  });

  it("rejects dangling references with a readable error", () => {
    const net = straightRoad();
    const broken = { ...net, gates: [{ ...net.gates[0], nodeId: "missing" }] };
    expect(() => new RuntimeNetwork(broken as typeof net, 25)).toThrow(/node missing/);
  });
});
