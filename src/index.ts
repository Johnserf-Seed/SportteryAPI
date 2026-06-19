// Cloudflare Worker entry — Sporttery 竞彩足球 odds-derivation REST API.

import type { Env } from "./env.ts";
import type { PoolCode } from "./types.ts";
import { corsPreflight, fail, HttpError, ok, readJson } from "./http.ts";
import { cacheTtlSeconds, getOdds, UpstreamError } from "./upstream.ts";
import { isAuthorized } from "./auth.ts";
import { parseUpstream } from "./parse.ts";
import { compareOdds, deriveMarket, round } from "./derive.ts";
import { calcParlay, listParlayTypes, PARLAY_TABLE, TICKET_CAP, UNIT_PRICE } from "./parlay.ts";
import { POOL_MAX_ALLUP, POOL_NAME_ZH } from "./labels.ts";

export { OddsStream } from "./stream.ts";

const POOL_SET = new Set<PoolCode>(["had", "hhad", "crs", "ttg", "hafu"]);

function parsePools(value: string | null, fallback: string): PoolCode[] {
  const src = value && value.trim() ? value : fallback;
  const list = src
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is PoolCode => POOL_SET.has(s as PoolCode));
  return list.length ? list : (["had", "hhad", "crs", "ttg", "hafu"] as PoolCode[]);
}

const SERVICE_INFO = {
  service: "sporttery-odds-api",
  description:
    "China Sports Lottery 竞彩足球 odds-derivation REST API (derived purely from odds).",
  upstream: "https://m.sporttery.cn/mjc/jsq/zqspf/",
  endpoints: {
    "GET /health": "liveness probe",
    "GET /api/matches": "live matches + odds + derived metrics. query: pools,date,league,matchId",
    "GET /api/match/:matchId": "one match by upstream matchId",
    "GET /api/parlay/types": "the full 过关 (M串N) reference table. query: matches",
    "GET /api/meta": "pool labels, parlay table, and the odds formulas this service uses",
    "POST /api/derive": "derive implied/no-vig probs, return rate, fair odds from odds. body: {odds:[...]} or {h,d,a}",
    "POST /api/value": "Kelly index / value vs a reference odds set. body: {offered:[...], reference:[...], labels?:[...]}",
    "POST /api/parlay": "过关/单关 prize calculator. body: {legs:[{odds,result?}], passType?, folds?, multiplier?}",
    "GET /stream": "WebSocket real-time odds stream (future; requires the OddsStream DO to be enabled)",
  },
  auth: "If API_KEY is configured, /api/* and /stream require it via 'Authorization: Bearer <key>' or 'X-API-Key: <key>'. /stream may also use ?key= (WebSocket only).",
  note: "Live odds are pulled from sporttery (set UPSTREAM_PROXY to an upstream-reachable relay to bypass the geo-block). Compute endpoints (derive/value/parlay) work anywhere.",
  dataSource: "https://webapi.sporttery.cn — the undocumented public web API behind the official 竞彩 calculator. Data © 中国体育彩票.",
};

function parseMatchId(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, "matchId must be a number");
  return n;
}

async function handleMatches(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pools = parsePools(url.searchParams.get("pools"), env.DEFAULT_POOLS ?? "hhad,had,crs,ttg,hafu");
  const { data, source } = await getOdds(env, ctx);
  const result = parseUpstream(data, {
    pools,
    date: url.searchParams.get("date") ?? undefined,
    league: url.searchParams.get("league") ?? undefined,
    matchId: parseMatchId(url.searchParams.get("matchId")),
  });
  result.source = source;
  return ok(result, { "Cache-Control": `public, max-age=${cacheTtlSeconds(env)}` });
}

async function handleMatch(matchId: number, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pools = parsePools(null, env.DEFAULT_POOLS ?? "hhad,had,crs,ttg,hafu");
  const { data } = await getOdds(env, ctx);
  const result = parseUpstream(data, { pools, matchId });
  if (result.matchCount === 0) throw new HttpError(404, `match ${matchId} not found or not currently selling`);
  return ok(result.matches[0]);
}

function deriveBody(body: any): Response {
  let odds: number[] = [];
  let keys: string[] | undefined;
  if (Array.isArray(body?.odds)) {
    odds = body.odds.map(Number);
  } else if (body && ["h", "d", "a"].every((k) => k in body)) {
    odds = [Number(body.h), Number(body.d), Number(body.a)];
    keys = ["home", "draw", "away"];
  } else {
    throw new HttpError(400, "provide {odds:[...]} (any N-way market) or all of {h,d,a}");
  }
  if (odds.length < 2 || odds.some((o) => !Number.isFinite(o) || o <= 1)) {
    throw new HttpError(400, "need at least 2 decimal odds, each > 1");
  }
  const d = deriveMarket(odds);
  return ok({
    overround: round(d.overround, 6),
    returnRate: round(d.returnRate, 6),
    returnRatePct: round(d.returnRate * 100, 3),
    margin: round(d.margin, 6),
    outcomes: d.perOutcome.map((o, i) => ({
      key: keys?.[i] ?? String(i),
      odds: o.odds,
      impliedProb: round(o.impliedProb, 6),
      noVigProb: round(o.noVigProb, 6),
      fairOdds: round(o.fairOdds, 4),
    })),
  });
}

