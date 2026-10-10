// Sealed tokens: the gateway keeps no sign-in state, so every client id, code
// and token it issues carries its own claims, signed with the gateway's key.
// A token is `<base64url JSON>.<base64url HMAC-SHA256 of that text>`. The JSON
// holds the payload plus `kind`, so a token of one kind is never accepted as
// another, and `exp` (seconds since the epoch) unless the token never expires.
//
// The gateway signs with one key and may accept more: during a signing-key
// rollover the previous key is still accepted until its `until` time, so
// rotating the key no longer signs everyone out. `now` (milliseconds since the
// epoch) defaults to the clock and lets tests move time.
import { createHmac, timingSafeEqual } from "node:crypto";

// How long each kind of token lives, in seconds. A client id never expires.
export const TTL = { consent: 600, pending: 600, code: 60, access: 3600, refresh: 30 * 24 * 3600 };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const sign = (text, key) => createHmac("sha256", key).update(text).digest();

export function seal(kind, payload, { key, ttlSec, now = Date.now() } = {}) {
  const claims = { ...payload, kind };
  if (ttlSec !== undefined) claims.exp = Math.floor(now / 1000) + ttlSec;
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body, key).toString("base64url")}`;
}

// Whether `signature` is `body`'s signature under `key`.
function signedWith(body, signature, key) {
  const expected = sign(body, key);
  return signature.length === expected.length && timingSafeEqual(signature, expected);
}

// Returns the payload (with `exp` when the token has one), or null when the
// token is malformed, signed with no accepted key, of another kind or expired.
// `keys` is `[{ key, until? }]`, tried in order; a key past its `until`
// (milliseconds since the epoch) is skipped. `key` alone means `[{ key }]`.
export function unseal(kind, token, { key, keys = [{ key }], now = Date.now() } = {}) {
  if (typeof token !== "string") return null;
  const [body, signature, extra] = token.split(".");
  if (extra !== undefined || !BASE64URL.test(body ?? "") || !BASE64URL.test(signature ?? "")) return null;
  const given = Buffer.from(signature, "base64url");
  const accepted = keys.filter((entry) => entry.key && (entry.until === undefined || now <= entry.until));
  if (!accepted.some((entry) => signedWith(body, given, entry.key))) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims === null || typeof claims !== "object" || claims.kind !== kind) return null;
  if (claims.exp !== undefined && !(claims.exp > now / 1000)) return null;
  const { kind: _kind, ...payload } = claims;
  return payload;
}

// A value derived from the key for one purpose, such as a client's secret.
// The label keeps it from ever equalling a token signature.
export const derive = (label, value, { key }) => sign(`${label}\0${value}`, key).toString("base64url");

// A key's fingerprint: safe to log, equal for equal keys, so a script can
// check which key the running gateway holds without ever reading it out.
export const fingerprint = (key) => derive("fingerprint", "desk", { key });
