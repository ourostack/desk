// The hooks receiver over real HTTP, with the in-memory store and a fake GitHub sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import { createHooksApp } from "../src/hooks/app.js";
import { createHooksMemoryStore } from "../src/hooks/memory-store.js";
import { HooksStoreError, MAX_BODY_BYTES } from "../src/hooks/core.js";
import { hooksKey } from "../src/hooks/seal.js";

const KEY = hooksKey("client-key-for-tests");
const OWNER = { authorization: "Bearer owner" };
const OTHER = { authorization: "Bearer other" };
const identity = async (header) =>
  header === "Bearer owner" ? { accountId: "acct-owner" } : header === "Bearer other" ? { accountId: "acct-other" } : { status: 401, error: "send Authorization: Bearer <GitHub token>" };

async function serve(t, { store = createHooksMemoryStore(), now = () => Date.now(), identify = identity } = {}) {
  const logs = [];
  const app = createHooksApp({ store, identity: identify, key: KEY, publicUrl: "https://hooks.example/", now, log: (line) => logs.push(line) });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { headers = {}, body, json } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : body });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { call, logs, store };
}

const standardHeaders = (secret, raw, { id = `msg_${randomBytes(4).toString("hex")}`, timestamp = Math.floor(Date.now() / 1000) } = {}) => ({
  "webhook-id": id,
  "webhook-timestamp": String(timestamp),
  "webhook-signature": `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw])).digest("base64")}`,
});

