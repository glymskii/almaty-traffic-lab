import type { Connector, Network } from "@atl/contracts";
import { checkNetworkIntegrity } from "@atl/contracts";
import { expect } from "vitest";

/**
 * Turns every left movement through `nodeId` into a **prohibited** one the way the signal generator
 * does it (T-08): the connector stays in the network but leaves its signal group, so no phase ever
 * releases it and `IntersectionRuntime.connProhibited` marks it impassable.
 *
 * Unlike `crossroads({ leftTurnMode: "prohibited" })`, which simply does not build the connectors,
 * this keeps them in the graph -- which is exactly the case routing has to walk around (see the
 * notes of T-11 on scenario overrides).
 */
export function withProhibitedLefts(net: Network, nodeId: string): Network {
  const banned = new Set(
    net.connectors.filter((c) => c.viaNodeId === nodeId && c.turn === "left").map((c) => c.id),
  );
  expect(banned.size).toBeGreaterThan(0);
  const connectors = net.connectors.map((c) => {
    if (!banned.has(c.id)) return c;
    // An unsignalized connector may not carry protection `protected`/`permissive` (contracts'
    // integrity check), and it must lose the group id, not just the group's back reference.
    const { signalGroupId: _dropped, ...rest } = c;
    const stripped: Connector = { ...rest, protection: "yield" };
    return stripped;
  });
  const signalControllers = net.signalControllers.map((ctrl) => ({
    ...ctrl,
    groups: ctrl.groups.map((g) => ({
      ...g,
      connectorIds: g.connectorIds.filter((id) => !banned.has(id)),
    })),
  }));
  const patched: Network = { ...net, connectors, signalControllers };
  expect(checkNetworkIntegrity(patched)).toEqual([]);
  return patched;
}
