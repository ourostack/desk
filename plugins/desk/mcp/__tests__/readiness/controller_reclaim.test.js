// Readiness-controller repairs: a loose state-directory mode is tightened, and a socket nobody listens on is reclaimed even when its owner record is corrupt.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { connectOrStartController, endpointIsAbandoned, probeEndpoint, unlinkIfUnchanged } from "../../src/readiness/controller-client.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../src/readiness/identity.js"
import { mkTempRoot } from "../_temp_roots.js"

const posixOnly = process.platform === "win32" ? "POSIX sockets and modes" : false

async function deadSocket(endpoint) {
  mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(endpoint)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "inherit"] })
  await new Promise((resolve) => child.stdout.once("data", resolve))
  child.kill("SIGKILL")
  await new Promise((resolve) => child.once("exit", resolve))
}

test("a state directory with mode 755 is tightened to 700 and reported; the default onRepair is silent", { skip: posixOnly }, async (t) => {
  for (const withHook of [true, false]) {
    const root = await mkTempRoot("desk-reclaim-mode-")
    const stateHome = path.join(root, "state")
    const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
    const stateDir = path.join(stateHome, identity.id)
    mkdirSync(stateDir, { recursive: true })
    chmodSync(stateDir, 0o755)
    const repairs = []
    const client = await connectOrStartController({ root, stateHome, ephemeral: true, ...(withHook ? { onRepair: (repair) => repairs.push(repair) } : {}) })
    t.after(() => client.close())
    assert.equal(lstatSync(stateDir).mode & 0o777, 0o700)
    if (withHook) assert.deepEqual(repairs, [{ action: "chmod_700", path: stateDir, from: "755" }])
  }
})

test("a socket nobody listens on is reclaimed even with a corrupt owner record", { skip: posixOnly }, async (t) => {
  const root = await mkTempRoot("desk-reclaim-abandoned-")
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  t.after(() => rmSync(endpoint, { force: true }))
  await deadSocket(endpoint)
  mkdirSync(path.join(stateHome, identity.id), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(stateHome, identity.id, "owner.json"), "{corrupt")
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  assert.equal((await client.status()).owner.pid, process.pid)
})

test("endpointIsAbandoned only reclaims a refused socket of ours", { skip: posixOnly }, async (t) => {
  const root = await mkTempRoot("desk-reclaim-probe-")
  const privateDir = path.join(root, "private")
  mkdirSync(privateDir, { mode: 0o700 })
  // Missing endpoint, or a folder that is not private.
  assert.equal(await endpointIsAbandoned(path.join(privateDir, "missing.sock")), null)
  const loose = path.join(root, "loose")
  mkdirSync(loose, { mode: 0o755 })
  chmodSync(loose, 0o755)
  assert.equal(await endpointIsAbandoned(path.join(loose, "x.sock")), null)
  // A regular file is not a socket.
  writeFileSync(path.join(privateDir, "file.sock"), "")
  assert.equal(await endpointIsAbandoned(path.join(privateDir, "file.sock")), null)
  // A live listener is accepting, never abandoned.
  const live = path.join(privateDir, "live.sock")
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => server.listen(live, resolve))
  t.after(() => server.close())
  assert.equal(await endpointIsAbandoned(live), null)
  assert.equal(await probeEndpoint(live), "accepting")
  // A dead socket is refused and reclaimable; an injected probe decides the rest.
  const dead = path.join(privateDir, "dead.sock")
  await deadSocket(dead)
  assert.equal((await endpointIsAbandoned(dead)).isSocket(), true)
  assert.equal(await endpointIsAbandoned(dead, async () => "unknown"), null)
  assert.equal(await probeEndpoint(path.join(privateDir, "missing.sock")), "unknown")
  // A probe that never hears back gives up as unknown.
  const { EventEmitter } = await import("node:events")
  let destroyed = false
  const silentSocket = Object.assign(new EventEmitter(), { destroy() { destroyed = true } })
  assert.equal(await probeEndpoint("/nowhere.sock", { timeoutMs: 5, connect: () => silentSocket }), "unknown")
  assert.equal(destroyed, true)
})

test("a socket owned by another user is never reclaimed", { skip: posixOnly }, async () => {
  const root = await mkTempRoot("desk-reclaim-uid-")
  const privateDir = path.join(root, "private")
  mkdirSync(privateDir, { mode: 0o700 })
  const dead = path.join(privateDir, "dead.sock")
  await deadSocket(dead)
  const originalGetuid = process.getuid
  let calls = 0
  // The first call is the private-folder check (ours); the socket check then sees a different user.
  process.getuid = () => (calls++ === 0 ? originalGetuid() : originalGetuid() + 1)
  try {
    assert.equal(await endpointIsAbandoned(dead), null)
  } finally {
    process.getuid = originalGetuid
  }
})

