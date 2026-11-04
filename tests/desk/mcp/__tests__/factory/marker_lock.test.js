// The lock around a capture's marker read and write (hooks/lib/factory-end.cjs). Outbox treats a lock as abandoned only after
// 10 minutes, but a detached capture stops itself after 60 s, so a lock left by a capture killed inside that short section must
// not block the session's later captures. And a capture at the end of a turn keeps a recorded end unless the record is absent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { factoryStateRoot, listMarkers } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { MAX_MARKER_BYTES } from "../../../../../plugins/desk/mcp/src/factory/marker.js"
import { ID, scratch, session } from "./_session_helpers.js"

import { runHook } from "../../../../../plugins/desk/hooks/lib/factory-end.cjs"
const SESSION_END = fileURLToPath(new URL("../../../../../plugins/desk/hooks/session-end.cjs", import.meta.url))
const WAIT_MS = 20000

const payload = (ctx, marker, event) => ({ session_id: ID, cwd: ctx.desk, transcript_path: marker.log_path, hook_event_name: event, ...(event === "SessionEnd" ? { reason: "prompt_input_exit" } : {}) })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function plantLock(ctx, content, ageMs = 0) {
  const lock = path.join(await factoryStateRoot(ctx.env), "locks", `marker-claude-code-${ID}.lock`)
  await fs.mkdir(path.dirname(lock), { recursive: true })
  await fs.writeFile(lock, content)
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs)
    await fs.utimes(lock, then, then)
  }
  return lock
}

function endSession(ctx, marker, nodeOptions = "") {
  const run = spawnSync(process.execPath, [SESSION_END, "claude"], { env: { ...ctx.env, NODE_OPTIONS: nodeOptions }, input: JSON.stringify(payload(ctx, marker, "SessionEnd")), encoding: "utf8", timeout: 10000 })
  assert.equal(run.status, 0, run.stderr)
}

const markerLockPath = (root) => path.join(root, "locks", `marker-claude-code-${ID}.lock`)

async function endRecorded(ctx, waitMs = WAIT_MS, { clock = Date.now, onCheck = () => {} } = {}) {
  const deadline = clock() + waitMs
  const lock = markerLockPath(await factoryStateRoot(ctx.env))
  const ended = async () => {
    const complete = (await listMarkers(ctx.env))[0]?.end_reason === "prompt_input_exit" && !existsSync(lock)
    onCheck(complete)
    return complete
  }
  while (!(await ended()) && clock() < deadline) await pause(100)
  return ended()
}

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid

for (const [name, content, ageMs] of [
  ["holder's process has ended", () => JSON.stringify({ pid: deadPid(), started_at: new Date().toISOString() }), 0],
  ["holder died before writing its process id", () => "", 60000],
]) {
  test(`a session end is recorded at once past a marker lock whose ${name}`, () => scratch(async (ctx) => {
    const marker = await session(ctx)
    const lock = await plantLock(ctx, content(), ageMs)
    endSession(ctx, marker)
    assert.equal(await endRecorded(ctx), true, "the session-end capture recorded the end")
    assert.equal(existsSync(lock), false, "the abandoned lock is gone")
  }))
}

