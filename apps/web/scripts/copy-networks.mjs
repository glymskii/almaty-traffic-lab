#!/usr/bin/env node
// Copies compiled networks (docs/PLAN.md T-02) from data/networks/ into apps/web/public/networks/
// so Vite can serve them at /networks/<id>.network.json.gz. Runs in predev/prebuild; a missing or
// empty data/networks/ is expected before T-02 lands, not an error - src/data/loadNetwork.ts falls
// back to the built-in demo network in that case.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, "..", "..", "..", "data", "networks");
const targetDir = join(here, "..", "public", "networks");

mkdirSync(targetDir, { recursive: true });

if (!existsSync(sourceDir)) {
  console.log("copy-networks: data/networks does not exist yet - using the built-in demo network");
  process.exit(0);
}

const files = readdirSync(sourceDir).filter((name) => name.endsWith(".network.json.gz"));
if (files.length === 0) {
  console.log("copy-networks: data/networks is empty - using the built-in demo network");
  process.exit(0);
}

for (const file of files) {
  cpSync(join(sourceDir, file), join(targetDir, file));
}
console.log(`copy-networks: copied ${files.length} network(s) to apps/web/public/networks`);
