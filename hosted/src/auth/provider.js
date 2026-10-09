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
import { CustomOAuthError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { seal, unseal, derive, TTL } from "./seal.js";
import { createGitHubSignIn } from "./github.js";
import { consentPage, page, sendPage } from "./pages.js";

const CLAUDE_CALLBACKS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function isAllowedRedirect(uri) {
  if (CLAUDE_CALLBACKS.has(uri)) return true;
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;
}

const stderrLog = (message) => process.stderr.write(`desk-hosted auth: ${message}\n`);

// `log` receives one line per refused sign-in or token request. Lines carry
// the error code and client id only, never a token, code, secret or GitHub
// response.
export function createProvider({ key, issuer, github, allowedLogins, log = stderrLog }) {
  if (!key) throw new Error("createProvider needs a signing key");
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
      if (!redirectUris.length || !redirectUris.every(isAllowedRedirect)) {
        log("registration refused: invalid_redirect_uri");
        throw new CustomOAuthError("invalid_redirect_uri", "Redirect URIs must be Claude's callback or a loopback address.");
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

    getClient(clientId) {
      const registration = unseal("client", clientId, { key });
      if (!registration) return undefined;
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

  // Unseals a code or refresh token issued to this client, or refuses it.
  function grantFor(kind, client, token) {
    const grant = unseal(kind, token, { key });
    if (!grant || grant.clientId !== client.client_id || !allowedLogins.includes(grant.login)) {
      throw refuseGrant(client, `The ${kind === "code" ? "authorization code" : "refresh token"} is not valid.`);
    }
    return grant;
  }

  function issueTokens({ clientId, scopes = [], login, userId, name }) {
    // Each token gets its own id, so a rotation never hands back the same token.
    const claims = { clientId, scopes, login, userId, name };
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

    // Every client registers itself, so the person approves each sign-in
    // on a page that names the client and where its code will go. The
    // request travels sealed in the Approve form; nothing is stored.
    async authorize(client, { state, scopes, redirectUri, codeChallenge }, res) {
      const consent = seal("consent", { clientId: client.client_id, redirectUri, codeChallenge, state, scopes }, { key, ttlSec: TTL.consent });
      sendPage(res, consentPage({ clientName: client.client_name, redirectUri, consent }));
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

    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri) {
      const grant = grantFor("code", client, code);
      // The SDK always fixes a redirect URI at authorization, so the
      // exchange must name the same one.
      if (redirectUri !== grant.redirectUri) {
        throw refuseGrant(client, "redirect_uri is missing or does not match the authorization request.");
      }
      return issueTokens(grant);
    },

    async exchangeRefreshToken(client, refreshToken) {
      return issueTokens(grantFor("refresh", client, refreshToken));
    },

    async verifyAccessToken(token) {
      const access = unseal("access", token, { key });
      if (!access || !allowedLogins.includes(access.login)) {
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

// The Express route for the consent page's Approve form.
export function consentHandler(provider) {
  return (req, res) => {
    const outcome = provider.approve(typeof req.body?.consent === "string" ? req.body.consent : undefined);
    if (outcome.redirectTo) {
      res.setHeader("cache-control", "no-store");
      return res.redirect(303, outcome.redirectTo);
    }
    sendPage(res, outcome);
  };
}
