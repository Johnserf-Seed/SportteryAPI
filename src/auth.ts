// API-key authentication.
//
// If `API_KEY` is set (one key, or several comma-separated), every /api/* and
// /stream request must present a matching key via:
//   Authorization: Bearer <key>   or   X-API-Key: <key>
//   (/stream WebSocket clients may ALSO pass ?key=<key>, since a browser can't
//    set headers on a WebSocket handshake — ?key= is NOT accepted for REST,
//    because query-string keys leak into logs / history / Referer.)
// If `API_KEY` is unset/empty, auth is DISABLED (handy for local dev). If it is
// set but yields no usable key (e.g. only whitespace/commas), auth fails CLOSED
// (denies all) so a misconfigured secret can't silently leave the API open.

import type { Env } from "./env.ts";

/** Constant-time string compare (length is allowed to leak). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function configuredKeys(env: Env): string[] {
  return (env.API_KEY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Auth is ON whenever API_KEY is set to a non-empty string (even if misconfigured). */
export function authEnabled(env: Env): boolean {
  return (env.API_KEY ?? "") !== "";
}

function presentedKey(req: Request, url: URL, allowQueryKey: boolean): string {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  const header = req.headers.get("X-API-Key");
  if (header) return header.trim();
  if (allowQueryKey) return (url.searchParams.get("key") ?? "").trim();
  return "";
}

/**
 * Returns true if the request is authorized (or auth is disabled).
 * `allowQueryKey` enables the ?key= channel — pass true ONLY for /stream
 * (WebSocket), since query-string keys leak into logs / history / Referer.
 */
export function isAuthorized(req: Request, url: URL, env: Env, allowQueryKey = false): boolean {
  if (!authEnabled(env)) return true; // unset/empty → open
  const keys = configuredKeys(env);
  if (keys.length === 0) return false; // set but unusable → fail closed
  const given = presentedKey(req, url, allowQueryKey);
  if (!given) return false;
  return keys.some((k) => safeEqual(k, given));
}