test("marker replacement visibility precedes owned lock retirement", (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  const lock = await plantLock(ctx, "", 60000)
  const old = await fs.stat(lock, { bigint: true })
  const markerFile = path.join(path.dirname(path.dirname(lock)), "markers", `claude-code-${ID}.json`)
  let release
  const held = new Promise((resolve) => { release = resolve })
  let signalVisible
  const visible = new Promise((resolve) => { signalVisible = resolve })
  const rename = fs.rename
  const unlink = fs.unlink
  let gated = false
  let replacement
  let replacementPid
  let unlinkAttempts = 0
  let unlinkCompleted = 0
  const renameMock = t.mock.method(fs, "rename", async (from, to, ...rest) => {
    const result = await rename(from, to, ...rest)
    if (to === markerFile && !gated) {
      gated = true
      replacement = await fs.stat(lock, { bigint: true })
      replacementPid = JSON.parse(await fs.readFile(lock, "utf8")).pid
      signalVisible()
      await held
    }
    return result
  })
  const unlinkMock = t.mock.method(fs, "unlink", async (file, ...rest) => {
    if (file !== lock) return unlink(file, ...rest)
    unlinkAttempts += 1
    const result = await unlink(file, ...rest)
    unlinkCompleted += 1
    return result
  })
  const worker = runHook({ host: "claude", payload: payload(ctx, marker, "SessionEnd"), env: ctx.env, launch: async () => {}, supportsFinalize: false })
  let completion
  try {
    await Promise.race([visible, worker.then(() => { throw new Error("capture finished before the marker-rename gate") })])
    assert.equal((await listMarkers(ctx.env))[0]?.end_reason, "prompt_input_exit", "the original marker-only predicate is already true")
    assert.equal(replacementPid, process.pid, "the current lock belongs to this actual capture")
    assert.notDeepEqual([replacement.dev, replacement.ino, replacement.mtimeNs], [old.dev, old.ino, old.mtimeNs], "the abandoned lock identity was replaced")
    assert.equal(existsSync(lock), true)
    assert.throws(() => assert.equal(existsSync(lock), false, "the abandoned lock is gone"), assert.AssertionError, "the original pathname assertion fails during a legitimate replacement lock")
    let checked
    let checkFailed
    const observed = new Promise((resolve, reject) => { checked = resolve; checkFailed = reject })
    let completionSettled = false
    completion = endRecorded(ctx, WAIT_MS, { onCheck: (complete) => checked(complete) })
    completion.then(() => { completionSettled = true }, (error) => { completionSettled = true; checkFailed(error) })
    assert.equal(await observed, false, "the completion predicate sees the still-held lock")
    assert.equal(completionSettled, false)
    assert.equal(unlinkAttempts, 0)
    release()
    assert.equal(await worker, "written")
    assert.equal(await completion, true)
    assert.equal(unlinkAttempts, 1)
    assert.equal(unlinkCompleted, 1)
    assert.equal(existsSync(lock), false, "the replacement owner's lock was retired")
  } finally {
    release()
    try {
      await Promise.allSettled(completion ? [worker, completion] : [worker])
    } finally {
      unlinkMock.mock.restore()
      renameMock.mock.restore()
    }
  }
}))

test("marker completion refuses a persistent owned-lock unlink failure", (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  const lock = await plantLock(ctx, "", 60000)
  const old = await fs.stat(lock, { bigint: true })
  const unlink = fs.unlink
  let unlinkAttempts = 0
  const mock = t.mock.method(fs, "unlink", async (file, ...rest) => {
    if (file !== lock) return unlink(file, ...rest)
    unlinkAttempts += 1
    throw Object.assign(new Error("synthetic owned-lock unlink refusal"), { code: "EPERM" })
  })
  const worker = runHook({ host: "claude", payload: payload(ctx, marker, "SessionEnd"), env: ctx.env, launch: async () => {}, supportsFinalize: false })
  try {
    assert.equal(await worker, "written", "the existing hook swallows cleanup failure; this is not cleanup success")
    assert.equal((await listMarkers(ctx.env))[0]?.end_reason, "prompt_input_exit")
    const current = await fs.stat(lock, { bigint: true })
    assert.notDeepEqual([current.dev, current.ino, current.mtimeNs], [old.dev, old.ino, old.mtimeNs])
    assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).pid, process.pid)
    assert.equal(unlinkAttempts, 1)
    const start = Date.now()
    let clockReads = 0
    let checks = 0
    const complete = await endRecorded(ctx, WAIT_MS, {
      clock: () => clockReads++ === 0 ? start : start + WAIT_MS + 1,
      onCheck: () => { checks += 1 },
    })
    assert.equal(clockReads, 2, "one original deadline, not another waiting window")
    assert.equal(checks, 2)
    assert.equal(complete, false, "old identity retirement cannot hide failed replacement cleanup")
    assert.equal(existsSync(lock), true)
  } finally {
    try { await Promise.allSettled([worker]) } finally { mock.mock.restore() }
  }
}))

const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
const named = (pid) => JSON.stringify({ pid, started_at: new Date().toISOString() })
// A process that exists but refuses the check (EPERM): the system's first process, for a user other than root.
const refusingPid = () => {
  const pid = process.platform === "win32" ? 4 : 1
  try { process.kill(pid, 0) } catch (error) { if (error.code === "EPERM") return pid }
  return null
}

