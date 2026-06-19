// Local stdio MCP server for the Sporttery odds engine.
//
// Exposes the live-odds + derivation + parlay tooling to any MCP host
// (Claude Desktop / Claude Code) as callable tools. Runs locally so it can fetch
// sporttery directly from your own network; all math reuses the tested src/* modules.
//
// Run: node --no-warnings --experimental-strip-types mcp/server.ts   (npm run mcp)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchSporttery } from "./sporttery.ts";
import { parseUpstream } from "../src/parse.ts";
import { compareOdds, deriveMarket, round } from "../src/derive.ts";
import { calcParlay, listParlayTypes, PARLAY_TABLE, TICKET_CAP, UNIT_PRICE } from "../src/parlay.ts";
import { POOL_MAX_ALLUP, POOL_NAME_ZH } from "../src/labels.ts";
import type { PoolCode } from "../src/types.ts";

const ALL_POOLS: PoolCode[] = ["had", "hhad", "crs", "ttg", "hafu"];
const ALL = ALL_POOLS.join(",");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}
function err(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
}

function selectPools(csv: string | undefined, fallback: string): PoolCode[] {
  const list = (csv && csv.trim() ? csv : fallback)
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is PoolCode => (ALL_POOLS as string[]).includes(s));
  return list.length ? list : ALL_POOLS;
}

const META = {
  pools: ALL_POOLS.map((p) => ({ code: p, nameZh: POOL_NAME_ZH[p], maxAllUp: POOL_MAX_ALLUP[p] })),
  parlay: {
    unitPriceYuan: UNIT_PRICE,
    ticketCapYuan: TICKET_CAP,
    note: "单注2元；单关=2×倍数×赔率；M串N每注=2×倍数×Π(赔率)；单张封顶500万；混合过关取最小关数(木桶原则)。",
    table: PARLAY_TABLE,
  },
  formulas: {
    impliedProb: "1 / odds",
    returnRate: "1 / Σ(1/odds)  返还率",
    noVigProb: "(1/odds) / Σ(1/odds)  去水真实概率",
    fairOdds: "1 / noVigProb  真实赔率",
    kellyIndex: "offeredOdds × referenceProb  凯利指数 (需外部参考赔率)",
    ev: "referenceProb × offeredOdds - 1",
  },
};

const server = new McpServer({ name: "sporttery-odds", version: "0.1.0" });

