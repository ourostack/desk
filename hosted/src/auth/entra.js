// Sign-in through the Ouro tenant (Microsoft Entra External ID; spec item 9). Our OAuth server stays the
// authorization server MCP clients see; only its upstream sign-in moves from GitHub to the tenant:
//
// 1. `begin` sends the browser to the tenant's authorize endpoint with an authorization code request, S256 PKCE and
//    a nonce, `response_mode=query` (a form-post callback would be a cross-site POST that drops SameSite=Lax
//    cookies) and `scope=openid profile` (a v2 ID token carries `oid` only with `profile`). The PKCE verifier and
//    the nonce stay in the per-sign-in cookie (signin-cookie.js); `state` carries only the sealed pending request
//    and that cookie's stateId.
// 2. `callback` requires that cookie, exchanges the code with `client_secret_post` and the verifier, validates the
//    ID token against that cookie's nonce (id-token.js), and maps `(tid, oid)` to an Ouro `accountId` in the
//    accounts store, redeeming the browser's invite cookie when the identity is new. It then checks that the
//    account's Desk access is on and that its binding names this gateway's desk, and mints our own code carrying
//    `accountId` and `authTime`: the moment this callback accepted a fresh ID token, not the token's `auth_time`,
//    which Entra's rolling session keeps old.
//
// The tenant's endpoints come from its discovery document (`createDiscovery`). The document must name the issuer
// the gateway expects, `https://<tenantId>.ciamlogin.com/<tenantId>/v2.0`: its host is the tenant id, unlike the
// endpoints, which use the tenant name. A document naming any other issuer stops the gateway at start; one that
// can't be fetched doesn't, so a ciamlogin.com outage leaves the other sign-in paths working while this one shows a
// "try again shortly" page and the document is fetched again every 30 s.
//
// Every refusal fails closed with a page or an OAuth error. Logs name accounts by accountId only, never by oid,
// name, email, code, token, verifier, nonce, invite token or secret.
import { TTL, sealer } from "./seal.js";
import { createIdTokenVerifier } from "./id-token.js";
import { createSigninCookies, hostCookie, parseCookies } from "./signin-cookie.js";
import { hashToken } from "../accounts/invites.js";
import {
  accessOffPage,
  inviteInvalidPage,
  inviteOnlyPage,
  invitePage,
  inviteRefusedPage,
  noDeskPage,
  page,
  sendPage,
  signInUnavailablePage,
  startAgainPage,
  startingUpPage,
} from "./pages.js";

const stderrLog = (message) => process.stderr.write(`desk-hosted auth: ${message}\n`);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const entraIssuer = (tenantId) => `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`;

// How long a discovery fetch may take before it counts as failed and is retried in the background: short, so
// starting the gateway never waits long on ciamlogin.com.
export const DISCOVERY_TIMEOUT_MS = 10_000;
// How long the code exchange may take: a person is waiting at the callback, and a slow tenant should give them the
// "start again" page rather than a request held open for minutes.
export const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

// The seal kind of the state sent to the tenant. Its own kind, so it is never accepted as the GitHub sign-in's
// `pending` state, nor a GitHub state here.
const STATE_KIND = "entra-pending";

