import { describe, expect, it } from "vitest";
import { fetchOverpassQuery, OVERPASS_ENDPOINTS } from "../../src/importer/fetch.ts";

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function jsonResponse(body: unknown): FakeResponse {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function textResponse(text: string): FakeResponse {
  return { ok: true, status: 200, text: async () => text };
}

function httpError(status: number): FakeResponse {
  return { ok: false, status, text: async () => "" };
}

/** Builds a fetch stub that replays `steps` in order and records the endpoints it was called with. */
function fakeFetch(steps: Array<FakeResponse | Error>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    const step = steps[i++];
    if (!step) throw new Error("fakeFetch: exhausted configured steps");
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function noSleep(): (ms: number) => Promise<void> {
  return async () => {};
}

describe("fetchOverpassQuery", () => {
  it("returns elements and the osm timestamp on the first try", async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ elements: [{ type: "node", id: 1 }], osm3s: { timestamp_osm_base: "T" } }),
    ]);
    const result = await fetchOverpassQuery("Q", { fetchImpl, sleep: noSleep() });
    expect(result.elements).toEqual([{ type: "node", id: 1 }]);
    expect(result.timestampOsmBase).toBe("T");
    expect(calls).toHaveLength(1);
  });

  it("omits timestampOsmBase when osm3s is absent", async () => {
    const { fetchImpl } = fakeFetch([jsonResponse({ elements: [] })]);
    const result = await fetchOverpassQuery("Q", { fetchImpl, sleep: noSleep() });
    expect(result.timestampOsmBase).toBeUndefined();
  });

  it("retries on the same mirror after a network error before giving up on it", async () => {
    const { fetchImpl, calls } = fakeFetch([
      new Error("network down"),
      jsonResponse({ elements: [] }),
    ]);
    let sleeps = 0;
    const result = await fetchOverpassQuery("Q", {
      fetchImpl,
      endpoints: ["https://only-mirror"],
      sleep: async () => {
        sleeps++;
      },
    });
    expect(result.elements).toEqual([]);
    expect(calls).toEqual(["https://only-mirror", "https://only-mirror"]);
    expect(sleeps).toBe(1);
  });

  it("treats an HTML timeout page as a failure and retries", async () => {
    const { fetchImpl, calls } = fakeFetch([
      textResponse("<html>Timeout</html>"),
      jsonResponse({ elements: [{ type: "way", id: 7 }] }),
    ]);
    const result = await fetchOverpassQuery("Q", {
      fetchImpl,
      endpoints: ["https://only-mirror"],
      sleep: noSleep(),
    });
    expect(result.elements).toEqual([{ type: "way", id: 7 }]);
    expect(calls).toHaveLength(2);
  });

  it("treats a non-2xx HTTP status as a failure and retries", async () => {
    const { fetchImpl } = fakeFetch([httpError(429), jsonResponse({ elements: [] })]);
    const result = await fetchOverpassQuery("Q", {
      fetchImpl,
      endpoints: ["https://only-mirror"],
      sleep: noSleep(),
    });
    expect(result.elements).toEqual([]);
  });

  it("falls over to the next mirror once the first is exhausted", async () => {
    const { fetchImpl, calls } = fakeFetch([
      textResponse("bad"),
      textResponse("bad"),
      textResponse("bad"),
      jsonResponse({ elements: [{ type: "node", id: 9 }] }),
    ]);
    const result = await fetchOverpassQuery("Q", {
      fetchImpl,
      endpoints: ["https://mirror-a", "https://mirror-b"],
      sleep: noSleep(),
    });
    expect(result.elements).toEqual([{ type: "node", id: 9 }]);
    expect(calls).toEqual([
      "https://mirror-a",
      "https://mirror-a",
      "https://mirror-a",
      "https://mirror-b",
    ]);
  });

  it("throws once every mirror is exhausted", async () => {
    const { fetchImpl, calls } = fakeFetch(Array.from({ length: 6 }, () => textResponse("bad")));
    await expect(
      fetchOverpassQuery("Q", {
        fetchImpl,
        endpoints: ["https://mirror-a", "https://mirror-b"],
        sleep: noSleep(),
      }),
    ).rejects.toThrow(/overpass/);
    expect(calls).toHaveLength(6);
  });

  it("defaults to a real mirror list with at least 3 entries", () => {
    expect(OVERPASS_ENDPOINTS.length).toBeGreaterThanOrEqual(3);
    for (const url of OVERPASS_ENDPOINTS) {
      expect(url).toMatch(/^https:\/\//);
    }
  });
});
