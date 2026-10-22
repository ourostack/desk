// The multi-user gateway's account surfaces, wired by main.js: one browser session shared by the Ouro tenant's page
// sign-in and the gateway's pages, and the admin routes, whose account changes reach the account cache and the
// account's realm. Runs against the stub tenant and the in-memory store; no test reaches the network or needs Linux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { buildGateway, createGatewayAdmin, readConfig, startIdentity } from "../src/main.js";
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
  const admin = config.multiUser ? createGatewayAdmin({ config, parts, fetch: tenant.fetch, onAccountDeleted: async (id) => deleted.push(id) }) : undefined;
  const relay = { handle: (_req, res) => res.status(204).end() };
  const { app } = buildGateway({ config, relay, parts, admin, log: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    parts.discovery.stop();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, parts, deleted, tenant };
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

test("the gateway's admin forgets a changed account in the account cache and hands a deleted one to its realm", async (t) => {
  const { base, parts, deleted, tenant } = await gateway(t, { ...ENV, DESK_MULTI_USER: "1" });
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
  assert.deepEqual(deleted, [target], "the deleted account's realm is purged");
});
