import { existsSync } from "node:fs";
import { defaultSimConfig } from "@atl/contracts";
import { getBBox } from "../bboxes.ts";
import { compileNetwork } from "../compiler/index.ts";
import { defaultOutputPaths, readSnapshotFile, writeCompileOutputs } from "../compiler/write.ts";
import { parseArgs } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const bboxKey = typeof args.bbox === "string" ? args.bbox : "small";
const bbox = getBBox(bboxKey);
const snapshotPath =
  typeof args.snapshot === "string" ? args.snapshot : `data/osm/${bbox.id}/snapshot.json.gz`;
const paths = defaultOutputPaths(bbox.id);
if (typeof args.out === "string") {
  paths.networkPath = args.out;
  paths.assumptionsPath = `${args.out.replace(/\.network\.json(\.gz)?$/, "")}.assumptions.json`;
}

if (!existsSync(snapshotPath)) {
  console.error(
    `compile: snapshot ${snapshotPath} not found; run "pnpm import --bbox ${bboxKey}" first`,
  );
  process.exit(1);
}

console.log(`compile: ${bbox.id} (${bbox.title}) <- ${snapshotPath}`);
const startedAt = performance.now();
const snapshot = readSnapshotFile(snapshotPath);
const generatedAt = args["generated-at"];
const report = compileNetwork({
  bbox,
  snapshot,
  config: defaultSimConfig(),
  ...(typeof generatedAt === "string" ? { generatedAt } : {}),
});
writeCompileOutputs(report, paths);

const pct = (share: number) => `${Math.round(share * 100)}%`;
const s = report.stats;
const kinds = Object.entries(s.nodesByKind)
  .filter(([, n]) => n > 0)
  .map(([k, n]) => `${k} ${n}`)
  .join(", ");
console.log(
  `compile: ${s.nodes} nodes (${kinds}), ${s.links} links, ${s.lanes} lanes, ${s.totalLengthKm} km in ${Math.round(performance.now() - startedAt)} ms`,
);
console.log(
  `compile: defaults: speed ${pct(s.speedDefaultShare)} of links, lane count ${pct(s.laneCountDefaultShare)} of links, turns ${pct(s.turnsDefaultShare)} of lanes; bus lanes ${s.busLanes}, pockets ${s.pockets}`,
);
console.log("compile: assumptions:");
for (const a of report.assumptions)
  console.log(`  ${a.kind.padEnd(28)} ${String(a.count).padStart(6)}  e.g. ${a.example}`);
console.log(`compile: ${report.warnings.length} warnings`);
for (const w of report.warnings.slice(0, 15)) console.log(`  ${w}`);
if (report.warnings.length > 15)
  console.log(`  ... ${report.warnings.length - 15} more in ${paths.assumptionsPath}`);
console.log(`compile: wrote ${paths.networkPath} and ${paths.assumptionsPath}`);
