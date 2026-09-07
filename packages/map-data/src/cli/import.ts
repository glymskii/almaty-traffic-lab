import { getBBox } from "../bboxes.ts";
import { importOsm } from "../importer/index.ts";
import { parseArgs } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const bboxKey = typeof args.bbox === "string" ? args.bbox : "small";
const bbox = getBBox(bboxKey);
const outDir = typeof args.out === "string" ? args.out : `data/osm/${bbox.id}`;

console.log(`import: ${bbox.id} (${bbox.title}) -> ${outDir}`);
const snapshot = await importOsm({ bbox, outDir, useCache: args.refresh !== true });
console.log(
  `import: ${snapshot.elements.length} elements, osm timestamp ${snapshot.osmTimestamp ?? "?"}`,
);
