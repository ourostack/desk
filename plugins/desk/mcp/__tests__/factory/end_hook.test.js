import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { factoryStateRoot, listMarkers, requestFinalize, setConsent } from "../../src/factory/outbox.js"
import { END, ID, SENTINEL, json, scratch, session } from "./_session_helpers.js"

const SCRIPT = fileURLToPath(new URL("../../../hooks/factory-end.cjs", import.meta.url))
const require = createRequire(import.meta.url)
const hook = () => {
  assert.ok(existsSync(SCRIPT), "the bounded factory end hook must exist")
  return require(SCRIPT)
}

for (const event of ["SessionEnd", "Stop", "sessionEnd", "agentStop"]) {
  test(`${event} writes a private marker, ignores content, and derives only on session end`, () => scratch(async (ctx) => {
    const claude = /^[A-Z]/u.test(event)
    const marker = await session(ctx, claude ? "claude-code" : "copilot-cli")
    const payload = claude
      ? { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: event, reason: "prompt_input_exit", last_assistant_message: SENTINEL }
      : { sessionId: ID, cwd: ctx.desk, timestamp: Date.parse(END), ...(event === "agentStop" ? { stopReason: "end_turn", transcriptPath: "/ignored" } : { reason: "complete" }), initialPrompt: SENTINEL }
    const spawned = []
    const pluginRoot = path.join(ctx.base, ".local/agency/plugins/sessions/set/desk")
    await json(path.join(pluginRoot, "plugin.json"), { name: "desk", version: "3.2.0-alpha.42" })
    await json(path.join(path.dirname(pluginRoot), "overlay/plugin.json"), { name: "overlay", version: "1.0.0", desk: { factory: { store: "example/factory" } } })
    await json(path.join(ctx.base, ".claude/plugins/installed_plugins.json"), { version: 2, plugins: { "desk@ourostack": [{ version: "3.2.0-alpha.42", installPath: pluginRoot }] } })
    const result = await hook().runHook({ host: claude ? "claude" : "copilot", payload, env: ctx.env, pluginRoot, launch: async (...args) => spawned.push(args) })
    assert.equal(result, "written")
    const [saved] = await listMarkers(ctx.env)
    assert.equal(saved.log_path, marker.log_path)
    assert.equal(saved.desk_root, ctx.desk)
    assert.equal(saved.host, marker.host)
    assert.equal(saved.entrypoint, claude ? "unknown" : "launcher")
    assert.deepEqual(saved.plugins.find((p) => p.name === "desk"), { name: "desk", version: "3.2.0-alpha.42" })
    assert.equal(JSON.stringify(saved).includes(SENTINEL), false)
    assert.equal(saved.ended_at === null, event === "Stop" || event === "agentStop")
    assert.equal(spawned.length, /End$/u.test(event) ? 1 : 0)
    if (spawned.length) assert.deepEqual(spawned[0][1].slice(0, 1), ["derive"])
    const root = await factoryStateRoot(ctx.env)
    const file = path.join(root, "markers", `${saved.host}-${ID}.json`)
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    await hook().runHook({ host: claude ? "claude" : "copilot", payload, env: ctx.env, pluginRoot, launch: async () => {} })
    assert.equal((await listMarkers(ctx.env)).length, 1)
  }))
}

test("stdin is byte bounded, malformed input and stalled input finish silently", async () => {
  const { readInput } = hook()
  assert.deepEqual(await readInput(Readable.from(['{"ok":true}'])), { ok: true })
  for (const input of ["{", "null", "[]", "1", "x".repeat(1024 * 1024 + 1)]) {
    assert.equal(await readInput(Readable.from([input])), null)
  }
  assert.equal(await readInput(new Readable({ read() {} }), 10), null)
})

test("malformed and oversized CLI stdin exits zero with no output within two seconds", () => scratch(async ({ env }) => {
  hook()
  for (const input of ["{", JSON.stringify({ initialPrompt: SENTINEL.repeat(25000) })]) {
    const start = performance.now()
    const result = spawnSync(process.execPath, [SCRIPT, "copilot"], { env, input, encoding: "utf8", timeout: 2000 })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.ok(performance.now() - start < 2000)
  }
}))

