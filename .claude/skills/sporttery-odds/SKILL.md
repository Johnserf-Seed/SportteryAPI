---
name: sporttery-odds
description: Fetch and analyze China Sports Lottery 竞彩足球 (Jingcai football) odds. Use when the user wants the latest 竞彩 odds, to derive implied / no-vig probabilities or 返还率 (return rate), to assess value / 凯利指数 (Kelly) against a reference set, or to compute 单关 / 过关 (parlay) payouts. Backed by the Sporttery Odds service in this repo (MCP tools + REST + pure modules).
---

# Sporttery Odds

This skill drives the Sporttery Odds service in this repository (a Cloudflare
Worker REST API + a local MCP server) to fetch and analyze 竞彩足球 odds. All
derivation is **purely from the odds** — no predictions.

## Pick an interface (in order of preference)

1. **MCP tools** — if the `sporttery-odds` MCP server is connected, use its tools
   directly: `get_matches`, `get_match`, `derive_odds`, `compare_value`,
   `calc_parlay`, `list_parlay_types`, `get_meta`. This is the primary path.
2. **REST** — if a Worker is running/deployed: `GET /api/matches`,
   `GET /api/match/:id`, `POST /api/derive`, `POST /api/value`, `POST /api/parlay`,
   `GET /api/parlay/types`, `GET /api/meta`. Add the API key if one is configured
   (`Authorization: Bearer <key>`).
3. **Local, no server** — run the pure engine via Node, e.g.
   `npm run mcp:smoke` to sanity-check, or import `src/derive.ts` / `src/parlay.ts`
   in a one-off `node --experimental-strip-types` script.

> Live odds need the service to reach the geo-restricted upstream; the local MCP
> server reaches it directly, the deployed Worker needs `UPSTREAM_PROXY`. Compute
> tools (derive / value / parlay) work with any odds the user provides — no upstream.

## Metric cheat-sheet (what the numbers mean)

- **impliedProb** = `1/odds` — includes the bookmaker margin.
- **返还率 returnRate** = `1/Σ(1/odds)` — theoretical return-to-player. Lower ⇒ bigger
  margin. 竞彩 SPF is typically ~0.75–0.90.
- **去水概率 noVigProb** = `(1/odds)/Σ` — margin-removed "true" probability (sums to 1).
- **真实赔率 fairOdds** = `1/noVigProb`.
- **凯利指数 kelly** = `offeredOdds × referenceProb`. `>1` ⇒ positive expected value.
  Needs an EXTERNAL reference (a single odds set degenerates to returnRate).
- **trend** `up/flat/down` — sporttery's own odds movement flag.

## Common workflows

1. **"Latest odds for team / league / today"** → `get_matches` with `pools`,
   `league`, or `date` filters. Report each outcome's odds, 去水概率, and the
   market's 返还率. Don't dump all five pools unless asked — `had,hhad` is usually enough.
2. **"Is this a value bet?"** → get a reference odds set (the user's 欧赔, or a
   bookmaker consensus) and call `compare_value` with `{offered, reference}`.
   Flag outcomes where `kelly > 1`; mention the EV and (optionally) Kelly stake fraction.
3. **"How much would this parlay pay?"** → `calc_parlay` with `legs:[{odds}]`,
   a `passType` (`单关`, `3串1`, …) and `multiplier` (倍数). Report 注数, 总投注,
   最高奖金 (note the 500万 cap). Use per-leg `result: win|lose|void` for a
   settled-ticket calculation.
4. **"What 过关 types exist for N matches?"** → `list_parlay_types?matches=N`.
5. **Interpreting a market** → high margin / low 返还率 means the book holds more;
   compare 去水概率 across outcomes for the market's implied view.

## Guardrails

- This is **informational only — not betting advice**; surface that when giving
  analysis. The data is unofficial (see the repo README's Disclaimer / Data source).
- If a live fetch fails with 567/502, it's the geo-block — say so and suggest
  `UPSTREAM_PROXY` (Worker) or running the MCP server locally, rather than retrying.
- On Windows, send Chinese JSON bodies via a file, not inline `-d`.
