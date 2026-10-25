// desk_status answers compactly unless asked for `detail: true`, and uses the boot script's health words
// (boot acceptance round 6: "100KB to answer ready or not", and a degraded index read as an outage beside a ready boot).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { createDeskSession } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"
import { mkTempRoot } from "../_temp_roots.js"

const payload = (result) => JSON.parse(result.content[0].text)

const ready = {
  status: "ok",
  state: "ready",
  root: { path: "/d", source: "host-project", valid: true },
  runtime: { plugin: { version: "1.2.3" } },
  search: { state: "ready", message: "Search is ready." },
  write_scope: { mode: "workspace", person: null },
  sync: { blocked: false, ahead: 0, behind: 0 },
  admission: { summary: "ok", blockers: [] },
}

test("a ready desk whose detail is still loading says so in the summary and flags detail_pending, keeping state ready", () => {
  const compact = compactStatus({ status: "ok", state: "ready", detail_pending: true, status_detail: "unavailable: the runtime status did not answer; call desk_status again shortly", admission: { summary: "ok", blockers: [] } })
  assert.equal(compact.state, "ready")
  assert.match(compact.summary, /^Desk is ready, but its details .* are still loading.*Call desk_status again shortly\.$/u)
  assert.equal(compact.detail_pending, true)
  assert.deepEqual(compact.root, { path: null, source: null })
  assert.match(compact.status_detail, /^unavailable: /u)
  // The session's own first answer already names the desk it admitted, and its summary no longer calls the root empty.
  const rooted = compactStatus({ status: "ok", state: "ready", detail_pending: true, root: { path: "/d", source: "activation-config" }, admission: { summary: "ok", blockers: [] } })
  assert.deepEqual(rooted.root, { path: "/d", source: "activation-config" })
  assert.equal(rooted.summary, "Desk is ready, but its details (search, sync) are still loading, so the empty fields below are not a fault. Call desk_status again shortly.")
  assert.equal(rooted.detail_pending, true)
  assert.ok(!("detail_pending" in compactStatus(ready)), "a complete status has no detail_pending")
  assert.equal(compactStatus({ ...ready, detail_pending: true, status: "admitting", state: "admitting" }).detail_pending, undefined, "only a ready desk is called ready")
})

test("a repair Desk made at this session's start is one of the notes, in the words the repair log uses", () => {
  const line = "repaired: detached HEAD → main (was 0123456789ab)"
  assert.deepEqual(compactStatus({ ...ready, repair: line }).notes, [line])
  assert.deepEqual(compactStatus({ ...ready, repair: null }).notes, [])
  // The first answer of a session, before the runtime detail is loaded, already says it.
  assert.deepEqual(compactStatus({ status: "ok", state: "ready", detail_pending: true, repair: line, admission: { summary: "ok", blockers: [] } }).notes, [line])
  // A desk that is not ready says it too: the repair happened whatever the attempt ended in.
  const degraded = compactStatus({ ...ready, status: "degraded", state: "degraded", code: "controller_unavailable", repair: line })
  assert.equal(degraded.state, "degraded")
  assert.deepEqual(degraded.notes, [line])
})

test("a ready desk whose runtime status failed, or that carries no runtime detail, says why its root is empty", () => {
  const failed = compactStatus({ status: "ok", state: "ready", status_error: "status exploded", admission: { summary: "ok", blockers: [] } })
  assert.equal(failed.state, "ready")
  assert.match(failed.summary, /^Desk is ready, but its runtime status failed \(status exploded\).*not a missing desk.*call desk_doctor\.$/u)
  assert.equal(failed.status_error, "status exploded")
  assert.deepEqual(failed.root, { path: null, source: null })
  const bare = compactStatus({ status: "ok", state: "ready", admission: { summary: "ok", blockers: [] } })
  assert.equal(bare.state, "ready")
  assert.match(bare.summary, /^Desk is ready, but this answer carries no runtime detail .*not a missing desk.*desk_doctor to see why\.$/u)
  assert.ok(!("status_error" in bare) && !("detail_pending" in bare))
  assert.ok(!bare.summary.includes("{ detail: true }"), "detail: true returns the same thing here, so only desk_doctor is named")
  const long = compactStatus({ status: "ok", state: "ready", status_error: `${"x".repeat(300)}\n    at stack frame`, admission: { summary: "ok", blockers: [] } })
  assert.equal(long.status_error, `${"x".repeat(199)}…`)
  assert.ok(long.summary.includes(`(${"x".repeat(199)}…)`) && !long.summary.includes("stack frame"))
  assert.equal(compactStatus({ status: "ok", state: "ready", status_error: "boom\nsecond line", admission: { summary: "ok", blockers: [] } }).status_error, "boom")
  for (const empty of ["", "  \n  "]) {
    const unknown = compactStatus({ status: "ok", state: "ready", status_error: empty, admission: { summary: "ok", blockers: [] } })
    assert.equal(unknown.status_error, "unknown error")
    assert.match(unknown.summary, /failed \(unknown error\)/u)
  }
  assert.equal(compactStatus(ready).summary, "Desk is ready.")
  assert.ok(!("status_error" in compactStatus({ ...ready, status: "admitting", state: "admitting", status_error: "x" })), "a desk that is not ready reports through its own fix")
})

