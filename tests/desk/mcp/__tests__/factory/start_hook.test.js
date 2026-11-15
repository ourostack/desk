// The session-start side of the factory: the boot-check registry both startup
// hooks run, the detached factory start, and byte-for-byte startup output.
// Every desk, store and process here is a throwaway fixture; nothing reaches
// the network, and hook processes run with a temporary HOME and state folder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

import { readStatus, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { resolveDeskStateDir, writeLastStart } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { copilotStartupDirection, claudeStartupDirection } from "../../../../../plugins/desk/mcp/src/util/startup-direction.js"
import { bootFixtureEnv } from "../_boot_fixture.js"
import { STORE, scratch as scratchSession } from "./_session_helpers.js"
import { TOTAL_BUDGET_MS, checks, deskHealthCheck, launchCommand, runBootChecks } from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"
import { metadata } from "../../../../../plugins/desk/mcp/src/factory/plugin-sources.cjs"
import { main as factoryStartMain, DEADLINE_MS as factoryDeadlineMs } from "../../../../../plugins/desk/hooks/factory-start.cjs"

const HOOKS = fileURLToPath(new URL("../../../../../plugins/desk/hooks/", import.meta.url))
const PLUGIN = path.dirname(HOOKS)
const BOOT = path.join(HOOKS, "boot-checks.cjs") // the command-line entry; the registry is in lib/
const START = path.join(HOOKS, "factory-start.cjs")

// A session start in an ordinary interactive session, whatever runs the tests (a CI runner sets CI; a headless Claude run sets the entry point).
const interactive = (env) => {
  const clean = { ...env }
  for (const name of ["CI", "GITHUB_ACTIONS", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "DESK_FACTORY_HEADLESS"]) delete clean[name]
  return clean
}
// Every control here is an ordinary interactive start; the headless suppression has its own tests elsewhere.
const scratch = (run) => scratchSession(({ env, ...rest }) => run({ ...rest, env: interactive(env) }))
const quiet = { env: interactive(process.env), launchRepair: async () => {}, launch: async () => {} }
const check = (id, run, budgetMs = 100) => ({ id, budgetMs, run })

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

test("the registry runs publication inspection before workspace tidy within the shared budget", () => {
  assert.deepEqual(checks.map((entry) => entry.id), ["desk-health", "workspace-tidy"])
  assert.equal(TOTAL_BUDGET_MS, 300)
  assert.ok(checks.every((entry) => entry.budgetMs <= 300))
})

test("no line from any check means no output at all; lines join into exactly one Desk boot line", async (t) => {
  // This asserts output semantics, not the registry budget; a frozen clock keeps a cold runner from spending the 300ms total before a check runs.
  t.mock.method(performance, "now", () => 0)
  const order = []
  const silent = await runBootChecks({ ...quiet, checks: [check("a", async () => { order.push("a"); return {} }), check("b", async () => { order.push("b"); return { line: "   " } })] })
  assert.equal(silent, "")
  assert.deepEqual(order, ["a", "b"])
  const spoken = await runBootChecks({ ...quiet, checks: [check("a", async () => ({ line: "first\nhalf" })), check("b", () => undefined), check("c", async () => ({ line: "second" }))] })
  assert.equal(spoken, "Desk boot pre-checks: first half; second")
  assert.equal(spoken.split("\n").length, 1)
})

test("an exhausted registry budget skips the checks it has no time for", async (t) => {
  let tick = 0
  t.mock.method(performance, "now", () => (tick += 1000))
  const order = []
  const out = await runBootChecks({ ...quiet, checks: [check("a", async () => { order.push("a"); return {} }), check("b", async () => { order.push("b"); return {} })] })
  assert.equal(out, "")
  assert.ok(!order.includes("b"))
})

test("repairs start detached after every check has run, and a repair that cannot start is ignored", async () => {
  const events = []
  const launchRepair = async (command) => {
    events.push(["repair", command])
    if (command[0] === "fails") throw new Error("spawn failed")
  }
  const line = await runBootChecks({
    ...quiet,
    launchRepair,
    checks: [
      check("a", async () => { events.push(["check", "a"]); return { repair: { command: ["fails"] } } }),
      check("b", async () => { events.push(["check", "b"]); return { repair: { command: ["node", "x.js"] }, line: "b" } }),
      check("c", async () => { events.push(["check", "c"]); return { repair: { command: [] } } }),
      check("d", async () => ({ repair: { command: ["node", 7] } })),
      check("e", async () => ({ repair: "node x" })),
    ],
  })
  assert.equal(line, "Desk boot pre-checks: b")
  assert.deepEqual(events, [["check", "a"], ["check", "b"], ["check", "c"], ["repair", ["fails"]], ["repair", ["node", "x.js"]]])
})

test("a check that overruns its budget is skipped silently, but a check that throws is skipped and reported as a Desk problem: block; the rest still run", async (t) => {
  // This asserts skip and report semantics, not the registry total; a frozen clock keeps scheduling and filer work on a loaded runner from spending the 300ms total before "fine" runs. The slow check still overruns on its real 50ms timer.
  t.mock.method(performance, "now", () => 0)
  let aborted = false
  const line = await runBootChecks({
    ...quiet,
    checks: [
      check("slow", (ctx) => new Promise(() => { ctx.signal.addEventListener("abort", () => { aborted = true }) }), 50),
      check("self-stopped", async () => { throw Object.assign(new Error("over"), { code: "boot_check_budget" }) }),
      check("broken", async () => { throw new Error("boom") }),
      check("fine", async () => ({ line: "fine" })),
    ],
  })
  assert.equal(line, [
    "Desk boot pre-checks: Desk problem: broken — the check failed internally at startup",
    "  broke: boom",
    '  means: Desk\'s "broken" boot check could not report its status this session',
    "  fix: not fixable automatically -- the check itself needs investigation",
    "  file: filing in background",
    '  tell: Desk\'s "broken" boot check failed internally this session (boom). Filing this now so it gets fixed.; fine',
  ].join("\n"))
  // The overrunning check never answers on its own, so the run returning at all means it did not wait for it.
  assert.ok(aborted, "the overrunning check is told to stop")
})

// A check that never yields, on a clock the test owns: the boot runner reads `performance.now()`, so blocking advances that clock by exactly `ms`. A real busy loop would let a loaded machine add time to every check and change which budget each one overruns.
let virtualNow = 0
const block = (ms) => { virtualNow += ms }
const useVirtualClock = (t) => {
  virtualNow = 0
  t.mock.method(performance, "now", () => virtualNow)
}

test("checks that block synchronously past their budgets are skipped, and their real time counts against the total", async (t) => {
  useVirtualClock(t)
  const repairs = []
  const line = await runBootChecks({
    ...quiet,
    launchRepair: async (command) => repairs.push(command),
    checks: [
      check("a", () => { block(250); return { line: "a-late", repair: { command: ["node", "a.js"] } } }, 100),
      check("b", () => { block(40); return { line: "b", repair: { command: ["node", "b.js"] } } }, 50),
      check("c", () => { block(140); return { line: "c" } }, 260),
    ],
  })
  assert.equal(line, "Desk boot pre-checks: b", "a overran its own budget; c overran the 10 ms the total had left after a's real 250 ms")
  assert.deepEqual(repairs, [["node", "b.js"]], "an overrunning check's repair never starts")
  assert.equal(virtualNow, 250 + 40 + 140, "every check ran to its end on the owned clock")
})

test("the real elapsed time of each check is charged, so a total spent by blocking skips the rest without running them", async (t) => {
  useVirtualClock(t)
  let ran = false
  const line = await runBootChecks({
    ...quiet,
    totalBudgetMs: 100,
    checks: [check("first", () => { block(60); return { line: "first" } }, 80), check("second", () => { block(60); return { line: "second" } }, 80), check("third", () => { ran = true; return { line: "third" } }, 80)],
  })
  assert.equal(line, "Desk boot pre-checks: first")
  assert.equal(ran, false)
})

test("a check timer that fires before the clock reaches the total still spends it, so the next check is skipped", async (t) => {
  // Node's timers run on libuv's cached loop time, so one can fire a little before performance.now() reaches its budget.
  useVirtualClock(t)
  let ran = false
  const line = await runBootChecks({
    ...quiet,
    totalBudgetMs: 20,
    checks: [
      check("first", (ctx) => { block(ctx.budgetMs - 1.5); return new Promise(() => {}) }, 1000),
      check("second", async () => { ran = true; return { line: "never" } }),
    ],
  })
  assert.equal(line, "")
  assert.equal(ran, false)
})

test("the total budget caps every check, and checks after it are skipped", async () => {
  const budgets = []
  let ran = false
  const line = await runBootChecks({
    ...quiet,
    totalBudgetMs: 120,
    checkBudgets: { first: 1000 },
    checks: [
      check("first", (ctx) => { budgets.push(ctx.budgetMs); return new Promise(() => {}) }, 50),
      check("second", async () => { ran = true; return { line: "never" } }),
    ],
  })
  assert.equal(line, "")
  assert.ok(budgets[0] <= 120)
  assert.equal(ran, false)
})

test("a session start leaves factory state alone: a skipped check records nothing in the factory status", () => scratch(async ({ env, base }) => {
  await runBootChecks({ env, launchRepair: async () => {}, checks: [check("stalled", () => new Promise(() => {}), 10)] })
  assert.equal(existsSync(path.join(base, "state")), false)
  await setConsent(env, { store: STORE, contribute: false })
  await runBootChecks({ env, launchRepair: async () => {}, checks: [check("stalled", () => new Promise(() => {}), 10)] })
  assert.equal((await readStatus(env)).boot_checks, undefined)
}))

test("launchCommand starts detached with ignored stdio and never waits for the child", async () => {
  const seen = []
  const spawnImpl = (file, args, options) => {
    const handlers = {}
    const child = { once: (event, fn) => { handlers[event] = fn }, unref: () => seen.push("unref") }
    seen.push({ file, args, options })
    setImmediate(() => handlers.spawn())
    return child
  }
  await launchCommand(["node", "script.js", "--flag"], { A: "1" }, spawnImpl)
  assert.deepEqual(seen[0].file, "node")
  assert.deepEqual(seen[0].args, ["script.js", "--flag"])
  assert.equal(seen[0].options.detached, true)
  assert.equal(seen[0].options.stdio, "ignore")
  assert.deepEqual(seen[0].options.env, { A: "1" })
  assert.equal(seen[1], "unref")
  const failing = (file) => {
    const handlers = {}
    setImmediate(() => handlers.error(new Error(`no ${file}`)))
    return { once: (event, fn) => { handlers[event] = fn }, unref() {} }
  }
  await assert.rejects(launchCommand(["missing"], {}, failing), /no missing/u)
})

// ---------------------------------------------------------------------------
// The desk-health check inside the registry. The factory has no check here.
// ---------------------------------------------------------------------------

test("the registry has no factory, labels, andon or improvement check, and starts no factory delivery", () => {
  for (const id of ["factory", "labels", "andon", "improvement"]) assert.equal(checks.some((entry) => entry.id === id), false, id)
})

test("the desk-health check reports a degraded last start and otherwise asks for the fast-forward", () => scratch(async ({ env, desk, base }) => {
  const run = (options) => runBootChecks({ ...quiet, checks: [deskHealthCheck], checkBudgets: { "desk-health": 2000 }, totalBudgetMs: 2000, ...options })
  assert.equal(await run({ host: "claude", env }), "")
  execFileSync("git", ["init", "-q", "-b", "main", desk])
  const stateDir = resolveDeskStateDir({ env })
  const real = await fs.realpath(desk)
  await writeLastStart({ stateDir, root: real, snapshot: { state: "degraded:state_branch_detached", code: "state_branch_detached", repair: null, fix: null } })
  assert.equal(await run({ host: "claude", env }), "Desk boot pre-checks: Desk: degraded (desk checkout detached; writes paused); run desk_doctor")
  await writeLastStart({ stateDir, root: real, snapshot: { state: "ready", code: null, repair: null, fix: null } })
  const repairs = []
  assert.equal(await run({ host: "claude", env, launchRepair: async (command) => repairs.push(command) }), "")
  assert.deepEqual(repairs, [[process.execPath, BOOT, "--compatible", BOOT, "--fast-forward", desk]], "the fast-forward starts through the compatible-Node launcher")
  const crew = path.join(base, "crew")
  await fs.mkdir(path.join(crew, "_meta"), { recursive: true })
  await fs.mkdir(path.join(crew, "desks"), { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main", crew])
  await writeLastStart({ stateDir, root: crew, snapshot: { state: "degraded:crew_state_not_main", code: "crew_state_not_main", repair: null, fix: null } })
  assert.equal(await run({ host: "copilot", env, sessionFolder: crew }), "Desk boot pre-checks: Desk: degraded (crew_state_not_main; writes paused); run desk_status for the fix", "the session's own desk comes first on Copilot")
}))

test("the fast-forward repair entry point runs the detached fast-forward and reports as JSON", () => scratch(async ({ env, base }) => {
  const plain = path.join(base, "plain")
  await fs.mkdir(plain)
  const result = spawnSync(process.execPath, [BOOT, "--fast-forward", plain], { env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { result: "skipped", reason: "not_a_checkout" })
  const usage = spawnSync(process.execPath, [BOOT, "--fast-forward"], { env, encoding: "utf8" })
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /--fast-forward <desk>/u)
}))

// ---------------------------------------------------------------------------
// Delivery runs only where someone starts it.
// ---------------------------------------------------------------------------

test("factory-start.cjs runs sweep and flush for consented stores when started by hand, prints nothing and exits 0", () => scratch(async ({ env }) => {
  const start = { main: factoryStartMain, DEADLINE_MS: factoryDeadlineMs }
  assert.equal(start.DEADLINE_MS, 120000)
  assert.deepEqual(await start.main({ env }), { stores: {} })
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const binDir = path.join(env.HOME, "bin")
  await fs.mkdir(binDir)
  await fs.writeFile(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const summary = await start.main({ env: { ...env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }, deadlineMs: 20000 })
  assert.deepEqual(summary.stores, { [STORE]: { result: "nothing_pending" } })
  const run = spawnSync(process.execPath, [START], { env, encoding: "utf8", timeout: 30000 })
  assert.equal(run.status, 0)
  assert.equal(run.stdout, "")
  assert.equal(run.stderr, "")
  assert.equal((await readStatus(env)).last_flush[STORE].result, "nothing_pending")
}))

// ---------------------------------------------------------------------------
// Startup output, byte for byte.
// ---------------------------------------------------------------------------

// The fixture checks, through the test-only preload (`_boot_fixture_preload.cjs`), for the hook itself only.
async function overridesFor(dir, { lines = null }) {
  const file = path.join(dir, `overrides-${Math.random().toString(16).slice(2)}.cjs`)
  await fs.writeFile(file, `
require("node:test").mock.method(performance, "now", () => 0);
module.exports = {
  migrationLine: async () => "",
  checks: ${JSON.stringify(lines ?? [])}.map((line, index) => ({ id: "fixture-" + index, budgetMs: 100, run: async () => ({ line }) })),
};
`)
  return file
}

function runHook(host, env, desk) {
  return host === "copilot"
    ? spawnSync(process.execPath, [path.join(HOOKS, "copilot-session-start.cjs")], { env, input: JSON.stringify({ cwd: desk }), encoding: "utf8" })
    : spawnSync(process.execPath, [path.join(HOOKS, "claude-session-start.cjs"), path.join(PLUGIN, "skills", "using-desk", "SKILL.md")], { env, encoding: "utf8" })
}

// `checks` is the boot pre-checks line a speaking check adds ("\n\nDesk boot pre-checks: ..."). Both hosts add it to the startup
// direction, which opens the context (Claude Code keeps only a 2 KB preview of a context past 10,000 characters, so the boot imperative leads).
const { PLAIN_LANGUAGE_POINTER } = createRequire(import.meta.url)("../../../../../plugins/desk/hooks/lib/child-agent.cjs")

function expectedContext(host, env, desk, checks = "") {
  const skill = readFileSync(path.join(PLUGIN, "skills", "using-desk", "SKILL.md"), "utf8")
  const rfc = path.join(PLUGIN, "docs", "agentic-engineering-v3-rfc.md")
  // Copilot's hook drops the foundation's frontmatter and adds the worker pointer, which Claude Code's agent setting makes unnecessary.
  if (host === "copilot") return `${copilotStartupDirection({ env, sessionFolder: desk })}${checks}\n\n${PLAIN_LANGUAGE_POINTER}\n\nUnless started with \`--agent\` or the stand-down rule above applies (then skip this read too), act as Desk's worker: read ${path.join(PLUGIN, "agents", "worker.agent.md")} first.\n\n${skill.replace(/^---\n[\s\S]*?\n---\n\s*/u, "").trimEnd()}\n\nDesk RFC: ${rfc}`
  // Bash command substitution drops the file's trailing newlines, as `trimEnd` does for the newline-only tail.
  return `${claudeStartupDirection({ env })}${checks}\n\n${skill.replace(/\n+$/u, "")}\n\n${PLAIN_LANGUAGE_POINTER}\n\nDesk RFC: ${rfc}\n`
}

function envelope(host, context) {
  if (host === "copilot") return JSON.stringify({ additionalContext: context })
  return `${execFileSync("jq", ["-nc", "--arg", "c", context, "{hookSpecificOutput:{hookEventName:\"SessionStart\",additionalContext:$c}}"], { encoding: "utf8" }).trimEnd()}\n`
}

// jq.exe ends its line with CRLF on Windows; the line ending is whitespace to the JSON reader, so only the bytes before it must match.
const jqLine = (stdout) => process.platform === "win32" ? stdout.replace(/\r\n$/u, "\n") : stdout

for (const host of ["claude", "copilot"]) {
  test(`${host} session-start output is byte-identical when no boot check speaks, and gains exactly one line when they do`, () => scratch(async ({ env, desk, base }) => {
    const hookEnv = { ...env, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: desk }
    if (host === "copilot") {
      const home = hookEnv.COPILOT_HOME || path.join(hookEnv.HOME, ".copilot")
      await fs.mkdir(home, { recursive: true })
      await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ memory: false, includeCoAuthoredBy: false, askUser: false }))
    }
    const silent = await overridesFor(base, {})
    const quietRun = runHook(host, bootFixtureEnv(hookEnv, silent), desk)
    assert.equal(quietRun.status, 0, quietRun.stderr)
    const context = expectedContext(host, hookEnv, desk)
    const hasJq = spawnSync("jq", ["--version"]).status === 0
    const quietOut = jqLine(quietRun.stdout)
    if (host === "copilot" || hasJq) {
      const wanted = envelope(host, context)
      // On a mismatch, name the first differing byte with its neighbours: the full strings are too long for a failure log.
      const at = [...quietOut].findIndex((char, index) => char !== wanted[index])
      const near = (text) => JSON.stringify(text.slice(Math.max(0, at - 60), at + 80))
      assert.equal(quietOut, wanted, `silent boot checks leave the output byte-identical; first difference at ${at} of ${quietOut.length} (expected ${wanted.length}): got ${near(quietOut)} expected ${near(wanted)}`)
    }
    const parsed = JSON.parse(quietRun.stdout)
    assert.equal(parsed.additionalContext ?? parsed.hookSpecificOutput.additionalContext, context)
    assert.doesNotMatch(quietRun.stdout, /Desk boot pre-checks:/u)

    const speaking = await overridesFor(base, { lines: ["one", "two"] })
    const spokenRun = runHook(host, bootFixtureEnv(hookEnv, speaking), desk)
    assert.equal(spokenRun.status, 0, spokenRun.stderr)
    const spoken = JSON.parse(spokenRun.stdout)
    assert.equal(spoken.additionalContext ?? spoken.hookSpecificOutput.additionalContext, expectedContext(host, hookEnv, desk, "\n\nDesk boot pre-checks: one; two"))
    if (host === "copilot" || hasJq) assert.equal(jqLine(spokenRun.stdout), envelope(host, expectedContext(host, hookEnv, desk, "\n\nDesk boot pre-checks: one; two")))
    assert.equal(existsSync(path.join(base, "state", "ouroboros-skills", "desk", "factory")), false, "a session start starts no factory delivery and creates no factory state")
  }))
}

test("the real hooks with a bound desk and no decision add no factory boot line and never ask for consent", () => scratch(async ({ env, desk, base }) => {
  const overrides = path.join(base, "relax.cjs")
  await fs.writeFile(overrides, `module.exports = { options: { launch: async () => {}, launchRepair: async () => {}, totalBudgetMs: 5000, checkBudgets: { factory: 2000, "desk-health": 2000, "workspace-tidy": 2000 } } };\n`)
  const hookEnv = bootFixtureEnv({ ...env, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: desk }, overrides)
  for (const host of ["claude", "copilot"]) {
    const result = runHook(host, hookEnv, desk)
    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    const context = parsed.additionalContext ?? parsed.hookSpecificOutput.additionalContext
    const bootLines = context.split("\n").filter((line) => line.startsWith("Desk boot pre-checks:"))
    assert.deepEqual(bootLines.filter((line) => /Factory:/u.test(line)), [], `${host}: ${context}`)
    assert.doesNotMatch(context, /Factory: this desk/u)
  }
  assert.equal(existsSync(path.join(base, "state", "ouroboros-skills", "desk", "factory")), false, "startup never creates factory state")
}))

test("the Claude resolver appends the boot line only when there is one", async () => {
  const { main } = await import(pathToFileURL(path.join(PLUGIN, "mcp", "scripts", "resolve-desk-root.js")).href)
  const events = []
  const loadBoot = async () => ({ migrationLine: async () => { events.push("migrations"); return "" }, runBootChecks: async () => { events.push("checks"); return "" } })
  let output = ""
  await main({ argv: ["--startup-line", "--boot-checks"], env: { HOME: "/nonexistent-home" }, write: (text) => { output = text; events.push("write") }, loadBoot })
  assert.deepEqual(events, ["migrations", "checks", "write"], "the migration check starts before the boot checks and runs alongside them")
  assert.doesNotMatch(output, /\n\n$/u)
  assert.doesNotMatch(output, /Desk boot|Desk migrations/u)
  const speaking = async () => ({ migrationLine: async () => "Desk migrations: y", runBootChecks: async () => "Desk boot pre-checks: x" })
  await main({ argv: ["--startup-line", "--boot-checks"], env: { HOME: "/nonexistent-home" }, write: (text) => { output = text }, loadBoot: speaking })
  assert.match(output, /\n\nDesk boot pre-checks: x\n\nDesk migrations: y$/u)
  const migrationsOnly = async () => ({ migrationLine: async () => "Desk migrations: y", runBootChecks: async () => "" })
  await main({ argv: ["--startup-line", "--boot-checks"], env: { HOME: "/nonexistent-home" }, write: (text) => { output = text }, loadBoot: migrationsOnly })
  assert.match(output, /[^\n]\n\nDesk migrations: y$/u)
  assert.doesNotMatch(output, /Desk boot/u)
})

test("the plugin scan stops at its deadline and reports itself incomplete, never guessing", () => scratch(async ({ env, desk }) => {
  const { readSmallText } = await import(pathToFileURL(path.join(PLUGIN, "mcp", "src", "factory", "marker.js")).href)
  const { PATTERNS } = await import(pathToFileURL(path.join(PLUGIN, "mcp", "src", "factory", "schema.js")).href)
  const home = env.HOME
  await fs.mkdir(path.join(home, ".claude", "plugins"), { recursive: true })
  await fs.writeFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "desk@x": [{ version: "1.0.0", installPath: desk }] } }))
  for (const host of ["claude", "copilot"]) {
    const late = metadata({ host, pluginRoot: path.join(PLUGIN), home, env, readSmallText, PATTERNS, deadline: 0 })
    assert.equal(late.timedOut, true)
    assert.equal(late.incomplete, true)
    const fine = metadata({ host, pluginRoot: path.join(PLUGIN), home, env, readSmallText, PATTERNS })
    assert.equal(fine.timedOut, false)
  }
}))

