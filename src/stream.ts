// Durable Object: real-time odds stream over WebSocket (未来升级方向).
//
// This is the scaffold for the future direction "实时赔率变化流（WebSocket）".
// It uses the hibernation API (ctx.acceptWebSocket) so idle connections cost no
// billed wall-clock. To activate, uncomment the durable_objects/migrations/cron
// blocks in wrangler.jsonc and wire scheduled() in index.ts to call pushDiff().
//
// Flow once enabled:
//   cron (every minute) / DO alarm (sub-minute) → fetch upstream → diff vs last
//   snapshot in ctx.storage → broadcast({ type: "odds_diff", ... }) to clients.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { getOdds } from "./upstream.ts";
import { parseUpstream } from "./parse.ts";

interface ConnAttachment {
  /** Comma-separated pool filter the client subscribed to. */
  sub: string;
}

export class OddsStream extends DurableObject<Env> {
  /** Accept a client WebSocket (hibernatable). */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(req.url);
    const sub = url.searchParams.get("pools") ?? "";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sub } satisfies ConnAttachment);
    server.send(JSON.stringify({ type: "hello", message: "sporttery odds stream connected", sub }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (msg === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(): Promise<void> {
    /* connection dropped — nothing to clean up beyond hibernation defaults */
  }

  /** Send a payload to every connected client. */
  broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* socket gone */
      }
    }
  }

  /**
   * Poll upstream, diff against the last stored snapshot, and broadcast changed
   * markets. Call this from the Worker's scheduled() handler (or a DO alarm).
   */
  async poll(): Promise<void> {
    const { data } = await getOdds(this.env, this.ctx as unknown as ExecutionContext);
    const snapshot = parseUpstream(data);
    const prev = (await this.ctx.storage.get<Record<string, number>>("lastOdds")) ?? {};
    const next: Record<string, number> = {};
    const changes: Array<{ matchId: number; pool: string; code: string; outcome: string; odds: number }> = [];

    for (const m of snapshot.matches) {
      for (const market of Object.values(m.markets)) {
        if (!market) continue;
        for (const o of market.outcomes) {
          const key = `${m.matchId}:${market.pool}:${o.code}`;
          next[key] = o.odds;
          if (prev[key] !== undefined && prev[key] !== o.odds) {
            changes.push({ matchId: m.matchId, pool: market.pool, code: o.code, outcome: o.key, odds: o.odds });
          }
        }
      }
    }

    await this.ctx.storage.put("lastOdds", next);
    if (changes.length) {
      this.broadcast({ type: "odds_diff", updatedAt: snapshot.updatedAt, changes });
    }
  }
}
