// The session-start side of the factory: the boot-check registry both startup
// hooks run, the detached factory start, and byte-for-byte startup output.
// Every desk, store and process here is a throwaway fixture; nothing reaches
// the network, and hook processes run with a temporary HOME and state folder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { factoryStateRoot, quarantine, readStatus, requestEvaluation, requestFinalize, setConsent, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { indexJob } from "./_index_helper.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { resolveDeskStateDir, writeLastStart } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { copilotStartupDirection, claudeStartupDirection } from "../../../../../plugins/desk/mcp/src/util/startup-direction.js"
import { STORE, scratch } from "./_session_helpers.js"
import { main as factoryStartMain, DEADLINE_MS as factoryDeadlineMs } from "../../../../../plugins/desk/hooks/factory-start.cjs"

const require = createRequire(import.meta.url)
const HOOKS = fileURLToPath(new URL("../../../../../plugins/desk/hooks/", import.meta.url))
const PLUGIN = path.dirname(HOOKS)
const BOOT = path.join(HOOKS, "boot-checks.cjs")
const START = path.join(HOOKS, "factory-start.cjs")
const boot = () => {
  assert.ok(existsSync(BOOT), "the boot-check registry must exist")
  return require(BOOT)
}
const DAY = 24 * 60 * 60 * 1000

// A session start in an ordinary interactive session, whatever runs the tests (a CI runner sets CI; a headless Claude run sets the entry point).
const interactive = (env) => {
  const clean = { ...env }
  for (const name of ["CI", "GITHUB_ACTIONS", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "DESK_FACTORY_HEADLESS"]) delete clean[name]
  return clean
}
const quiet = { launchRepair: async () => {}, launch: async () => {}, record: async () => {} }
const check = (id, run, budgetMs = 100) => ({ id, budgetMs, run })

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

test("the registry runs its checks in order: factory, then labels, then desk-health, then workspace-tidy, then improvement", () => {
  assert.deepEqual(boot().checks.map((entry) => entry.id), ["factory", "labels", "andon", "desk-health", "workspace-tidy", "improvement"])
  assert.equal(boot().TOTAL_BUDGET_MS, 300)
  assert.ok(boot().checks.every((entry) => entry.budgetMs <= 300))
})

test("no line from any check means no output at all; lines join into exactly one Desk boot line", async () => {
  const { runBootChecks } = boot()
  const order = []
  const silent = await runBootChecks({ ...quiet, checks: [check("a", async () => { order.push("a"); return {} }), check("b", async () => { order.push("b"); return { line: "   " } })] })
  assert.equal(silent, "")
  assert.deepEqual(order, ["a", "b"])
  const spoken = await runBootChecks({ ...quiet, checks: [check("a", async () => ({ line: "first\nhalf" })), check("b", () => undefined), check("c", async () => ({ line: "second" }))] })
  assert.equal(spoken, "Desk boot pre-checks: first half; second")
  assert.equal(spoken.split("\n").length, 1)
})

