// The admission worker: root and activation resolution and the runtime restore, off the thread that answers the host.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { MessageChannel } from "node:worker_threads"
import { ActivationFailure } from "../../src/activation/failures.js"
import {
  attachAdmissionWorker, prepareRuntimeInputs, warmNativeModules, resolveAdmissionInputs, reviveError, runAdmissionJob, runInWorker, serializeError,
} from "../../src/runtime/admission-worker.js"
import { mkTempRoot } from "../_temp_roots.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))

test("resolve: root, activation and policy, or the error that stopped them, as plain data", async () => {
  const base = await mkTempRoot("desk-worker-resolve-")
  const desk = path.join(base, "desk")
  mkdirSync(desk)
  const good = resolveAdmissionInputs({ args: { root: desk, stateBranch: "main" }, env: {}, cwd: base, homeDir: base })
  assert.equal(good.root.root, desk)
  assert.equal(good.activation.stateBranch, "main")
  assert.equal(good.activation.readinessPolicy.semantic, "background")
  assert.equal(good.activation.runtimeCacheDir, null)
  const injected = resolveAdmissionInputs({ args: { root: desk }, env: {}, cwd: base, homeDir: base, injectedReadinessPolicy: { semantic: "unsupported" } })
  assert.equal(injected.activation.readinessPolicy.semantic, "unsupported")
  const missing = resolveAdmissionInputs({ args: { root: path.join(base, "missing") }, env: {}, cwd: base, homeDir: base })
  assert.equal(missing.rootError.code, "DESK_ROOT_UNAVAILABLE")
  assert.equal(missing.root, undefined)
  const configPath = path.join(base, "activation.json")
  writeFileSync(configPath, JSON.stringify({ schema_version: 1, desk: { root: desk }, desk_runtime: { semantic: "sometimes" } }))
  const badPolicy = resolveAdmissionInputs({ args: { root: desk, activationConfig: configPath }, env: {}, cwd: base, homeDir: base })
  assert.equal(badPolicy.root.root, desk)
  assert.equal(badPolicy.activationError.code, "activation_policy_invalid")
  assert.equal(badPolicy.activationError.status, "terminal")
  assert.deepEqual(JSON.parse(JSON.stringify(badPolicy)), badPolicy, "results survive postMessage")
})

test("runtime: inspection, restore, and the failure that stopped either", () => {
  const input = { mcpRoot: "/plugin", env: {}, runtimeCacheDir: "/cache", sourceIdentity: null }
  const prepared = { runtimeCacheDir: "/cache", sourceMirrorPath: "/cache/mirror", target: "t", packDir: "/p" }
  const warmed = []
  assert.deepEqual(prepareRuntimeInputs({ ...input, inspect: false, prepare: () => prepared, warm: (mirror) => warmed.push(mirror) }), { inspection: null, prepared })
  assert.deepEqual(warmed, ["/cache/mirror"], "the restored native modules are loaded on the worker")
  const ok = prepareRuntimeInputs({ ...input, inspect: true, inspector: () => ({ ok: true, archiveEntries: [1], manifest: {}, runtime: { a: 1 } }), prepare: () => prepared })
  assert.deepEqual(ok, { inspection: { ok: true, runtime: { a: 1 } }, prepared })
  assert.deepEqual(prepareRuntimeInputs({ ...input, inspect: true, inspector: () => ({ ok: false, reason: "missing_pack" }) }), { inspection: { ok: false, reason: "missing_pack" } })
  assert.equal(prepareRuntimeInputs({ ...input, inspect: true, inspector: () => { throw new Error("matrix unreadable") } }).inspectionError.message, "matrix unreadable")
  const failed = prepareRuntimeInputs({ ...input, inspect: false, prepare: () => { throw new Error("disk full") } })
  assert.deepEqual(failed, { inspection: null, restoreError: { name: "Error", message: "disk full" } })
})

