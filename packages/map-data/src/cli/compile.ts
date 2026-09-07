import { defaultSimConfig } from "@atl/contracts";
import { getBBox } from "../bboxes.ts";
import { compileNetwork } from "../compiler/index.ts";
import { parseArgs } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const bboxKey = typeof args.bbox === "string" ? args.bbox : "small";
const bbox = getBBox(bboxKey);
const outFile =
  typeof args.out === "string" ? args.out : `data/networks/${bbox.id}.network.json.gz`;

console.log(`compile: ${bbox.id} -> ${outFile}`);
// T-02 loads the snapshot from data/osm/<bboxId>/snapshot.json.gz and writes the network + assumptions report.
const report = compileNetwork({
  bbox,
  snapshot: { bboxId: bbox.id, fetchedAt: "", elements: [] },
  config: defaultSimConfig(),
});
console.log(`compile: ${report.network.links.length} links, ${report.warnings.length} warnings`);
