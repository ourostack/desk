import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import http from "node:http"
import { mkdir, writeFile, unlink } from "node:fs/promises"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
const require = createRequire(import.meta.url)
const native = require(path.join(mcpRoot, "web-native-messaging.cjs"))

test("native session acquires once and creates no window until actual first use", async () => {
  const calls = []
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1:1234/provider/" + "a".repeat(64),
    request: async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === "acquire") return { leaseId: "lease-a", owner: payload.owner, endpoint: "http://127.0.0.1:1234/proxy" }
      return { targetId: "lease-a:101" }
    },
  })
  await Promise.all([session.setOwner("agent"), session.setOwner("agent")])
  assert.deepEqual(calls.map(call => call.operation), ["acquire"])
  assert.equal(session.environment().DESK_NATIVE_LEASE_ID, "lease-a")
  assert.equal(session.environment().DESK_BROWSER_OWNER, "agent")
  await session.ensureWindow()
  assert.equal(calls.at(-1).operation, "ensureWindow")
  assert.equal(calls.at(-1).payload.owner, "agent")
  assert.ok(session.secrets().includes("a".repeat(64)), "standalone provider capability must be redacted as well as the full endpoint")
})

test("native session close detaches client before clear and never releases the shared browser", async () => {
  const order = []
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1:1234/provider/" + "a".repeat(64),
    request: async operation => { order.push(operation); return operation === "acquire" ? { leaseId: "lease-a", owner: "agent", endpoint: "http://127.0.0.1/proxy" } : { cleared: true, released: true } },
  })
  await session.setOwner("agent")
  await session.clear(async () => order.push("detach"))
  assert.deepEqual(order, ["acquire", "detach", "clear"])
  await session.release()
  assert.equal(order.at(-1), "release")
})

test("native session cleanup does not erase provider refusal or replace an acquired owner", async () => {
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1:1234/provider/" + "a".repeat(64),
    request: async operation => {
      if (operation === "acquire") return { leaseId: "lease-a", owner: "agent", endpoint: "http://127.0.0.1/proxy" }
      throw Object.assign(new Error("partial cleanup"), { code: "PARTIAL_CLEAR" })
    },
  })
  await session.setOwner("agent")
  await assert.rejects(session.setOwner("different"), /browser_owner_identity_conflict/u)
  await assert.rejects(session.clear(async () => {}), error => error.code === "PARTIAL_CLEAR")
})

test("shutdown during native acquisition waits and releases the exact late empty lease", async () => {
  let acquired
  const pending = new Promise(resolve => { acquired = resolve })
  const calls = []
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1:1234/provider/" + "a".repeat(64),
    request: async operation => {
      calls.push(operation)
      return operation === "acquire" ? pending : { released: true }
    },
  })
  const opening = session.setOwner("agent")
  const closing = session.release()
  acquired({ leaseId: "lease-a", owner: "agent", endpoint: "http://127.0.0.1/proxy" })
  await opening
  await closing
  assert.deepEqual(calls, ["acquire", "release"])
  assert.throws(() => session.ensureWindow(), /browser_native_session_unavailable/u)
})

test("native use queued behind clear cannot reuse old targets or create after cancellation", async () => {
  let finishDetach
  const detaching = new Promise(resolve => { finishDetach = resolve })
  const calls = []
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1:1234/provider/" + "a".repeat(64),
    request: async operation => {
      calls.push(operation)
      return operation === "acquire" ? { leaseId: "lease-a", owner: "agent", endpoint: "http://127.0.0.1/proxy" }
        : operation === "clear" ? { cleared: true } : { targetId: "new-owned-target" }
    },
  })
  await session.setOwner("agent")
  const closing = session.clear(() => detaching)
  const cancelled = { cancelled: false }
  const queued = session.ensureWindow(cancelled)
  await new Promise(setImmediate)
  assert.deepEqual(calls, ["acquire"], "no old-window use while detach/clear is pending")
  cancelled.cancelled = true
  finishDetach()
  await closing
  await queued
  assert.deepEqual(calls, ["acquire", "clear"], "cancelled queued work must not create another window")
  await session.ensureWindow()
  assert.equal(calls.at(-1), "ensureWindow")
})

