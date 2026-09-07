import type { Network } from "./network.ts";

const EPS_M = 0.5;

/**
 * Referential and structural integrity beyond what zod can express.
 * Returns a list of human-readable errors; empty list = network is consistent.
 * Every producer of a Network (compiler, synthetic builders, override application) must pass this.
 */
export function checkNetworkIntegrity(net: Network): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  const nodes = indexById(net.nodes, "nodes", err);
  const links = indexById(net.links, "links", err);
  const lanes = indexById(net.lanes, "lanes", err);
  const connectors = indexById(net.connectors, "connectors", err);
  const crosswalks = indexById(net.crosswalks, "crosswalks", err);
  const controllers = indexById(net.signalControllers, "signalControllers", err);
  const stops = indexById(net.busStops, "busStops", err);
  indexById(net.busRoutes, "busRoutes", err);
  indexById(net.gates, "gates", err);
  indexById(net.attractors, "attractors", err);

  const controllerByNode = new Map<string, string>();
  for (const c of net.signalControllers) {
    if (controllerByNode.has(c.nodeId)) err(`node ${c.nodeId} has more than one signal controller`);
    controllerByNode.set(c.nodeId, c.id);
  }

  for (const link of net.links) {
    if (!nodes.has(link.fromNodeId)) err(`link ${link.id}: fromNodeId ${link.fromNodeId} missing`);
    if (!nodes.has(link.toNodeId)) err(`link ${link.id}: toNodeId ${link.toNodeId} missing`);
    if (link.fromNodeId === link.toNodeId) err(`link ${link.id}: from and to are the same node`);
    for (let i = 0; i < link.laneIds.length; i++) {
      const laneId = link.laneIds[i] as string;
      const lane = lanes.get(laneId);
      if (!lane) {
        err(`link ${link.id}: laneIds[${i}] ${laneId} missing`);
        continue;
      }
      if (lane.linkId !== link.id)
        err(`lane ${laneId}: linkId ${lane.linkId} != owning link ${link.id}`);
      if (lane.index !== i)
        err(`lane ${laneId}: index ${lane.index} != position ${i} in link.laneIds`);
    }
    const polyLen = polylineLength(link.geometry);
    if (Math.abs(polyLen - link.lengthM) > Math.max(EPS_M, 0.01 * link.lengthM))
      err(`link ${link.id}: lengthM ${link.lengthM} != geometry length ${polyLen.toFixed(1)}`);
  }

  for (const lane of net.lanes) {
    const link = links.get(lane.linkId);
    if (!link) {
      err(`lane ${lane.id}: linkId ${lane.linkId} missing`);
      continue;
    }
    if (!link.laneIds.includes(lane.id))
      err(`lane ${lane.id}: not listed in link ${link.id}.laneIds`);
    if (lane.startS >= lane.endS)
      err(`lane ${lane.id}: startS ${lane.startS} >= endS ${lane.endS}`);
    if (lane.endS > link.lengthM + EPS_M)
      err(`lane ${lane.id}: endS ${lane.endS} beyond link length ${link.lengthM}`);
    if (lane.kind === "bus" && !lane.busLane)
      err(`lane ${lane.id}: kind=bus requires busLane rule`);
    if (lane.kind === "turn_pocket" && lane.startS <= 0)
      err(`lane ${lane.id}: turn_pocket must open mid-link (startS > 0)`);
  }

  for (const c of net.connectors) {
    const from = lanes.get(c.fromLaneId);
    const to = lanes.get(c.toLaneId);
    if (!from) err(`connector ${c.id}: fromLaneId ${c.fromLaneId} missing`);
    if (!to) err(`connector ${c.id}: toLaneId ${c.toLaneId} missing`);
    if (!nodes.has(c.viaNodeId)) err(`connector ${c.id}: viaNodeId ${c.viaNodeId} missing`);
    if (from && to) {
      const fromLink = links.get(from.linkId);
      const toLink = links.get(to.linkId);
      if (fromLink && fromLink.toNodeId !== c.viaNodeId)
        err(
          `connector ${c.id}: from-lane link ${fromLink.id} does not end at via node ${c.viaNodeId}`,
        );
      if (toLink && toLink.fromNodeId !== c.viaNodeId)
        err(
          `connector ${c.id}: to-lane link ${toLink.id} does not start at via node ${c.viaNodeId}`,
        );
      if (!from.turns.includes(c.turn))
        err(
          `connector ${c.id}: turn ${c.turn} not permitted by lane ${from.id} (${from.turns.join(",")})`,
        );
    }
    for (const cp of c.conflicts) {
      if (!connectors.has(cp.otherConnectorId))
        err(`connector ${c.id}: conflict with missing connector ${cp.otherConnectorId}`);
      if (cp.sThisM > c.lengthM + EPS_M)
        err(`connector ${c.id}: conflict sThisM ${cp.sThisM} beyond length ${c.lengthM}`);
    }
    for (const cwId of c.crosswalkIds) {
      const cw = crosswalks.get(cwId);
      if (!cw) err(`connector ${c.id}: crosswalk ${cwId} missing`);
      else if (!cw.connectorIds.includes(c.id))
        err(`crosswalk ${cwId}: does not list connector ${c.id} that references it`);
    }
    if (c.signalGroupId !== undefined) {
      const ctrlId = controllerByNode.get(c.viaNodeId);
      const ctrl = ctrlId ? controllers.get(ctrlId) : undefined;
      if (!ctrl)
        err(`connector ${c.id}: has signalGroupId but node ${c.viaNodeId} has no controller`);
      else if (!ctrl.groups.some((g) => g.id === c.signalGroupId))
        err(`connector ${c.id}: signalGroupId ${c.signalGroupId} not in controller ${ctrl.id}`);
      if (c.protection === "yield" || c.protection === "priority")
        err(`connector ${c.id}: signalized connector cannot have protection=${c.protection}`);
    } else if (c.protection === "protected" || c.protection === "permissive") {
      err(`connector ${c.id}: protection=${c.protection} requires a signalGroupId`);
    }
  }

  for (const cw of net.crosswalks) {
    if (!nodes.has(cw.nodeId)) err(`crosswalk ${cw.id}: nodeId ${cw.nodeId} missing`);
    for (const cid of cw.connectorIds) {
      const c = connectors.get(cid);
      if (!c) err(`crosswalk ${cw.id}: connector ${cid} missing`);
      else if (!c.crosswalkIds.includes(cw.id))
        err(`connector ${cid}: does not list crosswalk ${cw.id} that references it`);
    }
  }

  for (const ctrl of net.signalControllers) {
    const node = nodes.get(ctrl.nodeId);
    if (!node) err(`controller ${ctrl.id}: nodeId ${ctrl.nodeId} missing`);
    else if (node.kind !== "signalized")
      err(`controller ${ctrl.id}: node ${node.id} kind is ${node.kind}, expected signalized`);
    const groupIds = new Set<string>();
    for (const g of ctrl.groups) {
      if (groupIds.has(g.id)) err(`controller ${ctrl.id}: duplicate group id ${g.id}`);
      groupIds.add(g.id);
      if (g.kind === "vehicle" && g.connectorIds.length === 0)
        err(`controller ${ctrl.id}: vehicle group ${g.id} has no connectors`);
      if (g.kind === "pedestrian" && g.crosswalkIds.length === 0)
        err(`controller ${ctrl.id}: pedestrian group ${g.id} has no crosswalks`);
      for (const cid of g.connectorIds) {
        const c = connectors.get(cid);
        if (!c) err(`controller ${ctrl.id}: group ${g.id} references missing connector ${cid}`);
        else if (c.viaNodeId !== ctrl.nodeId)
          err(`controller ${ctrl.id}: group ${g.id} connector ${cid} is at another node`);
        else if (c.signalGroupId !== g.id)
          err(`connector ${cid}: signalGroupId ${c.signalGroupId} != group ${g.id} that lists it`);
      }
      for (const cwId of g.crosswalkIds) {
        const cw = crosswalks.get(cwId);
        if (!cw) err(`controller ${ctrl.id}: group ${g.id} references missing crosswalk ${cwId}`);
        else if (cw.signalGroupId !== g.id)
          err(
            `crosswalk ${cwId}: signalGroupId ${cw.signalGroupId} != group ${g.id} that lists it`,
          );
      }
    }
    const greenSomewhere = new Set<string>();
    for (const p of ctrl.phases) {
      for (const gid of p.greenGroupIds) {
        if (!groupIds.has(gid))
          err(`controller ${ctrl.id}: phase ${p.id} references unknown group ${gid}`);
        greenSomewhere.add(gid);
      }
    }
    for (const gid of groupIds)
      if (!greenSomewhere.has(gid)) err(`controller ${ctrl.id}: group ${gid} is never green`);
  }

  for (const stop of net.busStops) {
    const link = links.get(stop.linkId);
    const lane = lanes.get(stop.laneId);
    if (!link) err(`busStop ${stop.id}: linkId ${stop.linkId} missing`);
    if (!lane) err(`busStop ${stop.id}: laneId ${stop.laneId} missing`);
    else if (lane.linkId !== stop.linkId)
      err(`busStop ${stop.id}: lane ${lane.id} is not on link ${stop.linkId}`);
    if (link && stop.s > link.lengthM + EPS_M)
      err(`busStop ${stop.id}: s ${stop.s} beyond link length`);
  }

  for (const route of net.busRoutes) {
    for (let i = 0; i < route.linkIds.length; i++) {
      const id = route.linkIds[i] as string;
      const link = links.get(id);
      if (!link) {
        err(`busRoute ${route.id}: linkIds[${i}] ${id} missing`);
        continue;
      }
      if (i > 0) {
        const prev = links.get(route.linkIds[i - 1] as string);
        if (prev && prev.toNodeId !== link.fromNodeId)
          err(`busRoute ${route.id}: links ${prev.id} -> ${link.id} are not connected`);
      }
    }
    const first = links.get(route.linkIds[0] as string);
    const last = links.get(route.linkIds[route.linkIds.length - 1] as string);
    if (first && first.fromNodeId !== route.entryNodeId)
      err(`busRoute ${route.id}: entryNodeId != start of first link`);
    if (last && last.toNodeId !== route.exitNodeId)
      err(`busRoute ${route.id}: exitNodeId != end of last link`);
    for (const sid of route.stopIds) {
      const stop = stops.get(sid);
      if (!stop) err(`busRoute ${route.id}: stop ${sid} missing`);
      else if (!route.linkIds.includes(stop.linkId))
        err(`busRoute ${route.id}: stop ${sid} is not on the route`);
    }
  }

  for (const gate of net.gates) {
    const node = nodes.get(gate.nodeId);
    if (!node) err(`gate ${gate.id}: nodeId ${gate.nodeId} missing`);
    else if (node.kind !== "gate")
      err(`gate ${gate.id}: node ${node.id} kind is ${node.kind}, expected gate`);
    for (const id of gate.inLinkIds) {
      const l = links.get(id);
      if (!l) err(`gate ${gate.id}: inLink ${id} missing`);
      else if (l.fromNodeId !== gate.nodeId)
        err(`gate ${gate.id}: inLink ${id} does not start at the gate`);
    }
    for (const id of gate.outLinkIds) {
      const l = links.get(id);
      if (!l) err(`gate ${gate.id}: outLink ${id} missing`);
      else if (l.toNodeId !== gate.nodeId)
        err(`gate ${gate.id}: outLink ${id} does not end at the gate`);
    }
  }

  for (const a of net.attractors)
    if (!nodes.has(a.nodeId)) err(`attractor ${a.id}: nodeId ${a.nodeId} missing`);

  return errors;
}

function indexById<T extends { id: string }>(
  items: T[],
  what: string,
  err: (m: string) => void,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) err(`${what}: duplicate id ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

export function polylineLength(points: readonly (readonly [number, number])[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as readonly [number, number];
    const b = points[i] as readonly [number, number];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}
