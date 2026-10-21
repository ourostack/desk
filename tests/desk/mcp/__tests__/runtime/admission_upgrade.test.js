// In-place recovery: fix the injected condition while Desk runs, and desk_status reaches ready with no restart and an unchanged tool list.

import { test } from "node:test"
import { strict as assert, AssertionError } from "node:assert"
import { EventEmitter } from "node:events"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { installedNodesByMajor, mcpRoot } from "../launch/_mcp_handshake.js"
import { git, lastStartUntil, makeGitDesk, readLastStart, settled, startDesk, writeActivation, writeFile } from "./_admission_fixtures.js"
import { controllerRecords, waitForProcessesGone } from "./_controller_exit.js"
import { withReadinessFailure } from "./_readiness_failure_preload.mjs"
import { mkTempRoot } from "../_temp_roots.js"

// Select only "readiness diagnostic pure:" locally. The real admission cases
// below remain the remote Windows evidence, not these synthetic controls.
const diagnosticHelper = new URL("./_readiness_failure_preload.mjs", import.meta.url)
const diagnosticSource = new URL("../../../../../plugins/desk/mcp/src/", import.meta.url)
const diagnosticScope = { sourceRoot: diagnosticSource.href, cacheRoot: "file:///tiny-cache/", helperURL: diagnosticHelper.href }
async function diagnostics() {
  const helper = await import(diagnosticHelper.href).catch(error => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return {}
    throw error
  })
  assert.equal(typeof helper.transformSource, "function", "the approved diagnostic helper is missing")
  return helper
}

test("readiness diagnostic pure: synchronous decoration preserves receiver, result, original throw and one call", async () => {
  const { observeSync } = await diagnostics()
  const receiver = {}
  const result = {}
  let calls = 0
  const decorated = observeSync("copy", function(value) {
    calls++
    assert.equal(this, receiver)
    assert.equal(value, 17)
    return result
  })
  assert.equal(decorated.call(receiver, 17), result)
  assert.equal(calls, 1)
  const promise = Promise.resolve(result)
  assert.equal(observeSync("copy", () => promise)(), promise)
  const error = new Error()
  Object.defineProperty(error, "message", { get() { assert.fail("observer read an error getter") } })
  assert.throws(() => observeSync("copy", () => { throw error })(), value => value === error)
})

test("readiness diagnostic pure: failure prefix is bounded and rejects raw fields and malformed coverage", async () => {
  const { failurePrefix } = await diagnostics()
  const rows = Array.from({ length: 400 }, () => '[readiness-failure] ' + JSON.stringify({
    r: "c", e: "recv", m: "recordChange", q: "0123456789ab", t: 10, a: 1, i: 2,
    token: "secret-token", path: "/private/unrelated", args: ["raw-argument"],
  })).join("\n")
  const prefix = failurePrefix(rows + '\n[readiness-failure] {"r":"secret-token","e":"cov","m":"/private/unrelated"}')
  assert.ok(Buffer.byteLength(prefix) <= 960)
  assert.match(prefix, /coverage_unknown/)
  assert.match(prefix, /recordChange/)
  assert.doesNotMatch(prefix, /secret-token|private|raw-argument|token|args/)
})

test("readiness diagnostic pure: annotation changes only a test error data message and never invokes getters", async () => {
  const { annotateTestError } = await diagnostics()
  const error = new AssertionError({ message: "original assertion", actual: true, expected: false, operator: "strictEqual" })
  const originalMessage = error.message
  assert.equal(annotateTestError(error, ""), error)
  assert.ok(error.message.endsWith(originalMessage))
  assert.ok(error.message.length - originalMessage.length <= 960)
  const production = new Error("production recording error")
  assert.equal(annotateTestError(production, ""), production)
  assert.equal(production.message, "production recording error")
  const accessor = new Error()
  Object.defineProperty(accessor, "message", { get() { assert.fail("message getter invoked") } })
  Object.defineProperty(accessor, "code", { get() { assert.fail("code getter invoked") } })
  assert.equal(annotateTestError(accessor, ""), accessor)
  const timeout = new Error("desk_status did not reach the expected state within 20000 ms; original")
  assert.equal(annotateTestError(timeout, ""), timeout)
  assert.match(timeout.message, /^\[readiness-failure /)
})

test("readiness diagnostic pure: fork propagation changes only the owned controller and preserves delegation", async () => {
  const { wrapControllerFork } = await diagnostics()
  const receiver = {}
  const child = {}
  const calls = []
  const fork = wrapControllerFork(function(...args) { calls.push({ receiver: this, args }); return child }, diagnosticHelper.href, diagnosticScope)
  const options = { execArgv: [], env: { KEEP: "unchanged" }, stdio: ["ignore", "ignore", "inherit", "ipc"] }
  const entry = new URL("readiness/controller-child.js", diagnosticSource)
  assert.equal(fork.call(receiver, entry, [], options), child)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].receiver, receiver)
  assert.deepEqual(calls[0].args[2].execArgv, ["--import", diagnosticHelper.href])
  assert.equal(calls[0].args[2].env, options.env)
  assert.equal(calls[0].args[2].stdio, options.stdio)
  assert.deepEqual(options.execArgv, [])
  fork(fileURLToPath(entry), [], options)
  assert.equal(calls.at(-1).args[0], fileURLToPath(entry))
  assert.deepEqual(calls.at(-1).args[2].execArgv, ["--import", diagnosticHelper.href])
  for (const other of [
    new URL("runtime/status-inspection-child.js", diagnosticSource),
    new URL("file:///outside/readiness/controller-child.js"),
  ]) {
    fork(other, [], options)
    assert.equal(calls.at(-1).args[2], options)
  }
  const mirror = new URL("source-mirror/" + "a".repeat(64) + "/src/readiness/controller-child.js", diagnosticScope.cacheRoot)
  fork(mirror, [], options)
  assert.deepEqual(calls.at(-1).args[2].execArgv, ["--import", diagnosticHelper.href])
  const already = calls.at(-1).args[2]
  fork(mirror, [], already)
  assert.equal(calls.at(-1).args[2], already)
})

