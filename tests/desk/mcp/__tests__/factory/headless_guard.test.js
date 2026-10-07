// D7: a headless evaluator session is unmistakable to the capture side. It is never captured, never starts the
// loop, never gets startup instructions, and never changes desk state. Every desk, state folder and process here is
// a throwaway fixture; no agent CLI is launched.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { listMarkers } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { HEADLESS_CODE, READ_ONLY_TOOLS, headlessRefusal, isHeadlessFactorySession } from "../../../../../plugins/desk/mcp/src/factory/headless-flag.js"
import { TOOL_NAMES } from "../../../../../plugins/desk/mcp/src/tool-names.js"
import { callTool, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import { bootOnce, isNoninteractive } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { runBootChecks, startFactory } from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"
import { runHook as endRunHook } from "../../../../../plugins/desk/hooks/lib/factory-end.cjs"
import { runHook as syncRunHook } from "../../../../../plugins/desk/hooks/lib/sync-end.cjs"
import { bootFixtureEnv } from "../_boot_fixture.js"
import { mkTempDeskRoot } from "../tools/_helpers.js"
import { ID, STORE, json, scratch, session } from "./_session_helpers.js"

const require = createRequire(import.meta.url)
const HOOKS = fileURLToPath(new URL("../../../../../plugins/desk/hooks/", import.meta.url))
const PLUGIN = path.dirname(HOOKS)

test("the flag counts only when set and neither empty nor 0", () => {
  for (const value of ["1", "true", "yes", " 1 ", " ", " 0 "]) assert.equal(isHeadlessFactorySession({ DESK_FACTORY_HEADLESS: value }), true, value)
  for (const value of ["", "0", undefined]) assert.equal(isHeadlessFactorySession({ DESK_FACTORY_HEADLESS: value }), false, String(value))
  assert.equal(isHeadlessFactorySession({}), false)
  assert.equal(isHeadlessFactorySession(undefined), false)
})

test("the end hook writes no marker and starts nothing under the flag, and behaves as before without it", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const payload = { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }
  const spawned = []
  const run = (env) => endRunHook({ host: "claude", payload, env, launch: async (...args) => spawned.push(args) })
  for (const value of ["1", "true"]) assert.equal(await run({ ...ctx.env, DESK_FACTORY_HEADLESS: value }), "headless")
  assert.deepEqual(await listMarkers(ctx.env), [])
  assert.deepEqual(spawned, [])
  for (const value of ["0", ""]) assert.equal(await run({ ...ctx.env, DESK_FACTORY_HEADLESS: value }), "written")
  assert.equal((await listMarkers(ctx.env)).length, 1)
}))

// Only the flagged run is a process: the bounded hook gives itself 1500 ms, and an instrumented run on a loaded runner can pass that deadline, so a process run without the flag would sometimes write nothing. The unflagged path is the in-process test above.
test("the bounded end hook process spawns no worker and writes no marker under the flag", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const payload = { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "Stop" }
  const run = (flag) => spawnSync(process.execPath, [path.join(HOOKS, "factory-end.cjs"), "claude"], { env: { ...ctx.env, DESK_FACTORY_HEADLESS: flag }, input: JSON.stringify(payload), encoding: "utf8" })
  assert.equal(run("1").status, 0)
  assert.deepEqual(await listMarkers(ctx.env), [])
}))

test("boot checks say nothing and the detached factory start never happens under the flag", async () => {
  let ran = 0
  let launched = 0
  const checks = [{ id: "x", budgetMs: 100, run: async () => { ran += 1; return { line: "speaks" } } }]
  const quiet = { launchRepair: async () => { launched += 1 }, launch: async () => { launched += 1 }, record: async () => {} }
  assert.equal(await runBootChecks({ ...quiet, checks, env: { DESK_FACTORY_HEADLESS: "1" } }), "")
  assert.equal(await startFactory({ env: { DESK_FACTORY_HEADLESS: "1" }, launch: async () => { launched += 1 } }), false)
  assert.deepEqual([ran, launched], [0, 0])
  assert.equal(await runBootChecks({ ...quiet, checks, env: { DESK_FACTORY_HEADLESS: "0" } }), "Desk boot pre-checks: speaks")
  assert.equal(ran, 1)
})

