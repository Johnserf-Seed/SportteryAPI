import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Offline end-to-end check of the stdio MCP server (SDK + zod input schemas):
// spawn it, list the tools, and call the ones that need no network.

const root = fileURLToPath(new URL("..", import.meta.url));

test("MCP server lists its tools, runs them, and rejects bad arguments", { timeout: 30_000 }, async (t) => {
  const client = new Client({ name: "sporttery-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", "--experimental-strip-types", "mcp/server.ts"],
      cwd: root,
    }),
  );
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "calc_parlay",
    "compare_value",
    "derive_odds",
    "get_match",
    "get_matches",
    "get_meta",
    "list_parlay_types",
  ]);

  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const json = (r: any) => JSON.parse(r.content[0].text);

  assert.equal(json(await call("calc_parlay", { legs: [{ odds: 2 }, { odds: 3 }], passType: "2串1" })).maxPayout, 12);
  assert.equal(json(await call("derive_odds", { h: 2, d: 4, a: 4 })).returnRatePct, 100);

  // Domain errors come back as tool errors rather than crashing the server.
  const tooMany = await call("calc_parlay", { legs: Array.from({ length: 16 }, () => ({ odds: 2 })) });
  assert.equal(tooMany.isError, true);

  // Malformed arguments are rejected by the zod schemas (an error result or a
  // thrown JSON-RPC error, depending on the SDK version).
  const rejected = async (name: string, args: Record<string, unknown>) => {
    try {
      return (await call(name, args)).isError === true;
    } catch {
      return true;
    }
  };
  assert.ok(await rejected("calc_parlay", { legs: "x" }), "legs must be an array");
  assert.ok(await rejected("get_match", { matchId: "abc" }), "matchId must be a number");
});
