// Detecting a readiness controller that accepts connections but never answers, and reclaiming it only when it is provably ours to stop.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { readinessContracts } from "../../src/readiness/contracts.js"
import { HUNG_MISSES, HUNG_PROBE_MS, probeController, reclaimHungController, reclaimPreconditions } from "../../src/readiness/hung-controller.js"
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

async function silentChild(endpoint, { ignoreTerm = false } = {}) {
  const child = spawn(process.execPath, ["-e", [
    ignoreTerm ? "process.on('SIGTERM', () => {})" : "",
    `require("net").createServer(() => {}).listen(${JSON.stringify(endpoint)}, () => process.stdout.write("up"))`,
  ].join(";")], { stdio: ["ignore", "pipe", "inherit"] })
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

test("a silent controller whose process ignores SIGTERM is killed, and the reclaim reports it", { skip: posixOnly }, async (t) => {
  const context = await fixture(t, "desk-hung-reclaim-")
  const child = await silentChild(context.endpoint, { ignoreTerm: true })
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal)))
  t.after(() => child.kill("SIGKILL"))
  writeOwner(context, child.pid)
  const probe = await probeController({ root: context.root, policy, stateHome: context.stateHome, timeoutMs: 200 })
  assert.equal(probe.state, "silent")
  const reclaimed = await reclaimHungController(probe, { termWaitMs: 200 })
  assert.equal(reclaimed.reclaimed, true)
  assert.equal(reclaimed.pid, child.pid)
  assert.match(reclaimed.line, /reclaimed a hung readiness controller \(pid \d+/u)
  assert.equal(await exited, "SIGKILL")
})

test("a silent controller that exits on SIGTERM needs no SIGKILL", { skip: posixOnly }, async (t) => {
  const context = await fixture(t, "desk-hung-term-")
  const child = await silentChild(context.endpoint)
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal)))
  writeOwner(context, child.pid)
  const probe = await probeController({ root: context.root, policy, stateHome: context.stateHome, timeoutMs: 200 })
  assert.equal((await reclaimHungController(probe)).reclaimed, true)
  assert.equal(await exited, "SIGTERM")
})

test("every precondition refuses a reclaim that is not provably ours", async (t) => {
  const base = await mkTempRoot("desk-hung-preconditions-")
  const identity = controllerIdentity({ root: base, ...readinessContracts(policy) })
  const privateDir = path.join(base, "private")
  mkdirSync(privateDir, { mode: 0o700 })
  const stateDir = path.join(base, "state")
  mkdirSync(stateDir, { mode: 0o700 })
  const endpoint = path.join(privateDir, "c.sock")
  const server = net.createServer(() => {})
  if (process.platform !== "win32") await new Promise((resolve) => server.listen(endpoint, resolve))
  t.after(() => server.close())
  const stat = process.platform === "win32" ? { dev: 1, ino: 1 } : lstatSync(endpoint)
  const record = (overrides = {}) => ({ identity, endpoint, socket: { dev: stat.dev, ino: stat.ino }, owner: { pid: 999999 }, ...overrides })
  const probe = (overrides = {}) => ({ state: "silent", endpoint, stateDir, identity, record: record(), ...overrides })
  const alive = () => {}
  const cases = [
    [probe(), { platform: "win32" }, "unsupported_platform"],
    [probe({ state: "answering" }), {}, "controller_answering"],
    [probe({ record: null }), {}, "owner_record_not_ours"],
    [probe({ record: record({ identity: { ...identity, root: "/elsewhere" } }) }), {}, "owner_record_not_ours"],
    [probe({ record: { endpoint, owner: { pid: 1 } } }), {}, "owner_record_not_ours"],
    [probe({ endpoint: path.join(privateDir, "missing.sock") }), {}, "endpoint_not_ours"],
    [probe({ record: record({ socket: { dev: stat.dev, ino: stat.ino + 1 } }) }), {}, "endpoint_not_ours"],
    [probe({ record: record({ socket: null }) }), {}, "endpoint_not_ours"],
    [probe(), { uid: -1 }, "endpoint_not_ours"],
    [probe({ record: record({ owner: { pid: process.pid } }) }), { kill: alive }, "owner_pid_invalid"],
    [probe({ record: record({ owner: { pid: "12" } }) }), { kill: alive }, "owner_pid_invalid"],
    [probe({ record: record({ owner: null }) }), { kill: alive }, "owner_pid_invalid"],
    [probe(), { kill: () => { throw Object.assign(new Error("perm"), { code: "EPERM" }) } }, "owner_not_ours"],
    [probe(), { kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }) } }, "owner_gone"],
  ]
  for (const [candidate, options, reason] of cases) {
    if (process.platform === "win32" && reason !== "unsupported_platform") continue
    assert.deepEqual(reclaimPreconditions(candidate, options), { ok: false, reason }, reason)
  }
  if (process.platform !== "win32") {
    assert.deepEqual(reclaimPreconditions(probe(), { kill: alive }), { ok: true, pid: 999999 })
    chmodSync(privateDir, 0o755)
    assert.equal(reclaimPreconditions(probe(), { kill: alive }).reason, "endpoint_not_ours")
    chmodSync(privateDir, 0o700)
    const fileEndpoint = path.join(privateDir, "file")
    writeFileSync(fileEndpoint, "")
    const fileStat = lstatSync(fileEndpoint)
    assert.equal(reclaimPreconditions(probe({ endpoint: fileEndpoint, record: record({ endpoint: fileEndpoint, socket: { dev: fileStat.dev, ino: fileStat.ino } }) }), { kill: alive }).reason, "endpoint_not_ours")
  }
  assert.deepEqual(await reclaimHungController(probe({ state: "refused" })), { reclaimed: false, reason: "controller_refused" })
  assert.equal(reclaimPreconditions(probe({ state: "refused" })).reason, "controller_refused", "the defaults read this process")
})

