import type { Connector, Network, SignalController } from "@atl/contracts";

// The synthetic networks of T-03 live in the sim-core test tree; the plan generator is specified
// against them (card T-08 §4). Test-only import: nothing in `src` reaches across packages.
export { crossroads, tJunction } from "../../../sim-core/test/fixtures/builders.ts";

/**
 * The same network without any signal plan: this is what the compiler hands to the generator
 * after the intersections stage — signalized nodes whose connectors still yield.
 */
export function stripControllers(net: Network): Network {
  const connectors = net.connectors.map((c) => {
    const { signalGroupId: _dropped, ...rest } = c;
    return { ...rest, protection: "yield" } as Connector;
  });
  const crosswalks = net.crosswalks.map((cw) => {
    const { signalGroupId: _dropped, ...rest } = cw;
    return rest;
  });
  return { ...net, connectors, crosswalks, signalControllers: [] };
}

export function controllerOf(net: Network, nodeId: string): SignalController {
  const ctrl = net.signalControllers.find((c) => c.nodeId === nodeId);
  if (ctrl === undefined) throw new Error(`no controller at ${nodeId}`);
  return ctrl;
}

export function connectorsAt(net: Network, nodeId: string): Connector[] {
  return net.connectors.filter((c) => c.viaNodeId === nodeId);
}

/** Group id of every connector of the node, so a test can say which section serves a movement. */
export function groupSections(ctrl: SignalController): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of ctrl.groups) for (const id of g.connectorIds) out[id] = g.section;
  return out;
}

/**
 * Phases that give green to two conflicting movements both marked `protected` — the invariant of
 * acceptance criterion 2. An empty result means the plan never releases a protected conflict.
 */
export function protectedConflictsInPhases(net: Network, ctrl: SignalController): string[] {
  const byId = new Map(net.connectors.map((c) => [c.id, c] as const));
  const groupOf = new Map<string, string>();
  for (const g of ctrl.groups) for (const id of g.connectorIds) groupOf.set(id, g.id);
  const bad: string[] = [];
  for (const phase of ctrl.phases) {
    const green = new Set(phase.greenGroupIds);
    for (const gid of phase.greenGroupIds) {
      const group = ctrl.groups.find((g) => g.id === gid);
      if (group === undefined) continue;
      for (const id of group.connectorIds) {
        const connector = byId.get(id);
        if (connector === undefined || connector.protection !== "protected") continue;
        for (const conflict of connector.conflicts) {
          const otherGroup = groupOf.get(conflict.otherConnectorId);
          const other = byId.get(conflict.otherConnectorId);
          if (otherGroup === undefined || otherGroup === gid) continue;
          if (green.has(otherGroup) && other?.protection === "protected")
            bad.push(`${phase.id}: ${id} vs ${conflict.otherConnectorId}`);
        }
      }
    }
  }
  return bad;
}
