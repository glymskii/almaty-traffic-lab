import { describe, expect, it } from "vitest";
import { LINK_PICK_RADIUS_M, NODE_PICK_RADIUS_M, pickNodeOrLink } from "../src/scene/picking.ts";
import { buildSignalizedJunction, buildStraightRoad } from "./fixtures.ts";

/**
 * `pickNodeOrLink` backs both the T-23 hover tooltip and T-24's click-to-select for the scenario
 * editor's forms - a bug here would silently break "click a node/link to edit it".
 */
describe("pickNodeOrLink", () => {
  it("picks the nearest node within NODE_PICK_RADIUS_M", () => {
    const net = buildStraightRoad({ lengthM: 200 });
    const hit = pickNodeOrLink(net, 1, 1);
    expect(hit).toEqual({ kind: "node", node: net.nodes[0] });
  });

  it("does not pick a node just outside the radius", () => {
    const net = buildStraightRoad({ lengthM: 200 });
    const hit = pickNodeOrLink(net, NODE_PICK_RADIUS_M + 1, 0);
    expect(hit?.kind).not.toBe("node");
  });

  it("picks the nearest link within LINK_PICK_RADIUS_M when no node is close", () => {
    const net = buildStraightRoad({ lengthM: 200 });
    // Midpoint of the link, well outside both end nodes' pick radius.
    const hit = pickNodeOrLink(net, 100, 2);
    expect(hit).toEqual({ kind: "link", link: net.links[0] });
  });

  it("does not pick a link just outside the radius", () => {
    const net = buildStraightRoad({ lengthM: 200 });
    const hit = pickNodeOrLink(net, 100, LINK_PICK_RADIUS_M + 1);
    expect(hit).toBeUndefined();
  });

  it("returns undefined far from every node and link", () => {
    const net = buildStraightRoad({ lengthM: 200 });
    expect(pickNodeOrLink(net, 1000, 1000)).toBeUndefined();
  });

  it("prefers a node over a link when a point is within both radii (signalized junction)", () => {
    const net = buildSignalizedJunction();
    const center = net.nodes.find((n) => n.id === "n_c");
    if (center === undefined) throw new Error("fixture missing n_c");
    // Right at the signalized node, which also sits at the end of the "in" link - both are
    // plausible picks; the node must win, exactly as the hover tooltip already does.
    const hit = pickNodeOrLink(net, center.x, center.y);
    expect(hit).toEqual({ kind: "node", node: center });
  });

  it("picks the correct link out of several candidates", () => {
    const net = buildSignalizedJunction();
    // Well clear of n_c (100,0) and n_out (200,0): the midpoint of out_left, which runs south.
    const hit = pickNodeOrLink(net, 100, -50);
    expect(hit?.kind).toBe("link");
    if (hit?.kind === "link") expect(hit.link.id).toBe("out_left");
  });
});
