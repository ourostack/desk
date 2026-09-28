// Readiness-controller repairs: a loose state-directory mode is tightened, and a socket nobody listens on is reclaimed when its owner record is missing or corrupt or its owner is gone. A socket whose owner runs is never taken over.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { connectOrStartController, endpointIsAbandoned, endpointIsReclaimable, probeEndpoint, socketTakeoverGuards, unlinkIfUnchanged } from "../../src/readiness/controller-client.js"
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
  assert.equal(await endpointIsAbandoned(path.join(privateDir, "missing.sock"), { stateDir: privateDir }), null)
  const loose = path.join(root, "loose")
  mkdirSync(loose, { mode: 0o755 })
  chmodSync(loose, 0o755)
  assert.equal(await endpointIsAbandoned(path.join(loose, "x.sock"), { stateDir: loose }), null)
  // A regular file is not a socket.
  writeFileSync(path.join(privateDir, "file.sock"), "")
  assert.equal(await endpointIsAbandoned(path.join(privateDir, "file.sock"), { stateDir: privateDir }), null)
  // A live listener is accepting, never abandoned.
  const live = path.join(privateDir, "live.sock")
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => server.listen(live, resolve))
  t.after(() => server.close())
  assert.equal(await endpointIsAbandoned(live, { stateDir: privateDir }), null)
  assert.equal(await probeEndpoint(live), "accepting")
  // A dead socket is refused and reclaimable; an injected probe decides the rest.
  const dead = path.join(privateDir, "dead.sock")
  await deadSocket(dead)
  assert.equal((await endpointIsAbandoned(dead, { stateDir: privateDir })).isSocket(), true)
  assert.equal(await endpointIsAbandoned(dead, { stateDir: privateDir, probe: async () => "unknown" }), null)
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
    assert.equal(await endpointIsAbandoned(dead, { stateDir: privateDir }), null)
  } finally {
    process.getuid = originalGetuid
  }
})

test("a socket whose recorded owner runs is never taken over, even when it refuses; one from an earlier boot is reclaimed", { skip: posixOnly }, async (t) => {
  const root = await mkTempRoot("desk-reclaim-live-owner-")
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  t.after(() => rmSync(endpoint, { force: true }))
  await deadSocket(endpoint)
  const { dev, ino } = lstatSync(endpoint)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  // PID 1 always runs (it belongs to root, so signalling it fails with EPERM): to Desk it is a running owner whose socket refuses, like a stopped one or one whose accept queue is full.
  const owner = (startedAt) => writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({ identity, endpoint, socket: { dev, ino }, owner: { pid: 1, token: "t", started_at: startedAt } }))
  owner(new Date().toISOString())
  assert.equal(await endpointIsAbandoned(endpoint, { stateDir, identity }), null, "a refused socket alone is not enough")
  await assert.rejects(connectOrStartController({ root, stateHome, ephemeral: true }), (error) => {
    assert.equal(error.code, "controller_owner_unresponsive")
    assert.equal(error.owner_pid, 1)
    assert.match(error.message, /readiness controller for this root belongs to a running process \(pid 1\)/u)
    return true
  })
  assert.equal(lstatSync(endpoint).ino, ino, "the socket was kept")
  // The same record from before this boot: PID 1 is some other process now, so the socket is reclaimed.
  owner("2000-01-01T00:00:00.000Z")
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  assert.equal((await client.status()).owner.pid, process.pid)
})

test("a socket whose recorded owner PID now names a later process (its start time differs) is reclaimed, and that process is left alone", { skip: posixOnly }, async (t) => {
  const { readProcessStart } = await import("../../src/readiness/process-start.js")
  const root = await mkTempRoot("desk-reclaim-reused-pid-")
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  t.after(() => rmSync(endpoint, { force: true }))
  await deadSocket(endpoint)
  const { dev, ino } = lstatSync(endpoint)
  // ps reports whole seconds: the unrelated process starts in a later second than the recorded owner (this test process).
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const unrelated = spawn("sleep", ["60"], { stdio: "ignore" })
  t.after(() => unrelated.kill("SIGKILL"))
  await new Promise((resolve) => unrelated.once("spawn", resolve))
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
    identity, endpoint, socket: { dev, ino },
    owner: { pid: unrelated.pid, token: "t", started_at: new Date().toISOString(), process_start: await readProcessStart(process.pid) },
  }))
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  assert.equal((await client.status()).owner.pid, process.pid, "a new controller was elected")
  assert.equal(unrelated.exitCode, null)
  assert.equal(unrelated.signalCode, null, "the process that reused the PID was never signalled")
})