for (const host of ["claude", "copilot"]) {
  test(`the ${host} start hook prints nothing and starts no process under the flag`, () => scratch(async ({ env, desk, base }) => {
    const calls = path.join(base, "calls.txt")
    const fixture = path.join(base, "fixture.cjs")
    await fs.writeFile(fixture, `const fs = require("node:fs");
module.exports = { startFactory: async () => { fs.appendFileSync(${JSON.stringify(calls)}, "started\\n"); return true } };`)
    const hookEnv = bootFixtureEnv({ ...env, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: desk }, fixture)
    const run = (flag) => host === "copilot"
      ? spawnSync(process.execPath, [path.join(HOOKS, "copilot-session-start.cjs")], { env: { ...hookEnv, DESK_FACTORY_HEADLESS: flag }, input: JSON.stringify({ cwd: desk }), encoding: "utf8" })
      : spawnSync("bash", [path.join(HOOKS, "session-start.sh"), path.join(PLUGIN, "skills", "using-desk", "SKILL.md")], { env: { ...hookEnv, DESK_FACTORY_HEADLESS: flag }, encoding: "utf8" })
    const headless = run("1")
    assert.equal(headless.status, 0, headless.stderr)
    assert.equal(headless.stdout, "")
    await assert.rejects(fs.access(calls))
    const normal = run("0")
    assert.equal(normal.status, 0, normal.stderr)
    assert.match(normal.stdout, /Desk/u)
  }))
}

test("the start hook script and the helper agree on every flag value, whitespace included", () => scratch(async ({ env, desk }) => {
  const hookEnv = { ...env, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: desk }
  for (const value of ["1", "true", "0", "", " ", " 0 ", " 1 ", "no"]) {
    const run = spawnSync("bash", [path.join(HOOKS, "session-start.sh"), path.join(PLUGIN, "skills", "using-desk", "SKILL.md")], { env: { ...hookEnv, DESK_FACTORY_HEADLESS: value }, encoding: "utf8" })
    assert.equal(run.status, 0)
    assert.equal(run.stdout === "", isHeadlessFactorySession({ DESK_FACTORY_HEADLESS: value }), JSON.stringify(value))
  }
}))

test("the sync-end hook writes no sync record and runs no git under the flag", () => scratch(async (ctx) => {
  const payload = { hook_event_name: "SessionEnd", cwd: ctx.desk, session_id: ID }
  assert.equal(await syncRunHook({ host: "claude", payload, env: { ...ctx.env, DESK_FACTORY_HEADLESS: "1" } }), "headless")
  assert.notEqual(await syncRunHook({ host: "claude", payload, env: { ...ctx.env, DESK_FACTORY_HEADLESS: "0" } }), "headless")
}))

test("the copilot prompt hook emits nothing and claims nothing under the flag", () => scratch(async ({ env, desk }) => {
  const run = (flag) => spawnSync(process.execPath, [path.join(HOOKS, "copilot-boot-prompt.cjs")], { input: JSON.stringify({ sessionId: ID, cwd: desk, prompt: "x" }), env: { ...env, DESK_FACTORY_HEADLESS: flag }, encoding: "utf8" })
  assert.equal(run("1").stdout, "{}\n")
  assert.equal(run("1").status, 0)
}))

test("a hook that cannot load the rule file still honours the flag from the environment, and an ordinary session keeps working", () => scratch(async ({ base, desk, env }) => {
  const copy = path.join(base, "plugin")
  await fs.cp(HOOKS, path.join(copy, "hooks"), { recursive: true })
  const hooks = path.join(copy, "hooks")
  const payload = { hook_event_name: "SessionEnd", cwd: desk, session_id: ID }
  for (const [flag, headless] of [[undefined, false], ["0", false], ["", false], ["1", true]]) {
    const hookEnv = { ...env, PLUGIN_ROOT: copy }
    if (flag === undefined) delete hookEnv.DESK_FACTORY_HEADLESS
    else hookEnv.DESK_FACTORY_HEADLESS = flag
    const label = JSON.stringify(flag)
    const start = spawnSync(process.execPath, [path.join(hooks, "copilot-session-start.cjs")], { input: JSON.stringify({ cwd: desk }), env: hookEnv, encoding: "utf8" })
    assert.equal(start.stdout === "", headless, `copilot start ${label}`)
    const prompt = spawnSync(process.execPath, [path.join(hooks, "copilot-boot-prompt.cjs")], { input: JSON.stringify({ sessionId: ID, cwd: desk }), env: hookEnv, encoding: "utf8" })
    assert.equal(prompt.status, 0)
    assert.equal((await require(path.join(hooks, "lib", "sync-end.cjs")).runHook({ host: "claude", payload, env: hookEnv })) === "headless", headless, `sync-end ${label}`)
    assert.equal((await require(path.join(hooks, "lib", "factory-end.cjs")).runHook({ host: "claude", payload: { ...payload, session_id: ID, transcript_path: path.join(base, "x.jsonl") }, env: hookEnv })) === "headless", headless, `factory-end ${label}`)
    assert.equal(await require(path.join(hooks, "lib", "boot-checks.cjs")).startFactory({ env: hookEnv, launch: async () => {} }) , false)
  }
}))

