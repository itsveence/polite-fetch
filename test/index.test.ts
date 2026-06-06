import { describe, it, expect } from "vitest";
import {
  politeFetch,
  createPoliteFetch,
  parseRateLimit,
  parseDelayValue,
  parseDuration,
  sleep,
  type PoliteFetchOptions,
} from "../src/index.js";

const FIXED_NOW = 1_700_000_000_000; // a stable "now" for date math

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "body", { status, headers });
}

/** A fetch stub that returns a queued sequence (last item repeats). */
function seqFetch(items: Array<Response | Error>) {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    const item = items[Math.min(calls.length - 1, items.length - 1)]!;
    if (item instanceof Error) throw item;
    return item;
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

/** Records delays and resolves immediately. */
function recordingSleep() {
  const delays: number[] = [];
  const fn = async (ms: number) => {
    delays.push(ms);
  };
  return Object.assign(fn, { delays });
}

describe("parseDuration", () => {
  it("parses Go-style durations", () => {
    expect(parseDuration("1s")).toBe(1000);
    expect(parseDuration("880ms")).toBe(880);
    expect(parseDuration("6m0s")).toBe(360_000);
    expect(parseDuration("1h2m3s")).toBe(3_723_000);
    expect(parseDuration("20ms")).toBe(20);
    expect(parseDuration("1.5s")).toBe(1500);
  });

  it("rejects non-durations", () => {
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("1s extra")).toBeNull();
    expect(parseDuration("100")).toBeNull(); // no unit
  });
});

describe("parseDelayValue", () => {
  it("treats small numbers as delta-seconds", () => {
    expect(parseDelayValue("30", FIXED_NOW)).toBe(30_000);
    expect(parseDelayValue("1.5", FIXED_NOW)).toBe(1500);
  });

  it("treats large numbers as epoch seconds", () => {
    const resetEpochSec = Math.floor(FIXED_NOW / 1000) + 42;
    expect(parseDelayValue(String(resetEpochSec), FIXED_NOW)).toBe(42_000);
  });

  it("treats very large numbers as epoch milliseconds", () => {
    expect(parseDelayValue(String(FIXED_NOW + 5000), FIXED_NOW)).toBe(5000);
  });

  it("parses Go durations", () => {
    expect(parseDelayValue("6m0s", FIXED_NOW)).toBe(360_000);
  });

  it("parses ISO and HTTP dates", () => {
    const iso = new Date(FIXED_NOW + 10_000).toISOString();
    expect(parseDelayValue(iso, FIXED_NOW)).toBe(10_000);
    const http = new Date(FIXED_NOW + 2000).toUTCString(); // 1s resolution
    expect(parseDelayValue(http, FIXED_NOW)).toBeGreaterThanOrEqual(1000);
  });

  it("clamps past times to 0 and returns null for junk", () => {
    expect(parseDelayValue("-5", FIXED_NOW)).toBe(0);
    expect(parseDelayValue("not-a-time", FIXED_NOW)).toBeNull();
  });
});

describe("parseRateLimit", () => {
  it("prefers Retry-After (seconds)", () => {
    const r = parseRateLimit(res(429, { "retry-after": "12" }), { now: FIXED_NOW });
    expect(r).toEqual({ delayMs: 12_000, source: "retry-after" });
  });

  it("parses Retry-After as an HTTP date", () => {
    const when = new Date(FIXED_NOW + 3000).toUTCString();
    const r = parseRateLimit(res(429, { "retry-after": when }), { now: FIXED_NOW });
    expect(r.source).toBe("retry-after");
    expect(r.delayMs).toBeGreaterThanOrEqual(2000);
  });

  it("reads OpenAI reset durations when a bucket is exhausted", () => {
    const r = parseRateLimit(
      res(429, {
        "x-ratelimit-remaining-requests": "5",
        "x-ratelimit-reset-requests": "1s",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "6m0s",
      }),
      { now: FIXED_NOW },
    );
    expect(r).toEqual({ delayMs: 360_000, source: "openai" });
  });

  it("reads Anthropic RFC-3339 reset timestamps", () => {
    const reset = new Date(FIXED_NOW + 8000).toISOString();
    const r = parseRateLimit(
      res(429, {
        "anthropic-ratelimit-tokens-remaining": "0",
        "anthropic-ratelimit-tokens-reset": reset,
      }),
      { now: FIXED_NOW },
    );
    expect(r).toEqual({ delayMs: 8000, source: "anthropic" });
  });

  it("reads GitHub epoch reset with remaining 0", () => {
    const reset = Math.floor(FIXED_NOW / 1000) + 60;
    const r = parseRateLimit(
      res(429, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      }),
      { now: FIXED_NOW },
    );
    expect(r).toEqual({ delayMs: 60_000, source: "x-ratelimit" });
  });

  it("uses reset on a 429 even without a remaining header", () => {
    const reset = Math.floor(FIXED_NOW / 1000) + 5;
    const r = parseRateLimit(
      res(429, { "x-ratelimit-reset": String(reset) }),
      { now: FIXED_NOW },
    );
    expect(r.delayMs).toBe(5000);
  });

  it("ignores reset when the bucket is not exhausted", () => {
    const r = parseRateLimit(
      res(200, {
        "x-ratelimit-remaining": "10",
        "x-ratelimit-reset": String(Math.floor(FIXED_NOW / 1000) + 60),
      }),
      { now: FIXED_NOW },
    );
    expect(r).toEqual({ delayMs: null, source: null });
  });

  it("accepts a plain header record", () => {
    const r = parseRateLimit({ "Retry-After": 7 }, { now: FIXED_NOW });
    expect(r).toEqual({ delayMs: 7000, source: "retry-after" });
  });
});

