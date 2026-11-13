// The session boot is Desk's to run, not the agent's: a hook (or the server's first tool reply) starts it, and exactly one place hands the result over.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  autoBootEnabled,
  awaitBoot,
  bootAgeSeconds,
  bootContext,
  bootKey,
  bootPaths,
  claimDelivery,
  pendingBootLine,
  serverBootKey,
  startBoot,
  wasDelivered,
  withStartupBoot,
} from "../../../../../plugins/desk/mcp/src/runtime/startup-boot.js"
import { runBootCli } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { bootFixtureEnv } from "../_boot_fixture.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url)).replace(/[\\/]$/u, "")
const ROOT = mkdtempSync(path.join(tmpdir(), "startup-boot-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = (name) => path.join(ROOT, `${name}-${(counter += 1)}`)
const stateDir = () => fresh("state")
const noWait = async () => {}

// A spawn that starts nothing but records what it was asked, and lets a test write the result the boot would.
function fakeSpawn({ pid = process.pid } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { pid, unref() {}, on() {} }
  }
  return { spawn, calls }
}

test("a session's key is its Copilot session id, else its folder, and the server computes the same one", () => {
  assert.equal(bootKey({ sessionId: "abc", folder: "/x" }), "s:abc")
  assert.equal(bootKey({ folder: path.resolve("/x/y") }), `f:${path.resolve("/x/y")}`)
  assert.equal(bootKey({ sessionId: " ", folder: "relative" }), null)
  assert.equal(bootKey({}), null)
  assert.equal(serverBootKey({ COPILOT_AGENT_SESSION_ID: "abc" }), "s:abc")
  assert.equal(serverBootKey({ CLAUDE_PROJECT_DIR: path.resolve("/x/y") }), `f:${path.resolve("/x/y")}`)
  assert.equal(serverBootKey({}), null)
  assert.notEqual(bootPaths({ stateDir: "/s", key: "s:a" }).text, bootPaths({ stateDir: "/s", key: "s:b" }).text)
  assert.match(path.basename(bootPaths({ stateDir: "/s", key: "../../etc" }).text), /^[0-9a-f]{32}\.txt$/u)
})

test("automatic boots stay off when the operator, a headless evaluator or a test run says so", () => {
  assert.equal(autoBootEnabled({}, { allowInTest: true }), true)
  assert.equal(autoBootEnabled({ DESK_AUTO_BOOT: "0" }, { allowInTest: true }), false)
  assert.equal(autoBootEnabled({ DESK_AUTO_BOOT: " 0 " }, { allowInTest: true }), false)
  assert.equal(autoBootEnabled({ DESK_FACTORY_HEADLESS: "1" }, { allowInTest: true }), false)
  assert.equal(autoBootEnabled({ DESK_FACTORY_HEADLESS: "0" }, { allowInTest: true }), true)
  assert.equal(autoBootEnabled({}), false, "this process is a node:test run")
})

test("starting a boot claims it once, runs the plugin's own script in the session folder, and says nothing for a second starter", () => {
  const dir = stateDir()
  const folder = fresh("folder")
  mkdirSync(folder, { recursive: true })
  const { spawn, calls } = fakeSpawn()
  const first = startBoot({ key: "s:one", folder, sessionId: "one", env: { PATH: "x" }, stateDir: dir, spawn })
  assert.equal(first.state, "started")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args[1], "--deliver")
  assert.equal(calls[0].args[2], first.paths.text)
  assert.ok(calls[0].args[0].endsWith(path.join("mcp", "scripts", "session-boot.js")))
  assert.equal(calls[0].options.cwd, folder)
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.env.COPILOT_AGENT_SESSION_ID, "one", "the boot binds the desk the server will")
  assert.equal(startBoot({ key: "s:one", folder, sessionId: "one", env: {}, stateDir: dir, spawn }).state, "already")
  assert.equal(calls.length, 1)
  // A resumed session boots afresh.
  writeFileSync(first.paths.text, "old\n")
  assert.equal(claimDelivery(first.paths), true)
  assert.equal(startBoot({ key: "s:one", folder, sessionId: "one", env: {}, stateDir: dir, spawn, fresh: true }).state, "started")
  assert.equal(existsSync(first.paths.text), false)
  assert.equal(wasDelivered(first.paths), false)
  assert.equal(startBoot({ key: null, stateDir: dir, spawn }).state, "failed")
})

