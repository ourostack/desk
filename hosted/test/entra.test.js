// Sign-in through the Ouro tenant (spec item 9): discovery, the per-sign-in cookie, the Entra callback and the
// invite pages, against a stub tenant and the in-memory accounts store. No test reaches the network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { seal, unseal } from "../src/auth/seal.js";
import { createDiscovery, createEntraSignIn, createInvites } from "../src/auth/entra.js";
import { createSigninCookies, parseCookies, SIGNIN_COOKIE_PREFIX } from "../src/auth/signin-cookie.js";
import { consentPage } from "../src/auth/pages.js";
import { createProvider } from "../src/auth/provider.js";
import { createApp } from "../src/server.js";
import { createMemoryStore } from "../src/accounts/memory-store.js";
import { seed, issueInvite, newInvite } from "../src/accounts/invites.js";
import { stubTenant, DISCOVERY, DISCOVERY_URL, ISSUER, TENANT_ID, SUBDOMAIN, CLIENT_ID, CLIENT_SECRET } from "./fixtures/stub-tenant.mjs";

const KEY = "test-key-0123456789abcdef0123456789abcdef";
const GATEWAY = "https://desk.ouro.bot";
const RESOURCE = `${GATEWAY}/mcp`;
const CALLBACK = `${GATEWAY}/oauth/entra/callback`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const REPO = "arimendelow/desk";
const START = Date.parse("2026-11-01T00:00:00Z");
const BINDING = { kind: "github", repo: REPO, installationId: 12345678, author: { name: "Ari Mendelow", email: "16390116+arimendelow@users.noreply.github.com" } };
const PENDING = { clientId: "client-1", redirectUri: CLAUDE_CALLBACK, codeChallenge: "client-challenge", state: "client-state", scopes: ["desk"], aud: RESOURCE };

// Every module logs here; after each test no line may carry a secret, code, token, oid, name or invite token.
const logs = [];
const secrets = new Set([CLIENT_SECRET, "Ari Mendelow", "ari@example.com"]);
afterEach(() => {
  for (const line of logs) for (const secret of secrets) assert.ok(!line.includes(secret), `log line leaks a secret: ${line}`);
  logs.length = 0;
});
const log = (line) => logs.push(line);

// A browser's cookie jar: applies Set-Cookie headers and hands back what the browser would send.
function browser() {
  const jar = new Map();
  return {
    jar,
    apply(setCookies = []) {
      for (const header of setCookies) {
        const [pair] = header.split(";");
        const name = pair.slice(0, pair.indexOf("="));
        if (/;\s*Max-Age=0(;|$)/i.test(header)) jar.delete(name);
        else jar.set(name, pair.slice(pair.indexOf("=") + 1));
      }
    },
    cookies: () => Object.fromEntries(jar),
  };
}

async function setup({ discoveryDown = false, retryMs = 30_000 } = {}) {
  let clock = START;
  const now = () => clock;
  const tenant = await stubTenant({ now });
  tenant.state.discoveryDown = discoveryDown;
  const discovery = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, fetch: tenant.fetch, retryMs, log });
  await discovery.start();
  const store = createMemoryStore();
  const { accountId } = await seed({ store, displayName: "Ari Mendelow", binding: BINDING });
  const entra = createEntraSignIn({
    key: KEY,
    discovery,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUrl: CALLBACK,
    store,
    repo: REPO,
    fetch: tenant.fetch,
    now,
    log,
  });
  const invites = createInvites({ key: KEY, store, now, log });
  return { tenant, discovery, store, accountId, entra, invites, now, advance: (ms) => (clock += ms) };
}

// Begins a sign-in in `who`'s browser and returns what the tenant's redirect back would carry.
function beginIn(ctx, who, pending = PENDING) {
  const outcome = ctx.entra.begin(pending, who.cookies());
  assert.ok(outcome.redirectTo, `begin gave a page: ${outcome.html}`);
  who.apply(outcome.setCookies);
  return new URL(outcome.redirectTo);
}

function codeIn(outcome) {
  assert.ok(outcome.redirectTo, `expected a redirect, got ${outcome.status}: ${outcome.html}`);
  const back = new URL(outcome.redirectTo);
  return { back, code: back.searchParams.get("code") && unseal("code", back.searchParams.get("code"), { key: KEY, now: START }) };
}

