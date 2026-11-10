// Index tracing on the boot-check registry (spec.md §3): none of the real
// checks is designed to touch the Git index, so a check that stages a path
// mid-run is a genuine anomaly, caught the moment it happens rather than
// surfacing later as an opaque pull failure. Every desk and process here is a
// throwaway fixture; nothing reaches the real HOME or the network.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { checks, runBootChecks } from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"
import { removeTree } from "../_remove_tree.js"
const quiet = { launchRepair: async () => {}, launch: async () => {}, record: async () => {} }

function fixture(t) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-boot-drift-")))
  t.after(() => removeTree(repo))
  const env = {
    // XDG_STATE_HOME is set explicitly, not just inherited from `...process.env`: the
    // filing-storm throttle (fix round, spec.md §1 Part 5) keys its stamp file off this
    // directory, and the isolated test run pins XDG_STATE_HOME process-wide -- leaving it
    // inherited here would make every fixture share one throttle stamp regardless of this
    // repo's own unique HOME, colliding across tests that hit the same reason text.
    ...process.env, HOME: repo, XDG_STATE_HOME: path.join(repo, ".local", "state"), DESK: repo, GIT_CONFIG_NOSYSTEM: "1",
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

// Real staging data with neither wall-clock race: the snapshot's own spawn timeout (the registry's remaining budget)
// can kill a slow Windows `git diff --cached`, and the registry's 300 ms budget can skip the after-snapshot.
function untimedGit(t, env) {
  t.mock.method(performance, "now", () => 0)
  return (command, args) => ({ status: 0, stdout: execFileSync(command, args, { env, encoding: "utf8" }), stderr: "" })
}

test("a check that stages a file mid-run produces a Desk problem: index-drift block, without accusing the check of it", async (t) => {
  t.mock.method(performance, "now", () => 0)
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray.txt"), "x\n")
  const snapshots = []
  const line = await runBootChecks({
    ...quiet,
    env,
    // Real staging data, without a second wall-clock race; snapshot timeout behavior is tested separately.
    spawnGit: (command, args) => {
      assert.equal(args[1], repo)
      const stdout = execFileSync(command, args, { env, encoding: "utf8" })
      snapshots.push(stdout)
      return { status: 0, stdout, stderr: "" }
    },
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray.txt"); return {} } }],
  })
  assert.deepEqual(snapshots, ["", "stray.txt\n"], "both snapshots must observe the fixture's real staging transition")
  assert.match(line, /Desk problem: index-drift — unexpected file staged during probe/)
  assert.match(line, /stray\.txt/)
  assert.match(line, /it may have staged it, or another session may have staged it at the same time/)
  assert.doesNotMatch(line, /staged a file it should never touch/)
  assert.doesNotMatch(line, /unexpectedly staged/)
})

// ── index-drift is migrated onto real filing too (spec.md §1, Part 5) ──────

test("an index-drift block queues the detached filer, never awaiting it, and reports filing in background", async (t) => {
  const { repo, env, git } = fixture(t)
  const launched = []
  writeFileSync(path.join(repo, "stray.txt"), "x\n")
  const line = await runBootChecks({
    ...quiet,
    spawnGit: untimedGit(t, env),
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
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray.txt"), "x\n")
  const line = await runBootChecks({
    ...quiet,
    spawnGit: untimedGit(t, env),
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray.txt"); return {} } }],
    launchRepair: async () => { throw new Error("spawn unavailable") },
  })
  assert.match(line, /Desk problem: index-drift — unexpected file staged during probe/)
  assert.match(line, /file: filing in background/)
})

test("a check with no index change adds no index-drift block, and the usual line still comes through", async (t) => {
  const { env } = fixture(t)
  const line = await runBootChecks({ ...quiet, env, spawnGit: untimedGit(t, env), checks: [{ id: "quiet-check", budgetMs: 50, run: async () => ({ line: "fine" }) }] })
  assert.equal(line, "Desk boot pre-checks: fine")
  assert.doesNotMatch(line, /Desk problem/)
})

test("with no bound desk, index tracing never runs and never touches Git", async () => {
  const line = await runBootChecks({
    ...quiet,
    env: { HOME: "/nonexistent-desk-drift-home" },
    checks: [{ id: "probe", budgetMs: 50, run: async () => ({}) }],
  })
  assert.equal(line, "")
})

test("a bound desk that resolves but is not itself a Git repository is never watched for drift", async (t) => {
  const notGit = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-boot-drift-not-git-")))
  t.after(() => removeTree(notGit))
  const line = await runBootChecks({
    ...quiet,
    env: { HOME: notGit, DESK: notGit },
    checks: [{ id: "probe", budgetMs: 50, run: async () => ({}) }],
  })
  assert.equal(line, "")
})

test("a check that stages several files mid-run names every one of them, in the plural", async (t) => {
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray-a.txt"), "a\n")
  writeFileSync(path.join(repo, "stray-b.txt"), "b\n")
  const line = await runBootChecks({
    ...quiet,
    spawnGit: untimedGit(t, env),
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray-a.txt", "stray-b.txt"); return {} } }],
  })
  assert.match(line, /Desk problem: index-drift — unexpected files staged during probe/)
  assert.match(line, /stray-a\.txt/)
  assert.match(line, /stray-b\.txt/)
  assert.match(line, /Files appeared in the index while "probe" ran/)
})

test("the five real boot checks produce zero false-positive drift blocks against a synthetic bound desk", async (t) => {
  const { env } = fixture(t)
  const line = await runBootChecks({ ...quiet, host: "claude", env, checks, checkBudgets: Object.fromEntries(checks.map((c) => [c.id, 2000])), totalBudgetMs: 10000 })
  assert.doesNotMatch(line, /Desk problem: index-drift/)
})

// Snapshots share the whole-start deadline, but not a check's own work allowance.

test("a git call that reports a timeout mid-snapshot never drops the check's line, and adds no drift block", async (t) => {
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
  assert.equal(line, "Desk boot pre-checks: fine")
})

test("a before-snapshot that fails skips the after-snapshot entirely — it never turns its own failure into a false-positive drift", async (t) => {
  const { env } = fixture(t)
  let diffCalls = 0
  const spawnGit = (command, args) => {
    if (args.includes("rev-parse")) return { status: 0, stdout: "true\n", stderr: "" }
    diffCalls += 1
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) }
  }
  const line = await runBootChecks({ ...quiet, env, spawnGit, checks: [{ id: "probe", budgetMs: 50, run: async () => ({ line: "fine" }) }] })
  assert.equal(diffCalls, 1, "only the before-snapshot is attempted; the after-snapshot is skipped")
  assert.equal(line, "Desk boot pre-checks: fine")
  assert.doesNotMatch(line, /Desk problem/)
})

test("snapshots longer than a check allowance preserve its line when they fit the whole-start deadline", async (t) => {
  const { env } = fixture(t)
  let now = 0
  t.mock.method(performance, "now", () => now)
  const slowSpawnGit = (command, args) => {
    if (args.includes("rev-parse")) return { status: 0, stdout: "true\n", stderr: "" }
    now += 100
    return { status: 0, stdout: "", stderr: "" }
  }
  const line = await runBootChecks({
    ...quiet,
    env,
    spawnGit: slowSpawnGit,
    checks: [{ id: "quiet-check", budgetMs: 20, run: async () => ({ line: "fine" }) }],
  })
  assert.equal(line, "Desk boot pre-checks: fine")
  assert.equal(now, 200)
})
