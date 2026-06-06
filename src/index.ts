/**
 * polite-fetch
 *
 * A rate-limit-aware `fetch` wrapper. When a server responds with 429/503 it
 * almost always tells you when to come back — via `Retry-After`, `X-RateLimit-*`,
 * or provider-specific headers. Most retry libraries ignore those and apply
 * blind exponential backoff. polite-fetch reads the headers and waits exactly
 * as long as the server asked (falling back to jittered backoff only when the
 * server stays silent).
 *
 * Supported signals:
 *   - `Retry-After` (delta-seconds or HTTP-date)            [RFC 9110]
 *   - `X-RateLimit-Reset` / `X-RateLimit-Remaining`         [GitHub + generic]
 *   - OpenAI    `x-ratelimit-reset-{requests,tokens}` (Go durations like "6m0s")
 *   - Anthropic `anthropic-ratelimit-{requests,tokens}-reset` (RFC 3339 dates)
 *   - GitHub    `x-ratelimit-reset` (epoch seconds) + `x-ratelimit-remaining`
 *   - Stripe / Shopify REST: `Retry-After`
 */

export interface RateLimitResult {
  /** Recommended wait in milliseconds, or `null` when no signal was found. */
  delayMs: number | null;
  /** Which signal produced the delay, or `null`. */
  source:
    | "retry-after"
    | "openai"
    | "anthropic"
    | "github"
    | "x-ratelimit"
    | null;
}

/** A header source: a `Response`, a `Headers`, or a plain record. */
export type HeaderSource =
  | Response
  | Headers
  | Record<string, string | number | undefined>;

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

const GO_DURATION = /^((?:\d+(?:\.\d+)?)(?:ns|µs|us|ms|s|m|h))+$/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|µs|us|ms|s|m|h)/g;

/**
 * Parse a Go-style duration string (e.g. `"1s"`, `"6m0s"`, `"880ms"`,
 * `"1h2m3s"`) into milliseconds. Returns `null` if the whole string is not a
 * valid duration. This is the format OpenAI uses for its reset headers.
 */
export function parseDuration(value: string): number | null {
  const v = value.trim();
  if (!GO_DURATION.test(v)) return null;
  let total = 0;
  GO_DURATION_PART.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GO_DURATION_PART.exec(v)) !== null) {
    total += parseFloat(m[1]!) * UNIT_MS[m[2]!]!;
  }
  return total;
}

/**
 * Interpret a numeric reset value. Heuristic:
 *   - `>= 1e12` → epoch milliseconds
 *   - `>= 1e7`  → epoch seconds (e.g. GitHub `x-ratelimit-reset`)
 *   - otherwise → delta seconds (e.g. `Retry-After: 30`)
 */
function resolveNumeric(n: number, now: number): number {
  if (n >= 1e12) return n - now;
  if (n >= 1e7) return n * 1000 - now;
  return n * 1000;
}

/**
 * Parse any single rate-limit value into a delay in milliseconds relative to
 * `now`. Handles delta-seconds, epoch seconds/ms, Go durations, RFC 3339 / HTTP
 * dates. Returns `null` when nothing parseable is found. Negative results are
 * clamped to 0.
 */
export function parseDelayValue(value: string, now: number = Date.now()): number | null {
  const v = value.trim();
  if (!v) return null;

  if (/^-?\d+(\.\d+)?$/.test(v)) {
    return Math.max(0, resolveNumeric(Number(v), now));
  }

  const dur = parseDuration(v);
  if (dur != null) return Math.max(0, dur);

  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.max(0, t - now);

  return null;
}

function getHeaders(source: HeaderSource): {
  get: (name: string) => string | null;
  status?: number;
} {
  if (source instanceof Headers) {
    return { get: (n) => source.get(n) };
  }
  if (typeof Response !== "undefined" && source instanceof Response) {
    return { get: (n) => source.headers.get(n), status: source.status };
  }
  // plain record (case-insensitive lookup)
  const lower: Record<string, string> = {};
  for (const [k, val] of Object.entries(source as Record<string, unknown>)) {
    if (val != null) lower[k.toLowerCase()] = String(val);
  }
  return { get: (n) => lower[n.toLowerCase()] ?? null };
}

interface ProviderPair {
  name: Exclude<RateLimitResult["source"], "retry-after" | null>;
  remaining: string;
  reset: string;
}

