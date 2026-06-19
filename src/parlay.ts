// 过关 (parlay) combination engine + prize calculator for 竞彩足球.
//
// Rules (verified against 竞彩网 official help):
//   - Base unit price 单注金额 = 2 元.
//   - 单关 (single): payout = 2 × 倍数 × 赔率, only on bettingSingle-eligible matches.
//   - M串N parlay: pick M matches, box all combinations of the given fold sizes;
//     注数 (bets) = Σ C(M, size). Each winning 注 pays 2 × 倍数 × Π(legs' odds).
//   - 单张彩票最高奖金 (per-ticket cap) = 5,000,000 元.

import { round } from "./derive.ts";

export const UNIT_PRICE = 2;
export const TICKET_CAP = 5_000_000;

export interface ParlayVariant {
  label: string;
  /** Number of combinations (注数). */
  bets: number;
  /** Which combination/fold sizes are boxed. */
  comboSizes: number[];
}

/** Full official M串N table for M = 2..8 (matches → variants). */
export const PARLAY_TABLE: Record<number, ParlayVariant[]> = {
  2: [{ label: "2串1", bets: 1, comboSizes: [2] }],
  3: [
    { label: "3串1", bets: 1, comboSizes: [3] },
    { label: "3串3", bets: 3, comboSizes: [2] },
    { label: "3串4", bets: 4, comboSizes: [2, 3] },
  ],
  4: [
    { label: "4串1", bets: 1, comboSizes: [4] },
    { label: "4串4", bets: 4, comboSizes: [3] },
    { label: "4串5", bets: 5, comboSizes: [3, 4] },
    { label: "4串6", bets: 6, comboSizes: [2] },
    { label: "4串11", bets: 11, comboSizes: [2, 3, 4] },
  ],
  5: [
    { label: "5串1", bets: 1, comboSizes: [5] },
    { label: "5串5", bets: 5, comboSizes: [4] },
    { label: "5串6", bets: 6, comboSizes: [4, 5] },
    { label: "5串10", bets: 10, comboSizes: [2] },
    { label: "5串16", bets: 16, comboSizes: [3, 4, 5] },
    { label: "5串20", bets: 20, comboSizes: [2, 3] },
    { label: "5串26", bets: 26, comboSizes: [2, 3, 4, 5] },
  ],
  6: [
    { label: "6串1", bets: 1, comboSizes: [6] },
    { label: "6串6", bets: 6, comboSizes: [5] },
    { label: "6串7", bets: 7, comboSizes: [5, 6] },
    { label: "6串15", bets: 15, comboSizes: [2] },
    { label: "6串20", bets: 20, comboSizes: [3] },
    { label: "6串22", bets: 22, comboSizes: [4, 5, 6] },
    { label: "6串35", bets: 35, comboSizes: [2, 3] },
    { label: "6串42", bets: 42, comboSizes: [3, 4, 5, 6] },
    { label: "6串50", bets: 50, comboSizes: [2, 3, 4] },
    { label: "6串57", bets: 57, comboSizes: [2, 3, 4, 5, 6] },
  ],
  7: [
    { label: "7串1", bets: 1, comboSizes: [7] },
    { label: "7串7", bets: 7, comboSizes: [6] },
    { label: "7串8", bets: 8, comboSizes: [6, 7] },
    { label: "7串21", bets: 21, comboSizes: [5] },
    { label: "7串35", bets: 35, comboSizes: [4] },
    { label: "7串120", bets: 120, comboSizes: [2, 3, 4, 5, 6, 7] },
  ],
  8: [
    { label: "8串1", bets: 1, comboSizes: [8] },
    { label: "8串8", bets: 8, comboSizes: [7] },
    { label: "8串9", bets: 9, comboSizes: [7, 8] },
    { label: "8串28", bets: 28, comboSizes: [6] },
    { label: "8串56", bets: 56, comboSizes: [5] },
    { label: "8串70", bets: 70, comboSizes: [4] },
    { label: "8串247", bets: 247, comboSizes: [2, 3, 4, 5, 6, 7, 8] },
  ],
};

export type LegResult = "win" | "lose" | "void";

export interface ParlayLeg {
  /** Decimal odds for this selection. */
  odds: number;
  /** Optional label, e.g. "周五029 主胜". */
  label?: string;
  /** Settlement state (default "win"). void ⇒ leg settles at odds 1.00. */
  result?: LegResult;
}

export interface ParlayInput {
  legs: ParlayLeg[];
  /** "单关", an "M串N" label, or explicit fold sizes. Default: full N串1. */
  passType?: string;
  folds?: number[];
  /** 倍数 (multiplier), default 1. */
  multiplier?: number;
}