test("a ready desk answers in one word with nothing to fix and pointers to the rest", () => {
  const compact = compactStatus(ready)
  assert.equal(compact.state, "ready")
  assert.equal(compact.summary, "Desk is ready.")
  assert.deepEqual(compact.degraded, [])
  assert.equal(compact.search, "Search is ready.")
  assert.deepEqual(compact.notes, [])
  assert.deepEqual(compact.root, { path: "/d", source: "host-project" })
  assert.deepEqual(compact.write_scope, { mode: "workspace", person: null })
  assert.equal(compact.sync, "in sync")
  assert.equal(compact.plugin_version, "1.2.3")
  assert.match(compact.detail, /detail: true/u)
  assert.ok(!("fix" in compact) && !("code" in compact) && !("status_detail" in compact))
  assert.ok(JSON.stringify(compact).length < 800)
})

test("search that is still preparing never makes the state degraded, and the old index's removal is a note", () => {
  const preparing = "Search is preparing 3 of 10 sections for meaning-based search; exact-word search is ready."
  const removed = "Desk removed its old search index (9.7 GB), which this version no longer uses."
  const compact = compactStatus({ ...ready, search: { state: "preparing", message: preparing, old_index_removed: removed } })
  assert.equal(compact.state, "ready")
  assert.equal(compact.search, preparing)
  assert.deepEqual(compact.degraded, [])
  assert.deepEqual(compact.notes, [removed])
  assert.equal(compactStatus({ ...ready, search: undefined }).search, "not_checked")
})

test("a desk that is not ready says why, with the code, the fix and the onboarding path", () => {
  const compact = compactStatus({
    status: "degraded", state: "degraded", code: "no_remote", fix: "Fix the remote.", onboarding_skill: "crew:join-crew",
    summary: "top summary", root: { path: "/d", valid: false, diagnostic: "desk_root_not_found" },
    admission: { summary: "Desk is degraded", blockers: ["blocker one", { message: "blocker two" }, { code: "x" }, 7, "blocker one"] },
    status_error: "status exploded", status_detail: "cached: slow",
  })
  assert.equal(compact.state, "degraded")
  assert.equal(compact.summary, "Desk is degraded")
  assert.deepEqual(compact.degraded, [
    "Desk is degraded", "top summary", "blocker one", "blocker two", '{"code":"x"}', "7", "status exploded", "desk root /d: desk_root_not_found",
  ])
  assert.equal(compact.code, "no_remote")
  assert.equal(compact.fix, "Fix the remote.")
  assert.equal(compact.onboarding_skill, "crew:join-crew")
  assert.equal(compact.status_detail, "cached: slow")
})

test("a setup diagnostic keeps the small keys the onboarding path needs, and the selected activation is named", () => {
  const compact = compactStatus({
    status: "setup_required", mode: "setup", reason: "no_desk_root", reason_detail: null, binding_path: "/b.json", paths_tried: [{ source: "x", path: "/x" }],
    remediation: [{ action: "bind_desk", message: "bind" }], onboarding_skill: "desk:first-run-bootstrap",
    activation: { selected_id: "desk", chain: ["desk", "overlay"] },
  })
  assert.equal(compact.state, "setup_required")
  assert.equal(compact.binding_path, "/b.json")
  assert.deepEqual(compact.paths_tried, [{ source: "x", path: "/x" }])
  assert.equal(compact.remediation[0].action, "bind_desk")
  assert.equal(compact.reason, "no_desk_root")
  assert.deepEqual(compact.activation, { selected_id: "desk", chain: ["desk", "overlay"] })
  assert.deepEqual(compactStatus({ ...ready, activation: { selected_id: "desk" } }).activation, { selected_id: "desk", chain: [] })
  assert.ok(!("binding_path" in compactStatus({ ...ready, binding_path: "/b.json" })), "a ready desk carries no setup keys")
})

