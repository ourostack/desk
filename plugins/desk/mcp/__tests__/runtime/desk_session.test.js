// The session behind the front door, driven directly with fake inputs, runtimes, git, watchers and controller probes: every admission outcome, every gate and every desk_doctor repair.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { ActivationFailure } from "../../src/activation/failures.js"
import { createDeskSession, requirementMet, toolRequirement } from "../../src/runtime/desk-session.js"
import { lastStartRootKey } from "../../src/runtime/last-start.js"
import { mkTempRoot } from "../_temp_roots.js"

const flush = () => new Promise((resolve) => setImmediate(resolve))
async function waitUntil(predicate) {
  for (let tries = 0; !predicate(); tries += 1) {
    if (tries > 500) throw new Error("condition not reached")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const payload = (result) => JSON.parse(result.content[0].text)
const unsupported = { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" }

function fakeRuntime(overrides = {}) {
  const calls = []
  return {
    calls,
    callTool: async ({ name, input, person, statusContext }) => {
      calls.push({ name, input, person, admission: statusContext.admission })
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", tool: name, person }) }] }
    },
    connectOrStartController: async () => ({ accepted: true, async status() { return { state: "READY" } } }),
    ...overrides,
  }
}

function inputs({ root, policy = unsupported, stateBranch = null, activationStatus = null } = {}) {
  return { root: { root, source: "explicit-root" }, activation: { activationStatus, readinessPolicy: policy, stateBranch } }
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
    resolveInputs: async () => inputs({ root, ...(overrides.inputs ?? {}) }),
    loadRuntime: async () => ({ runtimeServer: runtime, runtimeStatus: { state: "ready" } }),
    setupDiagnostic: (error) => ({ status: "setup_required", mode: "setup", summary: "no desk", remediation: [{ action: "run_first_run_bootstrap", message: "bootstrap" }], paths_tried: error.tried }),
    hung: { probe: async () => ({ state: "refused" }) },
    ...overrides,
  })
  t.after(() => session.dispose())
  return { session, base, root, lines, runtime, log: () => lines.join("") }
}

test("tool requirements: status, doctor, reads, authority, controller and writes", () => {
  assert.equal(toolRequirement("desk_status"), "status")
  assert.equal(toolRequirement("desk_doctor"), "doctor")
  for (const name of ["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread"]) assert.equal(toolRequirement(name), "read")
  assert.equal(toolRequirement("desk_work_ledger"), "authority")
  assert.equal(toolRequirement("desk_reindex"), "controller")
  for (const name of ["task_create", "track_rename", "friction_add", "lesson_add"]) assert.equal(toolRequirement(name), "write")
  const readable = { runtimeServer: {}, root: {} }
  assert.equal(requirementMet("read", {}), false)
  assert.equal(requirementMet("read", readable), true)
  assert.equal(requirementMet("controller", readable), false)
  assert.equal(requirementMet("controller", { ...readable, admission: { controller: {} } }), true)
  assert.equal(requirementMet("authority", readable), false)
  assert.equal(requirementMet("authority", { ...readable, authorityAdmitted: true }), true)
  assert.equal(requirementMet("write", { ...readable, authorityAdmitted: true }), true, "writes never need the controller")
  assert.equal(requirementMet("write", { ...readable, authorityAdmitted: true, stateBranch: { ok: false } }), false)
  assert.equal(requirementMet("write", { ...readable, authorityAdmitted: true, launcher: { blocksWrites: true } }), false)
  assert.equal(requirementMet("read", { ...readable, launcher: { mode: "refuse" } }), false)
})

test("unknown tools are refused; reads, the ledger and journaled writes dispatch to the runtime once admitted", async (t) => {
  const { session, runtime } = await makeSession(t)
  assert.equal((await session.callTool({ name: "nope" })).isError, true)
  assert.equal(payload(await session.callTool({ name: "desk_search", input: { query: "x" } })).tool, "desk_search")
  assert.equal(payload(await session.callTool({ name: "desk_work_ledger" })).tool, "desk_work_ledger")
  assert.equal(payload(await session.callTool({ name: "desk_reindex" })).tool, "desk_reindex")
  assert.equal(payload(await session.callTool({ name: "task_create" })).tool, "task_create")
  assert.deepEqual(runtime.calls.map((call) => call.name), ["desk_search", "desk_work_ledger", "desk_reindex", "task_create"])
  assert.deepEqual(runtime.calls[3].input, {})
  assert.equal(typeof runtime.calls[3].admission.controller.status, "function", "a healthy controller journals the write")
  assert.equal(session.admission.snapshot().state, "ready")
})

test("setup, missing roots and activation errors are named degraded states, from Error objects or the worker's plain errors", async (t) => {
  let result
  const { session, root } = await makeSession(t, { resolveInputs: async () => result })
  const cases = [
    [{ rootError: { name: "Error", message: "no desk", code: "DESK_ROOT_NOT_FOUND", tried: [{ source: "fallback:desk" }] } }, "degraded:no_desk_root", /bootstrap/u],
    [{ rootError: { name: "Error", message: "bad config", code: "ACTIVATION_CONFIG_INVALID" } }, "degraded:activation_config_invalid", /activation config/u],
    [{ rootError: Object.assign(new Error("--root path does not exist: /x"), { code: "DESK_ROOT_UNAVAILABLE", path: "/x" }) }, "degraded:root_unavailable", /at \/x/u],
    [{ rootError: "a thrown string" }, "degraded:root_unavailable", /at the desk root/u],
    [{ root: { root }, activationError: { name: "ActivationFailure", message: "bad policy", code: "activation_policy_invalid", status: "terminal", phase: "VERIFYING" } }, "degraded:activation_policy_invalid", /desk_runtime policy/u],
  ]
  for (const [value, state, fix] of cases) {
    result = value
    const snapshot = await session.admission.refresh({ force: true })
    assert.equal(snapshot.state, state)
    assert.match(snapshot.fix, fix)
  }
  assert.equal(session.admission.snapshot().diagnostic.observed.failure.phase, "VERIFYING")
  assert.equal(payload(await session.callTool({ name: "desk_status" })).status, "degraded")
  result = cases[0][0]
  const setup = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(setup.status, "setup_required")
  assert.equal(setup.mode, "setup")
  result = cases[3][0]
  assert.equal((await session.admission.refresh({ force: true })).diagnostic.observed.name, "unknown")
})

test("a changed policy or root drops the old authority and controller", async (t) => {
  let policy = unsupported
  let rootName = "a"
  const closed = []
  const runtime = fakeRuntime({ connectOrStartController: async () => ({ accepted: true, close: async () => closed.push("closed") }) })
  const { session, base } = await makeSession(t, { runtime, resolveInputs: async () => inputs({ root: path.join(base, rootName), policy }) })
  assert.equal((await session.admission.refresh()).state, "ready")
  policy = { ...unsupported, semantic: "background" }
  await session.admission.refresh({ force: true })
  await flush()
  assert.deepEqual(closed, ["closed"])
  rootName = "b"
  await session.admission.refresh({ force: true })
  await flush()
  assert.deepEqual(closed, ["closed", "closed"])
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
  assert.equal(payload(await session.callTool({ name: "desk_search" })).tool, "desk_search", "the gate retried admission, which now loads the runtime")
  await session.admission.refresh({ force: true })
  assert.equal(loads, 2)
})

test("authority failures refuse writes; a controller failure keeps authority, so writes go straight to the files", async (t) => {
  const personPolicy = await makeSession(t, { inputs: { policy: { ...unsupported, write_authority: "person" } } })
  const refused = await personPolicy.session.admission.refresh()
  assert.equal(refused.code, "authority_invalid")
  assert.equal(requirementMet("write", personPolicy.session.context), false)
  assert.equal(requirementMet("read", personPolicy.session.context), true)
  assert.match(refused.fix, /reconnect the Desk MCP server/u, "a --person fix says it needs a reconnect")
  const cases = [
    [Object.assign(new Error("different contract"), { code: "controller_semantic_mismatch", diagnostic: { expected: 1 } }), "controller_semantic_mismatch", true],
    [new Error("readiness controller has unsafe directory ownership or permissions"), "controller_state_unsafe", true],
    [new Error("readiness controller election did not converge"), "controller_unavailable", true],
    [Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), "controller_unavailable", true],
    [new RangeError("something else"), "admission_exception", true],
  ]
  let thrown
  const runtime = fakeRuntime({ connectOrStartController: async () => { throw thrown } })
  const { session } = await makeSession(t, { runtime })
  for (const [error, code, writable] of cases) {
    thrown = error
    session.context.authorityAdmitted = false
    const snapshot = await session.admission.refresh({ force: true })
    assert.equal(snapshot.code, code, error.message)
    assert.equal(requirementMet("write", session.context), writable, code)
  }
  const write = await session.callTool({ name: "task_create" })
  assert.equal(payload(write).tool, "task_create")
  assert.equal(runtime.calls.at(-1).admission, undefined, "without a controller the write is not journaled")
  assert.match(session.admission.snapshot().fix, /something else|retries admission/u)
  thrown = cases[0][0]
  session.context.authorityAdmitted = false
  assert.deepEqual((await session.admission.refresh({ force: true })).diagnostic.observed.diagnostic, { expected: 1 })
})

