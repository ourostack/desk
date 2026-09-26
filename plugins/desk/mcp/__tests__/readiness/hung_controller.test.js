// Detecting a readiness controller that accepts connections but never answers, and reclaiming it only when it is provably ours to stop.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { readinessContracts } from "../../src/readiness/contracts.js"
import { HUNG_MISSES, HUNG_PROBE_MS, hungControllerReport, probeController } from "../../src/readiness/hung-controller.js"
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

function writeOwner({ stateDir, identity, endpoint }, pid, socket = lstatSync(endpoint)) {
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
    schema_version: 1, identity, endpoint, socket: { dev: socket.dev, ino: socket.ino }, owner: { pid, token: "t" },
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
  assert.deepEqual(report, { state: "silent", endpoint: context.endpoint, owner_pid: child.pid, owner_started_at: null })
  assert.equal(child.exitCode, null, "the owner is still running")
  assert.equal(child.signalCode, null)
})

test("a report reads what the owner record says, and nothing when it says nothing", () => {
  assert.deepEqual(hungControllerReport({ state: "silent", endpoint: "/e", record: { owner: { pid: 12, started_at: "2026-09-26T00:00:00.000Z" } } }), { state: "silent", endpoint: "/e", owner_pid: 12, owner_started_at: "2026-09-26T00:00:00.000Z" })
  assert.deepEqual(hungControllerReport({ state: "silent", endpoint: "/e", record: null }), { state: "silent", endpoint: "/e", owner_pid: null, owner_started_at: null })
  assert.deepEqual(hungControllerReport({ state: "silent", endpoint: "/e", record: { owner: { pid: "12" } } }).owner_pid, null)
})
