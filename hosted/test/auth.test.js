import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { seal, unseal } from "../src/auth/seal.js";
import { createProvider, consentHandler } from "../src/auth/provider.js";
import { githubCallbackHandler } from "../src/auth/github.js";
import { createRedirectPolicy } from "../src/auth/redirects.js";

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

// Every provider logs here instead of stderr; the suite checks after each
// test that no log line carries a token, code or secret.
const logs = [];
const issued = new Set();

function makeProvider(github = fakeGitHub(), options = {}) {
  return createProvider({
    key: KEY,
    issuer: ISSUER,
    github: { ...GITHUB, fetch: github.fetch },
    allowedLogins: ["arimendelow"],
    resource: MCP_URL,
    log: (line) => logs.push(line),
    ...options,
  });
}

afterEach(() => {
  for (const line of logs) {
    for (const secret of [...issued, "gho_", GITHUB.clientSecret]) assert.ok(!line.includes(secret), `log line leaks a secret: ${line}`);
  }
  logs.length = 0;
  issued.clear();
});

// Mounts the SDK's OAuth router with our provider, the GitHub callback and a
// bearer-protected /mcp, the way the gateway will.
async function start(t, github = fakeGitHub(), options = {}) {
  const provider = makeProvider(github, options);
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
  app.post("/oauth/consent", express.urlencoded({ extended: false }), consentHandler(provider, { issuer: ISSUER }));
  app.all(
    "/mcp",
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_URL)) }),
    (req, res) => res.json(req.auth),
  );
  const server = app.listen(0, "127.0.0.1");
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
  const body = await response.json();
  if (body.client_secret) issued.add(body.client_secret);
  return { status: response.status, body };
}

const tokenRequest = (base, params) =>
  fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }).then(async (response) => {
    const body = await response.json();
    for (const token of [body.access_token, body.refresh_token, params.code, params.refresh_token]) if (token) issued.add(token);
    return { status: response.status, body };
  });

// Opens the consent page for a fresh authorization request and returns the
// response and the sealed consent value its Approve form carries.
// `resource: null` leaves the resource parameter out.
async function consentPage(base, client, { challenge = "challenge", redirectUri = client.redirect_uris[0], resource = MCP_URL } = {}) {
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state",
    ...(resource === null ? {} : { resource }),
  });
  const response = await fetch(authorize, { redirect: "manual" });
  const html = await response.text();
  const consent = html.match(/name="consent" value="([^"]+)"/)?.[1];
  return { response, html, consent };
}

// Approves on the consent page: the form POST the browser sends, which a
// browser marks as coming from the gateway's own page.
const approve = (base, consent, headers = { "sec-fetch-site": "same-origin" }) =>
  fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ consent }),
    redirect: "manual",
  });

// Runs Claude's side of sign-in up to the authorization code: register,
// authorize, approve on the consent page, then GitHub's redirect back to our
// callback.
async function signIn(base, { githubCode = "gh-code", metadata, resource } = {}) {
  const client = (await register(base, metadata)).body;
  const { verifier, challenge } = pkce();
  const { response, consent } = await consentPage(base, client, { challenge, resource });
  assert.equal(response.status, 200);
  const toGitHub = await approve(base, consent);
  assert.equal(toGitHub.status, 303);
  const githubUrl = new URL(toGitHub.headers.get("location"));
  const callback = await fetch(
    `${base}/oauth/github/callback?${new URLSearchParams({ code: githubCode, state: githubUrl.searchParams.get("state") })}`,
    { redirect: "manual" },
  );
  return { client, verifier, githubUrl, callback };
}