async function signIn(ctx, who, { oid, claims, pending } = {}) {
  const url = beginIn(ctx, who, pending);
  const code = ctx.tenant.authorize(url, { oid, claims });
  const outcome = await ctx.entra.callback({ code, state: url.searchParams.get("state"), cookies: who.cookies() });
  who.apply(outcome.clearCookies);
  return outcome;
}

async function identityFor(ctx, oid) {
  await ctx.store.tables.create("identities", { partitionKey: TENANT_ID, rowKey: oid, accountId: ctx.accountId });
}

const OID = "4f6c1d2e-8b9a-4c3d-9e8f-7a6b5c4d3e2f";

// ---- discovery ----

test("discovery reads the tenant's document and expects the issuer on the tenant id's host", async () => {
  const ctx = await setup();
  assert.equal(ctx.discovery.ready(), true);
  assert.deepEqual(ctx.discovery.get(), {
    issuer: `https://${TENANT_ID}.ciamlogin.com/${TENANT_ID}/v2.0`,
    authorizationEndpoint: DISCOVERY.authorization_endpoint,
    tokenEndpoint: DISCOVERY.token_endpoint,
    jwksUri: DISCOVERY.jwks_uri,
  });
  assert.equal(ctx.tenant.calls.discovery, 1);
  assert.ok(DISCOVERY_URL.startsWith(`https://${SUBDOMAIN}.ciamlogin.com/`));
});

test("refuses to start when the fetched issuer differs", async () => {
  const tenant = await stubTenant();
  // The tenant-name form of the issuer is what a builder from the endpoints' host would get wrong.
  tenant.state.discovery = { ...DISCOVERY, issuer: `https://${SUBDOMAIN}.ciamlogin.com/${TENANT_ID}/v2.0` };
  const discovery = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, fetch: tenant.fetch, log });
  await assert.rejects(discovery.start(), /issuer/);
  assert.equal(discovery.ready(), false);
  discovery.stop();
  const pinned = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, expectedIssuer: ISSUER, fetch: (await stubTenant()).fetch, log });
  await pinned.start();
  assert.equal(pinned.ready(), true);
});

test("starts when the document can't be fetched, refuses Entra sign-in with the try-again page, and accepts it once a retry loads the document", async () => {
  const ctx = await setup({ discoveryDown: true, retryMs: 5 });
  try {
    assert.equal(ctx.discovery.ready(), false);
    const refused = ctx.entra.begin(PENDING, {});
    assert.equal(refused.status, 503);
    assert.match(refused.html, /try again shortly/i);
    assert.equal(refused.redirectTo, undefined);
    assert.ok(logs.some((line) => /discovery/.test(line)));
    ctx.tenant.state.discoveryDown = false;
    for (let i = 0; i < 200 && !ctx.discovery.ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ctx.discovery.ready(), true);
    const fetchesWhenReady = ctx.tenant.calls.discovery;
    assert.ok(fetchesWhenReady >= 2);
    assert.match(ctx.entra.begin(PENDING, {}).redirectTo, /^https:\/\/ourobottest\.ciamlogin\.com\//);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.tenant.calls.discovery, fetchesWhenReady, "no more fetches once loaded");
  } finally {
    ctx.discovery.stop();
  }
});

test("a document with a non-https endpoint is not used and is retried", async () => {
  const tenant = await stubTenant();
  tenant.state.discovery = { ...DISCOVERY, token_endpoint: "http://ourobottest.ciamlogin.com/token" };
  const discovery = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, fetch: tenant.fetch, retryMs: 60_000, log });
  await discovery.start();
  assert.equal(discovery.ready(), false);
  discovery.stop();
});

// ---- the per-sign-in cookie ----

