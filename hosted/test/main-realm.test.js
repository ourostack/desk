// The multi-user gateway's account surfaces, wired by main.js: one browser session shared by the Ouro tenant's page
// sign-in and the gateway's pages, and the admin routes, whose account changes reach the account cache and the
// account's realm. Runs against the stub tenant and the in-memory store; no test reaches the network or needs Linux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { buildGateway, createGatewayAdmin, createLinkHooks, createSessionStart, deskChildArgs, deskInitArgs, readConfig, startIdentity } from "../src/main.js";
import { createMemoryStore } from "../src/accounts/memory-store.js";
import { seed } from "../src/accounts/invites.js";
import { stubTenant, ISSUER, TENANT_ID, SUBDOMAIN, CLIENT_ID, CLIENT_SECRET } from "./fixtures/stub-tenant.mjs";

const ADMIN_OID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const ENV = {
  DESK_SIGNING_KEY: "test-key-0123456789abcdef0123456789abcdef",
  DESK_PUBLIC_URL: "https://desk.ouro.bot",
  DESK_ENTRA_TENANT_ID: TENANT_ID,
  DESK_ENTRA_SUBDOMAIN: SUBDOMAIN,
  DESK_ENTRA_CLIENT_ID: CLIENT_ID,
  DESK_ENTRA_CLIENT_SECRET: CLIENT_SECRET,
  DESK_ACCOUNTS_ENDPOINT: "https://synthetic.table.core.windows.net",
};

