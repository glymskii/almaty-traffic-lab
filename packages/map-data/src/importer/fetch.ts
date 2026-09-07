import type { OsmElement } from "./index.ts";

/** Parsed, validated Overpass response for one query. */
export interface OverpassResult {
  elements: OsmElement[];
  /** `osm3s.timestamp_osm_base` from the response, when present. */
  timestampOsmBase?: string;
}

/** Public mirrors tried in order; the main server occasionally serves an HTML timeout page instead of JSON. */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const ATTEMPTS_PER_MIRROR = 3;
const RETRY_BASE_DELAY_MS = 2000;
/** Overpass front-ends (Apache) answer 406 to requests without a descriptive User-Agent. */
const USER_AGENT = "almaty-traffic-lab/0.0.1 (+https://github.com/glymskii/almaty-traffic-lab)";

export interface FetchOverpassOptions {
  endpoints?: string[];
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so retries don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Overpass sometimes answers 200 with an HTML timeout/error page; only a parsed `elements` array counts as success. */
function parseOverpassResponse(text: string): OverpassResult | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const elements = (data as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return undefined;
  const osm3s = (data as { osm3s?: { timestamp_osm_base?: unknown } }).osm3s;
  const timestampOsmBase =
    typeof osm3s?.timestamp_osm_base === "string" ? osm3s.timestamp_osm_base : undefined;
  return timestampOsmBase !== undefined
    ? { elements: elements as OsmElement[], timestampOsmBase }
    : { elements: elements as OsmElement[] };
}

/**
 * POSTs an Overpass QL query to each mirror in turn, retrying up to ATTEMPTS_PER_MIRROR times
 * per mirror with exponential backoff before failing over to the next one.
 */
export async function fetchOverpassQuery(
  query: string,
  opts: FetchOverpassOptions = {},
): Promise<OverpassResult> {
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS;
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleep ?? defaultSleep;

  let lastError = "no mirrors configured";
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_MIRROR; attempt++) {
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json,*/*",
            "user-agent": USER_AGENT,
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!res.ok) {
          lastError = `${endpoint} -> HTTP ${res.status}`;
        } else {
          const parsed = parseOverpassResponse(await res.text());
          if (parsed) return parsed;
          lastError = `${endpoint} -> response was not JSON with an "elements" field`;
        }
      } catch (err) {
        lastError = `${endpoint} -> ${err instanceof Error ? err.message : String(err)}`;
      }
      if (attempt < ATTEMPTS_PER_MIRROR - 1) {
        await doSleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }
  throw new Error(`overpass: all mirrors exhausted, last error: ${lastError}`);
}