test("a boot that cannot be spawned leaves one plain sentence where its result would be", async () => {
  const dir = stateDir()
  const spawn = () => { throw new Error("spawn EAGAIN\nmore") }
  const result = startBoot({ key: "s:fail", folder: undefined, env: {}, stateDir: dir, spawn })
  assert.equal(result.state, "failed")
  const { boot } = await awaitBoot({ paths: result.paths })
  assert.match(boot.text, /^Desk boot: it could not start \(spawn EAGAIN\)\. desk_status reports the desk's state\.\n$/u)
})

test("waiting for a boot returns its text, says it is still running, or says its process ended without one", async () => {
  const dir = stateDir()
  const { spawn } = fakeSpawn()
  const { paths } = startBoot({ key: "s:wait", env: {}, stateDir: dir, spawn, now: () => 1000 })
  assert.deepEqual(await awaitBoot({ paths, waitMs: 0 }), { boot: null, reason: "running" })
  const clock = { now: 0 }
  const result = await awaitBoot({ paths, waitMs: 120, now: () => clock.now, pause: async (ms) => { clock.now += ms } })
  assert.equal(result.reason, "running", "the wait gives up at its limit")
  writeFileSync(paths.text, "Desk boot: ready\n")
  const ready = await awaitBoot({ paths })
  assert.equal(ready.reason, "ready")
  assert.equal(ready.boot.text, "Desk boot: ready\n")
  assert.equal(typeof ready.boot.seconds, "number")
  // A text that appears while waiting is returned at once.
  rmSync(paths.text)
  let polls = 0
  const late = await awaitBoot({ paths, waitMs: 5000, pause: async () => { if ((polls += 1) === 2) writeFileSync(paths.text, "late\n") } })
  assert.equal(late.boot.text, "late\n")
  assert.deepEqual(await awaitBoot({ paths: bootPaths({ stateDir: dir, key: "s:never" }) }), { boot: null, reason: "none" })
  assert.deepEqual(await awaitBoot({ paths: null }), { boot: null, reason: "none" })
  // A process that has gone and left nothing is reported at once, not after the whole wait.
  const gone = startBoot({ key: "s:gone", env: {}, stateDir: dir, spawn: fakeSpawn({ pid: 2 ** 22 + 12345 }).spawn })
  assert.equal((await awaitBoot({ paths: gone.paths, waitMs: 60_000 })).reason, "ended")
  assert.equal(typeof bootAgeSeconds(paths), "number")
  assert.equal(bootAgeSeconds(bootPaths({ stateDir: dir, key: "s:none" })), undefined)
})

test("exactly one caller may hand the text over", () => {
  const paths = bootPaths({ stateDir: stateDir(), key: "s:once" })
  assert.equal(wasDelivered(paths), false)
  assert.equal(claimDelivery(paths), true)
  assert.equal(claimDelivery(paths), false)
  assert.equal(wasDelivered(paths), true)
  assert.equal(claimDelivery(null), false)
  assert.equal(wasDelivered(undefined), false)
})

test("the context frames the boot as Desk's own and cuts a long one at a line, leaving the rest for the first Desk tool reply", () => {
  const text = `${"line of the boot\n".repeat(100)}`
  const whole = bootContext({ boot: { text, seconds: 2.94 } })
  assert.equal(whole.whole, true)
  assert.match(whole.text, /^Desk boot \(Desk ran it for you at session start, 2\.9 s; its instructions are for the operator's session, so a child agent with a bounded brief follows its brief instead\):\n\nline of the boot\n/u)
  assert.equal(bootContext({ boot: { text: "x\n", seconds: null } }).text.startsWith("Desk boot (Desk ran it for you at session start; "), true)
  const head = bootContext({ boot: { text, seconds: 1 }, maxChars: 600 })
  assert.equal(head.whole, false)
  assert.ok(head.text.length <= 600, String(head.text.length))
  assert.ok(head.text.endsWith("[The rest of the boot arrives with your first Desk tool reply.]"))
  assert.doesNotMatch(head.text, /line of the boo\n\n\[The/u, "cut at a line end")
  assert.match(pendingBootLine({ seconds: 3.14 }), /^Desk's boot is still running \(it started 3\.1 s ago\)\. Call desk_status for its result/u)
  assert.doesNotMatch(pendingBootLine(), /started/u)
  assert.doesNotMatch(pendingBootLine(), /node |session-boot/u, "no script to run")
})

const call = (name, input = {}, extra = {}) => ({ name, input, ...extra })
const reply = (text) => ({ content: [{ type: "text", text }] })

test("the server's first Desk tool reply carries the boot a hook did not deliver, once, and only appends to the reply", async () => {
  const dir = stateDir()
  const env = { COPILOT_AGENT_SESSION_ID: "srv-1", DESK_PLUGIN_ROOT: plugin }
  const paths = bootPaths({ stateDir: dir, key: "s:srv-1" })
  const { spawn } = fakeSpawn()
  startBoot({ key: "s:srv-1", env: {}, stateDir: dir, spawn })
  writeFileSync(paths.text, "Desk boot: ready | desk /d\n")
  const callTool = withStartupBoot({ callTool: async () => reply("status"), env, stateDir: dir, allowInTest: true, pause: noWait })
  const first = await callTool(call("desk_status"))
  assert.equal(first.content[0].text, "status", "the tool's own text is untouched and first")
  assert.match(first.content[1].text, /^Desk boot \(Desk ran it for you at session start/u)
  assert.match(first.content[1].text, /Desk boot: ready \| desk \/d/u)
  const second = await callTool(call("desk_status"))
  assert.equal(second.content.length, 1, "delivered once")
  assert.equal(wasDelivered(paths), true)
})

test("a boot a hook already delivered is not delivered again, and an error reply is returned as it is", async () => {
  const dir = stateDir()
  const env = { COPILOT_AGENT_SESSION_ID: "srv-2" }
  const paths = bootPaths({ stateDir: dir, key: "s:srv-2" })
  startBoot({ key: "s:srv-2", env: {}, stateDir: dir, spawn: fakeSpawn().spawn })
  writeFileSync(paths.text, "boot\n")
  claimDelivery(paths)
  const callTool = withStartupBoot({ callTool: async () => reply("ok"), env, stateDir: dir, allowInTest: true, pause: noWait })
  assert.equal((await callTool(call("desk_status"))).content.length, 1)
  const failing = withStartupBoot({ callTool: async () => ({ isError: true, content: [{ type: "text", text: "no" }] }), env: { COPILOT_AGENT_SESSION_ID: "srv-3" }, stateDir: dir, allowInTest: true, pause: noWait })
  assert.deepEqual(await failing(call("task_update")), { isError: true, content: [{ type: "text", text: "no" }] })
  const aborted = withStartupBoot({ callTool: async () => reply("ok"), env: { COPILOT_AGENT_SESSION_ID: "srv-4" }, stateDir: dir, allowInTest: true, pause: noWait })
  assert.equal((await aborted(call("desk_status", {}, { signal: { aborted: true } }))).content.length, 1)
})

test("with no hook, the first tool reply starts the boot and waits for it; a boot that has not finished is said so and delivered later", async () => {
  const dir = stateDir()
  const env = { COPILOT_AGENT_SESSION_ID: "srv-5", DESK_PLUGIN_ROOT: plugin }
  const starts = []
  const paths = bootPaths({ stateDir: dir, key: "s:srv-5" })
  const start = (options) => {
    starts.push(options)
    return startBoot({ ...options, spawn: fakeSpawn().spawn })
  }
  const callTool = withStartupBoot({
    callTool: async () => reply("status"),
    env,
    stateDir: dir,
    allowInTest: true,
    start,
    waitMs: 100,
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const first = await callTool(call("desk_status"))
  assert.equal(starts.length, 1)
  assert.ok(starts[0].script.endsWith(path.join("mcp", "scripts", "session-boot.js")))
  assert.equal(starts[0].sessionId, "srv-5")
  assert.match(first.content[1].text, /^Desk's boot has not finished or did not leave a result\./u)
  // It arrives with a later reply once it exists, without another wait.
  writeFileSync(paths.text, "now here\n")
  const later = await callTool(call("desk_status"))
  assert.match(later.content[1].text, /now here/u)
  assert.equal(starts.length, 1, "started once")
})

test("a server with no session key, or with automatic boots off, answers exactly as before", async () => {
  const inner = async () => reply("ok")
  assert.equal(withStartupBoot({ callTool: inner, env: {}, stateDir: stateDir(), allowInTest: true }), inner)
  assert.equal(withStartupBoot({ callTool: inner, env: { COPILOT_AGENT_SESSION_ID: "x", DESK_AUTO_BOOT: "0" }, stateDir: stateDir(), allowInTest: true }), inner)
  assert.equal(withStartupBoot({ callTool: inner, env: { COPILOT_AGENT_SESSION_ID: "x" }, stateDir: stateDir() }), inner, "a node:test run")
})

test("a task_focus reply carries the task's push route once per task, from the boot for that one task", async () => {
  const dir = stateDir()
  const env = { COPILOT_AGENT_SESSION_ID: "srv-6" }
  const paths = bootPaths({ stateDir: dir, key: "s:srv-6" })
  startBoot({ key: "s:srv-6", env: {}, stateDir: dir, spawn: fakeSpawn().spawn })
  writeFileSync(paths.text, "boot\n")
  claimDelivery(paths)
  const asked = []
  const taskBoot = async ({ track, slug }) => {
    asked.push(`${track}/${slug}`)
    return slug === "quiet" ? "" : `Push routes for ${track}/${slug}: gh as someone`
  }
  const callTool = withStartupBoot({ callTool: async () => reply("focused"), env, stateDir: dir, allowInTest: true, taskBoot, pause: noWait })
  const first = await callTool(call("task_focus", { track: "ops", slug: "ship" }))
  assert.equal(first.content[1].text, "Push routes for ops/ship: gh as someone")
  assert.equal((await callTool(call("task_focus", { track: "ops", slug: "ship" }))).content.length, 1, "once per task")
  assert.equal((await callTool(call("task_focus", { track: "ops", slug: "quiet" }))).content.length, 1, "no text, nothing appended")
  assert.equal((await callTool(call("task_focus", { clear: true }))).content.length, 1)
  assert.equal((await callTool(call("task_update", { track: "ops", slug: "other" }))).content.length, 1)
  assert.deepEqual(asked, ["ops/ship", "ops/quiet"])
  const throwing = withStartupBoot({ callTool: async () => reply("focused"), env, stateDir: dir, allowInTest: true, taskBoot: async () => { throw new Error("x") }, pause: noWait })
  assert.equal((await throwing(call("task_focus", { track: "a", slug: "b" }))).content.length, 1, "a failing route check never fails the reply")
})

test("the boot script's --deliver writes its text to the file, renamed into place, and prints nothing", async () => {
  const file = path.join(fresh("deliver"), "out.txt")
  const out = []
  const code = await runBootCli({ argv: ["--deliver", file], env: {}, io: { stdout: { write: (chunk) => out.push(chunk) } }, bootFn: async () => ({ boot_complete: true, status: "ready", degraded: [], pending: [], instructions: [], root: null, host: null }) })
  assert.equal(code, 0)
  assert.deepEqual(out, [])
  assert.match(readFileSync(file, "utf8"), /^Desk boot: ready/u)
  // A file that cannot be written does not throw: the reader sees the boot end without a result.
  const blocked = path.join(fresh("blocked"), "x")
  writeFileSync(path.dirname(blocked), "a file where a folder should be")
  assert.equal(await runBootCli({ argv: ["--deliver", blocked], env: {}, io: { stdout: { write: () => {} } }, bootFn: async () => ({ boot_complete: true, status: "ready", degraded: [], pending: [], instructions: [], root: null, host: null }) }), 0)
})

// The real hooks, against a fixture desk and the real boot script.
function deskFixture(name) {
  const home = fresh(name)
  const desk = path.join(home, "desk")
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "_archive"), { recursive: true })
  writeFileSync(path.join(desk, "AGENTS.md"), "# Desk\n")
  const fixture = path.join(home, "boot-fixture.cjs")
  writeFileSync(fixture, 'module.exports = { checks: [], startFactory: async () => true, migrationLine: async () => "" };\n')
  const env = bootFixtureEnv({
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    DESK: desk,
    DESK_BOOT_VERSION_CHECK: "0",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  }, fixture)
  return { home, desk, env }
}

test("the Copilot first-prompt hook runs the boot itself and hands the agent its result, once", () => {
  const { desk, env } = deskFixture("copilot-hook")
  const run = (script, input) => {
    const result = spawnSync(process.execPath, [path.join(plugin, "hooks", script)], { input: JSON.stringify(input), env, encoding: "utf8", timeout: 60_000 })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const first = run("copilot-boot-prompt.cjs", { sessionId: "hook-1", cwd: desk, prompt: "hi" })
  assert.match(first.additionalContext, /^Desk boot \(Desk ran it for you at session start, [\d.]+ s; /u)
  assert.match(first.additionalContext, /Desk boot: (ready|degraded|setup_required)/u)
  assert.doesNotMatch(first.additionalContext, /session-boot/u, "the agent is never told to run the script")
  assert.deepEqual(run("copilot-boot-prompt.cjs", { sessionId: "hook-1", cwd: desk, prompt: "again" }), {}, "once per session")
  const session = run("copilot-session-start.cjs", { sessionId: "hook-1", cwd: desk, source: "new" })
  assert.doesNotMatch(session.additionalContext, /Desk boot \(Desk ran it/u, "sessionStart after the prompt hook adds no second copy")
  assert.match(session.additionalContext, /Desk runs the session boot itself, so there is nothing for you to run/u)
  // A resumed session boots afresh and gets its result in the sessionStart context.
  const resumed = run("copilot-session-start.cjs", { sessionId: "hook-1", cwd: desk, source: "resume" })
  assert.match(resumed.additionalContext, /Desk boot \(Desk ran it for you at session start/u)
  // A folder that is no desk (with no desk bound anywhere) gets no boot.
  const elsewhere = path.join(path.dirname(desk), "no-desk")
  mkdirSync(elsewhere, { recursive: true })
  const { DESK: _bound, ...unbound } = env
  const bare = spawnSync(process.execPath, [path.join(plugin, "hooks", "copilot-boot-prompt.cjs")], { input: JSON.stringify({ sessionId: "hook-2", cwd: elsewhere, prompt: "hi" }), env: { ...unbound, HOME: elsewhere, USERPROFILE: elsewhere }, encoding: "utf8", timeout: 60_000 })
  assert.deepEqual(JSON.parse(bare.stdout), {})
  // A headless evaluator and a payload with no session id get no boot either.
  const headless = spawnSync(process.execPath, [path.join(plugin, "hooks", "copilot-boot-prompt.cjs")], { input: JSON.stringify({ sessionId: "hook-3", cwd: desk }), env: { ...env, DESK_FACTORY_HEADLESS: "1" }, encoding: "utf8", timeout: 60_000 })
  assert.deepEqual(JSON.parse(headless.stdout), {})
  assert.deepEqual(run("copilot-boot-prompt.cjs", { cwd: desk }), {}, "no session id, no key")
})

test("the Claude hook starts the boot and carries its head after the startup line, leaving the rest for the first Desk tool reply", () => {
  const { desk, env } = deskFixture("claude-hook")
  const long = Object.assign({}, env, { CLAUDE_PROJECT_DIR: desk, CLAUDE_PLUGIN_ROOT: plugin })
  const foundation = path.join(plugin, "skills", "using-desk", "SKILL.md")
  const result = spawnSync(process.execPath, [path.join(plugin, "hooks", "claude-session-start.cjs"), foundation], { env: long, encoding: "utf8", timeout: 60_000, cwd: desk })
  assert.equal(result.status, 0, result.stderr)
  const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext
  const boot = text.indexOf("Desk boot (Desk ran it for you at session start")
  assert.ok(boot > text.indexOf("Desk startup:"), "the startup line leads")
  assert.ok(boot < text.indexOf("The human supplies intent"), "the boot comes before the foundation")
  assert.doesNotMatch(text, /session-boot/u)
  const paths = bootPaths({ stateDir: path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk"), key: `f:${desk}` })
  assert.equal(existsSync(paths.text), true, "the boot's own result is on disk for the first tool reply")
})
