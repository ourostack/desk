// GitHub sign-in: the gateway learns who is signing in from the "Ouro Desk"
// GitHub App's user authorization. The GitHub user token is used once, to read
// the login, and then dropped; it is never stored or handed to anyone.
import { seal, unseal, TTL } from "./seal.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const page = (status, message) => ({
  status,
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Desk sign-in</title></head><body><p>${escapeHtml(message)}</p></body></html>`,
});

// `log` receives one line per refused or failed sign-in: the error code and
// client id only.
export function createGitHubSignIn({ key, clientId, clientSecret, callbackUrl, allowedLogins, fetch = globalThis.fetch, log = () => {} }) {
  // The browser goes to GitHub carrying the client's sign-in request as a
  // sealed `pending` state, and comes back with it to githubCallback.
  function authorizeUrl(pendingState) {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, state: pendingState });
    return url.href;
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

  // Returns `{ redirectTo }` to send the browser back to the client, or
  // `{ status, html }` for a page the gateway shows instead.
  async function githubCallback({ code, state, error }) {
    const pending = unseal("pending", state, { key });
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
    let user;
    try {
      user = await readGitHubUser(code);
    } catch {
      user = null;
    }
    if (!user) {
      log(`sign-in failed: github_unconfirmed client ${pending.clientId}`);
      return page(502, "GitHub did not confirm who signed in. Start again from Claude.");
    }
    if (!allowedLogins.includes(user.login)) {
      log(`sign-in refused: login_not_allowed client ${pending.clientId}`);
      return page(403, `This Desk is not open to ${user.login}.`);
    }
    back.searchParams.set(
      "code",
      seal(
        "code",
        {
          clientId: pending.clientId,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          scopes: pending.scopes,
          login: user.login,
          userId: user.id,
          name: user.name ?? null,
        },
        { key, ttlSec: TTL.code },
      ),
    );
    return { redirectTo: back.href };
  }

  return { authorizeUrl, githubCallback };
}

// The Express route for GitHub's redirect back to the gateway.
export function githubCallbackHandler({ githubCallback }) {
  return async (req, res) => {
    res.setHeader("cache-control", "no-store");
    try {
      const text = (value) => (typeof value === "string" ? value : undefined);
      const outcome = await githubCallback({ code: text(req.query.code), state: text(req.query.state), error: text(req.query.error) });
      if (outcome.redirectTo) return res.redirect(302, outcome.redirectTo);
      res.status(outcome.status).type("html").send(outcome.html);
    } catch {
      const failure = page(502, "Sign-in failed while talking to GitHub. Start again from Claude.");
      res.status(failure.status).type("html").send(failure.html);
    }
  };
}
