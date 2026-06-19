// Smoke test of the API. Usage: BASE=<url> API_KEY=<key> node --experimental-strip-types scripts/smoke.ts
// Defaults to local dev; pass BASE=https://sporttery-api.<your-subdomain>.workers.dev for prod.
const BASE = process.env.BASE ?? "http://localhost:8787";
const API_KEY = process.env.API_KEY ?? "";
const authHeaders = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};

async function get(path: string) {
  return (await fetch(BASE + path, { headers: { ...authHeaders } })).json() as any;
}
async function post(path: string, body: unknown) {
  return (
    await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    })
  ).json() as any;
}

const health = await get("/health");
console.log("health        :", health.data?.ok);

const matches = await get("/api/matches?pools=had");
console.log("matches       :", matches.data?.source, matches.data?.matchCount + "场");

const derive = await post("/api/derive", { h: 1.44, d: 3.9, a: 5.6 });
console.log("derive RTP%   :", derive.data?.returnRatePct);

const value = await post("/api/value", {
  offered: [2.1, 3.4, 3.8],
  reference: [2.0, 3.5, 4.0],
  labels: ["主胜", "平", "主负"],
});
console.log("value kelly[0]:", value.data?.outcomes[0].label, value.data?.outcomes[0].kelly, "isValue", value.data?.outcomes[0].isValue);

const parlay = await post("/api/parlay", {
  legs: [{ odds: 1.44 }, { odds: 2.1 }, { odds: 3.3 }],
  passType: "3串1",
});
console.log("parlay 3串1   :", "bets", parlay.data?.bets, "maxPayout", parlay.data?.maxPayout);

const types = await get("/api/parlay/types?matches=5");
console.log("parlay/types  :", types.data?.map((v: any) => v.label).join(","));

const meta = await get("/api/meta");
console.log("meta cap元    :", meta.data?.parlay.ticketCapYuan);
