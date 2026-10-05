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

  // Minimal forward proxy: CONNECT tunnels plus absolute-form requests.
  const proxied: string[] = [];
  const tunnels = new Set<net.Socket>();
  const proxy = http.createServer((req, res) => {
    proxied.push(`${req.method} ${req.url}`);
    const upstream = http.request(req.url!, { method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(upstream);
  });
  proxy.on("connect", (req, socket: net.Socket, head) => {
    proxied.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    tunnels.add(socket).add(upstream);
  });

  const targetPort = await listen(target);
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
  assert.ok(proxied.length > 0, "the request should have gone through the proxy");
});
