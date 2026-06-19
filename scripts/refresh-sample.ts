// Refresh sample.json from the live upstream (used by offline tests).
// Run: npm run refresh-sample

import { writeFileSync } from "node:fs";

const pools = "hhad,had,crs,ttg,hafu";
const url = `https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=${pools}&channel=c`;

const res = await fetch(url, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    Referer: "https://m.sporttery.cn/",
    Accept: "application/json, text/plain, */*",
  },
});
if (!res.ok) {
  console.error(`upstream responded ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const out = new URL("../sample.json", import.meta.url);
writeFileSync(out, JSON.stringify(data, null, 2));
const count = (data as any)?.value?.totalCount ?? "?";
console.log(`wrote sample.json (${count} matches)`);
