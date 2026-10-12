// GitHub sign-in: the gateway learns who is signing in from the "Ouro Desk"
// GitHub App's user authorization. The GitHub user token is used once, to read
// the user, and then dropped; it is never stored or handed to anyone.
//
// It runs in one of two ways:
//
// - Without Ouro accounts (today's gateway, no `fallback`), it is the only
//   sign-in: any login in `allowedLogins` gets a code carrying its GitHub login.
// - With Ouro accounts (`fallback`), it is the GitHub fallback (spec item 13):
//   on only while `fallback.enabled` (DESK_GITHUB_SIGNIN=on), it admits only
//   GitHub user ids mapped to an Ouro account (DESK_GITHUB_ACCOUNTS), keyed by
//   the numeric id because a login can be renamed and re-registered and an id
//   can't. It binds each sign-in to the browser that began it with the
//   per-sign-in cookie, as the Ouro tenant's sign-in does, and mints a code
//   carrying the `accountId` and `authTime` (seconds since the epoch, the
//   moment this callback accepted GitHub's answer).
import { TTL } from "./seal.js";
import { page, sendPage, startAgainPage } from "./pages.js";
import { parseCookies } from "./signin-cookie.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

export const githubSignInOffPage = () => page(403, "GitHub sign-in is turned off for this Hosted Desk. Start again from Claude and sign in with Apple or email.");

