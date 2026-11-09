import "../_isolated_env.mjs"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { removeTree } from "../_remove_tree.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { startOrJoinRecovery } from "../../../../../plugins/desk/mcp/src/runtime/recovery-state.js"

if (process.platform === "darwin") {
  process.env.PATH = `/usr/bin:/bin:${process.env.PATH}`
  process.env.GIT_EXEC_PATH = "/Library/Developer/CommandLineTools/usr/libexec/git-core"
}
delete process.env.GIT_TEMPLATE_DIR
delete process.env.GIT_CONFIG_PARAMETERS
delete process.env.GIT_CONFIG_COUNT

test("local status preserves recovery evidence beside counts and outgoing blockers", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-recovery-status-"))
  t.after(() => removeTree(dir))
  const root = path.join(dir, "root")
  mkdirSync(root)
  const env = { ...process.env, XDG_STATE_HOME: path.join(dir, "state") }
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
  }
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  writeFileSync(path.join(root, "seed"), "original\n")
  git("add", "seed")
  git("commit", "-qm", "seed")
  // An unreachable URL makes any accidental network read fail this local-only contract.
  git("remote", "add", "origin", "http://127.0.0.1:1/never-contact")
  for (const blocked of [false, true]) {
    for (const state of ["starting", "accepted", "blocked", "unknown", null]) {
      const recovery = state === null ? null : { id: "fixture-operation", state, custody: state === "starting" ? "unaccepted" : "accepted",
        reason: state === "blocked" ? "writer_custody_required" : state === "unknown" ? "owner_lost" : null }
      updateSyncStatus(root, env, { blocked, reason: blocked ? "push_rejected" : null, unpushed: blocked ? 2 : 0, recovery, last_pull: null })
      const status = await desk_status({ deskRoot: root, env })
      assert.deepEqual(status.sync.recovery ?? null, recovery, `state=${state}, blocked=${blocked}`)
      assert.equal(status.sync.blocked, blocked)
      const compact = compactStatus({ status: "ok", root: { path: root }, sync: status.sync })
      if (state !== null) assert.deepEqual(compact.recovery, recovery)
      if (["blocked", "unknown"].includes(state)) assert.equal(compact.state, "degraded")
      if (["starting", "accepted"].includes(state) && !blocked) assert.match(compact.sync, /pending/u)
      if (blocked) assert.match(compact.sync, /push blocked/u)
    }
  }
})

test("a background check barrier is separate from incoming synchronization", () => {
  const recovery = { id: "fixture-operation", state: "synced", incoming: { state: "verified" }, checks: { state: "blocked", reason: "migration_pending" } }
  const compact = compactStatus({ status: "ok", root: { path: "/fixture" }, sync: { blocked: false, ahead: 0, behind: 0, recovery } })
  assert.equal(compact.state, "degraded")
  assert.equal(compact.sync, "in sync")
  assert.match(compact.degraded.join("\n"), /background checks.*migration_pending/u)
  assert.doesNotMatch(compact.degraded.join("\n"), /incoming|last sync failed/u)
  assert.equal(compact.recovery.incoming.state, "verified")
})

for (const inspection of ["absent", "failed"]) for (const pending of [true, false]) test(`known incoming failure survives ${inspection} remote inspection with pending=${pending}`, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-recovery-early-status-"))
  t.after(() => removeTree(dir))
  const root = path.join(dir, "root")
  mkdirSync(path.join(root, ".git", "objects"), { recursive: true })
  writeFileSync(path.join(root, ".git", "config"), "[core]\nrepositoryformatversion=0\nbare=false\n")
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
  const env = { ...process.env, XDG_STATE_HOME: path.join(dir, "state") }
  const failure = { state: "unresolved", reason: "known incoming failure", at: "2026-10-30T00:00:00Z" }
  updateSyncStatus(root, env, { last_pull: failure })
  if (pending) await startOrJoinRecovery({ root, env, waitMs: 0,
    spawnImpl: () => Object.assign(new EventEmitter(), { pid: process.pid, unref() {} }) })
  if (inspection === "failed") writeFileSync(path.join(root, ".git", "config"), "[invalid\n")
  const full = await desk_status({ deskRoot: root, env })
  assert.equal(full.sync.configured, false)
  if (pending) assert.equal(full.sync.recovery.priorFailure.reason, failure.reason)
  assert.equal(full.sync.last_pull?.reason, failure.reason)
  const compact = compactStatus(full)
  assert.equal(compact.state, "degraded")
  assert.match(compact.degraded.join("\n"), /known incoming failure/u)
  assert.doesNotMatch(compact.sync, /^in sync|^sync pending/u)
})

test("compact status retains pending prior failure even without a last-pull copy", () => {
  const compact = compactStatus({ status: "ok", root: { path: "/fixture" }, sync: {
    configured: false, recovery: { state: "starting", priorFailure: { state: "unresolved", reason: "known incoming failure" } },
  } })
  assert.equal(compact.state, "degraded")
  assert.match(compact.degraded.join("\n"), /known incoming failure/u)
})

test("verified current recovery does not resurrect its resolved prior incoming failure", () => {
  const compact = compactStatus({ status: "ok", root: { path: "/fixture" }, sync: {
    blocked: false, ahead: 0, behind: 0, last_pull: null,
    recovery: { state: "synced", incoming: { state: "verified" },
      priorFailure: { state: "unresolved", reason: "resolved incoming failure" } },
  } })
  assert.equal(compact.state, "ready")
  assert.equal(compact.sync, "in sync")
})

test("pending foreground details do not render as a failed task scan", () => {
  const text = formatBootText({
    status: "ready", root: { path: "/fixture" }, active_tasks: null,
    sync_summary: "Desk sync is pending in the background", background: { state: "pending" }, instructions: [],
  })
  assert.match(text, /Desk boot: ready/u)
  assert.match(text, /pending in the background/u)
  assert.doesNotMatch(text, /unavailable|degraded|failed/u)
})
