// The hooks store. One suite runs against the in-memory store and, with DESK_AZURITE=1, against the Table store on
// Azurite, whose transactions and binary properties are the real ones. Test names carry `[memory]` or `[azurite]`.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { AzureNamedKeyCredential } from "@azure/data-tables";
import { createHooksMemoryStore, memoryBackend } from "../src/hooks/memory-store.js";
import { createHooksTableStore, hooksStoreError, retryAfterOf } from "../src/hooks/store.js";
import { createHooksApp } from "../src/hooks/app.js";
import { Conflict, EXPIRY_MS, MAX_BODY_BYTES, hooksStoreOn, newEventId, tableNames } from "../src/hooks/core.js";
import { azuriteFromEnv } from "./fixtures/azurite.mjs";

const azurite = await azuriteFromEnv();
const NOW = Date.parse("2026-11-20T21:00:00Z");
const VERIFY = { preset: "standard", scheme: "standard", secretFrom: "server" };

let ids = 0;
const hookId = () => randomBytes(16).toString("base64url");
const event = (receivedAt, extra = {}) => ({ eventId: newEventId(receivedAt + ids++), receivedAt, deliveryId: null, headers: { "content-type": "application/json" }, body: Buffer.from('{"n":1}'), ...extra });

async function newHook(store, name = "smoke") {
  const hook = { accountId: randomUUID(), name, id: hookId(), verify: VERIFY, sealedSecret: "sealed", createdAt: NOW };
  await store.createHook(hook);
  return hook;
}

function storeSuite(label, make) {
  const name = (text) => `${label} ${text}`;
  describe(`${label} hooks store`, { skip: make === null && "set DESK_AZURITE=1 with Azurite running to run the Table store suite" }, () => {
    test(name("a hook is found by id and by name, and listed for its account only"), async () => {
      const store = await make();
      const hook = await newHook(store);
      const byId = await store.hookById(hook.id);
      assert.deepEqual(byId, { id: hook.id, accountId: hook.accountId, name: "smoke", verify: VERIFY, sealedSecret: "sealed", createdAt: new Date(NOW).toISOString(), lastEventAt: null, lastRejection: null });
      assert.deepEqual(await store.hookByName(hook.accountId, "smoke"), byId);
      assert.equal(await store.hookByName(randomUUID(), "smoke"), null);
      assert.equal(await store.hookById(hookId()), null);
      assert.deepEqual((await store.listHooks(hook.accountId)).map((h) => h.name), ["smoke"]);
      assert.deepEqual(await store.listHooks(randomUUID()), []);
    });

    test(name("a second hook with the same name on one account is a Conflict"), async () => {
      const store = await make();
      const hook = await newHook(store);
      await assert.rejects(store.createHook({ ...hook, id: hookId() }), Conflict);
    });

    test(name("a repeated delivery id stores one copy"), async () => {
      const store = await make();
      const hook = await newHook(store);
      assert.equal(await store.addEvent(hook.id, event(NOW, { deliveryId: "gh-1" })), "stored");
      assert.equal(await store.addEvent(hook.id, event(NOW + 1000, { deliveryId: "gh-1" })), "duplicate");
      assert.equal(await store.addEvent(hook.id, event(NOW + 2000, { deliveryId: "gh-2" })), "stored");
      assert.equal(await store.pending(hook.id), 2);
      assert.equal((await store.hookById(hook.id)).lastEventAt, new Date(NOW + 2000).toISOString());
    });

    test(name("a delivery id seen more than 7 days ago is a new delivery"), async () => {
      const store = await make();
      const hook = await newHook(store);
      await store.addEvent(hook.id, event(NOW, { deliveryId: "old" }));
      assert.equal(await store.addEvent(hook.id, event(NOW + EXPIRY_MS + 1, { deliveryId: "old" })), "stored");
    });

    test(name("a 524,288-byte body round-trips byte-equal, and so does an empty one, oldest first"), async () => {
      const store = await make();
      const hook = await newHook(store);
      const big = randomBytes(MAX_BODY_BYTES);
      await store.addEvent(hook.id, event(NOW, { body: big }));
      await store.addEvent(hook.id, event(NOW + 1, { body: Buffer.alloc(0), headers: {} }));
      const { events, expired } = await store.listEvents(hook.id, { limit: 50, now: NOW + 2 });
      assert.equal(expired, 0);
      assert.equal(events.length, 2);
      assert.ok(events[0].body.equals(big), "the 512 KB body comes back byte-equal");
      assert.equal(events[1].body.length, 0);
      assert.deepEqual(events[1].headers, {});
      assert.ok(events[0].eventId < events[1].eventId);
    });

    test(name("listEvents honours the limit and removes events older than 7 days, counting them"), async () => {
      const store = await make();
      const hook = await newHook(store);
      await store.addEvent(hook.id, event(NOW, { deliveryId: "aged" }));
      await store.addEvent(hook.id, event(NOW + 10));
      await store.addEvent(hook.id, event(NOW + 20));
      const later = NOW + EXPIRY_MS + 1;
      const first = await store.listEvents(hook.id, { limit: 1, now: later });
      assert.equal(first.expired, 1);
      assert.equal(first.events.length, 1);
      assert.equal(first.events[0].receivedAt, new Date(NOW + 10).toISOString());
      assert.equal(await store.pending(hook.id), 2);
      // The aged delivery mark went with it, so the same id is new again.
      assert.equal(await store.addEvent(hook.id, event(later, { deliveryId: "aged" })), "stored");
    });

    test(name("deleteEvent acknowledges one event"), async () => {
      const store = await make();
      const hook = await newHook(store);
      const one = event(NOW);
      await store.addEvent(hook.id, one);
      assert.equal(await store.deleteEvent(hook.id, one.eventId), true);
      assert.equal(await store.deleteEvent(hook.id, one.eventId), false);
      assert.equal(await store.pending(hook.id), 0);
    });

    test(name("noteRejection is shown on the hook"), async () => {
      const store = await make();
      const hook = await newHook(store);
      await store.noteRejection(hook.id, "signature does not match", NOW);
      assert.deepEqual((await store.hookById(hook.id)).lastRejection, { reason: "signature does not match", at: new Date(NOW).toISOString() });
    });

    test(name("deleteHook removes the hook and its events"), async () => {
      const store = await make();
      const hook = await newHook(store);
      await store.addEvent(hook.id, event(NOW, { deliveryId: "x" }));
      assert.equal(await store.deleteHook(hook.accountId, "smoke"), true);
      assert.equal(await store.deleteHook(hook.accountId, "smoke"), false);
      assert.equal(await store.hookById(hook.id), null);
      assert.equal(await store.pending(hook.id), 0);
      // The name is free again.
      await store.createHook({ ...hook, id: hookId() });
    });
  });
}

