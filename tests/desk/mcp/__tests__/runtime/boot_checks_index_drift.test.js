// Index tracing on the boot-check registry (spec.md §3): none of the real
// checks is designed to touch the Git index, so a check that stages a path
// mid-run is a genuine anomaly, caught the moment it happens rather than
// surfacing later as an opaque pull failure. Every desk and process here is a
// throwaway fixture; nothing reaches the real HOME or the network.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const BOOT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/boot-checks.cjs", import.meta.url))
const quiet = { launchRepair: async () => {}, launch: async () => {}, record: async () => {} }

function fixture(t) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-boot-drift-")))
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5 }))
  const env = {
    ...process.env, HOME: repo, DESK: repo, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid",
  }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS|GLOBAL))/u.test(key)) delete env[key]
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env })
  writeFileSync(path.join(repo, "committed.md"), "base\n")
  execFileSync("git", ["-C", repo, "add", "committed.md"], { env })
  execFileSync("git", ["-C", repo, "commit", "-qm", "first"], { env })
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env })
  return { repo, env, git }
}

test("a check that stages a file mid-run produces a Desk problem: index-drift block, without accusing the check of it", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray.txt"), "x\n")
  const line = await runBootChecks({
    ...quiet,
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray.txt"); return {} } }],
  })
  assert.match(line, /Desk problem: index-drift — unexpected file staged during probe/)
  assert.match(line, /stray\.txt/)
  assert.match(line, /it may have staged it, or another session may have staged it at the same time/)
  assert.doesNotMatch(line, /staged a file it should never touch/)
  assert.doesNotMatch(line, /unexpectedly staged/)
})

// ── index-drift is migrated onto real filing too (spec.md §1, Part 5) ──────

test("an index-drift block queues the detached filer, never awaiting it, and reports filing in background", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { repo, env, git } = fixture(t)
  const launched = []
  writeFileSync(path.join(repo, "stray.txt"), "x\n")
  const line = await runBootChecks({
    ...quiet,
    host: "claude",
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray.txt"); return {} } }],
    launchRepair: async (command, launchEnv) => { launched.push({ command, launchEnv }) },
  })
  assert.match(line, /Desk problem: index-drift — unexpected file staged during probe/)
  assert.match(line, /file: filing in background/)
  assert.equal(launched.length, 1)
  assert.ok(launched[0].command.some((part) => part.endsWith("file-desk-problem.js")))
  assert.ok(launched[0].command.includes("--mechanism"))
  assert.ok(launched[0].command.includes("index-drift"))
  assert.ok(launched[0].command.includes("--host"))
  assert.ok(launched[0].command.includes("claude"))
})

test("an index-drift block still renders, with 'not filed', when the launcher itself fails to start", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray.txt"), "x\n")
  const line = await runBootChecks({
    ...quiet,
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray.txt"); return {} } }],
    launchRepair: async () => { throw new Error("spawn unavailable") },
  })
  assert.match(line, /Desk problem: index-drift — unexpected file staged during probe/)
  assert.match(line, /file: filing in background/)
})

test("a check with no index change adds no index-drift block, and the usual line still comes through", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { env } = fixture(t)
  const line = await runBootChecks({ ...quiet, env, checks: [{ id: "quiet-check", budgetMs: 50, run: async () => ({ line: "fine" }) }] })
  assert.equal(line, "Desk boot: fine")
  assert.doesNotMatch(line, /Desk problem/)
})

test("with no bound desk, index tracing never runs and never touches Git", async () => {
  const { runBootChecks } = require(BOOT)
  const line = await runBootChecks({
    ...quiet,
    env: { HOME: "/nonexistent-desk-drift-home" },
    checks: [{ id: "probe", budgetMs: 50, run: async () => ({}) }],
  })
  assert.equal(line, "")
})

