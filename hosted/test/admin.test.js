// The admin routes (spec item 16): invites, access on and off, and deleting an account, for a bearer token from the
// Ouro tenant that carries the `ouro.admin` app role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken, INVITE_TTL_MS } from "../src/accounts/invites.js";
import { TENANT_ID } from "./fixtures/stub-tenant.mjs";
import { newSigningKey } from "./fixtures/stub-tenant.mjs";
import { ARI_OID, CLI_CLIENT_ID, GATEWAY, START, adminCall, adminToken, browser, pageSignIn, startAccountGateway } from "./fixtures/account-gateway.mjs";

const NEW_OID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER_OID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

test("admin route without ouro.admin role is 403", async (t) => {
  const ctx = await startAccountGateway(t);
  const token = await adminToken(ctx, { roles: [] });
  for (const [method, path, body] of [
    ["POST", "/admin/invites", { displayName: "Someone" }],
    ["POST", `/admin/accounts/${ctx.accountId}/access`, { on: false }],
    ["DELETE", `/admin/accounts/${ctx.accountId}`],
  ]) {
    const refused = await adminCall(ctx, method, path, { token, body });
    assert.equal(refused.status, 403, `${method} ${path}`);
    assert.equal(refused.json.error, "forbidden");
  }
  assert.equal((await adminCall(ctx, "POST", "/admin/invites", { token: await adminToken(ctx, { roles: ["ouro.reader"] }), body: { displayName: "x" } })).status, 403);
  assert.equal((await adminCall(ctx, "POST", "/admin/invites", { token: await adminToken(ctx, { claims: { roles: "ouro.admin" } }), body: { displayName: "x" } })).status, 403, "roles must be a list");
  assert.equal((await adminCall(ctx, "POST", "/admin/invites", { token: await adminToken(ctx, { claims: { roles: undefined } }), body: { displayName: "x" } })).status, 403, "no roles claim");
  assert.equal((await ctx.store.getAccount(ctx.accountId)).deskAccess, true);
});

test("an admin route refuses a missing, malformed, foreign or non-access token with 401", async (t) => {
  const ctx = await startAccountGateway(t);
  const missing = await adminCall(ctx, "POST", "/admin/invites", { body: { displayName: "x" } });
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate"), /^Bearer/);
  const stranger = await newSigningKey("stranger-key");
  const iat = Math.floor(ctx.now() / 1000);
  const base = { ver: "2.0", iss: (await import("./fixtures/stub-tenant.mjs")).ISSUER, aud: (await import("./fixtures/stub-tenant.mjs")).CLIENT_ID, tid: TENANT_ID, iat, nbf: iat, exp: iat + 3600, oid: ARI_OID, azp: CLI_CLIENT_ID, roles: ["ouro.admin"] };
  const bad = {
    malformed: "not-a-jwt",
    "signed by another key": await ctx.tenant.idToken(base, { key: stranger }),
    "for another app": await adminToken(ctx, { claims: { aud: "11111111-2222-4333-8444-555555555555" } }),
    "from another tenant": await adminToken(ctx, { claims: { tid: "11111111-2222-4333-8444-555555555555" } }),
    expired: await adminToken(ctx, { claims: { exp: iat - 600, nbf: iat - 4000, iat: iat - 4000 } }),
    "an ID token (it carries a nonce)": await adminToken(ctx, { claims: { nonce: "n" } }),
    "without azp": await adminToken(ctx, { claims: { azp: undefined } }),
    "app-only (no delegated scope)": await adminToken(ctx, { claims: { scp: undefined } }),
  };
  for (const [what, token] of Object.entries(bad)) {
    const refused = await adminCall(ctx, "POST", "/admin/invites", { token, body: { displayName: "x" } });
    assert.equal(refused.status, 401, what);
  }
  for (const line of ctx.logs) for (const token of Object.values(bad)) assert.ok(!line.includes(token), `log leaks a token: ${line}`);
});

