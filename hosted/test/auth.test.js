import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { seal, unseal } from "../src/auth/seal.js";
import { createProvider } from "../src/auth/provider.js";
import { githubCallbackHandler } from "../src/auth/github.js";

const KEY = "test-key-0123456789abcdef0123456789abcdef";
const ISSUER = "https://desk.ouro.bot";
const MCP_URL = "https://desk.ouro.bot/mcp";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const GITHUB = { clientId: "Iv1.ouro-desk", clientSecret: "github-app-secret" };

// A stand-in for GitHub's OAuth and REST endpoints. `users` maps a GitHub
// code to the user that signed in with it.
function fakeGitHub(users = { "gh-code": { login: "arimendelow", id: 16390116, name: "Ari Mendelow" } }) {
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push({ url: String(url), init });
    if (String(url) === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(init.body);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.accept, "application/json");
      assert.equal(body.get("client_id"), GITHUB.clientId);
      assert.equal(body.get("client_secret"), GITHUB.clientSecret);
      assert.equal(body.get("redirect_uri"), "https://desk.ouro.bot/oauth/github/callback");
      const code = body.get("code");
      if (!users[code]) return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: `gho_${code}`, token_type: "bearer" });
    }
    if (String(url) === "https://api.github.com/user") {
      const code = init.headers.authorization.replace("Bearer gho_", "");
      return Response.json(users[code]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }
  return { fetch, calls };
}

function makeProvider(github = fakeGitHub()) {
  return createProvider({
    key: KEY,
    issuer: ISSUER,
    github: { ...GITHUB, fetch: github.fetch },
    allowedLogins: ["arimendelow"],
  });
}

// Mounts the SDK's OAuth router with our provider, the GitHub callback and a
// bearer-protected /mcp, the way the gateway will.
async function start(t, github = fakeGitHub()) {
  const provider = makeProvider(github);
  const app = express();
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(ISSUER),
      resourceServerUrl: new URL(MCP_URL),
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  app.get("/oauth/github/callback", githubCallbackHandler(provider));
  app.all(
    "/mcp",
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_URL)) }),
    (req, res) => res.json(req.auth),
  );
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, provider, github };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(base, metadata = {}) {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], ...metadata }),
  });
  return { status: response.status, body: await response.json() };
}

const tokenRequest = (base, params) =>
  fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

// Runs Claude's side of sign-in up to the authorization code: register,
// authorize, then GitHub's redirect back to our callback.
async function signIn(base, { githubCode = "gh-code", metadata } = {}) {
  const client = (await register(base, metadata)).body;
  const { verifier, challenge } = pkce();
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state",
    resource: MCP_URL,
  });
  const toGitHub = await fetch(authorize, { redirect: "manual" });
  assert.equal(toGitHub.status, 302);
  const githubUrl = new URL(toGitHub.headers.get("location"));
  const callback = await fetch(
    `${base}/oauth/github/callback?${new URLSearchParams({ code: githubCode, state: githubUrl.searchParams.get("state") })}`,
    { redirect: "manual" },
  );
  return { client, verifier, githubUrl, callback };
}

async function signInForTokens(base) {
  const { client, verifier, callback } = await signIn(base);
  const code = new URL(callback.headers.get("location")).searchParams.get("code");
  const tokens = await tokenRequest(base, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK,
  });
  assert.equal(tokens.status, 200);
  return { client, tokens: tokens.body };
}

test("seal round-trips a payload of its kind", () => {
  const token = seal("code", { login: "arimendelow" }, { key: KEY, ttlSec: 60 });
  const payload = unseal("code", token, { key: KEY });
  assert.equal(payload.login, "arimendelow");
  assert.equal(typeof payload.exp, "number");
});

test("unseal refuses a tampered token, the wrong kind, the wrong key and an expired token", () => {
  const token = seal("access", { login: "arimendelow" }, { key: KEY, ttlSec: 3600 });
  const [body, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), login: "mallory" })).toString("base64url");
  assert.equal(unseal("access", `${forged}.${signature}`, { key: KEY }), null);
  assert.equal(unseal("access", `${body}.${signature.slice(0, -2)}AA`, { key: KEY }), null);
  assert.equal(unseal("access", `${body}`, { key: KEY }), null);
  assert.equal(unseal("access", "not a token", { key: KEY }), null);
  assert.equal(unseal("refresh", token, { key: KEY }), null);
  assert.equal(unseal("access", token, { key: `${KEY}-other` }), null);
  assert.equal(unseal("access", seal("access", {}, { key: KEY, ttlSec: -1 }), { key: KEY }), null);
});