function valueBody(body: any): Response {
  const offered = body?.offered;
  const reference = body?.reference;
  if (!Array.isArray(offered) || !Array.isArray(reference)) {
    throw new HttpError(400, "provide {offered:[...], reference:[...]} with equal length");
  }
  const off = offered.map(Number);
  const ref = reference.map(Number);
  if (off.length !== ref.length || off.length < 2) {
    throw new HttpError(400, "offered and reference must be the same length (>= 2)");
  }
  if ([...off, ...ref].some((o) => !Number.isFinite(o) || o <= 1)) {
    throw new HttpError(400, "all odds must be decimal and > 1");
  }
  let analyses;
  try {
    analyses = compareOdds(off, ref);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const labels: string[] | undefined = Array.isArray(body?.labels) ? body.labels : undefined;
  return ok({
    outcomes: analyses.map((a, i) => ({
      label: labels?.[i] ?? String(i),
      odds: a.odds,
      refProb: round(a.refProb, 6),
      kelly: round(a.kelly, 4),
      ev: round(a.ev, 4),
      kellyFraction: round(a.kellyFraction, 4),
      isValue: a.isValue,
    })),
    bestValue:
      analyses
        .map((a, i) => ({ i, kelly: a.kelly }))
        .sort((x, y) => y.kelly - x.kelly)[0]?.i ?? null,
  });
}

const META = {
  pools: (Object.keys(POOL_NAME_ZH) as PoolCode[]).map((p) => ({
    code: p,
    nameZh: POOL_NAME_ZH[p],
    maxAllUp: POOL_MAX_ALLUP[p],
  })),
  parlay: {
    unitPriceYuan: UNIT_PRICE,
    ticketCapYuan: TICKET_CAP,
    note: "单注金额2元；单关=2×倍数×赔率；M串N每注=2×倍数×Π(赔率)；单张彩票封顶500万元；混合过关取最小关数(木桶原则)。",
    table: PARLAY_TABLE,
  },
  formulas: {
    impliedProb: "1 / odds",
    overround: "Σ(1/odds)  (总概率)",
    returnRate: "1 / overround  (返还率, 理论返还率)",
    margin: "1 - returnRate  (庄家抽水)",
    noVigProb: "(1/odds) / overround  (标准化/去水真实概率, 比例归一)",
    fairOdds: "1 / noVigProb = odds × overround  (真实赔率)",
    kellyIndex: "offeredOdds × referenceProb  (凯利指数; 需外部参考赔率, 单一赔率退化为返还率)",
    ev: "referenceProb × offeredOdds - 1  (期望值, =kelly-1)",
  },
};

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") return corsPreflight();

  // Open endpoints (no auth).
  if (method === "GET" && path === "/") return ok(SERVICE_INFO);
  if (method === "GET" && path === "/health") return ok({ ok: true });

  // Everything below (/api/*, /stream) requires the API key when one is configured.
  // ?key= is accepted ONLY for the /stream WebSocket (query keys leak into logs).
  if (!isAuthorized(req, url, env, path === "/stream")) {
    return fail(401, "unauthorized — provide a valid API key (Authorization: Bearer <key> or X-API-Key; ?key= only for /stream)");
  }

  // WebSocket stream (future). Routes to the DO only if the binding is enabled.
  if (path === "/stream") {
    if (!env.ODDS_STREAM) {
      return fail(501, "real-time stream not enabled — uncomment the OddsStream DO in wrangler.jsonc");
    }
    const id = env.ODDS_STREAM.idFromName("global");
    return env.ODDS_STREAM.get(id).fetch(req);
  }

  if (method === "GET" && path === "/api/meta") return ok(META);

  if (method === "GET" && path === "/api/matches") return handleMatches(url, env, ctx);

  const matchMatch = /^\/api\/match\/(\d+)$/.exec(path);
  if (method === "GET" && matchMatch) return handleMatch(Number(matchMatch[1]), env, ctx);

  if (method === "GET" && path === "/api/parlay/types") {
    const m = url.searchParams.get("matches");
    return ok(listParlayTypes(m ? Number(m) : undefined));
  }

  if (method === "POST" && path === "/api/derive") return deriveBody(await readJson(req));
  if (method === "POST" && path === "/api/value") return valueBody(await readJson(req));
  if (method === "POST" && path === "/api/parlay") {
    try {
      return ok(calcParlay(await readJson(req)));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  }

  return fail(404, `no route for ${method} ${path}`);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message, e.details);
      if (e instanceof UpstreamError) return fail(e.status, e.message);
      return fail(500, "internal error", (e as Error).message);
    }
  },

  // Cron handler (enable "triggers.crons" in wrangler.jsonc) — future: drives the
  // OddsStream WebSocket poller. No-op unless the DO is enabled.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.ODDS_STREAM) {
      const id = env.ODDS_STREAM.idFromName("global");
      const stub = env.ODDS_STREAM.get(id) as unknown as { poll(): Promise<void> };
      ctx.waitUntil(stub.poll().catch(() => {}));
    }
  },
} satisfies ExportedHandler<Env>;
