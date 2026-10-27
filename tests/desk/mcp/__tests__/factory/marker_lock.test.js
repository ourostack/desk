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

async function endRecorded(ctx, waitMs = WAIT_MS) {
  const deadline = Date.now() + waitMs
  const ended = async () => (await listMarkers(ctx.env))[0]?.end_reason === "prompt_input_exit"
  while (!(await ended()) && Date.now() < deadline) await pause(100)
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