async function signInForTokens(base, { resource } = {}) {
  const { client, verifier, callback } = await signIn(base, { resource });
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

test("two identical registrations get different client ids and secrets", async (t) => {
  const { base } = await start(t);
  const first = (await register(base)).body;
  const second = (await register(base)).body;
  assert.notEqual(first.client_id, second.client_id);
  assert.notEqual(first.client_secret, second.client_secret);
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

test("authorize shows a consent page naming the client and where it will be sent, not a redirect", async (t) => {
  const { base, github } = await start(t);
  const client = (await register(base, { client_name: "Claude" })).body;
  const { response, html, consent } = await consentPage(base, client);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(html, /Connect Claude to your desk/);
  assert.match(html, /When you approve, you sign in with GitHub, and then Hosted Desk sends you back to <strong>claude\.ai<\/strong>\./);
  assert.match(html, /<form method="post" action="\/oauth\/consent">/);
  assert.match(html, /<button type="submit">Approve<\/button>/);
  const sealed = unseal("consent", consent, { key: KEY });
  assert.equal(sealed.clientId, client.client_id);
  assert.equal(sealed.redirectUri, CLAUDE_CALLBACK);
  assert.equal(sealed.state, "claude-state");
  assert.ok(sealed.exp - Date.now() / 1000 <= 600 && sealed.exp - Date.now() / 1000 > 590, "the consent seal lives 600 s");
  assert.equal(unseal("pending", consent, { key: KEY }), null, "a consent seal is not a pending state");
  assert.equal(github.calls.length, 0);
});

test("the consent page names an unnamed client 'an app' and a loopback redirect by host and port", async (t) => {
  const { base } = await start(t);
  const client = (await register(base, { client_name: undefined, redirect_uris: ["http://127.0.0.1:33418/callback"] })).body;
  const { response, html } = await consentPage(base, client);
  assert.equal(response.status, 200);
  assert.match(html, /Connect an app to your desk/);
  assert.match(html, /sends you back to <strong>127\.0\.0\.1:33418<\/strong>\./);
});

test("the consent page escapes a hostile client name", async (t) => {
  const { base } = await start(t);
  const hostile = `<script>alert("x")</script><img src=x onerror='y'>&`;
  const client = (await register(base, { client_name: hostile })).body;
  const { html } = await consentPage(base, client);
  assert.ok(!html.includes("<script>"), "no raw script tag");
  assert.ok(!/<img(?! src="\/assets\/desk-icon\.svg")/.test(html), "no raw img tag other than the Desk icon");
  assert.match(html, /Connect &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&lt;img src=x onerror=&#39;y&#39;&gt;&amp; to your desk/);
});

test("a consent POST that is tampered, expired, of another kind or missing gets 400 and no redirect", async (t) => {
  const { base, github } = await start(t);
  const client = (await register(base)).body;
  const { consent } = await consentPage(base, client);
  const [body, signature] = consent.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), redirectUri: "http://127.0.0.1:1/x" })).toString("base64url");
  const request = { clientId: client.client_id, redirectUri: CLAUDE_CALLBACK, codeChallenge: "c", state: "s" };
  const refused = [
    `${forgedBody}.${signature}`,
    seal("consent", request, { key: KEY, ttlSec: -1 }),
    seal("consent", request, { key: `${KEY}-other`, ttlSec: 600 }),
    seal("pending", request, { key: KEY, ttlSec: 600 }),
    "junk",
  ];
  for (const value of refused) {
    const response = await approve(base, value);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(await response.text(), /expired or is not valid/);
  }
  const missing = await fetch(`${base}/oauth/consent`, { method: "POST", headers: { "sec-fetch-site": "same-origin" }, redirect: "manual" });
  assert.equal(missing.status, 400);
  assert.equal(github.calls.length, 0);
  assert.ok(logs.some((line) => line === "consent refused: invalid_consent"));
});

