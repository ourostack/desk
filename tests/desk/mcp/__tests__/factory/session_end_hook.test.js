// Session end is one hook command per host: hooks/session-end.cjs reads the payload once and hands it to one detached worker that
// runs both the factory capture (lib/factory-end.cjs) and the unpushed-commit check (lib/sync-end.cjs). On Windows each registered
// command is its own PowerShell process, about 0.75 s before any work, so one command instead of two is the saving.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { listMarkers } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { readSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { ID, scratch, session } from "./_session_helpers.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const SCRIPT = path.join(plugin, "hooks", "session-end.cjs")
const claude = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).hooks
const copilot = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json"), "utf8")).hooks
const WAIT_MS = 30000

test("each host registers exactly one session-end command, and it is session-end.cjs", () => {
  assert.deepEqual(copilot.sessionEnd, [
    { type: "command", bash: 'node "${PLUGIN_ROOT}/hooks/session-end.cjs" copilot', powershell: 'node "${PLUGIN_ROOT}/hooks/session-end.cjs" copilot', timeoutSec: 3 },
  ])
  assert.deepEqual(claude.SessionEnd, [
    { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.cjs" claude', timeout: 5 }] },
  ])
  // The per-turn events keep only the factory end hook: the unpushed check never runs on every turn.
  const perTurn = [...claude.Stop.flatMap((group) => group.hooks.map((hook) => hook.command)), ...copilot.agentStop.flatMap((hook) => [hook.bash, hook.powershell])]
  for (const command of perTurn) assert.match(command, /factory-end\.cjs/u)
})

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
}

async function unpushedDesk(ctx) {
  git(ctx.desk, ["init", "-q"])
  git(ctx.desk, ["config", "user.email", "test@example.com"])
  git(ctx.desk, ["config", "user.name", "Test"])
  await fs.writeFile(path.join(ctx.desk, "seed.md"), "seed\n")
  git(ctx.desk, ["add", "seed.md"])
  git(ctx.desk, ["commit", "-q", "-m", "seed"])
  const origin = path.join(ctx.base, "origin.git")
  await fs.mkdir(origin, { recursive: true })
  git(origin, ["init", "-q", "--bare"])
  git(ctx.desk, ["remote", "add", "origin", origin])
  git(ctx.desk, ["push", "-q", "-u", "origin", "HEAD:main"])
  await fs.writeFile(path.join(ctx.desk, "more.md"), "more\n")
  git(ctx.desk, ["add", "more.md"])
  git(ctx.desk, ["commit", "-q", "-m", "more"])
}

async function until(check) {
  const deadline = Date.now() + WAIT_MS
  while (!(await check()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  return check()
}

test("one session-end run exits at once and its one detached worker records both the factory marker and the unpushed check", (t) => scratch(async (ctx) => {
  await unpushedDesk(ctx)
  const marker = await session(ctx)
  // Makes only the worker slow, as starting Node, loading Desk and running Git is on a loaded machine.
  const slow = path.join(ctx.base, "slow-worker.cjs")
  await fs.writeFile(slow, 'if (process.argv.includes("--worker")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000)\n')
  const env = { ...ctx.env, NODE_OPTIONS: `--require ${JSON.stringify(slow)}` }
  const input = JSON.stringify({ session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "SessionEnd", reason: "prompt_input_exit" })
  const started = performance.now()
  const result = spawnSync(process.execPath, [SCRIPT, "claude"], { env, input, encoding: "utf8", timeout: 5000 })
  const elapsed = performance.now() - started
  t.diagnostic(`session-end hook exited in ${Math.round(elapsed)} ms`)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  assert.ok(elapsed < 3000, `the session-end hook took ${Math.round(elapsed)} ms, past Copilot's 3000 ms`)
  assert.equal((await listMarkers(ctx.env)).length, 0, "the hook returned before its worker wrote the marker")
  assert.equal(await until(async () => (await listMarkers(ctx.env)).length === 1), true, "the worker wrote the factory marker")
  const [saved] = await listMarkers(ctx.env)
  assert.equal(saved.session_id, ID)
  assert.equal(saved.end_reason, "prompt_input_exit")
  assert.equal(await until(async () => readSyncStatus({ root: ctx.desk, env: ctx.env })?.reason === "unpushed_at_session_end"), true, "the same worker ran the unpushed check")
}))

test("a Copilot sessionEnd payload reaches both jobs too", () => scratch(async (ctx) => {
  await unpushedDesk(ctx)
  await session(ctx, "copilot-cli")
  const input = JSON.stringify({ sessionId: ID, cwd: ctx.desk, timestamp: Date.now(), reason: "complete" })
  const result = spawnSync(process.execPath, [SCRIPT, "copilot"], { env: { ...ctx.env, NODE_OPTIONS: "" }, input, encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await until(async () => (await listMarkers(ctx.env)).some((marker) => marker.host === "copilot-cli" && marker.end_reason === "complete")), true)
  assert.equal(await until(async () => readSyncStatus({ root: ctx.desk, env: ctx.env })?.reason === "unpushed_at_session_end"), true)
}))

test("malformed stdin, and a headless session, exit zero with no output and start no worker", () => scratch(async (ctx) => {
  await unpushedDesk(ctx)
  const marker = await session(ctx)
  const good = JSON.stringify({ session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "SessionEnd", reason: "other" })
  for (const [input, extra] of [["{", {}], [good, { DESK_FACTORY_HEADLESS: "1" }]]) {
    const result = spawnSync(process.execPath, [SCRIPT, "claude"], { env: { ...ctx.env, NODE_OPTIONS: "", ...extra }, input, encoding: "utf8", timeout: 5000 })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal((await listMarkers(ctx.env)).length, 0)
  assert.notEqual(readSyncStatus({ root: ctx.desk, env: ctx.env })?.blocked, true)
}))
