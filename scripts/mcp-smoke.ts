// Smoke test: spawn the MCP server over stdio, list tools, and call a few.
// Run: npm run mcp:smoke

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["--no-warnings", "--experimental-strip-types", "mcp/server.ts"],
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

function firstText(r: any): string {
  const t = r?.content?.find((c: any) => c.type === "text")?.text ?? "";
  return t.length > 220 ? t.slice(0, 220) + " …" : t;
}

const derive = await client.callTool({
  name: "derive_odds",
  arguments: { h: 1.44, d: 3.9, a: 5.6 },
});
console.log("\nderive_odds:", firstText(derive));

const parlay = await client.callTool({
  name: "calc_parlay",
  arguments: { legs: [{ odds: 1.44 }, { odds: 2.1 }, { odds: 3.3, result: "void" }], passType: "3串1", multiplier: 2 },
});
console.log("\ncalc_parlay:", firstText(parlay));

const value = await client.callTool({
  name: "compare_value",
  arguments: { offered: [2.1, 3.4, 3.8], reference: [2.0, 3.5, 4.0], labels: ["主胜", "平", "主负"] },
});
console.log("\ncompare_value:", firstText(value));

try {
  const matches = await client.callTool({ name: "get_matches", arguments: { pools: "had", league: "" } });
  const data = JSON.parse(matches.content?.[0]?.text ?? "{}");
  console.log("\nget_matches: source-of-truth live →", data.matchCount, "matches;", "first:", data.matches?.[0]?.matchNumStr, data.matches?.[0]?.home?.abbName, "vs", data.matches?.[0]?.away?.abbName);
} catch (e) {
  console.log("\nget_matches: (live fetch failed — expected if sporttery throttles)", (e as Error).message);
}

await client.close();
console.log("\nOK");
