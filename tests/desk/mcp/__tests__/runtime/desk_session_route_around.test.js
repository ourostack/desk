// Desk tools only help (#623), at the real session boundary: every refusal the session makes before a tool runs, the
// tool's own failure and an exception all leave with `route_around`, built for this session's root, person and branch.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import { createDeskSession } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { toolRoute } from "../../../../../plugins/desk/mcp/src/util/tool-route.js"
import { mkTempRoot } from "../_temp_roots.js"
import { git, makeGitDesk, writeFile } from "./_admission_fixtures.js"

const payload = (result) => JSON.parse(result.content[0].text)
const unsupported = { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" }
const quietWatch = () => Object.assign(new EventEmitter(), { close() {} })

function fakeRuntime(answer = async ({ name, person }) => ({ content: [{ type: "text", text: JSON.stringify({ status: "ok", tool: name, person }) }] })) {
  return {
    callTool: (call) => answer(call),
    createSearchEngine: () => ({ warm() {}, noteChange() {}, searchStatus: () => ({ state: "ready", message: "ready" }), async close() {} }),
  }
}

async function makeSession(t, { root, runtime = fakeRuntime(), inputs = {}, ...overrides } = {}) {
  const base = await mkTempRoot("desk-route-")
  const deskRoot = root ?? path.join(base, "desk")
  mkdirSync(deskRoot, { recursive: true })
  const session = createDeskSession({
    args: { person: null },
    deskStateDir: path.join(base, "state"),
    readinessStateHome: path.join(base, "readiness"),
    stderr: { write() {} },
    resolveInputs: async () => ({ root: { root: deskRoot, source: "explicit-root" }, activation: { activationStatus: null, readinessPolicy: inputs.policy ?? unsupported, stateBranch: inputs.stateBranch ?? null } }),
    loadRuntime: async () => ({ runtimeServer: runtime, runtimeStatus: { state: "ready" } }),
    setupDiagnostic: () => ({ status: "setup_required", mode: "setup", summary: "no desk", remediation: [] }),
    watch: quietWatch,
    ...overrides,
  })
  t.after(() => session.dispose())
  return { session, root: deskRoot }
}

test("an unknown tool's text refusal gains a route as a second item", async (t) => {
  const { session } = await makeSession(t)
  const result = await session.callTool({ name: "nope" })
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, "unknown tool: nope")
  assert.match(JSON.parse(result.content[1].text).route_around.summary, /nope is not a Desk tool/u)
})

test("a refusal while Desk is still admitting carries the tool's route", async (t) => {
  const timers = { setTimeout: (callback) => { setImmediate(callback); return 1 }, clearTimeout: () => {} }
  const { session, root } = await makeSession(t, { timers, disposeAdmissionWaitMs: 0, loadRuntime: () => new Promise(() => {}) })
  const refused = payload(await session.callTool({ name: "desk_search", input: { query: "ferry" } }))
  assert.equal(refused.code, "admitting")
  assert.deepEqual(refused.route_around, toolRoute("desk_search", { query: "ferry" }, { root, person: null, stateBranch: null, code: "admitting" }))
  assert.ok(refused.route_around.steps.some((step) => step.argv?.includes("grep")), "a search is answered from the files")
})

test("a tool that throws leaves with a route, and no longer tells the agent to retry blind", async (t) => {
  const { session, root } = await makeSession(t, { runtime: fakeRuntime(async () => { throw new TypeError("tool broke") }) })
  await session.admission.refresh()
  const result = await session.callTool({ name: "task_update", input: { track: "ops", slug: "harbor" } })
  const answer = payload(result)
  assert.equal(result.isError, true)
  assert.equal(answer.code, "tool_exception")
  assert.doesNotMatch(answer.fix, /retry the call/u)
  assert.match(answer.fix, /do not repeat it blind: route_around/u)
  assert.deepEqual(answer.route_around, toolRoute("task_update", { track: "ops", slug: "harbor" }, { root, person: null, stateBranch: null, code: "tool_exception" }))
})