const httpsUrl = (value) => {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

class IssuerMismatch extends Error {
  constructor(found, expected) {
    super(`the Ouro tenant's discovery document names issuer ${found}, but the gateway expects ${expected}; check DESK_ENTRA_TENANT_ID and DESK_ENTRA_SUBDOMAIN`);
    this.name = "IssuerMismatch";
  }
}

// The tenant's OpenID Connect discovery document. `start()` fetches it once, waiting at most `timeoutMs`: it rejects
// only when the document loads and names another issuer; when it can't be fetched in time (or is malformed), it
// resolves and keeps fetching every `retryMs` in the background until it loads. `ready()` says whether it has;
// `get()` returns its endpoints; `mismatch()` says whether the last document fetched named another issuer, which a
// background retry can only log.
export function createDiscovery({
  subdomain,
  tenantId,
  expectedIssuer = entraIssuer(tenantId),
  fetch = globalThis.fetch,
  retryMs = 30_000,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  log = stderrLog,
}) {
  if (!SUBDOMAIN.test(subdomain ?? "")) throw new Error("the Ouro tenant's subdomain must be a DNS label, such as ourobot");
  if (!GUID.test(tenantId ?? "")) throw new Error("the Ouro tenant's id must be a GUID");
  const url = `https://${subdomain}.ciamlogin.com/${tenantId}/v2.0/.well-known/openid-configuration`;
  let loaded = null;
  let timer = null;
  let stopped = false;
  let mismatched = false;

  // Resolves true when loaded, false when it can't be used yet; throws IssuerMismatch.
  async function attempt() {
    let document;
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        log(`Entra discovery could not be loaded (HTTP ${response.status}); retrying in ${retryMs / 1000} s`);
        return false;
      }
      document = await response.json();
    } catch (error) {
      log(`Entra discovery could not be loaded (${error?.name ?? "error"}); retrying in ${retryMs / 1000} s`);
      return false;
    }
    mismatched = document?.issuer !== expectedIssuer;
    if (mismatched) throw new IssuerMismatch(typeof document?.issuer === "string" ? document.issuer.slice(0, 200) : "none", expectedIssuer);
    const endpoints = {
      issuer: document.issuer,
      authorizationEndpoint: httpsUrl(document.authorization_endpoint),
      tokenEndpoint: httpsUrl(document.token_endpoint),
      jwksUri: httpsUrl(document.jwks_uri),
    };
    if (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint || !endpoints.jwksUri) {
      log(`Entra discovery is missing an https endpoint; retrying in ${retryMs / 1000} s`);
      return false;
    }
    loaded = endpoints;
    log(`Entra discovery loaded: issuer ${endpoints.issuer}`);
    return true;
  }

  function retryLater() {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        if (!(await attempt())) retryLater();
      } catch (error) {
        log(error.message);
        retryLater();
      }
    }, retryMs);
    timer.unref?.();
  }

  return {
    async start() {
      if (!(await attempt())) retryLater();
    },
    ready: () => loaded !== null,
    mismatch: () => mismatched,
    get() {
      if (!loaded) throw new Error("the Ouro tenant's discovery document has not loaded yet");
      return loaded;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// The invite cookie: the sealed SHA-256 of an invite token, set by GET /invite/<token>, read at the callback.
export const INVITE_COOKIE = "__Host-desk-invite";
const MAX_INVITE_COOKIE_SEC = 24 * 3600;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const NO_REFERRER = { "referrer-policy": "no-referrer" };

// GET /invite/<token> and GET /invite. `land(token)` checks that the invite exists, is unexpired and unused, and
// sets the invite cookie, living until the invite expires and at most 24 hours (SameSite=Lax, because it must ride
// the redirect back from ciamlogin.com); then the browser goes to the token-free /invite page, so the token leaves
// the address bar and history. Neither page is ever sent with a referrer, and neither echoes the token.
export function createInvites({ key, keys, store, issuer, now = Date.now, log = stderrLog }) {
  const { sealed } = sealer({ key, keys, now });
  return {
    async land(token) {
      if (typeof token !== "string" || !INVITE_TOKEN.test(token)) {
        log("invite refused: invalid_invite");
        return { ...inviteInvalidPage(), headers: NO_REFERRER };
      }
      const tokenHash = hashToken(token);
      let invite;
      try {
        invite = await store.getInvite(tokenHash);
      } catch (error) {
        log(`invite refused: store_unavailable (${error?.name ?? "error"})`);
        return { ...signInUnavailablePage(), headers: NO_REFERRER };
      }
      const remainingSec = invite ? Math.floor((invite.expiresAt - now()) / 1000) : 0;
      if (!invite || invite.redeemed || remainingSec <= 0) {
        log("invite refused: invalid_invite");
        return { ...inviteInvalidPage(), headers: NO_REFERRER };
      }
      const lifeSec = Math.min(remainingSec, MAX_INVITE_COOKIE_SEC);
      log(`invite opened: account ${invite.accountId}`);
      return { redirectTo: "/invite", headers: NO_REFERRER, setCookies: [hostCookie(INVITE_COOKIE, sealed("invite", { tokenHash }, lifeSec), lifeSec)] };
    },
    page: () => ({ ...invitePage({ issuer }), headers: NO_REFERRER }),
  };
}

// A binding that can't be read as one this gateway accepts (a hosted binding, say) is no binding; a store that
// can't answer is an outage, and throws.
async function bindingOf(store, accountId) {
  try {
    return await store.getBinding(accountId);
  } catch (error) {
    if (error?.name === "StoreError") throw error;
    return null;
  }
}

// Whether a signed-in account may have a code: its Desk access is on and its binding names this gateway's desk.
// Returns the page that refuses it, or null. Throws when the store can't answer. Shared by the Ouro tenant's
// sign-in and the GitHub fallback.
export async function admissionRefusal({ store, accountId, repo, clientId, log = stderrLog }) {
  const account = await store.getAccount(accountId);
  if (!account?.deskAccess) {
    log(`sign-in refused: access_off account ${accountId} client ${clientId}`);
    return accessOffPage();
  }
  const binding = await bindingOf(store, accountId);
  if (binding?.kind !== "github" || binding.repo !== repo) {
    log(`sign-in refused: no_desk account ${accountId} client ${clientId}`);
    return noDeskPage();
  }
  return null;
}

// `key` or `keys` is the signing-key ring the provider uses. `discovery` is createDiscovery's; `verifier` defaults
// to an ID-token verifier built from it once it has loaded. `store` is the accounts store (findIdentity,
// redeemInvite, getAccount, getBinding). `repo` is the one desk this gateway serves (DESK_REPO). `now()` is the
// clock in milliseconds.
export function createEntraSignIn({
  key,
  keys,
  discovery,
  tenantId,
  clientId,
  clientSecret,
  callbackUrl,
  verifier,
  cookies,
  store,
  repo,
  fetch = globalThis.fetch,
  timeoutMs = TOKEN_EXCHANGE_TIMEOUT_MS,
  now = Date.now,
  log = stderrLog,
}) {
  for (const [name, value] of Object.entries({ tenantId, clientId, clientSecret, callbackUrl, repo })) {
    if (typeof value !== "string" || value === "") throw new Error(`createEntraSignIn needs ${name}`);
  }
  const { sealed, unsealed } = sealer({ key, keys, now });
  const signins = cookies ?? createSigninCookies({ key, keys, now });
  let idTokens = verifier ?? null;
  const verifierNow = () =>
    (idTokens ??= createIdTokenVerifier({ issuer: discovery.get().issuer, clientId, tenantId, jwksUri: discovery.get().jwksUri, fetch, now }));

  const inviteFrom = (jar) => {
    const invite = unsealed("invite", jar[INVITE_COOKIE]);
    return typeof invite?.tokenHash === "string" ? invite.tokenHash : null;
  };

  // The ID token for `code`, or null when the tenant didn't give one.
  async function exchange(code, codeVerifier, clientIdForLog) {
    let response;
    try {
      response = await fetch(discovery.get().tokenEndpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(timeoutMs),
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl,
          code_verifier: codeVerifier,
          scope: "openid profile",
        }).toString(),
      });
    } catch (error) {
      log(`sign-in failed: entra_token_exchange (${error?.name ?? "error"}) client ${clientIdForLog}`);
      return null;
    }
    // The body is read under the same deadline; a body cut off counts as no ID token.
    let grant = {};
    let failure = `HTTP ${response.status}`;
    if (response.ok) {
      try {
        grant = await response.json();
      } catch (error) {
        failure = error?.name ?? "error";
      }
    }
    if (typeof grant?.id_token !== "string") {
      log(`sign-in failed: entra_token_exchange (${failure}) client ${clientIdForLog}`);
      return null;
    }
    return grant.id_token;
  }

  // The account for this identity, redeeming the browser's invite when it is new. Returns `{ accountId, redeemed }`
  // or `{ refusal }` (a page).
  async function accountFor({ tid, oid }, jar, clientIdForLog) {
    const known = await store.findIdentity(tid, oid);
    // An invite cookie left in a browser whose identity already has an account is dropped, so nobody signing in
    // later in that browser as a new identity can redeem it.
    if (known !== null) return { accountId: known, redeemed: false, clearInvite: inviteFrom(jar) !== null };
    const tokenHash = inviteFrom(jar);
    if (!tokenHash) {
      log(`sign-in refused: not_invited client ${clientIdForLog}`);
      return { refusal: inviteOnlyPage() };
    }
    const result = await store.redeemInvite({ tokenHash, tid, oid, now: now() });
    if (result.refused === "identity_has_account") {
      // Mapped by a concurrent sign-in of the same identity.
      const mapped = await store.findIdentity(tid, oid);
      if (mapped !== null) return { accountId: mapped, redeemed: false, clearInvite: true };
    }
    if (result.refused) {
      log(`sign-in refused: invite_${result.refused} client ${clientIdForLog}`);
      return { refusal: inviteRefusedPage(), clearInvite: true };
    }
    log(`invite redeemed: account ${result.accountId}`);
    return { accountId: result.accountId, redeemed: true };
  }

  return {
    // `pending` is the client's approved request (clientId, redirectUri, codeChallenge, state, scopes, aud);
    // `jar` the browser's cookies. Returns `{ redirectTo, setCookies }` or a page.
    begin(pending, jar = {}) {
      if (!discovery.ready()) {
        log(`sign-in refused: discovery_not_ready client ${pending?.clientId}`);
        return startingUpPage();
      }
      const { stateId, challenge, nonce, setCookies } = signins.begin(jar);
      const { exp: _exp, ...request } = pending;
      const url = new URL(discovery.get().authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: callbackUrl,
        response_mode: "query",
        scope: "openid profile",
        state: sealed(STATE_KIND, { ...request, stateId }, TTL.pending),
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return { redirectTo: url.href, setCookies };
    },

    // Returns `{ redirectTo, clearCookies }` to send the browser back to the client, or `{ status, html,
    // clearCookies }` for a page shown instead.
    async callback({ code, state, error, cookies: jar = {} }) {
      const pending = unsealed(STATE_KIND, state);
      if (!pending || typeof pending.stateId !== "string") {
        log("sign-in refused: invalid_state");
        return { ...startAgainPage(), clearCookies: [] };
      }
      const clearCookies = [signins.clear(pending.stateId)];
      const signin = signins.take(pending.stateId, jar);
      if (!signin) {
        log(`sign-in refused: signin_cookie_missing client ${pending.clientId}`);
        return { ...startAgainPage(), clearCookies };
      }
      const back = new URL(pending.redirectUri);
      if (pending.state !== undefined) back.searchParams.set("state", pending.state);
      if (error || !code) {
        log(`sign-in refused: access_denied by Entra client ${pending.clientId}`);
        back.searchParams.set("error", "access_denied");
        return { redirectTo: back.href, clearCookies };
      }
      if (!discovery.ready()) {
        log(`sign-in refused: discovery_not_ready client ${pending.clientId}`);
        return { ...signInUnavailablePage(), clearCookies };
      }

      const idToken = await exchange(code, signin.verifier, pending.clientId);
      if (!idToken) return { ...page(502, "Ouro sign-in did not confirm who signed in. Start again from Claude."), clearCookies };
      let identity;
      try {
        identity = await verifierNow().verify(idToken, { nonce: signin.nonce });
      } catch (refusal) {
        log(`sign-in refused: invalid_id_token (${refusal?.reason ?? "error"}) client ${pending.clientId}`);
        return { ...page(400, "Ouro sign-in could not be confirmed. Start again from Claude."), clearCookies };
      }
      const authTime = Math.floor(now() / 1000);

      let accountId;
      try {
        const found = await accountFor(identity, jar, pending.clientId);
        if (found.clearInvite || found.redeemed) clearCookies.push(hostCookie(INVITE_COOKIE, "", 0));
        if (found.refusal) return { ...found.refusal, clearCookies };
        accountId = found.accountId;
        const refusal = await admissionRefusal({ store, accountId, repo, clientId: pending.clientId, log });
        if (refusal) return { ...refusal, clearCookies };
      } catch (failure) {
        log(`sign-in failed: store_unavailable (${failure?.name ?? "error"}) client ${pending.clientId}`);
        return { ...signInUnavailablePage(), clearCookies };
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
            accountId,
            authTime,
            aud: pending.aud,
          },
          TTL.code,
        ),
      );
      log(`sign-in: account ${accountId} client ${pending.clientId}`);
      return { redirectTo: back.href, clearCookies };
    },
  };
}

