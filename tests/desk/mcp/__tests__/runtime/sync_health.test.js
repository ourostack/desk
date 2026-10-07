// One health word for boot and desk_status (boot acceptance round A): a failed pull is recorded where desk_status
// reads it back, and the compact answer degrades exactly as the boot script's `status` does.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { healthWord, pullStillFailing, syncDegradation } from "../../../../../plugins/desk/mcp/src/runtime/health.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { fastForwardStateBranch } from "../../../../../plugins/desk/mcp/src/runtime/desk-health.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { readSyncStatus, recordFetchOk, recordPullOutcome, runPushWorker } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"

const env = process.env
const instantClock = { sleep: () => Promise.resolve() }

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function mkDeskWithOrigin() {
  const origin = await mkTempRoot("desk-health-origin-")
  git(origin, ["init", "--bare", "-q"])
  const root = await mkTempRoot("desk-health-clone-")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"])
  git(root, ["remote", "add", "origin", origin])
  await fs.writeFile(path.join(root, "seed.md"), "seed\n")
  git(root, ["add", "--", "seed.md"])
  git(root, ["commit", "-q", "-m", "seed"])
  git(root, ["push", "-q", "-u", "origin", "main"])
  return { origin, root }
}

test("healthWord and syncDegradation are the one source of the words boot reports", () => {
  assert.equal(healthWord([]), "ready")
  assert.equal(healthWord(["x"]), "degraded")
  assert.equal(syncDegradation({ state: "synced" }), null)
  assert.equal(syncDegradation(null), null)
  assert.equal(syncDegradation({ state: "unresolved", reason: "pull_rebase_failed", cause: "unreachable" }), "sync: unresolved (pull_rebase_failed, unreachable)")
  assert.equal(syncDegradation({ state: "unresolved" }), "sync: unresolved")
})

test("a failed sync is recorded for desk_status, and a later good sync clears it", async () => {
  const { origin, root } = await mkDeskWithOrigin()
  git(root, ["remote", "set-url", "origin", path.join(origin, "gone")])
  const failed = await syncWorkspace({ root, env, fileProblem: () => ({ file: "none" }) })
  assert.equal(failed.state, "unresolved")
  const recorded = readSyncStatus({ root, env }).last_pull
  assert.equal(recorded.state, "unresolved")
  assert.equal(recorded.cause, failed.cause)

  const status = await desk_status({ deskRoot: root, env })
  assert.equal(status.sync.last_pull.state, "unresolved")

  git(root, ["remote", "set-url", "origin", origin])
  assert.equal((await syncWorkspace({ root, env })).state, "synced")
  assert.equal(readSyncStatus({ root, env }).last_pull, null)
  assert.equal("last_pull" in (await desk_status({ deskRoot: root, env })).sync, false)
})

test("desk_status carries the failed pull beside a recorded blocked push too", async () => {
  const { root } = await mkDeskWithOrigin()
  recordPullOutcome({ root, env, result: { state: "unresolved", reason: "pull_rebase_failed", cause: "auth_failed" } })
  const { syncStatusPath } = await import("../../../../../plugins/desk/mcp/src/runtime/sync-worker.js")
  const file = syncStatusPath({ root, env })
  const current = JSON.parse(await fs.readFile(file, "utf8"))
  writeFileSync(file, `${JSON.stringify({ ...current, blocked: true, reason: "push_rejected" })}\n`)
  const status = await desk_status({ deskRoot: root, env })
  assert.equal(status.sync.blocked, true)
  assert.equal(status.sync.last_pull.cause, "auth_failed")
})

test("a recorded sync outcome never throws when the state folder is unwritable", async () => {
  const { root } = await mkDeskWithOrigin()
  const blocker = path.join(await mkTempRoot("desk-health-blocker-"), "file")
  writeFileSync(blocker, "not a folder")
  const unwritable = { ...env, XDG_STATE_HOME: blocker }
  assert.doesNotThrow(() => recordPullOutcome({ root, env: unwritable, result: { state: "unresolved" } }))
  assert.doesNotThrow(() => recordPullOutcome({ root, env: unwritable, result: undefined }))
  assert.doesNotThrow(() => recordFetchOk({ root, env: unwritable }))
})

test("a successful push clears a failed-pull record: the remote is reachable again", async () => {
  const { root } = await mkDeskWithOrigin()
  recordPullOutcome({ root, env, result: { state: "unresolved", reason: "pull_rebase_failed", cause: "unreachable" } })
  await fs.writeFile(path.join(root, "more.md"), "more\n")
  git(root, ["add", "--", "more.md"])
  git(root, ["commit", "-q", "-m", "more"])
  assert.deepEqual(await runPushWorker({ root, env, clock: instantClock }), { result: "ok" })
  assert.equal(readSyncStatus({ root, env }).last_pull, null)
})

const ready = {
  status: "ok",
  root: { path: "/d", source: "host-project", valid: true },
  readiness: { state: "ready" },
  sync: { blocked: false, ahead: 0, behind: 0 },
  admission: { summary: "ok", blockers: [] },
}
const lastPull = { state: "unresolved", reason: "pull_rebase_failed", cause: "unreachable" }

test("compact desk_status says degraded for a failed sync, the same line and word as boot", () => {
  const compact = compactStatus({ ...ready, sync: { ...ready.sync, last_pull: lastPull } })
  assert.equal(compact.state, "degraded")
  assert.equal(compact.summary, "Desk works, but the last sync failed.")
  assert.deepEqual(compact.degraded, [syncDegradation(lastPull)])
  assert.match(compact.fix, /git -C \/d pull --rebase --autostash/u)
  assert.equal(compact.sync, "last pull failed (unreachable): not known to be in sync")
  assert.equal(compactStatus({ ...ready, root: undefined, sync: { last_pull: { state: "unresolved" } } }).fix.includes("<desk>"), true)
  assert.equal(compactStatus({ ...ready, sync: { last_pull: { state: "unresolved" } } }).sync, "last pull failed: not known to be in sync")
})