// ---------------------------------------------------------------------------
// The size budget. Claude Code saves a SessionStart context over 10,000 characters to a file and shows a 2 KB preview, which cut the boot imperative off in round AJ.
// ---------------------------------------------------------------------------

// 300 characters under Claude Code's hard limit of 10,000; the measurement below already uses long worst-case paths.
const CONTEXT_BUDGET = 9700

// One pending migration is the budgeted case. Three (a stale install) can pass 10,000 whatever the foundation does, so that case pins only that the boot imperative still
// opens the context and names the boot script inside the first 2,000 characters, which Claude Code's preview always shows.
for (const [host, pending] of [["claude", 1], ["copilot", 1], ["claude", 3], ["copilot", 3]]) {
  test(`${host} session-start context with ${pending} pending migration${pending === 1 ? "" : "s"}, a cache-style plugin root, a long desk path and a pre-check line ${pending === 1 ? `stays within ${CONTEXT_BUDGET} characters` : "names the boot script in its first 2,000 characters"}`, () => scratch(async ({ base, env }) => {
    const root = path.join(base, "Users", "someone.long-name", ".claude", "plugins", "cache", "ourostack", "desk", "3.2.0-alpha.196")
    await fs.mkdir(path.dirname(root), { recursive: true })
    await fs.symlink(PLUGIN, root)
    const desk = path.join(base, "Users", "someone.long-name", "code", "organization-engineering", "personal-workspaces", "operator-desk-checkout")
    await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
    await fs.mkdir(path.join(desk, "_archive"))
    const { migrationLine } = await import("../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js")
    const migration = migrationLine(["02-tidy", "03-move", "04-more"].slice(0, pending).map((id) => ({ id, state: "agent_work" })), root)
    const precheck = "workspace-tidy deferred (0 listed); 1 task card with unreadable repos: greenhouse-ops/valve-firmware-flasher/task.md (repo ~/code/valve-firmware not found); their repositories were not inspected"
    const overrides = path.join(base, "budget-overrides.cjs")
    await fs.writeFile(overrides, `
require("node:test").mock.method(performance, "now", () => 0);
module.exports = {
  checks: [{ id: "fixture", budgetMs: 100, run: async () => ({ line: ${JSON.stringify(precheck)} }) }],
  migrationLine: async () => ${JSON.stringify(migration)},
};
`)
    const hookEnv = bootFixtureEnv({ ...env, PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: desk, DESK: desk, DESK_AUTO_BOOT: "0" }, overrides)
    const run = host === "copilot"
      ? spawnSync(process.execPath, [path.join(root, "hooks", "copilot-session-start.cjs")], { env: hookEnv, input: JSON.stringify({ cwd: desk }), encoding: "utf8" })
      : spawnSync(process.execPath, [path.join(root, "hooks", "claude-session-start.cjs"), path.join(root, "skills", "using-desk", "SKILL.md")], { env: hookEnv, encoding: "utf8" })
    assert.equal(run.status, 0, run.stderr)
    const parsed = JSON.parse(run.stdout)
    const context = parsed.additionalContext ?? parsed.hookSpecificOutput.additionalContext
    assert.match(context, /Desk boot pre-checks: workspace-tidy deferred/u, "the pre-check line is in the measured context")
    assert.match(context, /Desk migrations: 02-tidy is pending/u, "the migration line is in the measured context")
    assert.ok(context.startsWith("Desk startup:"), "the startup line leads")
    // The paths come from wherever this test runs, so measure with fixed ones: a cache-style plugin root (77 characters, ~/.claude/plugins/cache/ourostack/desk/3.2.0-alpha.196 under a long user name) and a 97-character desk path.
    const CACHE_ROOT = "/Users/someone.long-name/.claude/plugins/cache/ourostack/desk/3.2.0-alpha.196"
    const LONG_DESK = "/Users/someone.long-name/code/organization-engineering/personal-workspaces/operator-desk-checkout"
    const measured = [[desk, LONG_DESK], [root, CACHE_ROOT], [await fs.realpath(PLUGIN), CACHE_ROOT]].reduce((text, [from, to]) => text.split(from).join(to), context)
    assert.ok(measured.indexOf("Desk runs the session boot itself") >= 0 && measured.indexOf("Desk runs the session boot itself") < 2000, "the boot is explained inside the first 2,000 characters, where Claude Code's preview reaches")
    if (pending === 1) assert.ok(measured.length <= CONTEXT_BUDGET, `the SessionStart context is ${measured.length} characters with typical long paths; it must stay at most ${CONTEXT_BUDGET} so Claude Code (limit 10,000) shows all of it. Tighten the foundation or the startup line.`)
  }))
}
