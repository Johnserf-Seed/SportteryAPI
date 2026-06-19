// Worker environment bindings (configured in wrangler.jsonc / secrets).

export interface Env {
  /** Default comma-separated pool codes to fetch from upstream. */
  DEFAULT_POOLS?: string;
  /** Seconds to cache an upstream response (per-colo Cache API). */
  CACHE_TTL_SECONDS?: string;
  /** Forwarding-proxy URL prefix prepended to the upstream URL (bypass geo-block). */
  UPSTREAM_PROXY?: string;
  /** Comma-separated API key(s) gating /api/* and /stream. Unset = auth disabled. */
  API_KEY?: string;
  /** Optional Durable Object for the real-time WebSocket stream (future). */
  ODDS_STREAM?: DurableObjectNamespace;
}
