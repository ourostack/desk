import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { seal } from "../src/auth/seal.js";
import { createProvider } from "../src/auth/provider.js";
import { createApp, createDeepHealth } from "../src/server.js";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
    resource: RESOURCE,
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
  const server = app.listen(0, "127.0.0.1");
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

test("the authorization-server metadata advertises S256, registration and offline_access", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json();
  assert.deepEqual(body.scopes_supported, ["desk", "offline_access"]);
  assert.equal(body.client_id_metadata_document_supported, true);
  assert.equal(body.token_endpoint, `${ISSUER}/token`);
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

test("the consent route is mounted and refuses an invalid consent", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER },
    body: "consent=forged",
    redirect: "manual",
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /expired or is not valid/);
});

test("the consent route checks the POST came from the gateway's own origin", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: "consent=forged",
    redirect: "manual",
  });
  assert.equal(response.status, 403);
});

test("when the GitHub App is not set up, /healthz still answers and /authorize and /mcp answer 503", async (t) => {
  const { base, reached } = await start(t, { unavailable: NOT_SET_UP });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const authorize = await fetch(`${base}/authorize?response_type=code&client_id=x`, { redirect: "manual" });
  assert.equal(authorize.status, 503);
  assert.match(await authorize.text(), new RegExp(NOT_SET_UP));
  const consent = await fetch(`${base}/oauth/consent`, { method: "POST", body: new URLSearchParams({ consent: "x" }), redirect: "manual" });
  assert.equal(consent.status, 503);
  const mcp = await mcpPost(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, accessToken());
  assert.equal(mcp.status, 503);
  assert.match((await mcp.json()).error.message, new RegExp(NOT_SET_UP));
  assert.equal(reached.length, 0);
});

// ---- /healthz/deep (spec items 10 and 13; Review Focus 10 and 12) ----

const MAPPED = "0b8e2f4c-1d3a-4e5b-9c7d-6f8a0b1c2d3e";

// A deep check over stand-ins for discovery and the accounts store, on a fake clock.
function deepParts({ accountIds = [MAPPED] } = {}) {
  let clock = 1_000_000;
  const state = { ready: true, mismatch: false, storeDown: false, rows: new Map([[MAPPED, { accountId: MAPPED, deskAccess: true }]]), reads: 0 };
  const discovery = { ready: () => state.ready, mismatch: () => state.mismatch };
  const store = {
    async getAccount(accountId) {
      state.reads++;
      if (state.storeDown) throw Object.assign(new Error(`the accounts store failed: get on table accounts for ${accountId}`), { name: "StoreError" });
      return state.rows.get(accountId) ?? null;
    },
  };
  const deep = createDeepHealth({ discovery, store, accountIds, now: () => clock });
  return { deep, state, advance: (ms) => (clock += ms) };
}