test("a failed sync is listed first when Desk is also not ready, and a healthy sync changes nothing", () => {
  const compact = compactStatus({ status: "degraded", summary: "worse", fix: "Fix it.", root: { path: "/d" }, sync: { last_pull: lastPull } })
  assert.equal(compact.state, "degraded")
  assert.equal(compact.degraded[0], syncDegradation(lastPull))
  assert.ok(compact.degraded.includes("worse"))
  assert.equal(compact.fix, "Fix it.")
  assert.equal(compactStatus({ ...ready, sync: { ...ready.sync, last_pull: { state: "synced" } } }).state, "ready")
})

test("desk_status reports no failed pull when nothing was recorded or the record is cleared", async () => {
  const { root } = await mkDeskWithOrigin()
  assert.equal(readSyncStatus({ root, env }), null)
  assert.equal("last_pull" in (await desk_status({ deskRoot: root, env })).sync, false)
  recordPullOutcome({ root, env, result: { state: "synced" } })
  assert.equal(readSyncStatus({ root, env }).last_pull, null)
  assert.equal("last_pull" in (await desk_status({ deskRoot: root, env })).sync, false)
})

const NOW = Date.parse("2026-09-30T12:00:00Z")
const failedAt = (iso) => ({ state: "unresolved", reason: "r", cause: "unreachable", at: iso })

test("a failed pull stops counting once a later push or fetch proves the remote reachable, and after 24 hours", () => {
  const lastPull = failedAt("2026-09-30T10:00:00Z")
  assert.equal(pullStillFailing({ lastPull, now: NOW }), true)
  assert.equal(pullStillFailing({ lastPull, lastPushAt: "2026-09-30T09:00:00Z", fetchedAt: Date.parse("2026-09-30T09:59:00Z"), now: NOW }), true, "earlier ones do not clear it")
  assert.equal(pullStillFailing({ lastPull, lastPushAt: "2026-09-30T11:00:00Z", now: NOW }), false)
  assert.equal(pullStillFailing({ lastPull, fetchedAt: Date.parse("2026-09-30T11:00:00Z"), now: NOW }), false)
  assert.equal(pullStillFailing({ lastPull, lastPushAt: "not a date", now: NOW }), true)
  assert.equal(pullStillFailing({ lastPull: failedAt("2026-09-29T11:00:00Z"), now: NOW }), false, "older than 24 hours")
  assert.equal(pullStillFailing({ lastPull: failedAt("garbage"), now: NOW }), false)
  assert.equal(pullStillFailing({ lastPull: { state: "synced" }, now: NOW }), false)
  assert.equal(pullStillFailing({ lastPull: null }), false)
  assert.equal(pullStillFailing({ lastPull: failedAt(new Date().toISOString()) }), true, "now defaults to the clock")
})

const later = () => new Promise((resolve) => setTimeout(resolve, 20))

async function failedPullDesk() {
  const { origin, root } = await mkDeskWithOrigin()
  git(root, ["remote", "set-url", "origin", path.join(origin, "gone")])
  await syncWorkspace({ root, env, fileProblem: () => ({ file: "none" }) })
  return { origin, root }
}

test("desk_status keeps a failed pull when Desk's own later fetch also fails, and drops it once that fetch succeeds", async () => {
  const { origin, root } = await failedPullDesk()
  assert.equal((await desk_status({ deskRoot: root, env })).sync.last_pull.state, "unresolved")
  await later()
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "skipped", reason: "fetch_failed" })
  assert.equal((await desk_status({ deskRoot: root, env })).sync.last_pull.state, "unresolved", "a failed fetch is not proof of anything")
  git(root, ["remote", "set-url", "origin", origin])
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "up_to_date" })
  assert.equal("last_pull" in (await desk_status({ deskRoot: root, env })).sync, false, "Desk's own successful fetch cleared it")
})

test("desk_status never reads FETCH_HEAD: a fetch run by hand, even one that wrote it, does not clear a failed pull", async () => {
  const { origin, root } = await failedPullDesk()
  await later()
  git(root, ["remote", "set-url", "origin", origin])
  git(root, ["fetch", "-q", "origin"])
  const fetchHead = path.join(git(root, ["rev-parse", "--absolute-git-dir"]).trim(), "FETCH_HEAD")
  assert.equal(statSync(fetchHead).size > 0, true)
  assert.equal((await desk_status({ deskRoot: root, env })).sync.last_pull.state, "unresolved")
})

test("desk_status keeps a failed pull after a multi-remote fetch with one dead remote wrote FETCH_HEAD", async () => {
  const { origin, root } = await failedPullDesk()
  await later()
  git(root, ["remote", "add", "good", origin])
  const result = spawnSync("git", ["-C", root, "fetch", "--all"], { encoding: "utf8" })
  assert.notEqual(result.status, 0, "origin is still dead")
  const fetchHead = path.join(git(root, ["rev-parse", "--absolute-git-dir"]).trim(), "FETCH_HEAD")
  assert.equal(statSync(fetchHead).size > 0, true, "the partial failure leaves a non-empty FETCH_HEAD")
  assert.equal((await desk_status({ deskRoot: root, env })).sync.last_pull.state, "unresolved")
})

test("the sync fix quotes a desk path with a space", () => {
  const compact = compactStatus({ ...ready, root: { path: "/my desk" }, sync: { last_pull: lastPull } })
  assert.match(compact.fix, /git -C '\/my desk' pull --rebase --autostash/u)
})
