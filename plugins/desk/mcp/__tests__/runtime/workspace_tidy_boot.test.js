import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { mkTempRoot } from "../_temp_roots.js"
import { dispositionRecord, mergeTidyEvidence } from "../../src/runtime/workspace-evidence.js"

const require = createRequire(import.meta.url)
const hookPath = new URL("../../../hooks/boot-checks.cjs", import.meta.url)
let boot = {}
try { boot = require(hookPath.pathname) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

async function fixture() {
  const root = await mkTempRoot("desk-tidy-boot-")
  const desk = path.join(root, "desk")
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  git(desk, "init", "-b", "main")
  git(desk, "config", "user.name", "Fixture")
  git(desk, "config", "user.email", "fixture@example.invalid")
  git(desk, "commit", "--allow-empty", "-m", "init")
  return { root, desk, env: { ...process.env, HOME: root, DESK: desk, DESK_ACTIVATION_CONFIG: "" } }
}

// Tests that read what the boot line reports (last repair, locks, launch failures) are not timing tests: they lift both the whole-check budget and the inspection budget so a loaded machine cannot turn the line into "budget exceeded". The budgets themselves are asserted by the deadline and cancellation tests below.
const DETAIL_BUDGET_MS = 30_000
// The registry's total budget, which also bounds the workspace-tidy check's own soft deadline.
const BOOT_BUDGET_MS = boot.TOTAL_BUDGET_MS
// A check whose launch never resolves can return only through its timer; this limit fails a check that waits on the launch without mistaking a loaded machine for one.
const STALLED_LAUNCH_LIMIT_MS = 5_000
// The workspace-tidy check alone, through the shared registry. `budgetMs` is the check's own soft deadline (by default its registry budget less the 20 ms margin); the registry's budgets are lifted so only that deadline is under test.
function tidy({ budgetMs, ...options } = {}) {
  return boot.runBootChecks({
    checks: [boot.workspaceTidyCheck], totalBudgetMs: 10 * DETAIL_BUDGET_MS, checkBudgets: { "workspace-tidy": 10 * DETAIL_BUDGET_MS }, record: async () => {},
    ...options, tidyBudgetMs: budgetMs ?? boot.workspaceTidyCheck.budgetMs - 20,
  })
}
function readBootDetails(options) {
  return tidy({ budgetMs: DETAIL_BUDGET_MS, inspectionBudgetMs: DETAIL_BUDGET_MS, ...options })
}
// The detached repair writes its report once it has inspected the fixture; the wait watches for the report and leaves a loaded machine ample room.
const REPAIR_REPORT_WAIT_MS = 30_000
const INCOMPLETE_REPAIR_RETRIES = 5
// A report from a repair whose Git inspection failed, rather than one that inspected and decided.
const inspectionFailed = (report) => report !== undefined && (report.issues.length > 0 || report.left.some((entry) => /Command failed|timed out|incomplete inventory/u.test(entry.reason)))

test("boot check queues a detached repair, returns without waiting, and records complete leftovers", async (t) => {
  assert.equal(typeof boot.runBootChecks, "function")
  const f = await fixture()
  const w = path.join(f.root, "unowned")
  git(f.desk, "worktree", "add", "-b", "unowned", w)
  const started = performance.now()
  const line = await tidy({ host: "copilot", env: f.env, sessionFolder: f.desk })
  const elapsed = performance.now() - started
  t.diagnostic(`boot check returned in ${Math.round(elapsed)} ms (whole-check budget ${BOOT_BUDGET_MS} ms)`)
  // The whole-check budget is what keeps session start from waiting on the repair. The bound is that budget plus the same again for a loaded event loop, still far below the repair's own run time.
  assert.ok(elapsed < 2 * BOOT_BUDGET_MS, `the boot check took ${Math.round(elapsed)} ms`)
  assert.match(line, /^Desk boot: workspace-tidy/)
  assert.match(line, /deferred/)
  assert.equal(line.split("\n").length, 1)
  if (line.startsWith("Desk boot: workspace-tidy budget exceeded")) {
    // A loaded machine can spend the whole budget before the launch, and then nothing is queued until the next session start. Queue the repair the way that next start does, without the budget, so the leftovers are still recorded.
    t.diagnostic("the whole-check budget ran out before the launch; the repair was queued by a second boot check")
    assert.match(await readBootDetails({ host: "copilot", env: f.env, sessionFolder: f.desk }), /deferred \(/)
  }
  const reportPath = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  const waited = performance.now()
  const deadline = Date.now() + REPAIR_REPORT_WAIT_MS
  let report
  while (Date.now() < deadline) {
    try { report = await boot.readReport(reportPath); break } catch (error) { if (error.code !== "ENOENT") throw error }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  t.diagnostic(`the detached repair wrote its report ${Math.round(performance.now() - waited)} ms after the boot check returned`)
  // Each Git call in a repair has a 2 s limit. On a loaded machine one can run out, and the repair then records an honest incomplete report (an issue, or a leftover whose reason is the failed Git call) that the next session start's repair replaces. Only that outcome is repaired again, a bounded number of times; any other report is asserted as it is.
  for (let attempt = 1; attempt <= INCOMPLETE_REPAIR_RETRIES && inspectionFailed(report); attempt += 1) {
    t.diagnostic(`repair ${attempt} could not finish inspecting on a loaded machine (${JSON.stringify({ issues: report.issues, left: report.left.map((entry) => entry.reason) })}); repairing again as the next session start would`)
    let result
    do {
      result = await boot.runRepair(f.desk)
      if (result.busy) await new Promise((resolve) => setTimeout(resolve, 100))
    } while (result.busy)
    report = await boot.readReport(reportPath)
  }
  assert.equal(report?.left.length, 1)
  assert.equal(report.left[0].path, w)
  assert.match(report.left[0].reason, /ownership/)
  assert.ok((await fs.stat(w)).isDirectory())
  const next = await readBootDetails({ host: "copilot", env: f.env, sessionFolder: f.desk, launch: async () => {} })
  assert.match(next, /1 left/)
  assert.match(next, /ownership/)
})

test("ambiguous Copilot binding never launches cleanup against a guessed desk", async () => {
  const f = await fixture()
  const other = path.join(f.root, "other")
  await fs.mkdir(path.join(other, "_meta"), { recursive: true })
  await fs.mkdir(path.join(other, "_archive"))
  const line = await tidy({ host: "copilot", env: f.env, sessionFolder: other })
  assert.match(line, /binding.*ambiguous/)
  assert.equal((await fs.readdir(path.join(f.desk, ".git"))).some((name) => name.startsWith("desk-workspace")), false)
})

test("boot failure degrades in one bounded line and never blocks session start", async () => {
  const f = await fixture()
  const bad = path.join(f.root, "bad.json")
  await fs.writeFile(bad, "{")
  const line = await tidy({ host: "claude", env: { ...f.env, DESK_ACTIVATION_CONFIG: bad } })
  assert.match(line, /^Desk boot:/)
  assert.match(line, /binding|configuration/)
  assert.ok(line.length <= 512)
})

test("both actual startup hooks include exactly one boot line without changing their host envelope", async () => {
  const f = await fixture()
  const plugin = path.resolve(hookPath.pathname, "../..")
  // Generous budgets: this test is about the envelope and the single line, not about a loaded host's timing.
  const preload = path.join(f.root, "relax-budgets.cjs")
  await fs.writeFile(preload, `const boot = require(${JSON.stringify(fileURLToPath(hookPath))}); const run = boot.runBootChecks; boot.runBootChecks = (options) => run({ ...options, totalBudgetMs: 5000, checkBudgets: { factory: 2000, "desk-health": 2000, "workspace-tidy": 2000 } });\n`)
  const env = { ...f.env, PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: f.desk, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim() }
  for (const host of ["copilot", "claude"]) {
    const result = host === "copilot"
      ? execFileSync(process.execPath, [path.join(plugin, "hooks", "copilot-session-start.cjs")], { env, input: JSON.stringify({ cwd: f.desk }), encoding: "utf8" })
      : execFileSync("bash", [path.join(plugin, "hooks", "session-start.sh")], { env, encoding: "utf8" })
    const parsed = JSON.parse(result)
    const context = parsed.additionalContext ?? parsed.hookSpecificOutput.additionalContext
    assert.equal((context.match(/Desk boot:/gu) ?? []).length, 1)
    assert.match(context, /Desk startup:/)
  }
  // Let the exact fixture-only repairs finish before the fixture owner removes the root.
  await new Promise((resolve) => setTimeout(resolve, 300))
})

test("the complete boot check has a deadline even when launching repair stalls", async (t) => {
  const f = await fixture()
  // Real time: a stalled launch never resolves, so the check returns only through its own timer. The bound is generous for a loaded machine and still fails a check that waits on the launch.
  const started = performance.now()
  const line = await tidy({ host: "copilot", env: f.env, sessionFolder: f.desk, budgetMs: 60, launch: () => new Promise(() => {}) })
  const elapsed = performance.now() - started
  t.diagnostic(`a 60 ms budget returned in ${Math.round(elapsed)} ms with the launch stalled`)
  assert.ok(elapsed < STALLED_LAUNCH_LIMIT_MS, `the boot check took ${Math.round(elapsed)} ms`)
  assert.match(line, /budget.*deferred/)

  // Mocked time: the check ends exactly at the budget it was given, not at the 500 ms default, once the launch has begun and stalled.
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let launching
  const launched = new Promise((resolve) => { launching = resolve })
  let result
  const pending = tidy({ host: "copilot", env: f.env, sessionFolder: f.desk, budgetMs: 60, inspectionBudgetMs: DETAIL_BUDGET_MS, launch: () => { launching(); return new Promise(() => {}) } })
    .then((value) => { result = value })
  await launched
  t.mock.timers.tick(59)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(result, undefined, "the check must wait out its whole budget")
  t.mock.timers.tick(1)
  await pending
  assert.match(result, /budget.*deferred/)
})

test("existing repair locks expose the exact pending resource without stealing it", async () => {
  const f = await fixture()
  const file = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  await fs.writeFile(`${file}.lock`, "another-owner")
  const result = await boot.runRepair(f.desk)
  assert.equal(result.busy, true)
  assert.equal(await fs.readFile(`${file}.lock`, "utf8"), "another-owner")
  const line = await readBootDetails({ host: "copilot", env: f.env, sessionFolder: f.desk, launch: async () => {} })
  assert.match(line, /repair lock/)
})

for (const host of ["copilot", "claude"]) test(`R5 actual ${host} hook process cancels its stalled inspection child before the whole-check budget`, async () => {
  const f = await fixture()
  const plugin = path.resolve(fileURLToPath(hookPath), "../..")
  const preload = path.join(f.root, "stall-inspection.cjs")
  const proof = path.join(f.root, "process-proof.json")
  await fs.writeFile(preload, `
const cp = require("node:child_process");
const fs = require("node:fs");
const original = cp.execFile;
const born = Date.now();
const children = [];
cp.execFile = function(file, args, options, callback) {
  const child = original(process.execPath, ["-e", "setTimeout(() => {}, 1400)"], options, callback);
  children.push({pid: child.pid, spawned: Date.now()});
  child.once("close", () => { children.find(x => x.pid === child.pid).closed = Date.now(); });
  return child;
};
require("node:module").syncBuiltinESMExports();
require(${JSON.stringify(fileURLToPath(hookPath))}).runBootChecks = ((run) => options => run({...options, launch: async () => {}}))(require(${JSON.stringify(fileURLToPath(hookPath))}).runBootChecks);
process.once("exit", () => fs.writeFileSync(${JSON.stringify(proof)}, JSON.stringify({born, exited:Date.now(), children})));
`)
  const child = spawn(host === "claude" ? "bash" : process.execPath, [path.join(plugin, "hooks", host === "claude" ? "session-start.sh" : "copilot-session-start.cjs")], {
    env: { ...f.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: f.desk, NODE_OPTIONS: `--require=${preload}` }, stdio: ["pipe", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stdin.end(JSON.stringify({ cwd: f.desk }))
  const [code] = await once(child, "close")
  assert.equal(code, 0)
  const parsed = JSON.parse(output)
  assert.match(parsed.additionalContext ?? parsed.hookSpecificOutput.additionalContext, /Desk boot:.*deferred/)
  const timing = JSON.parse(await fs.readFile(proof, "utf8"))
  assert.equal(timing.children.length, 1)
  assert.ok(timing.children.every((entry) => entry.closed), "every exact owned child closed")
  assert.ok(timing.exited - timing.born < 500, JSON.stringify(timing))
  for (const entry of timing.children) assert.throws(() => process.kill(entry.pid, 0), { code: "ESRCH" })
})

test("R3/R2 CLI acknowledges exact canonical accounting and refuses wrong revocation authority", async () => {
  const f = await fixture()
  const common = git(f.desk, "rev-parse", "--absolute-git-dir")
  const entry = dispositionRecord({ repository: common, worktree: "/recorded/topic", branch: "refs/heads/topic", head: "abc", owner: "task" }, "removed", true)
  await fs.writeFile(boot.reportPath(f.desk, common), JSON.stringify(mergeTidyEvidence({}, {}, entry)))
  const run = (args) => spawnSync(process.execPath, [fileURLToPath(hookPath), ...args], { encoding: "utf8", env: f.env })
  const ack = run(["--ack", f.desk, entry.id, entry.digest, "task.md#resources"])
  assert.equal(ack.status, 0, ack.stderr)
  assert.equal(JSON.parse(ack.stdout).resources.length, 0)
  const revoked = run(["--revoke", common, f.desk, "refs/heads/main", "wrong-owner"])
  assert.equal(revoked.status, 1)
  assert.doesNotMatch(revoked.stderr, /usage:/)
  const invalid = run([])
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /usage:/)
})

test("boot reports absent bindings, malformed reports and repair launch failures explicitly", async () => {
  assert.match(await tidy(), /no bound desk/)
  const f = await fixture()
  const common = git(f.desk, "rev-parse", "--absolute-git-dir")
  const file = boot.reportPath(f.desk, common)
  await fs.writeFile(file, "{")
  await assert.rejects(boot.runRepair(f.desk), /JSON/)
  const bad = await readBootDetails({ host: "claude", env: f.env, launch: async () => {} })
  assert.match(bad, /report unreadable/)
  await fs.writeFile(file, JSON.stringify({ root: "different", removed: [], left: [], issues: [] }))
  assert.doesNotMatch(await readBootDetails({ host: "claude", env: f.env, launch: async () => {} }), /Last repair/)
  assert.match(await readBootDetails({ host: "claude", env: f.env, launch: async () => { throw new Error("launch failed") } }), /launch failed/)
  const nonGit = path.join(f.root, "nonGit")
  await fs.mkdir(nonGit)
  await assert.rejects(boot.runRepair(nonGit), /not an inspectable/)
  await fs.unlink(file)
  await fs.symlink(path.join(f.desk, "tracked"), file)
  await assert.rejects(boot.readReport(file), /unsafe/)
})

test("boot lock I/O failures and a slow report read do not authorize late launch", async (t) => {
  const f = await fixture()
  const common = git(f.desk, "rev-parse", "--absolute-git-dir")
  const file = boot.reportPath(f.desk, common)
  const lstat = fs.lstat.bind(fs)
  const mock = t.mock.method(fs, "lstat", (candidate) => candidate === `${file}.lock`
    ? Promise.reject(Object.assign(new Error("lock denied"), { code: "EACCES" })) : lstat(candidate))
  assert.match(await readBootDetails({ host: "claude", env: f.env, launch: async () => {} }), /lock unreadable/)
  mock.mock.restore()
  const open = fs.open.bind(fs)
  const denied = t.mock.method(fs, "open", (candidate, ...args) => candidate === `${file}.lock`
    ? Promise.reject(Object.assign(new Error("lock access denied"), { code: "EACCES" })) : open(candidate, ...args))
  await assert.rejects(boot.runRepair(f.desk), /access denied/)
  denied.mock.restore()
  await fs.writeFile(file, JSON.stringify({ root: f.desk, removed: [], left: [], issues: [] }))
  const read = fs.readFile.bind(fs)
  let release
  const entered = new Promise((resolve) => { release = resolve })
  let finish
  const delayed = t.mock.method(fs, "readFile", async (candidate, ...args) => {
    if (candidate === file) { release(); await new Promise((resolve) => { finish = resolve }) }
    return read(candidate, ...args)
  })
  let launched = false
  // Mocked time: the whole-check budget expires while the report read is held, however long a loaded machine takes to reach that read.
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending = tidy({ host: "claude", env: f.env, budgetMs: 500, inspectionBudgetMs: DETAIL_BUDGET_MS, launch: async () => { launched = true } })
  await entered
  t.mock.timers.tick(500)
  assert.match(await pending, /budget/)
  t.mock.timers.reset()
  finish()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(launched, false)
  delayed.mock.restore()
})

test("repair never removes a root lock replaced by another exact owner", async (t) => {
  const f = await fixture()
  const file = boot.reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (source, target) => {
    await rename(source, target)
    if (target === file) await fs.writeFile(`${file}.lock`, JSON.stringify({ token: "new-owner" }))
  })
  await boot.runRepair(f.desk)
  assert.equal(JSON.parse(await fs.readFile(`${file}.lock`, "utf8")).token, "new-owner")
})

test("whole-check cancellation suppresses launch when inventory resolves late", async (t) => {
  const f = await fixture()
  const realpath = fs.realpath.bind(fs)
  let finish, entered
  const ready = new Promise((resolve) => { entered = resolve })
  t.mock.method(fs, "realpath", async (file) => {
    if (file === f.desk) { entered(); await new Promise((resolve) => { finish = resolve }) }
    return realpath(file)
  })
  let launched = false
  // Mocked time: the whole-check budget expires while inventory is held, however long a loaded machine takes to reach it.
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const check = tidy({ host: "claude", env: f.env, budgetMs: 50, launch: async () => { launched = true } })
  await ready
  t.mock.timers.tick(50)
  assert.match(await check, /budget/)
  t.mock.timers.reset()
  finish()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(launched, false)
})