storeSuite("[memory]", async () => createHooksMemoryStore());
storeSuite(
  "[azurite]",
  azurite &&
    (async () => {
      const store = createHooksTableStore({ ...azurite, tablePrefix: `t${randomBytes(4).toString("hex")}` });
      await store.ensure();
      return store;
    }),
);

test("a hook whose id row fails to write leaves no name behind", async () => {
  const rows = new Map();
  const backend = {
    async create(table, entity) {
      if (entity.partitionKey.startsWith("id:")) throw new Error("store down");
      rows.set(`${entity.partitionKey}/${entity.rowKey}`, entity);
    },
    async remove(table, pk, rk) {
      return rows.delete(`${pk}/${rk}`);
    },
  };
  const store = hooksStoreOn(backend, tableNames());
  await assert.rejects(store.createHook({ accountId: "a", name: "n", id: "i", verify: VERIFY, createdAt: NOW }), /store down/);
  assert.equal(rows.size, 0);
});

test("a hook name row pointing at another account's hook is not that hook", async () => {
  const backend = {
    async get(table, pk) {
      return pk.startsWith("id:") ? { partitionKey: pk, rowKey: "", accountId: "other", name: "n", verify: "{}", createdAt: "x" } : { id: "i" };
    },
    async query() {
      return [{ id: "i" }];
    },
  };
  const store = hooksStoreOn(backend, tableNames());
  assert.equal(await store.hookByName("mine", "n"), null);
  assert.deepEqual(await store.listHooks("mine"), []);
});

test("a failing lastEventAt write never fails a stored event", async () => {
  const backend = {
    async createAll() {},
    async merge() {
      throw new Error("store down");
    },
  };
  assert.equal(await hooksStoreOn(backend, tableNames()).addEvent("h", event(NOW)), "stored");
});

test("a hook whose creation stopped after its name row can be deleted, freeing the name", async () => {
  const names = tableNames();
  const backend = memoryBackend(names);
  let failNext = false;
  const store = hooksStoreOn({ ...backend, create: async (table, entity) => {
    if (failNext && entity.partitionKey.startsWith("id:")) throw new Error("store down");
    return backend.create(table, entity);
  }, remove: async (table, pk, rk) => {
    if (failNext) throw new Error("store down");
    return backend.remove(table, pk, rk);
  } }, names);
  failNext = true;
  const hook = { accountId: "acct", name: "stuck", id: hookId(), verify: VERIFY, sealedSecret: "", createdAt: NOW };
  await assert.rejects(store.createHook(hook), /store down/);
  failNext = false;
  assert.deepEqual(await store.listHooks("acct"), []);
  await assert.rejects(store.createHook({ ...hook, id: hookId() }), Conflict);
  assert.equal(await store.deleteHook("acct", "stuck"), true);
  await store.createHook({ ...hook, id: hookId() });
  assert.equal((await store.hookByName("acct", "stuck")).name, "stuck");
  // Another account's name row pointing at this hook's id is not this account's to delete.
  await backend.create(names.hooks, { partitionKey: "other", rowKey: "stuck", id: (await store.hookByName("acct", "stuck")).id });
  assert.equal(await store.deleteHook("other", "stuck"), false);
});