test("readiness diagnostic pure: request start is not reported as a wire send before connect", async () => {
  const helper = await diagnostics()
  const original = `
function fixture() {
  const method = "recordChange";
  const id = randomUUID()
  const timeout = () => { reject(new Error(\`readiness controller request timed out: \${method}\`)) };
  socket.once("connect", () => {
      socket.write("original")
  });
  socket.on("data", createControllerResponseAccumulator((line) => {}));
}
return fixture;`
  const changed = helper.transformSource(new URL("readiness/controller-client.js", diagnosticSource).href, original, diagnosticScope)
  assert.equal(changed.coverage, "applied")
  const heard = []
  const callbacks = {}
  let writes = 0
  const socket = { once(name, fn) { callbacks[name] = fn }, on(name, fn) { callbacks[name] = fn }, write() { writes++ } }
  const fixture = new Function("__rd", "__rw", "__rm", "randomUUID", "socket", "createControllerResponseAccumulator", "reject",
    changed.source.split("\n").slice(1).join("\n"))((event) => heard.push(event), helper.observeSync, helper.isMirror, () => "id", socket, fn => fn, () => {})
  fixture()
  assert.deepEqual(heard.filter(value => value !== "cov"), ["start"])
  assert.equal(writes, 0)
  callbacks.connect()
  assert.deepEqual(heard.filter(value => value !== "cov"), ["start", "send"])
  assert.equal(writes, 1)
  callbacks.data("{}")
  assert.equal(heard.at(-1), "reply")
})

test("readiness diagnostic pure: module anchors are atomic, mirror-scoped and syntax checked without execution", async () => {
  const { transformSource } = await diagnostics()
  for (const file of ["readiness/controller-client.js", "readiness/controller-server.js", "readiness/journal.js", "runtime/bootstrap.js", "runtime/admission-worker.js"]) {
    const original = readFileSync(new URL(file, diagnosticSource), "utf8")
    const url = new URL(file, diagnosticSource).href
    const changed = transformSource(url, original, diagnosticScope)
    assert.equal(changed.coverage, "applied", file)
    const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: changed.source, encoding: "utf8" })
    assert.equal(syntax.status, 0, syntax.stderr)
    const missing = transformSource(url, "", diagnosticScope)
    assert.equal(missing.coverage, "unknown")
    assert.equal(missing.source, "")
    const duplicated = transformSource(url, original + "\n" + original, diagnosticScope)
    assert.equal(duplicated.coverage, "unknown")
    assert.equal(duplicated.source, original + "\n" + original)
    const mirrorURL = new URL("source-mirror/" + "a".repeat(64) + "/src/" + file, diagnosticScope.cacheRoot).href
    assert.equal(transformSource(mirrorURL, original, diagnosticScope).coverage, "applied")
    assert.equal(transformSource("file:///outside/src/" + file, original, diagnosticScope).source, original)
    const twice = transformSource(url, changed.source, diagnosticScope)
    assert.equal(twice.coverage, "unknown", "a repeated loader must not decorate already instrumented code")
    assert.equal(twice.source, changed.source)
  }
})

test("readiness diagnostic pure: protection awaits once and propagates the original async rejection", async () => {
  const helper = await diagnostics()
  const original = `
async function existing(protectFile, entries) {
  if (protectFile && entries.length > 0) await protectFile(entries)
}
async function directory(protect, staging) {
  await protect([{ path: staging, kind: "directory", created: true }])
}
async function atomic(protectFile, temporary) {
  if (protectFile) await protectFile([{ path: temporary, kind: "file", created: true }])
}
return {existing, directory, atomic};`
  const transformed = helper.transformSource(new URL("readiness/journal.js", diagnosticSource).href, original, diagnosticScope)
  assert.equal(transformed.coverage, "applied")
  // Execute only this tiny synthetic callback fixture, not a journal/controller.
  const fixture = new Function("__rd", "__rw", "__rm", transformed.source.split("\n").slice(1).join("\n"))(helper.emit, helper.observeSync, helper.isMirror)
  let release
  let calls = 0
  const pending = new Promise(resolve => { release = resolve })
  const work = fixture.existing(() => { calls++; return pending }, [{}])
  assert.equal(calls, 1)
  release()
  assert.equal(await work, undefined)
  const error = new Error("same asynchronous rejection")
  await assert.rejects(fixture.atomic(() => Promise.reject(error), "unused"), value => value === error)
  let thenReads = 0
  const thenable = { get then() { thenReads++; return (resolve) => resolve() } }
  await fixture.directory(() => thenable, "unused")
  assert.equal(thenReads, 1, "the original await, not the observer, assimilates thenables")
})

