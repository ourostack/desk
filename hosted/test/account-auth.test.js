// Tokens that belong to Ouro accounts (spec items 9, 11, 12 and 13): the provider with the Ouro tenant, the accounts
// store and Ari's legacy mapping configured. Codes minted by the tenant's sign-in or the GitHub fallback carry an
// accountId and an authTime; refresh and verify check the account; a refresh more than 30 days after authTime is
// refused; legacy tokens (v1a's, sealed with a GitHub login) map to Ari's account until the cutoff. Against a stub
// tenant, a stand-in GitHub and the in-memory accounts store, on a fake clock. No test reaches the network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { seal, unseal } from "../src/auth/seal.js";
import { createProvider } from "../src/auth/provider.js";
import { createDiscovery, createEntraSignIn, createInvites } from "../src/auth/entra.js";
import { SIGNIN_COOKIE_PREFIX } from "../src/auth/signin-cookie.js";
import { createApp } from "../src/server.js";
import { createMemoryStore } from "../src/accounts/memory-store.js";
import { createAccountCache } from "../src/accounts/cache.js";
import { seed } from "../src/accounts/invites.js";
import { stubTenant, TENANT_ID, SUBDOMAIN, CLIENT_ID, CLIENT_SECRET } from "./fixtures/stub-tenant.mjs";

const KEY = "test-key-0123456789abcdef0123456789abcdef";
const GATEWAY = "https://desk.ouro.bot";
const RESOURCE = `${GATEWAY}/mcp`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const REPO = "arimendelow/desk";
const GITHUB = { clientId: "Iv1.ouro-desk", clientSecret: "github-app-secret" };
const ARI_ID = 16390116;
const START = Date.parse("2026-11-01T00:00:00Z");
const CUTOFF = new Date("2026-11-15T00:00:00Z");
const DAY = 24 * 3600 * 1000;
const BINDING = { kind: "github", repo: REPO, installationId: 12345678, author: { name: "Ari Mendelow", email: "16390116+arimendelow@users.noreply.github.com" } };
const OID = "4f6c1d2e-8b9a-4c3d-9e8f-7a6b5c4d3e2f";

const logs = [];
const secrets = new Set([CLIENT_SECRET, GITHUB.clientSecret, "gho_", OID, "Ari Mendelow", "arimendelow"]);
afterEach(() => {
  for (const line of logs) for (const secret of secrets) assert.ok(!line.includes(secret), `log line leaks a secret or a name: ${line}`);
  logs.length = 0;
});
const log = (line) => logs.push(line);

// A stand-in for GitHub: `users` maps a GitHub code to the user that signed in with it.
function fakeGitHub(users = { "gh-ari": { login: "arimendelow", id: ARI_ID, name: "Ari Mendelow" } }) {
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push(String(url));
    if (String(url) === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(init.body).get("code");
      return users[code] ? Response.json({ access_token: `gho_${code}` }) : Response.json({ error: "bad_verification_code" });
    }
    if (String(url) === "https://api.github.com/user") return Response.json(users[init.headers.authorization.replace("Bearer gho_", "")]);
    throw new Error(`unexpected fetch ${url}`);
  }
  return { fetch, calls };
}

// A browser's cookie jar.
function browser() {
  const jar = new Map();
  return {
    apply(setCookies = []) {
      for (const header of setCookies) {
        const [pair] = header.split(";");
        const name = pair.slice(0, pair.indexOf("="));
        if (/;\s*Max-Age=0(;|$)/i.test(header)) jar.delete(name);
        else jar.set(name, pair.slice(pair.indexOf("=") + 1));
      }
    },
    cookies: () => Object.fromEntries(jar),
    header: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
  };
}