test("a consent POST from the gateway's own page is accepted by Sec-Fetch-Site or, without it, by Origin", async (t) => {
  const { base } = await start(t);
  const client = (await register(base)).body;
  for (const headers of [{ "sec-fetch-site": "same-origin" }, { origin: ISSUER }, { "sec-fetch-site": "same-origin", origin: ISSUER }]) {
    const { consent } = await consentPage(base, client);
    const response = await approve(base, consent, headers);
    assert.equal(response.status, 303, JSON.stringify(headers));
    assert.match(response.headers.get("location"), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  }
});

test("a consent POST from another site, or with no origin evidence, gets 403 and no redirect", async (t) => {
  const { base, github } = await start(t);
  const client = (await register(base)).body;
  const refused = [
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
    { "sec-fetch-site": "cross-site", origin: ISSUER },
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: `${ISSUER}.evil.example` },
    {},
  ];
  for (const headers of refused) {
    const { consent } = await consentPage(base, client);
    const response = await approve(base, consent, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(await response.text(), /Approve on the Hosted Desk page itself/);
  }
  assert.equal(github.calls.length, 0);
  assert.ok(logs.some((line) => line === "consent refused: cross_origin"));
});

test("approving on the consent page sends the browser to GitHub with a sealed pending state", async (t) => {
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
  assert.ok(logs.some((line) => line.startsWith("sign-in refused: login_not_allowed client ")));
  assert.ok(!logs.some((line) => line.includes("mallory")));
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
    tokenRequest(
      base,
      Object.fromEntries(
        Object.entries({
          grant_type: "authorization_code",
          client_id: client.client_id,
          client_secret: client.client_secret,
          code,
          code_verifier: verifier,
          redirect_uri: CLAUDE_CALLBACK,
          ...overrides,
        }).filter(([, value]) => value !== undefined),
      ),
    );
  const other = (await register(base, { client_name: "Other" })).body;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const expired = seal(
    "code",
    { clientId: client.client_id, redirectUri: CLAUDE_CALLBACK, codeChallenge: challenge, login: "arimendelow", userId: 1, name: "A" },
    { key: KEY, ttlSec: -1 },
  );
  const cases = {
    "redirect mismatch": await exchange({ redirect_uri: "https://claude.com/api/mcp/auth_callback" }),
    "redirect omitted": await exchange({ redirect_uri: undefined }),
    "another client": await exchange({ client_id: other.client_id, client_secret: other.client_secret }),
    expired: await exchange({ code: expired }),
    "refresh as code": await exchange({ code: seal("refresh", {}, { key: KEY, ttlSec: 60 }) }),
  };
  for (const [name, reply] of Object.entries(cases)) {
    assert.equal(reply.status, 400, name);
    assert.equal(reply.body.error, "invalid_grant", name);
  }
  assert.ok(logs.includes(`token refused: invalid_grant client ${client.client_id}`));
});

test("registration accepts ChatGPT's per-connector callback and a configured redirect", async (t) => {
  const { base } = await start(t, fakeGitHub(), { redirects: createRedirectPolicy(`${CLAUDE_CALLBACK},https://vscode.dev/redirect`) });
  for (const uri of ["https://chatgpt.com/connector/oauth/abc_DEF-123", "https://vscode.dev/redirect"]) {
    const { status, body } = await register(base, { redirect_uris: [uri] });
    assert.equal(status, 201, uri);
    assert.deepEqual(body.redirect_uris, [uri]);
  }
  const removed = await register(base, { redirect_uris: ["https://claude.com/api/mcp/auth_callback"] });
  assert.equal(removed.status, 400, "a default left out of DESK_REDIRECTS is refused");
  assert.equal(removed.body.error, "invalid_redirect_uri");
});

test("a redirect removed from DESK_REDIRECTS stops working for a client registered before the removal", async (t) => {
  // Registered while claude.ai's callback was allowed (the default), the way
  // Ari's existing connector was.
  const before = await start(t);
  const { client, tokens } = await signInForTokens(before.base);
  assert.ok(await before.provider.clientsStore.getClient(client.client_id));

  // The same key, with claude.ai's callback no longer configured.
  const after = await start(t, fakeGitHub(), { redirects: createRedirectPolicy("https://claude.com/api/mcp/auth_callback") });
  logs.length = 0;
  assert.equal(await after.provider.clientsStore.getClient(client.client_id), undefined);
  assert.deepEqual(logs, ["client refused: invalid_redirect_uri"]);

  const { response, html } = await consentPage(after.base, client);
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(html).error, "invalid_client");

  const refresh = await tokenRequest(after.base, {
    grant_type: "refresh_token",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(refresh.status, 400);
  assert.equal(refresh.body.error, "invalid_client");
});

test("a client with several redirects is refused when any one of them is no longer allowed", async (t) => {
  const { provider } = await start(t);
  const both = provider.clientsStore.registerClient({ redirect_uris: [CLAUDE_CALLBACK, "https://claude.com/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
  const narrowed = makeProvider(fakeGitHub(), { redirects: createRedirectPolicy(CLAUDE_CALLBACK) });
  assert.equal(await narrowed.clientsStore.getClient(both.client_id), undefined);
});

const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());

test("authorize with the MCP resource seals it as the audience, compared by its normalized form", async (t) => {
  const { base } = await start(t);
  const client = (await register(base)).body;
  for (const resource of [MCP_URL, "https://DESK.ouro.bot:443/mcp"]) {
    const { response, consent } = await consentPage(base, client, { resource });
    assert.equal(response.status, 200, resource);
    assert.equal(unseal("consent", consent, { key: KEY }).aud, MCP_URL, resource);
  }
});

test("authorize with another resource sends invalid_target back to the client", async (t) => {
  const { base, github } = await start(t);
  const client = (await register(base)).body;
  for (const resource of ["https://desk.ouro.bot/other", "https://evil.example/mcp", "https://desk.ouro.bot/mcp/"]) {
    const { response } = await consentPage(base, client, { resource });
    assert.equal(response.status, 302, resource);
    const back = new URL(response.headers.get("location"));
    assert.equal(back.origin + back.pathname, CLAUDE_CALLBACK);
    assert.equal(back.searchParams.get("error"), "invalid_target", resource);
    assert.equal(back.searchParams.get("state"), "claude-state");
  }
  assert.equal(github.calls.length, 0);
  assert.ok(logs.includes(`authorize refused: invalid_target client ${client.client_id} resource https://evil.example/mcp`));
  assert.ok(logs.includes(`authorize refused: invalid_target client ${client.client_id} resource https://desk.ouro.bot/mcp/`));
});

test("authorize without a resource gets the default audience in the code and the tokens", async (t) => {
  const { base, provider } = await start(t);
  const { client, verifier, callback } = await signIn(base, { resource: null });
  const code = new URL(callback.headers.get("location")).searchParams.get("code");
  issued.add(code);
  assert.equal(unseal("code", code, { key: KEY }).aud, MCP_URL);
  const { status, body } = await tokenRequest(base, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK,
  });
  assert.equal(status, 200);
  assert.equal(claimsOf(body.access_token).aud, MCP_URL);
  assert.equal(claimsOf(body.refresh_token).aud, MCP_URL);
  assert.equal((await provider.verifyAccessToken(body.access_token)).extra.login, "arimendelow");
});

test("a code exchange or refresh naming another resource gets invalid_target; the MCP resource is accepted", async (t) => {
  const { base } = await start(t);
  const { client, verifier, callback } = await signIn(base);
  const code = new URL(callback.headers.get("location")).searchParams.get("code");
  const exchange = (resource) =>
    tokenRequest(base, {
      grant_type: "authorization_code",
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK,
      resource,
    });
  const wrong = await exchange("https://evil.example/mcp");
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "invalid_target");
  const right = await exchange(MCP_URL);
  assert.equal(right.status, 200);
  assert.equal(claimsOf(right.body.access_token).aud, MCP_URL);

  const refresh = (resource) =>
    tokenRequest(base, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: right.body.refresh_token,
      ...(resource ? { resource } : {}),
    });
  const wrongRefresh = await refresh("https://desk.ouro.bot/other");
  assert.equal(wrongRefresh.status, 400);
  assert.equal(wrongRefresh.body.error, "invalid_target");
  assert.equal((await refresh(MCP_URL)).status, 200);
  assert.equal((await refresh()).status, 200);
  assert.ok(logs.includes(`token refused: invalid_target client ${client.client_id} resource https://desk.ouro.bot/other`));
});

test("an access token for another audience is refused; one with no audience, minted before v1a, is accepted", async (t) => {
  const { base, provider } = await start(t);
  const claims = { clientId: "c", scopes: ["desk"], login: "arimendelow", userId: 16390116, name: "Ari Mendelow" };
  const foreign = seal("access", { ...claims, aud: "https://elsewhere.example/mcp" }, { key: KEY, ttlSec: 3600 });
  const legacy = seal("access", claims, { key: KEY, ttlSec: 3600 });
  const current = seal("access", { ...claims, aud: MCP_URL }, { key: KEY, ttlSec: 3600 });
  for (const token of [foreign, legacy, current]) issued.add(token);
  await assert.rejects(provider.verifyAccessToken(foreign), { errorCode: "invalid_token" });
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${foreign}` } })).status, 401);
  assert.equal((await provider.verifyAccessToken(legacy)).extra.login, "arimendelow");
  assert.equal((await provider.verifyAccessToken(current)).extra.login, "arimendelow");
  const mcp = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${legacy}` } });
  assert.equal(mcp.status, 200);
});

