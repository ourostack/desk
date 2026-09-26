import { test } from "node:test"
import assert from "node:assert/strict"
import { fork, spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { startControllerProcess, reclaimControllerChild, verifyOwnedChild, supervisorEndpoint, releaseSupervisor } from "../../src/readiness/controller-process.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../src/readiness/identity.js"
import { readinessContracts } from "../../src/readiness/contracts.js"
import { probeController } from "../../src/readiness/hung-controller.js"
import { request } from "../../src/readiness/controller-client.js"
import { readProcessStart } from "../../src/readiness/process-start.js"
import { mkTempRoot } from "../_temp_roots.js"
import { connectOrStartController } from "../../src/server.js"
import { controllerSocketIdentity } from "../../src/readiness/controller-server.js"

const policy = { lexical: "required", semantic: "unsupported" }
const posixOnly = process.platform === "win32" ? "POSIX sockets and stop signals" : false

async function fixture(t, deps) {
  const root = await mkTempRoot("desk-child-supervisor-")
  const stateHome = path.join(root, "readiness")
  const identity = controllerIdentity({ root, ...readinessContracts(policy) })
  const endpoint = deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const options = { identity, endpoint, stateDir, policy, embed: null, ephemeral: true }
  const controller = await startControllerProcess(options, deps)
  t.after(() => controller.close())
  const ownerFile = path.join(stateDir, "owner.json")
  const record = JSON.parse(readFileSync(ownerFile, "utf8"))
  return { root, stateHome, identity, endpoint, stateDir, controller, options, ownerFile, record }
}

function reclaimRequest(context, params = {}) {
  return request({
    endpoint: context.record.supervisor.endpoint, identity: context.identity, method: "reclaim",
    params: {
      token: context.record.owner.token, supervisor_token: context.record.supervisor.token,
      owner_pid: context.record.owner.pid, ...params,
    },
  })
}

test("a supervisor rejects wrong ownership and healthy-child reclaim instead of signalling anything", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  for (const params of [{ token: "wrong" }, { supervisor_token: "wrong" }, { owner_pid: process.pid }]) {
    assert.deepEqual(await reclaimRequest(context, params), { reclaimed: false, reason: "supervisor_owner_mismatch" })
  }
  assert.deepEqual(await reclaimRequest(context), { reclaimed: false, reason: "controller_answering" })
  assert.equal((await probeController({ root: context.root, stateHome: context.stateHome, policy })).state, "answering")
})

test("a forged record naming the MCP parent cannot cause its supervisor to signal that parent", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  const forged = { ...context.record, owner: { ...context.record.owner, pid: process.pid, process_start: await readProcessStart(process.pid) } }
  writeFileSync(context.ownerFile, JSON.stringify(forged))
  try {
    const result = await reclaimControllerChild({ ownerVerified: true, identity: context.identity, record: forged, endpoint: context.endpoint })
    assert.deepEqual(result, { reclaimed: false, reason: "supervisor_owner_mismatch" })
    assert.equal(process.kill(process.pid, 0), true)
    assert.equal(process.kill(context.record.owner.pid, 0), true)
  } finally {
    writeFileSync(context.ownerFile, JSON.stringify(context.record))
  }
})

test("a changed supervisor endpoint cannot receive controller credentials or claim a successful reclaim", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  let contacted = false
  const endpoint = path.join(context.root, "impostor.sock")
  const impostor = net.createServer((socket) => {
    contacted = true
    socket.once("data", () => socket.end('{"result":{"reclaimed":true}}\n'))
  })
  await new Promise((resolve) => impostor.listen(endpoint, resolve))
  t.after(() => new Promise((resolve) => impostor.close(resolve)))
  const record = { ...context.record, supervisor: { ...context.record.supervisor, endpoint } }
  const result = await reclaimControllerChild({ ownerVerified: true, identity: context.identity, record, endpoint: context.endpoint })
  assert.deepEqual(result, { reclaimed: false, reason: "supervisor_endpoint_changed" })
  assert.equal(contacted, false)
  assert.equal(process.kill(context.record.owner.pid, 0), true)
})