test("the state words match boot's: setup_required, admitting, and a bare payload falls back to degraded", () => {
  assert.equal(compactStatus({ status: "setup_required", state: "degraded" }).state, "setup_required")
  assert.equal(compactStatus({ status: "admitting" }).state, "admitting")
  assert.equal(compactStatus({ status: "error", state: "admitting" }).state, "admitting")
  const bare = compactStatus({ status: "error", root: { valid: false } })
  assert.equal(bare.state, "degraded")
  assert.deepEqual(bare.degraded, ["desk root (none): not usable"])
  assert.equal(bare.summary, "Desk is not ready.")
  assert.equal(compactStatus({ status: "error", code: "boom" }).degraded[0], "boom")
  assert.equal(compactStatus({ status: "error" }).degraded[0], "Desk is not ready")
  assert.equal(compactStatus({ status: "error", summary: "plain summary" }).summary, "plain summary")
  assert.equal(compactStatus({ status: "error", admission: { blockers: "none" } }).degraded[0], "Desk is not ready")
})

test("sync and enforcement conditions that matter become short notes", () => {
  assert.equal(compactStatus({ ...ready, sync: "no remote configured" }).sync, "no remote configured")
  assert.equal(compactStatus({ ...ready, sync: null }).sync, null)
  assert.equal(compactStatus({ ...ready, sync: { blocked: true, reason: "dirty" } }).sync, "blocked (dirty)")
  assert.equal(compactStatus({ ...ready, sync: { blocked: true } }).sync, "blocked")
  assert.match(compactStatus({ ...ready, sync: { blocked: true, reason: "dirty" } }).notes[0], /Pushing the desk is blocked \(dirty\)/u)
  assert.match(compactStatus({ ...ready, sync: { blocked: true } }).notes[0], /Pushing the desk is blocked\./u)
  assert.equal(compactStatus({ ...ready, sync: { blocked: false, behind: 2, ahead: 0 } }).sync, "2 commit(s) behind origin")
  assert.equal(compactStatus({ ...ready, sync: { blocked: false, behind: 0, ahead: 3 } }).sync, "3 commit(s) ahead of origin, not pushed yet")
  const minimal = compactStatus({ status: "ok" })
  assert.deepEqual(minimal.root, { path: null, source: null })
  assert.equal(minimal.plugin_version, null)
})

async function makeSession(t, runtimePayload) {
  const base = await mkTempRoot("desk-status-compact-")
  const root = path.join(base, "desk")
  mkdirSync(root, { recursive: true })
  const runtime = {
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(runtimePayload) }] }),
    connectOrStartController: async () => ({ accepted: true, async status() { return { state: "READY" } } }),
  }
  const session = createDeskSession({
    args: { person: null },
    deskStateDir: path.join(base, "state"),
    readinessStateHome: path.join(base, "readiness"),
    stderr: { write() {} },
    resolveInputs: async () => ({
      root: { root, source: "explicit-root" },
      activation: { activationStatus: null, readinessPolicy: { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" }, stateBranch: null },
    }),
    loadRuntime: async () => ({ runtimeServer: runtime, runtimeStatus: { state: "ready" } }),
    setupDiagnostic: () => ({ status: "setup_required", mode: "setup", summary: "no desk" }),
    hung: { probe: async () => ({ state: "refused" }) },
  })
  t.after(() => session.dispose())
  await session.admission.refresh({ force: true })
  return session
}

test("the desk_status tool is compact by default and returns the full payload only for detail: true", async (t) => {
  const full = { ...ready, active_embedding_spec: { id: "spec" }, snapshots: { module_state: "available" }, document_vectors: { chunks_total: 1 } }
  const session = await makeSession(t, full)
  const compact = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(compact.state, "ready")
  assert.ok(!("snapshots" in compact) && !("active_embedding_spec" in compact))
  assert.equal(payload(await session.callTool({ name: "desk_status", input: { detail: false } })).state, "ready")
  assert.ok(!("snapshots" in payload(await session.callTool({ name: "desk_status", input: { detail: "yes" } }))))
  const detailed = payload(await session.callTool({ name: "desk_status", input: { detail: true } }))
  assert.equal(detailed.status, "ok")
  assert.deepEqual(detailed.snapshots, { module_state: "available" })
  assert.ok(JSON.stringify(compact).length < JSON.stringify(detailed).length)
})

test("desk_status declares its two optional inputs: detail, and has_instructions for a hosted Desk", () => {
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS.desk_status.properties), ["detail", "has_instructions"])
  assert.deepEqual(TOOL_INPUT_SCHEMAS.desk_status.required, [])
})