test("the signin cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/ and lives 10 minutes", () => {
  const cookies = createSigninCookies({ key: KEY, now: () => START });
  const begun = cookies.begin({});
  assert.match(begun.stateId, /^[A-Za-z0-9_-]{22,}$/);
  assert.equal(begun.challenge, createHash("sha256").update(begun.verifier).digest("base64url"));
  assert.equal(begun.setCookies.length, 1);
  const [header] = begun.setCookies;
  assert.ok(header.startsWith(`${SIGNIN_COOKIE_PREFIX}${begun.stateId}=`));
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) assert.ok(header.split("; ").includes(attribute), `missing ${attribute}`);
  assert.ok(!/Domain=/i.test(header));
  const jar = browser();
  jar.apply(begun.setCookies);
  assert.deepEqual(cookies.take(begun.stateId, jar.cookies()), { verifier: begun.verifier, nonce: begun.nonce });
  assert.equal(cookies.take("another-state-id-0000000", jar.cookies()), null);
  // Expired after 10 minutes.
  const later = createSigninCookies({ key: KEY, now: () => START + 601_000 });
  assert.equal(later.take(begun.stateId, jar.cookies()), null);
  // A cookie copied under another sign-in's name is refused.
  const other = cookies.begin({});
  assert.equal(cookies.take(other.stateId, { [`${SIGNIN_COOKIE_PREFIX}${other.stateId}`]: jar.cookies()[`${SIGNIN_COOKIE_PREFIX}${begun.stateId}`] }), null);
});

test("a browser holds at most 5 signin cookies, the oldest dropped", () => {
  let clock = START;
  const cookies = createSigninCookies({ key: KEY, now: () => clock });
  const jar = browser();
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const begun = cookies.begin(jar.cookies());
    jar.apply(begun.setCookies);
    ids.push(begun.stateId);
    clock += 1000;
  }
  const held = Object.keys(jar.cookies()).filter((name) => name.startsWith(SIGNIN_COOKIE_PREFIX));
  assert.equal(held.length, 5);
  assert.deepEqual(held.sort(), ids.slice(2).map((id) => `${SIGNIN_COOKIE_PREFIX}${id}`).sort());
});

test("parseCookies reads a Cookie header and ignores malformed pairs", () => {
  assert.deepEqual(parseCookies("a=1; __Host-desk-signin-x=y.z; junk; b = 2"), { a: "1", "__Host-desk-signin-x": "y.z", b: "2" });
  assert.deepEqual(parseCookies(undefined), {});
});

// ---- the Entra sign-in ----

test("the authorize URL carries response_mode=query and scope openid profile", async () => {
  const ctx = await setup();
  const who = browser();
  const url = beginIn(ctx, who);
  assert.equal(`${url.origin}${url.pathname}`, DISCOVERY.authorization_endpoint);
  const params = url.searchParams;
  assert.equal(params.get("client_id"), CLIENT_ID);
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("response_mode"), "query");
  assert.equal(params.get("scope"), "openid profile");
  assert.equal(params.get("redirect_uri"), CALLBACK);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.match(params.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(params.get("nonce"), /^[A-Za-z0-9_-]{22,}$/);
  // The state carries only the sealed pending request and the stateId: no verifier, no nonce.
  const pending = unseal("entra-pending", params.get("state"), { key: KEY, now: START });
  assert.equal(pending.clientId, PENDING.clientId);
  assert.ok(who.cookies()[`${SIGNIN_COOKIE_PREFIX}${pending.stateId}`]);
  const stateText = Buffer.from(params.get("state").split(".")[0], "base64url").toString();
  assert.ok(!stateText.includes(params.get("nonce")));
  const { verifier } = createSigninCookies({ key: KEY, now: () => START }).take(pending.stateId, who.cookies());
  assert.ok(!stateText.includes(verifier));
});

test("a known identity signs in and gets a code for its account, audience and client", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const who = browser();
  const { back, code } = codeIn(await signIn(ctx, who, { oid: OID }));
  assert.equal(`${back.origin}${back.pathname}`, CLAUDE_CALLBACK);
  assert.equal(back.searchParams.get("state"), "client-state");
  assert.equal(code.accountId, ctx.accountId);
  assert.equal(code.clientId, PENDING.clientId);
  assert.equal(code.redirectUri, PENDING.redirectUri);
  assert.equal(code.codeChallenge, PENDING.codeChallenge);
  assert.deepEqual(code.scopes, PENDING.scopes);
  assert.equal(code.aud, RESOURCE);
  assert.equal(code.oid, undefined);
  assert.equal(code.name, undefined);
  assert.deepEqual(Object.keys(who.cookies()).filter((name) => name.startsWith(SIGNIN_COOKIE_PREFIX)), [], "the signin cookie is cleared");
  assert.ok(logs.some((line) => line.includes(ctx.accountId)));
  assert.ok(!logs.some((line) => line.includes(OID)), "logs never name the oid");
});

