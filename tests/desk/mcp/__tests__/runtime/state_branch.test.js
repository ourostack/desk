// The state-branch check and its safe repair, on temporary Git repositories and a scripted git.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import {
  inspectStateBranch, isStateBranchName, repairStateBranch, runGit, stateBranchProblem, STATE_BRANCH_REPAIR,
} from "../../src/runtime/state-branch.js"
import { git, makeGitDesk, writeFile } from "./_admission_fixtures.js"

test("state branch names follow Git's rules for a plain branch", () => {
  for (const name of ["main", "release/2026", "v2-alpha", "a.b"]) assert.equal(isStateBranchName(name), true, name)
  for (const name of [null, undefined, "", "-x", "a..b", "a//b", "a@{1}", "a.", "a/", "x.lock", "has space", 7]) {
    assert.equal(isStateBranchName(name), false, String(name))
  }
  assert.equal(STATE_BRANCH_REPAIR, "switch_state_branch")
})

test("nothing to protect: no state branch, or a root outside any checkout", async () => {
  const fixture = await makeGitDesk("desk-state-branch-none-")
  assert.deepEqual(await inspectStateBranch({ root: fixture.desk, branch: null }), { checked: false, ok: true, kind: "not_configured", branch: null })
  assert.deepEqual(await inspectStateBranch({ root: fixture.desk }), { checked: false, ok: true, kind: "not_configured", branch: null })
  const plain = path.join(fixture.root, "plain")
  mkdirSync(plain)
  assert.deepEqual(await inspectStateBranch({ root: plain, branch: "main" }), { checked: false, ok: true, kind: "not_a_checkout", branch: "main" })
})

test("on the state branch, and from a subfolder of the checkout", async () => {
  const fixture = await makeGitDesk("desk-state-branch-on-")
  const inspection = await inspectStateBranch({ root: path.join(fixture.desk, "ops"), branch: "main" })
  assert.equal(inspection.ok, true)
  assert.equal(inspection.kind, "on_state_branch")
  assert.equal(inspection.head.branch, "main")
  assert.equal(inspection.toplevel.endsWith("desk"), true)
  assert.deepEqual(await repairStateBranch({ inspection }), { repaired: false, reason: "preconditions_not_met", blockers: [] })
  assert.deepEqual(await repairStateBranch({}), { repaired: false, reason: "preconditions_not_met", blockers: [] })
})

test("every blocker is detected and named with a fix", async () => {
  const fixture = await makeGitDesk("desk-state-branch-blockers-")
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "local.md"), "local\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "local")
  writeFile(path.join(fixture.desk, "_meta", "friction.md"), "edited\n")
  writeFileSync(path.join(fixture.desk, ".git", "MERGE_HEAD"), "x")
  writeFileSync(path.join(fixture.desk, ".git", "index.lock"), "")
  git(fixture.desk, "branch", "-m", "main", "renamed-main")
  const inspection = await inspectStateBranch({ root: fixture.desk, branch: "main" })
  assert.equal(inspection.kind, "detached")
  assert.deepEqual(inspection.blockers, ["state_branch_missing", "tracked_changes", "operation_in_progress", "index_locked", "local_only_commits"])
  assert.equal(inspection.repairable, false)
  assert.equal(inspection.automatic, false)
  const problem = stateBranchProblem(inspection)
  assert.equal(problem.code, "state_branch_detached")
  assert.match(problem.summary, /HEAD in .* is detached at [0-9a-f]{12}, not on the state branch main/u)
  assert.match(problem.fix, /then call desk_doctor with \{"repair":"switch_state_branch"\}/u, "mid-session, every fix ends at the doctor repair")
  // Found by the first admission attempt too: the agent reads it after that attempt, when only the doctor switches.
  assert.equal(stateBranchProblem(inspection, { automatic: true }).fix, problem.fix)
  for (const text of ["branch --track main origin/main", "git -C", "status", "index.lock", "push origin HEAD:refs/heads/<name>"]) {
    assert.ok(problem.fix.includes(text), text)
  }
  assert.deepEqual((await repairStateBranch({ inspection })).reason, "preconditions_not_met")
})

