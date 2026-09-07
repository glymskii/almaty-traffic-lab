// Fails the build if non-deterministic APIs are used inside the simulation core.
// The core must be reproducible: same seed + same network + same scenario => identical trajectories.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages/sim-core/src", "packages/contracts/src"];
const FORBIDDEN = [/Math\.random\s*\(/, /Date\.now\s*\(/, /performance\.now\s*\(/, /new Date\s*\(/];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

let failed = false;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    // CLI / benchmark entry points may measure wall-clock time; they opt out explicitly.
    if (text.includes("// determinism-check: allow-wall-clock")) continue;
    for (const re of FORBIDDEN) {
      if (re.test(text)) {
        console.error(`determinism: ${file} uses forbidden API ${re}`);
        failed = true;
      }
    }
  }
}
if (failed) process.exit(1);
console.log("determinism: ok");