async function makeStandard(call, name = "smoke") {
  const created = await call("POST", "/hooks", { headers: OWNER, json: { name, verify: "standard" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { ...created.body, path: new URL(created.body.url).pathname };
}

test("healthz answers ok and an unknown route or id gets the same 404", async (t) => {
  const { call } = await serve(t);
  assert.deepEqual(await call("GET", "/healthz").then((r) => [r.status, r.body]), [200, "ok"]);
  const route = await call("GET", "/nope");
  const id = await call("POST", `/hooks/${randomBytes(16).toString("base64url")}`, { body: "{}" });
  const shape = await call("POST", "/hooks/short", { body: "{}" });
  for (const answer of [route, id, shape]) assert.deepEqual([answer.status, answer.body], [404, { code: "hook-not-found", error: "not found" }]);
});

test("create, receive, read, acknowledge and read empty, end to end", async (t) => {
  const { call, logs } = await serve(t);
  const hook = await makeStandard(call);
  assert.match(hook.url, /^https:\/\/hooks\.example\/hooks\/[A-Za-z0-9_-]{22}$/);
  assert.match(hook.secret, /^whsec_/);
  assert.equal(hook.verify, "standard");
  // Odd whitespace and key order: verified on the exact bytes, stored byte-equal.
  const raw = Buffer.from('{ "z": 1,  "a":[ 2 ] }  \n');
  const sent = await call("POST", hook.path, { headers: { ...standardHeaders(hook.secret, raw), "content-type": "application/json", authorization: "Bearer leak", cookie: "c=1", "x-github-event": "ping" }, body: raw });
  assert.deepEqual([sent.status, sent.body], [202, { accepted: true }]);
  const listed = await call("GET", "/hooks", { headers: OWNER });
  assert.equal(listed.body[0].pending, 1);
  assert.equal(listed.body[0].verify, "standard");
  assert.ok(listed.body[0].lastEventAt);
  assert.equal("url" in listed.body[0], false, "the address is shown once, at creation");
  const read = await call("GET", "/hooks/smoke/events", { headers: OWNER });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const [event] = read.body.events;
  assert.ok(Buffer.from(event.body, "base64").equals(raw));
  assert.equal(event.headers["x-github-event"], "ping");
  assert.equal(event.headers.authorization, undefined);
  assert.equal(event.headers.cookie, undefined);
  assert.equal(event.deliveryId.startsWith("msg_"), true);
  assert.equal((await call("DELETE", `/hooks/smoke/events/${event.eventId}`, { headers: OWNER })).status, 204);
  assert.equal((await call("DELETE", `/hooks/smoke/events/${event.eventId}`, { headers: OWNER })).status, 404);
  assert.deepEqual((await call("GET", "/hooks/smoke/events", { headers: OWNER })).body, { events: [], expired: 0 });
  // Logs name the hook, status and size, never the secret, id or body.
  const text = logs.join("\n");
  assert.match(text, /hooks: receive smoke 202 \d+ bytes/);
  assert.ok(!text.includes(hook.secret) && !text.includes(hook.path.slice(7)) && !text.includes('"z"'));
});

test("a bad signature is 401 and shows as the hook's last rejection; a stale timestamp too", async (t) => {
  const { call } = await serve(t);
  const hook = await makeStandard(call);
  const raw = Buffer.from("{}");
  const wrong = { ...standardHeaders(hook.secret, raw), "webhook-signature": "v1,AAAA" };
  const refused = await call("POST", hook.path, { headers: wrong, body: raw });
  assert.deepEqual([refused.status, refused.body], [401, { code: "signature-refused", error: "refused: signature does not match" }]);
  assert.equal((await call("GET", "/hooks", { headers: OWNER })).body[0].lastRejection.reason, "signature does not match");
  const stale = await call("POST", hook.path, { headers: standardHeaders(hook.secret, raw, { timestamp: Math.floor(Date.now() / 1000) - 301 }), body: raw });
  assert.equal(stale.status, 401);
  assert.equal((await call("GET", "/hooks", { headers: OWNER })).body[0].pending, 0);
});

test("a repeated delivery id answers 200 and stores one copy", async (t) => {
  const { call } = await serve(t);
  const hook = await makeStandard(call);
  const raw = Buffer.from("{}");
  const headers = standardHeaders(hook.secret, raw, { id: "msg_same" });
  assert.equal((await call("POST", hook.path, { headers, body: raw })).status, 202);
  const again = await call("POST", hook.path, { headers, body: raw });
  assert.deepEqual([again.status, again.body], [200, { accepted: true, duplicate: true }]);
  assert.equal((await call("GET", "/hooks", { headers: OWNER })).body[0].pending, 1);
});

test("create bodies accept exactly 16 KB and report that limit at 16 KB + 1", async (t) => {
  const { call } = await serve(t);
  const bodyAt = (name, bytes) => {
    const json = JSON.stringify({ name, verify: "none", padding: "\u00e9" });
    return Buffer.from(json + " ".repeat(bytes - Buffer.byteLength(json)));
  };
  const exact = bodyAt("exact", 16384);
  const over = bodyAt("over", 16385);
  const headers = { ...OWNER, "content-type": "application/json" };
  const accepted = await call("POST", "/hooks", { headers, body: exact });
  assert.equal(accepted.status, 201);
  const refused = await call("POST", "/hooks", { headers, body: over });
  assert.deepEqual([refused.status, refused.body], [413, { code: "body-too-large", error: "the body is over 16384 bytes" }]);
  assert.deepEqual((await call("GET", "/hooks", { headers: OWNER })).body.map((hook) => hook.name), ["exact"]);
  t.diagnostic(JSON.stringify({ createBytes: over.length, status: refused.status, ...refused.body }));
});

test("bodies at the edges: empty, exactly 512 KB and binary round-trip; 512 KB + 1 is 413", async (t) => {
  const { call } = await serve(t);
  const created = await call("POST", "/hooks", { headers: OWNER, json: { name: "open", verify: "none" } });
  assert.equal(created.body.secret, undefined);
  const path = new URL(created.body.url).pathname;
  const exact = randomBytes(MAX_BODY_BYTES);
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]);
  assert.equal((await call("POST", path)).status, 202);
  assert.equal((await call("POST", path, { body: exact, headers: { "content-type": "application/octet-stream" } })).status, 202);
  assert.equal((await call("POST", path, { body: binary, headers: { "content-type": "application/octet-stream" } })).status, 202);
  const over = await call("POST", path, { body: randomBytes(MAX_BODY_BYTES + 1) });
  assert.deepEqual([over.status, over.body], [413, { code: "body-too-large", error: `the body is over ${MAX_BODY_BYTES} bytes` }]);
  const bodies = (await call("GET", "/hooks/open/events", { headers: OWNER })).body.events.map((event) => Buffer.from(event.body, "base64"));
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].length, 0);
  assert.ok(bodies[1].equals(exact));
  assert.ok(bodies[2].equals(binary));
});