test("readiness diagnostic pure: case wrapper does not mutate responses or retain stream wrappers", async () => {
  const { withReadinessFailure } = await diagnostics()
  const output = new EventEmitter()
  let writes = 0
  const input = { write() { assert.equal(this, input); writes++; return false } }
  const originalWrite = input.write
  const session = { child: { stdin: input, stdout: output }, stderr: () => "" }
  const response = { isError: true, payload: { canonical_written: true, journal_recorded: null, retryable: false } }
  assert.equal(await withReadinessFailure(session, async () => {
    assert.equal(input.write('{"id":1,"method":"tools/call","params":{"secret":"not retained"}}\n'), false)
    output.emit("data", '{"id":1,"result":{}}\n')
    return response
  }), response)
  assert.equal(writes, 1)
  assert.equal(input.write, originalWrite)
  assert.equal(output.listenerCount("data"), 0)
  const originalError = new Error("production error")
  await assert.rejects(withReadinessFailure(session, async () => { throw originalError }), value => value === originalError)
  assert.equal(originalError.message, "production error")
  assert.equal(input.write, originalWrite)
  const frozen = Object.freeze({ write() { return false } })
  assert.equal(await withReadinessFailure({ child: { stdin: frozen, stdout: output }, stderr: () => "" }, async () => response), response)
})