test("the kill sequence: a survivor is reported, and a process that vanishes during SIGTERM or SIGKILL counts as reclaimed", { skip: posixOnly }, async (t) => {
  const base = await mkTempRoot("desk-hung-sequence-")
  const identity = controllerIdentity({ root: base, ...readinessContracts(policy) })
  const privateDir = path.join(base, "private")
  mkdirSync(privateDir, { mode: 0o700 })
  const stateDir = path.join(base, "state")
  mkdirSync(stateDir, { mode: 0o700 })
  const endpoint = path.join(privateDir, "c.sock")
  const server = net.createServer(() => {})
  await new Promise((resolve) => server.listen(endpoint, resolve))
  t.after(() => server.close())
  const stat = lstatSync(endpoint)
  const probe = { state: "silent", endpoint, stateDir, identity, record: { identity, endpoint, socket: { dev: stat.dev, ino: stat.ino }, owner: { pid: 999999 } } }
  const sleep = async () => {}
  const run = async (script) => {
    const signals = []
    const kill = (pid, signal) => {
      signals.push(signal)
      const step = script(signal, signals)
      if (step === "throw") throw Object.assign(new Error("gone"), { code: "ESRCH" })
    }
    const result = await reclaimHungController(probe, { kill, sleep, termWaitMs: 100, killWaitMs: 100 })
    return { result, signals }
  }
  const survivor = await run(() => "alive")
  assert.equal(survivor.result.reason, "owner_survived")
  assert.ok(survivor.signals.includes("SIGTERM") && survivor.signals.includes("SIGKILL"))
  // The precondition check signals 0 once; the process is gone by the time SIGTERM is sent.
  const goneOnTerm = await run((signal, signals) => (signals.length > 1 ? "throw" : "alive"))
  assert.equal(goneOnTerm.result.reclaimed, true)
  // Alive through the SIGTERM wait, gone when SIGKILL is sent.
  const goneOnKill = await run((signal, signals) => (signals.includes("SIGKILL") ? "throw" : "alive"))
  assert.equal(goneOnKill.result.reclaimed, true)
  assert.deepEqual(goneOnKill.signals.filter((signal) => signal !== 0), ["SIGTERM", "SIGKILL"])
})