test("a tool's own failure nested under a success-looking status gains a route; one it routed itself is kept", async (t) => {
  let next
  const { session, root } = await makeSession(t, { runtime: fakeRuntime(async () => ({ content: [{ type: "text", text: JSON.stringify(next) }] })) })
  await session.admission.refresh()
  next = { status: "nothing_to_commit", commit: { status: "failed", reason: "stage_failed" } }
  const saved = payload(await session.callTool({ name: "desk_save", input: { paths: ["notes.md"], message: "m" } }))
  assert.deepEqual(saved.route_around, toolRoute("desk_save", { paths: ["notes.md"], message: "m" }, { root, person: null, stateBranch: null }))
  next = { status: "written", commit: { status: "failed", reason: "timeout", route_around: { own: true } } }
  const own = payload(await session.callTool({ name: "lesson_add", input: { scope: "personal", topic: "t", body: "b" } }))
  assert.equal(own.route_around, undefined)
  assert.deepEqual(own.commit.route_around, { own: true })
  next = { status: "ok" }
  assert.equal(payload(await session.callTool({ name: "task_update", input: {} })).route_around, undefined, "a success stays as it was")
})

test("a headless refusal keeps its protection: the route hands the change on and writes nothing", async (t) => {
  const { session } = await makeSession(t, { runtime: fakeRuntime(async () => ({ content: [{ type: "text", text: JSON.stringify({ status: "refused", code: "headless_session", summary: "A headless session does not take new work." }) }] })) })
  await session.admission.refresh()
  const refused = payload(await session.callTool({ name: "improvement_next", input: {} }))
  assert.match(refused.route_around.summary, /never write it by hand, change identity or treat the refusal as permission/u)
  assert.equal(JSON.stringify(refused.route_around).includes("argv"), false)
})

test("a hosted refusal routes in words only: a hosted Desk has no shell or Git", async (t) => {
  const { session } = await makeSession(t, { env: { DESK_HOSTED: "1" } })
  const refused = payload(await session.callTool({ name: "desk_recall", input: { topic: "x" } }))
  assert.equal(refused.code, "hosted_unavailable")
  assert.match(refused.route_around.summary, /hosted Desk/u)
  assert.equal(JSON.stringify(refused.route_around).includes("argv"), false)
})

test("a write refused because the shared checkout is on another branch routes through a temporary worktree on the state branch, never a switch", async (t) => {
  const fixture = await makeGitDesk("desk-route-branch-")
  git(fixture.desk, "switch", "feature")
  // A local commit makes the branch differ from its upstream, so Desk will not switch it on its own.
  writeFile(path.join(fixture.desk, "ops", "local.md"), "local\n")
  git(fixture.desk, "add", "--", "ops/local.md")
  git(fixture.desk, "commit", "-m", "local work", "--", "ops/local.md")
  const { session } = await makeSession(t, { root: fixture.desk, inputs: { stateBranch: "main" } })
  const snapshot = await session.admission.refresh()
  assert.match(snapshot.state, /^degraded:state_branch_/u)
  const refused = payload(await session.callTool({ name: "track_update", input: { slug: "ops" } }))
  assert.match(refused.code, /^state_branch_/u)
  const steps = refused.route_around.steps
  assert.deepEqual(steps.find((step) => step.argv?.includes("worktree")).argv, ["git", "-C", fixture.desk, "worktree", "add", `${fixture.desk}.desk-route-track_update`, "main"])
  assert.ok(!JSON.stringify(steps).includes('"switch"'), "the route never switches the shared checkout by hand")
  assert.equal(git(fixture.desk, "branch", "--show-current").trim(), "feature", "the refusal changed nothing")
})

test("diagnostic mode's gated tools carry a route that starts by finding the desk root", async () => {
  const { startDiagnosticServer } = await import("../../../../../plugins/desk/mcp/src/runtime/diagnostic-server.js")
  const input = new EventEmitter()
  const chunks = []
  const running = startDiagnosticServer({ diagnostic: { status: "degraded", mode: "diagnostic", summary: "Node is too old.", remediation: [] }, input, output: { write: (chunk) => chunks.push(chunk) } })
  input.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_update", arguments: { track: "ops", slug: "harbor" } } }) + "\n"))
  input.emit("end")
  await running
  const message = JSON.parse(chunks.join("").trim().split("\n").at(-1))
  const answer = JSON.parse(message.result.content[0].text)
  assert.equal(message.result.isError, true)
  assert.equal(answer.route_around.steps[0].tool, "desk_status", "the route first finds the desk root this mode could not")
})