test("a callback whose state has no matching signin cookie gets a 400 page and no code", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const browserA = browser();
  const browserB = browser();
  beginIn(ctx, browserA);
  // The attacker begins in browser B, signs in at the tenant and hands the victim's browser A the callback URL.
  const urlB = beginIn(ctx, browserB);
  const code = ctx.tenant.authorize(urlB, { oid: OID });
  const outcome = await ctx.entra.callback({ code, state: urlB.searchParams.get("state"), cookies: browserA.cookies() });
  assert.equal(outcome.status, 400);
  assert.equal(outcome.redirectTo, undefined);
  assert.match(outcome.html, /start again/i);
  assert.equal(ctx.tenant.calls.token.length, 0, "the code is never exchanged");
  // With no cookies at all, the same.
  assert.equal((await ctx.entra.callback({ code, state: urlB.searchParams.get("state"), cookies: {} })).status, 400);
  // A forged state is refused too.
  assert.equal((await ctx.entra.callback({ code, state: "forged", cookies: browserB.cookies() })).status, 400);
});

test("two sign-ins begun in one browser both complete", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const who = browser();
  const first = beginIn(ctx, who, { ...PENDING, state: "first" });
  const second = beginIn(ctx, who, { ...PENDING, state: "second" });
  const secondOutcome = await ctx.entra.callback({ code: ctx.tenant.authorize(second, { oid: OID }), state: second.searchParams.get("state"), cookies: who.cookies() });
  who.apply(secondOutcome.clearCookies);
  const firstOutcome = await ctx.entra.callback({ code: ctx.tenant.authorize(first, { oid: OID }), state: first.searchParams.get("state"), cookies: who.cookies() });
  assert.equal(codeIn(secondOutcome).back.searchParams.get("state"), "second");
  assert.equal(codeIn(firstOutcome).back.searchParams.get("state"), "first");
  assert.equal(codeIn(firstOutcome).code.accountId, ctx.accountId);
});

test("an unknown identity with no invite gets the invite-only page", async () => {
  const ctx = await setup();
  const outcome = await signIn(ctx, browser(), { oid: OID });
  assert.equal(outcome.status, 403);
  assert.match(outcome.html, /invite/i);
  assert.equal(await ctx.store.findIdentity(TENANT_ID, OID), null);
});

test("an unknown identity with a valid invite cookie redeems it and gets a code for the invite's account", async () => {
  const ctx = await setup();
  const { token } = await issueInvite({ store: ctx.store, accountId: ctx.accountId, now: START });
  secrets.add(token);
  const who = browser();
  const landed = await ctx.invites.land(token);
  assert.equal(landed.redirectTo, "/invite");
  who.apply(landed.setCookies);
  const outcome = await signIn(ctx, who, { oid: OID });
  assert.equal(codeIn(outcome).code.accountId, ctx.accountId);
  assert.equal(await ctx.store.findIdentity(TENANT_ID, OID), ctx.accountId);
  assert.equal(who.cookies()["__Host-desk-invite"], undefined, "the redeemed invite's cookie is cleared");
  // The invite is now used: another identity bringing the same cookie is refused.
  const other = browser();
  other.apply(landed.setCookies);
  const refused = await signIn(ctx, other, { oid: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" });
  assert.equal(refused.status, 403);
  assert.match(refused.html, /already been used|expired/i);
});

test("an expired invite cookie is refused at sign-in", async () => {
  const ctx = await setup();
  const { token } = await issueInvite({ store: ctx.store, accountId: ctx.accountId, ttlMs: 3600_000, now: START });
  secrets.add(token);
  const who = browser();
  who.apply((await ctx.invites.land(token)).setCookies);
  // The store's expiry passes while the cookie is still held (its own life is no longer than the invite's).
  const invite = await ctx.store.tables.get("invites", createHash("sha256").update(token).digest("base64url"), "");
  await ctx.store.tables.update("invites", { ...invite.entity, expiresAt: new Date(START - 1).toISOString() }, invite.etag);
  const outcome = await signIn(ctx, who, { oid: OID });
  assert.equal(outcome.status, 403);
  assert.equal(await ctx.store.findIdentity(TENANT_ID, OID), null);
});

test("an account with Desk access off gets a 403 page", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: false });
  const outcome = await signIn(ctx, browser(), { oid: OID });
  assert.equal(outcome.status, 403);
  assert.match(outcome.html, /access/i);
  assert.equal(outcome.redirectTo, undefined);
});

