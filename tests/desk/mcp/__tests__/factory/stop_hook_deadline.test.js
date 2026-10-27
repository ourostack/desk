// The turn-end hook (Claude Stop, Copilot agentStop) waits only for the delivery check, the one part whose answer the host uses.
// Measured on macOS (2026-10-26, Node 22, loaded machine): the bounded child took a median 206 ms, of which the factory capture
// (marker, finalize jobs, loop kick: loading Desk's MCP modules) was 197 ms and the delivery check 7 ms. Windows starts Node and
// loads modules several times slower, so the capture pushed the child past its 1500 ms deadline and the hook reported
// `hook_worker_unavailable` on most turns. The capture now runs detached, as it already did at session end.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { listMarkers } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { ID, scratch, session } from "./_session_helpers.js"

import { runBoundedHook } from "../../../../../plugins/desk/hooks/lib/factory-end.cjs"
const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/factory-end.cjs", import.meta.url))
const WAIT_MS = 30000

const stopPayload = (ctx, marker) => ({ session_id: ID, cwd: ctx.desk, transcript_path: marker.log_path, hook_event_name: "Stop" })

test("the turn-end hook answers after the delivery check alone and leaves a slow capture running detached", (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  const slow = path.join(ctx.base, "slow-capture.cjs")
  await fs.writeFile(slow, 'if (process.argv.includes("--detached")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000)\n')
  const started = performance.now()
  const result = spawnSync(process.execPath, [SCRIPT, "claude"], { env: { ...ctx.env, NODE_OPTIONS: `--require ${JSON.stringify(slow)}` }, input: JSON.stringify(stopPayload(ctx, marker)), encoding: "utf8", timeout: 5000 })
  const elapsed = performance.now() - started
  t.diagnostic(`turn-end hook exited in ${Math.round(elapsed)} ms`)
  assert.equal(result.status, 0, result.stderr)
  // This legacy fixture has no admitted human turn, so the check itself answers; the worker did not run out of time.
  assert.equal(result.stderr, "[desk-delivery] unverified: foreign_session\n")
  assert.ok(elapsed < 3000, `the hook took ${Math.round(elapsed)} ms`)
  assert.equal((await listMarkers(ctx.env)).length, 0, "the hook returned before the capture wrote the marker")
  const deadline = Date.now() + WAIT_MS
  while ((await listMarkers(ctx.env)).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await listMarkers(ctx.env)).length, 1, "the detached capture wrote the marker")
}))

test("the bounded child runs the delivery check only, and takes a fraction of what the capture takes", (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  const input = JSON.stringify(stopPayload(ctx, marker))
  const env = { ...ctx.env, NODE_OPTIONS: "" }
  const time = (args) => {
    const started = performance.now()
    const result = spawnSync(process.execPath, [SCRIPT, "claude", ...args], { env, input, encoding: "utf8", timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    return performance.now() - started
  }
  const bounded = time(["--factory-worker"])
  assert.equal((await listMarkers(ctx.env)).length, 0, "the bounded child writes no marker")
  const capture = time(["--factory-worker", "--detached"])
  assert.equal((await listMarkers(ctx.env)).length, 1, "the capture worker writes the marker")
  t.diagnostic(`bounded child (delivery check) ${Math.round(bounded)} ms; capture worker ${Math.round(capture)} ms; deadline 1500 ms`)
}))

// A stand-in worker: the bounded child behaves as `mode` says, and the detached capture copy exits at once.
async function fakeEntry(ctx, mode) {
  const file = path.join(ctx.base, `fake-${mode}.cjs`)
  const body = {
    slow: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)",
    exit: "process.exit(3)",
    signal: 'process.kill(process.pid, "SIGKILL"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)',
  }[mode]
  await fs.writeFile(file, `if (process.argv.includes("--detached")) process.exit(0)\n${body}\n`)
  return file
}

function collect() {
  let text = ""
  return { stream: new Writable({ write(chunk, _encoding, done) { text += chunk; done() } }), text: () => text }
}

const cases = [
  ["slow", "deadline", false],
  ["exit", "exit 3", false],
  // SIGKILL, because a test runner's preload may handle SIGTERM.
  ["signal", "signal SIGKILL", process.platform === "win32" ? "Windows has no signals" : false],
]
for (const [mode, reason, skip] of cases) {
  test(`a bounded child that fails says why: ${reason}`, { skip }, () => scratch(async (ctx) => {
    const entry = await fakeEntry(ctx, mode)
    const stderr = collect()
    const stdout = collect()
    const input = Readable.from([JSON.stringify({ session_id: ID, cwd: ctx.desk, transcript_path: path.join(ctx.base, "t.jsonl"), hook_event_name: "Stop" })])
    await runBoundedHook("claude", input, entry, { deadlineMs: 700, stderr: stderr.stream, stdout: stdout.stream, env: ctx.env })
    assert.equal(stderr.text(), `[desk-delivery] unverified: hook_worker_unavailable (${reason})\n`)
    assert.equal(stdout.text(), "")
  }))
}