test("a refresh token with no audience, minted before v1a, refreshes and the new tokens get the default audience", async (t) => {
  const { base, provider } = await start(t);
  const client = (await register(base)).body;
  const legacy = seal("refresh", { clientId: client.client_id, scopes: [], login: "arimendelow", userId: 16390116, name: "Ari Mendelow" }, { key: KEY, ttlSec: 3600 });
  const { status, body } = await tokenRequest(base, {
    grant_type: "refresh_token",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: legacy,
  });
  assert.equal(status, 200);
  assert.equal(claimsOf(body.access_token).aud, MCP_URL);
  assert.equal(claimsOf(body.refresh_token).aud, MCP_URL);
  assert.equal((await provider.verifyAccessToken(body.access_token)).extra.login, "arimendelow");
});

test("a code or refresh token sealed for another audience gets invalid_grant", async (t) => {
  const { base } = await start(t);
  const { client, verifier } = await signIn(base);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const claims = { clientId: client.client_id, login: "arimendelow", userId: 1, name: "A", scopes: [], aud: "https://elsewhere.example/mcp" };
  const code = await tokenRequest(base, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    code: seal("code", { ...claims, redirectUri: CLAUDE_CALLBACK, codeChallenge: challenge }, { key: KEY, ttlSec: 60 }),
    code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK,
  });
  assert.equal(code.status, 400);
  assert.equal(code.body.error, "invalid_grant");
  const refresh = await tokenRequest(base, {
    grant_type: "refresh_token",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: seal("refresh", claims, { key: KEY, ttlSec: 3600 }),
  });
  assert.equal(refresh.status, 400);
  assert.equal(refresh.body.error, "invalid_grant");
});

