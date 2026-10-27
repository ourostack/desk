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

function endSession(ctx, marker) {
  const run = spawnSync(process.execPath, [SESSION_END, "claude"], { env: { ...ctx.env, NODE_OPTIONS: "" }, input: JSON.stringify(payload(ctx, marker, "SessionEnd")), encoding: "utf8", timeout: 10000 })
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
  ["holder died before writing its process id", () => "", 10000],
]) {
  test(`a session end is recorded at once past a marker lock whose ${name}`, () => scratch(async (ctx) => {
    const marker = await session(ctx)
    const lock = await plantLock(ctx, content(), ageMs)
    endSession(ctx, marker)
    assert.equal(await endRecorded(ctx), true, "the session-end capture recorded the end")
    assert.equal(existsSync(lock), false, "the abandoned lock is gone")
  }))
}

test("a session end waits for a marker lock whose holder is alive, and records the end once that holder is gone", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
  try {
    await plantLock(ctx, JSON.stringify({ pid: holder.pid, started_at: new Date().toISOString() }))
    endSession(ctx, marker)
    assert.equal(await endRecorded(ctx, 3000), false, "a live holder's lock is respected")
  } finally {
    holder.kill("SIGKILL")
  }
  assert.equal(await endRecorded(ctx), true, "the end is recorded once the holder is gone")
}))

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