test("a bound desk that resolves but is not itself a Git repository is never watched for drift", async (t) => {
  const { runBootChecks } = require(BOOT)
  const notGit = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-boot-drift-not-git-")))
  t.after(() => rmSync(notGit, { recursive: true, force: true, maxRetries: 5 }))
  const line = await runBootChecks({
    ...quiet,
    env: { HOME: notGit, DESK: notGit },
    checks: [{ id: "probe", budgetMs: 50, run: async () => ({}) }],
  })
  assert.equal(line, "")
})

test("a check that stages several files mid-run names every one of them, in the plural", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray-a.txt"), "a\n")
  writeFileSync(path.join(repo, "stray-b.txt"), "b\n")
  const line = await runBootChecks({
    ...quiet,
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray-a.txt", "stray-b.txt"); return {} } }],
  })
  assert.match(line, /Desk problem: index-drift — unexpected files staged during probe/)
  assert.match(line, /stray-a\.txt/)
  assert.match(line, /stray-b\.txt/)
  assert.match(line, /Files appeared in the index while "probe" ran/)
})

test("the five real boot checks produce zero false-positive drift blocks against a synthetic bound desk", async (t) => {
  const { runBootChecks, checks } = require(BOOT)
  const { env } = fixture(t)
  const line = await runBootChecks({ ...quiet, host: "claude", env, checks, checkBudgets: Object.fromEntries(checks.map((c) => [c.id, 2000])), totalBudgetMs: 10000 })
  assert.doesNotMatch(line, /Desk problem: index-drift/)
})

// ── A snapshot's own cost never eats the check's budget (fix round 2) ──────
//
// Independent review reproduced: with the before/after snapshot inside the
// check's own elapsed measurement, a check with no index change lost its
// line to a false "over budget" 2/3 local runs — the snapshot's own git call
// cost was being charged against the check's tiny budget (as little as
// 20 ms). Both below prove it is excluded: one with a synthetic timed-out
// git call (what a real hang eventually resolves to), one with a real,
// deliberately slow git call bounded well under the check's own budget.

test("a git call that reports a timeout mid-snapshot never drops the check's line, and adds no drift block", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { env } = fixture(t)
  const timedOutSpawnGit = (command, args) => (args.includes("rev-parse")
    ? { status: 0, stdout: "true\n", stderr: "" }
    : { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) })
  const line = await runBootChecks({
    ...quiet,
    env,
    spawnGit: timedOutSpawnGit,
    checks: [{ id: "quiet-check", budgetMs: 20, run: async () => ({ line: "fine" }) }],
  })
  assert.equal(line, "Desk boot: fine")
})

test("a before-snapshot that fails skips the after-snapshot entirely — it never turns its own failure into a false-positive drift", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { env } = fixture(t)
  let diffCalls = 0
  const spawnGit = (command, args) => {
    if (args.includes("rev-parse")) return { status: 0, stdout: "true\n", stderr: "" }
    diffCalls += 1
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) }
  }
  const line = await runBootChecks({ ...quiet, env, spawnGit, checks: [{ id: "probe", budgetMs: 50, run: async () => ({ line: "fine" }) }] })
  assert.equal(diffCalls, 1, "only the before-snapshot is attempted; the after-snapshot is skipped")
  assert.equal(line, "Desk boot: fine")
  assert.doesNotMatch(line, /Desk problem/)
})

test("a snapshot slower than the check's own tiny budget never drops the check's line — its cost is never charged to it", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { env } = fixture(t)
  // Every snapshot call (before and after) actually takes real wall-clock
  // time, well past the check's own 20 ms budget, then reports "nothing
  // staged" — proving the check's own elapsed measurement excludes it.
  const slowSpawnGit = (command, args) => {
    if (args.includes("rev-parse")) return { status: 0, stdout: "true\n", stderr: "" }
    execFileSync("bash", ["-c", "sleep 0.15"])
    return { status: 0, stdout: "", stderr: "" }
  }
  const line = await runBootChecks({
    ...quiet,
    env,
    spawnGit: slowSpawnGit,
    checks: [{ id: "quiet-check", budgetMs: 20, run: async () => ({ line: "fine" }) }],
  })
  assert.equal(line, "Desk boot: fine")
})