test("a socket is reclaimable at once only when its recorded owner is gone or is this process, and it is still the file that owner published", { skip: posixOnly }, async () => {
  const root = await mkTempRoot("desk-rc-dead-")
  const privateDir = path.join(root, "private")
  mkdirSync(privateDir, { mode: 0o700 })
  const endpoint = path.join(privateDir, "c.sock")
  await deadSocket(endpoint)
  const { dev, ino } = lstatSync(endpoint)
  const record = { endpoint, socket: { dev, ino }, owner: { pid: 7 } }
  assert.equal(endpointIsReclaimable({ endpoint, owner: { state: "live", record } }), null)
  assert.equal(endpointIsReclaimable({ endpoint, owner: { state: "corrupt", record: null } }), null, "a corrupt record goes through the refused-twice check instead")
  assert.equal(endpointIsReclaimable({ endpoint, owner: { state: "dead", record } }).ino, ino)
  assert.equal(endpointIsReclaimable({ endpoint, owner: { state: "self", record } }).ino, ino)
  assert.equal(endpointIsReclaimable({ endpoint, owner: { state: "dead", record: { ...record, socket: { dev, ino: ino + 1 } } } }), null, "another file than the one the owner published")
  assert.equal(endpointIsReclaimable({ endpoint, owner: { state: "dead", record: { endpoint, owner: { pid: 7 } } } }), null, "a record that names no socket")
  assert.equal(endpointIsReclaimable({ endpoint: path.join(privateDir, "gone.sock"), owner: { state: "dead", record } }), null, "no socket at all")
  writeFileSync(path.join(privateDir, "file.sock"), "")
  assert.equal(endpointIsReclaimable({ endpoint: path.join(privateDir, "file.sock"), owner: { state: "dead", record: { ...record, endpoint: path.join(privateDir, "file.sock") } } }), null, "not a socket")
})

test("on Windows there is no socket file to guard: a named pipe in use cannot be bound, so election just tries", async () => {
  assert.equal(await socketTakeoverGuards.win32({ endpoint: "\\\\.\\pipe\\desk", identity: null, stateDir: "C:\\state" }), false)
  assert.equal(socketTakeoverGuards.darwin, socketTakeoverGuards.linux)
})

test("an owner that starts running between the two refused probes keeps its socket", { skip: posixOnly }, async () => {
  const root = await mkTempRoot("desk-rc-arrive-")
  const privateDir = path.join(root, "private")
  mkdirSync(privateDir, { mode: 0o700 })
  const endpoint = path.join(privateDir, "c.sock")
  await deadSocket(endpoint)
  let probes = 0
  const arriving = async () => {
    probes += 1
    // A controller elected by another session publishes its owner record (PID 1 always runs).
    if (probes === 2) writeFileSync(path.join(privateDir, "owner.json"), JSON.stringify({ endpoint, owner: { pid: 1, token: "t", started_at: new Date().toISOString() } }))
    return "refused"
  }
  assert.equal(await endpointIsAbandoned(endpoint, { stateDir: privateDir, probe: arriving }), null)
  assert.equal(probes, 2)
})

test("a running owner that is only busy gets one longer handshake and is joined, never replaced", { skip: posixOnly }, async (t) => {
  const { startReadinessController } = await import("../../src/readiness/controller-server.js")
  const root = await mkTempRoot("desk-reclaim-busy-owner-")
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const running = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true })
  t.after(() => running.close())
  const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  // Name a running process other than this one as the owner, and answer the first handshake too late.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  t.after(() => sleeper.kill("SIGKILL"))
  await new Promise((resolve) => sleeper.once("spawn", resolve))
  // With that process's own start time, so the record names it exactly, as its owner's own record would.
  const { readProcessStart } = await import("../../src/readiness/process-start.js")
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({ ...record, owner: { ...record.owner, pid: sleeper.pid, process_start: await readProcessStart(sleeper.pid) } }))
  const listeners = running.server.listeners("connection")
  let delayed = false
  running.server.removeAllListeners("connection")
  running.server.on("connection", (socket) => {
    if (delayed) return listeners.forEach((listener) => listener(socket))
    delayed = true
    setTimeout(() => listeners.forEach((listener) => listener(socket)), 300)
  })
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  assert.equal((await client.status()).owner.token, record.owner.token, "joined the running owner's controller")
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
  assert.equal(await endpointIsAbandoned(dead, { stateDir: privateDir, probe: async () => answers.shift() }), null, "a controller that started listening in between is kept")
  let replaced = false
  // The replacement is created beside the old socket and renamed over it, so it always has a different inode (a filesystem may reuse a removed file's inode at once).
  const replacing = async (endpoint) => {
    if (!replaced) {
      replaced = true
      const beside = `${endpoint}.new`
      await deadSocket(beside)
      renameSync(beside, endpoint)
    }
    return "refused"
  }
  assert.equal(await endpointIsAbandoned(dead, { stateDir: privateDir, probe: replacing }), null, "a socket replaced in between is kept")
  let removed = false
  const removing = async (endpoint) => {
    if (removed) rmSync(endpoint, { force: true })
    removed = true
    return "refused"
  }
  assert.equal(await endpointIsAbandoned(dead, { stateDir: privateDir, probe: removing }), null, "a socket that disappears in between is not reclaimed")
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