test("an admission implementation that fails before verifying authority, or that returns contradicting authority, admits nothing", async (t) => {
  const failing = await makeSession(t, { runtime: fakeRuntime({ admitControlPlane: async () => { throw new Error("readiness controller election did not converge") } }) })
  assert.equal((await failing.session.admission.refresh()).code, "controller_unavailable")
  assert.equal(failing.session.context.authorityAdmitted, false)
  const closed = []
  const contradicting = await makeSession(t, {
    args: { person: "ari" },
    runtime: fakeRuntime({ admitControlPlane: async () => ({ authority: { mode: "workspace" }, controller: { close: async () => closed.push(1) } }) }),
  })
  assert.equal((await contradicting.session.admission.refresh()).code, "authority_invalid")
  assert.equal(contradicting.session.context.admission, null)
  const verifiedThenFailed = await makeSession(t, {
    runtime: fakeRuntime({
      admitControlPlane: async ({ verifyAuthority, policy }) => {
        await verifyAuthority({ policy })
        throw Object.assign(new Error("no connector"), { code: "controller_start_failed" })
      },
    }),
  })
  assert.equal((await verifiedThenFailed.session.admission.refresh()).code, "controller_unavailable")
  assert.equal(verifiedThenFailed.session.context.authorityAdmitted, true)
})