async function startDeep(t, deepHealth) {
  const provider = createProvider({ key: KEY, issuer: ISSUER, github: { clientId: "x", clientSecret: "y" }, allowedLogins: ["arimendelow"], resource: RESOURCE, log: () => {} });
  const app = createApp({ provider, relay: {}, githubCallback: provider.githubCallback, issuer: ISSUER, resource: RESOURCE, deepHealth });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("/healthz/deep answers 503 with only the check name when the store, discovery or a mapped account is unavailable, and 200 when all pass", async (t) => {
  const parts = deepParts();
  const base = await startDeep(t, parts.deep);
  const deep = async () => {
    parts.advance(10_001);
    const response = await fetch(`${base}/healthz/deep`);
    return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control") };
  };
  assert.deepEqual(await deep(), { status: 200, text: "ok", cache: "no-store" });

  parts.state.storeDown = true;
  assert.deepEqual(await deep(), { status: 503, text: "failing: store", cache: "no-store" });
  parts.state.storeDown = false;

  parts.state.ready = false;
  assert.equal((await deep()).text, "failing: discovery");
  parts.state.ready = true;
  parts.state.mismatch = true;
  assert.equal((await deep()).text, "failing: discovery", "an issuer mismatch found after start fails the check");
  parts.state.mismatch = false;

  parts.state.rows.delete(MAPPED);
  const missing = await deep();
  assert.equal(missing.status, 503);
  assert.equal(missing.text, "failing: legacy-account");
  assert.ok(!missing.text.includes(MAPPED), "never the account id or any other data");

  parts.state.ready = false;
  parts.state.storeDown = true;
  assert.equal((await deep()).text, "failing: discovery, store");
});

test("/healthz/deep makes at most one store read per 10 s however often it is called", async (t) => {
  const parts = deepParts();
  const base = await startDeep(t, parts.deep);
  const replies = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/healthz/deep`).then((response) => response.status)));
  assert.deepEqual(new Set(replies), new Set([200]));
  for (let i = 0; i < 5; i++) {
    parts.advance(1_900);
    assert.equal((await fetch(`${base}/healthz/deep`)).status, 200);
  }
  assert.equal(parts.state.reads, 1, "one read in the first 10 s");
  parts.advance(1_000);
  await fetch(`${base}/healthz/deep`);
  assert.equal(parts.state.reads, 2, "the next read only after 10 s");
});

test("/healthz/deep fails legacy-account when the legacy mapping is missing or empty, still reading the store once", async (t) => {
  // An empty DESK_GITHUB_ACCOUNTS would refuse Ari's existing connector at deploy, so the deploy's deep check catches it.
  const parts = deepParts({ accountIds: [] });
  assert.deepEqual(await parts.deep.check(), { ok: false, failing: ["legacy-account"] });
  assert.equal(parts.state.reads, 1);
  parts.state.storeDown = true;
  parts.advance(10_001);
  assert.deepEqual(await parts.deep.check(), { ok: false, failing: ["store"] });
  parts.state.storeDown = false;
  parts.advance(10_001);
  const base = await startDeep(t, parts.deep);
  const response = await fetch(`${base}/healthz/deep`);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "failing: legacy-account");
});

test("without the Ouro tenant and accounts, /healthz/deep answers ok, as there is nothing deeper to check", async (t) => {
  const base = await startDeep(t, undefined);
  const response = await fetch(`${base}/healthz/deep`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("provision.sh's startup and liveness probes stay on /healthz", (t) => {
  // A fake az and dig on PATH: the app doesn't exist yet, so a dry run prints the spec it would create.
  const dir = mkdtempSync(join(tmpdir(), "desk-provision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "az"),
    `#!/bin/sh
case "$*" in
  *"containerapp show"*"--query name"*) echo "ERROR: (ResourceNotFound) The Resource was not found." >&2; exit 3 ;;
  *"containerapp show"*) exit 3 ;;
  *"env show"*"--query id"*) echo /subscriptions/s/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/env ;;
  *"env show"*"defaultDomain"*) echo example.eastus2.azurecontainerapps.io ;;
  *"env show"*) echo verification-id ;;
  *"identity show"*"--query id"*) echo /subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi ;;
  *"identity show"*) echo 00000000-0000-0000-0000-000000000000 ;;
  *"acr show"*) echo registry.azurecr.io ;;
  *"federated-credential show"*) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  writeFileSync(join(dir, "dig"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "az"), 0o755);
  chmodSync(join(dir, "dig"), 0o755);
  const script = fileURLToPath(new URL("../infra/provision.sh", import.meta.url));
  const output = execFileSync("bash", [script], { env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, DRY_RUN: "1" }, encoding: "utf8" });
  const spec = output.split("\n").filter((line) => line.startsWith("    | ")).map((line) => line.slice(6)).join("\n");
  const probes = [...spec.matchAll(/- type: (\w+)\n\s+httpGet:\n\s+path: (\S+)/g)].map(([, type, path]) => [type, path]);
  assert.deepEqual(probes, [["Startup", "/healthz"], ["Liveness", "/healthz"]], spec);
  assert.ok(!spec.includes("/healthz/deep"));
});