// A session built on the fake runtime above whose destination check can be held or slowed after the first admission.
async function revalidatingSession(t, { resolve }) {
  const base = await mkTempRoot("desk-status-starting-")
  const root = path.join(base, "desk")
  mkdirSync(root, { recursive: true })
  const session = createDeskSession({
    args: { person: null },
    deskStateDir: path.join(base, "state"),
    readinessStateHome: path.join(base, "readiness"),
    stderr: { write() {} },
    resolveInputs: async () => {
      await resolve()
      return {
        root: { root, source: "explicit-root" },
        activation: { activationStatus: null, readinessPolicy: { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" }, stateBranch: null },
      }
    },
    loadRuntime: async () => ({ runtimeServer: {
      callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(ready) }] }),
      connectOrStartController: async () => ({ accepted: true, async status() { return { state: "READY" } } }),
    }, runtimeStatus: { state: "ready" } }),
    setupDiagnostic: () => ({ status: "setup_required", mode: "setup", summary: "no desk" }),
    hung: { probe: async () => ({ state: "refused" }) },
  })
  t.after(() => session.dispose())
  return session
}

test("desk_status does not say ready while admission is still running", async (t) => {
  // The first admission: every tool call waits for it, so the desk is still starting.
  const since = new Date(Date.now() - 3000).toISOString()
  const first = compactStatus({ status: "admitting", state: "admitting", admission: { summary: "Desk is starting: the handshake is complete and admission is running in the background.", blockers: [], starting: true, phase: "loading_runtime", phase_since: since } })
  assert.equal(first.state, "admitting")
  assert.equal(first.summary, "Desk is still starting (loading Desk, 3 s so far). Call desk_status again in about 10 s.")
  assert.equal(first.fix, "desk_status and desk_skill answer at once. Every other Desk tool waits up to 10 s for startup: task reads and updates and exact-word search (desk_search) need only the desk's files, so they run as soon as startup finishes, and meaning-based search (desk_recall, desk_similar) can take longer to catch up. If startup is still running after 10 s, the call is refused with code admitting; retry it then.")
  assert.ok(!("detail_pending" in first), "only a ready desk is called ready")
  // Each step is named in plain words, or not at all.
  const step = (phase, extra = {}) => compactStatus({ status: "admitting", admission: { starting: true, phase, ...extra } }).summary
  assert.equal(step("resolving_inputs"), "Desk is still starting (finding this session's desk). Call desk_status again in about 10 s.")
  assert.equal(step("connecting_controller", { phase_since: "not a date" }), "Desk is still starting (starting search). Call desk_status again in about 10 s.")
  assert.equal(step("some_future_step"), "Desk is still starting. Call desk_status again in about 10 s.")
  assert.equal(step(null), "Desk is still starting. Call desk_status again in about 10 s.")
  // An admitted desk that re-admits after a change keeps its own words: it is not starting.
  const again = compactStatus({ status: "admitting", state: "admitting", summary: "Desk is verifying this session's destination; operations wait for resolution.", fix: "Call desk_status, then retry once destination verification completes.", admission: { starting: false } })
  assert.equal(again.summary, "Desk is verifying this session's destination; operations wait for resolution.")
  assert.equal(again.fix, "Call desk_status, then retry once destination verification completes.")

  // The session's own first answer, while its first destination check is still running.
  let release = () => {}
  let hold = true
  const session = await revalidatingSession(t, { resolve: () => hold && new Promise((resolve) => { release = resolve }) })
  t.after(() => release())
  session.start()
  const starting = payload(await session.callTool({ name: "desk_status" }))
  assert.equal(starting.state, "admitting")
  assert.match(starting.summary, /^Desk is still starting \(finding this session's desk/u)
  hold = false
  release()
  await session.admission.idle()
  assert.equal(payload(await session.callTool({ name: "desk_status" })).state, "ready")
})

test("a ready session whose background re-check is slow still reports ready", async (t) => {
  let slow = false
  const session = await revalidatingSession(t, { resolve: () => slow && new Promise((resolve) => setTimeout(resolve, 150)) })
  await session.admission.refresh({ force: true })
  slow = true
  for (let call = 0; call < 3; call += 1) {
    const status = payload(await session.callTool({ name: "desk_status" }))
    assert.equal(status.state, "ready", "a re-check of an admitted desk is not a start")
    assert.doesNotMatch(status.summary, /still starting/u)
  }
  await session.admission.idle()
})