test("a branch with local-only commits gets a push fix, and a failed switch is reported", async () => {
  const fixture = await makeGitDesk("desk-state-branch-other-")
  git(fixture.desk, "switch", "--track", "origin/feature")
  writeFile(path.join(fixture.desk, "ops", "more.md"), "more\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "more")
  const inspection = await inspectStateBranch({ root: fixture.desk, branch: "main" })
  assert.equal(inspection.kind, "other_branch")
  const problem = stateBranchProblem(inspection)
  assert.equal(problem.code, "state_branch_mismatch")
  assert.match(problem.summary, /is on branch feature/u)
  assert.match(problem.fix, /push -u origin feature/u)

  const failed = stateBranchProblem({ ...inspection, blockers: [] }, { failedRepair: { reason: "switch_failed", message: "would overwrite x" } })
  assert.match(failed.fix, /git switch main did not run cleanly \(would overwrite x\)/u)
  assert.match(stateBranchProblem({ ...inspection, blockers: [] }, { automatic: true }).fix, /someone may be using this branch on purpose/u)
  assert.match(stateBranchProblem({ ...inspection, blockers: [] }).fix, /never switches it back on its own mid-session/u)
})

test("a switch that git refuses is not reported as a repair", async () => {
  const fixture = await makeGitDesk("desk-state-branch-refused-")
  git(fixture.desk, "checkout", "--detach", "origin/feature")
  const inspection = await inspectStateBranch({ root: fixture.desk, branch: "main" })
  assert.equal(inspection.automatic, true)
  // An untracked file where main has a tracked one: git switch refuses rather than overwrite it.
  git(fixture.desk, "rm", "--cached", "-q", "ops/harbor-lights/task.md")
  const scripted = ({ args, cwd }) => args[0] === "switch" ? { ok: false, stdout: "", stderr: "would be overwritten" } : runGit({ args, cwd })
  const result = await repairStateBranch({ inspection, git: scripted })
  assert.deepEqual(result, { repaired: false, reason: "switch_failed", message: "would be overwritten", blockers: [] })
  git(fixture.desk, "reset", "-q")
})

test("runGit runs git asynchronously, drops Git location variables and never rejects", async () => {
  let seen
  const execFileImpl = (command, args, options, callback) => {
    seen = { command, args, env: options.env, timeout: options.timeout }
    setImmediate(() => callback(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), null, null))
  }
  const result = await runGit({ cwd: "/somewhere", args: ["status"], execFileImpl, env: { GIT_DIR: "/x", GIT_WORK_TREE: "/y", KEEP: "1" } })
  assert.deepEqual(result, { ok: false, stdout: "", stderr: "spawn git ENOENT" })
  assert.equal(seen.command, "git")
  assert.deepEqual(seen.args, ["-C", "/somewhere", "status"])
  assert.equal(seen.env.GIT_DIR, undefined)
  assert.equal(seen.env.GIT_WORK_TREE, undefined)
  assert.equal(seen.env.KEEP, "1")
  assert.equal(seen.env.GIT_OPTIONAL_LOCKS, "0")
  const quiet = await runGit({ cwd: "/x", args: [], execFileImpl: (c, a, o, callback) => callback(null, " ok \n", "") })
  assert.deepEqual(quiet, { ok: true, stdout: "ok", stderr: "" })
  const failedQuietly = await runGit({ cwd: "/x", args: [], execFileImpl: (c, a, o, callback) => callback(Object.assign(new Error("Command failed"), { code: 2 }), "", " why \n") })
  assert.deepEqual(failedQuietly, { ok: false, stdout: "", stderr: "why" })
  const real = await runGit({ cwd: "/", args: ["--version"] })
  assert.equal(real.ok, true)
  assert.match(real.stdout, /^git version/u)
  assert.equal(typeof (await runGit({ cwd: "/", args: ["--version"], env: undefined })).ok, "boolean")
})

test("a HEAD that moves between the check and the switch aborts the repair", async () => {
  const fixtureState = { sha: "a".repeat(40) }
  const git = ({ args }) => {
    const key = args.join(" ")
    if (key.startsWith("symbolic-ref")) return { ok: false, stdout: "" }
    if (key.startsWith("rev-parse --verify --quiet HEAD")) return { ok: true, stdout: fixtureState.sha }
    assert.fail(`unexpected git ${key}`)
  }
  const inspection = { checked: true, ok: false, repairable: true, kind: "detached", branch: "main", toplevel: "/repo", gitDir: "/repo/.git", head: { branch: null, sha: "b".repeat(40) }, blockers: [] }
  const moved = await repairStateBranch({ inspection, git })
  assert.equal(moved.reason, "head_moved")
  assert.match(stateBranchProblem(inspection, { failedRepair: moved }).fix, /HEAD moved while Desk was checking it/u)
})

test("a switch that leaves commits off every local branch reports them", async () => {
  const git = ({ args }) => {
    const key = args.join(" ")
    if (key.startsWith("symbolic-ref")) return { ok: false, stdout: "" }
    if (key.startsWith("rev-parse --verify --quiet HEAD")) return { ok: true, stdout: "c".repeat(40) }
    if (key === "switch --no-guess main") {
      return { ok: true, stdout: "", stderr: "Warning: you are leaving 2 commits behind, not connected to\nany of your branches:\n\n  1234567 first\n  89abcde second\n\nIf you want to keep them by creating a new branch, this may be a good time" }
    }
    assert.fail(`unexpected git ${key}`)
  }
  const inspection = { checked: true, ok: false, repairable: true, kind: "detached", branch: "main", toplevel: "/repo", gitDir: "/repo/.git", head: { branch: null, sha: "c".repeat(40) }, blockers: [] }
  const repaired = await repairStateBranch({ inspection, git })
  assert.equal(repaired.line, `repaired: detached HEAD → main (was ${"c".repeat(12)}); git noted 2 commit(s) not on a local branch: 1234567, 89abcde`)
})

test("an unborn HEAD with no commits reports an unknown sha", async () => {
  const scripted = ({ args }) => {
    const key = args.join(" ")
    if (key.startsWith("rev-parse --show-toplevel")) return { ok: true, stdout: "/repo\n/repo/.git" }
    if (key.startsWith("symbolic-ref")) return { ok: false, stdout: "" }
    if (key.startsWith("status")) return { ok: false, stdout: "" }
    return { ok: false, stdout: "" }
  }
  const inspection = await inspectStateBranch({ root: "/repo", branch: "main", git: scripted, exists: () => false })
  assert.equal(inspection.head.sha, null)
  assert.match(stateBranchProblem(inspection).summary, /detached at unknown/u)
})