async function setup({ githubSignIn = true, github = fakeGitHub(), cutoff = CUTOFF } = {}) {
  let clock = START;
  const now = () => clock;
  const tenant = await stubTenant({ now });
  const discovery = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, fetch: tenant.fetch, log });
  await discovery.start();
  const store = createMemoryStore();
  const { accountId } = await seed({ store, displayName: "Ari Mendelow", binding: BINDING });
  await store.tables.create("identities", { partitionKey: TENANT_ID, rowKey: OID, accountId });
  const accounts = createAccountCache({ store, now });
  const entra = createEntraSignIn({
    key: KEY,
    discovery,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUrl: `${GATEWAY}/oauth/entra/callback`,
    store,
    repo: REPO,
    fetch: tenant.fetch,
    now,
    log,
  });
  const legacy = { byUserId: new Map([[ARI_ID, { login: "arimendelow", accountId }]]), cutoff };
  const provider = createProvider({
    key: KEY,
    issuer: GATEWAY,
    resource: RESOURCE,
    github: { ...GITHUB, fetch: github.fetch, signIn: githubSignIn },
    entra,
    accounts,
    store,
    repo: REPO,
    legacy,
    now,
    log,
  });
  const client = provider.clientsStore.registerClient({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_post" });
  return { tenant, discovery, store, accounts, entra, provider, client, accountId, github, now, advance: (ms) => (clock += ms), setClock: (ms) => (clock = ms) };
}

const consentFor = (ctx, client = ctx.client) =>
  seal("consent", { clientId: client.client_id, redirectUri: CLAUDE_CALLBACK, codeChallenge: "challenge", state: "claude-state", scopes: ["desk"], aud: RESOURCE }, { key: KEY, ttlSec: 600, now: ctx.now() });

// The Ouro tenant's sign-in, called directly: approve, the tenant, our callback. Returns our sealed code.
async function entraCode(ctx, { claims } = {}) {
  const who = browser();
  const approved = ctx.provider.approve(consentFor(ctx), { method: "entra", cookies: who.cookies() });
  assert.ok(approved.redirectTo, `approve gave a page: ${approved.html}`);
  who.apply(approved.setCookies);
  const url = new URL(approved.redirectTo);
  const code = ctx.tenant.authorize(url, { oid: OID, claims });
  const outcome = await ctx.entra.callback({ code, state: url.searchParams.get("state"), cookies: who.cookies() });
  assert.ok(outcome.redirectTo, `callback gave a page: ${outcome.html}`);
  return new URL(outcome.redirectTo).searchParams.get("code");
}

// The GitHub fallback, called directly. Returns the callback's outcome.
async function githubSignIn(ctx, { githubCode = "gh-ari", who = browser(), cookies } = {}) {
  const approved = ctx.provider.approve(consentFor(ctx), { method: "github", cookies: who.cookies() });
  assert.ok(approved.redirectTo, `approve gave a page: ${approved.html}`);
  who.apply(approved.setCookies);
  const url = new URL(approved.redirectTo);
  assert.equal(`${url.origin}${url.pathname}`, "https://github.com/login/oauth/authorize");
  return ctx.provider.githubCallback({ code: githubCode, state: url.searchParams.get("state"), cookies: cookies ?? who.cookies() });
}

const exchange = (ctx, code) => ctx.provider.exchangeAuthorizationCode(ctx.client, code, "verifier", CLAUDE_CALLBACK);
const refresh = (ctx, token) => ctx.provider.exchangeRefreshToken(ctx.client, token);
const claimsOf = (kind, token, now = START) => unseal(kind, token, { key: KEY, now });

// A v1a token for this client, sealed as v1a's gateway sealed them.
const legacyToken = (ctx, kind, { login = "arimendelow", userId = ARI_ID, ttlSec = kind === "access" ? 3600 : 30 * 24 * 3600 } = {}) =>
  seal(kind, { clientId: ctx.client.client_id, scopes: [], login, userId, name: "Ari Mendelow", jti: randomBytes(4).toString("hex") }, { key: KEY, ttlSec, now: ctx.now() });

// ---- tokens that belong to accounts ----

test("an Entra-minted code redeems for tokens that carry the account and authTime, and verify to the account", async () => {
  const ctx = await setup();
  const tokens = await exchange(ctx, await entraCode(ctx));
  const access = claimsOf("access", tokens.access_token);
  assert.equal(access.accountId, ctx.accountId);
  assert.equal(access.authTime, Math.floor(START / 1000), "authTime is in seconds, like exp");
  assert.equal(access.aud, RESOURCE);
  assert.equal(access.login, undefined);
  assert.equal(access.legacy, undefined);
  const info = await ctx.provider.verifyAccessToken(tokens.access_token);
  assert.deepEqual(info.extra, { accountId: ctx.accountId });
  assert.equal(info.clientId, ctx.client.client_id);
});

test("a refresh 30 days and 1 s after authTime is refused and one at 29 days succeeds, keeping authTime", async () => {
  const ctx = await setup();
  const first = await exchange(ctx, await entraCode(ctx));
  ctx.advance(29 * DAY);
  const second = await refresh(ctx, first.refresh_token);
  assert.equal(claimsOf("refresh", second.refresh_token, ctx.now()).authTime, Math.floor(START / 1000));
  assert.equal(claimsOf("access", second.access_token, ctx.now()).authTime, Math.floor(START / 1000));
  ctx.setClock(START + 30 * DAY);
  await refresh(ctx, second.refresh_token);
  ctx.setClock(START + 30 * DAY + 1000);
  await assert.rejects(refresh(ctx, second.refresh_token), { errorCode: "invalid_grant" });
  assert.ok(logs.some((line) => line.includes("(lifetime)")));
});

test("a fresh sign-in whose ID token carries an auth_time 31 days old still yields a usable refresh", async () => {
  const ctx = await setup();
  const code = await entraCode(ctx, { claims: { auth_time: Math.floor((START - 31 * DAY) / 1000) } });
  const tokens = await exchange(ctx, code);
  ctx.advance(DAY);
  const refreshed = await refresh(ctx, tokens.refresh_token);
  assert.ok(refreshed.access_token);
});

test("a GitHub-fallback token carries authTime and the same limit applies", async () => {
  const ctx = await setup();
  const outcome = await githubSignIn(ctx);
  assert.ok(outcome.redirectTo, outcome.html);
  const code = new URL(outcome.redirectTo).searchParams.get("code");
  const claims = claimsOf("code", code);
  assert.equal(claims.accountId, ctx.accountId);
  assert.equal(claims.authTime, Math.floor(START / 1000));
  assert.equal(claims.login, undefined);
  const tokens = await exchange(ctx, code);
  assert.equal(claimsOf("refresh", tokens.refresh_token).authTime, Math.floor(START / 1000));
  ctx.setClock(START + 29 * DAY);
  const later = await refresh(ctx, tokens.refresh_token);
  ctx.setClock(START + 30 * DAY + 1000);
  await assert.rejects(refresh(ctx, later.refresh_token), { errorCode: "invalid_grant" });
});

test("an account token is not ended by the legacy cutoff", async () => {
  const ctx = await setup();
  const tokens = await exchange(ctx, await entraCode(ctx));
  ctx.setClock(CUTOFF.getTime() + 1000);
  assert.ok((await refresh(ctx, tokens.refresh_token)).access_token);
});

// ---- legacy tokens ----

test("a legacy refresh token with login arimendelow and userId 16390116 before the cutoff refreshes to Ari's accountId with legacy true and the default aud", async () => {
  const ctx = await setup();
  const tokens = await refresh(ctx, legacyToken(ctx, "refresh"));
  for (const [kind, token] of [["refresh", tokens.refresh_token], ["access", tokens.access_token]]) {
    const claims = claimsOf(kind, token);
    assert.equal(claims.accountId, ctx.accountId, kind);
    assert.equal(claims.legacy, true, kind);
    assert.equal(claims.aud, RESOURCE, kind);
    assert.equal(claims.authTime, undefined, `${kind}: a legacy token has no authTime; the cutoff governs it`);
    assert.equal(claims.login, "arimendelow", kind);
    assert.equal(claims.userId, ARI_ID, kind);
    assert.equal(claims.clientId, ctx.client.client_id, kind);
  }
  assert.deepEqual((await ctx.provider.verifyAccessToken(tokens.access_token)).extra, { accountId: ctx.accountId });
  // A v1a access token, still within its hour, verifies to Ari's account too.
  assert.deepEqual((await ctx.provider.verifyAccessToken(legacyToken(ctx, "access"))).extra, { accountId: ctx.accountId });
});

test("a token refreshed from a legacy token passes v1a's grantFor rule", async () => {
  const ctx = await setup();
  const tokens = await refresh(ctx, legacyToken(ctx, "refresh"));
  // v1a's rule, verbatim: unsealed with the same key, issued to this client, a login in DESK_ALLOWED_LOGINS, and no
  // audience or this one.
  const allowedLogins = ["arimendelow"];
  const grant = unseal("refresh", tokens.refresh_token, { key: KEY, now: START });
  assert.ok(grant && grant.clientId === ctx.client.client_id && allowedLogins.includes(grant.login) && (grant.aud === undefined || grant.aud === RESOURCE));
  assert.equal(typeof grant.userId, "number");
  // And a gateway running as v1a did (no accounts) refreshes it and verifies its access token to the login.
  const v1a = createProvider({ key: KEY, issuer: GATEWAY, resource: RESOURCE, github: GITHUB, allowedLogins, now: ctx.now, log });
  const again = await v1a.exchangeRefreshToken(ctx.client, tokens.refresh_token);
  assert.equal((await v1a.verifyAccessToken(tokens.access_token)).extra.login, "arimendelow");
  assert.equal((await v1a.verifyAccessToken(again.access_token)).extra.userId, ARI_ID);
});

test("that refreshed token is itself refused after the cutoff", async () => {
  const ctx = await setup();
  const tokens = await refresh(ctx, legacyToken(ctx, "refresh"));
  ctx.setClock(CUTOFF.getTime() - 1000);
  const before = await refresh(ctx, tokens.refresh_token);
  ctx.setClock(CUTOFF.getTime());
  await assert.rejects(refresh(ctx, before.refresh_token), { errorCode: "invalid_grant" });
  await assert.rejects(refresh(ctx, tokens.refresh_token), { errorCode: "invalid_grant" });
  assert.ok(logs.some((line) => line.includes("(legacy_cutoff)")));
});

test("a legacy access token is refused after the cutoff", async () => {
  const ctx = await setup();
  ctx.setClock(CUTOFF.getTime() - 60_000);
  const access = legacyToken(ctx, "access");
  await ctx.provider.verifyAccessToken(access);
  ctx.setClock(CUTOFF.getTime());
  await assert.rejects(ctx.provider.verifyAccessToken(access), { errorCode: "invalid_token" });
});

test("a legacy token with login arimendelow and another userId is refused", async () => {
  const ctx = await setup();
  await assert.rejects(refresh(ctx, legacyToken(ctx, "refresh", { userId: 1 })), { errorCode: "invalid_grant" });
  await assert.rejects(ctx.provider.verifyAccessToken(legacyToken(ctx, "access", { userId: 1 })), { errorCode: "invalid_token" });
  // Ari's id under another login (a rename) is refused too: both must match.
  await assert.rejects(refresh(ctx, legacyToken(ctx, "refresh", { login: "someone-else" })), { errorCode: "invalid_grant" });
  // A token marked legacy that names another account than the mapping's is refused.
  const marked = seal("refresh", { clientId: ctx.client.client_id, scopes: [], login: "arimendelow", userId: ARI_ID, accountId: "another-account", legacy: true }, { key: KEY, ttlSec: 600, now: START });
  await assert.rejects(refresh(ctx, marked), { errorCode: "invalid_grant" });
});

test("without a cutoff set yet, legacy tokens keep working", async () => {
  const ctx = await setup({ cutoff: null });
  ctx.setClock(START + 60 * DAY);
  assert.ok((await refresh(ctx, legacyToken(ctx, "refresh"))).access_token);
});

// ---- the GitHub fallback ----

test("a GitHub sign-in as login arimendelow with another user id gets a 403 page", async () => {
  const ctx = await setup({ github: fakeGitHub({ "gh-impostor": { login: "arimendelow", id: 99, name: "Not Ari" } }) });
  const outcome = await githubSignIn(ctx, { githubCode: "gh-impostor" });
  assert.equal(outcome.status, 403);
  assert.equal(outcome.redirectTo, undefined);
  assert.ok(logs.some((line) => line.startsWith("sign-in refused: github_user_not_mapped client ")));
});

test("with DESK_GITHUB_SIGNIN off, the GitHub callback route refuses and the consent page has no GitHub link", async (t) => {
  const ctx = await setup({ githubSignIn: false });
  const base = await startGateway(t, ctx);
  const page = await authorizePage(base, ctx);
  assert.match(page, /Continue with Apple or email/);
  assert.ok(!/GitHub/.test(page), "no GitHub option");
  // Even a state sealed for a real pending request and its cookie can't get a code through the callback.
  const forged = seal("pending", { clientId: ctx.client.client_id, redirectUri: CLAUDE_CALLBACK, codeChallenge: "c", stateId: "a".repeat(22) }, { key: KEY, ttlSec: 600, now: START });
  const response = await fetch(`${base}/oauth/github/callback?${new URLSearchParams({ code: "gh-ari", state: forged })}`, { redirect: "manual" });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(ctx.github.calls, [], "GitHub is never asked");
});

test("the consent form's method=github is refused when the GitHub fallback is off", async (t) => {
  const ctx = await setup({ githubSignIn: false });
  const base = await startGateway(t, ctx);
  const response = await postConsent(base, consentFor(ctx), { method: "github" });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("location"), null);
  assert.ok(logs.includes(`consent refused: github_signin_off client ${ctx.client.client_id}`));
});

