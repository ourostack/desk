// The session behind the front door, driven directly with fake roots, runtimes, git and watchers: every admission outcome, every gate and both desk_doctor repairs.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { ActivationFailure } from "../../src/activation/failures.js"
import { createDeskSession, requirementMet, toolRequirement } from "../../src/runtime/desk-session.js"
import { mkTempRoot } from "../_temp_roots.js"

const flush = () => new Promise((resolve) => setImmediate(resolve))
const payload = (result) => JSON.parse(result.content[0].text)

function fakeRuntime(overrides = {}) {
  const calls = []
  return {
    calls,
    callTool: async ({ name, input, person, statusContext }) => {
      calls.push({ name, input, person, controller: statusContext.admission.controller })
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", tool: name, person }) }] }
    },
    connectOrStartController: async () => ({ accepted: true, async status() { return { state: "READY" } } }),
    ...overrides,
  }
}

async function makeSession(t, overrides = {}) {
  const base = await mkTempRoot("desk-session-")
  const root = path.join(base, "desk")
  mkdirSync(root, { recursive: true })
  const lines = []
  const runtime = overrides.runtime ?? fakeRuntime()
  const session = createDeskSession({
    args: { person: null },
    deskStateDir: path.join(base, "state"),
    readinessStateHome: path.join(base, "readiness"),
    stderr: { write: (text) => lines.push(text) },
    resolveRoot: () => ({ root, source: "explicit-root" }),
    resolveActivation: () => ({ activationStatus: null, readinessPolicy: { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" }, stateBranch: null }),
    loadRuntime: async () => ({ runtimeServer: runtime, runtimeStatus: { state: "ready" } }),
    setupDiagnostic: (error) => ({ status: "setup_required", mode: "setup", summary: "no desk", remediation: [{ action: "run_first_run_bootstrap", message: "bootstrap" }], paths_tried: error.tried }),
    ...overrides,
  })
  t.after(() => session.dispose())
  return { session, base, root, lines, runtime, log: () => lines.join("") }
}

test("tool requirements: status, doctor, reads, controller tools and writes", () => {
  assert.equal(toolRequirement("desk_status"), "status")
  assert.equal(toolRequirement("desk_doctor"), "doctor")
  for (const name of ["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread"]) assert.equal(toolRequirement(name), "read")
  for (const name of ["desk_reindex", "desk_work_ledger"]) assert.equal(toolRequirement(name), "controller")
  for (const name of ["task_create", "track_rename", "friction_add", "lesson_add"]) assert.equal(toolRequirement(name), "write")
  const readable = { runtimeServer: {}, root: {} }
  assert.equal(requirementMet("read", {}), false)
  assert.equal(requirementMet("read", readable), true)
  assert.equal(requirementMet("controller", readable), false)
  assert.equal(requirementMet("controller", { ...readable, admission: {} }), true)
  assert.equal(requirementMet("write", { ...readable, admission: {}, stateBranch: { ok: false } }), false)
  assert.equal(requirementMet("write", { ...readable, admission: {}, stateBranch: { ok: true } }), true)
  assert.equal(requirementMet("write", { ...readable, admission: {} }), true)
})

test("unknown tools are refused, reads and writes dispatch to the runtime once admitted", async (t) => {
  const { session, runtime } = await makeSession(t)
  assert.equal((await session.callTool({ name: "nope" })).isError, true)
  const read = await session.callTool({ name: "desk_search", input: { query: "x" } })
  assert.equal(payload(read).tool, "desk_search")
  const write = await session.callTool({ name: "task_create" })
  assert.equal(payload(write).tool, "task_create")
  assert.deepEqual(runtime.calls.map((call) => call.name), ["desk_search", "task_create"])
  assert.deepEqual(runtime.calls[1].input, {})
  assert.equal(session.admission.snapshot().state, "ready")
})

test("setup, missing roots and activation errors are named degraded states", async (t) => {
  const outcomes = [
    Object.assign(new Error("no desk"), { code: "DESK_ROOT_NOT_FOUND", tried: [{ source: "fallback:desk" }] }),
    Object.assign(new Error("bad config"), { code: "ACTIVATION_CONFIG_INVALID" }),
    Object.assign(new Error("--root path does not exist: /x"), { code: "DESK_ROOT_UNAVAILABLE", path: "/x" }),
    new Error("a thrown root without a path"),
  ]
  let error
  const { session } = await makeSession(t, { resolveRoot: () => { throw error } })
  const states = []
  for (error of outcomes) {
    const snapshot = await session.admission.refresh({ force: true })
    states.push([snapshot.state, snapshot.fix])
  }
  assert.equal(states[0][0], "degraded:no_desk_root")
  assert.equal(states[0][1], "bootstrap")
  assert.equal(states[1][0], "degraded:activation_config_invalid")
  assert.equal(states[2][0], "degraded:root_unavailable")
  assert.match(states[2][1], /at \/x/u)
  assert.match(states[3][1], /at the desk root/u)
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.status, "degraded")
  error = outcomes[0]
  const setup = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(setup.status, "setup_required")
  assert.equal(setup.mode, "setup")
})

test("an invalid policy and a changed policy or root are handled on the next attempt", async (t) => {
  let activation = () => { throw new ActivationFailure({ code: "activation_policy_invalid", summary: "bad policy" }) }
  let root = "a"
  const closed = []
  const runtime = fakeRuntime({ connectOrStartController: async () => ({ accepted: true, close: async () => closed.push("closed") }) })
  const { session, base } = await makeSession(t, {
    runtime,
    resolveActivation: () => activation(),
    resolveRoot: () => ({ root: path.join(base, root) }),
  })
  const first = await session.admission.refresh({ force: true })
  assert.equal(first.state, "degraded:activation_policy_invalid")
  assert.match(first.fix, /desk_runtime policy/u)
  const policy = (semantic) => ({ activationStatus: { id: 1 }, readinessPolicy: { semantic, lexical: "required", write_authority: "workspace", authority_provider: null }, stateBranch: null })
  activation = () => policy("unsupported")
  assert.equal((await session.admission.refresh({ force: true })).state, "ready")
  activation = () => policy("background")
  await session.admission.refresh({ force: true })
  await flush()
  assert.deepEqual(closed, ["closed"], "a policy change drops the old controller")
  root = "b"
  await session.admission.refresh({ force: true })
  await flush()
  assert.deepEqual(closed, ["closed", "closed"], "a root change drops the old controller")
  assert.equal(session.context.root.root, path.join(base, "b"))
})

test("runtime failures stop admission and the runtime is loaded only once", async (t) => {
  let loads = 0
  const { session } = await makeSession(t, {
    loadRuntime: async () => {
      loads += 1
      return loads === 1
        ? { outcome: { state: "degraded", code: "artifact_integrity_invalid", fix: "refresh", diagnostic: { reason: "missing_pack" } } }
        : { runtimeServer: fakeRuntime(), runtimeStatus: {} }
    },
  })
  assert.equal((await session.admission.refresh()).state, "degraded:artifact_integrity_invalid")
  const served = payload(await session.callTool({ name: "desk_search" }))
  assert.equal(served.tool, "desk_search", "the gate retried admission, which now loads the runtime")
  await session.admission.refresh({ force: true })
  assert.equal(loads, 2)
})

test("every admission failure class maps to its state and fix", async (t) => {
  const cases = [
    [new ActivationFailure({ code: "authority_invalid", summary: "no authority" }), "authority_invalid"],
    [new ActivationFailure({ code: "embedding_model_mismatch", summary: "model", observed: { model: "x" } }), "embedding_model_mismatch"],
    [Object.assign(new Error("different contract"), { code: "controller_semantic_mismatch", diagnostic: { expected: 1 } }), "controller_semantic_mismatch"],
    [new Error("readiness controller has unsafe directory ownership or permissions"), "controller_state_unsafe"],
    [new ActivationFailure({ code: "controller_start_failed", summary: "no connector" }), "controller_unavailable"],
    [new Error("readiness controller election did not converge"), "controller_unavailable"],
    [Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), "controller_unavailable"],
    [new RangeError("something else"), "admission_exception"],
  ]
  let thrown
  const runtime = fakeRuntime({ admitControlPlane: async () => { throw thrown } })
  const { session } = await makeSession(t, { runtime })
  for (const [error, code] of cases) {
    thrown = error
    const snapshot = await session.admission.refresh({ force: true })
    assert.equal(snapshot.code, code, error.message)
    assert.equal(typeof snapshot.fix, "string")
  }
  thrown = cases[1][0]
  const mismatch = await session.admission.refresh({ force: true })
  assert.equal(mismatch.diagnostic.observed.failure.observed.model, "x")
  assert.equal(mismatch.diagnostic.authority_verified, false)
  thrown = cases[2][0]
  assert.deepEqual((await session.admission.refresh({ force: true })).diagnostic.observed.diagnostic, { expected: 1 })
})

test("admission passes the readiness state home, captures verified authority, and reports a state-directory repair", async (t) => {
  let seen
  const runtime = fakeRuntime({
    connectOrStartController: async (options) => {
      seen = options
      options.onRepair({ action: "chmod_700", path: "/state/abc", from: "755" })
      return { accepted: true }
    },
  })
  const { session, base, log } = await makeSession(t, { runtime })
  const snapshot = await session.admission.refresh()
  assert.equal(seen.stateHome, path.join(base, "readiness"))
  assert.equal(snapshot.repair, "repaired: readiness state directory mode 755 → 700 (/state/abc)")
  assert.match(readFileSync(path.join(base, "state", "repairs.log"), "utf8"), /mode 755 → 700/u)
  assert.match(log(), /state: ready \(repaired: readiness state directory/u)
  const lastStart = JSON.parse(readFileSync(path.join(base, "state", "last-start.json"), "utf8"))
  assert.equal(lastStart.repair, snapshot.repair)
})

test("a verified authority is kept even when the controller then fails", async (t) => {
  const runtime = fakeRuntime({ connectOrStartController: async () => { throw new ActivationFailure({ code: "embedding_model_mismatch", summary: "model" }) } })
  const { session } = await makeSession(t, { runtime })
  const snapshot = await session.admission.refresh()
  assert.equal(snapshot.diagnostic.authority_verified, true)
})

test("an unwritable state directory is logged, never fatal", async (t) => {
  const base = await mkTempRoot("desk-session-unwritable-")
  const blocked = path.join(base, "file")
  writeFileSync(blocked, "not a directory")
  const runtime = fakeRuntime({
    connectOrStartController: async (options) => {
      options.onRepair({ action: "chmod_700", path: "/s", from: "755" })
      return { accepted: true }
    },
  })
  const { session, log } = await makeSession(t, { runtime, deskStateDir: path.join(blocked, "state") })
  assert.equal((await session.admission.refresh()).state, "ready")
  assert.match(log(), /could not append to the repair log/u)
  assert.match(log(), /could not record last-start\.json/u)
})

test("required semantic admission waits for the barrier, and a failed or incomplete barrier degrades with reads and writes still open", async (t) => {
  const barriers = [
    () => { throw new Error("embedding offline") },
    () => ({ capability: "semantic", current: false }),
    () => ({ capability: "semantic", current: true }),
  ]
  const controller = {
    accepted: true,
    beginConvergence: async () => {},
    barrier: async () => barriers.shift()(),
    status: async () => ({}),
  }
  const { session } = await makeSession(t, {
    runtime: fakeRuntime({ connectOrStartController: async () => controller }),
    resolveActivation: () => ({ activationStatus: null, readinessPolicy: { semantic: "required", lexical: "required", write_authority: "workspace", authority_provider: null }, stateBranch: null }),
  })
  const failed = await session.admission.refresh()
  assert.equal(failed.state, "degraded:semantic_unavailable")
  assert.deepEqual(failed.diagnostic.observed, { name: "Error", message: "embedding offline" })
  assert.equal(payload(await session.callTool({ name: "task_create" })).tool, "task_create", "writes stay open")
  const incomplete = await session.admission.refresh({ force: true })
  assert.deepEqual(incomplete.diagnostic.observed, { barrier: { capability: "semantic", current: false } })
  assert.equal((await session.admission.refresh({ force: true })).state, "ready")
  assert.equal((await session.admission.refresh({ force: true })).state, "ready", "a current semantic barrier is not re-checked")
})

test("background convergence failures are logged whatever is thrown", async (t) => {
  const { session, log } = await makeSession(t, {
    runtime: fakeRuntime({ beginBackgroundConvergence: () => { throw "busy" } }),
    resolveActivation: () => ({ activationStatus: null, readinessPolicy: { semantic: "background", lexical: "required", write_authority: "workspace", authority_provider: null }, stateBranch: null }),
  })
  await session.admission.refresh()
  await flush()
  assert.match(log(), /background convergence failed: busy/u)
  const second = await makeSession(t, {
    runtime: fakeRuntime({ beginBackgroundConvergence: () => { throw new Error("broken") } }),
    resolveActivation: () => ({ activationStatus: null, readinessPolicy: { semantic: "background", lexical: "required", write_authority: "workspace", authority_provider: null }, stateBranch: null }),
  })
  await second.session.admission.refresh()
  await flush()
  assert.match(second.log(), /background convergence failed: broken/u)
})

test("a lost controller is found by desk_status and before a write, and re-elected", async (t) => {
  let alive = true
  let connections = 0
  const runtime = fakeRuntime({
    connectOrStartController: async () => {
      connections += 1
      return { accepted: true, async status() { if (!alive) throw new Error("readiness controller connection closed: status") } }
    },
  })
  const { session } = await makeSession(t, { runtime })
  await session.admission.refresh()
  alive = false
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.state, "ready")
  assert.equal(connections, 2)
  alive = false
  const write = await session.callTool({ name: "task_create" })
  assert.equal(payload(write).tool, "task_create")
  assert.equal(connections, 3)
})

test("the ready check runs every 60 s and a controller without status() is never probed", async (t) => {
  const { session } = await makeSession(t, { runtime: fakeRuntime({ connectOrStartController: async () => ({ accepted: true }) }) })
  await session.admission.refresh()
  assert.equal(payload(await session.callTool({ name: "desk_status" })).state, "ready")
})

test("refusals name admitting, a live state-branch problem, or the controller", async (t) => {
  let release
  const hold = new Promise((resolve) => { release = resolve })
  const { session } = await makeSession(t, {
    loadRuntime: async () => { await hold; return { runtimeServer: fakeRuntime(), runtimeStatus: {} } },
  })
  session.start()
  const refusedWhileAdmitting = await Promise.race([
    session.callTool({ name: "desk_search" }),
    new Promise((resolve) => setTimeout(() => resolve(null), 50)),
  ])
  assert.equal(refusedWhileAdmitting, null, "a read waits for admission")
  release()
  assert.equal(payload(await session.callTool({ name: "desk_search" })).tool, "desk_search")
})

test("a read refused while admitting explains that Desk is still admitting", async (t) => {
  const timers = { setTimeout: (callback) => { setImmediate(callback); return 1 }, clearTimeout: () => {} }
  const { session } = await makeSession(t, {
    timers,
    loadRuntime: () => new Promise(() => {}),
  })
  const refused = payload(await session.callTool({ name: "desk_search" }))
  assert.equal(refused.code, "admitting")
  assert.match(refused.fix, /still admitting/u)
})

function scriptedGit(state) {
  return ({ args }) => {
    const key = args.join(" ")
    if (key.startsWith("rev-parse --show-toplevel")) return { ok: true, stdout: "/repo\n/repo/.git" }
    if (key.startsWith("symbolic-ref")) return state.branch ? { ok: true, stdout: state.branch } : { ok: false, stdout: "" }
    if (key.startsWith("rev-parse --verify --quiet HEAD")) return { ok: true, stdout: "abcdef1234567890" }
    if (key.startsWith("show-ref")) return { ok: true, stdout: "" }
    if (key.startsWith("status")) return { ok: true, stdout: state.dirty ? " M x" : "" }
    if (key.startsWith("rev-parse --verify --quiet @{upstream}")) return state.upstream ? { ok: true, stdout: state.upstream } : { ok: false, stdout: "" }
    if (key.startsWith("branch -r --contains")) return { ok: true, stdout: state.onRemote ? "origin/x" : "" }
    if (key.startsWith("switch")) {
      if (state.switchFails) return { ok: false, stdout: "", stderr: "untracked file would be overwritten" }
      state.branch = "main"
      state.switches = (state.switches ?? 0) + 1
      return { ok: true, stdout: "" }
    }
    return { ok: false, stdout: "" }
  }
}

function branchActivation(stateBranch = "main") {
  return () => ({ activationStatus: null, readinessPolicy: { semantic: "unsupported", lexical: "required", write_authority: "workspace", authority_provider: null }, stateBranch })
}

test("state branch: automatic repair, a failed switch, a local-only commit, and a doctor-only branch", async (t) => {
  const state = { branch: null, onRemote: true }
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const { session } = await makeSession(t, { git: scriptedGit(state), resolveActivation: branchActivation(), watch: () => watcher })
  const repaired = await session.admission.refresh()
  assert.equal(repaired.state, "ready")
  assert.equal(repaired.repair, "repaired: detached HEAD → main (was abcdef123456)")

  state.branch = null
  state.switchFails = true
  const failed = await session.admission.refresh({ force: true })
  assert.equal(failed.state, "degraded:state_branch_detached")
  assert.match(failed.fix, /git switch main failed/u)

  state.switchFails = false
  state.onRemote = false
  const localOnly = await session.admission.refresh({ force: true })
  assert.deepEqual(localOnly.blockers, ["local_only_commits"])
  const refused = payload(await session.callTool({ name: "task_create" }))
  assert.equal(refused.code, "state_branch_detached")
  assert.deepEqual(refused.blockers, ["local_only_commits"])

  state.branch = "review"
  state.onRemote = true
  const doctorOnly = await session.admission.refresh({ force: true })
  assert.equal(doctorOnly.state, "degraded:state_branch_mismatch")
  assert.match(doctorOnly.fix, /switch_state_branch/u)
  const doctored = payload(await session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } }))
  assert.equal(doctored.status, "ok")
  assert.match(doctored.repair, /^repaired: branch review → main/u)
  assert.equal(doctored.state, "ready")
  const again = payload(await session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } }))
  assert.equal(again.summary, "Already on the state branch main.")
})