test("an account bound to another repository gets the no-desk page", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  await ctx.store.putBinding(ctx.accountId, { ...BINDING, repo: "someone/desk" });
  const outcome = await signIn(ctx, browser(), { oid: OID });
  assert.equal(outcome.status, 403);
  assert.match(outcome.html, /no desk/i);
});

test("an account with no binding gets the no-desk page", async () => {
  const ctx = await setup();
  const { accountId } = await ctx.store.putAccount({ accountId: "acct-without-binding", displayName: "Nobody", deskAccess: true }).then(() => ({ accountId: "acct-without-binding" }));
  await ctx.store.tables.create("identities", { partitionKey: TENANT_ID, rowKey: OID, accountId });
  const outcome = await signIn(ctx, browser(), { oid: OID });
  assert.equal(outcome.status, 403);
  assert.match(outcome.html, /no desk/i);
});

test("a store that can't answer refuses the sign-in with a try-again page", async () => {
  const ctx = await setup();
  ctx.store.findIdentity = async () => {
    throw new Error("the accounts store failed: get on table identities (HTTP 503)");
  };
  const outcome = await signIn(ctx, browser(), { oid: OID });
  assert.equal(outcome.status, 503);
  assert.equal(outcome.redirectTo, undefined);
});

test("an Entra error goes back to the client as access_denied", async () => {
  const ctx = await setup();
  const who = browser();
  const url = beginIn(ctx, who);
  const outcome = await ctx.entra.callback({ error: "access_denied", state: url.searchParams.get("state"), cookies: who.cookies() });
  const back = new URL(outcome.redirectTo);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "client-state");
  assert.equal(back.searchParams.get("code"), null);
  assert.equal(ctx.tenant.calls.token.length, 0);
  assert.ok(outcome.clearCookies.length >= 1);
});

test("the token request sends the verifier and client_secret_post and never logs the secret", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const who = browser();
  const url = beginIn(ctx, who);
  const pending = unseal("entra-pending", url.searchParams.get("state"), { key: KEY, now: START });
  const { verifier } = createSigninCookies({ key: KEY, now: () => START }).take(pending.stateId, who.cookies());
  const code = ctx.tenant.authorize(url, { oid: OID });
  secrets.add(code);
  secrets.add(verifier);
  secrets.add(url.searchParams.get("nonce"));
  codeIn(await ctx.entra.callback({ code, state: url.searchParams.get("state"), cookies: who.cookies() }));
  const [call] = ctx.tenant.calls.token;
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(call.headers.authorization, undefined, "client_secret_post, not basic");
  assert.equal(call.body.get("client_secret"), CLIENT_SECRET);
  assert.equal(call.body.get("code_verifier"), verifier);
  assert.equal(call.body.get("grant_type"), "authorization_code");
  assert.equal(call.body.get("redirect_uri"), CALLBACK);
  // A failed exchange logs no secret either (checked after each test), and gives a page, not a code.
  const url2 = beginIn(ctx, who);
  const failed = await ctx.entra.callback({ code: "not-a-code", state: url2.searchParams.get("state"), cookies: who.cookies() });
  assert.equal(failed.status, 502);
  assert.ok(logs.some((line) => /token_exchange/.test(line)));
});

test("an ID token for another nonce is refused at the callback", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const outcome = await signIn(ctx, browser(), { oid: OID, claims: { nonce: "another-sign-ins-nonce" } });
  assert.equal(outcome.status, 400);
  assert.equal(outcome.redirectTo, undefined);
  assert.ok(logs.some((line) => /invalid_id_token/.test(line)));
});

