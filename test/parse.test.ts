import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseUpstream } from "../src/parse.ts";

const payload = JSON.parse(
  readFileSync(new URL("../sample.json", import.meta.url), "utf8"),
);

test("parseUpstream returns normalized matches with derived markets", () => {
  const res = parseUpstream(payload);
  assert.ok(res.matchCount > 0, "expected at least one match");
  const m = res.matches[0];
  assert.ok(m.matchId > 0);
  assert.ok(m.home.abbName.length > 0);
  assert.ok(Object.keys(m.markets).length > 0);
});

test("had market has home/draw/away order and sensible return rate", () => {
  const res = parseUpstream(payload, { pools: ["had"] });
  const withHad = res.matches.find((m) => m.markets.had);
  assert.ok(withHad, "expected a match with a had market");
  const had = withHad!.markets.had!;
  assert.deepEqual(
    had.outcomes.map((o) => o.key),
    ["home", "draw", "away"],
  );
  // theoretical return-to-player is below 1 and realistic (> 0.8)
  assert.ok(had.returnRate! > 0.8 && had.returnRate! < 1, `returnRate=${had.returnRate}`);
  // no-vig probabilities normalize to ~1
  const sum = had.outcomes.reduce((s, o) => s + (o.noVigProb ?? 0), 0);
  assert.ok(Math.abs(sum - 1) < 1e-3, `noVig sum=${sum}`);
  // every outcome carries derived metrics
  for (const o of had.outcomes) {
    assert.ok(o.impliedProb! > 0 && o.fairOdds! > 1);
  }
});

test("pool filtering and date filtering work", () => {
  const onlyTtg = parseUpstream(payload, { pools: ["ttg"] });
  for (const m of onlyTtg.matches) {
    assert.deepEqual(Object.keys(m.markets), ["ttg"]);
  }
  const firstDate = payload.value.matchInfoList[0].matchNumDate;
  const filtered = parseUpstream(payload, { date: String(firstDate) });
  assert.ok(filtered.matchCount > 0);
});

test("matchId filter is exact and handles 0 (no falsy-skip)", () => {
  const all = parseUpstream(payload);
  const id = all.matches[0].matchId;
  const one = parseUpstream(payload, { matchId: id });
  assert.equal(one.matchCount, 1);
  assert.equal(one.matches[0].matchId, id);
  // matchId 0 doesn't exist → empty, NOT the whole list
  assert.equal(parseUpstream(payload, { matchId: 0 }).matchCount, 0);
});

test("hhad market exposes the handicap goalLine", () => {
  const res = parseUpstream(payload, { pools: ["hhad"] });
  const withHhad = res.matches.find((m) => m.markets.hhad);
  if (withHhad) {
    assert.equal(typeof withHhad.markets.hhad!.goalLine, "number");
  }
});