const text = (value) => (typeof value === "string" ? value : undefined);

// The Express route for the tenant's redirect back to the gateway. An unexpected error is logged by its name
// only: its message could carry a value from the request.
export function entraCallbackHandler(entra, { log = stderrLog } = {}) {
  return async (req, res) => {
    res.setHeader("cache-control", "no-store");
    try {
      const outcome = await entra.callback({
        code: text(req.query.code),
        state: text(req.query.state),
        error: text(req.query.error),
        cookies: parseCookies(req.headers.cookie),
      });
      for (const header of outcome.clearCookies ?? []) res.append("set-cookie", header);
      if (outcome.redirectTo) return res.redirect(302, outcome.redirectTo);
      sendPage(res, outcome);
    } catch (error) {
      log(`sign-in failed: entra_callback_error (${typeof error?.name === "string" && /^\w{1,64}$/.test(error.name) ? error.name : "error"})`);
      sendPage(res, page(502, "Sign-in failed while talking to Ouro sign-in. Start again from Claude."));
    }
  };
}

// The Express routes GET /invite/:token and GET /invite.
export function inviteHandlers(invites) {
  return {
    async landing(req, res) {
      res.setHeader("cache-control", "no-store");
      const outcome = await invites.land(text(req.params.token));
      if (!outcome.redirectTo) return sendPage(res, outcome);
      res.set(outcome.headers);
      for (const header of outcome.setCookies) res.append("set-cookie", header);
      res.redirect(303, outcome.redirectTo);
    },
    page(_req, res) {
      sendPage(res, invites.page());
    },
  };
}