test("the code's authTime is the callback time even when the ID token's auth_time is 31 days old", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  ctx.advance(45_000);
  const authTime = Math.floor((START - 31 * 24 * 3600 * 1000) / 1000);
  const { code } = codeIn(await signIn(ctx, browser(), { oid: OID, claims: { auth_time: authTime } }));
  assert.equal(code.authTime, Math.floor((START + 45_000) / 1000));
});

// ---- the consent page ----

test("the consent page offers Apple or email when Entra is on, and GitHub only when the fallback is on", () => {
  const base = { clientName: "Claude", redirectUri: CLAUDE_CALLBACK, consent: "sealed" };
  assert.match(consentPage(base).html, /sign in with GitHub/, "today's page is unchanged without Entra");
  const entraOnly = consentPage({ ...base, signIn: { entra: true, github: false } }).html;
  assert.match(entraOnly, /Continue with Apple or email/);
  assert.ok(!/GitHub/.test(entraOnly));
  const both = consentPage({ ...base, signIn: { entra: true, github: true } }).html;
  assert.match(both, /Continue with Apple or email/);
  assert.match(both, /name="method" value="github"/);
});

// ---- the gateway's routes ----

async function startGateway(t, ctx) {
  const provider = createProvider({
    key: KEY,
    issuer: GATEWAY,
    github: { clientId: "Iv1.ouro-desk", clientSecret: "secret", fetch: () => assert.fail("no GitHub call expected") },
    allowedLogins: ["arimendelow"],
    resource: RESOURCE,
    log,
  });
  const app = createApp({ provider, relay: { handle: () => assert.fail("no relay") }, githubCallback: provider.githubCallback, issuer: GATEWAY, resource: RESOURCE, entra: ctx?.entra, invites: ctx?.invites });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("without Entra settings the gateway has no Entra or invite routes", async (t) => {
  const base = await startGateway(t);
  for (const path of ["/oauth/entra/callback?code=x&state=y", "/invite/abc", "/invite"]) {
    assert.equal((await fetch(`${base}${path}`, { redirect: "manual" })).status, 404, path);
  }
});

test("the invite route sets a SameSite=Lax cookie only for a known, unexpired invite, redirects to /invite and never echoes the token", async (t) => {
  const ctx = await setup();
  const base = await startGateway(t, ctx);
  const { token } = await issueInvite({ store: ctx.store, accountId: ctx.accountId, now: START });
  secrets.add(token);
  const response = await fetch(`${base}/invite/${token}`, { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/invite");
  const [cookie] = response.headers.getSetCookie();
  assert.ok(cookie.startsWith("__Host-desk-invite="));
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(cookie.split("; ").includes(attribute), `missing ${attribute}`);
  assert.ok(!cookie.includes(token), "the cookie carries the sealed hash, not the token");
  assert.ok(!(await response.text()).includes(token));

  const unknown = newInvite();
  const expiredInvite = await issueInvite({ store: ctx.store, accountId: ctx.accountId, ttlMs: 1000, now: START - 2000 });
  secrets.add(unknown.token);
  secrets.add(expiredInvite.token);
  for (const bad of [unknown.token, expiredInvite.token, "not a token"]) {
    const refused = await fetch(`${base}/invite/${encodeURIComponent(bad)}`, { redirect: "manual" });
    assert.equal(refused.status, 404);
    assert.deepEqual(refused.headers.getSetCookie(), []);
    assert.ok(!(await refused.text()).includes(bad));
  }
  // A used invite sets no cookie either.
  const who = browser();
  who.apply((await ctx.invites.land(token)).setCookies);
  await signIn(ctx, who, { oid: OID });
  const used = await fetch(`${base}/invite/${token}`, { redirect: "manual" });
  assert.equal(used.status, 404);
  assert.deepEqual(used.headers.getSetCookie(), []);
});

test("both invite pages send Referrer-Policy no-referrer", async (t) => {
  const ctx = await setup();
  const base = await startGateway(t, ctx);
  const { token } = await issueInvite({ store: ctx.store, accountId: ctx.accountId, now: START });
  secrets.add(token);
  const landing = await fetch(`${base}/invite/${token}`, { redirect: "manual" });
  assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
  assert.equal(landing.headers.get("cache-control"), "no-store");
  const refused = await fetch(`${base}/invite/unknown`, { redirect: "manual" });
  assert.equal(refused.headers.get("referrer-policy"), "no-referrer");
  const page = await fetch(`${base}/invite`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(await page.text(), /Apple or email/);
});

test("the invite cookie expires with the invite and within 24 hours", async () => {
  const ctx = await setup();
  const week = await issueInvite({ store: ctx.store, accountId: ctx.accountId, now: START });
  const twoHours = await issueInvite({ store: ctx.store, accountId: ctx.accountId, ttlMs: 2 * 3600_000, now: START });
  secrets.add(week.token);
  secrets.add(twoHours.token);
  const maxAge = (landed) => Number(/Max-Age=(\d+)/.exec(landed.setCookies[0])[1]);
  const weekLanded = await ctx.invites.land(week.token);
  assert.equal(maxAge(weekLanded), 24 * 3600);
  const shortLanded = await ctx.invites.land(twoHours.token);
  assert.equal(maxAge(shortLanded), 2 * 3600);
  // The sealed value itself expires no later than the cookie.
  const sealedValue = (landed) => decodeURIComponent(landed.setCookies[0].split(";")[0].split("=").slice(1).join("="));
  assert.ok(unseal("invite", sealedValue(shortLanded), { key: KEY, now: START + 2 * 3600_000 - 1000 }));
  assert.equal(unseal("invite", sealedValue(shortLanded), { key: KEY, now: START + 2 * 3600_000 + 1000 }), null);
  assert.equal(unseal("invite", sealedValue(weekLanded), { key: KEY, now: START + 24 * 3600_000 + 1000 }), null);
});

test("the Entra callback route reads the browser's cookies, clears the signin cookie and redirects", async (t) => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const base = await startGateway(t, ctx);
  const who = browser();
  const url = beginIn(ctx, who);
  const code = ctx.tenant.authorize(url, { oid: OID });
  const cookieHeader = Object.entries(who.cookies()).map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(`${base}/oauth/entra/callback?${new URLSearchParams({ code, state: url.searchParams.get("state") })}`, {
    redirect: "manual",
    headers: { cookie: cookieHeader },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("location").startsWith(`${CLAUDE_CALLBACK}?`));
  assert.ok(response.headers.getSetCookie().some((header) => header.startsWith(SIGNIN_COOKIE_PREFIX) && /Max-Age=0/.test(header)));
  // Without the cookie, a page and no redirect.
  const url2 = beginIn(ctx, who);
  const refused = await fetch(`${base}/oauth/entra/callback?${new URLSearchParams({ code: ctx.tenant.authorize(url2, { oid: OID }), state: url2.searchParams.get("state") })}`, { redirect: "manual" });
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get("x-frame-options"), "DENY");
});

test("sealed values of one kind are never accepted as another", () => {
  const pending = seal("pending", { stateId: "x" }, { key: KEY, ttlSec: 600, now: START });
  assert.equal(unseal("signin", pending, { key: KEY, now: START }), null);
  assert.equal(unseal("invite", pending, { key: KEY, now: START }), null);
});

// ---- fix round 1: timeouts, the invite cookie, the state's kind, a later mismatch, unexpected errors ----

// A fetch that never answers until its signal aborts it, as a ciamlogin.com that accepts the connection and hangs.
const hanging = (seen) => (url, init = {}) => {
  seen?.push({ url: String(url), signal: init.signal });
  return new Promise((_, reject) => {
    if (!init.signal) return;
    // AbortSignal.timeout's timer doesn't hold the event loop open; a real hanging socket does, and so does this.
    const socket = setTimeout(() => {}, 60_000);
    init.signal.addEventListener("abort", () => (clearTimeout(socket), reject(init.signal.reason)), { once: true });
  });
};

test("a discovery fetch that never answers is cut off, so start resolves and retries in the background", async () => {
  const seen = [];
  const discovery = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, fetch: hanging(seen), retryMs: 60_000, timeoutMs: 50, log });
  const started = performance.now();
  await discovery.start();
  discovery.stop();
  assert.ok(performance.now() - started < 2000, "start must not wait on a hanging tenant");
  assert.equal(discovery.ready(), false);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.ok(logs.some((line) => /Entra discovery could not be loaded/.test(line)));
});

test("a token exchange that never answers is cut off and shows a page", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const seen = [];
  const hang = hanging(seen);
  const entra = createEntraSignIn({
    key: KEY,
    discovery: ctx.discovery,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUrl: CALLBACK,
    store: ctx.store,
    repo: REPO,
    fetch: (url, init) => (String(url) === DISCOVERY.token_endpoint ? hang(url, init) : ctx.tenant.fetch(url, init)),
    timeoutMs: 50,
    now: ctx.now,
    log,
  });
  const who = browser();
  const begun = entra.begin(PENDING, who.cookies());
  who.apply(begun.setCookies);
  const url = new URL(begun.redirectTo);
  const started = performance.now();
  const outcome = await entra.callback({ code: ctx.tenant.authorize(url, { oid: OID }), state: url.searchParams.get("state"), cookies: who.cookies() });
  assert.ok(performance.now() - started < 2000);
  assert.equal(outcome.status, 502);
  assert.equal(outcome.redirectTo, undefined);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.ok(logs.some((line) => /entra_token_exchange \(TimeoutError\)/.test(line)));
});