test("a consent form with no method goes to the Ouro tenant, and an unknown method is refused", async (t) => {
  const ctx = await setup();
  const base = await startGateway(t, ctx);
  const missing = await postConsent(base, consentFor(ctx), {});
  assert.equal(missing.status, 303);
  assert.ok(missing.headers.get("location").startsWith("https://ourobottest.ciamlogin.com/"), missing.headers.get("location"));
  assert.ok(missing.headers.getSetCookie().some((header) => header.startsWith(SIGNIN_COOKIE_PREFIX)));
  const entra = await postConsent(base, consentFor(ctx), { method: "entra" });
  assert.ok(entra.headers.get("location").startsWith("https://ourobottest.ciamlogin.com/"));
  const github = await postConsent(base, consentFor(ctx), { method: "github" });
  assert.equal(github.status, 303);
  assert.ok(github.headers.get("location").startsWith("https://github.com/login/oauth/authorize?"));
  assert.ok(github.headers.getSetCookie().some((header) => header.startsWith(SIGNIN_COOKIE_PREFIX)));
  const other = await postConsent(base, consentFor(ctx), { method: "password" });
  assert.equal(other.status, 400);
  assert.equal(other.headers.get("location"), null);
});

test("a GitHub callback without its signin cookie gets the start-again page", async () => {
  const ctx = await setup();
  const outcome = await githubSignIn(ctx, { cookies: {} });
  assert.equal(outcome.status, 400);
  assert.match(outcome.html, /started in another browser/);
  assert.equal(outcome.redirectTo, undefined);
  // Another browser's cookie doesn't do either (code injection).
  const other = browser();
  other.apply(ctx.provider.approve(consentFor(ctx), { method: "github", cookies: {} }).setCookies);
  const injected = await githubSignIn(ctx, { cookies: other.cookies() });
  assert.equal(injected.status, 400);
  assert.deepEqual(ctx.github.calls, [], "GitHub is never asked");
});

