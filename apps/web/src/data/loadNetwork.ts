import { type Network, parseNetwork } from "@atl/contracts";
import { createDemoNetwork } from "./demo-network.ts";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * Loads a compiled network from /networks/<networkId>.network.json.gz (copied from data/networks
 * by scripts/copy-networks.mjs, see docs/PLAN.md T-02), falling back to the built-in demo network
 * when it isn't there - T-02's output isn't required to work on apps/web.
 *
 * "Isn't there" is checked by the body (gzip magic or a JSON object), not just HTTP status: Vite's dev server (and
 * many static hosts configured for SPA routing) answer an unmatched path with a 200 and
 * `index.html` instead of a 404, so `response.ok` alone would happily try to decompress a web
 * page. A response that *is* real gzip but still fails to decode or validate is a genuine bug and
 * is left to throw, so it isn't mistaken for "no file yet".
 */
/** Compiled networks are named by bbox preset id (packages/map-data/src/bboxes.ts), not by preset key. */
export const DEFAULT_NETWORK_ID = "almaty-abay-small";

export async function loadNetwork(networkId = DEFAULT_NETWORK_ID): Promise<Network> {
  let response: Response;
  try {
    response = await fetch(`/networks/${networkId}.network.json.gz`);
  } catch {
    return createDemoNetwork();
  }
  if (!response.ok) return createDemoNetwork();

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
    const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return parseNetwork(await new Response(decompressed).json());
  }
  // Some servers (Vite dev, some static hosts) send .gz files with Content-Encoding: gzip, so the
  // browser has already inflated the body and we receive plain JSON. Anything else (an HTML SPA
  // fallback page) means the file is not there.
  const first = firstNonWhitespace(bytes);
  if (first === 0x7b /* { */) {
    return parseNetwork(JSON.parse(new TextDecoder().decode(bytes)));
  }
  return createDemoNetwork();
}

function firstNonWhitespace(bytes: Uint8Array): number {
  for (let i = 0; i < Math.min(bytes.length, 64); i++) {
    const b = bytes[i] ?? 0;
    if (b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09) return b;
  }
  return -1;
}
