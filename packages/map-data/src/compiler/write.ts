import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { type Network, parseNetwork } from "@atl/contracts";
import type { OsmSnapshot } from "../importer/index.ts";
import type { CompileReport } from "./index.ts";

/** Compact JSON; key order follows the zod schemas, so the same network gives the same bytes. */
export function serializeNetwork(network: Network): string {
  return JSON.stringify(network);
}

/** gzip without a timestamp in the header (Node's zlib writes MTIME = 0), hence byte-stable. */
export function gzipNetwork(network: Network): Buffer {
  return gzipSync(Buffer.from(serializeNetwork(network), "utf8"), { level: 9 });
}

export function readNetworkFile(path: string): Network {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return parseNetwork(JSON.parse(text));
}

export function readSnapshotFile(path: string): OsmSnapshot {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text) as OsmSnapshot;
}

/** Contents of `<bboxId>.assumptions.json`. */
export function assumptionsDocument(report: CompileReport): Record<string, unknown> {
  const { meta } = report.network;
  return {
    networkId: meta.networkId,
    bboxId: meta.bboxId,
    generatedAt: meta.generatedAt,
    sourceHash: meta.sourceHash ?? null,
    stats: report.stats,
    assumptions: report.assumptions,
    warnings: report.warnings,
    linkLevels: report.linkLevels,
  };
}

export interface CompileOutputPaths {
  networkPath: string;
  assumptionsPath: string;
}

/** `data/networks/<bboxId>.network.json.gz` + `<bboxId>.assumptions.json`. */
export function defaultOutputPaths(bboxId: string, dir = "data/networks"): CompileOutputPaths {
  return {
    networkPath: `${dir}/${bboxId}.network.json.gz`,
    assumptionsPath: `${dir}/${bboxId}.assumptions.json`,
  };
}

export function writeCompileOutputs(report: CompileReport, paths: CompileOutputPaths): void {
  mkdirSync(dirname(paths.networkPath), { recursive: true });
  mkdirSync(dirname(paths.assumptionsPath), { recursive: true });
  writeFileSync(paths.networkPath, gzipNetwork(report.network));
  writeFileSync(paths.assumptionsPath, `${JSON.stringify(assumptionsDocument(report), null, 2)}\n`);
}