test("a GitHub fallback sign-in for an account with Desk access off gets a 403 page", async () => {
  const ctx = await setup();
  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: false });
  const outcome = await githubSignIn(ctx);
  assert.equal(outcome.status, 403);
  assert.match(outcome.html, /access is turned off/);
});

// ---- the account check ----

test("verify refuses an account with access off (401) and answers server_error (500) when the store is down and the cache is stale", async (t) => {
  const ctx = await setup();
  const tokens = await exchange(ctx, await entraCode(ctx));
  const base = await startGateway(t, ctx);
  const mcp = () => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal((await mcp()).status, 200);

  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: false });
  ctx.advance(61_000);
  const off = await mcp();
  assert.equal(off.status, 401);
  assert.equal((await off.json()).error, "invalid_token");

  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: true });
  ctx.advance(61_000);
  assert.equal((await mcp()).status, 200);
  const getAccount = ctx.store.getAccount;
  ctx.store.getAccount = async () => {
    throw Object.assign(new Error("the accounts store failed: get on table accounts (timed out)"), { name: "StoreError" });
  };
  ctx.advance(30_000);
  assert.equal((await mcp()).status, 200, "a row up to 60 s old is still served");
  ctx.advance(31_000);
  const down = await mcp();
  assert.equal(down.status, 500);
  assert.equal((await down.json()).error, "server_error");
  ctx.store.getAccount = getAccount;
});