test("desk_doctor refuses switch_state_branch without a state branch, when unsafe, or when git refuses", async (t) => {
  const noBranch = await makeSession(t)
  await noBranch.session.admission.refresh()
  const refused = await noBranch.session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } })
  assert.equal(refused.isError, true)
  assert.equal(payload(refused).reason, "no_state_branch")

  const state = { branch: "feature", onRemote: false }
  const unsafe = await makeSession(t, { git: scriptedGit(state), resolveActivation: branchActivation(), watch: () => Object.assign(new EventEmitter(), { close() {} }) })
  await unsafe.session.admission.refresh()
  const blocked = payload(await unsafe.session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } }))
  assert.equal(blocked.status, "refused")
  assert.deepEqual(blocked.blockers, ["local_only_commits"])
  state.onRemote = true
  state.switchFails = true
  const gitRefused = payload(await unsafe.session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } }))
  assert.equal(gitRefused.status, "refused")
  assert.match(gitRefused.fix, /untracked file would be overwritten/u)
})

test("a write re-checks the state branch live and refuses when HEAD moved since admission", async (t) => {
  const state = { branch: "main", onRemote: false }
  const { session } = await makeSession(t, { git: scriptedGit(state), resolveActivation: branchActivation(), watch: () => Object.assign(new EventEmitter(), { close() {} }) })
  assert.equal((await session.admission.refresh()).state, "ready")
  state.branch = null
  const refused = await session.callTool({ name: "task_create" })
  assert.equal(refused.isError, true)
  assert.equal(payload(refused).code, "state_branch_detached")
  state.branch = "main"
  assert.equal(payload(await session.callTool({ name: "task_create" })).tool, "task_create")
  // HEAD detached again, but safely: the write's re-check repairs it and the write goes through.
  state.branch = null
  state.onRemote = true
  assert.equal(payload(await session.callTool({ name: "task_create" })).tool, "task_create")
  assert.equal(state.switches, 1)
})