test("a registered client is recovered from its id, and the id carries no secret", async (t) => {
  const { base, provider } = await start(t);
  const { status, body } = await register(base);
  assert.equal(status, 201);
  assert.ok(body.client_secret);
  assert.equal(body.client_secret_expires_at, 0);
  const decoded = Buffer.from(body.client_id.split(".")[0], "base64url").toString();
  assert.ok(!decoded.includes(body.client_secret));
  const client = await provider.clientsStore.getClient(body.client_id);
  assert.deepEqual(client.redirect_uris, [CLAUDE_CALLBACK]);
  assert.equal(client.client_secret, body.client_secret);
  assert.equal(await provider.clientsStore.getClient("forged"), undefined);
});

test("a public client registers without a secret", async (t) => {
  const { base, provider } = await start(t);
  const { status, body } = await register(base, { token_endpoint_auth_method: "none" });
  assert.equal(status, 201);
  assert.equal(body.client_secret, undefined);
  assert.equal((await provider.clientsStore.getClient(body.client_id)).client_secret, undefined);
});

test("registration refuses any redirect outside Claude and loopback", async (t) => {
  const { base } = await start(t);
  for (const uri of [
    "https://evil.example/cb",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/other",
    "http://claude.ai/api/mcp/auth_callback",
    "https://localhost/cb",
  ]) {
    const { status, body } = await register(base, { redirect_uris: [CLAUDE_CALLBACK, uri] });
    assert.equal(status, 400, uri);
    assert.equal(body.error, "invalid_redirect_uri", uri);
  }
});

test("registration accepts claude.com and loopback redirects on any port", async (t) => {
  const { base } = await start(t);
  for (const uri of ["https://claude.com/api/mcp/auth_callback", "http://localhost:6274/oauth/callback", "http://127.0.0.1:33418/callback"]) {
    const { status, body } = await register(base, { redirect_uris: [uri] });
    assert.equal(status, 201, uri);
    assert.deepEqual(body.redirect_uris, [uri]);
  }
});

test("authorize sends the browser to GitHub with a sealed pending state", async (t) => {
  const { base } = await start(t);
  const { client, githubUrl } = await signIn(base);
  assert.equal(githubUrl.origin + githubUrl.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(githubUrl.searchParams.get("client_id"), GITHUB.clientId);
  assert.equal(githubUrl.searchParams.get("redirect_uri"), "https://desk.ouro.bot/oauth/github/callback");
  const pending = unseal("pending", githubUrl.searchParams.get("state"), { key: KEY });
  assert.equal(pending.clientId, client.client_id);
  assert.equal(pending.redirectUri, CLAUDE_CALLBACK);
  assert.equal(pending.state, "claude-state");
});

test("the full sign-in issues tokens whose access token verifies to the GitHub login", async (t) => {
  const { base, github } = await start(t);
  const { callback, client, verifier } = await signIn(base);
  assert.equal(callback.status, 302);
  const back = new URL(callback.headers.get("location"));
  assert.equal(back.origin + back.pathname, CLAUDE_CALLBACK);
  assert.equal(back.searchParams.get("state"), "claude-state");
  const code = back.searchParams.get("code");

  const wrongVerifier = await tokenRequest(base, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: pkce().verifier,
    redirect_uri: CLAUDE_CALLBACK,
  });
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.body.error, "invalid_grant");

  const { status, body } = await tokenRequest(base, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK,
  });
  assert.equal(status, 200);
  assert.equal(body.token_type, "bearer");
  assert.equal(body.expires_in, 3600);
  assert.ok(body.refresh_token);

  const mcp = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(mcp.status, 200);
  const auth = await mcp.json();
  assert.equal(auth.clientId, client.client_id);
  assert.equal(typeof auth.expiresAt, "number");
  assert.deepEqual(auth.extra, { login: "arimendelow", userId: 16390116, name: "Ari Mendelow" });

  // The GitHub user token is used for /user only and never handed onward.
  assert.deepEqual(github.calls.map((call) => call.url), ["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
  assert.ok(!JSON.stringify(body).includes("gho_"));
});