test("native release waits for clear and refuses new use while exact release is pending", async () => {
  let finishDetach
  const detaching = new Promise(resolve => { finishDetach = resolve })
  const calls = []
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1:1234/provider/" + "a".repeat(64),
    request: async operation => {
      calls.push(operation)
      return operation === "acquire" ? { leaseId: "lease-a", owner: "agent", endpoint: "http://127.0.0.1/proxy" }
        : { cleared: true, released: true }
    },
  })
  await session.setOwner("agent")
  const clearing = session.clear(() => detaching)
  const releasing = session.release()
  await new Promise(setImmediate)
  assert.deepEqual(calls, ["acquire"])
  assert.throws(() => session.ensureWindow(), /browser_native_session_unavailable/u)
  finishDetach()
  await Promise.all([clearing, releasing])
  assert.deepEqual(calls, ["acquire", "clear", "release"])
})

test("native session resumes only a new operation after exact fresh readiness and never replays a lost call", async t => {
  const root = await mkTempRoot("native-session-resume-")
  const readyFile = path.join(root, "provider.json")
  const identity = { pid: 123, startIdentity: "browser-original", owner: "operator", executable: "/owned/browser", profileRoot: "/owned/profile" }
  const calls = []
  const server = http.createServer(async (request, response) => {
    let input = ""
    for await (const chunk of request) input += chunk
    const { operation, payload } = JSON.parse(input)
    calls.push(operation)
    if (operation === "ensureWindow" && request.url.endsWith("a".repeat(64))) {
      response.destroy()
      return
    }
    let result
    if (operation === "acquire") result = { leaseId: "lease-original", owner: payload.owner, endpoint: "http://127.0.0.1:1234/original-proxy" }
    else if (operation === "attest") {
      assert.deepEqual(payload.expectedProcessIdentity, identity)
      result = { healthy: true, processIdentity: identity }
    } else if (operation === "resume") {
      assert.equal(payload.leaseId, "lease-original")
      assert.equal(payload.owner, "agent")
      result = { leaseId: "lease-original", owner: "agent", endpoint: "http://127.0.0.1:1234/restored-proxy" }
    } else if (operation === "ensureWindow") result = { targetId: "new-operation-target" }
    else assert.fail("unexpected native session operation")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/provider/`
  const session = native.createNativeSession({
    endpoint: base + "a".repeat(64), readyFile, processIdentity: identity, extensionSourceDigest: "c".repeat(64),
  })
  await writeFile(readyFile, JSON.stringify({
    version: 1, endpoint: base + "a".repeat(64), processIdentity: identity, extensionSourceDigest: "c".repeat(64),
  }), { mode: 0o600 })
  await session.setOwner("agent")
  calls.splice(0, calls.indexOf("acquire"))
  await assert.rejects(session.ensureWindow(), error => error.code === "ECONNRESET")
  assert.deepEqual(calls, ["acquire", "ensureWindow"], "lost effect must not be transparently resent")
  await writeFile(readyFile, JSON.stringify({
    version: 1, endpoint: base + "b".repeat(64), processIdentity: identity, extensionSourceDigest: "c".repeat(64),
  }), { mode: 0o600 })
  const resumed = await session.resume()
  assert.equal(resumed.changed, true)
  assert.equal(resumed.endpoint, "http://127.0.0.1:1234/restored-proxy")
  assert.equal(session.environment().DESK_NATIVE_PROVIDER_URL, base + "b".repeat(64))
  await session.ensureWindow()
  assert.deepEqual(calls, ["acquire", "ensureWindow", "attest", "resume", "ensureWindow"])
  await writeFile(readyFile, JSON.stringify({
    version: 1, endpoint: base + "b".repeat(64),
    processIdentity: { ...identity, startIdentity: "browser-replacement" }, extensionSourceDigest: "c".repeat(64),
  }), { mode: 0o600 })
  await assert.rejects(session.resume(), error => error.code === "NATIVE_BROWSER_GENERATION_MISMATCH")
  assert.equal(calls.length, 5, "different generation must fail before provider RPC")
})

test("native preparation IPC keeps update outcomes session-free and preserves stable refusal codes", async () => {
  const root = await mkTempRoot("native-update-ipc-")
  const file = path.join(root, "native-messaging-prepare.mjs")
  await writeFile(file, 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({updated:true,reconciliationRequired:true})+"\\n"));\n')
  const result = await native.prepareNativeMessaging({ mcpRoot: root, runtimeExecutable: process.execPath, update: true })
  assert.equal(result.updated, true)
  assert.equal(result.session, undefined)
  await writeFile(file, 'process.stdin.resume(); process.stdin.on("end",()=>{process.stderr.write("NATIVE_UPDATE_ACTIVE_OWNERS\\n");process.exitCode=1});\n')
  await assert.rejects(native.prepareNativeMessaging({ mcpRoot: root, runtimeExecutable: process.execPath, update: true }),
    error => error.code === "NATIVE_UPDATE_ACTIVE_OWNERS")
})

test("native provider requests reject invalid capabilities and malformed or failed replies", async t => {
  for (const endpoint of [
    "https://127.0.0.1/provider/" + "a".repeat(64), "http://localhost/provider/" + "a".repeat(64),
    "http://127.0.0.1/foreign", "http://user@127.0.0.1/provider/" + "a".repeat(64),
    "http://127.0.0.1/provider/" + "a".repeat(64) + "?key=1",
  ]) await assert.rejects(native.providerRequest(endpoint, "status"), /NATIVE_PROVIDER_ENDPOINT_INVALID/u)
  let reply = "malformed", status = 200
  const server = http.createServer((request, response) => { response.writeHead(status); response.end(reply) })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const endpoint = `http://127.0.0.1:${server.address().port}/provider/${"a".repeat(64)}`
  await assert.rejects(native.providerRequest(endpoint, "status"), /NATIVE_PROVIDER_RESPONSE_INVALID/u)
  reply = '{"ok":false,"error":{"code":"EXACT_PROVIDER_REFUSAL"}}'
  await assert.rejects(native.providerRequest(endpoint, "status"), error => error.code === "EXACT_PROVIDER_REFUSAL")
  reply = '{"ok":true}'; status = 500
  await assert.rejects(native.providerRequest(endpoint, "status"), error => error.code === "NATIVE_PROVIDER_REQUEST_FAILED")
  reply = '{"ok":false,"error":{}}'; status = 200
  await assert.rejects(native.providerRequest(endpoint, "status"), error => error.code === "NATIVE_PROVIDER_REQUEST_FAILED")
  reply = "x".repeat(1048577)
  await assert.rejects(native.providerRequest(endpoint, "status"), /NATIVE_RESPONSE_TOO_LARGE/u)
})

test("native provider timeout terminates only its exact pending request", async t => {
  const request = new (require("node:events").EventEmitter)()
  let destroyed
  request.setTimeout = (ms, callback) => { assert.equal(ms, 30000); queueMicrotask(callback); return request }
  request.destroy = error => { destroyed = error; request.emit("error", error) }
  request.end = () => {}
  t.mock.method(http, "request", () => request)
  await assert.rejects(native.providerRequest("http://127.0.0.1/provider/" + "a".repeat(64), "status"), /NATIVE_PROVIDER_TIMEOUT/u)
  assert.equal(destroyed.message, "NATIVE_PROVIDER_TIMEOUT")
})

test("native session refuses invalid acquisition, use before ownership, and partial cleanup", async () => {
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1/provider/" + "a".repeat(64),
    request: async () => ({ owner: "agent" }),
  })
  assert.throws(() => session.environment(), /browser_native_session_unavailable/u)
  assert.ok(session.secrets().length)
  await session.release()
  for (const owner of [null, "", " ", "x".repeat(161), "bad\nowner"]) {
    await assert.rejects(session.setOwner(owner), /browser_owner_identity_missing/u)
  }
  await assert.rejects(session.setOwner("agent"), /NATIVE_ACQUIRE_RESPONSE_INVALID/u)
  for (const outcome of [null, { cleared: false, released: false }]) {
    const exact = native.createNativeSession({
      endpoint: "http://127.0.0.1/provider/" + "a".repeat(64),
      request: async operation => operation === "acquire"
        ? { leaseId: "lease", owner: "agent", endpoint: "http://127.0.0.1/proxy" } : outcome,
    })
    await exact.setOwner("agent")
    assert.equal((await exact.setOwner("agent")).leaseId, "lease")
    const clear = exact.clear(async () => {})
    assert.equal(exact.clear(async () => assert.fail("duplicate detach")), clear)
    await assert.rejects(clear, /PARTIAL_CLEAR/u)
    const release = exact.release()
    assert.equal(exact.release(), release)
    await assert.rejects(release, /PARTIAL_RELEASE/u)
  }
  const released = native.createNativeSession({
    endpoint: "http://127.0.0.1/provider/" + "a".repeat(64),
    request: async operation => operation === "acquire" ? { leaseId: "lease", owner: "agent", endpoint: "http://127.0.0.1/proxy" } : { released: true },
  })
  await released.setOwner("agent")
  await released.release()
  assert.equal((await released.release()).released, true)
})

