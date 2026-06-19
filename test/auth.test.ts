import { test } from "node:test";
import assert from "node:assert/strict";
import { authEnabled, isAuthorized } from "../src/auth.ts";

const mk = (headers: Record<string, string> = {}, urlStr = "https://x/api/matches") => ({
  req: new Request(urlStr, { headers }),
  url: new URL(urlStr),
});

test("auth disabled when API_KEY unset or empty → all allowed", () => {
  const { req, url } = mk();
  assert.equal(authEnabled({}), false);
  assert.equal(isAuthorized(req, url, {}), true);
  assert.equal(isAuthorized(req, url, { API_KEY: "" }), true);
});

test("fails closed when API_KEY is set but unusable (whitespace/commas)", () => {
  const { req, url } = mk();
  for (const k of [" ", ",", ", ,"]) {
    assert.equal(authEnabled({ API_KEY: k }), true, `enabled for ${JSON.stringify(k)}`);
    assert.equal(isAuthorized(req, url, { API_KEY: k }), false, `denied for ${JSON.stringify(k)}`);
  }
});

test("accepts Bearer and X-API-Key, rejects wrong/missing", () => {
  const env = { API_KEY: "k1,k2" };
  let c = mk({ Authorization: "Bearer k2" });
  assert.equal(isAuthorized(c.req, c.url, env), true);
  c = mk({ "X-API-Key": "k1" });
  assert.equal(isAuthorized(c.req, c.url, env), true);
  c = mk({ Authorization: "Bearer nope" });
  assert.equal(isAuthorized(c.req, c.url, env), false);
  c = mk();
  assert.equal(isAuthorized(c.req, c.url, env), false);
});

test("?key= is honored only for /stream (allowQueryKey), not REST", () => {
  const env = { API_KEY: "secret" };
  const c = mk({}, "https://x/api/matches?key=secret");
  assert.equal(isAuthorized(c.req, c.url, env, false), false); // REST: rejected (leak risk)
  assert.equal(isAuthorized(c.req, c.url, env, true), true); // /stream: accepted
});
