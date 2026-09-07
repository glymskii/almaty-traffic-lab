import { describe, expect, it } from "vitest";
import { straightRoad } from "./builders.ts";

describe("synthetic builders", () => {
  it("straightRoad is a valid network", () => {
    const net = straightRoad({
      lanes: 3,
      busLane: true,
      busStop: { s: 500, kind: "in_lane" },
      busRoute: { headwayPeakS: 300, headwayOffpeakS: 600 },
    });
    expect(net.lanes).toHaveLength(4);
    expect(net.lanes[3]?.kind).toBe("bus");
    expect(net.busRoutes[0]?.stopIds).toEqual(["stop0"]);
  });
});