export interface ParlayResult {
  matches: number;
  passType: string;
  folds: number[];
  bets: number;
  unitPrice: number;
  multiplier: number;
  totalStake: number;
  /** Payout if every leg wins, before the ticket cap. */
  maxPayout: number;
  /** maxPayout after applying the 5,000,000 ticket cap. */
  maxPayoutCapped: number;
  /** Payout given the per-leg results supplied (void ⇒ 1.00), after cap. */
  realizedPayout: number;
  capped: boolean;
  /** Per fold-size breakdown of bets + payout-if-all-win. */
  byFold: { size: number; bets: number; payout: number }[];
}

/** n choose k. */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/** All index combinations of size k from [0..n). */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const idx: number[] = [];
  const rec = (start: number) => {
    if (idx.length === k) {
      out.push(idx.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      idx.push(i);
      rec(i + 1);
      idx.pop();
    }
  };
  rec(0);
  return out;
}

/** Resolve a passType / folds spec into the concrete fold sizes to box. */
export function resolveFolds(input: ParlayInput): { folds: number[]; passType: string } {
  const m = input.legs.length;
  if (input.passType === "单关" || (m === 1 && !input.folds && !input.passType)) {
    return { folds: [1], passType: "单关" };
  }
  if (input.folds && input.folds.length) {
    const folds = [...new Set(input.folds)].sort((a, b) => a - b);
    return { folds, passType: input.passType ?? `${m}串${folds.reduce((s, k) => s + choose(m, k), 0)}` };
  }
  if (input.passType) {
    const mm = /^(\d+)串(\d+)$/.exec(input.passType);
    if (!mm) throw new Error(`Invalid passType "${input.passType}"`);
    const labelM = Number(mm[1]);
    if (labelM !== m) {
      throw new Error(`passType "${input.passType}" needs ${labelM} selections but got ${m}`);
    }
    const variant = (PARLAY_TABLE[m] ?? []).find((v) => v.label === input.passType);
    if (variant) return { folds: variant.comboSizes, passType: variant.label };
    // Accept an "M串1" all-in even for M outside the canned table.
    if (Number(mm[2]) === 1) return { folds: [m], passType: input.passType };
    throw new Error(`Unknown passType "${input.passType}" for ${m} matches`);
  }
  // Default: all-in N串1.
  return { folds: [m], passType: `${m}串1` };
}

/** Compute注数 / stake / payout for a parlay. */
export function calcParlay(input: ParlayInput): ParlayResult {
  const legs = input.legs ?? [];
  const m = legs.length;
  if (m === 0) throw new Error("At least one leg is required");
  const multiplier = input.multiplier ?? 1;
  if (!Number.isInteger(multiplier) || multiplier < 1) {
    throw new Error("multiplier (倍数) must be a positive integer");
  }
  for (const leg of legs) {
    if (!Number.isFinite(leg.odds) || leg.odds <= 1) {
      throw new Error(`Each leg needs decimal odds > 1 (got ${leg.odds})`);
    }
  }

  const { folds, passType } = resolveFolds(input);
  for (const k of folds) {
    if (!Number.isInteger(k) || k < 1 || k > m) {
      throw new Error(`Fold size ${k} must be an integer in 1..${m}`);
    }
  }
  if (m === 1 && folds.some((k) => k !== 1)) {
    throw new Error("A single selection can only be played as 单关");
  }

  const stakeUnit = UNIT_PRICE * multiplier;
  const effOdds = legs.map((l) => (l.result === "void" ? 1 : l.odds));
  const won = legs.map((l) => l.result !== "lose"); // win or void counts as not-lost

  let bets = 0;
  let maxPayout = 0;
  let realizedPayout = 0;
  const byFold: { size: number; bets: number; payout: number }[] = [];

  for (const k of folds) {
    const combos = combinations(m, k);
    let foldPayout = 0;
    for (const combo of combos) {
      const allMax = combo.reduce((p, i) => p * legs[i].odds, 1);
      foldPayout += Math.max(stakeUnit * allMax, UNIT_PRICE);
      const comboWon = combo.every((i) => won[i]);
      if (comboWon) {
        const real = combo.reduce((p, i) => p * effOdds[i], 1);
        realizedPayout += Math.max(stakeUnit * real, UNIT_PRICE);
      }
    }
    bets += combos.length;
    maxPayout += foldPayout;
    byFold.push({ size: k, bets: combos.length, payout: round(foldPayout, 2) });
  }

  const cap = (x: number) => Math.min(x, TICKET_CAP);
  return {
    matches: m,
    passType,
    folds,
    bets,
    unitPrice: UNIT_PRICE,
    multiplier,
    totalStake: round(bets * stakeUnit, 2),
    maxPayout: round(maxPayout, 2),
    maxPayoutCapped: round(cap(maxPayout), 2),
    realizedPayout: round(cap(realizedPayout), 2),
    capped: maxPayout > TICKET_CAP,
    byFold,
  };
}

/** List the parlay variants for a given M (or the whole table). */
export function listParlayTypes(matches?: number): Record<number, ParlayVariant[]> | ParlayVariant[] {
  if (matches !== undefined) return PARLAY_TABLE[matches] ?? [];
  return PARLAY_TABLE;
}