test("a lost controller is reconnected on the next attempt, and a reconnect that is not accepted stays degraded", async (t) => {
  let accept = true
  let connections = 0
  const runtime = fakeRuntime({
    connectOrStartController: async () => {
      connections += 1
      return accept ? { accepted: true, async status() {} } : accept === null ? null : { accepted: false }
    },
  })
  const { session } = await makeSession(t, { runtime, inputs: { policy: { ...unsupported, semantic: "background" } } })
  await session.admission.refresh()
  session.context.controllerLost = true
  accept = false
  assert.equal((await session.admission.refresh({ force: true })).code, "controller_unavailable")
  accept = null
  assert.equal((await session.admission.refresh({ force: true })).code, "controller_unavailable")
  accept = true
  assert.equal((await session.admission.refresh({ force: true })).state, "ready")
  assert.equal(connections, 4)
})

test("a hung controller is counted across attempts and marked controller_hung after 3 misses; nothing is stopped and writes keep working", async (t) => {
  const probes = []
  const runtime = fakeRuntime({ connectOrStartController: async () => { throw new Error("readiness controller election did not converge") } })
  const { session } = await makeSession(t, {
    runtime,
    hung: {
      probeMs: 7,
      probe: async (options) => {
        probes.push(options.timeoutMs)
        return { state: "silent", endpoint: "/tmp/x.sock", record: { owner: { pid: 4242 } } }
      },
    },
  })
  const first = await session.admission.refresh()
  assert.equal(first.state, "degraded:controller_unavailable")
  assert.match(first.summary, /owner pid 4242, \/tmp\/x\.sock.*1 of 3 checks missed/u)
  assert.equal(first.fix, "Nothing to do: search uses plain text (lexical search and timeline read the files directly) and writes work (they go straight to the files). The controller recovers when it answers again or when its owning session (pid 4242) ends; Desk keeps checking in the background.")
  assert.equal(requirementMet("write", session.context), true)
  await session.admission.refresh({ force: true })
  const hung = await session.admission.refresh({ force: true })
  assert.equal(hung.state, "degraded:controller_hung")
  assert.match(hung.summary, /3 of 3 checks missed; hung/u)
  assert.equal(hung.fix, first.fix)
  assert.doesNotMatch(hung.fix, /task|A2b/u, "no internal task names in text the agent reads")
  assert.equal(hung.repair, null, "nothing was reclaimed")
  assert.deepEqual(probes, [7, 7, 7])
  assert.equal(requirementMet("write", session.context), true, "writes keep working while the controller is hung")
  assert.equal(payload(await session.callTool({ name: "task_create" })).tool, "task_create")
  assert.equal(runtime.calls.at(-1).admission, undefined, "the write went straight to the file")
  await session.admission.refresh({ force: true })
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.admission.hung_controller.owner_pid, 4242)
  assert.ok(status.admission.hung_controller.misses >= 4)
  assert.match(status.summary ?? status.admission.summary, /3 of 3 checks missed; hung/u)
})