test("readiness diagnostic pure: opt-in hooks reach declaration-only imports in main and inherited worker", async () => {
  const { preloadArgs } = await diagnostics()
  const root = await mkTempRoot("readiness-preload-control-")
  const fixture = { runtimeCache: path.join(root, "unused-cache") }
  assert.deepEqual(preloadArgs(fixture, null), [])
  assert.deepEqual(preloadArgs(fixture, "unrelated-case"), [])
  const args = preloadArgs(fixture, "missing-root")
  assert.equal(args[0], "--import")
  assert.equal(new URL(args[1]).protocol, "file:")
  const target = new URL("runtime/bootstrap.js", diagnosticSource).href
  // Two tiny scripts only. Import declarations; never prepare/copy a runtime,
  // run a controller, or invoke protection. This proves hook reach, not phases.
  const worker = path.join(root, "worker.mjs")
  const entry = path.join(root, "entry.mjs")
  writeFile(worker, `await import(${JSON.stringify(target)})\n`)
  writeFile(entry, `import { Worker } from "node:worker_threads"
await import(${JSON.stringify(target)})
const worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { deskAdmissionWorker: true } })
await new Promise((resolve, reject) => {
  worker.once("error", reject)
  worker.once("exit", code => code === 0 ? resolve() : reject(new Error("worker failed")))
})
`)
  const result = spawnSync(process.execPath, [...args, entry], { encoding: "utf8", timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const facts = result.stderr.split("\n").filter(line => line.startsWith("[readiness-failure] "))
    .map(line => JSON.parse(line.slice("[readiness-failure] ".length)))
  assert.ok(facts.some(row => row.r === "m" && row.e === "cov" && row.m === "mirror"))
  assert.ok(facts.some(row => row.r === "w" && row.e === "cov" && row.m === "mirror"))
  assert.ok(facts.every(row => row.e === "cov"), "declaration imports must not claim execution of publication phases")
  assert.equal(existsSync(fixture.runtimeCache), false)
})

test("readiness diagnostic pure: inherited stream method and test error identity are restored on failure", async () => {
  const { withReadinessFailure } = await diagnostics()
  const prototype = { write() { return true } }
  const input = Object.create(prototype)
  const output = new EventEmitter()
  const session = { child: { stdin: input, stdout: output }, stderr: () => "" }
  const error = new AssertionError({ message: "same test assertion", actual: true, expected: false, operator: "strictEqual" })
  await assert.rejects(withReadinessFailure(session, async () => { throw error }), value => value === error)
  assert.equal(Object.hasOwn(input, "write"), false)
  assert.equal(input.write, prototype.write)
  assert.equal(output.listenerCount("data"), 0)
})

test("readiness diagnostic pure: a tools-list response is correlated without inventing a tools-call", async () => {
  const { withReadinessFailure } = await diagnostics()
  const output = new EventEmitter()
  const input = { write() { return true } }
  const session = { child: { stdin: input, stdout: output }, stderr: () => "" }
  const error = new AssertionError({ message: "original", actual: true, expected: false, operator: "strictEqual" })
  await assert.rejects(withReadinessFailure(session, async () => {
    input.write('{"id":3,"method":"tools/list"}\n')
    output.emit("data", '{"id":3,"result":{"secret":"not retained"}}\n')
    throw error
  }), value => value === error)
  assert.match(error.message, /tools\/list/)
  assert.doesNotMatch(error.message, /tools\/call|secret|not retained/)
})

test("readiness diagnostic pure: the bounded prefix retains both recording and uncertainty timelines", async () => {
  const { failurePrefix } = await diagnostics()
  const rows = [
    { r: "m", e: "cov", m: "client" }, { r: "w", e: "cov", m: "mirror" },
    { r: "c", e: "cov", m: "server" }, { r: "c", e: "cov", m: "journal" },
  ]
  for (const [m, q] of [["recordChange", "000000000001"], ["markUncertain", "000000000002"]]) {
    rows.push(...[
      ["m", "start"], ["m", "send"], ["c", "recv"], ["c", "done"], ["c", "reply"], ["m", "timeout"],
    ].map(([r, e]) => ({ r, e, m, q })))
  }
  const stderr = rows.map((row, t) => "[readiness-failure] " + JSON.stringify({ ...row, t: 100 + t, a: t, i: 0 })).join("\n")
  const prefix = failurePrefix(stderr)
  const summary = JSON.parse(prefix.slice("[readiness-failure ".length, -2))
  assert.ok(Buffer.byteLength(prefix) <= 960)
  for (const method of ["recordChange", "markUncertain"]) {
    const timeline = summary.rpc.find(row => row.m === method)
    assert.ok(timeline, method)
    assert.equal(typeof timeline.cs, "number", "actual send must survive retention")
    assert.equal(typeof timeline.sv, "number", "server receive must survive retention")
    assert.equal(typeof timeline.ct, "number", "client timeout must survive retention")
  }
})

test("readiness diagnostic pure: the existing failure parser retains the prefix from a tiny intended assertion", async () => {
  const root = await mkTempRoot("readiness-retention-control-")
  const entry = path.join(root, "retention.test.mjs")
  const fact = '[readiness-failure] {"r":"w","e":"build.begin","t":10,"a":0,"i":0}'
  writeFile(entry, `import { test } from "node:test"
import assert from "node:assert/strict"
import { annotateTestError } from ${JSON.stringify(diagnosticHelper.href)}
test("tiny intended assertion", () => {
  try { assert.equal(true, false, "original assertion") }
  catch (error) { annotateTestError(error, ${JSON.stringify(fact)}); throw error }
})
`)
  // Only this tiny test-runner child: otherwise Node skips a recursive test
  // invocation. No Desk launch environment or global environment is changed.
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", entry], { encoding: "utf8", timeout: 10000, env: childEnv })
  assert.equal(result.status, 1, "this synthetic assertion must remain a failure: " + result.stdout + result.stderr)
  // Exercise the existing pure parser, not its runner (which would launch a suite).
  const runner = readFileSync(new URL("../../../../../.github/scripts/run-suite-files.mjs", import.meta.url), "utf8")
  const start = runner.indexOf("const failures = ")
  const end = runner.indexOf("\n\nconst runFile", start)
  assert.ok(start >= 0 && end > start)
  const parse = new Function(runner.slice(start, end).replace("const failures = ", "return "))()
  const failures = parse(result.stdout)
  assert.equal(failures.length, 1)
  assert.match(failures[0].error, /\[readiness-failure .*coverage_unknown/u)
  assert.match(failures[0].error, /original assertion/u)
  assert.ok(failures[0].error.length <= 3000)
})

test("readiness diagnostic pure: observing an invalid request cannot replace the original async error", async () => {
  const helper = await diagnostics()
  const original = `
async function fixture(line, sentinel) {
  let request;
  request = JSON.parse(line)
  if (request === null) throw sentinel;
  const builtin = () => ({});
  const result = await builtin()
  if (!socket.destroyed) socket.end(\`\${JSON.stringify(responseMessage({ id: request.id, result }))}\\n\`)
}
return fixture;`
  const changed = helper.transformSource(new URL("readiness/controller-server.js", diagnosticSource).href, original, diagnosticScope)
  assert.equal(changed.coverage, "applied")
  const fixture = new Function("__rd", "__rw", "__rm", changed.source.split("\n").slice(1).join("\n"))(helper.emit, helper.observeSync, helper.isMirror)
  const error = new Error()
  Object.defineProperty(error, "message", { get() { assert.fail("error getter read") } })
  await assert.rejects(fixture("null", error), value => value === error)
})

test("readiness diagnostic pure: the third opt-in accepts only the closed existing phase vocabulary", async () => {
  const { preloadArgs, normalizePhase } = await diagnostics()
  const args = preloadArgs({ runtimeCache: "/unused-cache" }, "initial-admission")
  assert.equal(args[0], "--import")
  assert.equal(new URL(args[1]).searchParams.get("case"), "initial-admission")
  assert.equal(typeof normalizePhase, "function")
  for (const [value, expected] of [
    ["inspecting_runtime_pack", "inspecting_runtime_pack"],
    ["restoring_runtime_dependencies", "restoring_runtime_dependencies"],
    ["mirroring_source", "mirroring_source"],
    ["waiting_for_publication_lock:/private/raw-name", "waiting_for_publication_lock"],
    ["building:" + "a".repeat(64), "building"],
    ["unrecognized:/private/raw-name", null],
    ["inspecting_runtime_pack:/private/raw-name", null],
    [null, null],
  ]) assert.equal(normalizePhase(value), expected)
  assert.equal(normalizePhase({ toString() { assert.fail("raw object coerced") } }), null)
})

test("readiness diagnostic pure: worker phase forwarding preserves reads, callback result and original error", async () => {
  const helper = await diagnostics()
  const original = `
function fixture(reply, settled, onPhase) {
  if (reply.phase !== undefined) return settled ? undefined : onPhase(reply.phase)
  return "other";
}
return fixture;`
  const changed = helper.transformSource(new URL("runtime/admission-worker.js", diagnosticSource).href, original, diagnosticScope)
  assert.equal(changed.coverage, "applied")
  const fixture = new Function("__rd", "__rw", "__rm", "__rf", changed.source.split("\n").slice(1).join("\n"))(
    helper.emit, helper.observeSync, helper.isMirror, helper.forwardPhase)
  let reads = 0
  let calls = 0
  const raw = "building:/private/raw-name"
  const reply = { get phase() { reads++; return raw } }
  const result = Promise.resolve("same promise")
  assert.equal(fixture(reply, false, function(value) {
    calls++
    assert.equal(this, undefined)
    assert.equal(value, raw, "only the observation is normalized")
    return result
  }), result)
  assert.equal(reads, 2)
  assert.equal(calls, 1)
  reads = 0
  assert.equal(fixture(reply, true, () => assert.fail("late phase forwarded")), undefined)
  assert.equal(reads, 1)
  assert.equal(fixture({}, false, () => assert.fail("non-phase forwarded")), "other")
  const error = new Error()
  Object.defineProperty(error, "message", { get() { assert.fail("error getter read") } })
  assert.throws(() => fixture(reply, false, () => { throw error }), value => value === error)
})

test("readiness diagnostic pure: compact phases retain both critical RPCs and mark absent or lost phase coverage", async () => {
  const { failurePrefix } = await diagnostics()
  const labels = ["inspecting_runtime_pack", "restoring_runtime_dependencies", "waiting_for_publication_lock",
    "building", "mirroring_source", "waiting_for_publication_lock", "building"]
  const cov = [["m", "client"], ["w", "mirror"], ["c", "server"], ["c", "journal"], ["m", "worker"]]
    .map(([r, m]) => ({ r, e: "cov", m }))
  const phases = labels.map(m => ({ r: "m", e: "phase", m }))
  const rpc = [["recordChange", "000000000001"], ["markUncertain", "000000000002"]].flatMap(([m, q]) =>
    [["m", "send"], ["c", "recv"], ["m", "timeout"]].map(([r, e]) => ({ r, e, m, q })))
  const format = rows => failurePrefix(rows.map((row, index) =>
    "[readiness-failure] " + JSON.stringify({ ...row, t: 100 + index, a: index, i: 0 })).join("\n"))
  const parse = prefix => JSON.parse(prefix.slice("[readiness-failure ".length, -2))
  const prefix = format([...cov, ...phases, ...rpc])
  const summary = parse(prefix)
  assert.ok(Buffer.byteLength(prefix) <= 960)
  assert.equal(summary.phase_coverage_unknown, false)
  assert.deepEqual(summary.phases.map(([phase]) => phase), labels)
  for (const method of ["recordChange", "markUncertain"]) {
    const value = summary.rpc.find(row => row.m === method)
    assert.equal(typeof value.cs, "number")
    assert.equal(typeof value.sv, "number")
    assert.equal(typeof value.ct, "number")
  }
  assert.equal(parse(format([...cov, ...rpc])).phase_coverage_unknown, true)
  const unknown = format([...cov, ...phases, { r: "m", e: "unknown", m: "worker" },
    { r: "m", e: "phase", m: "building:/private/raw-hash" }, ...rpc])
  assert.equal(parse(unknown).phase_coverage_unknown, true)
  assert.doesNotMatch(unknown, /private|raw-hash/)
  const crowded = format([...cov, ...Array.from({ length: 60 }, () => phases).flat(), ...rpc])
  assert.ok(Buffer.byteLength(crowded) <= 960)
  const limited = parse(crowded)
  assert.equal(limited.phase_coverage_unknown, true)
  assert.ok(limited.rpc.some(row => row.m === "recordChange" && typeof row.cs === "number"))
  assert.ok(limited.rpc.some(row => row.m === "markUncertain" && typeof row.cs === "number"))
  const anotherUncertainty = [["m", "send"], ["c", "recv"], ["m", "timeout"]]
    .map(([r, e]) => ({ r, e, m: "markUncertain", q: "000000000003" }))
  const repeated = parse(format([...cov, ...phases, ...rpc, ...anotherUncertainty]))
  assert.ok(repeated.rpc.some(row => row.m === "recordChange" && typeof row.ct === "number"))
  assert.ok(repeated.rpc.some(row => row.m === "markUncertain" && row.q === "000000000003"))
})

async function waitFor(predicate, { deadlineMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error("condition not reached in time")
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

test("a missing root recovers in place once the desk appears: ready, same tool list, a write lands", async (t) => {
  const fixture = await makeGitDesk()
  const pending = path.join(fixture.root, "later-desk")
  const configPath = writeActivation({ ...fixture, desk: pending })
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--root", pending], diagnostics: "missing-root" })
  t.after(() => session.close())
  await withReadinessFailure(session, async () => {
    const before = session.tools.result.tools
    const degraded = await session.statusUntil(settled)
    assert.equal(degraded.state, "degraded:root_unavailable")
    git(fixture.root, "clone", fixture.origin, pending)
    const ready = await session.statusUntil((payload) => payload.state === "ready")
    assert.equal(ready.status, "ok")
    assert.equal(ready.admission.state, "ready")
    const after = await session.request("tools/list")
    assert.deepEqual(after.result.tools, before)
    const write = await session.call("task_create", { track: "ops", slug: "recovered-write-check", title: "After recovery" })
    assert.equal(write.isError, false, JSON.stringify(write.payload))
    assert.equal(existsSync(path.join(pending, "ops", "recovered-write-check", "task.md")), true)
    assert.equal((await lastStartUntil(fixture, (record) => record.state === "ready")).state, "ready")
  })
})

test("a saved binding to a missing folder never binds a home-folder desk and recovers in place once the folder appears", async (t) => {
  const fixture = await makeGitDesk()
  // Personal and work desks in the home folder: neither may stand in for the binding.
  for (const home of ["desk", "ms-desk"]) {
    git(fixture.root, "clone", fixture.origin, path.join(fixture.home, home))
  }
  const pending = path.join(fixture.root, "moved-desk")
  const configPath = writeActivation({ ...fixture, desk: pending })
  const session = await startDesk(fixture, { args: ["--activation-config", configPath], diagnostics: "saved-binding" })
  t.after(() => session.close())
  await withReadinessFailure(session, async () => {
    const before = session.tools.result.tools
    const degraded = await session.statusUntil(settled)
    assert.equal(degraded.state, "degraded:root_unavailable")
    assert.equal(degraded.root.path, pending)
    assert.equal(degraded.root.source, "activation-config")
    assert.equal(degraded.root.activation_config, configPath)
    assert.match(degraded.fix, /Restore access to that existing desk/u)
    assert.match(degraded.fix, /correct the saved association through its authorized configuration/u)
    assert.doesNotMatch(degraded.fix, /bootstrap|override|rebind/u)
    const write = await session.call("task_create", { track: "ops", slug: "refused-write-check", title: "Refused" })
    assert.equal(write.isError, true)
    assert.equal(write.payload.code, "root_unavailable")
    assert.doesNotMatch(write.payload.fix, /bootstrap|override|rebind/u)
    assert.equal(existsSync(pending), false, "refusal must not recreate the missing saved desk")
    git(fixture.root, "clone", fixture.origin, pending)
    // A ready status carries no runtime detail when the runtime status misses its short budget (it then says "unavailable"), so wait for the detail the assertions read.
    const ready = await session.statusUntil((payload) => payload.state === "ready" && payload.root && !payload.detail_pending)
    assert.equal(ready.root.path, pending)
    assert.equal(ready.root.source, "activation-config")
    assert.deepEqual((await session.request("tools/list")).result.tools, before)
    const landed = await session.call("task_create", { track: "ops", slug: "recovered-binding-check", title: "After recovery" })
    assert.equal(landed.isError, false, JSON.stringify(landed.payload))
    assert.equal(existsSync(path.join(pending, "ops", "recovered-binding-check", "task.md")), true)
    for (const home of ["desk", "ms-desk"]) {
      assert.equal(existsSync(path.join(fixture.home, home, "ops", "refused-write-check")), false)
      assert.equal(existsSync(path.join(fixture.home, home, "ops", "recovered-binding-check")), false)
    }
  })
})

test("a malformed activation config recovers in place once it is fixed", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = path.join(fixture.root, "fixable.activation.json")
  writeFile(configPath, "{not json")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => session.close())
  assert.equal((await session.statusUntil(settled)).state, "degraded:activation_config_invalid")
  writeActivation(fixture)
  writeFile(configPath, readFileSync(path.join(fixture.root, "desk.activation.json"), "utf8"))
  assert.equal((await session.statusUntil((payload) => payload.state === "ready")).state, "ready")
})

test("a detached HEAD with a local-only commit recovers once the commit is pushed and desk_doctor switches back: repaired, then ready", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "rescue.md"), "rescue\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "local work")
  const sha = git(fixture.desk, "rev-parse", "HEAD")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] })
  t.after(() => session.close())
  const before = session.tools.result.tools
  const degraded = await session.statusUntil(settled)
  assert.equal(degraded.state, "degraded:state_branch_detached")
  // What the fix tells the agent to do: keep the commit on a pushed branch.
  assert.match(degraded.fix, /then call desk_doctor with \{"repair":"switch_state_branch"\}/u)
  git(fixture.desk, "push", "origin", "HEAD:refs/heads/rescue-work")
  // Only the first admission attempt switches on its own; after it, the doctor repair does.
  assert.equal((await session.call("desk_status", { detail: true })).payload.state, "degraded:state_branch_detached")
  const doctored = (await session.call("desk_doctor", { repair: "switch_state_branch" })).payload
  assert.equal(doctored.repair, `repaired: detached HEAD → main (was ${sha.slice(0, 12)})`)
  const ready = await session.statusUntil((payload) => payload.state === "ready")
  // The doctor's forced refresh runs a fresh attempt even when the .git/HEAD watch started one first, so desk_status reports the repair, and the repair log keeps it.
  assert.equal(ready.repair, doctored.repair)
  assert.match(readFileSync(path.join(fixture.stateDir, "repairs.log"), "utf8"), new RegExp(`repaired: detached HEAD → main \\(was ${sha.slice(0, 12)}\\)`, "u"))
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "main")
  assert.deepEqual((await session.request("tools/list")).result.tools, before)
})

