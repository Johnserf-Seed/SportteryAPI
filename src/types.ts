// Shared domain types for the Sporttery odds API.
// Pure type declarations only — erased at runtime, safe to import anywhere.

/** China Sports Lottery 竞彩足球 betting pools we expose. */
export type PoolCode = "had" | "hhad" | "crs" | "ttg" | "hafu";

/** Odds short-term movement vs. the opening line, derived from upstream flags. */
export type Trend = "up" | "flat" | "down" | "unknown";

/** A single selectable outcome within a market, with its odds + derived metrics. */
export interface Outcome {
  /** Raw upstream code, e.g. "h", "a", "s01s00", "hh", "s3". */
  code: string;
  /** Short English-ish key, e.g. "home", "draw", "1:0", "HH". */
  key: string;
  /** Human label (Chinese), e.g. "主胜", "1:0", "胜/胜". */
  labelZh: string;
  /** Decimal odds (赔率). */
  odds: number;
  /** Movement vs. open. */
  trend: Trend;
  /** 1 / odds — raw implied probability (includes bookmaker margin). */
  impliedProb?: number;
  /** Margin-removed (no-vig) probability, proportional normalization. */
  noVigProb?: number;
  /** Fair odds = 1 / noVigProb. */
  fairOdds?: number;
}

/** One betting market (one pool) for a match. */
export interface Market {
  pool: PoolCode;
  /** Chinese pool name, e.g. "胜平负". */
  poolNameZh: string;
  /** Handicap value for hhad (applied to the home team), e.g. -1. */
  goalLine?: number;
  /** When upstream last updated this market (HH:MM:SS, Beijing time). */
  updateTime?: string;
  outcomes: Outcome[];
  /** Σ(1/odds) — total implied probability / 总概率. */
  overround?: number;
  /** 返还率 = 1 / overround (theoretical return-to-player). */
  returnRate?: number;
  /** Bookmaker margin as a fraction of stakes held = 1 - returnRate. */
  margin?: number;
}

export interface TeamRef {
  code: string;
  abbName: string;
  allName: string;
  rank?: string;
}

export interface LeagueRef {
  id: number;
  code: string;
  abbName: string;
  allName: string;
}

/** A normalized match with all requested markets. */
export interface Match {
  matchId: number;
  matchNum: number;
  /** Display id like "周五029". */
  matchNumStr: string;
  /** Date code like "260619". */
  matchNumDate: string;
  businessDate: string;
  matchDate: string;
  matchTime: string;
  weekday: string;
  league: LeagueRef;
  home: TeamRef;
  away: TeamRef;
  status: string;
  /** 单关 (single-match bet) allowed. */
  bettingSingle: boolean;
  /** 串关 (parlay) allowed. */
  bettingAllUp: boolean;
  markets: Partial<Record<PoolCode, Market>>;
}

export interface MatchListResult {
  updatedAt: string;
  matchCount: number;
  pools: PoolCode[];
  /** Which cache tier served the upstream payload: edge-cache | upstream | kv-snapshot-stale. */
  source?: string;
  matches: Match[];
}