// Each case plants a lock that must be respected, checks that the session end waits for it, then releases it.
const respected = [
  ["is held by a live process", async (ctx) => {
    const holder = sleeper()
    await plantLock(ctx, named(holder.pid))
    return { release: () => holder.kill("SIGKILL") }
  }],
  ["is held by a process that refuses the process check", async (ctx, t) => {
    const pid = refusingPid()
    if (pid === null) return t.skip("no process here refuses the check")
    const lock = await plantLock(ctx, named(pid))
    return { release: () => fs.unlink(lock).catch(() => {}) }
  }],
  ["has no process id yet, and was created 10 s ago", async (ctx) => {
    const lock = await plantLock(ctx, "", 10000)
    return { release: () => fs.unlink(lock).catch(() => {}) }
  }],
  // Two waiters judge the same abandoned lock: the other one removes it and takes the lock in the instant before this one
  // removes it. The worker's preload stands in for the other waiter at that instant.
  ["was abandoned, but another waiter replaced it just before this one removed it", async (ctx) => {
    const holder = sleeper()
    const lock = await plantLock(ctx, named(deadPid()))
    const preload = path.join(ctx.base, "other-waiter.cjs")
    await fs.writeFile(preload, `const fs = require("node:fs")
const lock = ${JSON.stringify(lock)}
const unlink = fs.unlinkSync
let replaced = false
for (const name of ["renameSync", "unlinkSync"]) {
  const original = fs[name]
  fs[name] = function (file, ...rest) {
    if (!replaced && file === lock) {
      replaced = true
      unlink(lock)
      fs.writeFileSync(lock, ${JSON.stringify(named(holder.pid))})
    }
    return original.call(this, file, ...rest)
  }
}
`)
    return { nodeOptions: `--require ${JSON.stringify(preload)}`, release: () => holder.kill("SIGKILL"), lock, holder: holder.pid }
  }],
]
for (const [name, plant] of respected) {
  test(`a session end waits for a marker lock that ${name}, and is recorded once it is released`, (t) => scratch(async (ctx) => {
    const marker = await session(ctx)
    const planted = await plant(ctx, t)
    if (!planted) return
    try {
      endSession(ctx, marker, planted.nodeOptions)
      assert.equal(await endRecorded(ctx, 5000), false, "the lock is respected")
      if (planted.lock) assert.equal(JSON.parse(await fs.readFile(planted.lock, "utf8")).pid, planted.holder, "the other waiter's lock is still in place")
    } finally {
      await planted.release()
    }
    assert.equal(await endRecorded(ctx), true, "the end is recorded once the lock is released")
  }))
}

const unreadable = [
  ["the record cannot be read", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX file modes and a non-root user" : false },
    (file) => fs.chmod(file, 0o000), (file) => fs.chmod(file, 0o600)],
  ["the record is too large to read", {},
    async (file) => fs.appendFile(file, " ".repeat(MAX_MARKER_BYTES)), async () => {}],
]
for (const [name, options, spoil, restore] of unreadable) {
  test(`a turn-end capture never replaces a recorded end when ${name}`, options, () => scratch(async (ctx) => {
    const marker = await session(ctx)
    const run = (event) => runHook({ host: "claude", payload: payload(ctx, marker, event), env: ctx.env, launch: async () => {}, supportsFinalize: false })
    assert.equal(await run("SessionEnd"), "written")
    const file = path.join(await factoryStateRoot(ctx.env), "markers", `claude-code-${ID}.json`)
    await spoil(file)
    const before = await fs.stat(file, { bigint: true })
    await run("Stop")
    await restore(file)
    const after = await fs.stat(file, { bigint: true })
    assert.equal(after.ino, before.ino, "the recorded marker was not replaced")
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).end_reason, "prompt_input_exit")
  }))
}

test("a turn-end capture with no record yet still writes one", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  assert.equal(await runHook({ host: "claude", payload: payload(ctx, marker, "Stop"), env: ctx.env, launch: async () => {}, supportsFinalize: false }), "written")
  const [saved] = await listMarkers(ctx.env)
  assert.equal(saved.session_id, ID)
  assert.equal(saved.end_reason, null)
}))