// `log` receives one line per refused or failed sign-in: the error code and
// client id (and, with accounts, the accountId) only. `sealed(kind, payload,
// ttlSec)` and `unsealed(kind, token)` are the provider's, so this signs and
// checks with its signing-key ring.
//
// `fallback`, with Ouro accounts: `{ enabled, accountFor(userId) -> accountId |
// undefined, cookies (createSigninCookies'), admit(accountId, clientId) -> page
// | null, now() }`.
export function createGitHubSignIn({ sealed, unsealed, clientId, clientSecret, callbackUrl, allowedLogins = [], fetch = globalThis.fetch, log = () => {}, fallback }) {
  const url = (state) => {
    const authorize = new URL(AUTHORIZE_URL);
    authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, state });
    return authorize.href;
  };

  // The browser goes to GitHub carrying the client's sign-in request as a
  // sealed `pending` state, and comes back with it to githubCallback.
  function authorizeUrl(pendingState) {
    return url(pendingState);
  }

  // The fallback's start: `pending` is the approved request, `jar` the
  // browser's cookies. Returns `{ redirectTo, setCookies }`.
  function begin(pending, jar = {}) {
    const { stateId, setCookies } = fallback.cookies.begin(jar);
    const { exp: _exp, ...request } = pending;
    return { redirectTo: url(sealed("pending", { ...request, stateId }, TTL.pending)), setCookies };
  }

  async function readGitHubUser(code) {
    const exchange = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl }).toString(),
    });
    const grant = exchange.ok ? await exchange.json() : {};
    if (!grant.access_token) return null;
    const response = await fetch(USER_URL, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${grant.access_token}`, "user-agent": "ouro-desk-hosted" },
    });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user?.login === "string" ? user : null;
  }

  async function confirmedUser(code, pending) {
    let user;
    try {
      user = await readGitHubUser(code);
    } catch {
      user = null;
    }
    if (!user) log(`sign-in failed: github_unconfirmed client ${pending.clientId}`);
    return user;
  }

  // Today's sign-in, unchanged. Returns `{ redirectTo }` to send the browser
  // back to the client, or `{ status, html }` for a page shown instead.
  async function allowedLoginCallback({ code, state, error }) {
    const pending = unsealed("pending", state);
    if (!pending) {
      log("sign-in refused: invalid_state");
      return page(400, "This sign-in link has expired or is not valid. Start again from Claude.");
    }
    const back = new URL(pending.redirectUri);
    if (pending.state !== undefined) back.searchParams.set("state", pending.state);
    if (error || !code) {
      log(`sign-in refused: access_denied by GitHub client ${pending.clientId}`);
      back.searchParams.set("error", "access_denied");
      return { redirectTo: back.href };
    }
    const user = await confirmedUser(code, pending);
    if (!user) return page(502, "GitHub did not confirm who signed in. Start again from Claude.");
    if (!allowedLogins.includes(user.login)) {
      log(`sign-in refused: login_not_allowed client ${pending.clientId}`);
      return page(403, `This Desk is not open to ${user.login}.`);
    }
    back.searchParams.set(
      "code",
      sealed(
        "code",
        {
          clientId: pending.clientId,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          scopes: pending.scopes,
          login: user.login,
          userId: user.id,
          name: user.name ?? null,
          aud: pending.aud,
        },
        TTL.code,
      ),
    );
    return { redirectTo: back.href };
  }

  // The GitHub fallback. Every outcome carries `clearCookies`.
  async function fallbackCallback({ code, state, error, cookies: jar = {} }) {
    if (!fallback.enabled) {
      log("sign-in refused: github_signin_off");
      return { ...githubSignInOffPage(), clearCookies: [] };
    }
    const pending = unsealed("pending", state);
    if (!pending || typeof pending.stateId !== "string") {
      log("sign-in refused: invalid_state");
      return { ...startAgainPage(), clearCookies: [] };
    }
    const clearCookies = [fallback.cookies.clear(pending.stateId)];
    if (!fallback.cookies.take(pending.stateId, jar)) {
      log(`sign-in refused: signin_cookie_missing client ${pending.clientId}`);
      return { ...startAgainPage(), clearCookies };
    }
    const back = new URL(pending.redirectUri);
    if (pending.state !== undefined) back.searchParams.set("state", pending.state);
    if (error || !code) {
      log(`sign-in refused: access_denied by GitHub client ${pending.clientId}`);
      back.searchParams.set("error", "access_denied");
      return { redirectTo: back.href, clearCookies };
    }
    const user = await confirmedUser(code, pending);
    if (!user) return { ...page(502, "GitHub did not confirm who signed in. Start again from Claude."), clearCookies };
    const accountId = Number.isSafeInteger(user.id) ? fallback.accountFor(user.id) : undefined;
    if (!accountId) {
      log(`sign-in refused: github_user_not_mapped client ${pending.clientId}`);
      return { ...page(403, `This Desk is not open to ${user.login}.`), clearCookies };
    }
    const refusal = await fallback.admit(accountId, pending.clientId);
    if (refusal) return { ...refusal, clearCookies };
    back.searchParams.set(
      "code",
      sealed(
        "code",
        {
          clientId: pending.clientId,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          scopes: pending.scopes,
          accountId,
          authTime: Math.floor(fallback.now() / 1000),
          aud: pending.aud,
        },
        TTL.code,
      ),
    );
    log(`sign-in: account ${accountId} by GitHub client ${pending.clientId}`);
    return { redirectTo: back.href, clearCookies };
  }

  return { authorizeUrl, begin, githubCallback: fallback ? fallbackCallback : allowedLoginCallback };
}

// The Express route for GitHub's redirect back to the gateway.
export function githubCallbackHandler({ githubCallback }) {
  return async (req, res) => {
    res.setHeader("cache-control", "no-store");
    try {
      const text = (value) => (typeof value === "string" ? value : undefined);
      const outcome = await githubCallback({
        code: text(req.query.code),
        state: text(req.query.state),
        error: text(req.query.error),
        cookies: parseCookies(req.headers.cookie),
      });
      for (const header of outcome.clearCookies ?? []) res.append("set-cookie", header);
      if (outcome.redirectTo) return res.redirect(302, outcome.redirectTo);
      sendPage(res, outcome);
    } catch {
      sendPage(res, page(502, "Sign-in failed while talking to GitHub. Start again from Claude."));
    }
  };
}