const PROVIDER_PAIRS: ProviderPair[] = [
  // OpenAI
  { name: "openai", remaining: "x-ratelimit-remaining-requests", reset: "x-ratelimit-reset-requests" },
  { name: "openai", remaining: "x-ratelimit-remaining-tokens", reset: "x-ratelimit-reset-tokens" },
  // Anthropic
  { name: "anthropic", remaining: "anthropic-ratelimit-requests-remaining", reset: "anthropic-ratelimit-requests-reset" },
  { name: "anthropic", remaining: "anthropic-ratelimit-tokens-remaining", reset: "anthropic-ratelimit-tokens-reset" },
  // GitHub + generic X-RateLimit-*
  { name: "github", remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" },
];

function isExhausted(remaining: string | null, status?: number): boolean {
  if (remaining != null) return Number(remaining) <= 0;
  // No remaining header, but a 429 with a reset header means we're throttled.
  return status === 429;
}

/**
 * Inspect a response (or raw headers) and return the recommended wait time.
 *
 * Precedence: an explicit `Retry-After` always wins. Otherwise the soonest-safe
 * delay is the *maximum* reset across any exhausted provider limit (so callers
 * wait until every depleted bucket has refilled).
 */
export function parseRateLimit(
  source: HeaderSource,
  options: { now?: number } = {},
): RateLimitResult {
  const now = options.now ?? Date.now();
  const { get, status } = getHeaders(source);

  const retryAfter = get("retry-after");
  if (retryAfter != null) {
    const ms = parseDelayValue(retryAfter, now);
    if (ms != null) return { delayMs: ms, source: "retry-after" };
  }

  let best: number | null = null;
  let bestSource: RateLimitResult["source"] = null;

  for (const pair of PROVIDER_PAIRS) {
    const reset = get(pair.reset);
    if (reset == null) continue;
    if (!isExhausted(get(pair.remaining), status)) continue;
    const ms = parseDelayValue(reset, now);
    if (ms == null) continue;
    if (best == null || ms > best) {
      best = ms;
      // Generic X-RateLimit-* (not GitHub-specific) still reports as "github"
      // pair name; relabel to "x-ratelimit" when no GitHub-only context exists.
      bestSource = pair.name === "github" ? "x-ratelimit" : pair.name;
    }
  }

  return { delayMs: best, source: bestSource };
}

/** Information passed to the `onRetry` callback before each wait. */
export interface RetryInfo {
  /** 0-based retry index (0 = first retry). */
  attempt: number;
  /** The response that triggered the retry, if any (absent for network errors). */
  response?: Response;
  /** The error that triggered the retry, if any. */
  error?: unknown;
  /** How long polite-fetch will wait, in milliseconds. */
  delayMs: number;
  /** Why this delay was chosen. */
  reason: NonNullable<RateLimitResult["source"]> | "backoff" | "network-error";
}

export interface PoliteFetchOptions {
  /** Maximum number of retries (not counting the initial request). Default 3. */
  maxRetries?: number;
  /** HTTP statuses that trigger a retry. Default `[429, 503]`. */
  retryStatuses?: number[];
  /** Custom predicate; overrides `retryStatuses` when provided. */
  retryOn?: (response: Response, attempt: number) => boolean;
  /** Retry when `fetch` itself throws (network errors). Default true. */
  retryOnNetworkError?: boolean;
  /** The underlying fetch implementation. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Hard cap on any single wait, in ms. Default 60_000. */
  maxDelayMs?: number;
  /** Floor on any single wait, in ms. Default 0. */
  minDelayMs?: number;
  /**
   * Backoff used when the server gives no timing hint. Receives the 0-based
   * attempt index. Default: full-jitter exponential (base 500ms, cap maxDelayMs).
   */
  backoff?: (attempt: number) => number;
  /** Called before each wait. */
  onRetry?: (info: RetryInfo) => void;
  /** Injectable sleep (for testing). Default: real timer honoring AbortSignal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Sleep for `ms`, rejecting early if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultBackoff(attempt: number, cap: number): number {
  const exp = Math.min(cap, 500 * 2 ** attempt);
  return Math.random() * exp; // full jitter
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

/**
 * A drop-in `fetch` that respects server-provided rate-limit timing.
 *
 * Returns the final `Response` (even if it is still an error after exhausting
 * retries), exactly like `fetch`. Throws only on network errors or abort.
 */
export async function politeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: PoliteFetchOptions = {},
): Promise<Response> {
  const {
    maxRetries = 3,
    retryStatuses = [429, 503],
    retryOn,
    retryOnNetworkError = true,
    fetch: fetchImpl = globalThis.fetch,
    maxDelayMs = 60_000,
    minDelayMs = 0,
    backoff = (attempt) => defaultBackoff(attempt, maxDelayMs),
    onRetry,
    sleep: sleepImpl = sleep,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("polite-fetch: no fetch implementation available");
  }

  const signal = init?.signal ?? undefined;
  const clamp = (ms: number) => Math.min(maxDelayMs, Math.max(minDelayMs, ms));
  const shouldRetry = (res: Response, attempt: number) =>
    retryOn ? retryOn(res, attempt) : retryStatuses.includes(res.status);

  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (retryOnNetworkError && attempt < maxRetries) {
        const delay = clamp(backoff(attempt));
        onRetry?.({ attempt, error: err, delayMs: delay, reason: "network-error" });
        await sleepImpl(delay, signal);
        attempt++;
        continue;
      }
      throw err;
    }

    if (!shouldRetry(response, attempt) || attempt >= maxRetries) {
      return response;
    }

    const { delayMs, source } = parseRateLimit(response);
    const delay = clamp(delayMs ?? backoff(attempt));
    onRetry?.({
      attempt,
      response,
      delayMs: delay,
      reason: source ?? "backoff",
    });

    // Free the unconsumed body before retrying so the connection can be reused.
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }

    await sleepImpl(delay, signal);
    attempt++;
  }
}

/** Create a `politeFetch` with baked-in default options. */
export function createPoliteFetch(
  defaults: PoliteFetchOptions = {},
): (
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: PoliteFetchOptions,
) => Promise<Response> {
  return (input, init, options) =>
    politeFetch(input, init, { ...defaults, ...options });
}

export default politeFetch;