test("closing a dead client cannot evict the replacement's local ownership or strand another client", { skip: posixOnly }, async (t) => {
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const root = await mkTempRoot("desk-child-replacement-clients-")
  const options = { deskRoot: root, policy, stateHome: path.join(root, "state"), ephemeral: true }
  const clients = []
  t.after(async () => { for (const client of clients) await client.close() })
  const old = await connectOrStartController(options)
  clients.push(old)
  const ended = new Promise((resolve) => old.onExit(resolve))
  process.kill((await old.status()).owner.pid, "SIGKILL")
  await ended
  const replacement = await connectOrStartController(options)
  clients.push(replacement)
  await old.close()
  const joining = await connectOrStartController(options)
  clients.push(joining)
  const owner = (await replacement.status()).owner
  await replacement.close()
  assert.equal((await joining.status()).owner.token, owner.token, "the joining client keeps the replacement alive")
})

test("supervisor addresses are child-specific and Windows uses a named pipe", () => {
  const one = supervisorEndpoint("/tmp/desk/a.sock", "darwin")
  const two = supervisorEndpoint("/tmp/desk/a.sock", "linux")
  assert.equal(path.dirname(one), "/tmp/desk")
  assert.equal(path.dirname(two), "/tmp/desk")
  assert.notEqual(one, two)
  assert.match(supervisorEndpoint("unused", "win32"), /^\\\\\.\\pipe\\desk-supervisor-[a-f0-9-]{36}$/u)
  assert.equal(controllerSocketIdentity("unused", "win32"), null)
})

test("reclaim verification rejects ended children, stored role claims and changed live identities", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  const child = { pid: context.record.owner.pid, exitCode: null, signalCode: null }
  const verify = (overrides = {}) => verifyOwnedChild({ ...context, child, ...overrides })
  assert.deepEqual(await verify(), { ok: true })
  for (const record of [
    null, {}, { owner: {} },
    { ...context.record, owner: { ...context.record.owner, kind: "session" } },
    { ...context.record, owner: { ...context.record.owner, pid: process.pid } },
    { ...context.record, owner: { ...context.record.owner, parent_pid: process.pid + 1 } },
  ]) assert.deepEqual(await verify({ record }), { ok: false, reason: "not_owned_child" })
  for (const ended of [{ exitCode: 0 }, { signalCode: "SIGKILL" }]) {
    assert.deepEqual(await verify({ child: { ...child, ...ended } }), { ok: false, reason: "not_owned_child" })
  }
  for (const current of [{ verified: false, state: "live" }, { verified: true, state: "dead" }]) {
    assert.deepEqual(await verify({ inspect: async () => current }), { ok: false, reason: "owner_unverified" })
  }
  for (const record of [
    { ...context.record, owner: { ...context.record.owner, pid: process.pid } },
    { ...context.record, owner: { ...context.record.owner, token: "replaced" } },
    { ...context.record, owner: { ...context.record.owner, process_start: "different-process" } },
    { ...context.record, endpoint: "/tmp/replacement.sock" },
  ]) {
    assert.deepEqual(await verify({ inspect: async () => ({ verified: true, state: "live", record }) }), { ok: false, reason: "owner_changed" })
  }
  assert.deepEqual(await verify({ record: { ...context.record, socket: { ...context.record.socket, ino: -1 } } }), { ok: false, reason: "endpoint_changed" })
})

test("unverified, legacy and incomplete controller records are never sent to a supervisor", async () => {
  for (const probe of [
    {}, { ownerVerified: true }, { ownerVerified: true, record: {} },
    { ownerVerified: false, record: { owner: { kind: "controller_child" } } },
    { ownerVerified: true, record: { owner: { kind: "session" } } },
    { ownerVerified: true, record: { owner: { kind: "controller_child" }, supervisor: {} } },
  ]) assert.deepEqual(await reclaimControllerChild(probe), { reclaimed: false, reason: "not_verified_child" })
})

