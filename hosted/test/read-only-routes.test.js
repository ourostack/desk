// Each route either app lists in READ_ONLY_ROUTES writes nothing: served with every collaborator recording its calls,
// the route touches nothing but the reads named here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createProvider } from "../src/auth/provider.js";
import { READ_ONLY_ROUTES as GATEWAY_ROUTES, createApp, createDeepHealth } from "../src/server.js";
import { READ_ONLY_ROUTES as HOOKS_ROUTES, createHooksApp } from "../src/hooks/app.js";
import { hooksStoreOn, tableNames } from "../src/hooks/core.js";
import { memoryBackend } from "../src/hooks/memory-store.js";
import { hooksKey } from "../src/hooks/seal.js";

const ISSUER = "https://desk.ouro.bot";
const RESOURCE = "https://desk.ouro.bot/mcp";

// Wraps an object so each method call is recorded by name and then forwarded.
function recording(target, calls) {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      return typeof value === "function"
        ? (...args) => {
            calls.push(String(key));
            return value.apply(object, args);
          }
        : value;
    },
  });
}

async function serve(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// A listed route, as a request: `USE /assets` is any file under it, and `ALL` is tried with POST, a write by method.
const requestFor = (entry) => {
  const [method, path] = entry.split(" ");
  return { method: method === "ALL" ? "POST" : method === "USE" ? "GET" : method, path: path === "/assets" ? "/assets/desk-logo.png" : path };
};

test("every gateway route on READ_ONLY_ROUTES reaches no relay, no GitHub and no store write", async (t) => {
  const calls = [];
  const github = [];
  const provider = recording(createProvider({ key: "test-key-0123456789abcdef0123456789abcdef", issuer: ISSUER, github: { clientId: "x", clientSecret: "y", fetch: (...args) => github.push(args) }, allowedLogins: ["arimendelow"], resource: RESOURCE, log: () => {} }), calls);
  const relay = recording({ handle: () => assert.fail("no relay call expected") }, calls);
  const store = recording({ getAccount: async () => ({ ok: true }) }, calls);
  const deepHealth = createDeepHealth({ discovery: { ready: () => true, mismatch: () => false }, store, accountIds: ["a"], now: () => 0 });
  const base = await serve(t, createApp({ provider, relay, githubCallback: provider.githubCallback, issuer: ISSUER, resource: RESOURCE, unavailable: "Hosted Desk is not set up yet.", deepHealth, log: () => {} }));
  calls.length = 0;
  assert.ok(GATEWAY_ROUTES.length > 0);
  for (const entry of GATEWAY_ROUTES) {
    const { method, path } = requestFor(entry);
    const response = await fetch(`${base}${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" } : {}) });
    assert.ok(response.status < 500 || response.status === 503, `${entry} answered ${response.status}`);
  }
  assert.deepEqual(github, [], "no GitHub call");
  assert.deepEqual([...new Set(calls)], ["getAccount"], "only the store's read");
});

test("every hooks route on READ_ONLY_ROUTES calls only the store's reads", async (t) => {
  const calls = [];
  const names = tableNames("");
  const backend = recording(memoryBackend(names), calls);
  const store = hooksStoreOn(backend, names);
  await store.createHook({ accountId: "acct", name: "seen", id: "A".repeat(22), verify: { preset: "none" }, sealedSecret: null, createdAt: 1 });
  const identity = async () => ({ accountId: "acct" });
  const base = await serve(t, createHooksApp({ store, identity, key: hooksKey("client-key-for-tests"), publicUrl: "https://hooks.example", log: () => {} }));
  calls.length = 0;
  assert.ok(HOOKS_ROUTES.length > 0);
  for (const entry of HOOKS_ROUTES) {
    const { method, path } = requestFor(entry);
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer owner" } });
    assert.equal(response.status, 200, entry);
  }
  assert.ok(calls.includes("query"), "GET /hooks reads the store");
  assert.deepEqual([...new Set(calls)].filter((name) => !["get", "query"].includes(name)), [], "only reads reach the backend");
});