test("the .git/HEAD watch re-runs admission on HEAD changes only, is replaced per git dir, and survives a failed watch", async (t) => {
  const state = { branch: "main" }
  const watchers = []
  const watch = (dir, options, listener) => {
    const watcher = Object.assign(new EventEmitter(), { dir, options, listener, closed: false, close() { this.closed = true } })
    watchers.push(watcher)
    return watcher
  }
  const { session } = await makeSession(t, { git: scriptedGit(state), resolveActivation: branchActivation(), watch })
  await session.admission.refresh()
  assert.equal(watchers.length, 1)
  assert.equal(watchers[0].dir, "/repo/.git")
  assert.equal(watchers[0].options.persistent, false)
  watchers[0].emit("error", new Error("ignored"))
  const attempts = session.admission.snapshot().attempts
  watchers[0].listener("change", "index")
  watchers[0].listener("rename", "HEAD")
  watchers[0].listener("rename", "HEAD")
  watchers[0].listener("rename", null)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(session.admission.snapshot().attempts, attempts + 1, "debounced to one attempt")

  const failing = await makeSession(t, { git: scriptedGit({ branch: "main" }), resolveActivation: branchActivation(), watch: () => { throw new Error("EMFILE") } })
  await failing.session.admission.refresh()
  assert.match(failing.log(), /could not watch \/repo\/\.git for HEAD changes: EMFILE/u)
  // A HEAD change still waiting for its debounce is dropped on dispose.
  watchers[0].listener("rename", "HEAD")
  session.dispose()
  assert.equal(watchers[0].closed, true)
})