test("two events with the same event id and no delivery id: the second is an error the sender retries, never a silent drop", async () => {
  const store = createHooksMemoryStore();
  const hook = await newHook(store);
  const one = event(NOW);
  await store.addEvent(hook.id, one);
  await assert.rejects(store.addEvent(hook.id, { ...one }), Conflict);
  assert.equal(await store.pending(hook.id), 1);
});

test("store errors name the status and Table Storage's Retry-After, never a key", () => {
  const throttled = { statusCode: 503, details: { errorCode: "ServerBusy" }, response: { headers: { get: (name) => (name === "retry-after" ? "7" : undefined) } }, message: "https://x/hookevents(PartitionKey='SECRETID')" };
  const error = hooksStoreError("create", "hookevents", throttled);
  assert.equal(error.statusCode, 503);
  assert.equal(error.retryAfter, 7);
  assert.equal(error.message, "the hooks store failed: create on table hookevents (HTTP 503 ServerBusy)");
  assert.equal(hooksStoreError("get", "hooks", { name: "AbortError" }).message, "the hooks store failed: get on table hooks (timed out)");
  assert.equal(hooksStoreError("get", "hooks", { statusCode: 500, response: { headers: { get: () => "soon" } } }).retryAfter, undefined);
  assert.equal(hooksStoreError("get", "hooks", { code: "ECONNREFUSED" }).message, "the hooks store failed: get on table hooks (ECONNREFUSED)");
});

test("Retry-After is read from retry-after-ms, x-ms-retry-after-ms or Retry-After, as seconds or a date", () => {
  const withHeaders = (headers) => ({ response: { headers: { get: (name) => headers[name] } } });
  assert.equal(retryAfterOf(withHeaders({ "retry-after-ms": "1500" })), 2);
  assert.equal(retryAfterOf(withHeaders({ "x-ms-retry-after-ms": "200", "retry-after": "40" })), 1);
  assert.equal(retryAfterOf(withHeaders({ "retry-after-ms": "nope", "retry-after": "40" })), 40);
  assert.equal(retryAfterOf(withHeaders({ "retry-after": new Date(NOW + 20_000).toUTCString() }), NOW), 20);
  assert.equal(retryAfterOf(withHeaders({ "retry-after": new Date(NOW - 20_000).toUTCString() }), NOW), undefined);
  assert.equal(retryAfterOf(withHeaders({ "retry-after": "99999" })), 3600);
  assert.equal(retryAfterOf(withHeaders({})), undefined);
  assert.equal(retryAfterOf(undefined), undefined);
});

test("a throttled Table Storage reaches the sender as 503 with its own Retry-After, through the real SDK pipeline", async (t) => {
  let requests = 0;
  const busy = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(503, { "Content-Type": "application/json;odata=minimalmetadata", "Retry-After": "12", "x-ms-error-code": "ServerBusy" });
    res.end(JSON.stringify({ "odata.error": { code: "ServerBusy", message: { lang: "en-US", value: "The server is busy." } } }));
  });
  await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
  t.after(() => busy.close());
  const store = createHooksTableStore({ endpoint: `http://127.0.0.1:${busy.address().port}/devstoreaccount1`, credential: new AzureNamedKeyCredential("devstoreaccount1", "a2V5"), timeoutMs: 2_000 });
  const app = createHooksApp({ store, identity: async () => ({ accountId: "a" }), key: Buffer.alloc(32), publicUrl: "https://h.example", log: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/hooks/${hookId().slice(0, 22)}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "12");
  assert.equal(requests, 1, "the SDK did not sleep and retry on the throttle");
  assert.ok(Date.now() - started < 1_500);
});

test("the Table store refuses plain http except on loopback, and table prefixes must be alphanumeric", () => {
  assert.throws(() => createHooksTableStore({ endpoint: "http://example.table.core.windows.net", credential: {} }), /https/);
  assert.doesNotThrow(() => createHooksTableStore({ endpoint: "https://example.table.core.windows.net", credential: {} }));
  assert.throws(() => tableNames("bad-prefix"), /alphanumeric/);
});

test("a Table store that stops answering fails within its deadline", async (t) => {
  const silent = createServer(() => {});
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => silent.close());
  silent.unref();
  const store = createHooksTableStore({ endpoint: `http://127.0.0.1:${silent.address().port}/devstoreaccount1`, credential: new AzureNamedKeyCredential("devstoreaccount1", "a2V5"), timeoutMs: 200 });
  const started = Date.now();
  await assert.rejects(store.hookById("abc"), /the hooks store failed: get on table hooks \(timed out\)/);
  assert.ok(Date.now() - started < 3000);
  silent.closeAllConnections();
});
