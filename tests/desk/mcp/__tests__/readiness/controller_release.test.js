// A readiness controller releases its rendezvous (owner.json and the socket file) on every normal end of its process, and only while they are still its own. Its owner record names it by PID and start time.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { releaseRendezvous, startReadinessController } from "../../src/readiness/controller-server.js"
import { createExitRelease } from "../../src/readiness/exit-release.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../src/readiness/identity.js"
import { readProcessStart } from "../../src/readiness/process-start.js"
import { mkTempRoot } from "../_temp_roots.js"

const posixOnly = process.platform === "win32" ? "unix socket files" : false
const serverModule = fileURLToPath(new URL("../../src/readiness/controller-server.js", import.meta.url))

function fakeProcess() {
  const proc = new EventEmitter()
  proc.pid = process.pid
  proc.kills = []
  proc.kill = (pid, signal) => { proc.kills.push([pid, signal]) }
  return proc
}

async function fixture(t, prefix) {
  const root = await mkTempRoot(prefix)
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  const stateDir = path.join(root, "state", identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  t.after(() => rmSync(endpoint, { force: true }))
  return { root, identity, endpoint, stateDir, ownerFile: path.join(stateDir, "owner.json") }
}

test("the owner record names the controller's process by PID and start time", { skip: posixOnly }, async (t) => {
  const { identity, endpoint, stateDir, ownerFile } = await fixture(t, "desk-release-record-")
  const controller = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true, exitRelease: createExitRelease(fakeProcess()) })
  t.after(() => controller.close())
  const record = JSON.parse(readFileSync(ownerFile, "utf8"))
  assert.equal(record.owner.pid, process.pid)
  assert.equal(record.owner.process_start, await readProcessStart(process.pid))
  assert.equal(controller.owner.process_start, record.owner.process_start)
})

test("a process whose start time cannot be read records its PID alone", { skip: posixOnly }, async (t) => {
  const { identity, endpoint, stateDir, ownerFile } = await fixture(t, "desk-release-nostart-")
  const controller = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true, exitRelease: createExitRelease(fakeProcess()), ownProcessStart: async () => null })
  t.after(() => controller.close())
  assert.equal("process_start" in JSON.parse(readFileSync(ownerFile, "utf8")).owner, false)
})

for (const event of ["exit", "beforeExit", "SIGTERM", "SIGINT"]) {
  test(`${event} removes owner.json and the socket file while they are still this controller's`, { skip: posixOnly }, async (t) => {
    const { identity, endpoint, stateDir, ownerFile } = await fixture(t, "desk-release-event-")
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const controller = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true, exitRelease: registry })
    t.after(() => controller.close())
    assert.ok(existsSync(ownerFile))
    assert.ok(lstatSync(endpoint).isSocket())
    proc.emit(event, event)
    assert.equal(existsSync(ownerFile), false)
    assert.equal(existsSync(endpoint), false)
    assert.equal(existsSync(stateDir), false, "an empty state folder goes too")
    assert.equal(registry.size(), 0, "released once")
  })
}

test("close() stops listening for the process's end", { skip: posixOnly }, async (t) => {
  const { identity, endpoint, stateDir } = await fixture(t, "desk-release-close-")
  const registry = createExitRelease(fakeProcess())
  const controller = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true, exitRelease: registry })
  assert.equal(registry.size(), 1)
  await controller.close()
  assert.equal(registry.size(), 0)
})

test("a rendezvous that is no longer this controller's is left alone", { skip: posixOnly }, async (t) => {
  const { identity, endpoint, stateDir, ownerFile } = await fixture(t, "desk-release-replaced-")
  const proc = fakeProcess()
  const controller = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true, exitRelease: createExitRelease(proc) })
  t.after(() => controller.close())
  const record = JSON.parse(readFileSync(ownerFile, "utf8"))
  const socket = { dev: record.socket.dev, ino: record.socket.ino }
  const owner = controller.owner
  for (const replaced of [
    { ...record.owner, token: "another-controller" },
    { ...record.owner, pid: record.owner.pid + 1 },
    { ...record.owner, process_start: "darwin:2000-01-01T00:00:00.000Z" },
  ]) {
    writeFileSync(ownerFile, JSON.stringify({ ...record, owner: replaced }))
    assert.equal(releaseRendezvous({ stateDir, endpoint, owner, socket }), false, JSON.stringify(replaced))
    assert.ok(existsSync(ownerFile))
    assert.ok(existsSync(endpoint))
  }
  writeFileSync(ownerFile, "{corrupt")
  assert.equal(releaseRendezvous({ stateDir, endpoint, owner, socket }), false, "a corrupt record")
  rmSync(ownerFile)
  assert.equal(releaseRendezvous({ stateDir, endpoint, owner, socket }), false, "no record")
  assert.ok(existsSync(endpoint))
  // Ours again, but the socket file is another one now: only the record goes.
  writeFileSync(ownerFile, JSON.stringify(record))
  writeFileSync(path.join(stateDir, "journal-placeholder"), "")
  assert.equal(releaseRendezvous({ stateDir, endpoint, owner, socket: { ...socket, ino: socket.ino + 1 } }), true)
  assert.equal(existsSync(ownerFile), false)
  assert.ok(existsSync(endpoint), "a socket file the controller did not publish stays")
  assert.ok(existsSync(stateDir), "a folder with other state stays")
  // A named pipe (Windows) has no socket file; a socket file already gone is fine.
  writeFileSync(ownerFile, JSON.stringify(record))
  assert.equal(releaseRendezvous({ stateDir, endpoint, owner, socket: null }), true)
  writeFileSync(ownerFile, JSON.stringify(record))
  assert.equal(releaseRendezvous({ stateDir, endpoint: path.join(stateDir, "gone.sock"), owner, socket }), true)
})

// A real process that elects a controller the way Desk does (not ephemeral, so it never holds the process open) and then ends one way or another.
function spawnOwner({ endpoint, stateDir, identity }, { keepAlive }) {
  const script = `
    const { startReadinessController } = await import(${JSON.stringify(serverModule)})
    await startReadinessController({ identity: ${JSON.stringify(identity)}, endpoint: ${JSON.stringify(endpoint)}, stateDir: ${JSON.stringify(stateDir)} })
    process.stdout.write("up")
    ${keepAlive ? "setInterval(() => {}, 1000)" : ""}
  `
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] })
  const up = new Promise((resolve) => child.stdout.once("data", resolve))
  const ended = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
  return { child, up, ended }
}

test("a real process: the event loop running dry (beforeExit, then exit) releases the rendezvous", { skip: posixOnly, timeout: 30000 }, async (t) => {
  const context = await fixture(t, "desk-release-drain-")
  const owner = spawnOwner(context, { keepAlive: false })
  t.after(() => owner.child.kill("SIGKILL"))
  assert.deepEqual(await owner.ended, { code: 0, signal: null })
  assert.equal(existsSync(context.ownerFile), false)
  assert.equal(existsSync(context.endpoint), false)
})

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`a real process: ${signal} releases the rendezvous and still ends the process by that signal`, { skip: posixOnly, timeout: 30000 }, async (t) => {
    const context = await fixture(t, "desk-release-signal-")
    const owner = spawnOwner(context, { keepAlive: true })
    t.after(() => owner.child.kill("SIGKILL"))
    await owner.up
    assert.ok(existsSync(context.ownerFile))
    assert.ok(lstatSync(context.endpoint).isSocket())
    owner.child.kill(signal)
    assert.deepEqual(await owner.ended, { code: null, signal })
    assert.equal(existsSync(context.ownerFile), false)
    assert.equal(existsSync(context.endpoint), false)
  })
}