test("an invite for a new person creates their account and returns a single-use link that expires in 7 days", async (t) => {
  const ctx = await startAccountGateway(t);
  const token = await adminToken(ctx);
  const created = await adminCall(ctx, "POST", "/admin/invites", { token, body: { displayName: "Jordan" } });
  assert.equal(created.status, 201, created.text);
  const { accountId, inviteUrl, expiresAt } = created.json;
  assert.match(accountId, /^[0-9a-f-]{36}$/);
  assert.ok(inviteUrl.startsWith(`${GATEWAY}/invite/`));
  assert.equal(Date.parse(expiresAt), START + INVITE_TTL_MS);
  assert.deepEqual(await ctx.store.getAccount(accountId), { accountId, displayName: "Jordan", deskAccess: true });
  assert.equal(await ctx.store.getBinding(accountId), null);
  const inviteToken = inviteUrl.slice(`${GATEWAY}/invite/`.length);
  assert.equal((await ctx.store.getInvite(hashToken(inviteToken))).accountId, accountId);
  assert.equal(created.headers.get("cache-control"), "no-store");
  for (const line of ctx.logs) assert.ok(!line.includes(inviteToken) && !line.includes("Jordan"), `log leaks: ${line}`);
});

test("a re-invite goes to an account nobody has signed in to yet; an unknown account is 404; a bad body is 400", async (t) => {
  const ctx = await startAccountGateway(t);
  const token = await adminToken(ctx);
  const first = await adminCall(ctx, "POST", "/admin/invites", { token, body: { displayName: "Jordan" } });
  const again = await adminCall(ctx, "POST", "/admin/invites", { token, body: { accountId: first.json.accountId } });
  assert.equal(again.status, 201);
  assert.equal(again.json.accountId, first.json.accountId);
  const signedIn = await adminCall(ctx, "POST", "/admin/invites", { token, body: { accountId: ctx.accountId } });
  assert.equal(signedIn.status, 409, "Ari has signed in, so a second invite would add a second person's sign-in");
  assert.equal((await adminCall(ctx, "POST", "/admin/invites", { token, body: { accountId: "no-such-account" } })).status, 404);
  for (const body of [{}, { displayName: "" }, { displayName: 7 }, { displayName: "x".repeat(101) }, { displayName: "Jo\nrdan" }, { displayName: "Jo <x@y>" }, { accountId: "../x" }, []]) {
    assert.equal((await adminCall(ctx, "POST", "/admin/invites", { token, body })).status, 400, JSON.stringify(body));
  }
});

test("invite issued by admin redeems once then inviteRefusedPage", async (t) => {
  const ctx = await startAccountGateway(t);
  const created = await adminCall(ctx, "POST", "/admin/invites", { token: await adminToken(ctx), body: { displayName: "Jordan" } });
  const path = new URL(created.json.inviteUrl).pathname;
  // Two browsers open the link before either signs in.
  const first = browser(ctx);
  const second = browser(ctx);
  await first.request(path);
  await second.request(path);
  const redeemed = await pageSignIn(ctx, first, { oid: NEW_OID });
  assert.equal(redeemed.status, 303);
  assert.equal(await ctx.store.findIdentity(TENANT_ID, NEW_OID), created.json.accountId);
  const refused = await pageSignIn(ctx, second, { oid: OTHER_OID });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /already been used or has expired/);
  assert.equal(await ctx.store.findIdentity(TENANT_ID, OTHER_OID), null);
});

test("access off refuses next /authorize with accessOffPage", async (t) => {
  const ctx = await startAccountGateway(t);
  const token = await adminToken(ctx);
  const off = await adminCall(ctx, "POST", `/admin/accounts/${ctx.accountId}/access`, { token, body: { on: false } });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.json, { accountId: ctx.accountId, deskAccess: false });
  assert.deepEqual(ctx.forgotten, [ctx.accountId], "the account cache drops the row so open sessions see it at once");
  // The next sign-in from a client, through the tenant, ends at the access-off page.
  const jar = {};
  const begun = ctx.entra.begin({ clientId: "client-1", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "c", state: "s", scopes: ["desk"], aud: `${GATEWAY}/mcp` }, jar);
  for (const header of begun.setCookies) {
    const [pair] = header.split(";");
    jar[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
  }
  const url = new URL(begun.redirectTo);
  const outcome = await ctx.entra.callback({ code: ctx.tenant.authorize(url, { oid: ARI_OID }), state: url.searchParams.get("state"), cookies: jar });
  assert.equal(outcome.status, 403);
  assert.match(outcome.html, /Desk access is turned off/);

  const on = await adminCall(ctx, "POST", `/admin/accounts/${ctx.accountId}/access`, { token, body: { on: true } });
  assert.deepEqual(on.json, { accountId: ctx.accountId, deskAccess: true });
  assert.equal((await ctx.store.getAccount(ctx.accountId)).displayName, "Ari Mendelow", "turning access on keeps the name");
});