test("a HEAD change is noticed without a tool call: the .git/HEAD watch or reconciliation re-runs admission", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] })
  t.after(() => session.close())
  assert.equal((await session.statusUntil(settled)).state, "ready")
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "unpushed.md"), "unpushed\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "unpushed")
  // No desk_status call: only the real watch/reconciliation can move the recorded state.
  await waitFor(() => existsSync(path.join(fixture.stateDir, "last-start.json")) && readLastStart(fixture).state === "degraded:state_branch_detached")
  git(fixture.desk, "switch", "main")
  await waitFor(() => readLastStart(fixture).state === "ready")
})

test("a lost readiness controller is re-elected in the background by the surviving session", { skip: process.platform === "win32" ? "POSIX signals" : false }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  mkdirSync(fixture.stateDir, { recursive: true })
  const first = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => first.close())
  assert.equal((await first.statusUntil(settled)).state, "ready")
  const second = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => second.close())
  assert.equal((await second.statusUntil(settled)).state, "ready")
  // The first session owns the controller; kill it the way a closed host session would.
  const owned = controllerRecords([fixture.readinessHome]).filter((record) => record.parentPid === first.child.pid).map((record) => record.pid)
  assert.equal(owned.length, 1, "the first session's controller child is on record")
  first.child.kill("SIGKILL")
  await new Promise((resolve) => first.child.once("exit", resolve))
  // The controller child shuts down on its own once its parent's channel drops. Until it has exited, a write can still reach it and
  // lose its recording as the controller goes away (canonical_write_recording_failed, connect ENOENT on main on 2026-10-07), which is
  // a write during the loss, not after it.
  await waitForProcessesGone(owned)
  const search = await second.call("desk_search", { query: "lighthouse" })
  assert.equal(search.isError, false)
  const write = await second.call("task_create", { track: "ops", slug: "after-owner-loss", title: "Survivor write" })
  assert.equal(write.isError, false, JSON.stringify(write.payload))
  assert.equal((await second.statusUntil((payload) => payload.state === "ready" && payload.readiness)).readiness.state !== "unavailable", true)
})

