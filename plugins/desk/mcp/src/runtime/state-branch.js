// The state branch: the one branch a desk checkout must be on for Desk to write.
//
// A host passes `--state-branch <name>` (or `desk.state_branch` in its activation config). Desk then checks the checkout that holds the desk root at every admission and before every write. When HEAD is elsewhere, Desk switches back only when that is provably safe, and otherwise serves reads and refuses writes with a fix the agent can act on in the session.
//
// Safe means all of these hold (the always-on investigation, §3(b), and Ari's ruling 1 of 2026-09-25):
// - no tracked change (`git status --porcelain=v1 --untracked-files=no` is empty);
// - no Git operation in progress (merge, cherry-pick, revert, bisect, rebase) and no index.lock;
// - no local-only commits: `git branch -r --contains HEAD` is non-empty, or the branch equals its upstream;
// - `refs/heads/<state branch>` exists.
// The repair is `git switch <state branch>`, which keeps untracked files and refuses rather than overwrite one. Desk never fetches or resets.
//
// Automatic repair covers a detached HEAD and a branch that equals its upstream. A branch with no upstream (or one that differs from it) whose commits are all on a remote branch is still safe, but someone may be using it deliberately, so the agent asks for it through desk_doctor's switch_state_branch repair.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

export const STATE_BRANCH_REPAIR = "switch_state_branch"
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<![./])$/u

// Git reads its location from these variables before `-C`; a host hook can leave them set, so they are dropped.
const GIT_LOCATION_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]

export function isStateBranchName(value) {
  return typeof value === "string" && BRANCH_NAME.test(value) && !value.endsWith(".lock")
}

/** Run one git command in `cwd`. Never throws: a missing git or a failed command is `{ ok: false }`. */
export function runGit({ cwd, args, spawn = spawnSync, env = process.env }) {
  const childEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  for (const name of GIT_LOCATION_VARIABLES) delete childEnv[name]
  const result = spawn("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    windowsHide: true,
  })
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim() || (result.error?.message ?? ""),
  }
}

/**
 * Where HEAD is relative to the state branch, and whether switching back is safe.
 * `ok` is true when there is nothing to protect: no state branch configured, a root outside any Git checkout, or HEAD already on the state branch.
 */
