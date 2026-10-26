import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { scratch } from "./_session_helpers.js"

import { readInput, runHook } from "../../../../../plugins/desk/hooks/lib/sync-end.cjs"
const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/sync-end.cjs", import.meta.url))

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function writeAndCommit(root, name, content, message) {
  await fs.writeFile(path.join(root, name), content)
  git(root, ["add", "--", name])
  git(root, ["commit", "-q", "-m", message])
}

async function mkDeskRepo(ctx) {
  git(ctx.desk, ["init", "-q"])
  git(ctx.desk, ["config", "user.email", "test@example.com"])
  git(ctx.desk, ["config", "user.name", "Test"])
  await writeAndCommit(ctx.desk, "seed.md", "seed\n", "seed")
}

for (const event of ["SessionEnd", "sessionEnd"]) {
  const claude = event === "SessionEnd"

  test(`${event} reports clean on a Git desk with nothing to push`, () => scratch(async (ctx) => {
    await mkDeskRepo(ctx)
    const payload = claude
      ? { session_id: "s", cwd: ctx.desk, hook_event_name: event }
      : { cwd: ctx.desk, reason: "complete" }
    const result = await runHook({ host: claude ? "claude" : "copilot", payload, env: ctx.env })
    assert.equal(result, "clean")
  }))

  test(`${event} reports unpushed, without filing, when real commits are still ahead of a real upstream`, () => scratch(async (ctx) => {
    await mkDeskRepo(ctx)
    const originDir = path.join(ctx.base, "origin.git")
    await fs.mkdir(originDir, { recursive: true })
    git(originDir, ["init", "-q", "--bare"])
    git(ctx.desk, ["remote", "add", "origin", originDir])
    git(ctx.desk, ["push", "-q", "-u", "origin", "HEAD:main"])
    await writeAndCommit(ctx.desk, "more.md", "more\n", "more")

    const payload = claude
      ? { session_id: "s", cwd: ctx.desk, hook_event_name: event }
      : { cwd: ctx.desk, reason: "complete" }
    const result = await runHook({ host: claude ? "claude" : "copilot", payload, env: ctx.env })
    assert.equal(result, "unpushed")

    const { readSyncStatus } = await import("../../../../../plugins/desk/mcp/src/runtime/sync-worker.js")
    const status = readSyncStatus({ root: ctx.desk, env: ctx.env })
    assert.equal(status.blocked, true)
    assert.equal(status.reason, "unpushed_at_session_end")
  }))
}

test("wrong host, wrong event and an unresolvable desk root never throw and never claim unpushed", () => scratch(async (ctx) => {
  await mkDeskRepo(ctx)
  assert.equal(await runHook({ host: "codex", payload: { cwd: ctx.desk }, env: ctx.env }), "invalid")
  assert.equal(await runHook({ host: "claude", payload: { session_id: "s", cwd: ctx.desk, hook_event_name: "Stop" }, env: ctx.env }), "invalid")
  assert.equal(await runHook({ host: "copilot", payload: { cwd: ctx.desk, stopReason: "end_turn" }, env: ctx.env }), "invalid")
  assert.equal(await runHook({ host: "claude", payload: null, env: ctx.env }), "invalid")
  assert.equal(await runHook({ host: "claude", payload: { session_id: "s", hook_event_name: "SessionEnd" }, env: ctx.env }), "invalid")
  const noDeskEnv = { ...ctx.env, DESK: path.join(ctx.base, "nowhere") }
  assert.equal(await runHook({ host: "claude", payload: { session_id: "s", cwd: ctx.desk, hook_event_name: "SessionEnd" }, env: noDeskEnv }), "unavailable")
}))

test("a Copilot session opened in another desk checks that desk, as the server binds it", () => scratch(async (ctx) => {
  await mkDeskRepo(ctx)
  const project = path.join(ctx.base, "project")
  await fs.mkdir(path.join(project, "_meta"), { recursive: true })
  await fs.mkdir(path.join(project, "_archive"))
  await mkDeskRepo({ desk: project })
  const originDir = path.join(ctx.base, "origin.git")
  git(ctx.base, ["init", "-q", "--bare", originDir])
  git(project, ["remote", "add", "origin", originDir])
  git(project, ["push", "-q", "-u", "origin", "HEAD:main"])
  await writeAndCommit(project, "more.md", "more\n", "more")
  const env = { ...ctx.env }
  delete env.DESK
  // The home-folder desk has nothing to push; the project desk has.
  assert.equal(await runHook({ host: "copilot", payload: { cwd: project, reason: "complete" }, env }), "unpushed")
  assert.equal(await runHook({ host: "claude", payload: { session_id: "s", cwd: project, hook_event_name: "SessionEnd" }, env }), "clean")
}))

test("stdin is byte bounded and malformed input finishes silently", async () => {
  assert.deepEqual(await readInput(Readable.from(['{"ok":true}'])), { ok: true })
  for (const input of ["{", "null", "[]", "1", "x".repeat(1024 * 1024 + 1)]) {
    assert.equal(await readInput(Readable.from([input])), null)
  }
  assert.equal(await readInput(new Readable({ read() {} }), 10), null)
})

test("malformed CLI stdin exits zero with no output, well under its own timeout", () => scratch(async ({ env }) => {
  const start = performance.now()
  const result = spawnSync(process.execPath, [SCRIPT, "claude"], { env, input: "{", encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  assert.ok(performance.now() - start < 5000)
}))

test("the CLI exits at once and leaves a slow unpushed check running detached", () => scratch(async (ctx) => {
  await mkDeskRepo(ctx)
  const originDir = path.join(ctx.base, "origin.git")
  await fs.mkdir(originDir, { recursive: true })
  git(originDir, ["init", "-q", "--bare"])
  git(ctx.desk, ["remote", "add", "origin", originDir])
  git(ctx.desk, ["push", "-q", "-u", "origin", "HEAD:main"])
  await writeAndCommit(ctx.desk, "more.md", "more\n", "more")
  // Makes only the worker process slow, as starting Node, loading Desk and running Git is on a loaded machine.
  const slow = path.join(ctx.base, "slow-worker.cjs")
  await fs.writeFile(slow, 'if (process.argv.includes("--worker")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000)\n')
  const env = { ...ctx.env, NODE_OPTIONS: `--require ${JSON.stringify(slow)}` }
  const started = performance.now()
  const result = spawnSync(process.execPath, [SCRIPT, "copilot"], { env, input: JSON.stringify({ cwd: ctx.desk, reason: "complete" }), encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0)
  assert.ok(performance.now() - started < 3000, `the session-end hook took ${Math.round(performance.now() - started)} ms, past Copilot's 3000 ms`)
  const { readSyncStatus } = await import("../../../../../plugins/desk/mcp/src/runtime/sync-worker.js")
  assert.notEqual(readSyncStatus({ root: ctx.desk, env: ctx.env })?.blocked, true, "the hook returned before its worker ran the check")
  const deadline = Date.now() + 30000
  while (readSyncStatus({ root: ctx.desk, env: ctx.env })?.blocked !== true && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(readSyncStatus({ root: ctx.desk, env: ctx.env })?.reason, "unpushed_at_session_end")
}))
