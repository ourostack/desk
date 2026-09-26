// Detecting a readiness controller whose owner runs but that does not answer, and reporting it: Desk never stops it and never takes it over.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { readinessContracts } from "../../src/readiness/contracts.js"
import { HUNG_MISSES, HUNG_PROBE_MS, hungControllerReport, probeController, probeMissed } from "../../src/readiness/hung-controller.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../src/readiness/identity.js"
import { mkTempRoot } from "../_temp_roots.js"

const posixOnly = process.platform === "win32" ? "unix sockets and signals" : false
const policy = { lexical: "required", semantic: "unsupported" }

async function fixture(t, prefix) {
  const root = await mkTempRoot(prefix)
  const stateHome = path.join(root, "state")
  const identity = controllerIdentity({ root, ...readinessContracts(policy) })
  const endpoint = deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  t.after(() => rmSync(endpoint, { force: true }))
  return { root, stateHome, identity, endpoint, stateDir }
}

const STARTED_AT = new Date().toISOString()

function writeOwner({ stateDir, identity, endpoint }, pid, socket = lstatSync(endpoint)) {
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
    schema_version: 1, identity, endpoint, socket: { dev: socket.dev, ino: socket.ino }, owner: { pid, token: "t", started_at: STARTED_AT },
  }))
}

async function silentChild(endpoint) {
  const child = spawn(process.execPath, ["-e",
    `require("net").createServer(() => {}).listen(${JSON.stringify(endpoint)}, () => process.stdout.write("up"))`,
  ], { stdio: ["ignore", "pipe", "inherit"] })
  await new Promise((resolve) => child.stdout.once("data", resolve))
  return child
}

test("the defaults are 3 misses and a 5 s probe", () => {
  assert.equal(HUNG_MISSES, 3)
  assert.equal(HUNG_PROBE_MS, 5000)
  assert.deepEqual(readinessContracts({ lexical: "required" }).lexicalContract.policy, { lexical: "required" })
})

test("probes tell missing, refused, answering and silent controllers apart", { skip: posixOnly }, async (t) => {
  const context = await fixture(t, "desk-hung-probe-")
  const probe = () => probeController({ root: context.root, policy, stateHome: context.stateHome, timeoutMs: 200 })
  assert.equal((await probe()).state, "missing")
  const answering = net.createServer((socket) => socket.once("data", () => socket.end("{}\n")))
  await new Promise((resolve) => answering.listen(context.endpoint, resolve))
  const answered = await probe()
  assert.equal(answered.state, "answering")
  assert.equal(answered.endpoint, context.endpoint)
  assert.equal(answered.record, null)
  await new Promise((resolve) => answering.close(resolve))
  const silent = net.createServer(() => {})
  await new Promise((resolve) => silent.listen(context.endpoint, resolve))
  writeOwner(context, process.pid)
  const quiet = await probe()
  assert.equal(quiet.state, "silent")
  assert.equal(quiet.record.owner.pid, process.pid)
  silent.close()
  await new Promise((resolve) => setImmediate(resolve))
  const child = await silentChild(context.endpoint)
  child.kill("SIGKILL")
  await new Promise((resolve) => child.once("exit", resolve))
  assert.equal((await probe()).state, "refused")
  const unknownSocket = Object.assign(new EventEmitter(), { destroy() {}, write() {} })
  const unknown = await probeController({ root: context.root, policy, stateHome: context.stateHome, timeoutMs: 5, connect: () => unknownSocket })
  assert.equal(unknown.state, "unknown")
  const erroring = Object.assign(new EventEmitter(), { destroy() {}, write() {} })
  const erred = probeController({ root: context.root, policy, stateHome: context.stateHome, connect: () => erroring })
  await new Promise((resolve) => setImmediate(resolve))
  erroring.emit("error", Object.assign(new Error("odd"), { code: "EACCES" }))
  assert.equal((await erred).state, "unknown")
})

test("a hung controller is reported with its owner and endpoint, never signalled", { skip: posixOnly }, async (t) => {
  const context = await fixture(t, "desk-hung-report-")
  const child = await silentChild(context.endpoint)
  t.after(() => child.kill("SIGKILL"))
  writeOwner(context, child.pid)
  const probe = await probeController({ root: context.root, policy, stateHome: context.stateHome, timeoutMs: 200 })
  assert.equal(probe.state, "silent")
  const report = hungControllerReport(probe)
  assert.deepEqual(report, { state: "silent", endpoint: context.endpoint, owner_pid: child.pid, owner_started_at: STARTED_AT, owner_verified: false })
  assert.equal(child.exitCode, null, "the owner is still running")
  assert.equal(child.signalCode, null)
})

test("a socket that refuses, or is gone, while its owner runs is unreachable, not refused or missing", { skip: posixOnly }, async (t) => {
  const context = await fixture(t, "desk-hung-unreachable-")
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  t.after(() => owner.kill("SIGKILL"))
  const dead = await silentChild(context.endpoint)
  dead.kill("SIGKILL")
  await new Promise((resolve) => dead.once("exit", resolve))
  writeOwner(context, owner.pid)
  const probe = () => probeController({ root: context.root, policy, stateHome: context.stateHome, timeoutMs: 200 })
  const refusing = await probe()
  assert.equal(refusing.state, "unreachable")
  assert.equal(probeMissed(refusing), true)
  rmSync(context.endpoint, { force: true })
  assert.equal((await probe()).state, "unreachable", "a running owner whose socket file is gone")
  owner.kill("SIGKILL")
  await new Promise((resolve) => owner.once("exit", resolve))
  const gone = await probe()
  assert.equal(gone.state, "missing", "once the owner is gone, a missing socket is just missing")
  assert.equal(probeMissed(gone), false)
  assert.equal(probeMissed({ state: "silent" }), true)
  assert.equal(probeMissed({ state: "answering" }), false)
})

test("a report reads what the owner record says, and nothing when it says nothing", () => {
  assert.deepEqual(hungControllerReport({ state: "silent", endpoint: "/e", record: { owner: { pid: 12, started_at: "2026-09-26T00:00:00.000Z" } } }), { state: "silent", endpoint: "/e", owner_pid: 12, owner_started_at: "2026-09-26T00:00:00.000Z", owner_verified: false })
  assert.deepEqual(hungControllerReport({ state: "silent", endpoint: "/e", record: null }), { state: "silent", endpoint: "/e", owner_pid: null, owner_started_at: null, owner_verified: false })
  assert.equal(hungControllerReport({ state: "silent", endpoint: "/e", record: { owner: { pid: 12, process_start: "darwin:2026-09-26T00:00:00.000Z" } } }).owner_verified, true, "a record with the owner's start time names the owner itself")
  assert.deepEqual(hungControllerReport({ state: "silent", endpoint: "/e", record: { owner: { pid: "12" } } }).owner_pid, null)
})
