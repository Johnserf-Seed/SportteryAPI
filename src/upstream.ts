// Cached client for the Sporttery upstream odds endpoint.
//
// The endpoint behind https://m.sporttery.cn/mjc/jsq/zqspf/ returns all
// currently-selling 竞彩足球 matches with had/hhad/crs/ttg/hafu odds.
//
// IMPORTANT — geo-block: the upstream is geo-restricted and rejects datacenter
// IPs (incl. Cloudflare) with HTTP 567. To pull from a globally-deployed Worker,
// set the `UPSTREAM_PROXY` var to a forwarding relay that can reach the upstream
// (see fetchUpstreamDirect).
//
// Serving:
//   1. Cache API — per-colo, short TTL (default 30s); de-dupes bursts.
//   2. upstream  — fetched on a miss (optionally via UPSTREAM_PROXY).

import type { Env } from "./env.ts";

const UPSTREAM = "https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

/** Synthetic per-colo Cache key (the cached body is always the full payload). */
const CACHE_KEY = new Request("https://odds-cache.internal/v1/latest");

export class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface OddsResult {
  data: any;
  /** Which tier served the payload: edge-cache | upstream. */
  source: string;
}

/** The full canonical pool set. The Worker always fetches ALL pools so any
 *  ?pools subset can be served from one cache entry, regardless of DEFAULT_POOLS
 *  (which only controls the per-request response default in the router). */
const ALL_POOLS = "hhad,had,crs,ttg,hafu";

/** Validated Cache-API TTL in seconds (>= 1; falls back to 30). */
export function cacheTtlSeconds(env: Env): number {
  const n = Number(env.CACHE_TTL_SECONDS ?? "30");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}

function snapResponse(body: string, ttl: number): Response {
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
  });
}

function isSportteryPayload(v: any): boolean {
  return !!(v && v.value && Array.isArray(v.value.matchInfoList));
}

/**
 * Fetch directly from upstream (no caching layer). Throws on any failure.
 * `proxy`, if set, routes through a relay that can reach the upstream (Workers
 * can't use CONNECT proxies). Two forms are supported:
 *   - contains "{url}": the placeholder is replaced with the percent-encoded
 *     target, e.g. "https://relay.example/fetch?url={url}".
 *   - otherwise: treated as a transparent prefix, e.g. "https://relay.example/".
 */
export async function fetchUpstreamDirect(pools: string, ttl: number, proxy?: string): Promise<any> {
  const target = `${UPSTREAM}?poolCode=${encodeURIComponent(pools)}&channel=c`;
  const url = proxy
    ? proxy.includes("{url}")
      ? proxy.replace("{url}", encodeURIComponent(target))
      : `${proxy}${target}`
    : target;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: "https://m.sporttery.cn/",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
  } catch (e) {
    throw new UpstreamError(502, `failed to reach upstream: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new UpstreamError(502, `upstream responded ${res.status} (geo-block? set UPSTREAM_PROXY to an upstream-reachable relay)`);
  }
  const data = (await res.json()) as any;
  if (!isSportteryPayload(data) || data.success === false) {
    throw new UpstreamError(502, data?.errorMessage || "upstream returned an unexpected body");
  }
  return data;
}

/**
 * Get the latest full payload via the per-colo Cache, falling through to a
 * direct upstream fetch (optionally proxied). Always uses the full pool set;
 * callers filter pools downstream.
 */
export async function getOdds(env: Env, ctx: ExecutionContext): Promise<OddsResult> {
  const ttl = cacheTtlSeconds(env);
  const cache = caches.default;

  const hit = await cache.match(CACHE_KEY);
  if (hit) return { data: await hit.json(), source: "edge-cache" };

  const data = await fetchUpstreamDirect(ALL_POOLS, ttl, env.UPSTREAM_PROXY);
  const body = JSON.stringify(data);
  ctx.waitUntil(cache.put(CACHE_KEY, snapResponse(body, ttl)));
  return { data, source: "upstream" };
}
