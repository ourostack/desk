// The admission worker: root and activation resolution and the runtime restore, off the thread that answers the host.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { MessageChannel } from "node:worker_threads"
import { ActivationFailure } from "../../../../../plugins/desk/mcp/src/activation/failures.js"
import {
  attachAdmissionWorker, prepareRuntimeInputs, warmNativeModules, resolveAdmissionInputs, reviveError, runAdmissionJob, runInWorker, serializeError,
} from "../../../../../plugins/desk/mcp/src/runtime/admission-worker.js"
import { resolveStartupDeskRoot } from "../../../../../plugins/desk/mcp/src/runtime/startup-resolve.js"
import { recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"
import { resolveBootRoot } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { mkTempRoot } from "../_temp_roots.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../../../../../plugins/desk/mcp", import.meta.url)))

function makeDesk(folder) {
  mkdirSync(path.join(folder, "_meta"), { recursive: true })
  mkdirSync(path.join(folder, "_archive"), { recursive: true })
  return folder
}

for (const scenario of [
  { name: "unavailable saved binding", association: "activation", unavailable: true, error: "DESK_ROOT_UNAVAILABLE" },
  { name: "valid saved binding", association: "activation", source: "activation-config" },
  { name: "unavailable DESK", association: "env", unavailable: true, error: "DESK_ROOT_UNAVAILABLE" },
  { name: "valid DESK", association: "env", source: "env:DESK" },
  { name: "malformed activation", association: "activation", malformed: true, error: "ACTIVATION_CONFIG_INVALID" },
]) {
  for (const entrypoint of ["boot", "admission"]) {
    test(`association: ${entrypoint} does not let a valid cwd mask ${scenario.name}`, async () => {
      const base = await mkTempRoot("desk-launch-association-")
      const home = path.join(base, "home")
      mkdirSync(home)
      const cwd = makeDesk(path.join(base, "launch"))
      const associated = path.join(base, "associated")
      if (!scenario.unavailable) makeDesk(associated)
      const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state") }
      if (scenario.association === "activation") {
        const config = path.join(base, "activation.json")
        writeFileSync(config, scenario.malformed ? "{" : JSON.stringify({
          schema_version: 1,
          desk: { root: associated, state_branch: "trunk" },
        }))
        env.DESK_ACTIVATION_CONFIG = config
      } else {
        env.DESK = associated
      }
      const input = { args: {}, env, cwd, homeDir: home }
      if (entrypoint === "boot") {
        const result = resolveBootRoot(input)
        if (scenario.error) {
          assert.equal(result.status, "degraded")
          assert.equal(result.reason, scenario.error)
          if (!scenario.malformed) assert.equal(result.path, associated)
        } else {
          assert.equal(result.status, "ready")
          assert.equal(result.path, associated)
          assert.equal(result.source, scenario.source)
        }
      } else {
        const result = resolveAdmissionInputs(input)
        if (scenario.error) {
          assert.equal(result.rootError?.code, scenario.error)
          assert.equal(result.root, undefined)
          assert.equal(result.activation, undefined, "a refused association must not attach its policy to cwd")
          if (!scenario.malformed) assert.equal(result.rootError.path, associated)
        } else {
          assert.equal(result.root.root, associated)
          assert.equal(result.root.source, scenario.source)
          if (scenario.association === "activation") assert.equal(result.activation.stateBranch, "trunk")
        }
      }
    })
  }
}

test("association: invalid saved binding and DESK refuse even with a valid host desk folder", async () => {
  const base = await mkTempRoot("desk-launch-known-association-")
  const known = makeDesk(path.join(base, "known"))
  const cwd = makeDesk(path.join(base, "launch"))
  const config = path.join(base, "activation.json")
  writeFileSync(config, JSON.stringify({ schema_version: 1, desk: { root: path.join(base, "missing-saved") } }))
  for (const extra of [
    { DESK_ACTIVATION_CONFIG: config },
    { DESK: path.join(base, "missing-env") },
  ]) {
    const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state"), CLAUDE_PROJECT_DIR: known, ...extra }
    const input = { args: {}, env, cwd, homeDir: base }
    assert.equal(resolveBootRoot(input).status, "degraded")
    assert.equal(resolveAdmissionInputs(input).rootError.code, "DESK_ROOT_UNAVAILABLE")
  }
  const project = path.join(base, "ordinary-host-project")
  mkdirSync(project)
  const home = path.join(base, "home")
  const fallback = makeDesk(path.join(home, "desk"))
  const input = { args: {}, env: { HOME: home, CLAUDE_PROJECT_DIR: project }, cwd, homeDir: home }
  assert.equal(resolveBootRoot(input).path, fallback, "known non-desk host context must not be replaced by child cwd")
  assert.equal(resolveAdmissionInputs(input).root.root, fallback)
})

