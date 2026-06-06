# polite-fetch

A rate-limit-aware `fetch` wrapper. When an API responds with `429`/`503` it
almost always tells you *when to come back* — but most retry libraries ignore
that and apply blind exponential backoff, hammering the server early and waiting
too long when it actually matters.

`polite-fetch` reads the server's own timing headers and waits **exactly** as
long as it asked, falling back to jittered exponential backoff only when the
server gives no hint.

## Signals it understands

| Source | Headers | Format |
| --- | --- | --- |
| Standard | `Retry-After` | delta-seconds or HTTP-date (RFC 9110) |
| OpenAI | `x-ratelimit-reset-requests` / `-tokens` (+ `-remaining-*`) | Go durations: `"1s"`, `"6m0s"`, `"880ms"` |
| Anthropic | `anthropic-ratelimit-{requests,tokens}-reset` (+ `-remaining`) | RFC 3339 timestamps |
| GitHub | `x-ratelimit-reset` (+ `x-ratelimit-remaining`) | epoch seconds |
| Generic | `X-RateLimit-Reset` / `X-RateLimit-Remaining` | epoch sec/ms or delta |
| Stripe / Shopify REST | `Retry-After` | seconds |

When several limits are exhausted, it waits for the **latest** reset so every
depleted bucket has refilled. An explicit `Retry-After` always takes precedence.

## Install

```sh
npm install polite-fetch
```

Requires Node 18+ (global `fetch`) or any environment with a `fetch` you can
pass in.

## Usage

```ts
import { politeFetch } from "polite-fetch";

// Drop-in replacement for fetch:
const res = await politeFetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}` },
  body: JSON.stringify(payload),
});
```

With options and a baked-in client:

```ts
import { createPoliteFetch } from "polite-fetch";

const api = createPoliteFetch({
  maxRetries: 5,
  maxDelayMs: 30_000,
  onRetry: ({ attempt, delayMs, reason }) =>
    console.warn(`retry #${attempt + 1} in ${delayMs}ms (${reason})`),
});

const res = await api("https://api.github.com/user");
```

## API

### `politeFetch(input, init?, options?) => Promise<Response>`
A drop-in `fetch`. Returns the final `Response` (even if still an error after
retries are exhausted), exactly like `fetch`. Throws only on network errors or
abort. Honors `init.signal` during waits.

#### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maxRetries` | `3` | Retries after the initial request. |
| `retryStatuses` | `[429, 503]` | Statuses that trigger a retry. |
| `retryOn(res, attempt)` | — | Custom predicate; overrides `retryStatuses`. |
| `retryOnNetworkError` | `true` | Retry when `fetch` throws. |
| `fetch` | global `fetch` | Underlying implementation. |
| `maxDelayMs` | `60000` | Hard cap on any single wait. |
| `minDelayMs` | `0` | Floor on any single wait. |
| `backoff(attempt)` | full-jitter exp (base 500ms) | Used only when no header hint exists. |
| `onRetry(info)` | — | Called before each wait with `{ attempt, response?, error?, delayMs, reason }`. |
| `sleep(ms, signal?)` | real timer | Injectable (for tests). |

### `createPoliteFetch(defaults) => politeFetch`
Returns a `politeFetch` with baked-in defaults (still overridable per call).

### `parseRateLimit(source, { now? }) => { delayMs, source }`
Inspect a `Response`, `Headers`, or plain header record and get the recommended
wait in ms (or `null`). `source` is one of `"retry-after" | "openai" |
"anthropic" | "github" | "x-ratelimit" | null`. Useful for proactive throttling.

### `parseDelayValue(value, now?)` / `parseDuration(value)` / `sleep(ms, signal?)`
Low-level helpers: parse any single rate-limit value to ms, parse a Go-style
duration to ms, and an abortable sleep.

## Notes & scope

- **Reactive, not a token bucket.** It reacts to responses; it doesn't
  pre-emptively pace requests (though `parseRateLimit` lets you build that).
- The numeric `X-RateLimit-Reset` heuristic treats values `≥ 1e7` as epoch
  seconds, `≥ 1e12` as epoch ms, and smaller values as delta-seconds — covering
  the common conventions. Pass an explicit `now` to `parseRateLimit` in tests.
- Provider header names are matched case-insensitively and detected by presence,
  so no per-host configuration is needed.

## License

MIT
