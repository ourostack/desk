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
  assert.deepEqual(inspectStateBranch({ root: fixture.desk, branch: null }), { checked: false, ok: true, kind: "not_configured", branch: null })
  assert.deepEqual(inspectStateBranch({ root: fixture.desk }), { checked: false, ok: true, kind: "not_configured", branch: null })
  const plain = path.join(fixture.root, "plain")
  mkdirSync(plain)
  assert.deepEqual(inspectStateBranch({ root: plain, branch: "main" }), { checked: false, ok: true, kind: "not_a_checkout", branch: "main" })
})

test("on the state branch, and from a subfolder of the checkout", async () => {
  const fixture = await makeGitDesk("desk-state-branch-on-")
  const inspection = inspectStateBranch({ root: path.join(fixture.desk, "ops"), branch: "main" })
  assert.equal(inspection.ok, true)
  assert.equal(inspection.kind, "on_state_branch")
  assert.equal(inspection.head.branch, "main")
  assert.equal(inspection.toplevel.endsWith("desk"), true)
  assert.deepEqual(repairStateBranch({ inspection }), { repaired: false, reason: "preconditions_not_met", blockers: [] })
  assert.deepEqual(repairStateBranch({}), { repaired: false, reason: "preconditions_not_met", blockers: [] })
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
  const inspection = inspectStateBranch({ root: fixture.desk, branch: "main" })
  assert.equal(inspection.kind, "detached")
  assert.deepEqual(inspection.blockers, ["state_branch_missing", "tracked_changes", "operation_in_progress", "index_locked", "local_only_commits"])
  assert.equal(inspection.repairable, false)
  assert.equal(inspection.automatic, false)
  const problem = stateBranchProblem(inspection)
  assert.equal(problem.code, "state_branch_detached")
  assert.match(problem.summary, /HEAD in .* is detached at [0-9a-f]{12}, not on the state branch main/u)
  for (const text of ["branch --track main origin/main", "git -C", "status", "index.lock", "push origin HEAD:refs/heads/<name>"]) {
    assert.ok(problem.fix.includes(text), text)
  }
  assert.deepEqual(repairStateBranch({ inspection }).reason, "preconditions_not_met")
})

test("a branch with local-only commits gets a push fix, and a failed switch is reported", async () => {
  const fixture = await makeGitDesk("desk-state-branch-other-")
  git(fixture.desk, "switch", "--track", "origin/feature")
  writeFile(path.join(fixture.desk, "ops", "more.md"), "more\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "more")
  const inspection = inspectStateBranch({ root: fixture.desk, branch: "main" })
  assert.equal(inspection.kind, "other_branch")
  const problem = stateBranchProblem(inspection)
  assert.equal(problem.code, "state_branch_mismatch")
  assert.match(problem.summary, /is on branch feature/u)
  assert.match(problem.fix, /push -u origin feature/u)

  const failed = stateBranchProblem({ ...inspection, blockers: [] }, { failedRepair: { reason: "switch_failed", message: "would overwrite x" } })
  assert.match(failed.fix, /git switch main failed \(would overwrite x\)/u)
  assert.doesNotMatch(failed.fix, /desk_doctor/u)
})

test("a switch that git refuses is not reported as a repair", async () => {
  const fixture = await makeGitDesk("desk-state-branch-refused-")
  git(fixture.desk, "checkout", "--detach", "origin/feature")
  const inspection = inspectStateBranch({ root: fixture.desk, branch: "main" })
  assert.equal(inspection.automatic, true)
  // An untracked file where main has a tracked one: git switch refuses rather than overwrite it.
  git(fixture.desk, "rm", "--cached", "-q", "ops/harbor-lights/task.md")
  const scripted = ({ args, cwd }) => args[0] === "switch" ? { ok: false, stdout: "", stderr: "would be overwritten" } : runGit({ args, cwd })
  const result = repairStateBranch({ inspection, git: scripted })
  assert.deepEqual(result, { repaired: false, reason: "switch_failed", message: "would be overwritten", blockers: [] })
  git(fixture.desk, "reset", "-q")
})

test("runGit drops Git location variables and never throws", () => {
  let seen
  const spawn = (command, args, options) => {
    seen = { command, args, env: options.env }
    return { status: 1, stdout: null, stderr: null, error: new Error("spawn git ENOENT") }
  }
  const result = runGit({ cwd: "/somewhere", args: ["status"], spawn, env: { GIT_DIR: "/x", GIT_WORK_TREE: "/y", KEEP: "1" } })
  assert.deepEqual(result, { ok: false, stdout: "", stderr: "spawn git ENOENT" })
  assert.equal(seen.command, "git")
  assert.deepEqual(seen.args, ["-C", "/somewhere", "status"])
  assert.equal(seen.env.GIT_DIR, undefined)
  assert.equal(seen.env.GIT_WORK_TREE, undefined)
  assert.equal(seen.env.KEEP, "1")
  assert.equal(seen.env.GIT_OPTIONAL_LOCKS, "0")
  const quiet = runGit({ cwd: "/x", args: [], spawn: () => ({ status: 0, stdout: " ok \n", stderr: "" }) })
  assert.deepEqual(quiet, { ok: true, stdout: "ok", stderr: "" })
  const noError = runGit({ cwd: "/x", args: [], spawn: () => ({ status: 2, stdout: "", stderr: "" }) })
  assert.deepEqual(noError, { ok: false, stdout: "", stderr: "" })
})

test("an unborn HEAD with no commits reports an unknown sha", () => {
  const scripted = ({ args }) => {
    const key = args.join(" ")
    if (key.startsWith("rev-parse --show-toplevel")) return { ok: true, stdout: "/repo\n/repo/.git" }
    if (key.startsWith("symbolic-ref")) return { ok: false, stdout: "" }
    if (key.startsWith("status")) return { ok: false, stdout: "" }
    return { ok: false, stdout: "" }
  }
  const inspection = inspectStateBranch({ root: "/repo", branch: "main", git: scripted, exists: () => false })
  assert.equal(inspection.head.sha, null)
  assert.match(stateBranchProblem(inspection).summary, /detached at unknown/u)
})