test("an unsupported content encoding is refused with its own status", async (t) => {
  const { call } = await serve(t);
  const created = await call("POST", "/hooks", { headers: OWNER, json: { name: "open", verify: "none" } });
  const answer = await call("POST", new URL(created.body.url).pathname, { body: "x", headers: { "content-encoding": "br-nonsense" } });
  assert.deepEqual([answer.status, answer.body], [415, { code: "body-unreadable", error: "the request body could not be read" }]);
});

test("management needs a mapped GitHub token, and each account sees only its own hooks", async (t) => {
  const { call } = await serve(t);
  await makeStandard(call);
  assert.deepEqual(await call("GET", "/hooks").then((r) => [r.status, r.body]), [401, { code: "identity-refused", error: "send Authorization: Bearer <GitHub token>" }]);
  assert.deepEqual((await call("GET", "/hooks", { headers: OTHER })).body, []);
  assert.equal((await call("GET", "/hooks/smoke/events", { headers: OTHER })).status, 404);
  assert.equal((await call("DELETE", "/hooks/smoke", { headers: OTHER })).status, 404);
  // Another account may use the same name.
  assert.equal((await call("POST", "/hooks", { headers: OTHER, json: { name: "smoke", verify: "standard" } })).status, 201);
});

test("unavailable identity verification stays retryable rather than becoming a sign-in refusal", async (t) => {
  const { call } = await serve(t, { identify: async () => ({ status: 503, error: "try again shortly" }) });
  const unavailable = await call("GET", "/hooks", { headers: OWNER });
  assert.deepEqual([unavailable.status, unavailable.body], [503, { code: "identity-unavailable", error: "try again shortly" }]);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
});

