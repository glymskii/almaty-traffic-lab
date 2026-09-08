import { describe, expect, it } from "vitest";
import { createDemoNetwork } from "../src/data/demo-network.ts";

describe("createDemoNetwork", () => {
  it("builds a schema-valid, internally consistent network", () => {
    expect(() => createDemoNetwork()).not.toThrow();
  });

  it("includes a left-turn pocket and a dedicated bus lane (T-05 acceptance criteria)", () => {
    const network = createDemoNetwork();
    expect(network.lanes.some((lane) => lane.kind === "turn_pocket")).toBe(true);
    expect(network.lanes.some((lane) => lane.kind === "bus")).toBe(true);
  });

  it("marks the centre node signalized so stop lines are exercised in the live demo too", () => {
    const network = createDemoNetwork();
    expect(network.nodes.some((node) => node.kind === "signalized")).toBe(true);
  });
});