test("runtime: a publication-lock timeout names the lock and the process holding it", async () => {
  const base = await mkTempRoot("desk-worker-lock-")
  const lockDir = path.join(base, "cache.publish-lock")
  mkdirSync(lockDir)
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 4321 }))
  const locked = (dir) => () => { throw new Error(`atomic publication lock timed out: ${dir}`) }
  const input = { mcpRoot: "/plugin", env: {}, runtimeCacheDir: null, sourceIdentity: null, inspect: false }
  assert.deepEqual(prepareRuntimeInputs({ ...input, prepare: locked(lockDir) }).restoreError.lock, { dir: lockDir, pid: 4321 })
  assert.deepEqual(prepareRuntimeInputs({ ...input, prepare: locked(path.join(base, "gone.publish-lock")) }).restoreError.lock, { dir: path.join(base, "gone.publish-lock"), pid: null })
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({}))
  assert.equal(prepareRuntimeInputs({ ...input, prepare: locked(lockDir) }).restoreError.lock.pid, null)
  assert.equal(prepareRuntimeInputs({ ...input, prepare: () => { throw "a string" } }).restoreError.message, "a string")
})

test("warmNativeModules loads better-sqlite3 and sqlite-vec from the source mirror and opens an in-memory database; any failure is harmless", async () => {
  const events = []
  const fakeRequire = (from) => {
    events.push(["from", from])
    return (name) => {
      events.push(["require", name])
      if (name === "better-sqlite3") return class { constructor(file) { events.push(["open", file]) } close() { events.push(["close"]) } }
      return { load: () => events.push(["load"]) }
    }
  }
  assert.equal(warmNativeModules("/mirror", { requireFrom: fakeRequire }), true)
  assert.deepEqual(events, [["from", path.join("/mirror", "src", "db", "init.js")], ["require", "better-sqlite3"], ["open", ":memory:"], ["require", "sqlite-vec"], ["load"], ["close"]])
  events.length = 0
  const failingVec = (from) => (name) => {
    if (name === "better-sqlite3") return class { close() { events.push(["close"]) } }
    throw new Error("no extension")
  }
  assert.equal(warmNativeModules("/mirror", { requireFrom: failingVec }), false)
  assert.deepEqual(events, [["close"]], "the database is closed even when the extension fails")
  const mirror = await mkTempRoot("desk-worker-missing-native-")
  const moduleRoot = path.join(mirror, "node_modules", "better-sqlite3")
  mkdirSync(moduleRoot, { recursive: true })
  writeFileSync(path.join(moduleRoot, "package.json"), JSON.stringify({ exports: "./missing.cjs" }))
  assert.equal(warmNativeModules(mirror), false, "a missing mirror module fails even when NODE_PATH supplies checkout dependencies")
  assert.equal(warmNativeModules(path.join(mcpRoot)), true, "this checkout's own modules load")
})

test("runtime job with the shipped inspector and restore defaults", async () => {
  const base = await mkTempRoot("desk-worker-real-")
  const result = prepareRuntimeInputs({ mcpRoot, env: { HOME: base }, runtimeCacheDir: path.join(base, "cache"), sourceIdentity: null, inspect: true })
  if (result.inspection.ok) {
    assert.equal(typeof result.prepared.sourceMirrorPath, "string")
    assert.equal(result.inspection.archiveEntries, undefined)
  } else {
    assert.equal(result.inspection.reason, "unsupported_target")
  }
})

test("runAdmissionJob dispatches by kind and refuses an unknown one", async () => {
  const base = await mkTempRoot("desk-worker-dispatch-")
  assert.equal(runAdmissionJob({ kind: "resolve", input: { args: { root: base }, env: {}, cwd: base } }).root.root, base)
  assert.throws(() => runAdmissionJob({ kind: "format-disk" }), /unknown admission job: format-disk/u)
  assert.throws(() => runAdmissionJob(null), /unknown admission job: undefined/u)
})