server.registerTool(
  "get_matches",
  {
    title: "获取竞彩足球最新赔率",
    description:
      "Fetch the latest China Sports Lottery 竞彩足球 matches with live odds and DERIVED metrics " +
      "(返还率 return rate, no-vig probabilities, fair odds, up/flat/down trend). Pools: had 胜平负, " +
      "hhad 让球胜平负, crs 比分, ttg 总进球, hafu 半全场. Default pools are had,hhad to keep responses " +
      "small — pass `pools` to include crs/ttg/hafu. Filter by date/league/matchId.",
    inputSchema: {
      pools: z.string().optional().describe("comma-separated: had,hhad,crs,ttg,hafu (default had,hhad)"),
      date: z.string().optional().describe("matchNumDate filter, e.g. 260619"),
      league: z.string().optional().describe("league name substring, e.g. 世界杯"),
      matchId: z.number().optional().describe("filter to a single upstream matchId"),
    },
  },
  async ({ pools, date, league, matchId }) => {
    try {
      const want = selectPools(pools, "had,hhad");
      const raw = await fetchSporttery(ALL); // fetch all, filter locally (one cached call)
      return ok(parseUpstream(raw, { pools: want, date, league, matchId }));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "get_match",
  {
    title: "按 matchId 获取单场",
    description: "Fetch one 竞彩足球 match (all pools) by its upstream matchId, with derived metrics.",
    inputSchema: { matchId: z.number().describe("upstream matchId") },
  },
  async ({ matchId }) => {
    try {
      const raw = await fetchSporttery(ALL);
      const res = parseUpstream(raw, { pools: ALL_POOLS, matchId });
      if (res.matchCount === 0) return err(new Error(`match ${matchId} not found / not selling`));
      return ok(res.matches[0]);
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "derive_odds",
  {
    title: "赔率推导",
    description:
      "Derive implied probability, no-vig (去水) probability, 返还率 return rate, margin, and fair odds " +
      "from a set of decimal odds for ONE market. Accepts {odds:[...]} (any N outcomes) or {h,d,a}.",
    inputSchema: {
      odds: z.array(z.number()).optional().describe("decimal odds for an N-outcome market"),
      h: z.number().optional(),
      d: z.number().optional(),
      a: z.number().optional(),
    },
  },
  async ({ odds, h, d, a }) => {
    try {
      let list: number[];
      let keys: string[] | undefined;
      if (Array.isArray(odds) && odds.length) {
        list = odds;
      } else if ([h, d, a].every((x) => typeof x === "number")) {
        list = [h as number, d as number, a as number];
        keys = ["home", "draw", "away"];
      } else {
        throw new Error("provide {odds:[...]} (any N-way market) or all of {h,d,a}");
      }
      if (list.length < 2 || list.some((o) => !Number.isFinite(o) || o <= 1)) {
        throw new Error("need at least 2 decimal odds, each > 1");
      }
      const dv = deriveMarket(list);
      return ok({
        overround: round(dv.overround, 6),
        returnRate: round(dv.returnRate, 6),
        returnRatePct: round(dv.returnRate * 100, 3),
        margin: round(dv.margin, 6),
        outcomes: dv.perOutcome.map((o, i) => ({
          key: keys?.[i] ?? String(i),
          odds: o.odds,
          impliedProb: round(o.impliedProb, 6),
          noVigProb: round(o.noVigProb, 6),
          fairOdds: round(o.fairOdds, 4),
        })),
      });
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "compare_value",
  {
    title: "凯利指数 / 价值对比",
    description:
      "Compare an offered odds set against a reference set (e.g. sporttery 胜平负 vs a 欧赔 reference). " +
      "The reference is de-vigged into 'true' probabilities; returns 凯利指数 (Kelly index = odds×refProb), " +
      "EV, Kelly stake fraction, and isValue per outcome. Lists must align outcome-for-outcome.",
    inputSchema: {
      offered: z.array(z.number()).describe("the offered decimal odds"),
      reference: z.array(z.number()).describe("reference decimal odds, same length"),
      labels: z.array(z.string()).optional().describe("optional labels per outcome"),
    },
  },
  async ({ offered, reference, labels }) => {
    try {
      if (offered.length !== reference.length || offered.length < 2) {
        throw new Error("offered and reference must be the same length (>= 2)");
      }
      if ([...offered, ...reference].some((o) => !Number.isFinite(o) || o <= 1)) {
        throw new Error("all odds must be decimal and > 1");
      }
      const res = compareOdds(offered, reference);
      return ok({
        outcomes: res.map((a, i) => ({
          label: labels?.[i] ?? String(i),
          odds: a.odds,
          refProb: round(a.refProb, 6),
          kelly: round(a.kelly, 4),
          ev: round(a.ev, 4),
          kellyFraction: round(a.kellyFraction, 4),
          isValue: a.isValue,
        })),
      });
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "calc_parlay",
  {
    title: "单关 / 过关奖金计算",
    description:
      "Calculate 单关/过关 (parlay) stake and payout for 竞彩足球. Each leg has decimal `odds` and an " +
      "optional `result` (win|lose|void; void settles at 1.00). `passType` is '单关', an 'M串N' label like " +
      "'3串1', or omit for N串1; or pass explicit `folds`. `multiplier` is 倍数. Returns bets(注数), " +
      "totalStake, maxPayout, realizedPayout (per `result`), byFold, and the 500万 cap flag.",
    inputSchema: {
      legs: z
        .array(
          z.object({
            odds: z.number(),
            result: z.enum(["win", "lose", "void"]).optional(),
            label: z.string().optional(),
          }),
        )
        .describe("the selections"),
      passType: z.string().optional().describe("'单关', 'M串N' label, or omit"),
      folds: z.array(z.number().int()).optional().describe("explicit combination sizes (integers), e.g. [2,3]"),
      multiplier: z.number().int().optional().describe("倍数 (default 1)"),
    },
  },
  async (args) => {
    try {
      return ok(calcParlay(args));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "list_parlay_types",
  {
    title: "过关方式对照表",
    description: "List the official 过关 (M串N) combination table. Optionally filter to a number of matches.",
    inputSchema: { matches: z.number().optional().describe("number of selected matches (2-8)") },
  },
  async ({ matches }) => ok(listParlayTypes(matches)),
);

server.registerTool(
  "get_meta",
  {
    title: "玩法 / 公式参考",
    description: "Reference: pool labels (胜平负/让球/比分/总进球/半全场), the parlay table, and the odds formulas this server uses.",
    inputSchema: {},
  },
  async () => ok(META),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[sporttery-odds] MCP server ready (stdio)");
