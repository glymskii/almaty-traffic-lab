import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBBox } from "../bboxes.ts";
import { importOsm } from "../importer/index.ts";
import { parseArgs } from "./args.ts";

// `pnpm --filter @atl/map-data run import` (the only invocation that works, see README:
// "import" is a reserved pnpm command name) runs with cwd = packages/map-data, not the repo
// root, so the default output path is anchored to this file's location instead of cwd.
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const args = parseArgs(process.argv.slice(2));
const bboxKey = typeof args.bbox === "string" ? args.bbox : "small";
const bbox = getBBox(bboxKey);
const outDir = typeof args.out === "string" ? args.out : join(REPO_ROOT, "data", "osm", bbox.id);

console.log(`import: ${bbox.id} (${bbox.title}) -> ${outDir}`);
const snapshot = await importOsm({ bbox, outDir, useCache: args.refresh !== true });

const countsByType = new Map<string, number>();
for (const el of snapshot.elements) {
  countsByType.set(el.type, (countsByType.get(el.type) ?? 0) + 1);
}
const typeCounts = ["node", "way", "relation"]
  .map((type) => `${type}=${countsByType.get(type) ?? 0}`)
  .join(", ");

const snapshotPath = join(outDir, "snapshot.json.gz");
const sizeKb = (statSync(snapshotPath).size / 1024).toFixed(1);

console.log(
  `import: ${snapshot.elements.length} elements (${typeCounts}), osm timestamp ${snapshot.osmTimestamp ?? "?"}`,
);
console.log(`import: wrote ${snapshotPath} (${sizeKb} KB)`);
