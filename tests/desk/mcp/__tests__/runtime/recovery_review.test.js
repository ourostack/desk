import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import vm from "node:vm"
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, existsSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { removeTree } from "../_remove_tree.js"
import { startOrJoinRecovery, readRecoveryStatus, recoveryBinding, runRecoveryWorker } from "../../../../../plugins/desk/mcp/src/runtime/recovery-state.js"
import { readSyncStatus, updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { syncDegradation } from "../../../../../plugins/desk/mcp/src/runtime/health.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
import { runBlock } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"

const recoverySource = readFileSync(new URL("../../../../../plugins/desk/mcp/src/runtime/recovery-state.js", import.meta.url), "utf8")
const settleStart = recoverySource.indexOf("const settle = async (result) => {")
const settleSource = recoverySource.slice(settleStart, recoverySource.indexOf("\n      try {", settleStart))

async function observeClosure(sequence, deadline = 3000) {
  let now = 0
  let stopped = null
  let result = null
  const reads = []
  const queue = [...sequence]
  const context = vm.createContext({
    Date: { now: () => now }, message: { deadline }, token: "fixture",
    process: { pid: 100, connected: true, send: (message) => { if (message.kind === "result") result = message.status } },
    watchdog: { pid: 101 }, resultReady: false,
    groupInventory: (_group, _exclude, options) => {
      const next = queue.length > 1 ? queue.shift() : queue[0]
      const timeout = options?.timeout ?? 250
      reads.push({ at: now, timeout })
      now += Math.min(next.cost ?? 0, timeout)
      return next
    },
    pause: async (ms) => { now += ms }, stop: (reason) => { stopped = { reason, at: now } },
  })
  await vm.runInContext(`${settleSource}; settle`, context)({ status: 0 })
  return { now, stopped, result, reads }
}

for (const laterEmpty of [true, false]) test(`activated descendant grace survives unknown inventory; laterEmpty=${laterEmpty}`, async () => {
  const live = { known: true, members: [{ pid: 102 }] }
  const unknown = { known: false, members: null, cost: 250 }
  const sequence = laterEmpty ? [live, unknown, { known: true, members: [] }] : [live, unknown]
  const result = await observeClosure(sequence)
  assert.equal(result.result, null)
  assert.equal(result.stopped?.reason, "descendants_outlived_command")
  assert.equal(result.stopped?.at, 250)
  assert.ok(result.reads[1].timeout < 250)
})

test("positive-only closure observations retain the 250ms cleanup grace", async () => {
  const result = await observeClosure([{ known: true, members: [{ pid: 102 }] }])
  assert.equal(result.result, null)
  assert.equal(result.stopped?.at, 250)
})

test("never-positive unknown closure retries use the original whole deadline", async () => {
  const unknown = { known: false, members: null, cost: 250 }
  const recovered = await observeClosure([unknown, { known: true, members: [] }])
  assert.equal(recovered.result, 0)
  assert.equal(recovered.stopped, null)
  const persistent = await observeClosure([unknown])
  assert.equal(persistent.result, null)
  assert.equal(persistent.stopped?.reason, "helper_closure_unknown")
  assert.equal(persistent.stopped?.at, 3000)
})

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-review-actor-free-"))
  t.after(() => removeTree(dir))
  const root = path.join(dir, "root")
  const home = path.join(dir, "home")
  mkdirSync(path.join(root, ".git", "objects"), { recursive: true })
  mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true })
  mkdirSync(home)
  const config = `[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = ${path.join(dir, "not-contacted.git")}\n[branch "main"]\nremote = origin\nmerge = refs/heads/main\n`
  writeFileSync(path.join(root, ".git", "config"), config)
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
  const object = (type, text) => {
    const bytes = Buffer.from(`${type} ${Buffer.byteLength(text)}\0${text}`)
    const id = createHash("sha1").update(bytes).digest("hex")
    const folder = path.join(root, ".git", "objects", id.slice(0, 2))
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, id.slice(2)), deflateSync(bytes))
    return id
  }
  const tree = object("tree", "")
  const head = object("commit", `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nseed\n`)
  writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${head}\n`)
  const env = { ...process.env, HOME: home, GH_CONFIG_DIR: path.join(home, "gh"), XDG_STATE_HOME: path.join(dir, "state"),
    PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_EXEC_PATH: "/Library/Developer/CommandLineTools/usr/libexec/git-core" }
  for (const key of Object.keys(env)) {
    if (/^(GIT_CONFIG_(?:KEY|VALUE)_|GIT_CONFIG_COUNT$|GIT_CONFIG_PARAMETERS$|GIT_CONFIG_SYSTEM$|GIT_CONFIG_GLOBAL$|GH_TOKEN$|GITHUB_TOKEN$)/u.test(key)) delete env[key]
  }
  const spawnImpl = () => Object.assign(new EventEmitter(), { pid: process.pid, unref() {} })
  return { dir, root, env, head, config, spawnImpl }
}

async function reservation(f) {
  const result = await startOrJoinRecovery({ ...f, waitMs: 0 })
  const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
  const folder = path.join(sync, readdirSync(sync).find((name) => name.endsWith(".recovery")))
  const file = path.join(folder, `${result.operation.id}.json`)
  return { id: result.operation.id, file, record: JSON.parse(readFileSync(file, "utf8")) }
}

async function completed(f) {
  const operation = await reservation(f)
  const record = { ...operation.record, binding: recoveryBinding(f.root, f.env), state: "synced", custody: "accepted", finalized: true,
    incoming: { state: "verified", head: f.head }, outgoing: { state: "verified" },
    source: { state: "current", head: f.head }, lfs: { state: "not_required" }, resources: { childrenClosed: true } }
  writeFileSync(operation.file, JSON.stringify(record))
  assert.equal(readRecoveryStatus(f).state, "synced", "The unchanged historical fixture is applicable before substitution")
  return record
}

test("R5 a new reservation preserves the known incoming failure in the main status read", async (t) => {
  const f = fixture(t)
  const failure = { state: "unresolved", reason: "prior incoming failure", at: "2026-10-30T00:00:00.000Z" }
  updateSyncStatus(f.root, f.env, { last_pull: failure })
  await reservation(f)
  const status = readSyncStatus(f)
  assert.equal(status.last_pull?.reason, failure.reason)
  const compact = compactStatus({ status: "ok", root: { path: f.root }, sync: status })
  assert.equal(compact.state, "degraded")
})

test("local hook-policy changes invalidate previously verified recovery evidence", async (t) => {
  const f = fixture(t)
  await completed(f)
  mkdirSync(path.join(f.root, ".git", "hooks"))
  writeFileSync(path.join(f.root, ".git", "hooks", "reference-transaction"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  assert.equal(readRecoveryStatus(f).state, "unknown")
  assert.equal(recoveryBinding(f.root, f.env).referenceHook.qualified, false)
})

test("R2 linked repository directory replacement cannot reuse cached synchronization", async (t) => {
  const f = fixture(t)
  const common = path.join(f.dir, "common.git")
  renameSync(path.join(f.root, ".git"), common)
  writeFileSync(path.join(f.root, ".git"), `gitdir: ${common}\n`)
  const prior = await completed(f)
  const previous = path.join(f.dir, "previous.git")
  renameSync(common, previous)
  mkdirSync(common)
  for (const name of readdirSync(previous)) renameSync(path.join(previous, name), path.join(common, name))
  assert.notEqual(recoveryBinding(f.root, f.env).key, prior.binding.key)
  assert.equal(readRecoveryStatus(f).state, "unknown")
})

test("R2 redirecting a linked common directory cannot reuse unchanged old files", async (t) => {
  const f = fixture(t)
  const other = fixture(t)
  const common = path.join(f.dir, "common.git")
  const admin = path.join(f.dir, "admin")
  renameSync(path.join(f.root, ".git"), common)
  mkdirSync(admin)
  writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(path.join(admin, "commondir"), "../common.git\n")
  writeFileSync(path.join(f.root, ".git"), "gitdir: ../admin\n")
  updateSyncStatus(f.root, f.env, { last_pull: { state: "unresolved", reason: "known before verified fetch" } })
  const prior = await completed(f)
  assert.equal(readSyncStatus(f).last_pull, null)
  writeFileSync(path.join(admin, "commondir"), `${path.join(other.root, ".git")}\n`)
  assert.notEqual(recoveryBinding(f.root, f.env).key, prior.binding.key)
  assert.equal(readRecoveryStatus(f).state, "unknown")
  assert.equal(readRecoveryStatus(f).historicalState, "synced")
  assert.equal(readSyncStatus(f).last_pull.reason, "known before verified fetch")
})

test("R2 an unreadable common-directory pointer cannot reuse cached synchronization", async (t) => {
  const f = fixture(t)
  await completed(f)
  symlinkSync(path.join(f.dir, "missing-pointer"), path.join(f.root, ".git", "commondir"))
  assert.equal(readRecoveryStatus(f).state, "unknown")
})

test("R2 redirecting a gitfile admin symlink cannot reuse cached synchronization", async (t) => {
  const f = fixture(t)
  const other = fixture(t)
  const original = path.join(f.dir, "original.git")
  const pointer = path.join(f.dir, "admin")
  renameSync(path.join(f.root, ".git"), original)
  symlinkSync(original, pointer, "dir")
  writeFileSync(path.join(f.root, ".git"), `gitdir: ${pointer}\n`)
  const prior = await completed(f)
  unlinkSync(pointer)
  symlinkSync(path.join(other.root, ".git"), pointer, "dir")
  assert.notEqual(recoveryBinding(f.root, f.env).key, prior.binding.key)
  assert.equal(readRecoveryStatus(f).state, "unknown")
})

test("R2 cached no-upstream evidence cannot survive switching to a tracked branch", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, ".git", "HEAD"), "ref: refs/heads/feature\n")
  const operation = await reservation(f)
  const binding = recoveryBinding(f.root, f.env)
  assert.equal(binding.nothingToSync, "no_upstream")
  writeFileSync(operation.file, JSON.stringify({ ...operation.record, binding, state: "synced",
    finalized: true, nothingToSync: "no_upstream" }))
  assert.equal(readRecoveryStatus(f).state, "synced")
  writeFileSync(path.join(f.root, ".git", "HEAD"), "ref: refs/heads/main\n")
  assert.equal(recoveryBinding(f.root, f.env).nothingToSync, undefined)
  assert.equal(readRecoveryStatus(f).state, "unknown")
})

test("R2 cached no-remote evidence still requires the current symbolic branch", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, ".git", "config"), "[core]\nrepositoryformatversion=0\nbare=false\n")
  const operation = await reservation(f)
  const binding = recoveryBinding(f.root, f.env)
  assert.equal(binding.nothingToSync, "no_remote")
  writeFileSync(operation.file, JSON.stringify({ ...operation.record, binding, state: "synced",
    finalized: true, nothingToSync: "no_remote" }))
  assert.equal(readRecoveryStatus(f).state, "synced")
  writeFileSync(path.join(f.root, ".git", "HEAD"), "ref: refs/heads/feature\n")
  assert.equal(readRecoveryStatus(f).state, "unknown")
})

test("R5 boot health also retains known failure while new custody is pending", async (t) => {
  const f = fixture(t)
  updateSyncStatus(f.root, f.env, { last_pull: { state: "unresolved", reason: "known incoming failure" } })
  const result = await startOrJoinRecovery({ ...f, waitMs: 0 })
  assert.match(syncDegradation(result) ?? "", /known incoming failure/u)
})

async function noWorkWithFailure(t, kind) {
  const f = fixture(t)
  writeFileSync(path.join(f.root, ".git", "config"), kind === "no_remote"
    ? "[core]\nrepositoryformatversion=0\nbare=false\n"
    : `[core]\nrepositoryformatversion=0\nbare=false\n[remote "origin"]\nurl=${path.join(f.dir, "not-contacted.git")}\n`)
  const failure = { state: "unresolved", reason: "known incoming failure before no-work" }
  updateSyncStatus(f.root, f.env, { last_pull: failure })
  const op = await reservation(f)
  await runRecoveryWorker({ root: f.root, env: f.env, id: op.id,
    acquireLock: async () => assert.fail("A no-work result cannot acquire native mutation custody") })
  const status = readSyncStatus(f)
  t.diagnostic(JSON.stringify({ noWorkBeforeAnyNextReservation: kind, status, rawOperation: JSON.parse(readFileSync(op.file, "utf8")) }))
  assert.equal(status.recovery.nothingToSync, kind)
  assert.equal(status.recovery.incoming.state, "not_dispatched")
  return { f, status, failure }
}

for (const kind of ["no_remote", "no_upstream"]) test(`R5 ${kind} settlement does not resolve a known incoming failure`, async (t) => {
  const { status, failure } = await noWorkWithFailure(t, kind)
  assert.equal(status.last_pull?.reason, failure.reason)
})

test("R5 no-work settlement retains incoming failure in boot and compact health", async (t) => {
  const { status } = await noWorkWithFailure(t, "no_remote")
  assert.match(syncDegradation({ state: "synced", nothingToSync: "no_remote", operation: status.recovery }) ?? "", /known incoming failure/u)
  const compact = compactStatus({ status: "ok", root: { path: "/fixture" }, sync: {
    configured: false, last_pull: null, recovery: status.recovery,
  } })
  assert.equal(compact.state, "degraded")
})

test("R5 another reservation cannot turn no-work into incoming-resolution lineage", async (t) => {
  const { f, failure } = await noWorkWithFailure(t, "no_remote")
  const next = await reservation(f)
  assert.equal(next.record.priorFailure?.reason, failure.reason)
  assert.equal(next.record.resolvedBeforeFingerprint, null)
})

test("R5 repeated no-work without failure remains healthy and does not invent incoming history", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, ".git", "config"), "[core]\nrepositoryformatversion=0\nbare=false\n")
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const op = await reservation(f)
    await runRecoveryWorker({ root: f.root, env: f.env, id: op.id, acquireLock: async () => assert.fail("No native custody needed") })
    const status = readSyncStatus(f)
    assert.equal(status.last_pull, null)
    assert.equal(status.recovery.priorFailure, null)
    assert.equal(syncDegradation({ state: "synced", operation: status.recovery }), null)
  }
})

test("R5 a later incoming failure is not cleared by an older completed record", async (t) => {
  const f = fixture(t)
  await completed(f)
  updateSyncStatus(f.root, f.env, { last_pull: { state: "unresolved", reason: "newer incoming failure" } })
  assert.equal(readSyncStatus(f).last_pull?.reason, "newer incoming failure")
})

test("R5 prior check barriers remain separate and visible during the next reservation", async (t) => {
  const f = fixture(t)
  const previous = await completed(f)
  const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
  const folder = path.join(sync, readdirSync(sync).find((name) => name.endsWith(".recovery")))
  writeFileSync(path.join(folder, `${previous.id}.json`), JSON.stringify({ ...previous, checks: { state: "blocked", reason: "migration_pending" } }))
  writeFileSync(path.join(folder, "latest.json"), JSON.stringify({ id: previous.id }))
  unlinkSync(path.join(folder, "active.json"))
  await reservation(f)
  const status = readSyncStatus(f)
  const compact = compactStatus({ status: "ok", root: { path: f.root }, sync: status })
  assert.equal(compact.state, "degraded")
  assert.match(compact.degraded.join("\n"), /background checks.*migration_pending/u)
  assert.equal(status.last_pull ?? null, null, "A check barrier must not become an incoming failure")
})

test("R1 missing custody indexes do not authorize replacing an orphan operation", async (t) => {
  const f = fixture(t)
  const operation = await reservation(f)
  unlinkSync(path.join(path.dirname(operation.file), "active.json"))
  const result = await startOrJoinRecovery({ ...f, waitMs: 0 })
  assert.equal(result.state, "unresolved")
  assert.equal(readdirSync(path.dirname(operation.file)).filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name)).length, 1)
})

test("R2 the worker's local context is the captured root rather than the caller checkout", async (t) => {
  const f = fixture(t)
  let context
  f.spawnImpl = (_command, _args, options) => {
    context = options.cwd
    return Object.assign(new EventEmitter(), { pid: process.pid, unref() {} })
  }
  await reservation(f)
  assert.equal(context, f.root)
})

test("R1 a block in an owned inspection container cannot detach from that container", async () => {
  let settings
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} })
  const child = Object.assign(new EventEmitter(), { pid: 987654, stdout: stream(), stderr: stream() })
  const running = runBlock("exit 0", {
    env: { PATH: "/usr/bin:/bin" }, timeoutMs: 1000, containment: { pid: process.pid, start: "fixture container generation" },
    spawn: (_command, _args, options) => {
      settings = options
      queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null) })
      return child
    },
  })
  await running
  assert.equal(settings.detached, false)
})

test("R2 a completed record is not current after repository replacement", async (t) => {
  const f = fixture(t)
  await completed(f)
  renameSync(f.root, path.join(f.dir, "retired"))
  mkdirSync(path.join(f.root, ".git"), { recursive: true })
  const result = readRecoveryStatus(f)
  assert.notEqual(result.state, "synced")
  assert.equal(result.historicalState, "synced")
})

test("R2 a completed record is not current after a route change", async (t) => {
  const f = fixture(t)
  await completed(f)
  writeFileSync(path.join(f.root, ".git", "config"), f.config.replace("not-contacted.git", "substituted.git"))
  const result = readRecoveryStatus(f)
  assert.notEqual(result.state, "synced")
  assert.equal(result.historicalState, "synced")
})

test("R2 a completed record is not current for another activation", async (t) => {
  const f = fixture(t)
  await completed(f)
  const result = readRecoveryStatus({ ...f, env: { ...f.env, DESK_ACTIVATION_ID: "another activation" } })
  assert.notEqual(result.state, "synced")
})

for (const start of [null, "a different process generation"]) {
  test(`R3 an accepted owner with ${start === null ? "missing" : "mismatched"} generation remains unknown`, async (t) => {
    const f = fixture(t)
    const operation = await reservation(f)
    writeFileSync(operation.file, JSON.stringify({ ...operation.record, state: "running", custody: "accepted",
      owner: { pid: process.pid, start }, resources: { childrenClosed: true } }))
    const result = readRecoveryStatus(f)
    assert.equal(result.state, "unknown")
    assert.equal(result.custody, "unknown")
  })
}

test("R3 a live helper with a recycled generation cannot inherit custody", async (t) => {
  const f = fixture(t)
  const operation = await reservation(f)
  const start = await readProcessStart(process.pid)
  assert.ok(start)
  writeFileSync(operation.file, JSON.stringify({ ...operation.record, state: "running", custody: "accepted",
    owner: { pid: process.pid, start }, resources: { childrenClosed: true } }))
  assert.equal(readRecoveryStatus(f).state, "running")
  writeFileSync(operation.file, JSON.stringify({ ...operation.record, state: "running", custody: "accepted",
    owner: { pid: process.pid, start },
    resources: { childrenClosed: false, childPid: process.pid, start: "original helper generation" } }))
  const result = readRecoveryStatus(f)
  assert.equal(result.state, "unknown")
  assert.equal(result.reason, "helper_generation_mismatch")
})

test("R3 unfinalized success cannot hide an unverifiable settlement owner", async (t) => {
  const f = fixture(t)
  await completed(f)
  const folder = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
  const state = path.join(folder, readdirSync(folder).find((name) => name.endsWith(".recovery")))
  const pointer = JSON.parse(readFileSync(path.join(state, "active.json"), "utf8"))
  const file = path.join(state, `${pointer.id}.json`)
  const record = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...record, finalized: false, owner: { pid: process.pid, start: "replaced settlement owner" } }))
  const result = readRecoveryStatus(f)
  assert.equal(result.state, "unknown")
  assert.equal(result.custody, "unknown")
})

test("R3 the independently surviving watchdog also requires its actual generation", async (t) => {
  const f = fixture(t)
  const operation = await reservation(f)
  const start = await readProcessStart(process.pid)
  assert.ok(start)
  writeFileSync(operation.file, JSON.stringify({ ...operation.record, state: "running", custody: "accepted",
    owner: { pid: process.pid, start }, resources: { childrenClosed: false, childPid: process.pid, start,
      watchdog: { pid: process.pid, start: "recycled watchdog generation" } } }))
  const result = readRecoveryStatus(f)
  assert.equal(result.state, "unknown")
  assert.equal(result.reason, "watchdog_generation_mismatch")
})

test("R6 an invalid-root CLI does not load the full runtime graph before returning", async (t) => {
  const f = fixture(t)
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  const missing = path.join(f.dir, "missing")
  const result = spawnSync(process.execPath, [script, "--json"], { cwd: f.dir, env: { ...f.env, DESK: missing, NODE_DEBUG: "esm" },
    encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  const boot = JSON.parse(result.stdout)
  assert.equal(boot.status, "degraded")
  assert.equal(boot.root.path, missing)
  assert.equal(/\/src\/factory\/(?:flush|pipeline)|\/runtime\/(?:boot|boot-dependencies)\.js/u.test(result.stderr), false,
    "Foreground root validation must not load full boot, dependency restoration or the factory pipeline")
  assert.equal(existsSync(f.env.XDG_STATE_HOME), false)
})

test("R6 a missing binding remains setup_required without starting recovery", async (t) => {
  const f = fixture(t)
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  const env = { HOME: f.env.HOME, GH_CONFIG_DIR: f.env.GH_CONFIG_DIR, XDG_STATE_HOME: f.env.XDG_STATE_HOME, PATH: f.env.PATH }
  const result = spawnSync(process.execPath, [script, "--json", "--task", "named task", "--task-only"], {
    cwd: f.dir, env, encoding: "utf8", timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  const boot = JSON.parse(result.stdout)
  assert.equal(boot.status, "setup_required")
  assert.equal(boot.sync, null)
  assert.equal(existsSync(f.env.XDG_STATE_HOME), false)
})

test("R6 explicit background inspection keeps its root gate before effects", async (t) => {
  const f = fixture(t)
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  const result = spawnSync(process.execPath, [script, "--background", "--json"], {
    cwd: f.dir, env: { ...f.env, DESK: path.join(f.dir, "missing") }, encoding: "utf8", timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  const boot = JSON.parse(result.stdout)
  assert.equal(boot.status, "degraded")
  assert.match(boot.degraded.join("\n"), /refused a substituted desk binding/u)
  assert.equal(existsSync(f.env.XDG_STATE_HOME), false)
})