test("createProvider needs the MCP resource", () => {
  assert.throws(() => makeProvider(fakeGitHub(), { resource: undefined }), /resource/);
});

const DOCUMENT_ID = "https://client.example/oauth/client.json";

// A stand-in for the client-document fetcher: it knows one document.
function fakeDocuments(client = { client_id: DOCUMENT_ID, client_name: "Example App", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }) {
  const asked = [];
  return {
    asked,
    async get(clientId) {
      asked.push(clientId);
      return clientId === DOCUMENT_ID ? client : undefined;
    },
  };
}

test("getClient sends an https client id to the document fetcher and a sealed one never", async (t) => {
  const documents = fakeDocuments();
  const { base, provider } = await start(t, fakeGitHub(), { clientDocuments: documents });
  assert.equal((await provider.clientsStore.getClient(DOCUMENT_ID)).client_name, "Example App");
  assert.equal(await provider.clientsStore.getClient("https://client.example/unknown.json"), undefined);
  const sealed = (await register(base)).body;
  assert.ok(await provider.clientsStore.getClient(sealed.client_id));
  assert.equal(await provider.clientsStore.getClient("http://client.example/oauth/client.json"), undefined);
  assert.deepEqual(documents.asked, [DOCUMENT_ID, "https://client.example/unknown.json"]);
});