test("association: empty host project context leaves cwd as a generic hint in boot and admission", async () => {
  const base = await mkTempRoot("desk-launch-empty-context-")
  const cwd = makeDesk(path.join(base, "launch"))
  for (const value of ["", "   "]) {
    const input = { args: {}, env: { HOME: base, CLAUDE_PROJECT_DIR: value }, cwd, homeDir: base }
    assert.equal(resolveBootRoot(input).path, cwd)
    assert.equal(resolveAdmissionInputs(input).root.root, cwd)
  }
})

test("resolve: a captured desk launch folder beats the home fallback and agrees with boot without host variables", async () => {
  const base = await mkTempRoot("desk-worker-launch-")
  const home = path.join(base, "home")
  const fallback = makeDesk(path.join(home, "desk"))
  const cwd = makeDesk(path.join(base, "opened-desk"))
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state") }
  const input = { args: {}, env, cwd, homeDir: home }
  const boot = resolveBootRoot({ env, cwd, homeDir: home })
  assert.equal(boot.status, "ready")
  assert.equal(boot.path, cwd)
  assert.equal(boot.source, "host-project")
  const startup = resolveStartupDeskRoot(input)
  assert.equal(startup.root, cwd, `the launch desk must not be masked by ${fallback}`)
  assert.equal(startup.source, "host-project")
  const admission = resolveAdmissionInputs(input)
  assert.equal(admission.root.root, cwd)
  assert.equal(admission.root.source, "host-project")
  const worker = await runInWorker({ kind: "resolve", input })
  assert.deepEqual(worker.root, startup, "captured launch evidence survives the worker boundary")
})

test("resolve: a non-desk launch folder preserves saved binding, DESK and home defaults", async () => {
  const base = await mkTempRoot("desk-worker-project-")
  const home = path.join(base, "home")
  const fallback = makeDesk(path.join(home, "desk"))
  const saved = makeDesk(path.join(base, "saved"))
  const cwd = path.join(base, "ordinary-project")
  mkdirSync(cwd)
  const configPath = path.join(base, "activation.json")
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    desk: { root: saved, state_branch: "trunk" },
    activation: { source_identity: "commit:0123456789abcdef" },
  }))
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state") }
  for (const [args, extra, root, source] of [
    [{ activationConfig: configPath }, {}, saved, "activation-config"],
    [{}, { DESK: saved }, saved, "env:DESK"],
    [{}, {}, fallback, "home_fallback"],
  ]) {
    const input = { args, env: { ...env, ...extra }, cwd, homeDir: home }
    for (const resolved of [resolveStartupDeskRoot(input), resolveAdmissionInputs(input).root]) {
      assert.equal(resolved.root, root)
      assert.equal(resolved.source, source)
    }
    if (args.activationConfig) {
      const { activation } = resolveAdmissionInputs(input)
      assert.equal(activation.sourceIdentity, "commit:0123456789abcdef")
      assert.equal(activation.activationStatus.source, "activation-config")
      assert.equal(activation.stateBranch, "trunk")
    }
  }
})

test("resolve: explicit and session roots remain authoritative despite a valid desk launch hint", async () => {
  const base = await mkTempRoot("desk-worker-explicit-launch-")
  const cwd = makeDesk(path.join(base, "launch"))
  const explicit = makeDesk(path.join(base, "explicit"))
  const missing = path.join(base, "missing")
  for (const key of ["root", "hostSessionRoot"]) {
    const input = { args: { [key]: explicit }, env: {}, cwd, homeDir: base }
    assert.equal(resolveAdmissionInputs(input).root.root, explicit)
    input.args[key] = missing
    assert.throws(() => resolveStartupDeskRoot(input), (error) => error.code === "DESK_ROOT_UNAVAILABLE" && error.path === missing)
    const refused = resolveAdmissionInputs(input)
    assert.equal(refused.rootError.code, "DESK_ROOT_UNAVAILABLE")
    assert.equal(refused.rootError.path, missing)
    assert.equal(refused.root, undefined)
  }
})

