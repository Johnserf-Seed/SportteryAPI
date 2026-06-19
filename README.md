# Sporttery Odds API

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/Johnserf-Seed/SportteryAPI/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnserf-Seed/SportteryAPI/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-server-0098FF)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Johnserf-Seed/SportteryAPI)

A **Cloudflare Worker REST API + local MCP server** that implements a clean,
agent-callable 竞彩足球 (China Sports Lottery football) odds service. It serves the
**latest odds** and **derives everything purely from those odds** — implied &
no-vig probabilities, 返还率 (return rate), fair odds, Kelly/value vs. a reference,
and full 单关/过关 (parlay) prize calculation.

```
┌── live odds ──────────────┐   ┌── pure math (no upstream) ──────────────┐
│ GET /api/matches          │   │ POST /api/derive   赔率推导               │
│ GET /api/match/:id        │   │ POST /api/value    凯利指数/价值          │
└───────────────────────────┘   │ POST /api/parlay   单关/过关奖金          │
                                 │ GET  /api/parlay/types · GET /api/meta   │
                                 └──────────────────────────────────────────┘
```

- **Agent-first.** JSON in / JSON out, open CORS, self-describing `/api/meta`,
  optional **API-key auth**, plus a local **MCP server** exposing the same power.
- **Pure, tested math.** All derivation/parlay logic lives in dependency-free
  modules with 25 unit tests — no build step (`npm test`).
- **Simple data path.** Per-colo Cache → upstream (optionally through an
  upstream-reachable relay via `UPSTREAM_PROXY`). The local MCP server fetches sporttery directly.

> ⚠️ **Geo-block.** The upstream is geo-restricted and rejects datacenter IPs
> (incl. Cloudflare) with HTTP **567**. To serve live odds from the deployed
> Worker, set `UPSTREAM_PROXY` to a forwarding relay that can reach the upstream.
> When the runtime can reach the upstream directly (local dev, or the MCP server),
> no proxy is needed. The compute endpoints (`derive`/`value`/`parlay`) need no
> upstream and work everywhere.

---

## Table of contents

