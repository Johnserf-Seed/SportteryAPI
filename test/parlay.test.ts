import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PARLAY_TABLE,
  TICKET_CAP,
  calcParlay,
  choose,
  combinations,
  listParlayTypes,
} from "../src/parlay.ts";

test("every M串N variant's bets equals the sum of its boxed combinations", () => {
  for (const [mStr, variants] of Object.entries(PARLAY_TABLE)) {
    const m = Number(mStr);
    for (const v of variants) {
      const expected = v.comboSizes.reduce((s, k) => s + choose(m, k), 0);
      assert.equal(v.bets, expected, `${v.label}: bets ${v.bets} != Σ C(${m},k) ${expected}`);
    }
  }
});

test("combinations returns the right count and shape", () => {
  assert.equal(combinations(4, 2).length, 6);
  assert.deepEqual(combinations(3, 2), [
    [0, 1],
    [0, 2],
    [1, 2],
  ]);
});

test("单关 pays 2 × multiplier × odds", () => {
  const r = calcParlay({ legs: [{ odds: 2.5 }], passType: "单关", multiplier: 3 });
  assert.equal(r.passType, "单关");
  assert.equal(r.bets, 1);
  assert.equal(r.totalStake, 6); // 2 × 3
  assert.equal(r.maxPayout, 15); // 2 × 3 × 2.5
});

test("2串1 multiplies both legs", () => {
  const r = calcParlay({ legs: [{ odds: 2.0 }, { odds: 3.0 }], passType: "2串1" });
  assert.equal(r.bets, 1);
  assert.equal(r.totalStake, 2);
  assert.equal(r.maxPayout, 12); // 2 × (2×3)
});

test("4串6 boxes all 2-folds", () => {
  const r = calcParlay({
    legs: [{ odds: 1.5 }, { odds: 1.5 }, { odds: 1.5 }, { odds: 1.5 }],
    passType: "4串6",
  });
  assert.equal(r.bets, 6);
  assert.equal(r.totalStake, 12);
  assert.equal(r.maxPayout, 27); // 6 combos × (2 × 2.25)
});

test("realized payout drops losing combos and treats void as 1.00", () => {
  const lose = calcParlay({
    legs: [{ odds: 2 }, { odds: 2 }, { odds: 2, result: "lose" }],
    passType: "3串1",
  });
  assert.equal(lose.maxPayout, 16); // 2 × 8 if all win
  assert.equal(lose.realizedPayout, 0); // one leg lost in a 3-fold

  const voided = calcParlay({
    legs: [{ odds: 2 }, { odds: 3, result: "void" }],
    passType: "2串1",
  });
  assert.equal(voided.realizedPayout, 4); // void settles at 1.00 ⇒ 2 × (2 × 1.00)
});

test("ticket payout is capped at 5,000,000", () => {
  const legs = Array.from({ length: 8 }, () => ({ odds: 10 }));
  const r = calcParlay({ legs, passType: "8串1" });
  assert.ok(r.maxPayout > TICKET_CAP);
  assert.equal(r.maxPayoutCapped, TICKET_CAP);
  assert.equal(r.capped, true);
});

test("explicit folds compute the N串N label and bets", () => {
  const r = calcParlay({
    legs: [{ odds: 2 }, { odds: 2 }, { odds: 2 }, { odds: 2 }],
    folds: [2, 3, 4],
  });
  assert.equal(r.bets, 11);
  assert.equal(r.passType, "4串11");
});

test("rejects a single selection played as a multi-fold parlay", () => {
  assert.throws(() => calcParlay({ legs: [{ odds: 2 }], passType: "2串1" }));
});

test("rejects non-integer fold sizes", () => {
  assert.throws(() =>
    calcParlay({ legs: [{ odds: 2 }, { odds: 2 }, { odds: 2 }], folds: [2.5] }),
  );
});

test("listParlayTypes(N) filters; 0 or out-of-range returns empty, no-arg returns the table", () => {
  const m2 = listParlayTypes(2) as { label: string }[];
  assert.equal(m2.length, 1);
  assert.equal(m2[0].label, "2串1");
  assert.deepEqual(listParlayTypes(0), []);
  assert.deepEqual(listParlayTypes(9), []);
  assert.equal(Array.isArray(listParlayTypes()), false); // whole table is an object
});