describe("politeFetch", () => {
  const base = (over: PoliteFetchOptions): PoliteFetchOptions => ({
    backoff: () => 999, // deterministic fallback
    ...over,
  });

  it("returns immediately on success", async () => {
    const fetch = seqFetch([res(200)]);
    const slp = recordingSleep();
    const out = await politeFetch("/x", {}, base({ fetch, sleep: slp }));
    expect(out.status).toBe(200);
    expect(fetch.calls).toHaveLength(1);
    expect(slp.delays).toEqual([]);
  });

  it("retries on 429 and waits the Retry-After time", async () => {
    const fetch = seqFetch([res(429, { "retry-after": "3" }), res(200)]);
    const slp = recordingSleep();
    const out = await politeFetch("/x", {}, base({ fetch, sleep: slp }));
    expect(out.status).toBe(200);
    expect(fetch.calls).toHaveLength(2);
    expect(slp.delays).toEqual([3000]);
  });

  it("falls back to backoff when the server is silent", async () => {
    const fetch = seqFetch([res(429), res(200)]);
    const slp = recordingSleep();
    await politeFetch("/x", {}, base({ fetch, sleep: slp }));
    expect(slp.delays).toEqual([999]);
  });

  it("stops after maxRetries and returns the last response", async () => {
    const fetch = seqFetch([res(429, { "retry-after": "1" })]);
    const slp = recordingSleep();
    const out = await politeFetch("/x", {}, base({ fetch, sleep: slp, maxRetries: 2 }));
    expect(out.status).toBe(429);
    expect(fetch.calls).toHaveLength(3); // 1 initial + 2 retries
    expect(slp.delays).toEqual([1000, 1000]);
  });

  it("clamps delays to maxDelayMs", async () => {
    const fetch = seqFetch([res(429, { "retry-after": "9999" }), res(200)]);
    const slp = recordingSleep();
    await politeFetch("/x", {}, base({ fetch, sleep: slp, maxDelayMs: 5000 }));
    expect(slp.delays).toEqual([5000]);
  });

  it("retries network errors then succeeds", async () => {
    const fetch = seqFetch([new TypeError("network down"), res(200)]);
    const slp = recordingSleep();
    const out = await politeFetch("/x", {}, base({ fetch, sleep: slp }));
    expect(out.status).toBe(200);
    expect(slp.delays).toEqual([999]);
  });

  it("does not retry network errors when disabled", async () => {
    const fetch = seqFetch([new TypeError("boom"), res(200)]);
    const slp = recordingSleep();
    await expect(
      politeFetch("/x", {}, base({ fetch, sleep: slp, retryOnNetworkError: false })),
    ).rejects.toThrow("boom");
  });

  it("reports the reason via onRetry", async () => {
    const fetch = seqFetch([res(429, { "retry-after": "2" }), res(200)]);
    const slp = recordingSleep();
    const reasons: string[] = [];
    await politeFetch(
      "/x",
      {},
      base({ fetch, sleep: slp, onRetry: (i) => reasons.push(i.reason) }),
    );
    expect(reasons).toEqual(["retry-after"]);
  });

  it("honors a custom retryOn predicate", async () => {
    const fetch = seqFetch([res(500), res(200)]);
    const slp = recordingSleep();
    const out = await politeFetch(
      "/x",
      {},
      base({ fetch, sleep: slp, retryOn: (r) => r.status === 500 }),
    );
    expect(out.status).toBe(200);
    expect(fetch.calls).toHaveLength(2);
  });

  it("createPoliteFetch bakes in defaults", async () => {
    const fetch = seqFetch([res(429, { "retry-after": "1" }), res(200)]);
    const slp = recordingSleep();
    const pf = createPoliteFetch({ fetch, sleep: slp, backoff: () => 1 });
    const out = await pf("/x");
    expect(out.status).toBe(200);
    expect(slp.delays).toEqual([1000]);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const start = Date.now();
    await sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(50, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when aborted mid-wait", async () => {
    const ctrl = new AbortController();
    const p = sleep(1000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
