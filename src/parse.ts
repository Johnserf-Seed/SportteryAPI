// Transform the raw Sporttery upstream payload into normalized, derived matches.

import type { Match, Market, MatchListResult, Outcome, PoolCode } from "./types.ts";
import { deriveMarket, round, toOdds } from "./derive.ts";
import {
  POOL_NAME_ZH,
  decodeOutcome,
  orderedOutcomeCodes,
  toTrend,
} from "./labels.ts";

const ALL_POOLS: PoolCode[] = ["had", "hhad", "crs", "ttg", "hafu"];

export interface ParseOptions {
  /** Which pools to include (default: all present). */
  pools?: PoolCode[];
  /** Filter by matchNumDate (e.g. "260619"). */
  date?: string;
  /** Filter by league code or abbreviated name (substring, case-insensitive). */
  league?: string;
  /** Filter to a single upstream matchId. */
  matchId?: number;
}

/** Build one normalized + derived Market from a raw pool object. */
export function buildMarket(pool: PoolCode, raw: Record<string, unknown>): Market | null {
  const codes = orderedOutcomeCodes(pool, raw);
  const outcomes: Outcome[] = [];
  for (const code of codes) {
    const odds = toOdds(raw[code]);
    if (odds === null) continue; // outcome not quoted
    const { key, labelZh } = decodeOutcome(pool, code);
    outcomes.push({
      code,
      key,
      labelZh,
      odds,
      trend: toTrend(raw[`${code}f`]),
    });
  }
  if (outcomes.length === 0) return null;

  const market: Market = {
    pool,
    poolNameZh: POOL_NAME_ZH[pool],
    updateTime: typeof raw.updateTime === "string" ? raw.updateTime : undefined,
    outcomes,
  };

  const goalLineValue = raw.goalLineValue;
  if (goalLineValue !== undefined && goalLineValue !== "" && goalLineValue !== null) {
    const n = Number(goalLineValue);
    if (Number.isFinite(n)) market.goalLine = n;
  }

  deriveMarketMetrics(market);
  return market;
}

/** Fill in overround / returnRate / margin and per-outcome derived probabilities. */
export function deriveMarketMetrics(market: Market): void {
  const d = deriveMarket(market.outcomes.map((o) => o.odds));
  market.overround = round(d.overround, 6);
  market.returnRate = round(d.returnRate, 6);
  market.margin = round(d.margin, 6);
  market.outcomes.forEach((o, i) => {
    const po = d.perOutcome[i];
    o.impliedProb = round(po.impliedProb, 6);
    o.noVigProb = round(po.noVigProb, 6);
    o.fairOdds = round(po.fairOdds, 4);
  });
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Parse the full upstream response into a normalized result. */
export function parseUpstream(payload: any, opts: ParseOptions = {}): MatchListResult {
  const wantedPools = (opts.pools && opts.pools.length ? opts.pools : ALL_POOLS).filter((p) =>
    ALL_POOLS.includes(p),
  );
  const groups: any[] = payload?.value?.matchInfoList ?? [];
  const leagueQuery = opts.league?.toLowerCase();
  const matches: Match[] = [];

  for (const group of groups) {
    if (opts.date && str(group.matchNumDate) !== opts.date) continue;
    for (const sm of group.subMatchList ?? []) {
      if (opts.matchId !== undefined && Number(sm.matchId) !== opts.matchId) continue;
      if (leagueQuery) {
        const hay = `${str(sm.leagueCode)} ${str(sm.leagueAbbName)} ${str(sm.leagueAllName)}`.toLowerCase();
        if (!hay.includes(leagueQuery)) continue;
      }

      const markets: Partial<Record<PoolCode, Market>> = {};
      for (const pool of wantedPools) {
        const raw = sm[pool];
        if (raw && typeof raw === "object") {
          const m = buildMarket(pool, raw as Record<string, unknown>);
          if (m) markets[pool] = m;
        }
      }
      if (Object.keys(markets).length === 0) continue;

      matches.push({
        matchId: Number(sm.matchId),
        matchNum: Number(sm.matchNum),
        matchNumStr: str(sm.matchNumStr),
        matchNumDate: str(sm.matchNumDate || group.matchNumDate),
        businessDate: str(sm.businessDate || group.businessDate),
        matchDate: str(sm.matchDate),
        matchTime: str(sm.matchTime),
        weekday: str(group.weekday),
        league: {
          id: Number(sm.leagueId) || 0,
          code: str(sm.leagueCode),
          abbName: str(sm.leagueAbbName),
          allName: str(sm.leagueAllName),
        },
        home: {
          code: str(sm.homeTeamCode),
          abbName: str(sm.homeTeamAbbName),
          allName: str(sm.homeTeamAllName),
          rank: str(sm.homeRank) || undefined,
        },
        away: {
          code: str(sm.awayTeamCode),
          abbName: str(sm.awayTeamAbbName),
          allName: str(sm.awayTeamAllName),
          rank: str(sm.awayRank) || undefined,
        },
        status: str(sm.matchStatus),
        bettingSingle: str(sm.bettingSingle) === "1" || sm.bettingSingle === 1,
        bettingAllUp: str(sm.bettingAllUp) === "1" || sm.bettingAllUp === 1,
        markets,
      });
    }
  }

  return {
    updatedAt: str(payload?.value?.lastUpdateTime) || new Date().toISOString(),
    matchCount: matches.length,
    pools: wantedPools,
    matches,
  };
}