test("a root outside Git drops the HEAD watch", async (t) => {
  const state = { branch: "main" }
  let git = scriptedGit(state)
  const watchers = []
  const { session } = await makeSession(t, {
    git: (options) => git(options),
    resolveActivation: branchActivation(),
    watch: (dir) => { const watcher = { dir, close() { watcher.closed = true }, on() {} }; watchers.push(watcher); return watcher },
  })
  await session.admission.refresh()
  git = () => ({ ok: false, stdout: "" })
  await session.admission.refresh({ force: true })
  assert.equal(watchers[0].closed, true)
})

test("desk_doctor: formats, repairs, prune, and the full report in every mode", async (t) => {
  const { session, base } = await makeSession(t)
  const badFormat = await session.callTool({ name: "desk_doctor", input: { format: "xml" } })
  assert.equal(badFormat.isError, true)
  const badRepair = await session.callTool({ name: "desk_doctor", input: { repair: "rm_rf" } })
  assert.equal(badRepair.isError, true)
  assert.match(badRepair.content[0].text, /switch_state_branch, prune_readiness_state/u)
  assert.equal(payload(await session.callTool({ name: "desk_doctor", input: { format: "preview" } })).runtime_state, "diagnostic")
  const beforeAdmission = payload(await session.callTool({ name: "desk_doctor" }))
  assert.equal(beforeAdmission.state, "admitting")
  assert.equal(beforeAdmission.status, "admitting")
  assert.deepEqual(beforeAdmission.repairs_available, ["switch_state_branch", "prune_readiness_state"])
  await session.admission.refresh()
  assert.equal(payload(await session.callTool({ name: "desk_doctor", input: { format: "preview" } })).runtime_state, "ready")
  const full = payload(await session.callTool({ name: "desk_doctor" }))
  assert.equal(full.state, "ready")
  assert.equal(full.tool, "desk_doctor", "a ready doctor is the runtime's report")
  mkdirSync(path.join(base, "readiness", "a".repeat(64), "journal"), { recursive: true })
  writeFileSync(path.join(base, "readiness", "a".repeat(64), "journal", "journal.json"), JSON.stringify({ root: path.join(base, "gone") }))
  const pruned = payload(await session.callTool({ name: "desk_doctor", input: { repair: "prune_readiness_state" } }))
  assert.equal(pruned.pruned.length, 1)
  assert.match(pruned.summary, /pruned 1 leftover/u)
})

