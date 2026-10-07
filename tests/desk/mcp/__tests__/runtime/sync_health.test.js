// One health word for boot and desk_status (boot acceptance round A): a failed pull is recorded where desk_status
// reads it back, and the compact answer degrades exactly as the boot script's `status` does.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import * as path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { healthWord, pullStillFailing, syncDegradation } from "../../../../../plugins/desk/mcp/src/runtime/health.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { fastForwardStateBranch } from "../../../../../plugins/desk/mcp/src/runtime/desk-health.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { readFetchOkAt, readSyncStatus, recordFetchOk, syncStatusPath, recordPullOutcome, runPushWorker, updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
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
  assert.doesNotThrow(() => recordFetchOk({ root, env: unwritable, at: new Date().toISOString() }))
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
  for (const cause of ["unreachable", "auth_failed", "deadline"]) assert.equal(pullStillFailing({ lastPull: { ...lastPull, cause }, fetchedAt: "2026-09-30T11:00:00Z", now: NOW }), false, `${cause}: a fetch proves reachability`)
  for (const cause of ["conflict", "diverged", "other", null]) {
    assert.equal(pullStillFailing({ lastPull: { ...lastPull, cause }, fetchedAt: "2026-09-30T11:00:00Z", now: NOW }), true, `${cause}: a fetch proves reachability only`)
    assert.equal(pullStillFailing({ lastPull: { ...lastPull, cause }, lastPushAt: "2026-09-30T11:00:00Z", now: NOW }), false, `${cause}: a push still clears it`)
  }
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

test("a successful Desk fetch does not clear a diverged failure", async () => {
  const { origin, root } = await mkDeskWithOrigin()
  recordPullOutcome({ root, env, result: { state: "unresolved", reason: "pull_rebase_failed", cause: "diverged" } })
  await later()
  git(root, ["remote", "set-url", "origin", origin])
  assert.deepEqual(await fastForwardStateBranch({ env, root }), { result: "up_to_date" })
  assert.equal(typeof readFetchOkAt({ root, env }), "string", "the fetch was recorded")
  assert.equal((await desk_status({ deskRoot: root, env })).sync.last_pull.cause, "diverged")
})

test("recording a fetch never rewrites the pull record, whatever order the two writers run in", async () => {
  const { root } = await mkDeskWithOrigin()
  recordPullOutcome({ root, env, result: { state: "unresolved", reason: "r", cause: "unreachable" } })
  const before = readFileSync(syncStatusPath({ root, env }), "utf8")
  recordFetchOk({ root, env, at: new Date().toISOString() })
  assert.equal(readFileSync(syncStatusPath({ root, env }), "utf8"), before, "the sync status file is untouched")
  // The fast-forward check read nothing from the sync status file, so a pull recorded while it ran survives its write.
  recordPullOutcome({ root, env, result: { state: "unresolved", reason: "r2", cause: "unreachable" } })
  recordFetchOk({ root, env, at: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(readSyncStatus({ root, env }).last_pull.reason, "r2")
  assert.equal(readFetchOkAt({ root: "/nonexistent/other", env }), null)
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

// ---- The status file's read-merge-write is locked: two writers never drop each other's fields. ----

const SYNC_WORKER_URL = new URL("../../../../../plugins/desk/mcp/src/runtime/sync-worker.js", import.meta.url).href

function runWriters(root, stateHome, writers, rounds) {
  const script = `
    import { recordPullOutcome, updateSyncStatus } from ${JSON.stringify(SYNC_WORKER_URL)}
    const [kind, root, rounds] = [process.argv[1], process.argv[2], Number(process.argv[3])]
    for (let i = 0; i < rounds; i += 1) {
      if (kind === "pull") recordPullOutcome({ root, env: process.env, result: { state: "unresolved", reason: "r" + i, cause: "unreachable" } })
      else updateSyncStatus(root, process.env, { blocked: i % 2 === 0, reason: "push" + i, last_push_at: "push-" + i })
    }`
  const childEnv = { ...env, XDG_STATE_HOME: stateHome, LOCALAPPDATA: stateHome, NODE_TEST_CONTEXT: "" }
  return Promise.all(writers.map((kind) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, kind, root, String(rounds)], { env: childEnv, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${kind} exited ${code}: ${stderr}`))))
  })))
}

test("a pull writer and a push writer racing across processes keep each other's fields", async () => {
  const stateHome = await mkTempRoot("desk-status-race-state-")
  const root = await mkTempRoot("desk-status-race-root-")
  const rounds = 150
  await runWriters(root, stateHome, ["pull", "push"], rounds)
  const raced = { ...env, XDG_STATE_HOME: stateHome, LOCALAPPDATA: stateHome }
  const recorded = readSyncStatus({ root, env: raced })
  assert.equal(recorded.last_pull.reason, `r${rounds - 1}`, "the last failed pull survived every push-side write")
  assert.equal(recorded.last_push_at, `push-${rounds - 1}`, "the last push survived every pull-side write")
  assert.equal(typeof recorded.last_success_at, "undefined", "a failed pull records no success time")
})

test("a held lock delays a status write by its budget only, then the write still lands", () => {
  const root = "/nonexistent/status-lock-root"
  const file = path.join(mkdtempSync(path.join(osTmpdir(), "desk-status-lock-")), "x.status.json")
  updateSyncStatus(root, env, { a: 1 }, file)
  // Hold the lock as another writer would; a second writer must wait out its budget, then still write.
  writeFileSync(`${file}.lock`, "")
  const started = Date.now()
  updateSyncStatus(root, env, { b: 2 }, file, { waitMs: 60 })
  assert.equal(Date.now() - started < 3000, true, "a held lock delays a writer by its budget only")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1, b: 2 })
  assert.equal(existsSync(`${file}.lock`), true, "a writer that never held the lock leaves the holder's lock alone")
})

test("a lock whose holder died is taken over and removed", () => {
  const root = "/nonexistent/status-lock-root"
  const file = path.join(mkdtempSync(path.join(osTmpdir(), "desk-status-stale-")), "x.status.json")
  writeFileSync(`${file}.lock`, "")
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${file}.lock`, old, old)
  updateSyncStatus(root, env, { c: 3 }, file, { waitMs: 5000 })
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { c: 3 })
  assert.equal(existsSync(`${file}.lock`), false, "the lock is released")
})

test("a stale lock that cannot be removed does not hang the writer", () => {
  const root = "/nonexistent/status-lock-root"
  const dir = mkdtempSync(path.join(osTmpdir(), "desk-status-stuck-"))
  const file = path.join(dir, "x.status.json")
  // A directory in the lock's place: it exists, is old, and unlink refuses it.
  mkdirSync(`${file}.lock`)
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${file}.lock`, old, old)
  updateSyncStatus(root, env, { d: 4 }, file, { waitMs: 30 })
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { d: 4 })
})
