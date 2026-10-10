// The gateway's OAuth authorization server for Claude, as the MCP SDK's
// OAuthServerProvider. The SDK's router serves the endpoints, checks PKCE and
// client secrets; this provider issues and checks sealed client ids, codes and
// tokens, asks the person to approve each client, and hands identity to
// GitHub sign-in.
//
// Everything is stateless. Two limits follow, accepted for v0 (one user,
// short-lived codes, 30-day refresh tokens, key rotation revokes everything):
// a code can be redeemed more than once within its minute, and a rotated
// refresh token stays usable until it expires. v1 adds a per-login
// not-before epoch.
import { randomUUID } from "node:crypto";
import { CustomOAuthError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { seal, unseal, derive, TTL } from "./seal.js";
import { createGitHubSignIn } from "./github.js";
import { consentPage, page, sendPage } from "./pages.js";
import { createRedirectPolicy } from "./redirects.js";
import { createClientDocuments } from "./client-document.js";

const stderrLog = (message) => process.stderr.write(`desk-hosted auth: ${message}\n`);

// `log` receives one line per refused sign-in or token request. Lines carry
// the error code and client id only, never a token, code, secret or GitHub
// response.
//
// `resource` is the MCP endpoint's URL, the one audience every code and token
// is sealed for. `redirects` is the redirect policy (see redirects.js); by
// default Claude's callbacks, ChatGPT's and loopback. `clientDocuments`
// reads clients whose id is an https URL (see client-document.js).
export function createProvider({
  key,
  issuer,
  github,
  allowedLogins,
  resource,
  redirects = createRedirectPolicy(),
  log = stderrLog,
  clientDocuments = createClientDocuments({ redirects, log }),
}) {
  if (!key) throw new Error("createProvider needs a signing key");
  if (!resource) throw new Error("createProvider needs the MCP resource URL");
  const audience = new URL(resource).href;
  const signIn = createGitHubSignIn({
    key,
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    callbackUrl: new URL("/oauth/github/callback", issuer).href,
    allowedLogins,
    fetch: github.fetch,
    log,
  });

  const clientSecret = (clientId) => derive("client_secret", clientId, { key });

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
      const clientId = seal("client", { redirect_uris: redirectUris, token_endpoint_auth_method, client_name, nonce: randomUUID() }, { key });
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
      const registration = unseal("client", clientId, { key });
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

  function refuseGrant(client, message) {
    log(`token refused: invalid_grant client ${client.client_id}`);
    return new InvalidGrantError(message);
  }

  // A client may name the resource it wants a token for (RFC 8707). There is
  // only one, so naming it changes nothing and naming any other is refused.
  // The SDK hands it over as a URL already; `href` compares the normalized
  // form, so an upper-case host or an explicit :443 still matches.
  function checkResource(requested, client, step) {
    if (requested !== undefined && new URL(requested).href !== audience) {
      log(`${step} refused: invalid_target client ${client.client_id}`);
      throw new InvalidTargetError(`This server only issues tokens for ${audience}.`);
    }
  }

  // A code or token sealed before v1a has no audience; it is taken as this
  // resource's until it expires. One sealed for any other audience (the
  // gateway's public URL moved) is refused.
  const forThisResource = (claims) => claims.aud === undefined || claims.aud === audience;

  // Unseals a code or refresh token issued to this client, or refuses it.
  function grantFor(kind, client, token) {
    const grant = unseal(kind, token, { key });
    if (!grant || grant.clientId !== client.client_id || !allowedLogins.includes(grant.login) || !forThisResource(grant)) {
      throw refuseGrant(client, `The ${kind === "code" ? "authorization code" : "refresh token"} is not valid.`);
    }
    return grant;
  }

  function issueTokens({ clientId, scopes = [], login, userId, name }) {
    // Each token gets its own id, so a rotation never hands back the same
    // token. Every new token carries the audience, whatever the grant it came
    // from carried.
    const claims = { clientId, scopes, login, userId, name, aud: audience };
    return {
      access_token: seal("access", { ...claims, jti: randomUUID() }, { key, ttlSec: TTL.access }),
      refresh_token: seal("refresh", { ...claims, jti: randomUUID() }, { key, ttlSec: TTL.refresh }),
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
      const consent = seal("consent", { clientId: client.client_id, redirectUri, codeChallenge, state, scopes, aud: audience }, { key, ttlSec: TTL.consent });
      // A document's client_name is whatever its author chose; the host of
      // its id is the part they had to control, so the page shows it too.
      const clientHost = client.client_id.startsWith("https://") ? new URL(client.client_id).host : undefined;
      sendPage(res, consentPage({ clientName: client.client_name, clientHost, redirectUri, consent }));
    },

    // The Approve form's POST. Returns `{ redirectTo }` (GitHub sign-in,
    // carrying the request as a sealed pending state) or a page to show.
    approve(consent) {
      const request = unseal("consent", consent, { key });
      if (!request) {
        log("consent refused: invalid_consent");
        return page(400, "This sign-in link has expired or is not valid. Start again from Claude.");
      }
      const { exp: _exp, ...pending } = request;
      return { redirectTo: signIn.authorizeUrl(seal("pending", pending, { key, ttlSec: TTL.pending })) };
    },

    async challengeForAuthorizationCode(client, code) {
      return grantFor("code", client, code).codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, requested) {
      checkResource(requested, client, "token");
      const grant = grantFor("code", client, code);
      // The SDK always fixes a redirect URI at authorization, so the
      // exchange must name the same one.
      if (redirectUri !== grant.redirectUri) {
        throw refuseGrant(client, "redirect_uri is missing or does not match the authorization request.");
      }
      return issueTokens(grant);
    },

    async exchangeRefreshToken(client, refreshToken, _scopes, requested) {
      checkResource(requested, client, "token");
      return issueTokens(grantFor("refresh", client, refreshToken));
    },

    async verifyAccessToken(token) {
      const access = unseal("access", token, { key });
      if (!access || !allowedLogins.includes(access.login) || !forThisResource(access)) {
        log("access token refused: invalid_token");
        throw new InvalidTokenError("The access token is not valid.");
      }
      return {
        token,
        clientId: access.clientId,
        scopes: access.scopes ?? [],
        expiresAt: access.exp,
        extra: { login: access.login, userId: access.userId, name: access.name },
      };
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
    const outcome = provider.approve(typeof req.body?.consent === "string" ? req.body.consent : undefined);
    if (outcome.redirectTo) {
      res.setHeader("cache-control", "no-store");
      return res.redirect(303, outcome.redirectTo);
    }
    sendPage(res, outcome);
  };
}
