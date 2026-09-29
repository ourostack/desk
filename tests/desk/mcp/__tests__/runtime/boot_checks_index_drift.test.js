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

test("a check that stages a file mid-run produces a Desk problem: index-drift block", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray.txt"), "x\n")
  const line = await runBootChecks({
    ...quiet,
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray.txt"); return {} } }],
  })
  assert.match(line, /Desk problem: index-drift — probe/)
  assert.match(line, /stray\.txt/)
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

test("a check that stages several files mid-run names every one of them", async (t) => {
  const { runBootChecks } = require(BOOT)
  const { repo, env, git } = fixture(t)
  writeFileSync(path.join(repo, "stray-a.txt"), "a\n")
  writeFileSync(path.join(repo, "stray-b.txt"), "b\n")
  const line = await runBootChecks({
    ...quiet,
    env,
    checks: [{ id: "probe", budgetMs: 50, run: async () => { git("add", "stray-a.txt", "stray-b.txt"); return {} } }],
  })
  assert.match(line, /Desk problem: index-drift — probe/)
  assert.match(line, /stray-a\.txt/)
  assert.match(line, /stray-b\.txt/)
  assert.match(line, /unexpectedly staged files/)
})

test("the five real boot checks produce zero false-positive drift blocks against a synthetic bound desk", async (t) => {
  const { runBootChecks, checks } = require(BOOT)
  const { env } = fixture(t)
  const line = await runBootChecks({ ...quiet, host: "claude", env, checks, checkBudgets: Object.fromEntries(checks.map((c) => [c.id, 2000])), totalBudgetMs: 10000 })
  assert.doesNotMatch(line, /Desk problem: index-drift/)
})
