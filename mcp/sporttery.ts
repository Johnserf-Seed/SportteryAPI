// Node-side sporttery client for the local MCP server.
//
// Runs locally and reaches sporttery directly from your own network (unlike the
// geo-blocked Cloudflare Worker). Supports an optional outbound HTTP proxy via
// SPORTTERY_PROXY / HTTPS_PROXY (useful behind a corporate/clash proxy), and a
// small in-memory cache (disable with { cache: false }).

const UPSTREAM = "https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  Referer: "https://m.sporttery.cn/",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const TTL_MS = 25_000;
let cache: { ts: number; pools: string; data: any } | null = null;

// Lazily build an undici ProxyAgent only if a proxy is configured.
let dispatcherPromise: Promise<any> | undefined;
function proxyUrl(): string {
  return (
    process.env.SPORTTERY_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    ""
  );
}
async function getDispatcher(): Promise<any> {
  if (dispatcherPromise !== undefined) return dispatcherPromise;
  const proxy = proxyUrl();
  if (!proxy) {
    dispatcherPromise = Promise.resolve(null);
    return null;
  }
  dispatcherPromise = import("undici")
    .then(({ ProxyAgent }) => {
      console.error(`[sporttery] using HTTP proxy ${proxy}`);
      return new ProxyAgent(proxy);
    })
    .catch((e) => {
      console.error(`[sporttery] proxy init failed (install 'undici'): ${(e as Error).message}`);
      return null;
    });
  return dispatcherPromise;
}

export async function fetchSporttery(pools: string, opts: { cache?: boolean } = {}): Promise<any> {
  const useCache = opts.cache !== false;
  const now = Date.now();
  if (useCache && cache && cache.pools === pools && now - cache.ts < TTL_MS) return cache.data;

  const url = `${UPSTREAM}?poolCode=${encodeURIComponent(pools)}&channel=c`;
  const dispatcher = await getDispatcher();
  const init: any = { headers: HEADERS };
  if (dispatcher) init.dispatcher = dispatcher;

  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`sporttery upstream HTTP ${res.status} (geo-restricted; needs an upstream-reachable network/proxy + browser headers)`);
  }
  const data = (await res.json()) as any;
  if (!data || !data.value || !Array.isArray(data.value.matchInfoList)) {
    throw new Error("unexpected sporttery payload");
  }
  if (useCache) cache = { ts: now, pools, data };
  return data;
}
