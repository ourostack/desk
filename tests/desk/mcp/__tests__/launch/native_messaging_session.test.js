import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import http from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
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
  await session.setOwner("agent")
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
