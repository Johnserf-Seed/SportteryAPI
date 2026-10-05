import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

// Offline check of the MCP client's proxy path: Node's built-in fetch driven by
// the undici ProxyAgent from getDispatcher(). An undici major whose dispatcher
// API doesn't match Node's bundled fetch fails here ("fetch failed: invalid
// onRequestStart method" with undici 8 on Node 22) — CI can't see it otherwise.

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

test("SPORTTERY_PROXY routes the MCP client's fetch through an undici ProxyAgent", async (t) => {
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const targetPort = await listen(target);

  // Minimal CONNECT proxy (undici's ProxyAgent tunnels every request). It is
  // pinned to the local target and never dials a caller-supplied address.
  const requested: string[] = [];
  const tunnels = new Set<net.Socket>();
  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, socket: net.Socket, head) => {
    requested.push(req.url ?? "");
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    tunnels.add(socket).add(upstream);
  });
  const proxyPort = await listen(proxy);
  process.env.SPORTTERY_PROXY = `http://127.0.0.1:${proxyPort}`;

  const { getDispatcher } = await import("../mcp/sporttery.ts");
  const dispatcher = await getDispatcher();
  t.after(async () => {
    await dispatcher?.destroy();
    for (const s of tunnels) s.destroy();
    target.closeAllConnections();
    proxy.closeAllConnections();
    target.close();
    proxy.close();
  });
  assert.ok(dispatcher, "expected a ProxyAgent when SPORTTERY_PROXY is set");

  const res = await fetch(`http://127.0.0.1:${targetPort}/odds`, { dispatcher } as RequestInit);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual([...new Set(requested)], [`127.0.0.1:${targetPort}`], "the request should tunnel through the proxy");
});