test("verifyAccessToken returns a numeric expiresAt and refuses a refresh token", async (t) => {
  const { base, provider } = await start(t);
  const { tokens } = await signInForTokens(base);
  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(typeof info.expiresAt, "number");
  assert.ok(info.expiresAt > Date.now() / 1000 + 3500);
  assert.equal(info.token, tokens.access_token);
  await assert.rejects(provider.verifyAccessToken(tokens.refresh_token), { errorCode: "invalid_token" });
  const unauthorized = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${tokens.refresh_token}` } });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /resource_metadata="https:\/\/desk\.ouro\.bot\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("a GitHub login outside the allowed set gets a 403 page and no code", async (t) => {
  const { base } = await start(t, fakeGitHub({ "gh-code": { login: "mallory", id: 1, name: "Mallory" } }));
  const { callback } = await signIn(base);
  assert.equal(callback.status, 403);
  assert.equal(callback.headers.get("location"), null);
  assert.match(callback.headers.get("content-type"), /text\/html/);
  assert.match(await callback.text(), /This Desk is not open to mallory\./);
});

test("the callback refuses a forged or expired pending state", async (t) => {
  const { base, github } = await start(t);
  const forged = seal("pending", { clientId: "x", redirectUri: "https://evil.example/cb", codeChallenge: "c" }, { key: "other-key", ttlSec: 600 });
  const expired = seal("pending", { clientId: "x", redirectUri: CLAUDE_CALLBACK, codeChallenge: "c" }, { key: KEY, ttlSec: -1 });
  for (const state of [forged, expired, "junk"]) {
    const response = await fetch(`${base}/oauth/github/callback?${new URLSearchParams({ code: "gh-code", state })}`, { redirect: "manual" });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal(github.calls.length, 0);
});

test("a GitHub denial goes back to the client as access_denied", async (t) => {
  const { base } = await start(t);
  const { githubUrl } = await signIn(base);
  const response = await fetch(
    `${base}/oauth/github/callback?${new URLSearchParams({ error: "access_denied", state: githubUrl.searchParams.get("state") })}`,
    { redirect: "manual" },
  );
  assert.equal(response.status, 302);
  const back = new URL(response.headers.get("location"));
  assert.equal(back.origin + back.pathname, CLAUDE_CALLBACK);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "claude-state");
  assert.equal(back.searchParams.get("code"), null);
});

test("refresh rotates both tokens", async (t) => {
  const { base, provider } = await start(t);
  const { client, tokens } = await signInForTokens(base);
  const { status, body } = await tokenRequest(base, {
    grant_type: "refresh_token",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(status, 200);
  assert.equal(body.expires_in, 3600);
  assert.notEqual(body.refresh_token, tokens.refresh_token);
  assert.equal((await provider.verifyAccessToken(body.access_token)).extra.login, "arimendelow");
});

test("a dead, foreign or misused refresh token gets invalid_grant", async (t) => {
  const { base } = await start(t);
  const { client, tokens } = await signInForTokens(base);
  const other = (await register(base, { client_name: "Other" })).body;
  const claims = { clientId: client.client_id, login: "arimendelow", userId: 16390116, name: "Ari Mendelow", scopes: [] };
  const [body, signature] = tokens.refresh_token.split(".");
  const cases = {
    tampered: `${body}x.${signature}`,
    expired: seal("refresh", claims, { key: KEY, ttlSec: -1 }),
    "access token": tokens.access_token,
  };
  for (const [name, refresh_token] of Object.entries(cases)) {
    const reply = await tokenRequest(base, { grant_type: "refresh_token", client_id: client.client_id, client_secret: client.client_secret, refresh_token });
    assert.equal(reply.status, 400, name);
    assert.equal(reply.body.error, "invalid_grant", name);
  }
  const foreign = await tokenRequest(base, {
    grant_type: "refresh_token",
    client_id: other.client_id,
    client_secret: other.client_secret,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error, "invalid_grant");
});

test("a code exchanged with another redirect, by another client or after expiry gets invalid_grant", async (t) => {
  const { base } = await start(t);
  const { client, verifier, callback } = await signIn(base, {
    metadata: { redirect_uris: [CLAUDE_CALLBACK, "https://claude.com/api/mcp/auth_callback"] },
  });
  const code = new URL(callback.headers.get("location")).searchParams.get("code");
  const exchange = (overrides) =>
    tokenRequest(base, {
      grant_type: "authorization_code",
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK,
      ...overrides,
    });
  const other = (await register(base, { client_name: "Other" })).body;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const expired = seal(
    "code",
    { clientId: client.client_id, redirectUri: CLAUDE_CALLBACK, codeChallenge: challenge, login: "arimendelow", userId: 1, name: "A" },
    { key: KEY, ttlSec: -1 },
  );
  const cases = {
    "redirect mismatch": await exchange({ redirect_uri: "https://claude.com/api/mcp/auth_callback" }),
    "another client": await exchange({ client_id: other.client_id, client_secret: other.client_secret }),
    expired: await exchange({ code: expired }),
    "refresh as code": await exchange({ code: seal("refresh", {}, { key: KEY, ttlSec: 60 }) }),
  };
  for (const [name, reply] of Object.entries(cases)) {
    assert.equal(reply.status, 400, name);
    assert.equal(reply.body.error, "invalid_grant", name);
  }
});
