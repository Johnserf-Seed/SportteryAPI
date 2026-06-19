import { test } from "node:test";
import assert from "node:assert/strict";
import { compareOdds, deriveMarket, toOdds, valueOf } from "../src/derive.ts";

const near = (a: number, b: number, eps = 1e-4) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

test("toOdds parses strings and rejects invalid odds", () => {
  assert.equal(toOdds("1.44"), 1.44);
  assert.equal(toOdds(" 2.5 "), 2.5);
  assert.equal(toOdds(""), null);
  assert.equal(toOdds("1.00"), null); // odds must be > 1
  assert.equal(toOdds("abc"), null);
  assert.equal(toOdds(null), null);
});

test("deriveMarket computes overround, return rate and no-vig probs", () => {
  const d = deriveMarket([2.1, 3.4, 3.8]);
  near(d.overround, 1 / 2.1 + 1 / 3.4 + 1 / 3.8);
  near(d.returnRate, 1 / d.overround);
  near(d.margin, 1 - d.returnRate);
  // no-vig probabilities normalize to 1
  const sum = d.perOutcome.reduce((s, o) => s + o.noVigProb, 0);
  near(sum, 1);
  // fair odds = odds * overround
  near(d.perOutcome[0].fairOdds, 2.1 * d.overround);
});

test("deriveMarket ignores invalid odds in the overround", () => {
  const d = deriveMarket([2.0, NaN, 2.0]);
  near(d.overround, 1); // only the two valid 2.0 outcomes
  near(d.returnRate, 1);
});

test("valueOf computes Kelly index, EV and stake fraction", () => {
  const v = valueOf(2.5, 0.5);
  near(v.kelly, 1.25);
  near(v.ev, 0.25);
  // f* = (b*p - q)/b, b=1.5, p=0.5, q=0.5 => (0.75-0.5)/1.5
  near(v.kellyFraction, (1.5 * 0.5 - 0.5) / 1.5);
  assert.equal(v.isValue, true);

  const noEdge = valueOf(2.0, 0.5);
  near(noEdge.kelly, 1);
  assert.equal(noEdge.isValue, false);
  assert.equal(noEdge.kellyFraction, 0); // never negative
});

test("compareOdds flags value vs a reference market", () => {
  const res = compareOdds([2.1, 3.4, 3.8], [2.0, 3.5, 4.0]);
  assert.equal(res.length, 3);
  // home offered 2.1 vs ref no-vig prob ~0.4828 => kelly ~1.014 (value)
  assert.ok(res[0].kelly > 1);
  assert.equal(res[0].isValue, true);
  assert.throws(() => compareOdds([2.0], [2.0, 3.0]));
});