test("a deliberate git switch mid-session stays put: writes go read-only with the doctor fix, and switching back restores ready", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "branch", "--track", "feature", "origin/feature")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"], diagnostics: "initial-admission" })
  t.after(() => session.close())
  await withReadinessFailure(session, async () => {
    assert.equal((await session.statusUntil(settled)).state, "ready")
  })
  // Clean and equal to its upstream: at startup Desk would switch this back; mid-session it must not.
  git(fixture.desk, "switch", "feature")
  await waitFor(() => readLastStart(fixture).state === "degraded:state_branch_mismatch")
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "feature", "Desk never switched the checkout")
  const write = await session.call("task_create", { track: "ops", slug: "mid-session-switch-check", title: "Blocked" })
  assert.equal(write.isError, true)
  assert.equal(write.payload.code, "state_branch_mismatch")
  assert.match(write.payload.fix, /desk_doctor with \{"repair":"switch_state_branch"\}/u)
  const status = await session.statusUntil(settled)
  assert.equal(status.state, "degraded:state_branch_mismatch")
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "feature")
  git(fixture.desk, "switch", "main")
  assert.equal((await session.statusUntil((payload) => payload.state === "ready")).state, "ready")
})

test("a session that never reaches ready never switches a deliberate git switch back: only the first admission attempt may", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "branch", "--track", "feature", "origin/feature")
  // A launcher read-only code keeps the session degraded for its whole life.
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main", "--degraded", "identity_unavailable"], diagnostics: "initial-admission" })
  t.after(() => session.close())
  const first = await withReadinessFailure(session, () => session.statusUntil(settled))
  assert.equal(first.state, "degraded:identity_unavailable")
  // Clean and equal to its upstream: the first attempt would have switched this back; every later one must not.
  git(fixture.desk, "switch", "feature")
  const later = await session.statusUntil((payload) => payload.admission.attempts >= first.admission.attempts + 3, { deadlineMs: 30000, intervalMs: 500 })
  assert.equal(later.state, "degraded:identity_unavailable")
  assert.equal(later.admission.state_branch.ok, false)
  assert.equal((await session.call("desk_status", { detail: true })).payload.admission.state_branch.kind, later.admission.state_branch.kind)
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "feature", "Desk never switched the checkout back")
  assert.doesNotMatch(session.stderr(), /repaired: branch feature/u)
  const write = await session.call("task_create", { track: "ops", slug: "never-ready-switch", title: "Blocked" })
  assert.equal(write.isError, true)
  assert.equal(write.payload.code, "state_branch_mismatch")
  assert.match(write.payload.fix, /desk_doctor with \{"repair":"switch_state_branch"\}/u)
})

