// The browser session for the gateway's own pages (spec item 18): first sign-in, linking GitHub, and later moving,
// downloading and deleting a desk. A page sign-in through the Ouro tenant starts it (entra.js `beginPage`); links in
// chat carry no capability, so every page asks for the session of the account it acts for.
//
// The session is one sealed cookie, `__Host-desk-session`: HttpOnly, Secure, SameSite=Lax (it must ride the
// top-level redirect back from ciamlogin.com), Path=/, no Domain, 12 hours. It holds the accountId, a random session
// id and when it was issued; the gateway keeps no session state. Every use reads the account, so a session ends as
// soon as its account's Desk access is turned off, the account is deleted, or the account signs out: sign-out records
// a time on the account (store revokeSessions) before which every session of it, any copy of the cookie included, is
// refused.
//
// A page that changes something posts a CSRF token sealed for that session id, and the post must come from the
// gateway's own origin (provider.js `fromOwnOrigin`, as the consent form does).
import { randomBytes } from "node:crypto";
import { sealer } from "./seal.js";
import { hostCookie, parseCookies } from "./signin-cookie.js";
import { fromOwnOrigin } from "./provider.js";

export const SESSION_COOKIE = "__Host-desk-session";
export const SESSION_TTL_SEC = 12 * 3600;
const SESSION_KIND = "browser-session";
const CSRF_KIND = "browser-csrf";
export const DEFAULT_NEXT = "/account";
// A path on the gateway: segments of letters, digits, `-` and `_`, with no query, fragment, `//` or backslash, so
// it can't name another host.
const LOCAL_PATH = /^(?:\/[A-Za-z0-9_-]+)+\/?$/;

const stderrLog = (message) => process.stderr.write(`desk-hosted session: ${message}\n`);

// Where a page sign-in may return to: `next` when it is a path on the gateway, else the account page.
export function safeNext(next) {
  return typeof next === "string" && next.length <= 200 && LOCAL_PATH.test(next) ? next : DEFAULT_NEXT;
}

// `store` answers getAccount. `issuer` is the gateway's public URL, whose origin page posts must come from.
export function createBrowserSession({ key, keys, store, issuer, now = Date.now, log = stderrLog }) {
  if (!store) throw new Error("createBrowserSession needs the accounts store");
  const { sealed, unsealed } = sealer({ key, keys, now });
  const issuerOrigin = new URL(issuer).origin;

  function sessionOf(req) {
    const session = unsealed(SESSION_KIND, parseCookies(req?.headers?.cookie)[SESSION_COOKIE]);
    return typeof session?.accountId === "string" && session.accountId !== "" && typeof session.sid === "string" ? session : null;
  }

  return {
    // The Set-Cookie header that starts a session for `accountId`.
    cookie(accountId) {
      if (typeof accountId !== "string" || accountId === "") throw new TypeError("a session needs an accountId");
      return hostCookie(SESSION_COOKIE, sealed(SESSION_KIND, { accountId, sid: randomBytes(16).toString("base64url"), iat: now() }, SESSION_TTL_SEC), SESSION_TTL_SEC);
    },

    start(res, accountId) {
      res.append("set-cookie", this.cookie(accountId));
    },

    // The Set-Cookie header that ends the session.
    clear: () => hostCookie(SESSION_COOKIE, "", 0),

    // The accountId this request's session acts for, or null when there is no valid session or its account is gone
    // or has Desk access off. Throws the store's error when the store can't answer, so a page can say "try again"
    // rather than send the person round a sign-in that can't help.
    async require(req) {
      const session = sessionOf(req);
      if (!session) return null;
      const account = await store.getAccount(session.accountId);
      if (!account?.deskAccess) {
        log(`session refused: ${account ? "access_off" : "no_account"} account ${session.accountId}`);
        return null;
      }
      if (account.sessionsNotBefore !== undefined && !(Number.isFinite(session.iat) && session.iat >= account.sessionsNotBefore)) {
        log(`session refused: signed_out account ${session.accountId}`);
        return null;
      }
      return session.accountId;
    },

    // Signs out every session of this request's account issued up to now, when this request's session is itself
    // still valid: a signed-out copy of a cookie can't sign the account out again. Throws the store's error.
    async revoke(req) {
      const accountId = await this.require(req);
      if (accountId) await store.revokeSessions(accountId, now() + 1);
    },

    // The account row for a page to show (getAccount's answer).
    account: (accountId) => store.getAccount(accountId),

    // A CSRF token for this request's session, to put in a page's forms; null without a session.
    csrfToken(req) {
      const session = sessionOf(req);
      return session ? sealed(CSRF_KIND, { sid: session.sid, accountId: session.accountId }, SESSION_TTL_SEC) : null;
    },

    // Whether a POST carries this session's CSRF token (form field `csrf` or header `x-csrf-token`) and came from
    // the gateway's own origin. `accountId`, when given, must be the session's.
    checkCsrf(req, accountId) {
      const session = sessionOf(req);
      if (!session || (accountId !== undefined && accountId !== session.accountId)) return false;
      if (!fromOwnOrigin(req, issuerOrigin)) return false;
      const given = typeof req.body?.csrf === "string" ? req.body.csrf : req.get?.("x-csrf-token");
      const token = unsealed(CSRF_KIND, given);
      return token?.sid === session.sid && token.accountId === session.accountId;
    },
  };
}