test("resolve: known host project context wins over an unrelated child launch folder", async () => {
  const base = await mkTempRoot("desk-worker-known-project-")
  const home = path.join(base, "home")
  mkdirSync(home)
  const cwd = makeDesk(path.join(base, "child-desk"))
  const known = makeDesk(path.join(base, "known-desk"))
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), CLAUDE_PROJECT_DIR: known }
  const input = { args: {}, env, cwd, homeDir: home }
  assert.equal(resolveStartupDeskRoot(input).root, known)
  assert.equal(resolveAdmissionInputs(input).root.root, known)
  const project = path.join(base, "ordinary-project")
  mkdirSync(project)
  const saved = makeDesk(path.join(base, "saved"))
  const nonDeskHost = { ...input, env: { ...env, CLAUDE_PROJECT_DIR: project, DESK: saved } }
  assert.equal(resolveAdmissionInputs(nonDeskHost).root.root, saved, "a known non-desk project must not be replaced by child cwd")
})

test("resolve: separate recorded sessions keep their desks despite each other's child launch folders", async () => {
  const base = await mkTempRoot("desk-worker-launch-sessions-")
  const home = path.join(base, "home")
  mkdirSync(home)
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state") }
  const one = makeDesk(path.join(base, "one"))
  const two = makeDesk(path.join(base, "two"))
  assert.equal(recordCopilotSession({ sessionId: "one", folder: one, env }), true)
  assert.equal(recordCopilotSession({ sessionId: "two", folder: two, env }), true)
  const inputs = [
    { args: {}, env: { ...env, COPILOT_AGENT_SESSION_ID: "one" }, cwd: two, homeDir: home },
    { args: {}, env: { ...env, COPILOT_AGENT_SESSION_ID: "two" }, cwd: one, homeDir: home },
  ]
  const results = await Promise.all(inputs.map((input) => runInWorker({ kind: "resolve", input })))
  for (const [index, root] of [one, two].entries()) {
    assert.equal(resolveStartupDeskRoot(inputs[index]).root, root)
    assert.equal(resolveAdmissionInputs(inputs[index]).root.root, root)
    assert.equal(results[index].root.root, root)
  }
})

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
  const detailed = () => { throw new Error(`atomic publication lock timed out: ${lockDir} (held by pid 4321, which is still running, so its build is taking longer than the wait; waited 30000 ms)`) }
  assert.deepEqual(prepareRuntimeInputs({ ...input, prepare: detailed }).restoreError.lock, { dir: lockDir, pid: 4321 }, "the holder and wait detail after the lock name is not part of the lock name")
  const spaced = path.join(base, "Program Files (x86)", "cache.publish-lock")
  mkdirSync(spaced, { recursive: true })
  writeFileSync(path.join(spaced, "owner.json"), JSON.stringify({ pid: 77 }))
  for (const detail of [
    "held by pid 77, which has exited",
    "held by pid 77, which is still running, so its build is taking longer than the wait",
    "no readable owner record",
  ]) {
    const withDetail = () => { throw new Error(`atomic publication lock timed out: ${spaced} (${detail}; waited 5 ms)`) }
    assert.deepEqual(prepareRuntimeInputs({ ...input, prepare: withDetail }).restoreError.lock, { dir: spaced, pid: 77 }, `a path holding " (" stays whole: ${detail}`)
  }
  const bareSpaced = () => { throw new Error(`atomic publication lock timed out: ${spaced}`) }
  assert.deepEqual(prepareRuntimeInputs({ ...input, prepare: bareSpaced }).restoreError.lock, { dir: spaced, pid: 77 })
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
  assert.equal(warmNativeModules("/mirror", { requireFrom: fakeRequire, platform: "linux" }), true)
  assert.deepEqual(events, [["from", path.join("/mirror", "src", "db", "init.js")], ["require", "better-sqlite3"], ["open", ":memory:"], ["require", "sqlite-vec"], ["load"], ["close"]])
  events.length = 0
  const failingVec = (from) => (name) => {
    if (name === "better-sqlite3") return class { close() { events.push(["close"]) } }
    throw new Error("no extension")
  }
  assert.equal(warmNativeModules("/mirror", { requireFrom: failingVec, platform: "linux" }), false)
  assert.deepEqual(events, [["close"]], "the database is closed even when the extension fails")
  const mirror = await mkTempRoot("desk-worker-missing-native-")
  const moduleRoot = path.join(mirror, "node_modules", "better-sqlite3")
  mkdirSync(moduleRoot, { recursive: true })
  writeFileSync(path.join(moduleRoot, "package.json"), JSON.stringify({ exports: "./missing.cjs" }))
  assert.equal(warmNativeModules(mirror), false, "a missing mirror module fails even when NODE_PATH supplies checkout dependencies")
  // Windows skips the warm-up (see warmNativeModules), so the real load is only expected elsewhere.
  assert.equal(warmNativeModules(path.join(mcpRoot)), process.platform !== "win32", "this checkout's own modules load")
  assert.equal(warmNativeModules("/mirror", { requireFrom: () => assert.fail("nothing is loaded on Windows"), platform: "win32" }), false)
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
  const { resolveStartupReadinessPolicy } = await import("../../../../../plugins/desk/mcp/src/runtime/startup-resolve.js")
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

