// The browser session for the gateway's own pages (spec item 18): page sign-in through the Ouro tenant, the session
// cookie, its 12-hour life, its CSRF checks, and sign-in started in one browser but finished in another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_COOKIE, safeNext } from "../src/auth/browser-session.js";
import { INVITE_COOKIE } from "../src/auth/entra.js";
import { issueInvite, hashToken } from "../src/accounts/invites.js";
import { ARI_OID, START, browser, pageSignIn, startAccountGateway } from "./fixtures/account-gateway.mjs";

const NEW_OID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const sessionCookieOf = (setCookies) => setCookies.find((header) => header.startsWith(`${SESSION_COOKIE}=`));

test("session cookie attributes", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  const back = await pageSignIn(ctx, ari, { oid: ARI_OID });
  assert.equal(back.status, 303);
  assert.equal(back.location, "/account");
  const cookie = sessionCookieOf(back.setCookies);
  assert.ok(cookie, "the callback starts a session");
  for (const attribute of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Max-Age=43200/, /Path=\//]) assert.match(cookie, attribute);
  assert.doesNotMatch(cookie, /Domain=/i);
  const account = await ari.request("/account");
  assert.equal(account.status, 200);
  assert.match(account.text, /Ari Mendelow/);
  assert.equal(account.response.headers.get("cache-control"), "no-store");
});

test("a page without a session sends the browser to sign in, then back to that page", async (t) => {
  const ctx = await startAccountGateway(t);
  const stranger = browser(ctx);
  const refused = await stranger.request("/account");
  assert.equal(refused.status, 303);
  assert.equal(refused.location, "/signin?next=%2Faccount");
});

test("sign-in returns only to a path on the gateway", () => {
  assert.equal(safeNext("/link/github"), "/link/github");
  assert.equal(safeNext("/account"), "/account");
  for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "/a//b", "javascript:alert(1)", "", undefined, "/x?y=1", "/x#y", `/${"a".repeat(300)}`]) {
    assert.equal(safeNext(bad), "/account", String(bad));
  }
});

test("expired session after 12h requires sign-in", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  await pageSignIn(ctx, ari, { oid: ARI_OID });
  ctx.advance(12 * 3600 * 1000 - 1000);
  assert.equal((await ari.request("/account")).status, 200);
  ctx.advance(2000);
  const expired = await ari.request("/account");
  assert.equal(expired.status, 303);
  assert.match(expired.location, /^\/signin\?next=/);
});

test("a tampered or forged session cookie is no session", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  await pageSignIn(ctx, ari, { oid: ARI_OID });
  const value = ari.jar.get(SESSION_COOKIE);
  ari.jar.set(SESSION_COOKIE, `${value.slice(0, -2)}AA`);
  assert.equal((await ari.request("/account")).status, 303);
  const forged = Buffer.from(JSON.stringify({ accountId: ctx.accountId, sid: "x", kind: "browser-session" })).toString("base64url");
  ari.jar.set(SESSION_COOKIE, `${forged}.AAAA`);
  assert.equal((await ari.request("/account")).status, 303);
});

test("a session ends when its account's access is turned off or the account is deleted", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  await pageSignIn(ctx, ari, { oid: ARI_OID });
  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: false });
  assert.equal((await ari.request("/account")).status, 303);
  assert.equal(await ctx.sessions.require({ headers: { cookie: `${SESSION_COOKIE}=${ari.jar.get(SESSION_COOKIE)}` } }), null);
});

test("an account whose access is off gets the access-off page and no session", async (t) => {
  const ctx = await startAccountGateway(t);
  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: false });
  const ari = browser(ctx);
  const back = await pageSignIn(ctx, ari, { oid: ARI_OID });
  assert.equal(back.status, 403);
  assert.match(back.text, /Desk access is turned off/);
  assert.equal(sessionCookieOf(back.setCookies), undefined);
});

test("POST without csrf is 403", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  await pageSignIn(ctx, ari, { oid: ARI_OID });
  const refused = await ari.request("/signout", { method: "POST", form: {} });
  assert.equal(refused.status, 403);
  assert.ok(ari.jar.has(SESSION_COOKIE), "a refused sign-out keeps the session");
});

