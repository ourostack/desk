// The per-sign-in cookie: binds an upstream sign-in (Ouro tenant, and in Task 6 the GitHub fallback) to the browser
// that began it. `begin` makes a random `stateId`, a PKCE verifier and a nonce, and seals the verifier and nonce into
// a cookie named for that stateId; the `state` sent upstream carries only the stateId, inside the sealed pending
// request. The callback must present the cookie for its state's stateId, so a code obtained in one browser and
// replayed through another's callback (code injection, login CSRF) is refused, while two sign-ins in one browser
// each keep their own cookie.
//
// The cookie is `__Host-desk-signin-<stateId>`: HttpOnly, Secure, SameSite=Lax (it must ride the top-level redirect
// back from ciamlogin.com), Path=/, no Domain, 10 minutes. A browser holds at most 5; `begin` drops the oldest.
import { createHash, randomBytes } from "node:crypto";
import { sealer } from "./seal.js";

export const SIGNIN_COOKIE_PREFIX = "__Host-desk-signin-";
export const SIGNIN_TTL_SEC = 600;
const MAX_SIGNINS = 5;
const STATE_ID = /^[A-Za-z0-9_-]{22,64}$/;

const random = (bytes) => randomBytes(bytes).toString("base64url");

// A Cookie header as `{ name: value }`. Pairs without `=` are ignored; the first of two same-named cookies wins.
export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string") return cookies;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(at + 1).trim();
  }
  return cookies;
}

// A Set-Cookie header for a `__Host-` cookie. `maxAgeSec` 0 deletes it.
export const hostCookie = (name, value, maxAgeSec) => `${name}=${value}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export function createSigninCookies({ key, keys, now = Date.now }) {
  const { sealed, unsealed } = sealer({ key, keys, now });
  const cookieName = (stateId) => `${SIGNIN_COOKIE_PREFIX}${stateId}`;
  const clear = (stateId) => hostCookie(cookieName(stateId), "", 0);

  return {
    // `cookies` are the browser's current cookies, so the oldest sign-ins beyond the limit can be dropped.
    begin(cookies = {}) {
      const stateId = random(16);
      const verifier = random(32);
      const nonce = random(24);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const held = Object.entries(cookies)
        .filter(([name]) => name.startsWith(SIGNIN_COOKIE_PREFIX))
        .map(([name, value]) => ({ name, exp: unsealed("signin", value)?.exp ?? -Infinity }))
        .sort((a, b) => a.exp - b.exp);
      const dropped = held.slice(0, Math.max(0, held.length - (MAX_SIGNINS - 1)));
      const setCookies = [
        ...dropped.map(({ name }) => hostCookie(name, "", 0)),
        hostCookie(cookieName(stateId), sealed("signin", { stateId, verifier, nonce }, SIGNIN_TTL_SEC), SIGNIN_TTL_SEC),
      ];
      return { stateId, verifier, challenge, nonce, setCookies };
    },

    // The verifier and nonce sealed for `stateId` in this browser, or null.
    take(stateId, cookies = {}) {
      if (typeof stateId !== "string" || !STATE_ID.test(stateId)) return null;
      const signin = unsealed("signin", cookies[cookieName(stateId)]);
      if (!signin || signin.stateId !== stateId || typeof signin.verifier !== "string" || typeof signin.nonce !== "string") return null;
      return { verifier: signin.verifier, nonce: signin.nonce };
    },

    clear,
  };
}