// A Node that bootstrap.cjs does not run Desk in (no shipped pack for its ABI here), so it re-runs index.js as a child under this Node. It must understand --import in NODE_OPTIONS (Node 20 and later).
function reexecNode() {
  const shipped = JSON.parse(readFileSync(path.join(mcpRoot, "artifacts", "runtime-deps", `${JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8")).version}`, "support-matrix.json"), "utf8"))
  const abis = new Set(shipped.targets.filter((target) => target.platform === process.platform && target.arch === process.arch).map((target) => String(target.node_abi)))
  const candidates = [...installedNodesByMajor().values()].map((entry) => entry.executable)
  for (const executable of ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"]) if (existsSync(executable)) candidates.push(executable)
  for (const executable of candidates) {
    const probe = spawnSync(executable, ["-p", "process.versions.modules + ' ' + process.versions.node"], { encoding: "utf8" })
    const [abi, version] = (probe.stdout ?? "").trim().split(" ")
    if (probe.status === 0 && Number(version?.split(".")[0]) >= 20 && !abis.has(abi)) return executable
  }
  return null
}

const crashPaths = [
  { name: "index.js as the entry point", entry: "index" },
  { name: "bootstrap.cjs running index.js in its own process", entry: "bootstrap" },
  { name: "the .mcp.claude-codex.json inline launcher running bootstrap.cjs in its own process", entry: "launcher" },
  { name: "bootstrap.cjs re-running index.js as a child under a Node with a shipped pack", entry: "bootstrap", reexec: true },
]

for (const launch of crashPaths) {
  const node = launch.reexec ? reexecNode() : process.execPath
  const skip = process.platform === "win32" ? "POSIX signals" : node === null ? "no installed Node 20+ without a shipped pack to start bootstrap.cjs under" : false
  test(`a crash after ready never ends the process (${launch.name}): it degrades to runtime_exception, keeps answering and re-admits`, { skip }, async (t) => {
    const fixture = await makeGitDesk()
    const configPath = writeActivation(fixture)
    const preload = new URL("./fixtures/crash-after-ready-preload.mjs", import.meta.url).href
    // NODE_OPTIONS reaches a re-exec child too; the crash is injected into whichever process runs Desk.
    const session = await startDesk(fixture, { args: ["--activation-config", configPath], entry: launch.entry, node, env: { NODE_OPTIONS: `--import=${preload}` } })
    t.after(() => session.close())
    assert.equal((await session.statusUntil(settled)).state, "ready")
    // Worker threads load the preload too, so a process can say it more than once.
    const armed = [...new Set([...session.stderr().matchAll(/\[crash-preload\] armed pid (\d+)/gu)].map((match) => Number(match[1])))]
    const deskPid = launch.reexec ? armed.find((pid) => pid !== session.child.pid) : session.child.pid
    assert.deepEqual(armed.sort(), (launch.reexec ? [session.child.pid, deskPid] : [deskPid]).sort(), session.stderr())
    process.kill(deskPid, "SIGUSR2")
    await waitFor(() => /caught unhandled_rejection/u.test(session.stderr()))
    const status = (await session.call("desk_status", { detail: true })).payload
    assert.deepEqual(status.admission.exceptions.map((entry) => [entry.kind, entry.message]), [
      ["uncaught_exception", "injected unhandled error event"],
      ["unhandled_rejection", "injected unhandled rejection"],
    ])
    assert.match(session.stderr(), /state: degraded:runtime_exception/u)
    assert.equal((await session.statusUntil((payload) => payload.state === "ready")).state, "ready")
    const write = await session.call("task_create", { track: "ops", slug: "after-crash-write", title: "Still serving" })
    assert.equal(write.isError, false, JSON.stringify(write.payload))
    assert.equal(session.child.exitCode, null, "the process is still running")
  })
}