for (const [name, script, expected] of [
  ["exits before admission", 'process.exit(2)', /exited before admission/u],
  ["never responds", 'process.on("message", () => {})', /startup timed out/u],
  ["reports a startup error", 'process.on("message", () => process.send({ type: "error", message: "fixture startup failed", code: "FIXTURE" }))', /fixture startup failed/u],
  ["publishes no owner", 'process.on("message", () => process.send({ type: "ready", owner: { token: "fake" } }))', /unexpected owner/u],
  ["sends a malformed reply", 'process.on("message", () => process.send(null))', /invalid startup message/u],
]) {
  test(`a child that ${name} fails admission and releases its supervisor`, { skip: posixOnly }, async (t) => {
    const context = await fixture(t)
    await context.controller.close()
    const entry = path.join(context.root, "startup-fixture.cjs")
    writeFileSync(entry, script)
    let child
    let supervisor
    await assert.rejects(startControllerProcess(context.options, {
      timeoutMs: name === "never responds" ? 200 : 5000,
      spawn: (_entry, args, options) => {
        child = fork(entry, args, options)
        const send = child.send.bind(child)
        child.send = (message) => { supervisor = message.options.supervisor; return send(message) }
        return child
      },
    }), expected)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(existsSync(supervisor.endpoint), false)
  })
}

for (const mismatch of ["pid", "token", "missing-owner"]) {
  test(`a startup publication with a mismatched ${mismatch} is rejected without retaining ownership`, { skip: posixOnly }, async (t) => {
    const context = await fixture(t)
    await context.controller.close()
    const entry = path.join(context.root, "wrong-owner.cjs")
    writeFileSync(entry, `
      const fs = require("node:fs"), path = require("node:path");
      process.on("disconnect", () => process.exit(0));
      process.on("message", ({ options }) => {
        fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(options.stateDir, "owner.json"), JSON.stringify({
          identity: options.identity, endpoint: options.endpoint, socket: null,
          owner: { pid: process.pid + ${mismatch === "pid" ? 1 : 0}, token: "stored", started_at: new Date().toISOString() },
        }));
        process.send(${JSON.stringify({ type: "ready", ...(mismatch === "missing-owner" ? {} : { owner: { token: mismatch === "token" ? "claimed" : "stored" } }) })});
      });
    `)
    await assert.rejects(startControllerProcess(context.options, {
      spawn: (_entry, args, options) => fork(entry, args, options),
    }), /unexpected owner/u)
  })
}

test("a synchronous spawn failure closes the supervisor instead of retaining a broken election", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  await context.controller.close()
  await assert.rejects(startControllerProcess(context.options, {
    spawn: () => { throw new Error("spawn denied") },
  }), /spawn denied/u)
})

test("the owning supervisor reclaims its stopped child after live verification, not its parent", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  process.kill(context.record.owner.pid, "SIGSTOP")
  const probe = await probeController({ root: context.root, policy, stateHome: context.stateHome, timeoutMs: 20 })
  assert.equal(probe.ownerVerified, true)
  assert.deepEqual(await reclaimControllerChild(probe), { reclaimed: true, owner_pid: context.record.owner.pid })
  assert.equal(process.kill(process.pid, 0), true)
  assert.equal(existsSync(context.ownerFile), false)
  assert.equal(existsSync(context.endpoint), false)
  const unwatch = await new Promise((resolve) => {
    const remove = context.controller.onExit(() => resolve(remove))
  })
  unwatch()
  await context.controller.close()
})

test("a supervisor refuses a changed identity even when the child is really stopped", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  process.kill(context.record.owner.pid, "SIGSTOP")
  writeFileSync(context.ownerFile, JSON.stringify({ ...context.record, owner: { ...context.record.owner, process_start: "reused-pid" } }))
  try {
    assert.deepEqual(await reclaimRequest(context), { reclaimed: false, reason: "owner_unverified" })
    assert.equal(process.kill(context.record.owner.pid, 0), true)
  } finally {
    writeFileSync(context.ownerFile, JSON.stringify(context.record))
    process.kill(context.record.owner.pid, "SIGCONT")
  }
})