test("access needs a boolean and a known account", async (t) => {
  const ctx = await startAccountGateway(t);
  const token = await adminToken(ctx);
  assert.equal((await adminCall(ctx, "POST", `/admin/accounts/${ctx.accountId}/access`, { token, body: { on: "false" } })).status, 400);
  assert.equal((await adminCall(ctx, "POST", "/admin/accounts/no-such-account/access", { token, body: { on: false } })).status, 404);
  assert.equal((await adminCall(ctx, "POST", "/admin/accounts/bad%2Fid/access", { token, body: { on: false } })).status, 400);
});

test("deleting an account removes its account, identities, binding and invites, and its desk", async (t) => {
  const ctx = await startAccountGateway(t);
  const token = await adminToken(ctx);
  const created = await adminCall(ctx, "POST", "/admin/invites", { token, body: { displayName: "Jordan" } });
  const { accountId } = created.json;
  // A second invite, still unused when the account is deleted.
  const pending = await adminCall(ctx, "POST", "/admin/invites", { token, body: { accountId } });
  assert.equal(pending.status, 201);
  const jordan = browser(ctx);
  await jordan.request(new URL(created.json.inviteUrl).pathname);
  await pageSignIn(ctx, jordan, { oid: NEW_OID });
  await ctx.store.putBinding(accountId, { kind: "github", repo: "jordan/desk", author: { name: "Jordan", email: `${accountId}@users.desk.ouro.bot` } });
  const deleted = await adminCall(ctx, "DELETE", `/admin/accounts/${accountId}`, { token });
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(deleted.json, { accountId, deleted: true, deskRemoved: true });
  assert.equal(await ctx.store.getAccount(accountId), null);
  assert.equal(await ctx.store.getBinding(accountId), null);
  assert.equal(await ctx.store.findIdentity(TENANT_ID, NEW_OID), null);
  assert.equal(await ctx.store.getInvite(hashToken(new URL(pending.json.inviteUrl).pathname.split("/").pop())), null);
  assert.deepEqual(ctx.deleted, [accountId]);
  assert.ok(ctx.forgotten.includes(accountId));
  assert.equal((await jordan.request("/account")).status, 303, "the deleted account's session no longer works");
  // Ari's rows are untouched.
  assert.equal((await ctx.store.getAccount(ctx.accountId)).deskAccess, true);
  assert.equal(await ctx.store.findIdentity(TENANT_ID, ARI_OID), ctx.accountId);
  assert.equal((await adminCall(ctx, "DELETE", `/admin/accounts/${accountId}`, { token })).status, 404);
});

test("an admin can't delete their own account", async (t) => {
  const ctx = await startAccountGateway(t);
  const refused = await adminCall(ctx, "DELETE", `/admin/accounts/${ctx.accountId}`, { token: await adminToken(ctx) });
  assert.equal(refused.status, 409);
  assert.equal((await ctx.store.getAccount(ctx.accountId)).deskAccess, true);
});

test("admin calls are logged by account id only", async (t) => {
  const ctx = await startAccountGateway(t);
  const token = await adminToken(ctx);
  await adminCall(ctx, "POST", `/admin/accounts/${ctx.accountId}/access`, { token, body: { on: false } });
  assert.ok(ctx.logs.some((line) => line.includes(`access off account ${ctx.accountId}`) && line.includes(`by account ${ctx.accountId}`)), ctx.logs.join("\n"));
  for (const line of ctx.logs) assert.ok(!line.includes(ARI_OID) && !line.includes(token), `log leaks: ${line}`);
});

test("without the tenant's discovery loaded, admin routes answer 503 and don't send the admin to sign in again", async (t) => {
  const ctx = await startAccountGateway(t, { discoveryDown: true });
  assert.equal(ctx.discovery.ready(), false);
  const refused = await adminCall(ctx, "POST", "/admin/invites", { token: await adminToken(ctx), body: { displayName: "Jordan" } });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error, "unavailable");
  assert.equal(refused.headers.get("www-authenticate"), null);
});

test("a body that isn't JSON is 400, not an HTML error page", async (t) => {
  const ctx = await startAccountGateway(t);
  const response = await fetch(`${ctx.base}/admin/invites`, { method: "POST", headers: { authorization: `Bearer ${await adminToken(ctx)}`, "content-type": "application/json" }, body: "{not json" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "bad_request");
});
