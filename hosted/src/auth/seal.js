// Sealed tokens: the gateway keeps no sign-in state, so every client id, code
// and token it issues carries its own claims, signed with the gateway's key.
// A token is `<base64url JSON>.<base64url HMAC-SHA256 of that text>`. The JSON
// holds the payload plus `kind`, so a token of one kind is never accepted as
// another, and `exp` (seconds since the epoch) unless the token never expires.
import { createHmac, timingSafeEqual } from "node:crypto";

// How long each kind of token lives, in seconds. A client id never expires.
export const TTL = { consent: 600, pending: 600, code: 60, access: 3600, refresh: 30 * 24 * 3600 };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const sign = (text, key) => createHmac("sha256", key).update(text).digest();

export function seal(kind, payload, { key, ttlSec } = {}) {
  const claims = { ...payload, kind };
  if (ttlSec !== undefined) claims.exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body, key).toString("base64url")}`;
}

// Returns the payload (with `exp` when the token has one), or null when the
// token is malformed, signed with another key, of another kind or expired.
export function unseal(kind, token, { key } = {}) {
  if (typeof token !== "string") return null;
  const [body, signature, extra] = token.split(".");
  if (extra !== undefined || !BASE64URL.test(body ?? "") || !BASE64URL.test(signature ?? "")) return null;
  const expected = sign(body, key);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims === null || typeof claims !== "object" || claims.kind !== kind) return null;
  if (claims.exp !== undefined && !(claims.exp > Date.now() / 1000)) return null;
  const { kind: _kind, ...payload } = claims;
  return payload;
}

// A value derived from the key for one purpose, such as a client's secret.
// The label keeps it from ever equalling a token signature.
export const derive = (label, value, { key }) => sign(`${label}\0${value}`, key).toString("base64url");
