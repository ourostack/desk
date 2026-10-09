import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { seal } from "../src/auth/seal.js";
import { createProvider } from "../src/auth/provider.js";
import { createApp } from "../src/server.js";

const KEY = "test-key-0123456789abcdef0123456789abcdef";
const ISSUER = "https://desk.ouro.bot";
const RESOURCE = "https://desk.ouro.bot/mcp";
const METADATA_URL = "https://desk.ouro.bot/.well-known/oauth-protected-resource/mcp";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const NOT_SET_UP = "Hosted Desk is not set up yet: its GitHub App is missing.";

// Starts the gateway app with a stand-in relay that records what reaches it.
async function start(t, { unavailable } = {}) {
  const provider = createProvider({
    key: KEY,
    issuer: ISSUER,
    github: { clientId: "Iv1.ouro-desk", clientSecret: "secret", fetch: () => assert.fail("no GitHub call expected") },
    allowedLogins: ["arimendelow"],
    log: () => {},
  });
  const reached = [];
  const relay = {
    handle(req, res, auth) {
      reached.push({ method: req.method, auth, bodySize: JSON.stringify(req.body ?? null).length });
      res.json({ relayed: true, login: auth.extra.login });
    },
  };
  const app = createApp({ provider, relay, githubCallback: provider.githubCallback, issuer: ISSUER, resource: RESOURCE, unavailable });
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, app, reached };
}

const accessToken = (claims = {}) =>
  seal("access", { clientId: "c", scopes: ["desk"], login: "arimendelow", userId: 16390116, name: "Ari", ...claims }, { key: KEY, ttlSec: 3600 });

const mcpPost = (base, body, token) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

test("POST /mcp without a token is 401 and names the protected-resource metadata", async (t) => {
  const { base, reached } = await start(t);
  const response = await mcpPost(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), new RegExp(`resource_metadata="${METADATA_URL}"`));
  assert.equal(reached.length, 0);
});

test("the protected-resource metadata names the resource exactly and the issuer first", async (t) => {
  const { base } = await start(t);
  const body = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(body.resource, RESOURCE);
  assert.equal(body.authorization_servers[0], `${ISSUER}/`);
  assert.deepEqual(body.scopes_supported, ["desk"]);
});

test("the authorization-server metadata advertises S256 and registration", async (t) => {
  const { base } = await start(t);
  const body = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.equal(body.registration_endpoint, `${ISSUER}/register`);
  assert.equal(body.issuer, `${ISSUER}/`);
});

test("/register takes JSON and /token takes a form-encoded refresh grant", async (t) => {
  const { base } = await start(t);
  const registration = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK] }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const refresh = seal(
    "refresh",
    { clientId: client.client_id, scopes: ["desk"], login: "arimendelow", userId: 16390116, name: "Ari" },
    { key: KEY, ttlSec: 3600 },
  );
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id, client_secret: client.client_secret }),
  });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.ok(tokens.access_token);
  assert.notEqual(tokens.refresh_token, refresh);
});

test("with a valid access token, /mcp reaches the relay with the token's identity", async (t) => {
  const { base, reached } = await start(t);
  const response = await mcpPost(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, accessToken());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { relayed: true, login: "arimendelow" });
  assert.equal(reached.length, 1);
  assert.deepEqual(reached[0].auth.extra, { login: "arimendelow", userId: 16390116, name: "Ari" });
});

test("a large Desk call body up to the 4 MB limit reaches the relay", async (t) => {
  const { base, reached } = await start(t);
  const text = "x".repeat(3 * 1024 * 1024);
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desk_save", arguments: { text } } };
  const response = await mcpPost(base, call, accessToken());
  assert.equal(response.status, 200);
  assert.ok(reached[0].bodySize > text.length);
  const tooLarge = await mcpPost(base, { ...call, params: { arguments: { text: "x".repeat(5 * 1024 * 1024) } } }, accessToken());
  assert.equal(tooLarge.status, 413);
  assert.equal(reached.length, 1);
});

test("/healthz answers ok, and the app trusts one proxy hop", async (t) => {
  const { base, app } = await start(t);
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(app.get("trust proxy"), 1);
});

test("the GitHub callback route is mounted", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/oauth/github/callback?code=x&state=forged`, { redirect: "manual" });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /expired or is not valid/);
});

test("when the GitHub App is not set up, /healthz still answers and /authorize and /mcp answer 503", async (t) => {
  const { base, reached } = await start(t, { unavailable: NOT_SET_UP });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const authorize = await fetch(`${base}/authorize?response_type=code&client_id=x`, { redirect: "manual" });
  assert.equal(authorize.status, 503);
  assert.match(await authorize.text(), new RegExp(NOT_SET_UP));
  const mcp = await mcpPost(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, accessToken());
  assert.equal(mcp.status, 503);
  assert.match((await mcp.json()).error.message, new RegExp(NOT_SET_UP));
  assert.equal(reached.length, 0);
});