test("bootOnce syncs nothing, installs no card guard and checks no stale refresh under the flag", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  const gh = async () => ({ code: 0, stdout: "", stderr: "" })
  const calls = []
  const run = (flag) => bootOnce({
    env: { DESK: root, DESK_FACTORY_HEADLESS: flag }, cwd: root, homeDir: root, gh, jq: gh,
    syncFn: async () => { calls.push("sync"); return { state: "synced" } },
    cardGuardFn: () => { calls.push("guard"); return { state: "installed" } },
    staleDeskFn: async () => { calls.push("stale"); return null },
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
  })
  const headless = await run("1")
  assert.deepEqual(calls, [])
  assert.equal(headless.sync_summary, "headless session; nothing synced")
  await run("0")
  assert.deepEqual(calls.sort(), ["guard", "stale", "sync"])
})

test("bootOnce adds no factory consent instruction to a headless session and still asks an interactive one", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  const gh = async () => ({ code: 0, stdout: "", stderr: "" })
  const run = (env) => bootOnce({
    env: { DESK: root, ...env }, cwd: root, homeDir: root, gh, jq: gh,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: STORE, source: "desk", consent: "undecided", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
  })
  const asked = (result) => result.instructions.some((text) => text.includes("Factory consent is undecided"))
  assert.equal(asked(await run({})), true)
  assert.equal(asked(await run({ DESK_FACTORY_HEADLESS: "1" })), false)
  assert.equal(asked(await run({ DESK_FACTORY_HEADLESS: "0" })), true)
  assert.equal(isNoninteractive({ DESK_FACTORY_HEADLESS: "1" }), true)
  assert.equal(isNoninteractive({ DESK_FACTORY_HEADLESS: "0" }), false)
  assert.equal(isNoninteractive({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), true)
})

// The server: one rule at dispatch, a read-only allow-list, anything else refused by default.
const parse = (result) => JSON.parse(result.content[0].text)

test("every registered tool is either read-only or refused under the flag, and the list names only real tools", () => {
  for (const name of READ_ONLY_TOOLS) assert.ok(TOOL_NAMES.includes(name), `${name} is not a registered tool`)
  for (const name of TOOL_NAMES) assert.equal(headlessRefusal(name, { DESK_FACTORY_HEADLESS: "1" }) === null, READ_ONLY_TOOLS.includes(name), name)
  for (const name of TOOL_NAMES) assert.equal(headlessRefusal(name, {}), null)
  assert.notEqual(headlessRefusal("a_future_writing_tool", { DESK_FACTORY_HEADLESS: "1" }), null, "an unknown tool is refused by default")
  for (const name of ["task_create", "task_update", "task_archive", "task_move", "task_focus", "track_create", "track_update", "track_rename", "friction_add", "lesson_add", "desk_save", "desk_reindex", "improvement_open", "improvement_next", "improvement_update"]) {
    assert.equal(READ_ONLY_TOOLS.includes(name), false, `${name} changes state`)
  }
})

test("callTool refuses a writing tool with headless_session and runs a read-only tool under the flag", async () => {
  const root = await mkTempDeskRoot()
  const calls = []
  const saved = { ...TOOL_IMPLS }
  try {
    for (const name of TOOL_NAMES) TOOL_IMPLS[name] = async () => { calls.push(name); return { ok: true } }
    const env = { DESK_FACTORY_HEADLESS: "1" }
    for (const name of TOOL_NAMES) {
      const result = await callTool({ deskRoot: root, name, input: {}, env })
      if (READ_ONLY_TOOLS.includes(name)) assert.deepEqual(parse(result), { ok: true }, name)
      else {
        assert.equal(result.isError, true, name)
        assert.deepEqual(parse(result), { status: "refused", code: HEADLESS_CODE, tool: name, message: parse(result).message })
      }
    }
    assert.deepEqual(calls.sort(), [...READ_ONLY_TOOLS].sort(), "a refused tool's body never runs")
    assert.equal(HEADLESS_CODE, "headless_session")
    calls.length = 0
    await callTool({ deskRoot: root, name: "task_create", input: {}, env: { DESK_FACTORY_HEADLESS: "0" } })
    assert.deepEqual(calls, ["task_create"])
  } finally {
    Object.assign(TOOL_IMPLS, saved)
  }
})

test("a headless task_create leaves the desk untouched", async () => {
  const root = await mkTempDeskRoot()
  const result = await callTool({ deskRoot: root, name: "task_create", input: { track: "t", slug: "some-task", title: "T" }, env: { DESK_FACTORY_HEADLESS: "1" } })
  assert.equal(parse(result).code, "headless_session")
  assert.deepEqual(await fs.readdir(root), [])
})