test("refresh refuses an account with access off as invalid_grant", async () => {
  const ctx = await setup();
  const tokens = await exchange(ctx, await entraCode(ctx));
  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: false });
  ctx.advance(61_000);
  await assert.rejects(refresh(ctx, tokens.refresh_token), { errorCode: "invalid_grant" });
  await assert.rejects(refresh(ctx, legacyToken(ctx, "refresh")), { errorCode: "invalid_grant" }, "legacy tokens map to the account and are checked too");
  assert.ok(logs.some((line) => line.includes(`(access_off) account ${ctx.accountId}`) || line.includes(`account ${ctx.accountId}`)));
});

test("a code exchange or refresh while the store is down and the cache is stale answers server_error", async () => {
  const ctx = await setup();
  const tokens = await exchange(ctx, await entraCode(ctx));
  ctx.store.getAccount = async () => {
    throw Object.assign(new Error("down"), { name: "StoreError" });
  };
  ctx.advance(61_000);
  await assert.rejects(refresh(ctx, tokens.refresh_token), { errorCode: "server_error" });
});

// ---- through the gateway's routes ----

async function startGateway(t, ctx) {
  const relay = { handle: (req, res, auth) => res.json({ relayed: true, extra: auth.extra }) };
  const app = createApp({ provider: ctx.provider, relay, githubCallback: ctx.provider.githubCallback, issuer: GATEWAY, resource: RESOURCE, entra: ctx.entra, invites: createInvites({ key: KEY, store: ctx.store, now: ctx.now, log }), log });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const postConsent = (base, consent, { method, cookie } = {}) =>
  fetch(`${base}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ consent, ...(method !== undefined ? { method } : {}) }),
    redirect: "manual",
  });

async function authorizePage(base, ctx, challenge = "challenge") {
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: ctx.client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "claude-state", resource: RESOURCE });
  const response = await fetch(authorize, { redirect: "manual" });
  assert.equal(response.status, 200);
  return response.text();
}

test("through the gateway, an Ouro sign-in ends in tokens whose access token reaches /mcp as the account", async (t) => {
  const ctx = await setup();
  const base = await startGateway(t, ctx);
  const verifier = randomBytes(32).toString("base64url");
  const html = await authorizePage(base, ctx, createHash("sha256").update(verifier).digest("base64url"));
  const consent = html.match(/name="consent" value="([^"]+)"/)[1];
  const who = browser();
  const approved = await postConsent(base, consent, { method: "entra" });
  assert.equal(approved.status, 303);
  who.apply(approved.headers.getSetCookie());
  const url = new URL(approved.headers.get("location"));
  const callback = await fetch(`${base}/oauth/entra/callback?${new URLSearchParams({ code: ctx.tenant.authorize(url, { oid: OID }), state: url.searchParams.get("state") })}`, {
    redirect: "manual",
    headers: { cookie: who.header() },
  });
  assert.equal(callback.status, 302);
  const code = new URL(callback.headers.get("location")).searchParams.get("code");
  const token = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: ctx.client.client_id, client_secret: ctx.client.client_secret, code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK }),
  });
  assert.equal(token.status, 200);
  const tokens = await token.json();
  const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(mcp.status, 200);
  assert.deepEqual((await mcp.json()).extra, { accountId: ctx.accountId });
});

// ---- review fix round 1 ----

test("a code minted for an account that is then disabled or removed is refused at exchange", async () => {
  const ctx = await setup();
  const disabledCode = await entraCode(ctx);
  // The cache holds no row yet (sign-in reads the store itself), so the exchange reads the store, within the code's
  // minute.
  await ctx.store.putAccount({ accountId: ctx.accountId, displayName: "Ari Mendelow", deskAccess: false });
  ctx.advance(30_000);
  await assert.rejects(exchange(ctx, disabledCode), { errorCode: "invalid_grant" });
  assert.ok(logs.some((line) => line.includes(`(access_off account ${ctx.accountId})`)));

  const ctx2 = await setup();
  const removedCode = await entraCode(ctx2);
  ctx2.store.getAccount = async () => null;
  ctx2.advance(30_000);
  await assert.rejects(exchange(ctx2, removedCode), { errorCode: "invalid_grant" });
  assert.ok(logs.some((line) => line.includes(`(no_account account ${ctx2.accountId})`)));
});

test("a code exchange while the store is down and the cache is stale answers server_error", async () => {
  const ctx = await setup();
  const code = await entraCode(ctx);
  ctx.store.getAccount = async () => {
    throw Object.assign(new Error("down"), { name: "StoreError" });
  };
  ctx.advance(30_000);
  await assert.rejects(exchange(ctx, code), { errorCode: "server_error" });
});

test("legacy tokens compare GitHub logins case-insensitively", async () => {
  const ctx = await setup();
  // GitHub logins are case-insensitive: a mapping written AriMendelow still maps a token sealed as arimendelow.
  ctx.provider = createProvider({
    key: KEY,
    issuer: GATEWAY,
    resource: RESOURCE,
    github: { ...GITHUB, fetch: ctx.github.fetch, signIn: true },
    entra: ctx.entra,
    accounts: ctx.accounts,
    store: ctx.store,
    repo: REPO,
    legacy: { byUserId: new Map([[ARI_ID, { login: "AriMendelow", accountId: ctx.accountId }]]), cutoff: CUTOFF },
    now: ctx.now,
    log,
  });
  const tokens = await refresh(ctx, legacyToken(ctx, "refresh"));
  assert.equal(claimsOf("refresh", tokens.refresh_token).accountId, ctx.accountId);
  assert.ok((await refresh(ctx, legacyToken(ctx, "refresh", { login: "ARIMENDELOW" }))).access_token);
  await assert.rejects(refresh(ctx, legacyToken(ctx, "refresh", { login: "arimendelow2" })), { errorCode: "invalid_grant" });
});
