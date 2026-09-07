import { readFileSync } from "node:fs";
import {
  defaultSimConfig,
  type Lane,
  type Link,
  type Network,
  type NetworkNode,
} from "@atl/contracts";
import { type BBoxPreset, bboxCentre } from "../../src/bboxes.ts";
import { type CompileReport, compileNetwork } from "../../src/compiler/index.ts";
import type { OsmElement, OsmSnapshot } from "../../src/importer/index.ts";
import { createProjection } from "../../src/projection.ts";

/** ~811 m wide (x ±405.5) and ~1113 m tall (y ±556.6) around (43.235, 76.915). */
export const MINI_BBOX: BBoxPreset = {
  id: "mini",
  title: "мини-фикстура: крест из двух улиц",
  south: 43.23,
  west: 76.91,
  north: 43.24,
  east: 76.92,
  tilesPerSide: 1,
};
export const FIXED_TIME = "2026-09-01T00:00:00Z";
export const MINI_HALF_WIDTH_M = 405.5;
export const MINI_HALF_HEIGHT_M = 556.6;

export function loadMiniSnapshot(): OsmSnapshot {
  const url = new URL("../fixtures/mini-osm.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as OsmSnapshot;
}

export function compile(snapshot: OsmSnapshot, bbox: BBoxPreset = MINI_BBOX): CompileReport {
  return compileNetwork({ bbox, snapshot, config: defaultSimConfig(), generatedAt: FIXED_TIME });
}

export function compileMini(): CompileReport {
  return compile(loadMiniSnapshot());
}

export interface LocalWay {
  id: number;
  tags: Record<string, string>;
  nodes: number[];
}

/** Snapshot in Overpass `out geom` shape from local-metre coordinates around the MINI bbox centre. */
export function localSnapshot(
  nodes: Record<number, [number, number]>,
  ways: LocalWay[],
  nodeTags: Record<number, Record<string, string>> = {},
): OsmSnapshot {
  const proj = createProjection(bboxCentre(MINI_BBOX));
  const at = (id: number) => {
    const p = nodes[id];
    if (p === undefined) throw new Error(`node ${id} has no coordinates`);
    return proj.toLonLat(p);
  };
  const elements: OsmElement[] = [];
  for (const [idStr, tags] of Object.entries(nodeTags)) {
    const id = Number(idStr);
    const ll = at(id);
    elements.push({ type: "node", id, lat: ll.lat, lon: ll.lon, tags });
  }
  for (const w of ways) {
    elements.push({
      type: "way",
      id: w.id,
      tags: w.tags,
      nodes: w.nodes,
      geometry: w.nodes.map((id) => at(id)),
    });
  }
  return { bboxId: "mini", fetchedAt: FIXED_TIME, elements };
}

export function linkById(net: Network, id: string): Link {
  const link = net.links.find((l) => l.id === id);
  if (link === undefined)
    throw new Error(`no link ${id}; have ${net.links.map((l) => l.id).join(", ")}`);
  return link;
}

export function nodeById(net: Network, id: string): NetworkNode {
  const node = net.nodes.find((n) => n.id === id);
  if (node === undefined)
    throw new Error(`no node ${id}; have ${net.nodes.map((n) => n.id).join(", ")}`);
  return node;
}

export function lanesOf(net: Network, link: Link): Lane[] {
  return link.laneIds.map((id) => {
    const lane = net.lanes.find((l) => l.id === id);
    if (lane === undefined) throw new Error(`no lane ${id}`);
    return lane;
  });
}

export function linkIds(net: Network): string[] {
  return net.links.map((l) => l.id);
}

export function nodeIds(net: Network): string[] {
  return net.nodes.map((n) => n.id);
}