test("a running owner that refuses connections counts as a miss, and a controller that answers the probe resets the count", async (t) => {
  const states = ["unreachable", "silent", "answering", "refused"]
  const { session } = await makeSession(t, {
    runtime: fakeRuntime({ connectOrStartController: async () => { throw new Error("readiness controller election did not converge") } }),
    hung: { probe: async () => ({ state: states.shift() ?? "missing", endpoint: "/tmp/x", record: null }) },
  })
  await session.admission.refresh()
  assert.equal(session.context.hung.misses, 1)
  assert.match(session.admission.snapshot().summary, /pid null, \/tmp\/x\) does not accept connections while its owner runs \(1 of 3/u)
  await session.admission.refresh({ force: true })
  assert.equal(session.context.hung.misses, 2)
  assert.match(session.admission.snapshot().summary, /accepts connections but does not answer \(2 of 3/u)
  await session.admission.refresh({ force: true })
  assert.equal(session.context.hung.misses, 0)
  await session.admission.refresh({ force: true })
  assert.equal(session.context.hung.misses, 0, "a refused socket whose owner is gone is not a miss")
})

test("desk_doctor reclaim_controller reports the owner and reclaims nothing", async (t) => {
  const answers = []
  const probe = async () => ({ state: answers.shift() ?? "silent", endpoint: "/tmp/x.sock", record: { owner: { pid: 7 } } })
  const noRoot = await makeSession(t, { resolveInputs: async () => ({ rootError: { name: "Error", message: "gone", code: "DESK_ROOT_UNAVAILABLE" } }) })
  await noRoot.session.admission.refresh()
  const refused = await noRoot.session.callTool({ name: "desk_doctor", input: { repair: "reclaim_controller" } })
  assert.equal(refused.isError, true)
  assert.equal(payload(refused).reason, "not_admitted")

  const { session } = await makeSession(t, { hung: { probe } })
  await session.admission.refresh()
  const hung = await session.callTool({ name: "desk_doctor", input: { repair: "reclaim_controller" } })
  assert.equal(hung.isError, undefined)
  const report = payload(hung)
  assert.equal(report.status, "report")
  assert.equal(report.reclaimed, false)
  assert.equal(report.controller.owner_pid, 7)
  assert.match(report.summary, /accepts connections but does not answer\. Desk does not stop it or replace it/u)
  assert.match(report.fix, /^Nothing to do: search uses plain text/u)
  assert.doesNotMatch(report.fix, /task|A2b/u)
  answers.push("unreachable")
  const unreachable = payload(await session.callTool({ name: "desk_doctor", input: { repair: "reclaim_controller" } }))
  assert.match(unreachable.summary, /does not accept connections while its owner runs\. Desk does not stop it/u)
  answers.push("answering")
  const healthy = payload(await session.callTool({ name: "desk_doctor", input: { repair: "reclaim_controller" } }))
  assert.equal(healthy.reclaimed, false)
  assert.match(healthy.summary, /not hung \(probe: answering\)/u)
  assert.equal(healthy.fix, "Call desk_status.")
})

test("an embedding override degrades semantic search only: lexical reads, writes and ready stay available", async (t) => {
  const override = { code: "embedding_override", model: "other", pinned_model: "nomic-embed-text", fix: "remove the override and reconnect" }
  const controller = { accepted: true, embeddingOverride: override, identity: { id: "c", semantic_contract: { mode: "background" } }, async status() {} }
  const runtime = fakeRuntime({ connectOrStartController: async () => controller })
  const { session } = await makeSession(t, { runtime, inputs: { policy: { ...unsupported, semantic: "background" } } })
  assert.equal((await session.admission.refresh()).state, "ready")
  await session.callTool({ name: "desk_search", input: { query: "x" } })
  const view = runtime.calls.at(-1).admission.controller
  assert.equal(view.identity.semantic_contract.mode, "unsupported", "searches get a lexical-only view of the controller")
  await session.callTool({ name: "desk_timeline" })
  assert.equal(runtime.calls.at(-1).admission.controller, view, "the view is cached per controller")
  const recall = await session.callTool({ name: "desk_recall", input: { topic: "x" } })
  assert.equal(recall.isError, true)
  assert.equal(payload(recall).code, "embedding_override")
  assert.equal(payload(await session.callTool({ name: "task_create" })).tool, "task_create")
  runtime.callTool = async () => ({ content: [{ type: "text", text: JSON.stringify({ status: "ok", semantic: { current: true } }) }] })
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.state, "ready")
  assert.equal(status.semantic.status, "unavailable (embedding_override)")
  assert.equal(status.semantic.current, false)

  const required = await makeSession(t, { runtime: fakeRuntime({ connectOrStartController: async () => controller }), inputs: { policy: { ...unsupported, semantic: "required" } } })
  const snapshot = await required.session.admission.refresh()
  assert.equal(snapshot.state, "degraded:embedding_override")
  assert.equal(requirementMet("write", required.session.context), true)
})

