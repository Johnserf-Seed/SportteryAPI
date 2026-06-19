// Odds-derivation engine (赔率推导引擎).
//
// Pure, stateless math over decimal odds. No I/O, no Cloudflare APIs — fully
// unit-testable. Everything the service "derives" from raw odds lives here.
//
// Core identities for an N-outcome market with decimal odds o_i:
//   impliedProb_i = 1 / o_i                      (含水概率 / raw implied prob)
//   overround     = Σ (1 / o_i)                  (总概率, > 1 because of margin)
//   returnRate    = 1 / overround                (返还率 / theoretical RTP)
//   margin        = 1 - returnRate               (庄家抽水, share of stakes held)
//   noVigProb_i   = impliedProb_i / overround    (标准化/去水概率, sums to 1)
//   fairOdds_i    = 1 / noVigProb_i = o_i * overround
//
// Value/Kelly are only meaningful when comparing an *offered* odds set against
// a separate *reference* probability (otherwise they degenerate to returnRate).

export interface MarketDerivation {
  /** Σ(1/odds). */
  overround: number;
  /** 1 / overround. */
  returnRate: number;
  /** 1 - returnRate (fraction of stakes the book holds). */
  margin: number;
  perOutcome: OutcomeDerivation[];
}

export interface OutcomeDerivation {
  odds: number;
  impliedProb: number;
  noVigProb: number;
  fairOdds: number;
}

/** Parse a decimal-odds value that may arrive as "1.44", " ", null, etc. */
export function toOdds(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n <= 1) return null; // decimal odds must be > 1
  return n;
}

/**
 * Derive implied / no-vig probabilities, return rate and fair odds for one
 * market given its list of decimal odds. Non-positive / missing odds are
 * ignored for the overround so a partially-quoted market still yields sensible
 * per-outcome numbers.
 */
export function deriveMarket(oddsList: ReadonlyArray<number>): MarketDerivation {
  const valid = oddsList.filter((o) => Number.isFinite(o) && o > 1);
  const overround = valid.reduce((s, o) => s + 1 / o, 0);
  const returnRate = overround > 0 ? 1 / overround : 0;
  const perOutcome: OutcomeDerivation[] = oddsList.map((o) => {
    const ok = Number.isFinite(o) && o > 1;
    const impliedProb = ok ? 1 / o : 0;
    const noVigProb = ok && overround > 0 ? impliedProb / overround : 0;
    const fairOdds = noVigProb > 0 ? 1 / noVigProb : 0;
    return { odds: o, impliedProb, noVigProb, fairOdds };
  });
  return { overround, returnRate, margin: 1 - returnRate, perOutcome };
}

export interface ValueAnalysis {
  odds: number;
  /** Reference (true) probability the offered odds are judged against. */
  refProb: number;
  /** 凯利指数 = odds * refProb. >1 ⇒ positive expected value. */
  kelly: number;
  /** Expected value per 1 unit staked = kelly - 1. */
  ev: number;
  /** Optimal Kelly staking fraction of bankroll; clamped at 0 (never negative). */
  kellyFraction: number;
  /** Whether this is a value bet (kelly > 1). */
  isValue: boolean;
}

/**
 * 凯利指数 / value of a single offered outcome against a reference probability.
 *
 *   kelly         = offeredOdds * refProb
 *   ev            = kelly - 1
 *   kellyFraction = (b*p - q) / b   where b = offeredOdds-1, p = refProb, q = 1-p
 */
export function valueOf(offeredOdds: number, refProb: number): ValueAnalysis {
  const o = offeredOdds;
  const p = Math.min(Math.max(refProb, 0), 1);
  const kelly = o * p;
  const ev = kelly - 1;
  const b = o - 1;
  const q = 1 - p;
  const f = b > 0 ? (b * p - q) / b : 0;
  return {
    odds: o,
    refProb: p,
    kelly,
    ev,
    kellyFraction: Math.max(0, f),
    isValue: kelly > 1,
  };
}

/**
 * Compare an offered odds set against a reference odds set for the same market
 * (e.g. Sporttery 胜平负 vs. a European/Asian book). The reference set's no-vig
 * probabilities become the "true" probabilities; each offered outcome is scored.
 * The two lists must be aligned outcome-for-outcome and equal length.
 */
export function compareOdds(
  offered: ReadonlyArray<number>,
  reference: ReadonlyArray<number>,
): ValueAnalysis[] {
  if (offered.length !== reference.length) {
    throw new Error("offered and reference odds lists must be the same length");
  }
  const ref = deriveMarket(reference);
  return offered.map((o, i) => valueOf(o, ref.perOutcome[i]?.noVigProb ?? 0));
}

/** Round to n decimal places without floating-point string noise. */
export function round(x: number, n = 4): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** n;
  return Math.round(x * f) / f;
}
