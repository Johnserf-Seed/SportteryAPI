import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeOutcome,
  isOutcomeKey,
  orderedOutcomeCodes,
  toTrend,
} from "../src/labels.ts";

test("decodeOutcome maps had/hhad codes", () => {
  assert.deepEqual(decodeOutcome("had", "h"), { key: "home", labelZh: "主胜" });
  assert.deepEqual(decodeOutcome("had", "d"), { key: "draw", labelZh: "平" });
  assert.deepEqual(decodeOutcome("hhad", "a"), { key: "away", labelZh: "主负" });
});

test("decodeOutcome decodes correct-score codes", () => {
  assert.deepEqual(decodeOutcome("crs", "s01s00"), { key: "1:0", labelZh: "1:0" });
  assert.deepEqual(decodeOutcome("crs", "s05s02"), { key: "5:2", labelZh: "5:2" });
  assert.deepEqual(decodeOutcome("crs", "s1sh"), { key: "win-other", labelZh: "胜其它" });
  assert.deepEqual(decodeOutcome("crs", "s1sd"), { key: "draw-other", labelZh: "平其它" });
  assert.deepEqual(decodeOutcome("crs", "s1sa"), { key: "loss-other", labelZh: "负其它" });
});

test("decodeOutcome decodes total-goals codes (s7 = 7+)", () => {
  assert.deepEqual(decodeOutcome("ttg", "s0"), { key: "0", labelZh: "0球" });
  assert.deepEqual(decodeOutcome("ttg", "s6"), { key: "6", labelZh: "6球" });
  assert.deepEqual(decodeOutcome("ttg", "s7"), { key: "7+", labelZh: "7球+" });
});

test("decodeOutcome decodes half/full codes", () => {
  assert.deepEqual(decodeOutcome("hafu", "hh"), { key: "HH", labelZh: "胜/胜" });
  assert.deepEqual(decodeOutcome("hafu", "ha"), { key: "HA", labelZh: "胜/负" });
  assert.deepEqual(decodeOutcome("hafu", "da"), { key: "DA", labelZh: "平/负" });
});

test("toTrend maps upstream flags", () => {
  assert.equal(toTrend("1"), "up");
  assert.equal(toTrend("0"), "flat");
  assert.equal(toTrend("-1"), "down");
  assert.equal(toTrend(""), "unknown");
});

test("isOutcomeKey filters flags and metadata", () => {
  assert.equal(isOutcomeKey("h"), true);
  assert.equal(isOutcomeKey("s01s00"), true);
  assert.equal(isOutcomeKey("hf"), false);
  assert.equal(isOutcomeKey("s01s00f"), false);
  assert.equal(isOutcomeKey("goalLine"), false);
  assert.equal(isOutcomeKey("updateTime"), false);
});

test("orderedOutcomeCodes returns had in home/draw/away order", () => {
  const raw = { a: "5.60", af: "0", d: "3.90", df: "1", h: "1.44", hf: "-1", updateTime: "x" };
  assert.deepEqual(orderedOutcomeCodes("had", raw), ["h", "d", "a"]);
});