test("stop leaves finalize requests pending until the command is available", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const job = "1".repeat(32)
  await requestFinalize(ctx.env, { job, deskRoot: ctx.desk })
  const calls = []
  const options = { host: "claude", payload: { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "Stop" }, env: ctx.env, launch: async (...args) => calls.push(args) }
  await hook().runHook(options)
  assert.deepEqual(calls, [])
  await hook().runHook({ ...options, supportsFinalize: true })
  assert.deepEqual(calls[0][1], ["finalize", "--job", job])
  assert.equal((await fs.readdir(path.join(await factoryStateRoot(ctx.env), "finalize"))).length, 1)
}))

test("invalid identifiers, events and paths never write or launch", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const base = { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "Stop" }
  for (const payload of [null, [], {}, { ...base, session_id: "../escape" }, { ...base, transcript_path: "relative" }, { ...base, cwd: "/bad\0path" }, { ...base, hook_event_name: "SessionStart" }]) {
    assert.equal(await hook().runHook({ host: "claude", payload, env: ctx.env, launch: async () => assert.fail("must not launch") }), "invalid")
  }
  assert.equal((await listMarkers(ctx.env)).length, 0)
}))

test("two real end-hook exits leave detached derivation running to completion, with no host profile writes", (t) => scratch(async (ctx) => {
  hook()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: "ourostack/factory", contribute: true })
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "outbox/ourostack__factory", `claude-code-${ID}.json`)
  for (const at of [END, "2026-09-26T08:02:00.000Z"]) {
    await fs.appendFile(marker.log_path, `${JSON.stringify({ type: "assistant", sessionId: ID, timestamp: at, message: { content: [] } })}\n`)
    const old = new Date(Date.now() - 60000)
    await fs.utimes(marker.log_path, old, old)
    const started = performance.now()
    const result = spawnSync(process.execPath, [SCRIPT, "claude"], {
      env: { ...ctx.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 2000,
      input: JSON.stringify({ session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    const elapsed = performance.now() - started
    t.diagnostic(`native synthetic end hook exited in ${Math.round(elapsed)} ms`)
    assert.ok(elapsed < 2000)
    const deadline = Date.now() + 10000
    let facts
    do {
      try { facts = JSON.parse(await fs.readFile(file, "utf8")) } catch (error) { if (error.code !== "ENOENT") throw error }
      if (facts?.session.derived_through === at) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    assert.equal(facts?.session.derived_through, at)
  }
}))

test("an incomplete sibling scan holds routing instead of silently selecting the public default", () => scratch(async (ctx) => {
  const marker = await session(ctx, "copilot-cli")
  const pluginRoot = path.join(ctx.base, "plugins/desk")
  await fs.mkdir(pluginRoot, { recursive: true })
  for (let n = 0; n < 66; n++) await fs.mkdir(path.join(ctx.base, "plugins", `plugin-${n}`))
  assert.equal(await hook().runHook({ host: "copilot", payload: { sessionId: ID, cwd: ctx.desk, stopReason: "end_turn" }, env: ctx.env, pluginRoot }), "written")
  const [saved] = await listMarkers(ctx.env)
  assert.equal(saved.routing.store, null)
  assert.equal(saved.routing.source, "invalid_declaration")
  assert.equal(saved.log_path, marker.log_path)
}))

test("stop refuses a symlinked finalize directory rather than starting another directory's jobs", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const root = await factoryStateRoot(ctx.env)
  const outside = path.join(ctx.base, "outside")
  await json(path.join(outside, `${"1".repeat(32)}.json`), {})
  await fs.symlink(outside, path.join(root, "finalize"), process.platform === "win32" ? "junction" : "dir")
  const calls = []
  assert.equal(await hook().runHook({ host: "claude", payload: { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "Stop" }, env: ctx.env, supportsFinalize: true, launch: async (...args) => calls.push(args) }), "unavailable")
  assert.deepEqual(calls, [])
  assert.equal((await listMarkers(ctx.env)).length, 1)
}))