test("a job reports its steps as phases: through runAdmissionJob, over the worker port, and to runInWorker's onPhase", async () => {
  const base = await mkTempRoot("desk-worker-phase-")
  const heard = []
  const seen = []
  const inspected = { ok: true, runtime: {} }
  const prepared = { sourceMirrorPath: base, runtimeCacheDir: base, target: "t", packDir: base }
  const input = { mcpRoot: base, env: {}, runtimeCacheDir: base, sourceIdentity: null, inspect: true, inspector: () => inspected, prepare: ({ onPhase }) => { onPhase("restoring_runtime_dependencies"); return prepared }, warm: () => false }
  prepareRuntimeInputs(input, { onPhase: (phase) => heard.push(phase) })
  assert.deepEqual(heard, ["inspecting_runtime_pack", "restoring_runtime_dependencies"])
  prepareRuntimeInputs({ ...input, inspect: false })
  runAdmissionJob({ kind: "resolve", input: { args: { root: base }, env: {}, cwd: base } })
  const channel = new MessageChannel()
  attachAdmissionWorker(channel.port1, { deskAdmissionWorker: true })
  const messages = []
  const done = new Promise((resolve) => channel.port2.on("message", (message) => { messages.push(message); if (message.ok !== undefined) resolve() }))
  channel.port2.postMessage({ kind: "runtime", input: { mcpRoot: base, env: {}, runtimeCacheDir: base, sourceIdentity: null, inspect: true } })
  await done
  assert.deepEqual(messages[0], { phase: "inspecting_runtime_pack" }, "the step is posted before the job ends, and carries no reply fields")
  assert.equal(messages.at(-1).ok, true)
  channel.port1.close()
  channel.port2.close()
  const worker = Object.assign(new EventEmitter(), { unref() {}, terminate() {}, postMessage() {} })
  const answered = runInWorker({ kind: "resolve" }, { createWorker: () => worker, onPhase: (phase) => seen.push(phase) })
  worker.emit("message", { phase: "building:runtime-cache" })
  worker.emit("message", { ok: true, value: 7 })
  assert.equal(await answered, 7)
  worker.emit("message", { phase: "arrives after the answer" })
  assert.deepEqual(seen, ["building:runtime-cache"], "a phase that arrives after the call settled is ignored")
  const silent = Object.assign(new EventEmitter(), { unref() {}, terminate() {}, postMessage() {} })
  const quiet = runInWorker({ kind: "resolve" }, { createWorker: () => silent })
  silent.emit("message", { phase: "ignored without a listener" })
  silent.emit("message", { ok: true, value: 8 })
  assert.equal(await quiet, 8)
})