test("required semantic admission waits for the barrier, and a failed or incomplete barrier degrades with reads and writes still open", async (t) => {
  const barriers = [
    () => { throw new Error("embedding offline") },
    () => ({ capability: "semantic", current: false }),
    () => ({ capability: "semantic", current: true }),
  ]
  const controller = { accepted: true, beginConvergence: async () => {}, barrier: async () => barriers.shift()(), status: async () => ({}) }
  const { session } = await makeSession(t, {
    runtime: fakeRuntime({ connectOrStartController: async () => controller }),
    inputs: { policy: { ...unsupported, semantic: "required" } },
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
  for (const [thrown, text] of [["busy", "busy"], [new Error("broken"), "broken"]]) {
    const { session, log } = await makeSession(t, {
      runtime: fakeRuntime({ beginBackgroundConvergence: () => { throw thrown } }),
      inputs: { policy: { ...unsupported, semantic: "background" } },
    })
    await session.admission.refresh()
    await flush()
    assert.match(log(), new RegExp(`background convergence failed: ${text}`, "u"))
  }
})

test("a lost controller is found by desk_status in the background, and a write falls back to the file", async (t) => {
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
  await session.callTool({ name: "desk_status" })
  await flush()
  await flush()
  assert.equal(connections, 2, "the background check re-elected at once")
  alive = false
  const write = await session.callTool({ name: "task_create" })
  assert.equal(payload(write).tool, "task_create")
  assert.equal(runtime.calls.at(-1).admission, undefined, "the write went straight to the file")
  assert.equal(session.admission.snapshot().code, "controller_unavailable")
})

test("refusals while admitting explain that Desk is still admitting", async (t) => {
  const timers = { setTimeout: (callback) => { setImmediate(callback); return 1 }, clearTimeout: () => {} }
  const { session } = await makeSession(t, { timers, loadRuntime: () => new Promise(() => {}) })
  const refused = payload(await session.callTool({ name: "desk_search" }))
  assert.equal(refused.code, "admitting")
  assert.match(refused.fix, /still admitting/u)
})

test("a tool that throws answers a structured degraded result", async (t) => {
  const runtime = fakeRuntime()
  const { session, log } = await makeSession(t, { runtime })
  await session.admission.refresh()
  runtime.callTool = async () => { throw new TypeError("tool broke") }
  const result = await session.callTool({ name: "desk_search" })
  assert.equal(result.isError, true)
  assert.deepEqual([payload(result).status, payload(result).code, payload(result).observed.name], ["degraded", "tool_exception", "TypeError"])
  assert.match(payload(result).summary, /failed unexpectedly/u)
  runtime.callTool = async () => { throw "not an error" }
  assert.equal(payload(await session.callTool({ name: "desk_search" })).observed.name, "unknown")
  assert.match(log(), /desk_search failed: tool broke/u)
})

test("recordException degrades to runtime_exception, keeps serving and re-admits on the backoff", async (t) => {
  const { session } = await makeSession(t)
  await session.admission.refresh()
  const snapshot = session.recordException("uncaught_exception", new Error("boom after ready"))
  assert.equal(snapshot.state, "degraded:runtime_exception")
  assert.match(snapshot.fix, /no restart is needed/u)
  session.recordException("unhandled_rejection", "rejected value")
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.deepEqual(status.admission.exceptions.map((entry) => entry.message), ["boom after ready", "rejected value"])
  assert.equal(status.state, "ready", "desk_status retried admission")
  for (let index = 0; index < 6; index += 1) session.recordException("uncaught_exception", new Error(`e${index}`))
  assert.equal(session.context.exceptions.length, 5)
})

function scriptedGit(state) {
  return ({ args }) => {
    const key = args.join(" ")
    if (key.startsWith("rev-parse --show-toplevel")) return { ok: true, stdout: "/repo\n/repo/.git" }
    if (key.startsWith("symbolic-ref")) return state.branch ? { ok: true, stdout: state.branch } : { ok: false, stdout: "" }
    if (key.startsWith("rev-parse --verify --quiet HEAD")) return { ok: true, stdout: "abcdef1234567890" }
    if (key.startsWith("show-ref")) return { ok: true, stdout: "" }
    if (key.startsWith("status")) return { ok: true, stdout: "" }
    if (key.startsWith("rev-parse --verify --quiet @{upstream}")) return state.upstream ? { ok: true, stdout: "abcdef1234567890" } : { ok: false, stdout: "" }
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

const quietWatch = () => Object.assign(new EventEmitter(), { close() {} })

test("state branch at startup: automatic repair, a failed switch, a local-only commit, and a doctor-only branch", async (t) => {
  const state = { branch: null, onRemote: true }
  const repaired = await makeSession(t, { git: scriptedGit(state), inputs: { stateBranch: "main" }, watch: quietWatch })
  const ready = await repaired.session.admission.refresh()
  assert.equal(ready.state, "ready")
  assert.equal(ready.repair, "repaired: detached HEAD → main (was abcdef123456)")

  const failState = { branch: null, onRemote: true, switchFails: true }
  const failing = await makeSession(t, { git: scriptedGit(failState), inputs: { stateBranch: "main" }, watch: quietWatch })
  const failed = await failing.session.admission.refresh()
  assert.equal(failed.state, "degraded:state_branch_detached")
  assert.match(failed.fix, /did not run cleanly/u)

  const localState = { branch: null, onRemote: false }
  const local = await makeSession(t, { git: scriptedGit(localState), inputs: { stateBranch: "main" }, watch: quietWatch })
  const localOnly = await local.session.admission.refresh()
  assert.deepEqual(localOnly.blockers, ["local_only_commits"])
  assert.match(localOnly.fix, /then call desk_doctor with \{"repair":"switch_state_branch"\}/u, "only the first attempt switches on its own, so the fix names the doctor repair")
  const refused = payload(await local.session.callTool({ name: "task_create" }))
  assert.equal(refused.code, "state_branch_detached")
  assert.deepEqual(refused.blockers, ["local_only_commits"])
  localState.onRemote = true
  assert.equal((await local.session.admission.refresh({ force: true })).state, "degraded:state_branch_detached", "after the first attempt, a pushed commit is not switched back on its own")
  assert.equal(localState.switches, undefined)
  const rescued = payload(await local.session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } }))
  assert.equal(rescued.state, "ready")

  const reviewState = { branch: "review", onRemote: true }
  const review = await makeSession(t, { git: scriptedGit(reviewState), inputs: { stateBranch: "main" }, watch: quietWatch })
  const doctorOnly = await review.session.admission.refresh()
  assert.equal(doctorOnly.state, "degraded:state_branch_mismatch")
  assert.match(doctorOnly.fix, /switch_state_branch/u)
  const doctored = payload(await review.session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } }))
  assert.equal(doctored.status, "ok")
  assert.match(doctored.repair, /^repaired: branch review → main/u)
  assert.equal(doctored.state, "ready")
  const again = payload(await review.session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } }))
  assert.equal(again.summary, "Already on the state branch main.")
})