test("creating checks the name, preset and who makes the secret", async (t) => {
  const { call } = await serve(t);
  const cases = [
    [{ name: "Bad_Name" }, 400, /name must be/, "hook-name-invalid"],
    [{ name: "x".repeat(41) }, 400, /name must be/, "hook-name-invalid"],
    [{ name: "a", verify: "md5" }, 400, /unknown verify preset md5; use standard/, "verification-invalid"],
    [{ name: "a", verify: "standard", secret: "mine" }, 400, /makes its own secret/, "secret-unexpected"],
    [{ name: "a", verify: "stripe" }, 400, /needs the signing secret/, "secret-required"],
    [{ name: "a", verify: "stripe", secret: "has space" }, 400, /needs the signing secret/, "secret-required"],
    [{ name: "a", verify: "none", secret: "x" }, 400, /has no secret/, "secret-unexpected"],
  ];
  for (const [json, status, error, code] of cases) {
    const answer = await call("POST", "/hooks", { headers: OWNER, json });
    assert.equal(answer.status, status, JSON.stringify(json));
    assert.match(answer.body.error, error);
    assert.equal(answer.body.code, code);
  }
  assert.deepEqual(await call("POST", "/hooks", { headers: { ...OWNER, "content-type": "application/json" }, body: "{" }).then((r) => [r.status, r.body]), [400, { code: "body-not-json", error: "the body is not valid JSON" }]);
  // The default preset is standard.
  assert.equal((await call("POST", "/hooks", { headers: OWNER, json: { name: "plain" } })).body.verify, "standard");
  const duplicate = await call("POST", "/hooks", { headers: OWNER, json: { name: "plain" } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "hook-conflict");
  // A sender's secret is kept, never echoed, and verifies its events.
  const sentry = await call("POST", "/hooks", { headers: OWNER, json: { name: "sentry", verify: "sentry", secret: "sentry-secret" } });
  assert.equal(sentry.status, 201);
  assert.equal(sentry.body.secret, undefined);
  const raw = Buffer.from('{"action":"triggered"}');
  const signature = createHmac("sha256", "sentry-secret").update(raw).digest("hex");
  assert.equal((await call("POST", new URL(sentry.body.url).pathname, { headers: { "sentry-hook-signature": signature, "request-id": "r1", "sentry-hook-resource": "event_alert" }, body: raw })).status, 202);
  // GitHub's secret is made here and shown once.
  const github = await call("POST", "/hooks", { headers: OWNER, json: { name: "gh", verify: "github" } });
  assert.match(github.body.secret, /^[A-Za-z0-9_-]{43}$/);
});

test("reading events checks the limit, and deleting a hook removes it", async (t) => {
  const { call } = await serve(t);
  await makeStandard(call);
  for (const limit of ["0", "101", "abc"]) {
    const invalid = await call("GET", `/hooks/smoke/events?limit=${limit}`, { headers: OWNER });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "event-limit-invalid");
  }
  assert.equal((await call("GET", "/hooks/smoke/events?limit=100", { headers: OWNER })).status, 200);
  const missingEvent = await call("DELETE", "/hooks/smoke/events/not-an-id", { headers: OWNER });
  assert.deepEqual([missingEvent.status, missingEvent.body.code], [404, "event-not-found"]);
  const missingHook = await call("GET", "/hooks/NOPE/events", { headers: OWNER });
  assert.deepEqual([missingHook.status, missingHook.body.code], [404, "hook-not-found"]);
  assert.equal((await call("DELETE", "/hooks/smoke", { headers: OWNER })).status, 204);
  assert.deepEqual((await call("GET", "/hooks", { headers: OWNER })).body, []);
});

test("Table Storage throttling answers 503 with its Retry-After, so the sender retries", async (t) => {
  const store = createHooksMemoryStore();
  const { call, logs } = await serve(t, { store });
  const created = await call("POST", "/hooks", { headers: OWNER, json: { name: "open", verify: "none" } });
  store.addEvent = async () => {
    throw new HooksStoreError("create", "hookevents", { statusCode: 503, code: "ServerBusy", retryAfter: 9 });
  };
  const busy = await call("POST", new URL(created.body.url).pathname, { body: "x" });
  assert.deepEqual([busy.status, busy.body, busy.headers.get("retry-after")], [503, { code: "storage-unavailable", error: "storage is unavailable; try again shortly" }, "9"]);
  store.addEvent = async () => {
    throw new HooksStoreError("create", "hookevents", { code: "timed out" });
  };
  const slow = await call("POST", new URL(created.body.url).pathname, { body: "x" });
  assert.deepEqual([slow.status, slow.headers.get("retry-after")], [503, null]);
  store.addEvent = async () => {
    throw new TypeError("boom with a secret in it");
  };
  const broken = await call("POST", new URL(created.body.url).pathname, { body: "x" });
  assert.deepEqual([broken.status, broken.body], [500, { code: "internal-error", error: "internal error" }]);
  assert.ok(!logs.join("\n").includes("secret in it"));
});

test("a failed rejection note still answers 401", async (t) => {
  const store = createHooksMemoryStore();
  const { call } = await serve(t, { store });
  const hook = await makeStandard(call);
  store.noteRejection = async () => {
    throw new Error("store down");
  };
  assert.equal((await call("POST", hook.path, { body: "{}" })).status, 401);
});