test("a csrf token from another session, or a post from another site, is 403", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  const other = browser(ctx);
  await pageSignIn(ctx, ari, { oid: ARI_OID });
  await pageSignIn(ctx, other, { oid: ARI_OID });
  const otherCsrf = /name="csrf" value="([^"]+)"/.exec((await other.request("/account")).text)[1];
  assert.equal((await ari.request("/signout", { method: "POST", form: { csrf: otherCsrf } })).status, 403);
  const ownCsrf = /name="csrf" value="([^"]+)"/.exec((await ari.request("/account")).text)[1];
  assert.equal((await ari.request("/signout", { method: "POST", form: { csrf: ownCsrf }, site: "cross-site" })).status, 403);
  assert.equal((await ari.request("/signout", { method: "POST", form: { csrf: ownCsrf }, site: null, headers: { origin: "https://evil.example" } })).status, 403);
  assert.ok(ari.jar.has(SESSION_COOKIE));
});

test("sign-out with the page's csrf token ends the session", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  await pageSignIn(ctx, ari, { oid: ARI_OID });
  const csrf = /name="csrf" value="([^"]+)"/.exec((await ari.request("/account")).text)[1];
  const out = await ari.request("/signout", { method: "POST", form: { csrf } });
  assert.equal(out.status, 200);
  assert.match(out.text, /signed out/i);
  assert.ok(!ari.jar.has(SESSION_COOKIE));
  assert.equal((await ari.request("/account")).status, 303);
});

test("a new person signs in through their invite and gets a session; without one they get the invite-only page", async (t) => {
  const ctx = await startAccountGateway(t);
  await ctx.store.putAccount({ accountId: "invitee-1", displayName: "Invitee", deskAccess: true });
  const { token } = await issueInvite({ store: ctx.store, accountId: "invitee-1", now: START });
  const uninvited = browser(ctx);
  const refused = await pageSignIn(ctx, uninvited, { oid: NEW_OID });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /invite-only/);

  const invitee = browser(ctx);
  await invitee.request(`/invite/${token}`);
  const back = await pageSignIn(ctx, invitee, { oid: NEW_OID });
  assert.equal(back.status, 303);
  assert.ok(sessionCookieOf(back.setCookies));
  assert.ok(!invitee.jar.has(INVITE_COOKIE), "the redeemed invite's cookie is cleared");
  assert.equal((await ctx.store.getInvite(hashToken(token))).redeemed, true);
  assert.equal(await ctx.store.findIdentity((await import("./fixtures/stub-tenant.mjs")).TENANT_ID, NEW_OID), "invitee-1");
  for (const line of ctx.logs) assert.ok(!line.includes(token) && !line.includes(NEW_OID), `log leaks: ${line}`);
});

test("invite opened in another browser shows startAgainPage and stays unused", async (t) => {
  const ctx = await startAccountGateway(t);
  await ctx.store.putAccount({ accountId: "invitee-1", displayName: "Invitee", deskAccess: true });
  const { token } = await issueInvite({ store: ctx.store, accountId: "invitee-1", now: START });
  // Sign-in starts in the laptop's browser; the invite was opened, and the tenant's redirect lands, in the phone's.
  const laptop = browser(ctx);
  const phone = browser(ctx);
  await phone.request(`/invite/${token}`);
  assert.ok(phone.jar.has(INVITE_COOKIE));
  const back = await pageSignIn(ctx, laptop, { oid: NEW_OID, callbackIn: phone });
  assert.equal(back.status, 400);
  assert.match(back.text, /started in another browser/);
  assert.equal(sessionCookieOf(back.setCookies), undefined);
  const invite = await ctx.store.getInvite(hashToken(token));
  assert.equal(invite.redeemed, false);
  assert.equal(await ctx.store.findIdentity((await import("./fixtures/stub-tenant.mjs")).TENANT_ID, NEW_OID), null);
  // The invite still works in the browser that holds it.
  const retried = await pageSignIn(ctx, phone, { oid: NEW_OID });
  assert.equal(retried.status, 303);
});

test("a cancelled page sign-in shows a page, not a redirect to a client", async (t) => {
  const ctx = await startAccountGateway(t);
  const ari = browser(ctx);
  const begun = await ari.request("/signin?next=%2Faccount");
  const url = new URL(begun.location);
  const back = await ari.request(`/oauth/entra/callback?error=access_denied&state=${encodeURIComponent(url.searchParams.get("state"))}`, { site: "cross-site" });
  assert.equal(back.status, 400);
  assert.equal(sessionCookieOf(back.setCookies), undefined);
});