test("mid-session, HEAD leaving the state branch is never switched back automatically: writes go read-only with the doctor fix", async (t) => {
  const state = { branch: "main", onRemote: true, upstream: true }
  const { session } = await makeSession(t, { git: scriptedGit(state), inputs: { stateBranch: "main" }, watch: quietWatch })
  assert.equal((await session.admission.refresh()).state, "ready")
  // A person switches to a clean branch equal to its upstream: at startup this would be switched back.
  state.branch = "feature"
  const refused = await session.callTool({ name: "task_create" })
  assert.equal(refused.isError, true)
  assert.equal(payload(refused).code, "state_branch_mismatch")
  assert.match(payload(refused).fix, /never switches it back on its own mid-session/u)
  const degraded = await session.admission.refresh({ force: true })
  assert.equal(degraded.state, "degraded:state_branch_mismatch")
  assert.equal(state.branch, "feature", "Desk did not switch")
  assert.equal(state.switches, undefined)
  state.onRemote = false
  state.upstream = false
  assert.match((await session.admission.refresh({ force: true })).fix, /then call desk_doctor/u)
  state.branch = "main"
  assert.equal((await session.admission.refresh({ force: true })).state, "ready")
})

test("desk_doctor refuses switch_state_branch without a state branch, when unsafe, when git refuses or HEAD moves", async (t) => {
  const noBranch = await makeSession(t)
  await noBranch.session.admission.refresh()
  const refused = await noBranch.session.callTool({ name: "desk_doctor", input: { repair: "switch_state_branch" } })
  assert.equal(refused.isError, true)
  assert.equal(payload(refused).reason, "no_state_branch")

  const state = { branch: "feature", onRemote: false }
  const unsafe = await makeSession(t, { git: scriptedGit(state), inputs: { stateBranch: "main" }, watch: quietWatch })
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

test("the .git/HEAD watch re-runs admission on HEAD changes only, never switches, and a failed watcher is re-created", async (t) => {
  const state = { branch: "main", onRemote: true }
  const watchers = []
  const watch = (dir, options, listener) => {
    const watcher = Object.assign(new EventEmitter(), { dir, options, listener, closed: false, close() { this.closed = true } })
    watchers.push(watcher)
    return watcher
  }
  const { session, log } = await makeSession(t, { git: scriptedGit(state), inputs: { stateBranch: "main" }, watch })
  await session.admission.refresh()
  assert.equal(watchers.length, 1)
  assert.equal(watchers[0].dir, "/repo/.git")
  assert.equal(watchers[0].options.persistent, false)
  const attempts = session.admission.snapshot().attempts
  state.branch = null
  watchers[0].listener("change", "index")
  watchers[0].listener("rename", null)
  watchers[0].listener("rename", "HEAD")
  watchers[0].listener("rename", "HEAD")
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(session.admission.snapshot().attempts, attempts + 1, "debounced to one attempt")
  assert.equal(session.admission.snapshot().state, "degraded:state_branch_detached")
  assert.equal(state.switches, undefined, "a watched HEAD change never switches")

  watchers[0].emit("error", new Error("watch died"))
  assert.equal(watchers[0].closed, true)
  assert.match(log(), /HEAD watch on \/repo\/\.git failed \(watch died\)/u)
  await session.admission.refresh({ force: true })
  assert.equal(watchers.length, 2, "the next attempt re-created the watcher")
  watchers[0].emit("error", "late error from the old watcher")
  assert.equal(watchers[1].closed, false)

  const failing = await makeSession(t, { git: scriptedGit({ branch: "main" }), inputs: { stateBranch: "main" }, watch: () => { throw new Error("EMFILE") } })
  await failing.session.admission.refresh()
  assert.match(failing.log(), /could not watch \/repo\/\.git for HEAD changes: EMFILE/u)
  watchers[1].listener("rename", "HEAD")
  session.dispose()
  assert.equal(watchers[1].closed, true)
})

test("a root outside Git drops the HEAD watch", async (t) => {
  let git = scriptedGit({ branch: "main" })
  const watchers = []
  const { session } = await makeSession(t, {
    git: (options) => git(options),
    inputs: { stateBranch: "main" },
    watch: (dir) => { const watcher = { dir, close() { watcher.closed = true }, on() {} }; watchers.push(watcher); return watcher },
  })
  await session.admission.refresh()
  git = () => ({ ok: false, stdout: "" })
  await session.admission.refresh({ force: true })
  assert.equal(watchers[0].closed, true)
})

test("a launcher in refuse mode admits nothing and refuses every data tool", async (t) => {
  let resolved = 0
  const { session } = await makeSession(t, {
    launcher: { code: "lifecycle_conflict", reason: "two providers claim worker", mode: "refuse", blocksWrites: true },
    resolveInputs: async () => { resolved += 1; return {} },
  })
  const snapshot = await session.admission.refresh()
  assert.equal(snapshot.state, "degraded:lifecycle_conflict")
  assert.match(snapshot.fix, /reconnect the Desk MCP server/u)
  assert.equal(resolved, 0)
  const read = payload(await session.callTool({ name: "desk_search" }))
  assert.equal(read.code, "lifecycle_conflict")
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.mode, "refused")
  assert.deepEqual(status.admission.launcher, { code: "lifecycle_conflict", reason: "two providers claim worker", mode: "refuse" })
  const doctor = payload(await session.callTool({ name: "desk_doctor" }))
  assert.equal(doctor.state, "degraded:lifecycle_conflict")
})

test("a launcher in read-only mode serves reads and refuses writes with its code", async (t) => {
  const { session } = await makeSession(t, { launcher: { code: "identity_unavailable", reason: "gh is not signed in", mode: "read_only", blocksWrites: true } })
  const snapshot = await session.admission.refresh()
  assert.equal(snapshot.state, "degraded:identity_unavailable")
  assert.equal(payload(await session.callTool({ name: "desk_search" })).tool, "desk_search")
  const write = payload(await session.callTool({ name: "task_create" }))
  assert.equal(write.code, "identity_unavailable")
  assert.match(write.fix, /gh is not signed in/u)
  const handedOff = await makeSession(t, { launcher: { code: "crew_state_unavailable", reason: "detached", mode: "read_only", blocksWrites: false } })
  assert.equal((await handedOff.session.admission.refresh()).state, "ready")
})

test("desk_doctor: formats, repairs, prune, and the full report in every mode", async (t) => {
  const { session, base } = await makeSession(t)
  const badFormat = await session.callTool({ name: "desk_doctor", input: { format: "xml" } })
  assert.equal(badFormat.isError, true)
  const badRepair = await session.callTool({ name: "desk_doctor", input: { repair: "rm_rf" } })
  assert.equal(badRepair.isError, true)
  assert.match(badRepair.content[0].text, /switch_state_branch, reclaim_controller, prune_readiness_state/u)
  assert.equal(payload(await session.callTool({ name: "desk_doctor", input: { format: "preview" } })).runtime_state, "diagnostic")
  const beforeAdmission = payload(await session.callTool({ name: "desk_doctor" }))
  assert.equal(beforeAdmission.state, "admitting")
  assert.equal(beforeAdmission.status, "admitting")
  assert.deepEqual(beforeAdmission.repairs_available, ["switch_state_branch", "reclaim_controller", "prune_readiness_state"])
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

test("desk_doctor reports an unexpected validator failure as a tool exception, not an input error", async (t) => {
  const { session } = await makeSession(t)
  const input = {}
  Object.defineProperty(input, "format", { get() { throw new Error("getter broke") } })
  const result = payload(await session.callTool({ name: "desk_doctor", input }))
  assert.equal(result.code, "tool_exception")
  assert.equal(result.observed.message, "getter broke")
})

test("desk_status answers at once: a slow or failing runtime status never holds it up", async (t) => {
  const runtime = fakeRuntime()
  const { session } = await makeSession(t, { runtime })
  await session.admission.refresh()
  runtime.callTool = async () => { throw new Error("status exploded") }
  assert.equal(payload(await session.callTool({ name: "desk_status" })).status_error, "status exploded")
  runtime.callTool = async () => { throw "string" }
  assert.equal(payload(await session.callTool({ name: "desk_status" })).status_error, "string")
  runtime.callTool = () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: "text", text: "{}" }] }), 1000))
  const started = Date.now()
  const slow = payload(await session.callTool({ name: "desk_status" }))
  assert.ok(Date.now() - started < 400, `desk_status took ${Date.now() - started} ms`)
  assert.match(slow.status_detail, /^unavailable: .*did not answer in time/u)
  assert.equal(slow.state, "ready")
  // Once a detail has arrived, a late one is replaced by the last, marked cached.
  runtime.callTool = async () => ({ content: [{ type: "text", text: JSON.stringify({ status: "ok", local_db: { state: "fresh" } }) }] })
  assert.equal(payload(await session.callTool({ name: "desk_status" })).local_db.state, "fresh")
  runtime.callTool = () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: "text", text: "{}" }] }), 1000))
  const cachedStarted = Date.now()
  const cached = payload(await session.callTool({ name: "desk_status" }))
  assert.ok(Date.now() - cachedStarted < 200, `desk_status took ${Date.now() - cachedStarted} ms`)
  assert.equal(cached.local_db.state, "fresh")
  assert.match(cached.status_detail, /^cached: .*this detail is from \d{4}-/u)
  assert.equal(cached.state, "ready", "the admission fields are current, not cached")
})

