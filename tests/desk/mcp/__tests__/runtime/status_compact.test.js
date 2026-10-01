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
  readiness: { state: "ready" },
  write_scope: { mode: "workspace", person: null },
  sync: { blocked: false, ahead: 0, behind: 0 },
  admission: { summary: "ok", blockers: [] },
}

test("a ready desk answers in one word with nothing to fix and pointers to the rest", () => {
  const compact = compactStatus(ready)
  assert.equal(compact.state, "ready")
  assert.equal(compact.summary, "Desk is ready.")
  assert.deepEqual(compact.degraded, [])
  assert.equal(compact.search, "ready")
  assert.deepEqual(compact.notes, [])
  assert.deepEqual(compact.root, { path: "/d", source: "host-project" })
  assert.deepEqual(compact.write_scope, { mode: "workspace", person: null })
  assert.equal(compact.sync, "in sync")
  assert.equal(compact.plugin_version, "1.2.3")
  assert.match(compact.detail, /detail: true/u)
  assert.ok(!("fix" in compact) && !("code" in compact) && !("status_detail" in compact))
  assert.ok(JSON.stringify(compact).length < 800)
})

test("a degraded search index never makes the state degraded: it is its own word, with a note", () => {
  const compact = compactStatus({
    ...ready,
    readiness: { state: "degraded", detail: { controller_state: "RECOVERING", convergence: { status: "failed", diagnostic: { message: "journal has unsafe state directory ancestry" } } } },
  })
  assert.equal(compact.state, "ready", "boot would say ready for the same desk")
  assert.equal(compact.search, "degraded")
  assert.deepEqual(compact.degraded, [])
  assert.match(compact.notes[0], /Search index degraded \(journal has unsafe state directory ancestry\): search reads the files directly/u)
  const bare = compactStatus({ ...ready, readiness: { state: "unavailable" } })
  assert.match(bare.notes[0], /^Search index unavailable: search reads/u)
  assert.equal(compactStatus({ ...ready, readiness: undefined }).search, "not_checked")
  assert.deepEqual(compactStatus({ ...ready, readiness: { state: "converging" } }).notes, [])
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
  assert.match(compactStatus({ ...ready, host_enforcement: { registered: false } }).notes[0], /deny hook is not registered/u)
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
    protect: async () => ({ protected: false }),
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

test("desk_status declares its one optional input", () => {
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS.desk_status.properties), ["detail"])
  assert.deepEqual(TOOL_INPUT_SCHEMAS.desk_status.required, [])
})