test("a child that refuses the stop operation is not reported as reclaimed", { skip: posixOnly }, async (t) => {
  let child
  const context = await fixture(t, { spawn: (...args) => { child = fork(...args); return child } })
  const kill = child.kill
  process.kill(child.pid, "SIGSTOP")
  child.kill = () => false
  try {
    assert.deepEqual(await reclaimRequest(context), { reclaimed: false, reason: "child_stop_failed" })
  } finally {
    child.kill = kill
    process.kill(child.pid, "SIGCONT")
  }
})

test("explicit close force-stops a hung owned child and removes its rendezvous", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  const unwatch = context.controller.onExit(() => assert.fail("a removed exit listener must not run"))
  unwatch()
  process.kill(context.record.owner.pid, "SIGSTOP")
  await context.controller.close()
  assert.equal(existsSync(context.ownerFile), false)
  assert.equal(existsSync(context.endpoint), false)
})

test("explicit close tolerates a child whose IPC just disconnected", { skip: posixOnly }, async (t) => {
  let child
  const context = await fixture(t, { spawn: (...args) => { child = fork(...args); return child } })
  child.disconnect()
  await context.controller.close()
  assert.equal(existsSync(context.ownerFile), false)
})

test("a competing child that loses the bind closes its watcher without altering the elected child", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  await assert.rejects(startControllerProcess(context.options), { code: "EADDRINUSE" })
  assert.equal((await probeController({ root: context.root, policy, stateHome: context.stateHome })).record.owner.token, context.record.owner.token)
})

test("supervisor framing rejects oversized, malformed and idle clients while preserving the controller", { skip: posixOnly }, async (t) => {
  let server
  const sockets = []
  const context = await fixture(t, {
    socketTimeoutMs: 50,
    createServer(handler) {
      server = net.createServer((socket) => { sockets.push(socket); handler(socket) })
      return server
    },
  })
  const logs = []
  t.mock.method(process.stderr, "write", (text) => { logs.push(String(text)); return true })
  server.emit("error", new Error("supervisor fixture"))
  assert.match(logs.join(""), /controller supervisor error: supervisor fixture/u)
  for (const input of [null, "x".repeat(17000), "{invalid}\n", "socket-error"]) {
    const socket = net.createConnection(context.record.supervisor.endpoint)
    let reply = ""
    socket.on("data", (chunk) => { reply += chunk })
    const closed = new Promise((resolve) => socket.once("close", resolve))
    await new Promise((resolve) => socket.once("connect", resolve))
    if (input === "socket-error") sockets.at(-1).emit("error", new Error("peer reset"))
    else if (input !== null) socket.write(input)
    await closed
    if (input === "{invalid}\n") assert.equal(typeof JSON.parse(reply).error.message, "string")
  }
  const socket = net.createConnection(context.record.supervisor.endpoint)
  let response = ""
  socket.on("data", (chunk) => { response += chunk })
  const finished = new Promise((resolve) => socket.once("end", resolve))
  await new Promise((resolve) => socket.once("connect", resolve))
  socket.write('{"method":"not')
  await new Promise((resolve) => setTimeout(resolve, 5))
  socket.write('-reclaim","params":{}}\n')
  await finished
  assert.equal(JSON.parse(response).result.reason, "supervisor_owner_mismatch")
})