test("desk_status answers while an admission attempt is still running", async (t) => {
  let release
  const { session } = await makeSession(t, { loadRuntime: () => new Promise((resolve) => { release = () => resolve({ runtimeServer: fakeRuntime(), runtimeStatus: {} }) }) })
  const started = Date.now()
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.ok(Date.now() - started < 200, `desk_status took ${Date.now() - started} ms`)
  assert.equal(status.state, "admitting")
  release()
})

test("a runtime status keeps its own status value when ready", async (t) => {
  const runtime = fakeRuntime()
  runtime.callTool = async () => ({ content: [{ type: "text", text: JSON.stringify({ root: {} }) }] })
  const { session } = await makeSession(t, { runtime })
  await session.admission.refresh()
  const status = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(status.status, "ok")
  assert.equal(status.admission.writes, "available")
  assert.equal(status.admission.controller, "connected")
  assert.equal(status.admission.state_branch.kind, "not_configured")
  assert.equal(status.semantic, undefined)
})

test("state-directory repairs and last-start records, and an unwritable state directory is logged, never fatal", async (t) => {
  const repairing = fakeRuntime({
    connectOrStartController: async (options) => {
      options.onRepair({ action: "chmod_700", path: "/state/abc", from: "755" })
      return { accepted: true }
    },
  })
  const { session, base, log } = await makeSession(t, { runtime: repairing })
  const snapshot = await session.admission.refresh()
  assert.equal(snapshot.repair, "repaired: readiness state directory mode 755 → 700 (/state/abc)")
  assert.match(readFileSync(path.join(base, "state", "repairs.log"), "utf8"), /mode 755 → 700/u)
  assert.match(log(), /state: ready \(repaired: readiness state directory/u)
  assert.equal(JSON.parse(readFileSync(path.join(base, "state", "last-start.json"), "utf8")).repair, snapshot.repair)

  const blockedBase = await mkTempRoot("desk-session-unwritable-")
  const blocked = path.join(blockedBase, "file")
  writeFileSync(blocked, "not a directory")
  const unwritable = await makeSession(t, { runtime: repairing, deskStateDir: path.join(blocked, "state") })
  assert.equal((await unwritable.session.admission.refresh()).state, "ready")
  assert.match(unwritable.log(), /could not append to the repair log/u)
  assert.match(unwritable.log(), /could not record last-start\.json/u)
})

test("the root's own start record begins with admitting, and desk_status points at it once the root is known", async (t) => {
  let release
  const loading = new Promise((resolve) => { release = resolve })
  const runtime = fakeRuntime()
  const { session, base } = await makeSession(t, { loadRuntime: async () => { await loading; return { runtimeServer: runtime, runtimeStatus: { state: "ready" } } } })
  const noRoot = await makeSession(t, { resolveInputs: async () => ({ rootError: { name: "Error", message: "gone", code: "DESK_ROOT_UNAVAILABLE" } }) })
  await noRoot.session.admission.refresh()
  assert.equal(payload(await noRoot.session.callTool({ name: "desk_status" })).admission.last_start, path.join(noRoot.base, "state", "last-start.json"), "no root: the shared record")
  const root = path.join(base, "desk")
  const perRoot = path.join(base, "state", "last-start", `${lastStartRootKey(root)}.json`)
  const attempt = session.admission.refresh()
  await waitUntil(() => existsSync(perRoot))
  assert.equal(JSON.parse(readFileSync(perRoot, "utf8")).state, "admitting", "the first state of the root's own record")
  assert.equal(JSON.parse(readFileSync(perRoot, "utf8")).root, root)
  release()
  assert.equal((await attempt).state, "ready")
  assert.equal(JSON.parse(readFileSync(perRoot, "utf8")).state, "ready")
  assert.equal(payload(await session.callTool({ name: "desk_status" })).admission.last_start, perRoot)
})

test("a controller whose close fails is still forgotten, and dispose closes the controller", async (t) => {
  const failing = await makeSession(t, { runtime: fakeRuntime({ connectOrStartController: async () => ({ accepted: true, close: async () => { throw new Error("already gone") } }) }) })
  await failing.session.admission.refresh()
  failing.session.dispose()
  await flush()
  assert.equal(failing.session.context.admission.controller, null)
  const closed = []
  const { session } = await makeSession(t, { runtime: fakeRuntime({ connectOrStartController: async () => ({ accepted: true, close: async () => closed.push(1) }) }) })
  await session.admission.refresh()
  session.dispose()
  await flush()
  assert.deepEqual(closed, [1])
})

test("the default stderr, git and hung-controller probes are real", async (t) => {
  const base = await mkTempRoot("desk-session-defaults-")
  const session = createDeskSession({
    args: {},
    deskStateDir: path.join(base, "state"),
    readinessStateHome: path.join(base, "readiness"),
    resolveInputs: async () => ({ root: { root: base }, activationError: new Error("stop here") }),
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

test("a required-semantic session that lost its controller reconnects without starting background convergence", async (t) => {
  let connections = 0
  let background = 0
  const controller = () => ({ accepted: true, beginConvergence: async () => {}, barrier: async () => ({ capability: "semantic", current: true }) })
  const runtime = fakeRuntime({
    connectOrStartController: async () => { connections += 1; return controller() },
    beginBackgroundConvergence: () => { background += 1 },
  })
  const { session } = await makeSession(t, { runtime, inputs: { policy: { ...unsupported, semantic: "required" } } })
  assert.equal((await session.admission.refresh()).state, "ready")
  session.context.controllerLost = true
  assert.equal((await session.admission.refresh({ force: true })).state, "ready")
  assert.equal(connections, 2)
  assert.equal(background, 0)
})
