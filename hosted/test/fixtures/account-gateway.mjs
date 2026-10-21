// A gateway with the Ouro tenant, the browser session and the admin routes, against a stub tenant and the in-memory
// accounts store, plus a cookie-keeping browser for driving it over HTTP. Shared by the browser-session and admin
// tests. No test reaches the network.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createDiscovery, createEntraSignIn, createInvites } from "../../src/auth/entra.js";
import { createBrowserSession } from "../../src/auth/browser-session.js";
import { createAdmin, createAdminTokenVerifier } from "../../src/admin.js";
import { createProvider } from "../../src/auth/provider.js";
import { createApp } from "../../src/server.js";
import { createMemoryStore } from "../../src/accounts/memory-store.js";
import { seed } from "../../src/accounts/invites.js";
import { stubTenant, ISSUER, TENANT_ID, SUBDOMAIN, CLIENT_ID, CLIENT_SECRET } from "./stub-tenant.mjs";

export const KEY = "test-key-0123456789abcdef0123456789abcdef";
export const GATEWAY = "https://desk.ouro.bot";
export const RESOURCE = `${GATEWAY}/mcp`;
export const REPO = "arimendelow/desk";
export const START = Date.parse("2026-11-01T00:00:00Z");
export const BINDING = { kind: "github", repo: REPO, installationId: 12345678, author: { name: "Ari Mendelow", email: "16390116+arimendelow@users.noreply.github.com" } };
export const ARI_OID = "4f6c1d2e-8b9a-4c3d-9e8f-7a6b5c4d3e2f";
export const CLI_CLIENT_ID = "0b6f7c1e-2d3a-4b5c-8d9e-1f2a3b4c5d6e";

// Starts the gateway. Ari's account exists, with his binding and his identity mapped. `ctx.logs` collects every line.
// With `discoveryDown`, the tenant's discovery document can't be fetched, so nothing tenant-signed can be checked.
export async function startAccountGateway(t, { discoveryDown = false } = {}) {
  let clock = START;
  const now = () => clock;
  const logs = [];
  const log = (line) => logs.push(line);
  const tenant = await stubTenant({ now });
  tenant.state.discoveryDown = discoveryDown;
  const discovery = createDiscovery({ subdomain: SUBDOMAIN, tenantId: TENANT_ID, fetch: tenant.fetch, log });
  await discovery.start();
  const store = createMemoryStore();
  const { accountId } = await seed({ store, displayName: "Ari Mendelow", binding: BINDING });
  await store.tables.create("identities", { partitionKey: TENANT_ID, rowKey: ARI_OID, accountId });
  const sessions = createBrowserSession({ key: KEY, store, issuer: GATEWAY, now, log });
  const entra = createEntraSignIn({
    key: KEY,
    discovery,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUrl: `${GATEWAY}/oauth/entra/callback`,
    store,
    repo: REPO,
    sessions,
    fetch: tenant.fetch,
    now,
    log,
  });
  const invites = createInvites({ key: KEY, store, issuer: GATEWAY, now, log });
  const forgotten = [];
  const deleted = [];
  const admin = createAdmin({
    store,
    issuer: GATEWAY,
    verifier: createAdminTokenVerifier({ discovery, tenantId: TENANT_ID, clientId: CLIENT_ID, fetch: tenant.fetch, now }),
    forget: (id) => forgotten.push(id),
    onAccountDeleted: async (id) => deleted.push(id),
    now,
    log,
  });
  const provider = createProvider({
    key: KEY,
    issuer: GATEWAY,
    github: { clientId: "Iv1.ouro-desk", clientSecret: "secret", fetch: () => assert.fail("no GitHub call expected") },
    allowedLogins: ["arimendelow"],
    resource: RESOURCE,
    log,
  });
  const app = createApp({ provider, relay: { handle: () => assert.fail("no relay") }, githubCallback: provider.githubCallback, issuer: GATEWAY, resource: RESOURCE, entra, invites, sessions, admin, log });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    discovery.stop();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, tenant, discovery, store, accountId, sessions, entra, invites, forgotten, deleted, logs, now, advance: (ms) => (clock += ms) };
}

// A browser: keeps cookies across requests to the gateway, as a real one would for desk.ouro.bot. `sameSite` sets
// Sec-Fetch-Site on every request, the way a browser marks a request made from the gateway's own page.
export function browser(ctx) {
  const jar = new Map();
  const apply = (setCookies) => {
    for (const header of setCookies) {
      const [pair] = header.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      if (/;\s*Max-Age=0(;|$)/i.test(header)) jar.delete(name);
      else jar.set(name, pair.slice(pair.indexOf("=") + 1));
    }
  };
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  async function request(path, { method = "GET", form, headers = {}, site = "same-origin" } = {}) {
    const init = { method, redirect: "manual", headers: { ...headers } };
    if (jar.size) init.headers.cookie = cookieHeader();
    if (site) init.headers["sec-fetch-site"] = site;
    if (form) {
      init.headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }
    const response = await fetch(`${ctx.base}${path}`, init);
    apply(response.headers.getSetCookie());
    return { response, status: response.status, location: response.headers.get("location"), setCookies: response.headers.getSetCookie(), text: await response.text() };
  }
  return { jar, apply, request };
}

// Signs `who` in to the gateway's pages as `oid`, starting at /signin?next=<next>, through the stub tenant. `callbackIn`
// is the browser the tenant's redirect lands in (the same one, unless a test moves it). Returns the callback's result.
export async function pageSignIn(ctx, who, { oid, next = "/account", callbackIn = who, claims } = {}) {
  const begun = await who.request(`/signin?next=${encodeURIComponent(next)}`);
  assert.equal(begun.status, 302, `signin gave ${begun.status}: ${begun.text}`);
  const url = new URL(begun.location);
  const code = ctx.tenant.authorize(url, { oid, claims });
  return callbackIn.request(`/oauth/entra/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get("state"))}`, { site: "cross-site" });
}

// An access token the tenant would issue to the `ouro` CLI for the gateway's app, with app roles `roles`.
export async function adminToken(ctx, { oid = ARI_OID, roles = ["ouro.admin"], claims = {} } = {}) {
  const iat = Math.floor(ctx.now() / 1000);
  return ctx.tenant.idToken({ ver: "2.0", iss: ISSUER, aud: CLIENT_ID, tid: TENANT_ID, iat, nbf: iat, exp: iat + 3600, oid, azp: CLI_CLIENT_ID, scp: "desk.admin", roles, ...claims });
}

export async function adminCall(ctx, method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${ctx.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text, headers: response.headers };
}
