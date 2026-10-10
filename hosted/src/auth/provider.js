// The gateway's OAuth authorization server for Claude, as the MCP SDK's
// OAuthServerProvider. The SDK's router serves the endpoints, checks PKCE and
// client secrets; this provider issues and checks sealed client ids, codes and
// tokens, asks the person to approve each client, and hands identity to
// GitHub sign-in.
//
// Everything is stateless. Two limits follow, accepted for v0 (one user,
// short-lived codes, 30-day refresh tokens):
// a code can be redeemed more than once within its minute, and a rotated
// refresh token stays usable until it expires. v1 adds a per-login
// not-before epoch.
//
// It runs in one of two ways. Without Ouro accounts (no `accounts`), as the
// gateway always has: GitHub sign-in for the logins in `allowedLogins`, and
// tokens that carry the GitHub login. With Ouro accounts (spec items 9 to 13):
//
// - Approve sends the browser to the Ouro tenant (`entra`), or to the GitHub
//   fallback when the consent form says `method=github` and the fallback is on
//   (`github.signIn`).
// - Codes and tokens carry `accountId` and `authTime`, the time (seconds since
//   the epoch, like `exp`) our callback accepted a fresh sign-in. A refresh
//   more than 30 days after `authTime` is refused, so every client signs in
//   again at least monthly; refreshed tokens keep their `authTime`.
// - Legacy tokens, sealed by the gateway before accounts with a GitHub `login`
//   and `userId`, map to an account through `legacy.byUserId` only when both
//   match, until `legacy.cutoff`. Tokens refreshed from them keep v1a's claims
//   (`clientId`, `login`, `userId`, `scopes`) so a rolled-back gateway still
//   accepts them, and add `accountId` and `legacy: true` with no `authTime`, so
//   the cutoff, not the lifetime, governs them.
// - Every code exchange, refresh and access token checks the account through
//   the account cache (`accounts`): Desk access off or no account refuses;
//   a store that can't answer while the cached row is older than a minute
//   answers server_error, not a refusal that would send the client to a
//   sign-in that can't succeed either.
import { randomUUID } from "node:crypto";
import { CustomOAuthError, InvalidGrantError, InvalidTargetError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { seal, unseal, derive, TTL } from "./seal.js";
import { createGitHubSignIn, githubSignInOffPage } from "./github.js";
import { admissionRefusal } from "./entra.js";
import { createSigninCookies, parseCookies } from "./signin-cookie.js";
import { StoreUnavailable } from "../accounts/cache.js";
import { consentPage, page, sendPage, signInUnavailablePage } from "./pages.js";
import { createRedirectPolicy } from "./redirects.js";
import { createClientDocuments } from "./client-document.js";

// The longest requested resource a refusal log line repeats.
const MAX_LOGGED_RESOURCE = 200;

// How long after a sign-in its tokens can still be refreshed (spec item 12), in seconds.
export const SIGN_IN_LIFETIME_SEC = 30 * 24 * 3600;

const stderrLog = (message) => process.stderr.write(`desk-hosted auth: ${message}\n`);

// `log` receives one line per refused sign-in or token request. Lines carry
// the error code and client id only, never a token, code, secret or GitHub
// response.
//
// `resource` is the MCP endpoint's URL, the one audience every code and token
// is sealed for. `redirects` is the redirect policy (see redirects.js); by
// default Claude's callbacks, ChatGPT's and loopback. `clientDocuments`
// reads clients whose id is an https URL (see client-document.js).
//
// `signingKeys` is the signing-key ring, `[{ key, until? }]`: codes and tokens
// are sealed with the first and accepted under any key not past its `until`
// (see seal.js). `clientKey` seals client ids and derives client secrets; it
// is kept apart from the signing keys so a rotation leaves every registered
// client working. `key` alone means one signing key that is also the client
// key, which is how the gateway ran before the ring. `now` is the clock, in
// milliseconds, for tests.
//
// With Ouro accounts: `accounts` is the account cache (cache.js), `store` the
// accounts store and `repo` this gateway's desk (both for the GitHub
// fallback's admission check), `entra` the tenant's sign-in (entra.js),
// `github.signIn` whether the GitHub fallback is on, and `legacy` is
// `{ byUserId: Map<GitHub user id, { login, accountId }>, cutoff: Date | null }`;
// the GitHub fallback admits exactly the ids in `byUserId`. `allowedLogins` is
// then unused.
export function createProvider({
  key,
  signingKeys = key ? [{ key }] : [],
  clientKey = key,
  now = Date.now,
  issuer,
  github,
  allowedLogins = [],
  resource,
  redirects = createRedirectPolicy(),
  log = stderrLog,
  clientDocuments = createClientDocuments({ redirects, log, ownHost: new URL(issuer).hostname }),
  accounts,
  store,
  repo,
  entra,
  legacy = { byUserId: new Map(), cutoff: null },
}) {
  if (!signingKeys[0]?.key) throw new Error("createProvider needs a signing key");
  if (!clientKey) throw new Error("createProvider needs a client key");
  const signing = signingKeys[0].key;
  const sealed = (kind, payload, ttlSec) => seal(kind, payload, { key: signing, ttlSec, now: now() });
  const unsealed = (kind, token) => unseal(kind, token, { keys: signingKeys, now: now() });
  if (!resource) throw new Error("createProvider needs the MCP resource URL");
  const audience = new URL(resource).href;
  const withAccounts = Boolean(accounts);
  if (withAccounts && (!store || !repo)) throw new Error("createProvider with accounts needs the accounts store and the desk's repo");
  const githubFallbackOn = withAccounts && github.signIn === true;
  const signIn = createGitHubSignIn({
    sealed,
    unsealed,
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    callbackUrl: new URL("/oauth/github/callback", issuer).href,
    allowedLogins,
    fetch: github.fetch,
    log,
    fallback: withAccounts
      ? {
          enabled: githubFallbackOn,
          accountFor: (userId) => legacy.byUserId.get(userId)?.accountId,
          cookies: createSigninCookies({ keys: signingKeys, now }),
          now,
          async admit(accountId, clientId) {
            try {
              return await admissionRefusal({ store, accountId, repo, clientId, log });
            } catch (error) {
              log(`sign-in failed: store_unavailable (${error?.name ?? "error"}) client ${clientId}`);
              return signInUnavailablePage();
            }
          },
        }
      : undefined,
  });

  const clientSecret = (clientId) => derive("client_secret", clientId, { key: clientKey });

  const clientsStore = {
    // The SDK generates an id and secret before calling this; both are
    // replaced. The id seals the client's registration (never its secret) and
    // the secret is derived from the id, so neither needs storing. A random
    // nonce makes every registration's id and secret its own, even for the
    // same metadata.
    registerClient(client) {
      const { redirect_uris: redirectUris, token_endpoint_auth_method, client_name } = client;
      if (!redirectUris.length || !redirectUris.every(redirects.allows)) {
        log("registration refused: invalid_redirect_uri");
        throw new CustomOAuthError("invalid_redirect_uri", "Redirect URIs must be a configured callback, ChatGPT's connector callback or a loopback address.");
      }
      const clientId = seal("client", { redirect_uris: redirectUris, token_endpoint_auth_method, client_name, nonce: randomUUID() }, { key: clientKey });
      const registered = { ...client, client_id: clientId };
      if (token_endpoint_auth_method === "none") {
        delete registered.client_secret;
        delete registered.client_secret_expires_at;
      } else {
        registered.client_secret = clientSecret(clientId);
        registered.client_secret_expires_at = 0;
      }
      return registered;
    },

    // An https client id names the client's metadata document; any other is
    // one this gateway sealed at registration. A sealed id never expires, so
    // its redirects are checked again on every use: removing one from
    // DESK_REDIRECTS then also shuts out the clients that registered it
    // before. The SDK awaits this.
    getClient(clientId) {
      if (typeof clientId === "string" && clientId.startsWith("https://")) return clientDocuments.get(clientId);
      const registration = unseal("client", clientId, { key: clientKey });
      if (!registration) return undefined;
      if (!registration.redirect_uris?.length || !registration.redirect_uris.every(redirects.allows)) {
        log("client refused: invalid_redirect_uri");
        return undefined;
      }
      const { nonce: _nonce, ...metadata } = registration;
      const client = { ...metadata, client_id: clientId };
      if (registration.token_endpoint_auth_method !== "none") {
        client.client_secret = clientSecret(clientId);
        client.client_secret_expires_at = 0;
      }
      return client;
    },
  };

  function refuseGrant(client, message, reason) {
    log(`token refused: invalid_grant client ${client.client_id}${reason ? ` (${reason})` : ""}`);
    return new InvalidGrantError(message);
  }

  // A client may name the resource it wants a token for (RFC 8707). There is
  // only one, so naming it changes nothing and naming any other is refused.
  // The SDK hands it over as a URL already; `href` compares the normalized
  // form, so an upper-case host or an explicit :443 still matches.
  // The refusal logs the resource asked for, so a client sending an
  // unexpected form can be diagnosed from the log. It is a public URL, not a
  // secret; the SDK has parsed it, so it holds no line breaks, and an
  // overlong one is left out.
  function checkResource(requested, client, step) {
    if (requested !== undefined && new URL(requested).href !== audience) {
      const href = new URL(requested).href;
      log(`${step} refused: invalid_target client ${client.client_id}${href.length <= MAX_LOGGED_RESOURCE ? ` resource ${href}` : ""}`);
      throw new InvalidTargetError(`This server only issues tokens for ${audience}.`);
    }
  }

  // A code or token sealed before v1a has no audience; it is taken as this
  // resource's until it expires. One sealed for any other audience (the
  // gateway's public URL moved) is refused.
  const forThisResource = (claims) => claims.aud === undefined || claims.aud === audience;

  // Whose a code or token is, with Ouro accounts: `{ accountId, authTime }`
  // for one minted by a sign-in, `{ accountId, legacy: true }` for a legacy
  // one that maps to an account, or `{ refused: reason }`.
  function ownerOf(grant) {
    if (grant.legacy === true || grant.accountId === undefined) {
      const mapped = Number.isSafeInteger(grant.userId) ? legacy.byUserId.get(grant.userId) : undefined;
      // GitHub logins are case-insensitive, so the mapping's login matches in any case.
      if (!mapped || typeof grant.login !== "string" || mapped.login.toLowerCase() !== grant.login.toLowerCase()) return { refused: "legacy_unmapped" };
      if (grant.accountId !== undefined && grant.accountId !== mapped.accountId) return { refused: "legacy_unmapped" };
      if (legacy.cutoff && now() >= legacy.cutoff.getTime()) return { refused: "legacy_cutoff" };
      return { accountId: mapped.accountId, legacy: true };
    }
    if (typeof grant.accountId !== "string" || grant.accountId === "" || !Number.isSafeInteger(grant.authTime)) return { refused: "malformed" };
    return { accountId: grant.accountId, authTime: grant.authTime };
  }

  // Whether the account may still use Desk: throws `refusal(reason)` when its
  // access is off or it is gone, and ServerError when the store can't answer
  // and the cached row is too old to trust.
  async function checkAccount(accountId, refusal) {
    let row;
    try {
      row = await accounts.account(accountId);
    } catch (error) {
      if (!(error instanceof StoreUnavailable)) throw refusal("account_unreadable");
      log(`account check failed: store_unavailable account ${accountId}`);
      throw new ServerError("The accounts store can't confirm this account right now. Try again shortly.");
    }
    if (!row) throw refusal(`no_account account ${accountId}`);
    if (!row.deskAccess) throw refusal(`access_off account ${accountId}`);
  }

  // Unseals a code or refresh token issued to this client, or refuses it.
  // Returns `{ grant, owner }`; `owner` is null without accounts.
  function grantFor(kind, client, token) {
    const invalid = (reason) => refuseGrant(client, `The ${kind === "code" ? "authorization code" : "refresh token"} is not valid.`, reason);
    const grant = unsealed(kind, token);
    if (!grant || grant.clientId !== client.client_id || !forThisResource(grant)) throw invalid();
    if (!withAccounts) {
      if (!allowedLogins.includes(grant.login)) throw invalid();
      return { grant, owner: null };
    }
    const owner = ownerOf(grant);
    if (owner.refused) throw invalid(owner.refused);
    if (owner.authTime !== undefined && Math.floor(now() / 1000) - owner.authTime > SIGN_IN_LIFETIME_SEC) throw invalid("lifetime");
    return { grant, owner };
  }

  // A grant the client may redeem: sealed for it and, with accounts, for an
  // account that may still use Desk.
  async function checkOwner(found, client) {
    if (found.owner) await checkAccount(found.owner.accountId, (reason) => refuseGrant(client, "The account behind this grant can't use Desk.", reason));
  }

  async function usableGrant(kind, client, token) {
    const found = grantFor(kind, client, token);
    await checkOwner(found, client);
    return found;
  }

  function issueTokens({ grant, owner }) {
    const { clientId, scopes = [], login, userId, name } = grant;
    // Each token gets its own id, so a rotation never hands back the same
    // token. Every new token carries the audience, whatever the grant it came
    // from carried.
    let claims;
    if (!owner) claims = { clientId, scopes, login, userId, name, aud: audience };
    else if (owner.legacy) claims = { clientId, scopes, login, userId, name, accountId: owner.accountId, legacy: true, aud: audience };
    else claims = { clientId, scopes, accountId: owner.accountId, authTime: owner.authTime, aud: audience };
    return {
      access_token: sealed("access", { ...claims, jti: randomUUID() }, TTL.access),
      refresh_token: sealed("refresh", { ...claims, jti: randomUUID() }, TTL.refresh),
      token_type: "bearer",
      expires_in: TTL.access,
    };
  }

  return {
    clientsStore,
    githubCallback: signIn.githubCallback,
    log,

    // Every client registers itself, so the person approves each sign-in
    // on a page that names the client and where its code will go. The
    // request travels sealed in the Approve form; nothing is stored.
    // A wrong `resource` is thrown before the page; the SDK sends it back to
    // the client's redirect as invalid_target.
    async authorize(client, { state, scopes, redirectUri, codeChallenge, resource: requested }, res) {
      checkResource(requested, client, "authorize");
      const consent = sealed("consent", { clientId: client.client_id, redirectUri, codeChallenge, state, scopes, aud: audience }, TTL.consent);
      // A document's client_name is whatever its author chose; the host of
      // its id is the part they had to control, so the page shows it too.
      const clientHost = client.client_id.startsWith("https://") ? new URL(client.client_id).host : undefined;
      const signInOptions = withAccounts ? { entra: Boolean(entra), github: githubFallbackOn } : undefined;
      sendPage(res, consentPage({ clientName: client.client_name, clientHost, redirectUri, consent, signIn: signInOptions }));
    },

    // The Approve form's POST. Returns `{ redirectTo, setCookies? }` (sign-in,
    // carrying the request as a sealed pending state) or a page to show.
    // Without accounts it always goes to GitHub. With accounts, `method` (the
    // form's button) picks the Ouro tenant ("entra", also when it is missing)
    // or the GitHub fallback ("github", refused while the fallback is off);
    // `cookies` are the browser's, for the per-sign-in cookie.
    approve(consent, { method, cookies = {} } = {}) {
      const request = unsealed("consent", consent);
      if (!request) {
        log("consent refused: invalid_consent");
        return page(400, "This sign-in link has expired or is not valid. Start again from Claude.");
      }
      const { exp: _exp, ...pending } = request;
      if (!withAccounts) return { redirectTo: signIn.authorizeUrl(sealed("pending", pending, TTL.pending)) };
      const chosen = method === undefined || method === "" ? (entra ? "entra" : "github") : method;
      if (chosen === "entra" && entra) return entra.begin(pending, cookies);
      if (chosen === "github") {
        if (!githubFallbackOn) {
          log(`consent refused: github_signin_off client ${pending.clientId}`);
          return githubSignInOffPage();
        }
        return signIn.begin(pending, cookies);
      }
      log(`consent refused: invalid_method client ${pending.clientId}`);
      return page(400, "This sign-in method isn't available. Start again from Claude.");
    },

    async challengeForAuthorizationCode(client, code) {
      return grantFor("code", client, code).grant.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, requested) {
      checkResource(requested, client, "token");
      const found = grantFor("code", client, code);
      // The SDK always fixes a redirect URI at authorization, so the
      // exchange must name the same one.
      if (redirectUri !== found.grant.redirectUri) {
        throw refuseGrant(client, "redirect_uri is missing or does not match the authorization request.");
      }
      await checkOwner(found, client);
      return issueTokens(found);
    },

    async exchangeRefreshToken(client, refreshToken, _scopes, requested) {
      checkResource(requested, client, "token");
      return issueTokens(await usableGrant("refresh", client, refreshToken));
    },

    async verifyAccessToken(token) {
      const refuse = (reason) => {
        log(`access token refused: invalid_token${reason ? ` (${reason})` : ""}`);
        return new InvalidTokenError("The access token is not valid.");
      };
      const access = unsealed("access", token);
      if (!access || !forThisResource(access)) throw refuse();
      const info = { token, clientId: access.clientId, scopes: access.scopes ?? [], expiresAt: access.exp };
      if (!withAccounts) {
        if (!allowedLogins.includes(access.login)) throw refuse();
        return { ...info, extra: { login: access.login, userId: access.userId, name: access.name } };
      }
      const owner = ownerOf(access);
      if (owner.refused) throw refuse(owner.refused);
      await checkAccount(owner.accountId, refuse);
      return { ...info, extra: { accountId: owner.accountId } };
    },
  };
}

// Whether a POST came from a page on the gateway's own origin. A browser
// sends Sec-Fetch-Site on every request it makes; one that does not falls
// back to Origin, which every browser sends on a cross-origin POST. A request
// with neither is refused.
function fromOwnOrigin(req, issuerOrigin) {
  const site = req.get("sec-fetch-site");
  if (site !== undefined) return site === "same-origin";
  return req.get("origin") === issuerOrigin;
}

// The Express route for the consent page's Approve form. Only the gateway's
// own page may submit it, so another site cannot post a consent it fetched
// and skip the page the person is meant to see.
export function consentHandler(provider, { issuer }) {
  const issuerOrigin = new URL(issuer).origin;
  return (req, res) => {
    if (!fromOwnOrigin(req, issuerOrigin)) {
      provider.log("consent refused: cross_origin");
      return sendPage(res, page(403, "This approval did not come from the Hosted Desk page. Approve on the Hosted Desk page itself, starting again from Claude."));
    }
    const text = (value) => (typeof value === "string" ? value : undefined);
    const outcome = provider.approve(text(req.body?.consent), { method: text(req.body?.method), cookies: parseCookies(req.headers.cookie) });
    if (outcome.redirectTo) {
      res.setHeader("cache-control", "no-store");
      for (const header of outcome.setCookies ?? []) res.append("set-cookie", header);
      return res.redirect(303, outcome.redirectTo);
    }
    sendPage(res, outcome);
  };
}