test("a known identity's sign-in clears an invite cookie it didn't need", async () => {
  const ctx = await setup();
  await identityFor(ctx, OID);
  const { token } = await issueInvite({ store: ctx.store, accountId: ctx.accountId, now: START });
  secrets.add(token);
  const who = browser();
  who.apply((await ctx.invites.land(token)).setCookies);
  codeIn(await signIn(ctx, who, { oid: OID }));
  assert.equal(who.cookies()["__Host-desk-invite"], undefined);
  // The invite is still unused.
  assert.equal((await ctx.invites.land(token)).redirectTo, "/invite");
});

test("the state sent to the tenant is never accepted as GitHub's pending state", async () => {
  const ctx = await setup();
  const url = beginIn(ctx, browser());
  assert.equal(unseal("pending", url.searchParams.get("state"), { key: KEY, now: START }), null);
  // And a GitHub pending state, even with a stateId, is not accepted at the Entra callback.
  const who = browser();
  const githubState = seal("pending", { ...PENDING, stateId: "x".repeat(22) }, { key: KEY, ttlSec: 600, now: START });
  assert.equal((await ctx.entra.callback({ code: "c", state: githubState, cookies: who.cookies() })).status, 400);
});

test("an issuer mismatch found by a background retry is reported by mismatch()", async () => {
  const tenant = await stubTenant();
  tenant.state.discoveryDown = true;
  const discovery = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, fetch: tenant.fetch, retryMs: 5, log });
  try {
    await discovery.start();
    assert.equal(discovery.mismatch(), false);
    tenant.state.discovery = { ...DISCOVERY, issuer: `https://${SUBDOMAIN}.ciamlogin.com/${TENANT_ID}/v2.0` };
    tenant.state.discoveryDown = false;
    for (let i = 0; i < 200 && !discovery.mismatch(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(discovery.mismatch(), true);
    assert.equal(discovery.ready(), false);
  } finally {
    discovery.stop();
  }
});

test("an unexpected error in the Entra callback route is logged by name only", async (t) => {
  const provider = createProvider({
    key: KEY,
    issuer: GATEWAY,
    github: { clientId: "Iv1.ouro-desk", clientSecret: "secret", fetch: () => assert.fail("no GitHub call expected") },
    allowedLogins: ["arimendelow"],
    resource: RESOURCE,
    log,
  });
  const entra = {
    callback: async () => {
      throw new TypeError("details-that-must-not-be-logged");
    },
  };
  const app = createApp({ provider, relay: {}, githubCallback: provider.githubCallback, issuer: GATEWAY, resource: RESOURCE, entra, log });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/oauth/entra/callback?code=c&state=s`, { redirect: "manual" });
  assert.equal(response.status, 502);
  assert.ok(logs.some((line) => line === "sign-in failed: entra_callback_error (TypeError)"), logs.join("\n"));
  assert.ok(!logs.some((line) => line.includes("details-that-must-not-be-logged")));
});