test("native resume checks private readiness, source, attestation and exact restored identity", async t => {
  const root = await mkTempRoot("native-resume-negative-")
  const readyFile = path.join(root, "ready.json")
  const identity = { pid: 123, startIdentity: "same", owner: "operator", executable: "/browser", profileRoot: "/profile" }
  let response = { healthy: true, processIdentity: identity }, held, requests = 0
  const server = http.createServer(async (request, reply) => {
    let text = ""; for await (const bytes of request) text += bytes
    const input = JSON.parse(text); requests++
    if (input.operation === "acquire") reply.end(JSON.stringify({ ok: true, result: { leaseId: "lease", owner: "agent", endpoint: "http://127.0.0.1/proxy" } }))
    else if (held) held = () => reply.end(JSON.stringify({ ok: true, result: response }))
    else reply.end(JSON.stringify({ ok: true, result: response }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const endpoint = `http://127.0.0.1:${server.address().port}/provider/${"a".repeat(64)}`
  const session = native.createNativeSession({ endpoint, readyFile, processIdentity: identity, extensionSourceDigest: "c".repeat(64) })
  const write = value => writeFile(readyFile, JSON.stringify(value), { mode: 0o600 })
  const ready = { version: 1, endpoint, processIdentity: identity, extensionSourceDigest: "c".repeat(64) }
  await write(ready)
  await session.setOwner("agent")
  const resume = session.resume()
  assert.equal(session.resume(), resume)
  assert.equal((await resume).changed, false)
  await write({ ...ready, extensionSourceDigest: "d".repeat(64) })
  await assert.rejects(session.resume(), error => error.code === "NATIVE_EXTENSION_SOURCE_MISMATCH")
  const noSource = native.createNativeSession({ endpoint, readyFile, processIdentity: identity })
  await assert.rejects(noSource.setOwner("agent"), error => error.code === "NATIVE_EXTENSION_SOURCE_MISMATCH")
  await write(ready)
  for (const value of [null, { healthy: false }, { healthy: true }, { healthy: true, processIdentity: { ...identity, owner: "foreign" } }]) {
    response = value
    await assert.rejects(session.resume(), error => error.code === "NATIVE_MEDIATOR_UNAVAILABLE")
  }
  response = { healthy: true, processIdentity: identity }
  await write({ ...ready, endpoint: endpoint.replace("a".repeat(64), "b".repeat(64)) })
  await assert.rejects(session.resume(), error => error.code === "NATIVE_RESUME_RESPONSE_INVALID")
  await writeFile(readyFile, "not-json")
  await assert.rejects(session.resume(), { name: "SyntaxError" })
  await unlink(readyFile)
  await mkdir(readyFile)
  await assert.rejects(session.resume(), error => error.code === "NATIVE_READINESS_NOT_PRIVATE")
  assert.ok(requests > 0)
})

test("native use queued immediately before release does not dispatch after retirement starts", async () => {
  const calls = []
  const session = native.createNativeSession({
    endpoint: "http://127.0.0.1/provider/" + "a".repeat(64),
    request: async operation => {
      calls.push(operation)
      return operation === "acquire" ? { leaseId: "lease", owner: "agent", endpoint: "http://127.0.0.1/proxy" }
        : { released: true }
    },
  })
  await session.setOwner("agent")
  const queued = session.ensureWindow()
  const release = session.release()
  await assert.rejects(queued, /browser_native_session_unavailable/u)
  await release
  assert.deepEqual(calls, ["acquire", "release"])
})

test("native preparation IPC refuses non-JSON output and unsanitized child diagnostics", async () => {
  const root = await mkTempRoot("native-prepare-ipc-failure-")
  const file = path.join(root, "native-messaging-prepare.mjs")
  await writeFile(file, 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("not-json"))')
  await assert.rejects(native.prepareNativeMessaging({ mcpRoot: root, runtimeExecutable: process.execPath, ignored: () => {} }),
    /NATIVE_PREPARE_RESPONSE_INVALID/u)
  await writeFile(file, 'process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("unknown private diagnostic");process.exitCode=1})')
  await assert.rejects(native.prepareNativeMessaging({ mcpRoot: root, runtimeExecutable: process.execPath }), error => error.code === "NATIVE_PREPARE_FAILED")
})

test("an empty retained lease resumes the current provider before shutdown release after update", async t => {
  const root = await mkTempRoot("native-empty-update-release-")
  const readyFile = path.join(root, "ready.json")
  const identity = { pid: 123, startIdentity: "same", owner: "operator", executable: "/browser", profileRoot: "/profile" }
  const operations = []
  const server = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk
    const { operation, payload } = JSON.parse(text)
    const replacement = request.url.endsWith("b".repeat(64))
    operations.push({ operation, replacement })
    let result
    if (operation === "acquire") result = { leaseId: "lease", owner: payload.owner, endpoint: "http://127.0.0.1/proxy" }
    else if (operation === "attest") result = { healthy: true, processIdentity: identity }
    else if (operation === "resume") result = { leaseId: "lease", owner: "agent", endpoint: "http://127.0.0.1/new-proxy" }
    else if (operation === "release" && replacement) result = { released: true }
    else { response.writeHead(503); response.end('{"ok":false,"error":{"code":"STALE_PROVIDER"}}'); return }
    response.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/provider/`
  const session = native.createNativeSession({ endpoint: base + "a".repeat(64), readyFile,
    processIdentity: identity, extensionSourceDigest: "c".repeat(64) })
  await writeFile(readyFile, JSON.stringify({ version: 1, endpoint: base + "a".repeat(64),
    processIdentity: identity, extensionSourceDigest: "c".repeat(64) }), { mode: 0o600 })
  await session.setOwner("agent")
  operations.splice(0, operations.findIndex(entry => entry.operation === "acquire"))
  await writeFile(readyFile, JSON.stringify({ version: 1, endpoint: base + "b".repeat(64),
    processIdentity: identity, extensionSourceDigest: "c".repeat(64) }), { mode: 0o600 })
  assert.equal((await session.release()).released, true)
  assert.deepEqual(operations, [
    { operation: "acquire", replacement: false }, { operation: "attest", replacement: true },
    { operation: "resume", replacement: true }, { operation: "release", replacement: true },
  ], "targetless shutdown after source update must not send release to the departed transport")
})

// 2026-10-12: the provider had died at startup, so its readiness file did not exist, and every browser call answered a bare
// `degraded:ENOENT` with no path and no cause.
const liveIdentity = { pid: 123, startIdentity: "same", owner: "operator", executable: "/browser", profileRoot: "/profile" }

// A provider fixture: answers attest (with leaseBound for a named lease), acquire, resume and ensureWindow, and records each call.
async function providerFixture(t, { leases = new Set(), refuseResume = false, resumeCode = "NATIVE_LEASE_OWNER_MISMATCH" } = {}) {
  const calls = []
  let next = 0
  const server = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk
    const { operation, payload } = JSON.parse(text)
    calls.push({ operation, payload })
    let result
    if (operation === "attest") result = { healthy: true, processIdentity: liveIdentity,
      ...(payload.leaseId ? { leaseBound: leases.has(payload.leaseId) } : {}) }
    else if (operation === "acquire") {
      const leaseId = "lease-" + ++next
      leases.add(leaseId)
      result = { leaseId, owner: payload.owner, endpoint: "http://127.0.0.1/proxy-" + leaseId }
    } else if (operation === "resume") {
      if (refuseResume || !leases.has(payload.leaseId)) {
        response.writeHead(400)
        response.end(JSON.stringify({ ok: false, error: { code: resumeCode } }))
        return
      }
      result = { leaseId: payload.leaseId, owner: payload.owner, endpoint: "http://127.0.0.1/resumed-" + payload.leaseId }
    } else result = { targetId: "t" }
    response.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { calls, leases, endpoint: suffix => `http://127.0.0.1:${server.address().port}/provider/${suffix.repeat(64)}` }
}

async function readyFixture(name) {
  const root = await mkTempRoot(name)
  const readyFile = path.join(root, "native-provider.json")
  const write = endpoint => writeFile(readyFile, JSON.stringify({ version: 1, endpoint, processIdentity: liveIdentity,
    extensionSourceDigest: "c".repeat(64) }), { mode: 0o600 })
  return { readyFile, write }
}

function sessionFor(readyFile, endpoint, extra = {}) {
  return native.createNativeSession({ endpoint, readyFile, processIdentity: liveIdentity, extensionSourceDigest: "c".repeat(64),
    readyWaitMs: 300, readyPollMs: 10, readOwnStart: async () => "own-start", ...extra })
}

test("a missing readiness file is waited for, then named as the provider not running, with the file's path", async t => {
  const { readyFile } = await readyFixture("native-session-not-running-")
  const provider = await providerFixture(t)
  const session = sessionFor(readyFile, provider.endpoint("a"))
  const started = Date.now()
  await assert.rejects(session.setOwner("agent"), error => {
    assert.equal(error.code, "browser_native_provider_not_running")
    assert.equal(error.readyFile, readyFile)
    assert.equal(error.message, "The native browser provider is not running: its readiness file " + readyFile + " is missing.")
    return true
  })
  assert.ok(Date.now() - started >= 500, "it waited for the provider, and tried once more")
  assert.deepEqual(provider.calls, [], "no lease was requested from a provider that is not running")
})

test("a provider that comes up while the session waits is used, and the session names its own process", async t => {
  const { readyFile, write } = await readyFixture("native-session-late-provider-")
  const provider = await providerFixture(t)
  const session = sessionFor(readyFile, provider.endpoint("a"), { readyWaitMs: 5000 })
  const acquiring = session.setOwner("agent")
  setTimeout(() => write(provider.endpoint("b")), 100)
  const acquired = await acquiring
  assert.equal(acquired.leaseId, "lease-1")
  assert.deepEqual(provider.calls.map(call => call.operation), ["attest", "acquire"])
  assert.deepEqual(provider.calls[1].payload, { owner: "agent", ownerPid: process.pid, ownerStart: "own-start" })
  assert.equal(session.environment().DESK_NATIVE_PROVIDER_URL, provider.endpoint("b"), "the lease is taken through the provider running now")
})

test("a session whose own start cannot be read still sends its process id", async t => {
  const { readyFile, write } = await readyFixture("native-session-no-start-")
  const provider = await providerFixture(t)
  await write(provider.endpoint("a"))
  await sessionFor(readyFile, provider.endpoint("a"), { readOwnStart: async () => { throw new Error("unreadable") } }).setOwner("agent")
  assert.deepEqual(provider.calls[1].payload, { owner: "agent", ownerPid: process.pid })
})

test("a readiness file that cannot be read for another reason is not mistaken for a stopped provider", async t => {
  const { readyFile } = await readyFixture("native-session-unreadable-")
  const provider = await providerFixture(t)
  await writeFile(readyFile, "a file where a folder is expected", { mode: 0o600 })
  const session = sessionFor(path.join(readyFile, "ready.json"), provider.endpoint("a"))
  await assert.rejects(session.setOwner("agent"), error => error.code === "ENOTDIR")
  assert.deepEqual(provider.calls, [])
})

test("a provider that stopped after writing its readiness file is tried once more, then named as not running", async t => {
  const { readyFile, write } = await readyFixture("native-session-refused-")
  await write("http://127.0.0.1:9/provider/" + "a".repeat(64))
  const session = sessionFor(readyFile, "http://127.0.0.1:9/provider/" + "a".repeat(64))
  await assert.rejects(session.setOwner("agent"), error => error.code === "browser_native_provider_not_running" &&
    error.message === "The native browser provider is not running: its readiness file " + readyFile +
      " is present, but the provider does not answer (ECONNREFUSED).")
})

test("a connection failure reported only by its message is still named as the provider not running", async t => {
  const { readyFile, write } = await readyFixture("native-session-message-only-")
  const provider = await providerFixture(t)
  await write(provider.endpoint("a"))
  const session = sessionFor(readyFile, provider.endpoint("a"), { request: async () => { throw new Error("ECONNRESET") } })
  await assert.rejects(session.setOwner("agent"), error => error.code === "browser_native_provider_not_running" &&
    error.message.endsWith(" is present, but the provider does not answer (ECONNRESET)."))
})

test("a failure with no error object is passed on, not retried", async t => {
  const { readyFile, write } = await readyFixture("native-session-no-error-")
  const provider = await providerFixture(t)
  await write(provider.endpoint("a"))
  let requests = 0
  const session = sessionFor(readyFile, provider.endpoint("a"), { request: () => { requests++; return Promise.reject(undefined) } })
  await session.setOwner("agent").then(() => assert.fail("acquired"), error => assert.equal(error, undefined))
  assert.equal(requests, 1)
})

test("a session whose lease the provider no longer holds takes a new one instead of failing", async t => {
  const { readyFile, write } = await readyFixture("native-session-reacquire-")
  const provider = await providerFixture(t)
  await write(provider.endpoint("a"))
  const session = sessionFor(readyFile, provider.endpoint("a"))
  const first = await session.setOwner("agent")
  assert.deepEqual(await session.resume(), { changed: false, endpoint: first.endpoint })
  provider.leases.delete(first.leaseId)
  const resumed = await session.resume()
  assert.deepEqual(resumed, { changed: true, endpoint: "http://127.0.0.1/proxy-lease-2" })
  assert.equal(session.environment().DESK_NATIVE_LEASE_ID, "lease-2")
  assert.equal(session.environment().DESK_BROWSER_OWNER, "agent", "the same owner")
})

test("a replacement provider that refuses the old lease gives the session a new lease", async t => {
  const { readyFile, write } = await readyFixture("native-session-replacement-")
  const provider = await providerFixture(t, { refuseResume: true })
  await write(provider.endpoint("a"))
  const session = sessionFor(readyFile, provider.endpoint("a"))
  const first = await session.setOwner("agent")
  await write(provider.endpoint("b"))
  const resumed = await session.resume()
  assert.equal(resumed.changed, true)
  assert.notEqual(session.environment().DESK_NATIVE_LEASE_ID, first.leaseId)
  assert.equal(session.environment().DESK_NATIVE_PROVIDER_URL, provider.endpoint("b"))
  assert.ok(provider.calls.some(call => call.operation === "resume"))
})

test("a replacement provider that refuses the old lease for another reason is reported, not papered over", async t => {
  const { readyFile, write } = await readyFixture("native-session-replacement-refusal-")
  const provider = await providerFixture(t, { refuseResume: true, resumeCode: "NATIVE_EFFECT_PENDING" })
  await write(provider.endpoint("a"))
  const session = sessionFor(readyFile, provider.endpoint("a"))
  const first = await session.setOwner("agent")
  await write(provider.endpoint("b"))
  await assert.rejects(session.resume(), error => error.code === "NATIVE_EFFECT_PENDING")
  assert.equal(session.environment().DESK_NATIVE_LEASE_ID, first.leaseId, "its recorded effects are kept for reconciliation")
})