test("repairs start detached after every check has run, and a repair that cannot start is ignored", async () => {
  const { runBootChecks } = boot()
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

test("a check that overruns its budget is skipped silently, but a check that throws is skipped, recorded and reported as a Desk problem: block; the rest still run", async () => {
  const { runBootChecks } = boot()
  const recorded = []
  let aborted = false
  const line = await runBootChecks({
    ...quiet,
    record: async (_env, skipped) => { recorded.push(...skipped) },
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
  assert.deepEqual(recorded.map(({ id, reason }) => ({ id, reason })), [{ id: "slow", reason: "budget" }, { id: "self-stopped", reason: "budget" }, { id: "broken", reason: "error" }])
  assert.ok(recorded.every((entry) => Number.isSafeInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0))
})

// A check that never yields, on a clock the test owns: the boot runner reads `performance.now()`, so blocking advances that clock by exactly `ms`. A real busy loop would let a loaded machine add time to every check and change which budget each one overruns.
let virtualNow = 0
const block = (ms) => { virtualNow += ms }
const useVirtualClock = (t) => {
  virtualNow = 0
  t.mock.method(performance, "now", () => virtualNow)
}

test("checks that block synchronously past their budgets are skipped with their real time, and that time counts against the total", async (t) => {
  useVirtualClock(t)
  const { runBootChecks } = boot()
  const recorded = []
  const repairs = []
  const line = await runBootChecks({
    ...quiet,
    record: async (_env, skipped) => { recorded.push(...skipped) },
    launchRepair: async (command) => repairs.push(command),
    checks: [
      check("a", () => { block(250); return { line: "a-late", repair: { command: ["node", "a.js"] } } }, 100),
      check("b", () => { block(40); return { line: "b", repair: { command: ["node", "b.js"] } } }, 50),
      check("c", () => { block(140); return { line: "c" } }, 260),
    ],
  })
  assert.equal(line, "Desk boot pre-checks: b", "a overran its own budget; c overran the 10 ms the total had left after a's real 250 ms")
  assert.deepEqual(repairs, [["node", "b.js"]], "an overrunning check's repair never starts")
  const byId = Object.fromEntries(recorded.map((entry) => [entry.id, entry]))
  assert.equal(byId.a.reason, "budget")
  assert.ok(byId.a.elapsed_ms >= 250, JSON.stringify(byId.a))
  assert.equal(byId.c.reason, "budget")
  assert.ok(byId.c.elapsed_ms >= 140, JSON.stringify(byId.c))
  assert.equal(byId.b, undefined, JSON.stringify(recorded))
  assert.equal(virtualNow, 250 + 40 + 140, "every check ran to its end on the owned clock")
})

test("the real elapsed time of each check is charged, so a total spent by blocking skips the rest without running them", async (t) => {
  useVirtualClock(t)
  const { runBootChecks } = boot()
  const recorded = []
  let ran = false
  const line = await runBootChecks({
    ...quiet,
    totalBudgetMs: 100,
    record: async (_env, skipped) => { recorded.push(...skipped) },
    checks: [check("first", () => { block(60); return { line: "first" } }, 80), check("second", () => { block(60); return { line: "second" } }, 80), check("third", () => { ran = true; return { line: "third" } }, 80)],
  })
  assert.equal(line, "Desk boot pre-checks: first")
  assert.equal(recorded[0].id, "second")
  assert.equal(recorded[0].reason, "budget")
  assert.deepEqual(recorded.slice(1).map(({ id, reason }) => ({ id, reason })), [{ id: "third", reason: "total_budget" }])
  assert.equal(ran, false)
})

test("the total budget caps every check, and checks after it are skipped", async () => {
  const { runBootChecks } = boot()
  const recorded = []
  const budgets = []
  const line = await runBootChecks({
    ...quiet,
    totalBudgetMs: 120,
    record: async (_env, skipped) => { recorded.push(...skipped) },
    checkBudgets: { first: 1000 },
    checks: [
      check("first", (ctx) => { budgets.push(ctx.budgetMs); return new Promise(() => {}) }, 50),
      check("second", async () => ({ line: "never" })),
    ],
  })
  assert.equal(line, "")
  assert.ok(budgets[0] <= 120)
  assert.deepEqual(recorded.map((entry) => entry.reason), ["budget", "total_budget"])
  const quick = await runBootChecks({ ...quiet, record: async () => { throw new Error("cannot record") }, checks: [check("x", () => new Promise(() => {}), 10)] })
  assert.equal(quick, "")
})

test("skips are recorded in the protected factory status only when factory state already exists", () => scratch(async ({ env, base }) => {
  const { recordSkipped, runBootChecks } = boot()
  assert.equal(await recordSkipped(env, [{ id: "x", reason: "budget" }]), false)
  assert.equal(existsSync(path.join(base, "state")), false)
  await setConsent(env, { store: STORE, contribute: false })
  await runBootChecks({ env, launchRepair: async () => {}, checks: [check("stalled", () => new Promise(() => {}), 10)] })
  const status = await readStatus(env)
  assert.deepEqual(status.boot_checks.skipped.map(({ id, reason }) => ({ id, reason })), [{ id: "stalled", reason: "budget" }])
  assert.ok(status.boot_checks.skipped[0].elapsed_ms >= 9)
  assert.match(status.boot_checks.at, /^\d{4}-\d{2}-\d{2}T/u)
}))

test("launchCommand starts detached with ignored stdio and never waits for the child", async () => {
  const { launchCommand } = boot()
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
// The factory and desk-health checks inside the registry.
// ---------------------------------------------------------------------------

test("the factory check says nothing when the bound desk's store has no decision (the boot script owns the question), and is silent without a desk", () => scratch(async ({ env, desk }) => {
  const { runBootChecks, factoryCheck } = boot()
  const run = (options) => runBootChecks({ ...quiet, checks: [factoryCheck], checkBudgets: { factory: 2000 }, totalBudgetMs: 2000, ...options })
  assert.equal(await run({ host: "claude", env }), "")
  assert.equal(await run({ host: "copilot", env, sessionFolder: desk }), "")
  const unbound = { ...env, DESK: "" }
  delete unbound.DESK
  assert.equal(await run({ host: "claude", env: { ...unbound, HOME: path.join(desk, "..", "empty-home") } }), "")
}))

test("the factory check starts one detached finalize for finished jobs whose facts are not delivered", () => scratch(async ({ env, desk }) => {
  const { runBootChecks, factoryCheck } = boot()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const folder = path.join(desk, "alpha", "shipped")
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, "task.md"), `---\nstatus: done\nupdated: ${new Date(Date.now() - DAY).toISOString()}\n---\n`)
  const job = jobId({ deskRemote: `local:${await fs.realpath(desk)}`, personPrefix: "", track: "alpha", slug: "shipped" })
  await requestFinalize(env, { job, deskRoot: desk })
  // A Claude Code plugin registry that lists this Desk and no overlay: a missing registry, or one without this Desk, holds the route, and with it every finalize.
  await fs.mkdir(path.join(env.HOME, ".claude", "plugins"), { recursive: true })
  await fs.writeFile(path.join(env.HOME, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "desk@ourostack": [{ version: "1.0.0", installPath: PLUGIN }] } }))
  const repairs = []
  const line = await runBootChecks({ ...quiet, host: "claude", env, checks: [factoryCheck], checkBudgets: { factory: 2000 }, totalBudgetMs: 2000, launchRepair: async (command) => repairs.push(command) })
  assert.equal(line, "")
  assert.deepEqual(repairs, [[process.execPath, BOOT, "--compatible", path.join(PLUGIN, "mcp", "scripts", "factory.js"), "finalize", "--job", job]], "finalize starts through the compatible-Node launcher")
  const person = []
  await runBootChecks({ ...quiet, host: "claude", env: { ...env, DESK_PERSON: "../bad" }, checks: [factoryCheck], checkBudgets: { factory: 2000 }, totalBudgetMs: 2000, launchRepair: async (command) => person.push(command) })
  assert.equal(person.length, 1, "an invalid person alias falls back to the desk's own tracks")
  const none = []
  await runBootChecks({ ...quiet, host: "claude", env: { ...env, DESK_PERSON: "sam" }, checks: [factoryCheck], checkBudgets: { factory: 2000 }, totalBudgetMs: 2000, launchRepair: async (command) => none.push(command) })
  assert.deepEqual(none, repairs, "a pending request is finalized whatever person prefix the task tools bound it under")
}))

test("the labels check names how many finished jobs wait for labels and what the plugin is doing, and starts nothing", () => scratch(async ({ env, desk }) => {
  const { runBootChecks, labelsCheck } = boot()
  const repairs = []
  env = interactive(env)
  const run = (options = {}) => runBootChecks({ ...quiet, host: "claude", env, checks: [labelsCheck], checkBudgets: { labels: 2000 }, totalBudgetMs: 2000, launchRepair: async (command) => repairs.push(command), ...options })
  // No consent, or nothing retained: silent, and no factory state is created.
  assert.equal(await run(), "")
  assert.equal(existsSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills")), false)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.equal(await run(), "")
  await requestEvaluation(env, { job: "9f2c4b1a7d3e5f60718293a4b5c6d7e8", deskRoot: desk })
  await requestEvaluation(env, { job: "5e6f708192a3b4c5d6e7f8091a2b3c4d", deskRoot: desk })
  await fs.writeFile(path.join(await factoryStateRoot(env), "evaluate-requests", "notes.txt"), "x")
  assert.equal(await run(), "Desk boot pre-checks: Factory evaluator: 2 finished jobs wait for labels (oldest 0 days); the plugin labels them in the background, no result recorded yet")
  assert.deepEqual(repairs, [], "the plugin runs the evaluator itself: the boot check starts no repair")
  // Labels quarantined with their facts are reported, and a job whose every session is held back is not counted as waiting.
  const root = await factoryStateRoot(env)
  await indexJob(env, "5e6f708192a3b4c5d6e7f8091a2b3c4d", "claude-code-00000001-0000-4000-8000-000000000001.json")
  await quarantine(env, STORE, "labels/5e6f708192a3b4c5d6e7f8091a2b3c4d/00000001-0000-4000-8000-000000000001.json", "facts_quarantined", { facts: "claude-code-00000001-0000-4000-8000-000000000001.json" })
  assert.equal(await run(), "Desk boot pre-checks: Factory evaluator: 1 finished job waits for labels (oldest 0 days); the plugin labels them in the background, no result recorded yet; Factory: 1 finished job has quarantined waste labels; no card is open for it yet")
  // Quarantined labels alone are reported without a repair.
  await fs.rm(path.join(root, "evaluate-requests", "9f2c4b1a7d3e5f60718293a4b5c6d7e8.json"))
  repairs.length = 0
  assert.equal(await run(), "Desk boot pre-checks: Factory: 1 finished job has quarantined waste labels; no card is open for it yet")
  assert.deepEqual(repairs, [])
  // A declined store keeps the check silent.
  await setConsent(env, { store: STORE, contribute: false, account: "contributor" })
  assert.equal(await run(), "")
}))

test("the desk-health check reports a degraded last start and otherwise asks for the fast-forward", () => scratch(async ({ env, desk, base }) => {
  const { runBootChecks, deskHealthCheck } = boot()
  const run = (options) => runBootChecks({ ...quiet, checks: [deskHealthCheck], checkBudgets: { "desk-health": 2000 }, totalBudgetMs: 2000, ...options })
  assert.equal(await run({ host: "claude", env }), "")
  execFileSync("git", ["init", "-q", "-b", "main", desk])
  const stateDir = resolveDeskStateDir({ env })
  const real = await fs.realpath(desk)
  writeLastStart({ stateDir, root: real, snapshot: { state: "degraded:state_branch_detached", code: "state_branch_detached", repair: null, fix: null } })
  assert.equal(await run({ host: "claude", env }), "Desk boot pre-checks: Desk: degraded (desk checkout detached; writes paused); run desk_doctor")
  writeLastStart({ stateDir, root: real, snapshot: { state: "ready", code: null, repair: null, fix: null } })
  const repairs = []
  assert.equal(await run({ host: "claude", env, launchRepair: async (command) => repairs.push(command) }), "")
  assert.deepEqual(repairs, [[process.execPath, BOOT, "--compatible", BOOT, "--fast-forward", desk]], "the fast-forward starts through the compatible-Node launcher")
  const crew = path.join(base, "crew")
  await fs.mkdir(path.join(crew, "_meta"), { recursive: true })
  await fs.mkdir(path.join(crew, "desks"), { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main", crew])
  writeLastStart({ stateDir, root: crew, snapshot: { state: "degraded:crew_state_not_main", code: "crew_state_not_main", repair: null, fix: null } })
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
// Starting delivery.
// ---------------------------------------------------------------------------

test("startFactory starts factory-start.cjs detached only when a store has contribute: true", () => scratch(async ({ env }) => {
  const { startFactory } = boot()
  const launched = []
  const launch = async (command, childEnv) => launched.push({ command, childEnv })
  assert.equal(await startFactory({ env, launch }), false)
  await setConsent(env, { store: STORE, contribute: false })
  assert.equal(await startFactory({ env, launch }), false)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.equal(await startFactory({ env, launch }), true)
  assert.deepEqual(launched.map((entry) => entry.command), [[process.execPath, BOOT, "--compatible", START], [process.execPath, BOOT, "--compatible", path.join(HOOKS, "loop-start.cjs")]], "delivery, then the loop worker's launcher, start through the compatible-Node launcher")
  assert.equal(launched[0].childEnv, env)
  assert.equal(await startFactory({ env, launch: async () => { throw new Error("spawn failed") } }), false)
}))

test("the andon check names each contributing store's open andon issues in one line, with no repair", () => scratch(async ({ env: raw }) => {
  const env = interactive(raw)
  const { runBootChecks, andonCheck } = boot()
  const repairs = []
  const run = () => runBootChecks({ ...quiet, host: "claude", env, checks: [andonCheck], checkBudgets: { andon: 2000 }, totalBudgetMs: 2000, launchRepair: async (command) => repairs.push(command) })
  assert.equal(await run(), "")
  assert.equal(existsSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills")), false)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(env, { store: "acme/work", contribute: true, account: "worker" })
  // No refresh has run yet for either store: said out loud, never silent.
  assert.equal(await run(), "Desk boot pre-checks: Factory: andon state unknown for acme/work (never refreshed) (not_refreshed); Factory: andon state unknown for ourostack/factory (never refreshed) (not_refreshed)")
  const at = new Date().toISOString()
  await writeStatus(env, { andon: { [STORE]: { checked_at: at, issues: [{ number: 41, title: "Andon: desk 3.4.0 tool_failures other" }] }, "acme/work": { checked_at: at, issues: [] } } })
  assert.equal(await run(), "Desk boot pre-checks: Factory: 1 open andon issue in ourostack/factory (#41); it has no improvement card yet, and gets one at the next background step")
  // A failed refresh after the last good one: unknown, beside the last known issues.
  await writeStatus(env, { andon: { [STORE]: { checked_at: at, issues: [{ number: 41, title: "x" }], failure: "auth_failed", failed_at: new Date(Date.parse(at) + 1000).toISOString() }, "acme/work": { checked_at: at, issues: [] } } })
  assert.equal(await run(), `Desk boot pre-checks: Factory: andon state unknown for ourostack/factory since ${at.slice(0, 10)} (auth_failed); Factory: 1 open andon issue in ourostack/factory (#41); it has no improvement card yet, and gets one at the next background step`)
  assert.deepEqual(repairs, [])
}))

test("factory-start.cjs runs sweep and flush for consented stores, prints nothing and exits 0", () => scratch(async ({ env }) => {
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

async function preloadFor(dir, { lines = null, calls }) {
  const file = path.join(dir, `preload-${Math.random().toString(16).slice(2)}.cjs`)
  await fs.writeFile(file, `
// NODE_OPTIONS reaches every Node process the hook starts, including each migration's Detect, which has a two-second budget; only the hook itself needs the fixture checks.
if (/(copilot-session-start\\.cjs|resolve-desk-root\\.js)$/u.test(process.argv[1] ?? "")) {
  const fs = require("node:fs");
  const boot = require(${JSON.stringify(BOOT)});
  boot.checks.splice(0, boot.checks.length, ...${JSON.stringify(lines ?? [])}.map((line, index) => ({ id: "fixture-" + index, budgetMs: 100, run: async () => ({ line }) })));
  boot.startFactory = async () => { fs.appendFileSync(${JSON.stringify(calls)}, "started\\n"); return true; };
}
`)
  return file
}

function runHook(host, env, desk) {
  return host === "copilot"
    ? spawnSync(process.execPath, [path.join(HOOKS, "copilot-session-start.cjs")], { env, input: JSON.stringify({ cwd: desk }), encoding: "utf8" })
    : spawnSync("bash", [path.join(HOOKS, "session-start.sh"), path.join(PLUGIN, "skills", "using-desk", "SKILL.md")], { env, encoding: "utf8" })
}

// `checks` is the boot pre-checks line a speaking check adds ("\n\nDesk boot pre-checks: ..."). Both hosts add it to the startup
// direction, which opens the context (Claude Code keeps only a 2 KB preview of a context past 10,000 characters, so the boot imperative leads).
function expectedContext(host, env, desk, checks = "") {
  const skill = readFileSync(path.join(PLUGIN, "skills", "using-desk", "SKILL.md"), "utf8")
  const rfc = path.join(PLUGIN, "docs", "agentic-engineering-v2-rfc.md")
  if (host === "copilot") return `${copilotStartupDirection({ env, sessionFolder: desk })}${checks}\n\n${skill.trimEnd()}\n\nDesk RFC: ${rfc}`
  // Bash command substitution drops the file's trailing newlines, as `trimEnd` does for the newline-only tail.
  return `${claudeStartupDirection({ env })}${checks}\n\n${skill.replace(/\n+$/u, "")}\n\nDesk RFC: ${rfc}\n`
}

function envelope(host, context) {
  if (host === "copilot") return JSON.stringify({ additionalContext: context })
  return `${execFileSync("jq", ["-nc", "--arg", "c", context, "{hookSpecificOutput:{hookEventName:\"SessionStart\",additionalContext:$c}}"], { encoding: "utf8" }).trimEnd()}\n`
}

// jq.exe ends its line with CRLF on Windows; the line ending is whitespace to the JSON reader, so only the bytes before it must match.
const jqLine = (stdout) => process.platform === "win32" ? stdout.replace(/\r\n$/u, "\n") : stdout

for (const host of ["claude", "copilot"]) {
  test(`${host} session-start output is byte-identical when no boot check speaks, and gains exactly one line when they do`, () => scratch(async ({ env, desk, base }) => {
    const calls = path.join(base, "calls.txt")
    const hookEnv = { ...env, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: desk }
    const silent = await preloadFor(base, { calls })
    const quietRun = runHook(host, { ...hookEnv, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${silent}`.trim() }, desk)
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

    const speaking = await preloadFor(base, { lines: ["one", "two"], calls })
    const spokenRun = runHook(host, { ...hookEnv, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${speaking}`.trim() }, desk)
    assert.equal(spokenRun.status, 0, spokenRun.stderr)
    const spoken = JSON.parse(spokenRun.stdout)
    assert.equal(spoken.additionalContext ?? spoken.hookSpecificOutput.additionalContext, expectedContext(host, hookEnv, desk, "\n\nDesk boot pre-checks: one; two"))
    if (host === "copilot" || hasJq) assert.equal(jqLine(spokenRun.stdout), envelope(host, expectedContext(host, hookEnv, desk, "\n\nDesk boot pre-checks: one; two")))
    assert.equal(readFileSync(calls, "utf8"), "started\nstarted\n", "each start launches factory delivery once, after its output is built")
  }))
}

test("the real hooks with a bound desk and no decision add no factory boot line and never ask for consent", () => scratch(async ({ env, desk, base }) => {
  const preload = path.join(base, "relax.cjs")
  await fs.writeFile(preload, `const boot = require(${JSON.stringify(BOOT)}); const run = boot.runBootChecks; boot.runBootChecks = (options) => run({ ...options, launch: async () => {}, launchRepair: async () => {}, totalBudgetMs: 5000, checkBudgets: { factory: 2000, "desk-health": 2000, "workspace-tidy": 2000 } });\n`)
  const hookEnv = { ...env, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: desk, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${preload}`.trim() }
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

test("the Claude resolver appends the boot line only when there is one and starts delivery afterwards", async () => {
  const { main } = await import(pathToFileURL(path.join(PLUGIN, "mcp", "scripts", "resolve-desk-root.js")).href)
  const events = []
  const loadBoot = async () => ({ default: { migrationLine: async () => { events.push("migrations"); return "" }, runBootChecks: async () => { events.push("checks"); return "" }, startFactory: async () => { events.push("factory") } } })
  let output = ""
  await main({ argv: ["--startup-line", "--boot-checks"], env: { HOME: "/nonexistent-home" }, write: (text) => { output = text; events.push("write") }, loadBoot })
  assert.deepEqual(events, ["migrations", "checks", "factory", "write"], "the migration check starts before the boot checks and runs alongside them")
  assert.doesNotMatch(output, /\n\n$/u)
  assert.doesNotMatch(output, /Desk boot|Desk migrations/u)
  const speaking = async () => ({ default: { migrationLine: async () => "Desk migrations: y", runBootChecks: async () => "Desk boot pre-checks: x", startFactory: async () => {} } })
  await main({ argv: ["--startup-line", "--boot-checks"], env: { HOME: "/nonexistent-home" }, write: (text) => { output = text }, loadBoot: speaking })
  assert.match(output, /\n\nDesk boot pre-checks: x\n\nDesk migrations: y$/u)
  const migrationsOnly = async () => ({ default: { migrationLine: async () => "Desk migrations: y", runBootChecks: async () => "", startFactory: async () => {} } })
  await main({ argv: ["--startup-line", "--boot-checks"], env: { HOME: "/nonexistent-home" }, write: (text) => { output = text }, loadBoot: migrationsOnly })
  assert.match(output, /[^\n]\n\nDesk migrations: y$/u)
  assert.doesNotMatch(output, /Desk boot/u)
})

test("the plugin scan stops at the check's deadline and the factory check is then skipped, never guessed", () => scratch(async ({ env, desk }) => {
  const { metadata } = require(path.join(HOOKS, "factory-end.cjs"))
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
  const { runBootChecks, factoryCheck } = boot()
  const recorded = []
  const line = await runBootChecks({ ...quiet, host: "claude", env, checks: [{ ...factoryCheck, run: (ctx) => factoryCheck.run({ ...ctx, deadline: 0 }) }], record: async (_env, skipped) => recorded.push(...skipped) })
  assert.equal(line, "")
  assert.equal(recorded[0].reason, "budget")
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
    const preload = path.join(base, "budget-preload.cjs")
    await fs.writeFile(preload, `
const boot = require(${JSON.stringify(BOOT)});
boot.checks.splice(0, boot.checks.length, { id: "fixture", budgetMs: 100, run: async () => ({ line: ${JSON.stringify(precheck)} }) });
boot.migrationLine = async () => ${JSON.stringify(migration)};
boot.startFactory = async () => true;
`)
    const hookEnv = { ...env, PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: desk, DESK: desk, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${preload}`.trim() }
    const run = host === "copilot"
      ? spawnSync(process.execPath, [path.join(root, "hooks", "copilot-session-start.cjs")], { env: hookEnv, input: JSON.stringify({ cwd: desk }), encoding: "utf8" })
      : spawnSync("bash", [path.join(root, "hooks", "session-start.sh"), path.join(root, "skills", "using-desk", "SKILL.md")], { env: hookEnv, encoding: "utf8" })
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
    assert.ok(measured.indexOf("session-boot.js") >= 0 && measured.indexOf("session-boot.js") < 2000, "the boot script is named inside the first 2,000 characters, where Claude Code's preview reaches")
    if (pending === 1) assert.ok(measured.length <= CONTEXT_BUDGET, `the SessionStart context is ${measured.length} characters with typical long paths; it must stay at most ${CONTEXT_BUDGET} so Claude Code (limit 10,000) shows all of it. Tighten the foundation or the startup line.`)
  }))
}