export function inspectStateBranch({ root, branch, git = runGit, exists = existsSync }) {
  if (!isStateBranchName(branch)) {
    return { checked: false, ok: true, kind: "not_configured", branch: branch ?? null }
  }
  const located = git({ cwd: root, args: ["rev-parse", "--show-toplevel", "--absolute-git-dir"] })
  if (!located.ok) {
    return { checked: false, ok: true, kind: "not_a_checkout", branch }
  }
  const [toplevel, gitDir] = located.stdout.split(/\r?\n/u)
  const symbolic = git({ cwd: toplevel, args: ["symbolic-ref", "--quiet", "--short", "HEAD"] })
  const sha = git({ cwd: toplevel, args: ["rev-parse", "--verify", "--quiet", "HEAD"] }).stdout || null
  const base = { checked: true, branch, toplevel, gitDir, head: { branch: symbolic.ok ? symbolic.stdout : null, sha } }
  if (symbolic.ok && symbolic.stdout === branch) {
    return { ...base, ok: true, kind: "on_state_branch", blockers: [], repairable: false, automatic: false }
  }
  const detached = !symbolic.ok
  const blockers = []
  if (!git({ cwd: toplevel, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`] }).ok) blockers.push("state_branch_missing")
  const status = git({ cwd: toplevel, args: ["status", "--porcelain=v1", "--untracked-files=no"] })
  if (!status.ok || status.stdout.length > 0) blockers.push("tracked_changes")
  if (OPERATION_MARKERS.some((marker) => exists(path.join(gitDir, marker)))) blockers.push("operation_in_progress")
  if (exists(path.join(gitDir, "index.lock"))) blockers.push("index_locked")
  const upstream = detached ? null : git({ cwd: toplevel, args: ["rev-parse", "--verify", "--quiet", "@{upstream}"] })
  const equalsUpstream = upstream?.ok === true && sha !== null && upstream.stdout === sha
  const onRemote = equalsUpstream || git({ cwd: toplevel, args: ["branch", "-r", "--contains", "HEAD"] }).stdout.length > 0
  if (!onRemote) blockers.push("local_only_commits")
  const repairable = blockers.length === 0
  return {
    ...base,
    ok: false,
    kind: detached ? "detached" : "other_branch",
    blockers,
    repairable,
    automatic: repairable && (detached || equalsUpstream),
  }
}

/** Switch back to the state branch when `inspection` says it is safe. Returns the one-line report, or why it did not switch. */
export function repairStateBranch({ inspection, git = runGit }) {
  if (!inspection?.checked || inspection.ok || !inspection.repairable) {
    return { repaired: false, reason: "preconditions_not_met", blockers: inspection?.blockers ?? [] }
  }
  const switched = git({ cwd: inspection.toplevel, args: ["switch", inspection.branch] })
  if (!switched.ok) {
    return { repaired: false, reason: "switch_failed", message: switched.stderr, blockers: inspection.blockers }
  }
  const was = shortSha(inspection.head.sha)
  const from = inspection.kind === "detached" ? "detached HEAD" : `branch ${inspection.head.branch}`
  return { repaired: true, line: `repaired: ${from} → ${inspection.branch} (was ${was})`, was: inspection.head.sha }
}

/** The degraded state for an inspection that is not ok, with a fix the agent can act on in the session. */
export function stateBranchProblem(inspection, { failedRepair = null } = {}) {
  const code = inspection.kind === "detached" ? "state_branch_detached" : "state_branch_mismatch"
  const where = inspection.toplevel
  const here = inspection.kind === "detached"
    ? `HEAD in ${where} is detached at ${shortSha(inspection.head.sha)}`
    : `${where} is on branch ${inspection.head.branch}`
  const steps = inspection.blockers.map((blocker) => blockerFix(blocker, inspection))
  if (failedRepair?.reason === "switch_failed") {
    steps.push(`git switch ${inspection.branch} failed (${failedRepair.message}); resolve what it names, then call desk_status.`)
  }
  if (steps.length === 0) {
    steps.push(`Its preconditions for a safe switch hold, but someone may be using this branch on purpose: call desk_doctor with {"repair":"${STATE_BRANCH_REPAIR}"} to switch back to ${inspection.branch}.`)
  }
  return {
    code,
    summary: `${here}, not on the state branch ${inspection.branch}. Desk serves reads; writes wait until the checkout is back on ${inspection.branch}.`,
    fix: steps.join(" "),
    blockers: inspection.blockers,
  }
}

function blockerFix(blocker, inspection) {
  const where = JSON.stringify(inspection.toplevel)
  const branch = inspection.branch
  const fixes = {
    state_branch_missing: `The local branch ${branch} does not exist; create it from the remote (git -C ${where} branch --track ${branch} origin/${branch}), then call desk_status.`,
    tracked_changes: `Tracked files have changes (git -C ${where} status); commit them on a pushed branch or move them elsewhere, then call desk_status.`,
    operation_in_progress: `A Git operation is in progress (git -C ${where} status names it); finish or abort it, then call desk_status.`,
    index_locked: `Another Git process holds ${path.join(inspection.gitDir, "index.lock")}; wait for it to finish (remove the lock only if no Git process is running), then call desk_status.`,
    local_only_commits: inspection.kind === "detached"
      ? `HEAD has commits that are on no remote branch; keep them on a pushed branch (git -C ${where} push origin HEAD:refs/heads/<name>), then call desk_status and Desk switches back to ${branch}.`
      : `Branch ${inspection.head.branch} has commits that are on no remote branch; push them (git -C ${where} push -u origin ${inspection.head.branch}), then call desk_status and Desk switches back to ${branch}.`,
  }
  return fixes[blocker]
}

function shortSha(sha) {
  return typeof sha === "string" ? sha.slice(0, 12) : "unknown"
}