test("socket and named-pipe reclaim guards fail closed without sending credentials", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  const child = { pid: context.record.owner.pid, exitCode: null, signalCode: null }
  const current = lstatSync(context.endpoint)
  for (const stat of [
    { isSocket: () => false, uid: current.uid, dev: current.dev, ino: current.ino },
    { isSocket: () => true, uid: current.uid + 1, dev: current.dev, ino: current.ino },
    { isSocket: () => true, uid: current.uid, dev: current.dev + 1, ino: current.ino },
  ]) assert.deepEqual(await verifyOwnedChild({ ...context, child, stat: () => stat }), { ok: false, reason: "endpoint_changed" })
  assert.deepEqual(await verifyOwnedChild({ ...context, child, platform: "win32" }), { ok: true })
  const probe = { identity: context.identity, record: context.record, endpoint: context.endpoint, ownerVerified: true }
  for (const stat of [
    { isSocket: () => false, uid: current.uid },
    { isSocket: () => true, uid: current.uid + 1 },
  ]) assert.deepEqual(await reclaimControllerChild(probe, { stat: () => stat }), { reclaimed: false, reason: "supervisor_not_owned" })
  assert.deepEqual(await reclaimControllerChild(probe, { stat: () => ({ isSocket: () => true, uid: current.uid, dev: -1, ino: -1 }) }), { reclaimed: false, reason: "supervisor_endpoint_changed" })
  const noInode = { ...probe, record: { ...context.record, supervisor: { endpoint: context.record.supervisor.endpoint, token: "t" } } }
  assert.deepEqual(await reclaimControllerChild(noInode), { reclaimed: false, reason: "supervisor_endpoint_changed" })
  assert.deepEqual(await reclaimControllerChild(probe, { platform: "win32" }), { reclaimed: false, reason: "supervisor_endpoint_changed" })
  const pipe = supervisorEndpoint("", "win32")
  const pipeProbe = { ...probe, record: { ...context.record, supervisor: { endpoint: pipe, token: "pipe-token" } } }
  const result = await reclaimControllerChild(pipeProbe, {
    platform: "win32",
    call: async (request) => {
      assert.equal(request.endpoint, pipe)
      assert.equal(request.params.owner_pid, child.pid)
      assert.equal(request.params.supervisor_token, "pipe-token")
      return { reclaimed: false, reason: "controller_answering" }
    },
  })
  assert.equal(result.reclaimed, false)
})

test("supervisor cleanup preserves replacement files and reports non-ENOENT failures", async () => {
  const root = await mkTempRoot("desk-supervisor-cleanup-")
  const endpoint = path.join(root, "owned.sock")
  writeFileSync(endpoint, "fixture")
  const stat = lstatSync(endpoint)
  const supervisor = { endpoint, socket: { dev: stat.dev, ino: stat.ino } }
  releaseSupervisor({})
  releaseSupervisor({ ...supervisor, socket: { dev: stat.dev + 1, ino: stat.ino } })
  releaseSupervisor({ ...supervisor, socket: { dev: stat.dev, ino: stat.ino + 1 } })
  assert.equal(existsSync(endpoint), true)
  const logs = []
  releaseSupervisor(supervisor, {
    unlink: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
    stderr: { write: (message) => logs.push(message) },
  })
  assert.match(logs.join(""), /supervisor cleanup failed: denied/u)
  releaseSupervisor(supervisor)
  assert.equal(existsSync(endpoint), false)
  releaseSupervisor(supervisor)
})

test("a corrupted owner record during child startup rejects admission instead of escaping the startup promise", { skip: posixOnly }, async (t) => {
  const context = await fixture(t)
  await context.controller.close()
  const childFile = path.join(context.root, "corrupt-start.cjs")
  writeFileSync(childFile, `
    const fs = require("node:fs");
    const path = require("node:path");
    process.on("disconnect", () => process.exit(0));
    process.on("message", ({ options }) => {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(options.stateDir, "owner.json"), "{}");
      process.send({ type: "ready", owner: { token: "fixture" } });
    });
  `)
  const manager = new URL("../../src/readiness/controller-process.js", import.meta.url).href
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `
    import { fork } from "node:child_process";
    import { startControllerProcess } from ${JSON.stringify(manager)};
    try {
      await startControllerProcess(${JSON.stringify(context.options)}, {
        spawn: (_entry, args, options) => fork(${JSON.stringify(childFile)}, args, options),
        timeoutMs: 2000,
      });
      process.exitCode = 2;
    } catch (error) {
      console.log(JSON.stringify({ handled: true, message: error.message }));
    }
  `], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  parent.stdout.on("data", (chunk) => { stdout += chunk })
  parent.stderr.on("data", (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => parent.once("close", resolve))
  assert.equal(code, 0, stderr)
  const result = JSON.parse(stdout)
  assert.equal(result.handled, true)
  assert.match(result.message, /unexpected owner/u)
})