test("a client metadata document signs in end to end as a public client", async (t) => {
  const { base, provider } = await start(t, fakeGitHub(), { clientDocuments: fakeDocuments() });
  const client = await provider.clientsStore.getClient(DOCUMENT_ID);
  const { verifier, challenge } = pkce();
  const { response, html, consent } = await consentPage(base, client, { challenge });
  assert.equal(response.status, 200);
  // The host the client id names comes first, above the name the document
  // gives itself, which anyone could choose.
  assert.match(html, /<h1>Connect Example App to your desk<\/h1><p class="from">From <strong>client\.example<\/strong><\/p>/);
  const toGitHub = await approve(base, consent);
  const state = new URL(toGitHub.headers.get("location")).searchParams.get("state");
  const callback = await fetch(`${base}/oauth/github/callback?${new URLSearchParams({ code: "gh-code", state })}`, { redirect: "manual" });
  const code = new URL(callback.headers.get("location")).searchParams.get("code");
  const { status, body } = await tokenRequest(base, {
    grant_type: "authorization_code",
    client_id: DOCUMENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK,
    resource: MCP_URL,
  });
  assert.equal(status, 200);
  assert.equal((await provider.verifyAccessToken(body.access_token)).clientId, DOCUMENT_ID);
  const refreshed = await tokenRequest(base, { grant_type: "refresh_token", client_id: DOCUMENT_ID, refresh_token: body.refresh_token });
  assert.equal(refreshed.status, 200);
});

test("authorize with a client document that cannot be read answers invalid_client", async (t) => {
  const { base } = await start(t, fakeGitHub(), { clientDocuments: fakeDocuments() });
  const { response, html } = await consentPage(base, { client_id: "https://client.example/unknown.json", redirect_uris: [CLAUDE_CALLBACK] });
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(html).error, "invalid_client");
});

test("the consent page escapes a hostile document's name and shows the host of its id with a port", async (t) => {
  const hostile = `<script>x</script>`;
  const documents = fakeDocuments({ client_id: DOCUMENT_ID, client_name: hostile, redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
  const { base, provider } = await start(t, fakeGitHub(), { clientDocuments: documents });
  const { html } = await consentPage(base, await provider.clientsStore.getClient(DOCUMENT_ID));
  assert.ok(!html.includes("<script>"));
  assert.match(html, /<h1>Connect &lt;script&gt;x&lt;\/script&gt; to your desk<\/h1>/);
  const { consentPage: render } = await import("../src/auth/pages.js");
  const page = render({ clientName: "A", clientHost: "client.example:8443", redirectUri: CLAUDE_CALLBACK, consent: "c" });
  assert.match(page.html, /From <strong>client\.example:8443<\/strong>/);
  assert.doesNotMatch(render({ clientName: "A", redirectUri: CLAUDE_CALLBACK, consent: "c" }).html, /From /);
});

test("by default the provider reads client documents itself, under the same redirect policy and log", async () => {
  const provider = makeProvider();
  // An IP literal resolves to itself with no network, and loopback is refused.
  assert.equal(await provider.clientsStore.getClient("https://127.0.0.1/client.json"), undefined);
  assert.deepEqual(logs, ["client refused: private_address client https://127.0.0.1/client.json"]);
});

test("the provider's document fetcher refuses a client id on the gateway's own host", async () => {
  const provider = makeProvider();
  assert.equal(await provider.clientsStore.getClient(`${ISSUER}/authorize?client_id=x`), undefined);
  assert.deepEqual(logs, [`client refused: own_host client ${ISSUER}/authorize?client_id=x`]);
});

test("VS Code's own registration succeeds with the default redirects", async (t) => {
  const { base } = await start(t);
  // VS Code's fetchDynamicRegistration body (microsoft/vscode
  // src/vs/base/common/oauth.ts, main, read 2026-10-10).
  const body = {
    client_name: "Visual Studio Code",
    client_uri: "https://code.visualstudio.com",
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    response_types: ["code"],
    redirect_uris: ["https://insiders.vscode.dev/redirect", "https://vscode.dev/redirect", "http://127.0.0.1/", "http://127.0.0.1:33418/"],
    token_endpoint_auth_method: "none",
  };
  const response = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 201);
  const client = await response.json();
  assert.deepEqual(client.redirect_uris, body.redirect_uris);
  assert.equal(client.client_secret, undefined);
  const { response: consent } = await consentPage(base, client, { redirectUri: "https://vscode.dev/redirect" });
  assert.equal(consent.status, 200);
});

test("a wrong resource too long to be worth logging is refused without it", async (t) => {
  const { base } = await start(t);
  const client = (await register(base)).body;
  const { response } = await consentPage(base, client, { resource: `https://evil.example/${"x".repeat(300)}` });
  assert.equal(response.status, 302);
  assert.ok(logs.includes(`authorize refused: invalid_target client ${client.client_id}`));
});