test("desk_doctor rethrows an unexpected validator failure instead of calling it an input error", async (t) => {
  const { session } = await makeSession(t)
  const input = {}
  Object.defineProperty(input, "format", { get() { throw new Error("getter broke") } })
  await assert.rejects(session.callTool({ name: "desk_doctor", input }), /getter broke/u)
})

test("desk_status keeps answering when the runtime's own status throws", async (t) => {
  const runtime = fakeRuntime()
  runtime.callTool = async () => { throw new Error("status exploded") }
  const { session } = await makeSession(t, { runtime })
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.state, "ready")
  assert.equal(status.status_error, "status exploded")
  runtime.callTool = async () => { throw "string" }
  assert.equal(payload(await session.callTool({ name: "desk_status" })).status_error, "string")
})

test("a runtime status keeps its own status value when ready", async (t) => {
  const runtime = fakeRuntime()
  runtime.callTool = async () => ({ content: [{ type: "text", text: JSON.stringify({ root: {} }) }] })
  const { session } = await makeSession(t, { runtime })
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.status, "ok")
  assert.equal(status.admission.writes, "available")
  assert.equal(status.admission.state_branch.kind, "not_configured")
})

test("a controller whose close fails is still forgotten", async (t) => {
  const { session } = await makeSession(t, { runtime: fakeRuntime({ connectOrStartController: async () => ({ accepted: true, close: async () => { throw new Error("already gone") } }) }) })
  await session.admission.refresh()
  session.dispose()
  await flush()
  assert.equal(session.context.admission, null)
})

test("dispose closes the controller and a disposed session answers with its last state", async (t) => {
  const closed = []
  const { session } = await makeSession(t, { runtime: fakeRuntime({ connectOrStartController: async () => ({ accepted: true, close: async () => closed.push(1) }) }) })
  await session.admission.refresh()
  session.dispose()
  await flush()
  assert.deepEqual(closed, [1])
  assert.equal(session.context.admission, null)
})

test("the default stderr and git are real", async (t) => {
  const base = await mkTempRoot("desk-session-defaults-")
  const session = createDeskSession({
    args: {},
    deskStateDir: path.join(base, "state"),
    readinessStateHome: path.join(base, "readiness"),
    resolveRoot: () => ({ root: base }),
    resolveActivation: () => { throw new Error("stop here") },
    loadRuntime: async () => assert.fail("not reached"),
  })
  t.after(() => session.dispose())
  const originalWrite = process.stderr.write
  const writes = []
  process.stderr.write = (text) => { writes.push(String(text)); return true }
  try {
    assert.equal((await session.admission.refresh()).state, "degraded:activation_config_invalid")
  } finally {
    process.stderr.write = originalWrite
  }
  assert.match(writes.join(""), /\[desk-mcp\] state: degraded:activation_config_invalid/u)
})