test("a dead socket whose recorded owner PID belongs to someone else is still reclaimed once nobody answers it", { skip: posixOnly }, async (t) => {
  const root = await mkTempRoot("desk-reclaim-eperm-")
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  t.after(() => rmSync(endpoint, { force: true }))
  await deadSocket(endpoint)
  const { dev, ino } = lstatSync(endpoint)
  mkdirSync(path.join(stateHome, identity.id), { recursive: true, mode: 0o700 })
  // PID 1 exists but belongs to root, so signalling it fails with EPERM rather than ESRCH.
  writeFileSync(path.join(stateHome, identity.id, "owner.json"), JSON.stringify({ identity, endpoint, socket: { dev, ino }, owner: { pid: 1, token: "t" } }))
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  assert.equal((await client.status()).owner.pid, process.pid)
})

test("unlinkIfUnchanged removes only the exact file judged stale", async () => {
  const root = await mkTempRoot("desk-reclaim-unlink-")
  const file = path.join(root, "endpoint")
  writeFileSync(file, "")
  const stat = lstatSync(file)
  unlinkIfUnchanged(file, { dev: stat.dev, ino: stat.ino + 1 })
  unlinkIfUnchanged(file, { dev: stat.dev + 1, ino: stat.ino })
  assert.equal(lstatSync(file).ino, stat.ino, "a replaced file is kept")
  unlinkIfUnchanged(file, stat)
  assert.throws(() => lstatSync(file), /ENOENT/u)
  unlinkIfUnchanged(file, stat)
})

test("a socket must refuse twice, and stay the same file, before it counts as abandoned", { skip: posixOnly }, async () => {
  const root = await mkTempRoot("desk-reclaim-twice-")
  const privateDir = path.join(root, "private")
  mkdirSync(privateDir, { mode: 0o700 })
  const dead = path.join(privateDir, "dead.sock")
  await deadSocket(dead)
  const answers = ["refused", "accepting"]
  assert.equal(await endpointIsAbandoned(dead, async () => answers.shift()), null, "a controller that started listening in between is kept")
  let replaced = false
  const replacing = async (endpoint) => {
    if (!replaced) {
      replaced = true
      rmSync(endpoint)
      await deadSocket(endpoint)
    }
    return "refused"
  }
  assert.equal(await endpointIsAbandoned(dead, replacing), null, "a socket replaced in between is kept")
  let removed = false
  const removing = async (endpoint) => {
    if (removed) rmSync(endpoint, { force: true })
    removed = true
    return "refused"
  }
  assert.equal(await endpointIsAbandoned(dead, removing), null, "a socket that disappears in between is not reclaimed")
})

test("a session meets the controller at the endpoint its owner record names, when that one answers", { skip: posixOnly }, async (t) => {
  const { startReadinessController } = await import("../../src/readiness/controller-server.js")
  const root = await mkTempRoot("desk-rendezvous-")
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  // An older Desk put its socket elsewhere (it followed XDG_RUNTIME_DIR).
  const elsewhereDir = path.join("/tmp", `drv-${process.pid}-${Date.now() % 100000}`)
  mkdirSync(elsewhereDir, { mode: 0o700 })
  t.after(() => rmSync(elsewhereDir, { recursive: true, force: true }))
  const elsewhere = path.join(elsewhereDir, "c.sock")
  const older = await startReadinessController({ identity, endpoint: elsewhere, stateDir, ephemeral: true })
  t.after(() => older.close())
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  assert.equal((await client.status()).owner.token, older.owner.token, "the session joined the older controller instead of starting a second one")
  assert.equal((await client.status(500)).state, "CONTROL_READY", "status takes a timeout")
})

test("a recorded endpoint that does not answer is ignored", { skip: posixOnly }, async (t) => {
  const root = await mkTempRoot("desk-rendezvous-dead-")
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  mkdirSync(path.join(stateHome, identity.id), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(stateHome, identity.id, "owner.json"), JSON.stringify({ identity, endpoint: "/tmp/desk-no-such-dir/x.sock", owner: { pid: 1, token: "t" } }))
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  assert.equal((await client.status()).owner.pid, process.pid)
  const recordedSame = await mkTempRoot("desk-rendezvous-same-")
  const sameIdentity = controllerIdentity({ root: recordedSame, protocolVersion: 1, lexicalContract: {} })
  mkdirSync(path.join(recordedSame, "state", sameIdentity.id), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(recordedSame, "state", sameIdentity.id, "owner.json"), JSON.stringify({ identity: sameIdentity, endpoint: 7 }))
  const other = await connectOrStartController({ root: recordedSame, stateHome: path.join(recordedSame, "state"), ephemeral: true })
  t.after(() => other.close())
  assert.equal((await other.status()).owner.pid, process.pid)
})

test("a controller server error after it started is logged, never unhandled", { skip: posixOnly }, async (t) => {
  const { startReadinessController } = await import("../../src/readiness/controller-server.js")
  const root = await mkTempRoot("desk-server-error-")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  const controller = await startReadinessController({ identity, endpoint, stateDir: path.join(root, "state", identity.id), ephemeral: true })
  t.after(() => controller.close())
  const writes = []
  t.mock.method(process.stderr, "write", (text) => { writes.push(String(text)); return true })
  controller.server.emit("error", new Error("late listen failure"))
  controller.server.emit("error", "not an error")
  assert.match(writes.join(""), /readiness controller server error: late listen failure/u)
  assert.match(writes.join(""), /readiness controller server error: not an error/u)
})