test("errors cross the thread boundary as plain data and come back as Errors", () => {
  const failure = new ActivationFailure({ phase: "VERIFYING", code: "authority_invalid", summary: "no authority", observed: { a: 1 } })
  const plain = serializeError(failure)
  assert.equal(plain.name, "ActivationFailure")
  assert.equal(plain.code, "authority_invalid")
  assert.deepEqual(plain.observed, { a: 1 })
  assert.deepEqual(serializeError("thrown text"), { name: "unknown", message: "thrown text" })
  const revived = reviveError(plain)
  assert.ok(revived instanceof Error)
  assert.equal(revived.code, "authority_invalid")
  assert.equal(revived.message, "no authority")
})

test("attachAdmissionWorker answers one job on its port, and does nothing outside a Desk worker", async () => {
  assert.equal(attachAdmissionWorker(null, { deskAdmissionWorker: true }), false)
  const channel = new MessageChannel()
  assert.equal(attachAdmissionWorker(channel.port1, {}), false)
  assert.equal(attachAdmissionWorker(channel.port1, { deskAdmissionWorker: true }), true)
  const base = await mkTempRoot("desk-worker-port-")
  const reply = new Promise((resolve) => channel.port2.once("message", resolve))
  channel.port2.postMessage({ kind: "resolve", input: { args: { root: base }, env: {}, cwd: base } })
  assert.equal((await reply).value.root.root, base)
  const other = new MessageChannel()
  attachAdmissionWorker(other.port1, { deskAdmissionWorker: true })
  const failure = new Promise((resolve) => other.port2.once("message", resolve))
  other.port2.postMessage({ kind: "nope" })
  assert.deepEqual(await failure, { ok: false, error: { name: "TypeError", message: "unknown admission job: nope" } })
  for (const port of [channel.port1, channel.port2, other.port1, other.port2]) port.close()
})

test("runInWorker runs a job on a real worker thread", async () => {
  const base = await mkTempRoot("desk-worker-thread-")
  const result = await runInWorker({ kind: "resolve", input: { args: { root: base }, env: {}, cwd: base } })
  assert.equal(result.root.root, base)
  await assert.rejects(runInWorker({ kind: "nope" }), (error) => error instanceof Error && error.name === "TypeError" && /unknown admission job/u.test(error.message))
})

test("runInWorker reports a worker that errors or exits before answering, and settles once", async () => {
  const fake = () => {
    const worker = Object.assign(new EventEmitter(), { terminated: 0, unref() {}, terminate() { this.terminated += 1 }, postMessage() {} })
    return worker
  }
  let worker = fake()
  const errored = runInWorker({ kind: "resolve" }, { createWorker: () => worker })
  worker.emit("error", new Error("worker crashed"))
  worker.emit("exit", 1)
  await assert.rejects(errored, /worker crashed/u)
  assert.equal(worker.terminated, 1)
  worker = fake()
  const exited = runInWorker({ kind: "resolve" }, { createWorker: () => worker })
  worker.emit("exit", 3)
  await assert.rejects(exited, /exited \(code 3\) before answering/u)
})

test("the readiness policy comes from desk_runtime, then desk.runtime, then the defaults", async () => {
  const { resolveStartupReadinessPolicy } = await import("../../src/runtime/startup-resolve.js")
  const base = await mkTempRoot("desk-worker-policy-")
  const write = (name, body) => {
    const file = path.join(base, name)
    writeFileSync(file, JSON.stringify({ schema_version: 1, desk: { root: base, ...body.desk }, ...body.top }))
    return file
  }
  const nested = write("nested.json", { desk: { runtime: { semantic: "unsupported" } } })
  assert.equal(resolveStartupReadinessPolicy({ args: { activationConfig: nested }, env: {} }).semantic, "unsupported")
  const neither = write("neither.json", {})
  assert.equal(resolveStartupReadinessPolicy({ args: { activationConfig: neither }, env: {} }).semantic, "background")
})