async function gateway(t, env) {
  const config = readConfig(env);
  const tenant = await stubTenant();
  const store = createMemoryStore();
  await store.ensureTables();
  const parts = await startIdentity(config, { store, fetch: tenant.fetch });
  const deleted = [];
  const closed = [];
  const relay = { handle: (_req, res) => res.status(204).end(), closeAccount: (id) => closed.push(id) };
  const runtime = { purgeAccount: async (id) => { deleted.push(id); } };
  const admin = config.multiUser ? createGatewayAdmin({ config, parts, relay, runtime, fetch: tenant.fetch }) : undefined;
  const { app } = buildGateway({ config, relay, parts, admin, log: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    parts.discovery.stop();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, parts, deleted, closed, tenant };
}

test("a multi-user gateway mounts /signin, /account, /signout and /admin, sharing one browser session", async (t) => {
  const { base, parts } = await gateway(t, { ...ENV, DESK_MULTI_USER: "1" });
  assert.ok(parts.sessions, "startIdentity builds the browser session on a multi-user gateway");
  assert.equal(parts.entra.pageSignIn, true, "the tenant's sign-in is built with that session");
  const signin = await fetch(`${base}/signin?next=/account`, { redirect: "manual" });
  assert.notEqual(signin.status, 404);
  assert.match(signin.headers.get("location") ?? "", /ciamlogin\.com/, "/signin starts an Ouro tenant sign-in");
  const account = await fetch(`${base}/account`, { redirect: "manual" });
  assert.notEqual(account.status, 404, "/account is mounted");
  const signout = await fetch(`${base}/signout`, { method: "POST", redirect: "manual" });
  assert.notEqual(signout.status, 404, "/signout is mounted");
  const admin = await fetch(`${base}/admin/invites`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(admin.status, 401, "/admin is mounted and needs an admin token");
});

test("a single-desk gateway with the Ouro tenant mounts none of the account pages or admin routes", async (t) => {
  const { base, parts } = await gateway(t, ENV);
  assert.equal(parts.sessions, null);
  for (const [method, path] of [["GET", "/signin?next=/account"], ["GET", "/account"], ["POST", "/signout"], ["POST", "/admin/invites"]]) {
    const response = await fetch(`${base}${path}`, { method, redirect: "manual" });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test("the gateway's admin forgets a deleted account in the account cache, ends its sessions and purges its realm", async (t) => {
  const { base, parts, deleted, closed, tenant } = await gateway(t, { ...ENV, DESK_MULTI_USER: "1" });
  const binding = { kind: "github", repo: "owner/desk", installationId: 1, author: { name: "Someone", email: "1+someone@users.noreply.github.com" } };
  const { accountId: adminId } = await seed({ store: parts.store, displayName: "Admin", binding });
  await parts.store.tables.create("identities", { partitionKey: TENANT_ID, rowKey: ADMIN_OID, accountId: adminId });
  const { accountId: target } = await seed({ store: parts.store, displayName: "Target", binding: { ...binding, repo: "owner/other" } });
  const forgotten = [];
  const original = parts.accounts.forget.bind(parts.accounts);
  parts.accounts.forget = (id) => { forgotten.push(id); return original(id); };
  const iat = Math.floor(Date.now() / 1000);
  const token = await tenant.idToken({ ver: "2.0", iss: ISSUER, aud: CLIENT_ID, tid: TENANT_ID, iat, nbf: iat, exp: iat + 3600, oid: ADMIN_OID, azp: "0b6f7c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e", scp: "desk.admin", roles: ["ouro.admin"] });
  const response = await fetch(`${base}/admin/accounts/${target}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(forgotten, [target], "the account cache forgets the deleted account");
  assert.deepEqual(closed, [target], "the deleted account's sessions end");
  assert.deepEqual(deleted, [target], "the deleted account's realm is purged");
});

const CONFIG = { pluginDir: "/app/plugins/desk" };
const AUTH = { extra: { accountId: "acct-1" } };

test("session start refuses a suspended or unconfirmed GitHub link before preparing the realm", async () => {
  const prepared = [];
  const runtime = { prepare: async (id) => { prepared.push(id); return { realm: {}, launch: (args) => ({ args }) }; } };
  const suspended = createSessionStart({ config: CONFIG, runtime, githubLink: { sessionRefusal: async () => "Your GitHub desk link is suspended." } });
  await assert.rejects(suspended({ auth: AUTH }), (error) => error.code === "DESK_SESSION_REFUSED" && /suspended/.test(error.message));
  assert.deepEqual(prepared, [], "no realm is prepared for a refused session");
  const checked = [];
  const ok = createSessionStart({ config: CONFIG, runtime, githubLink: { sessionRefusal: async (id) => { checked.push(id); return null; } } });
  assert.deepEqual(await ok({ auth: AUTH }), { args: deskChildArgs(CONFIG, {}) });
  assert.deepEqual(checked, ["acct-1"]);
  assert.deepEqual(prepared, ["acct-1"]);
});

test("a multi-user session start needs the GitHub link recheck, and waits for a reset the recheck started", async () => {
  assert.throws(() => createSessionStart({ config: CONFIG, runtime: {} }), /GitHub link recheck/);
  const events = [];
  let finishReset;
  const resetting = new Promise((resolve) => { finishReset = resolve; });
  const hooks = { settled: async (id) => { events.push(`settled ${id}`); await resetting; events.push("reset done"); } };
  const runtime = { prepare: async (id) => { events.push(`prepare ${id}`); return { realm: {}, launch: () => ({}) }; } };
  const start = createSessionStart({ config: CONFIG, runtime, hooks, githubLink: { sessionRefusal: async () => { events.push("recheck"); return null; } } });
  const started = start({ auth: AUTH });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["recheck", "settled acct-1"], "no realm is prepared while the account's reset runs");
  finishReset();
  await started;
  assert.deepEqual(events, ["recheck", "settled acct-1", "reset done", "prepare acct-1"]);
});

// A launched child that writes `stderr`, prints `stdout` and exits. Like a real child, its "close" waits for both
// streams to be read, so a desk-init whose stderr nobody drains never closes.
function childPrinting(stdout, { stderr = "desk-init: progress\n", hang = false } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough({ highWaterMark: 1 }),
    stdin: new PassThrough(),
    killed: null,
    kill(signal) { child.killed = signal; setImmediate(() => child.emit("close", null, signal)); },
  });
  if (hang) return child;
  setImmediate(async () => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    await Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
    child.emit("close", 0);
  });
  return child;
}

function linkFixture({ stdout = '{"status":"created"}\n', child, release } = {}) {
  const events = [];
  const parts = { accounts: { forget: (id) => events.push(`forget ${id}`) } };
  const relay = { closeAccount: (id) => events.push(`close ${id}`) };
  const runtime = {
    release: release ?? (async (id, options) => { events.push(options?.discard ? `discard ${id}` : `release ${id}`); }),
    prepare: async (id) => {
      events.push(`prepare ${id}`);
      return {
        launch: (args) => { events.push(["launch", args]); return child?.() ?? childPrinting(stdout); },
        push: async () => { events.push("push"); },
      };
    },
  };
  const hooks = createLinkHooks({ config: CONFIG, parts, runtime, relay: () => relay, timeoutMs: 200, log: (line) => events.push(line) });
  return { hooks, events };
}

test("relinking drops the account's cached row, sessions and prepared realm", async () => {
  const { hooks, events } = linkFixture();
  hooks.onLinked("acct-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["forget acct-1", "close acct-1", "release acct-1"]);
});

test("initDesk runs desk-init in a fresh realm from the new binding, with no path on its command line, and pushes what it made", async () => {
  const { hooks, events } = linkFixture();
  assert.deepEqual(await hooks.initDesk({ accountId: "acct-1" }), { status: "created" });
  assert.deepEqual(events, ["forget acct-1", "close acct-1", "release acct-1", "prepare acct-1", ["launch", deskInitArgs(CONFIG)], "push"]);
  assert.deepEqual(deskInitArgs(CONFIG), ["/app/plugins/desk/mcp/scripts/desk-init.js"]);
});

test("initDesk returns desk-init's refusal for an existing desk without pushing, keeping the realm, and discards any other refusal", async () => {
  const existing = linkFixture({ stdout: '{"status":"refused","reason":"already_a_desk"}\n' });
  assert.deepEqual(await existing.hooks.initDesk({ accountId: "acct-1" }), { status: "refused", reason: "already_a_desk" });
  assert.ok(!existing.events.includes("push"));
  assert.ok(!existing.events.includes("discard acct-1"), "an existing desk's realm (and any session in it) stays");
  const other = linkFixture({ stdout: '{"status":"refused","reason":"not_empty","step":"check"}\n' });
  await other.hooks.initDesk({ accountId: "acct-1" });
  assert.equal(other.events.at(-1), "discard acct-1");
});

test("a desk-init that fails, prints nothing or runs too long leaves its realm discarded, never pushed", async () => {
  for (const [name, fixture, error] of [
    ["silent", linkFixture({ stdout: "" }), /no result/],
    ["garbled", linkFixture({ stdout: "not json\n" }), SyntaxError],
    ["hung", linkFixture({ child: () => childPrinting("", { hang: true }) }), /did not finish in time/],
  ]) {
    await assert.rejects(fixture.hooks.initDesk({ accountId: "acct-1" }), error, name);
    assert.ok(!fixture.events.includes("push"), `${name}: nothing is pushed`);
    assert.equal(fixture.events.at(-1), "discard acct-1", `${name}: the realm is discarded`);
  }
});

test("a desk-init that writes a lot to stderr still finishes", async () => {
  const { hooks, events } = linkFixture({ child: () => childPrinting('{"status":"created"}\n', { stderr: "x".repeat(256 * 1024) }) });
  assert.deepEqual(await hooks.initDesk({ accountId: "acct-1" }), { status: "created" });
  assert.equal(events.at(-1), "push");
});

test("settled waits for a relink's reset, and a failed release is logged rather than thrown", async () => {
  let finish;
  const { hooks, events } = linkFixture({ release: () => new Promise((_, reject) => { finish = () => reject(Object.assign(new Error("x"), { code: "DESK_SESSION_REFUSED" })); }) });
  hooks.onLinked("acct-1");
  let settled = false;
  const waiting = hooks.settled("acct-1").then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "settled waits while the release runs");
  finish();
  await waiting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((line) => typeof line === "string" && /could not be released \(DESK_SESSION_REFUSED\)/.test(line)));
  await hooks.settled("acct-1");
});

const ADMIN_CLI = { DESK_ADMIN_CLIENT_ID: "20a65c9b-2fe5-45c1-8af9-79b4e22b958c", DESK_ADMIN_SCOPE: `api://${CLIENT_ID}/desk.admin` };

test("a multi-user gateway publishes the ouro CLI's admin sign-in settings at /.well-known/ouro-desk-admin", async (t) => {
  const { base } = await gateway(t, { ...ENV, ...ADMIN_CLI, DESK_MULTI_USER: "1" });
  const response = await fetch(`${base}/.well-known/ouro-desk-admin`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { tenantId: TENANT_ID, subdomain: SUBDOMAIN, clientId: ADMIN_CLI.DESK_ADMIN_CLIENT_ID, scope: ADMIN_CLI.DESK_ADMIN_SCOPE });
});

test("the admin sign-in settings are absent with the multi-user switch off, and on a multi-user gateway without them", async (t) => {
  for (const env of [{ ...ENV, ...ADMIN_CLI }, { ...ENV, DESK_MULTI_USER: "1" }]) {
    const { base } = await gateway(t, env);
    assert.equal((await fetch(`${base}/.well-known/ouro-desk-admin`)).status, 404);
  }
});

test("the admin sign-in settings are refused at start unless both are set, the client is a GUID and the scope is the gateway app's", () => {
  const multi = { ...ENV, DESK_MULTI_USER: "1" };
  assert.throws(() => readConfig({ ...multi, DESK_ADMIN_CLIENT_ID: ADMIN_CLI.DESK_ADMIN_CLIENT_ID }), /DESK_ADMIN_SCOPE/);
  assert.throws(() => readConfig({ ...multi, DESK_ADMIN_SCOPE: ADMIN_CLI.DESK_ADMIN_SCOPE }), /DESK_ADMIN_CLIENT_ID/);
  assert.throws(() => readConfig({ ...multi, ...ADMIN_CLI, DESK_ADMIN_CLIENT_ID: "ouro-cli" }), /GUID/);
  assert.throws(() => readConfig({ ...multi, ...ADMIN_CLI, DESK_ADMIN_SCOPE: "api://55555555-5555-5555-5555-555555555555/desk.admin" }), /gateway app/);
  assert.throws(() => readConfig({ ...multi, ...ADMIN_CLI, DESK_ADMIN_SCOPE: `api://${CLIENT_ID}/desk admin` }), /gateway app/);
  assert.deepEqual(readConfig({ ...multi, ...ADMIN_CLI }).identity.adminCli, { clientId: ADMIN_CLI.DESK_ADMIN_CLIENT_ID, scope: ADMIN_CLI.DESK_ADMIN_SCOPE });
});