- [Quick start](#quick-start)
- [Project layout](#project-layout)
- [Architecture & data flow](#architecture--data-flow)
- [Authentication](#authentication)
- [REST endpoints](#rest-endpoints)
- [The math (赔率推导)](#the-math-赔率推导)
- [Pools & outcome codes](#pools--outcome-codes)
- [Parlay (过关) rules](#parlay-过关-rules)
- [MCP server (local stdio)](#mcp-server-local-stdio)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Caching](#caching)
- [Future: real-time WebSocket stream](#future-real-time-websocket-stream)
- [Development & testing](#development--testing)
- [Data source](#data-source)
- [Crawling & robots policy](#crawling--robots-policy)
- [Disclaimer](#disclaimer)

---

## Quick start

Requires **Node ≥ 22.6** (for `--experimental-strip-types`; tests & scripts run
TypeScript with no build step).

```bash
npm install
npm test                  # 25 unit tests (math/parse/parlay/labels), no network
npm run dev               # wrangler dev → http://localhost:8787
curl http://localhost:8787/api/matches | jq '.data.matches[0]'
```

When the Worker can reach the upstream (e.g. local dev), `/api/matches` pulls
sporttery directly (`source: upstream`).

---

## Project layout

```
SportteryAPI/
├── src/                     # Cloudflare Worker
│   ├── index.ts             # router / HTTP entry, all REST endpoints
│   ├── auth.ts              # API-key authentication
│   ├── derive.ts    ✅pure   # 赔率推导: implied/no-vig prob, 返还率, fair odds, Kelly
│   ├── parlay.ts    ✅pure   # 单关/过关 M串N table + payout calculator
│   ├── labels.ts    ✅pure   # decode had/hhad/crs/ttg/hafu outcome codes
│   ├── parse.ts     ✅pure   # raw upstream JSON → normalized + derived Match[]
│   ├── upstream.ts          # Cache API → upstream fetch (optional UPSTREAM_PROXY)
│   ├── stream.ts            # OddsStream Durable Object (future WebSocket)
│   ├── env.ts / http.ts / types.ts
├── mcp/                     # Local stdio MCP server
│   ├── server.ts            # MCP tools (get_matches, derive_odds, calc_parlay, …)
│   └── sporttery.ts         # node-side sporttery client (cache + optional proxy)
├── scripts/
│   ├── smoke.ts             # REST smoke test                       (BASE=… node …)
│   ├── mcp-smoke.ts         # MCP stdio smoke test                  (npm run mcp:smoke)
│   └── refresh-sample.ts    # refresh sample.json                   (npm run refresh-sample)
├── test/                    # 25 node:test unit tests (no network)
├── sample.json              # captured upstream payload (offline tests)
├── .env.example             # env-var template (MCP proxy / smoke key)
├── wrangler.jsonc           # Worker config (committed; no secrets)
├── .mcp.json                # Claude Code project MCP registration
├── .github/workflows/       # CI (typecheck+test) + Deploy (CD to Cloudflare)
└── README.md / README.zh-CN.md
```

`✅pure` modules have **no Cloudflare imports** and are unit-tested directly with
Node's type-stripping. They're shared by both the Worker and the MCP server.

---

## Architecture & data flow

```
 agent / browser ──HTTP (+ API key)──▶ Worker (index.ts)
                                          ├─ /api/matches ─▶ Cache API ─▶ upstream ─┐
                                          ├─ /api/derive|value|parlay ─▶ pure math  │
                                          └─ auth gate (auth.ts)                    │
                                                  upstream (optional UPSTREAM_PROXY) ▼
                                                            webapi.sporttery.cn
 local MCP (mcp/server.ts) ─▶ fetches sporttery directly ─▶ pure math
```

The Worker pulls odds on demand (de-duped by the per-colo Cache). When its runtime
can reach the upstream it pulls directly; from the geo-blocked global edge it needs `UPSTREAM_PROXY`.

---

## Authentication

Optional API-key auth gates `/api/*` and `/stream`. `/` and `/health` stay open.

- **Disabled by default** — if no `API_KEY` is configured, all endpoints are open
  (handy for local dev).
- **Enable** by setting the `API_KEY` secret (one key, or several comma-separated):
  ```bash
  echo "key1,key2" | npx wrangler secret put API_KEY      # production
  # local dev: put API_KEY=... in .dev.vars
  ```
- **Present the key** via any of:
  - `Authorization: Bearer <key>`
  - `X-API-Key: <key>`
  - `?key=<key>` (for WebSocket clients)
- Missing/invalid key → `401`. Keys are compared in constant time.

```bash
curl -H "Authorization: Bearer key1" http://localhost:8787/api/matches
```

---

## REST endpoints

Base URL: `http://localhost:8787` (dev) or
`https://sporttery-api.<your-subdomain>.workers.dev` (deployed). All responses
are `{ "success": true, "data": … }` or `{ "success": false, "error": "…" }`.
CORS is open (`*`). `/api/*` requires the API key when one is configured.

### `GET /api/matches` — latest odds + derived metrics
Query (all optional): `pools` (csv of `had,hhad,crs,ttg,hafu`), `date` (`260619`),
`league` (substring), `matchId`.

```bash
curl "http://localhost:8787/api/matches?pools=had,hhad" -H "X-API-Key: $KEY"
```
```jsonc
{
  "success": true,
  "data": {
    "updatedAt": "…", "matchCount": 12, "pools": ["had","hhad"],
    "source": "upstream",                    // edge-cache | upstream
    "matches": [{
      "matchId": 2040239, "matchNumStr": "周五029",
      "home": { "abbName": "美国" }, "away": { "abbName": "澳大利亚" },
      "league": { "abbName": "世界杯" },
      "markets": {
        "had": {
          "poolNameZh": "胜平负",
          "overround": 1.1294, "returnRate": 0.8854, "margin": 0.1146,
          "outcomes": [
            { "key":"home","labelZh":"主胜","odds":1.44,"trend":"down",
              "impliedProb":0.6944,"noVigProb":0.6149,"fairOdds":1.6264 },
            { "key":"draw","labelZh":"平","odds":3.90, "…":"…" },
            { "key":"away","labelZh":"主负","odds":5.60,"…":"…" }
          ]
        }
      }
    }]
  }
}
```

### `GET /api/match/:matchId` — one match by upstream `matchId` (all pools)

### `POST /api/derive` — derive metrics from raw odds (stateless)
Body: `{ "odds": [1.44, 3.90, 5.60] }` or `{ "h":1.44, "d":3.90, "a":5.60 }`.
Works for any N-outcome market.

### `POST /api/value` — Kelly index / value vs. a reference odds set
Body: `{ "offered":[2.10,3.40,3.80], "reference":[2.00,3.50,4.00], "labels":["主胜","平","主负"] }`.
The reference set is de-vigged into "true" probabilities; each offered outcome
gets `kelly` (= odds × refProb), `ev`, `kellyFraction`, `isValue`.

### `POST /api/parlay` — 单关 / 过关 prize calculator
```jsonc
{
  "legs": [ { "odds": 1.44 }, { "odds": 2.10 }, { "odds": 3.30, "result": "void" } ],
  "passType": "3串1",     // "单关", an "M串N" label, omit (= N串1), or "folds":[2,3]
  "multiplier": 2          // 倍数, default 1
}
```
Returns `bets` (注数), `totalStake`, `maxPayout`/`maxPayoutCapped`,
`realizedPayout` (honors per-leg `result: win|lose|void`), `byFold`, `capped` (500万 cap).

### `GET /api/parlay/types` — the full M串N reference table (`?matches=4` to filter)
### `GET /api/meta` — pool labels, parlay table, formulas, auth + data-source notes
### `GET /health` · `GET /` — liveness / endpoint index (no auth)

> 💡 On Windows, send Chinese request bodies from a **file** (`--data-binary @body.json`),
> not inline `-d`, to avoid command-line codepage mangling of characters like `串`.

---

## The math (赔率推导)

For an N-outcome market with decimal odds `o_i`:

| Metric | Formula |
|---|---|
| implied prob (含水概率) | `1 / o_i` |
| overround (总概率) | `S = Σ(1/o_i)` |
| **返还率** (return rate / RTP) | `1 / S` |
| margin (庄家抽水) | `1 − 1/S` |
| no-vig prob (去水真实概率) | `(1/o_i) / S` |
| fair odds (真实赔率) | `1 / noVigProb = o_i × S` |
| 凯利指数 (Kelly index) | `o_i × p_ref_i` (needs an external reference) |
| EV | `p_ref_i × o_i − 1` |

A single odds set can't yield a meaningful Kelly index (it degenerates to the
return rate), so `/api/value` requires a **reference** odds set.

---

## Pools & outcome codes

| Pool | 名称 | Outcomes |
|---|---|---|
| `had` | 胜平负 (无让球) | `h`/`d`/`a` → 主胜 / 平 / 主负 |
| `hhad` | 让球胜平负 | `h`/`d`/`a` with `goalLine` added to the **home** score |
| `crs` | 比分 | `sHHsMM` = `home:away`; `s1sh`/`s1sd`/`s1sa` = 胜其它/平其它/负其它 |
| `ttg` | 总进球 | `s0`…`s6` exact; **`s7` = 7+** |
| `hafu` | 半全场 | 9 codes, 1st char = half-time, 2nd = full-time (e.g. `ha` = 胜/负) |

**Trend** (`up`/`flat`/`down`) is derived from sporttery's per-odds change flag.

---

## Parlay (过关) rules

- 单注金额 = **2 元**; 单关 = `2 × 倍数 × 赔率`; M串N 每注 = `2 × 倍数 × Π(赔率)`.
- 注数 (`bets`) for an "M串N" = `Σ C(M, size)` over its boxed fold sizes.
- 单张彩票封顶 **5,000,000 元**; 混合过关 max 关数 = the smallest per-play limit
  (木桶原则; had/hhad = 8, crs/ttg/hafu = 6).

| 场数 M | 玩法 (label → 注数) |
|---|---|
| 2 | 2串1 |
| 3 | 3串1, 3串3, 3串4 |
| 4 | 4串1, 4串4, 4串5, 4串6, 4串11 |
| 5 | 5串1, 5串5, 5串6, 5串10, 5串16, 5串20, 5串26 |
| 6 | 6串1, 6串6, 6串7, 6串15, 6串20, 6串22, 6串35, 6串42, 6串50, 6串57 |
| 7 | 7串1, 7串7, 7串8, 7串21, 7串35, 7串120 |
| 8 | 8串1, 8串8, 8串9, 8串28, 8串56, 8串70, 8串247 |

---

## MCP server (local stdio)

Exposes the live-odds + derivation + parlay engine to an MCP host (Claude Desktop
/ Claude Code) as tools. Runs **locally**, so it fetches sporttery directly from
your own network (no geo-block, no proxy needed) and reuses the tested `src/*` modules.

**Tools:** `get_matches`, `get_match`, `derive_odds`, `compare_value`,
`calc_parlay`, `list_parlay_types`, `get_meta`.

```bash
npm run mcp:smoke    # spawn the server, list tools, call a few
```

**Claude Code** — a project-scoped `.mcp.json` is included; reopen the project
and approve `sporttery-odds`. Or register globally:
```bash
claude mcp add sporttery-odds -- \
  node --no-warnings --experimental-strip-types /abs/path/to/SportteryAPI/mcp/server.ts
```

**Claude Desktop** — add to `%APPDATA%\Claude\claude_desktop_config.json`:
```jsonc
{
  "mcpServers": {
    "sporttery-odds": {
      "command": "node",
      "args": ["--no-warnings", "--experimental-strip-types",
               "C:/abs/path/to/SportteryAPI/mcp/server.ts"]
    }
  }
}
```
Set `SPORTTERY_PROXY` in `.env` if the host needs a proxy to reach sporttery.

---

## Deployment

**One-click** — the [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/Johnserf-Seed/SportteryAPI)
button (top of this README) forks the repo, sets up Workers Builds (auto-deploy on
push = CD), and deploys. Compute endpoints work immediately; live odds need
`UPSTREAM_PROXY` (below), and auth turns on once you set `API_KEY`.

**CLI:**
```bash
npx wrangler login
echo "your-strong-key" | npx wrangler secret put API_KEY  # enable auth (recommended)
npm run deploy
```

For live odds from the global edge, set an upstream-reachable relay:
```bash
# in wrangler.jsonc → vars:  "UPSTREAM_PROXY": "https://my-relay.example/"
npm run deploy
```
Without `UPSTREAM_PROXY`, the deployed Worker is geo-blocked (`/api/matches` → 502);
compute endpoints still work. `wrangler.jsonc` is committed (no secrets); secrets
live in `.dev.vars` (local) / `wrangler secret put`.

---

## Configuration

**Worker** — `vars` in `wrangler.jsonc` (+ `.dev.vars` / `wrangler secret put` for secrets):

| Var | Default | Meaning |
|---|---|---|
| `DEFAULT_POOLS` | `hhad,had,crs,ttg,hafu` | default pools `/api/matches` returns (the Worker always fetches all pools) |
| `CACHE_TTL_SECONDS` | `30` | per-colo Cache API TTL |
| `UPSTREAM_PROXY` | _(unset)_ | forwarding-proxy URL prefix to bypass the geo-block via an upstream-reachable relay |
| `API_KEY` | _(secret)_ | comma-separated API key(s); unset = auth disabled |

**Node side** (MCP / smoke) — env vars, loadable from `.env`:

| Var | Default | Meaning |
|---|---|---|
| `SPORTTERY_PROXY` | _(unset)_ | HTTP proxy for the MCP server's sporttery fetch (also honors `HTTPS_PROXY`) |
| `API_KEY` | _(unset)_ | key the REST smoke test presents |
| `BASE` | `http://localhost:8787` | smoke-test target |

**Proxies** — `SPORTTERY_PROXY` is a normal HTTP proxy (clash/v2ray) for the
node-side fetch (via undici). `UPSTREAM_PROXY` is a **URL prefix** for the Worker
(Workers can't use CONNECT proxies) pointing at a transparent, upstream-reachable relay.

---

## Caching

`/api/matches` reports which tier served it in `data.source`:

1. **Cache API** (`edge-cache`) — per-colo, `CACHE_TTL_SECONDS` (default 30s).
   De-dupes bursts so the upstream is hit at most once per window.
2. **upstream** (`upstream`) — fetched on a Cache miss (optionally via `UPSTREAM_PROXY`).

---

## Future: real-time WebSocket stream

`src/stream.ts` implements `OddsStream`, a hibernatable Durable Object that fans
out odds-diffs to WebSocket clients. To enable: uncomment the `durable_objects`,
`migrations`, and `triggers.crons` blocks in `wrangler.jsonc` (DO uses
`new_sqlite_classes`), then deploy. Clients connect to
`wss://<worker>/stream?pools=had,hhad&key=<API_KEY>`.

---

## Development & testing

```bash
npm test           # 25 unit tests (node:test, no network)
npm run typecheck  # tsc --noEmit over src/
npm run dev        # local Worker
npm run mcp:smoke  # MCP server smoke test
BASE=http://localhost:8787 API_KEY=$KEY node --experimental-strip-types scripts/smoke.ts
npm run refresh-sample   # refresh sample.json from live upstream
```

No build step: TypeScript runs via `node --experimental-strip-types`, and the
Worker is bundled by Wrangler/esbuild. Pure modules use `.ts` import extensions so
the same source works under `tsc`, esbuild, and Node type-stripping.

**CI:** `.github/workflows/ci.yml` runs `typecheck` + `test` on every push and PR
(Node 22). **CD:** `.github/workflows/deploy.yml` deploys to Cloudflare Workers
after CI passes on `main` (needs the `CLOUDFLARE_API_TOKEN` repo secret). The
Deploy-to-Cloudflare button (Workers Builds) is an alternative.

---

## Data source

This project is an **unofficial** reader. It does not host, generate, or own any lottery data.

- **Upstream endpoint:** `https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry`
- This is the **undocumented public web API** that powers the official 竞彩 (Jingcai) odds calculator page at `https://m.sporttery.cn/mjc/jsq/zqspf/`.
- All match schedules, odds, results, and related data — and all associated intellectual property — belong to **中国体育彩票 / China Sports Lottery (sporttery.cn)**. Data is published by the 国家体育总局体育彩票管理中心 (State Sports Lottery Administration Center); the operator is 中体彩彩票运营管理有限公司. Site filing: 京ICP备09045816号.
- This project **only reads the upstream JSON and transforms it** into derived metrics. It claims no ownership over the underlying data, adds no official endorsement, and provides no guarantee of accuracy. Any right to redistribute the underlying data rests with the rights holder, not with this project or its users.

---

## Crawling & robots policy

We checked sporttery's `robots.txt` directly (raw headers and body) on the relevant hosts.

- **`https://www.sporttery.cn/robots.txt`** — exists (HTTP 200). One group, `User-agent: *`, with five extension-based `Disallow` rules: `/*.pdf$`, `/*.js$`, `/*.json$`, `/*.php$`, `/*.mp4$`. There is **no** `Allow`, **no** `Crawl-delay`, and **no** `Sitemap` line.
- **`https://m.sporttery.cn/robots.txt`** — not found (HTTP 404). No directives.
- **`https://webapi.sporttery.cn/robots.txt`** (the API host) — no `robots.txt` is served; requests return only a Tencent Cloud EdgeOne WAF block page (HTTP 403 / 567).

**What this means here:**

- This project calls a **single JSON API endpoint** (`/gateway/jc/football/getMatchCalculatorV1.qry`). It does **not** spider HTML pages or crawl the site.
- `robots.txt` is **per-host**. The only published file lives on `www.sporttery.cn`, a **different** host from the API host `webapi.sporttery.cn`, so it does not govern the API. Even so, that file's `Disallow` rules are anchored file-extension patterns (`.pdf/.js/.json/.php/.mp4`), which a path like `/gateway/jc/football/...` would not match.
- **Absence of a `Disallow` is not permission.** The API host is protected by a WAF that actively challenges and blocks automated requests — a stronger access-control signal than `robots.txt`.

**Responsible-use measures this project takes:**

- Short cache TTLs so repeated reads are served from cache instead of re-hitting upstream.
- Low request frequency; no bulk or parallel harvesting.
- A **single proxy/relay** in front of the endpoint rather than a fleet of crawlers.
- Honoring any rate limits and backing off on errors.
- **Stopping on 4xx/5xx or WAF block responses** instead of retrying aggressively.

If you determine that any sporttery `robots.txt` rule (or the site's terms) disallows the path you intend to access, **respect it** and obtain authorization from 中国体育彩票 before proceeding. When in doubt, do not scrape.

---

## Disclaimer

- This project is **not affiliated with, authorized by, or endorsed by 中国体育彩票 / China Sports Lottery (sporttery.cn)** or any of its operators. All trademarks and data belong to their respective owners.
- It is provided for **informational and technical purposes only**. It is **not betting advice**, not a prediction service, and not a guarantee of any outcome.
- The data is supplied **"as is", with no warranty** of accuracy, completeness, timeliness, or availability. The upstream may change, be interrupted, or return errors at any time. Official schedules, odds, results, and prize redemption are determined solely by 中国体育彩票's official channels.
- **Gambling involves financial risk.** Any lottery or betting activity is for **adults (18+) only**, and only where it is legal in your jurisdiction. Please play rationally (理性购彩).
- **You are responsible** for complying with sporttery's terms (including its 法律声明, which restricts copying/derivative use and prohibits access by 非正当手段 / improper means) and with all applicable local laws. Use of this project is at your own risk.
- This is **not legal advice**. If you are a rights holder and want this project (or its access to your endpoint) changed or removed, contact the maintainers and it will be **removed on request**.
