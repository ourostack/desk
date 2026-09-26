// The state branch: the one branch a desk checkout must be on for Desk to write.
//
// A host passes `--state-branch <name>` (or `desk.state_branch` in its activation config). Desk then checks the checkout that holds the desk root at every admission and before every write. When HEAD is elsewhere, Desk switches back only when that is provably safe, and otherwise serves reads and refuses writes with a fix the agent can act on in the session.
//
// Safe means all of these hold (the always-on investigation, §3(b), and Ari's ruling 1 of 2026-09-25):
// - no tracked change (`git status --porcelain=v1 --untracked-files=no` is empty);
// - no Git operation in progress (merge, cherry-pick, revert, bisect, rebase) and no index.lock;
// - no local-only commits: `git branch -r --contains HEAD` is non-empty, or the branch equals its upstream;
// - `refs/heads/<state branch>` exists.
// The repair is `git switch --no-guess <state branch>`, which keeps untracked files and refuses rather than overwrite one; HEAD is read again right before it, and a HEAD that moved since the check aborts it. Desk never fetches or resets.
//
// When the switch happens (fix round 1 ruling): automatically only during the session's first admission attempt, whatever that attempt ends in (fix round 3 ruling), and then only for a detached HEAD or a branch equal to its upstream. Mid-session, a HEAD that leaves the state branch makes writes read-only and is never switched back automatically; the agent asks for the switch with desk_doctor's switch_state_branch repair, which runs the same preconditions.
//
// Git runs asynchronously, never blocking the thread that answers the host.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

export const STATE_BRANCH_REPAIR = "switch_state_branch"
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<![./])$/u
const LEFT_BEHIND = /leaving (\d+) commits? behind[\s\S]*?\n\n((?:\s+[0-9a-f]{7,40} .*\n?)+)/u

// Git reads its location from these variables before `-C`; a host hook can leave them set, so they are dropped.
const GIT_LOCATION_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]

export function isStateBranchName(value) {
  return typeof value === "string" && BRANCH_NAME.test(value) && !value.endsWith(".lock")
}

/** Run one git command in `cwd` without blocking. Never rejects: a missing git or a failed command is `{ ok: false }`. */
export function runGit({ cwd, args, execFileImpl = execFile, env = process.env }) {
  const childEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  for (const name of GIT_LOCATION_VARIABLES) delete childEnv[name]
  return new Promise((resolve) => {
    execFileImpl("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: childEnv,
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? "").trim(),
        stderr: String(stderr ?? "").trim() || (error ? error.message : ""),
      })
    })
  })
}

/**
 * Where HEAD is relative to the state branch, and whether switching back is safe.
 * `ok` is true when there is nothing to protect: no state branch configured, a root outside any Git checkout, or HEAD already on the state branch.
 */
export async function inspectStateBranch({ root, branch, git = runGit, exists = existsSync }) {
  if (!isStateBranchName(branch)) {
    return { checked: false, ok: true, kind: "not_configured", branch: branch ?? null }
  }
  const located = await git({ cwd: root, args: ["rev-parse", "--show-toplevel", "--absolute-git-dir"] })
  if (!located.ok) {
    return { checked: false, ok: true, kind: "not_a_checkout", branch }
  }
  const [toplevel, gitDir] = located.stdout.split(/\r?\n/u)
  const { detached, headBranch, sha } = await readHead(git, toplevel)
  const base = { checked: true, branch, toplevel, gitDir, head: { branch: headBranch, sha } }
  if (headBranch === branch) {
    return { ...base, ok: true, kind: "on_state_branch", blockers: [], repairable: false, automatic: false }
  }
  const blockers = []
  if (!(await git({ cwd: toplevel, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`] })).ok) blockers.push("state_branch_missing")
  const status = await git({ cwd: toplevel, args: ["status", "--porcelain=v1", "--untracked-files=no"] })
  if (!status.ok || status.stdout.length > 0) blockers.push("tracked_changes")
  if (OPERATION_MARKERS.some((marker) => exists(path.join(gitDir, marker)))) blockers.push("operation_in_progress")
  if (exists(path.join(gitDir, "index.lock"))) blockers.push("index_locked")
  const upstream = detached ? null : await git({ cwd: toplevel, args: ["rev-parse", "--verify", "--quiet", "@{upstream}"] })
  const equalsUpstream = upstream?.ok === true && sha !== null && upstream.stdout === sha
  const onRemote = equalsUpstream || (await git({ cwd: toplevel, args: ["branch", "-r", "--contains", "HEAD"] })).stdout.length > 0
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

async function readHead(git, toplevel) {
  const symbolic = await git({ cwd: toplevel, args: ["symbolic-ref", "--quiet", "--short", "HEAD"] })
  const sha = (await git({ cwd: toplevel, args: ["rev-parse", "--verify", "--quiet", "HEAD"] })).stdout || null
  return { detached: !symbolic.ok, headBranch: symbolic.ok ? symbolic.stdout : null, sha }
}

/** Switch back to the state branch when `inspection` says it is safe. Returns the one-line report, or why it did not switch. */
export async function repairStateBranch({ inspection, git = runGit }) {
  if (!inspection?.checked || inspection.ok || !inspection.repairable) {
    return { repaired: false, reason: "preconditions_not_met", blockers: inspection?.blockers ?? [] }
  }
  // The checks above took several git calls; a commit or checkout in between would make them stale.
  const now = await readHead(git, inspection.toplevel)
  if (now.headBranch !== inspection.head.branch || now.sha !== inspection.head.sha) {
    return { repaired: false, reason: "head_moved", message: "HEAD moved while Desk was checking it", blockers: inspection.blockers }
  }
  const switched = await git({ cwd: inspection.toplevel, args: ["switch", "--no-guess", inspection.branch] })
  if (!switched.ok) {
    return { repaired: false, reason: "switch_failed", message: switched.stderr, blockers: inspection.blockers }
  }
  const was = shortSha(inspection.head.sha)
  const from = inspection.kind === "detached" ? "detached HEAD" : `branch ${inspection.head.branch}`
  const leftBehind = LEFT_BEHIND.exec(switched.stderr)
  const note = leftBehind
    ? `; git noted ${leftBehind[1]} commit(s) not on a local branch: ${leftBehind[2].trim().split(/\s*\n\s*/u).map((entry) => entry.split(" ")[0]).join(", ")}`
    : ""
  return { repaired: true, line: `repaired: ${from} → ${inspection.branch} (was ${was})${note}`, was: inspection.head.sha }
}

/**
 * The degraded state for an inspection that is not ok, with a fix the agent can act on in the session.
 * `automatic` says the problem was found by the first admission attempt, the only one that switches on its own. The agent reads the fix after that attempt, so every fix ends with desk_doctor's switch_state_branch repair: once the blockers are gone, Desk never switches back by itself.
 */
export function stateBranchProblem(inspection, { failedRepair = null, automatic = false } = {}) {
  const code = inspection.kind === "detached" ? "state_branch_detached" : "state_branch_mismatch"
  const where = inspection.toplevel
  const here = inspection.kind === "detached"
    ? `HEAD in ${where} is detached at ${shortSha(inspection.head.sha)}`
    : `${where} is on branch ${inspection.head.branch}`
  const doctor = `call desk_doctor with {"repair":"${STATE_BRANCH_REPAIR}"} to switch back to ${inspection.branch}`
  const then = `then ${doctor}`
  const steps = inspection.blockers.map((blocker) => blockerFix(blocker, inspection, then))
  if (failedRepair?.reason === "switch_failed" || failedRepair?.reason === "head_moved") {
    steps.push(`git switch ${inspection.branch} did not run cleanly (${failedRepair.message}); resolve what it names, then ${doctor}.`)
  }
  if (steps.length === 0) {
    steps.push(automatic
      ? `Its preconditions for a safe switch hold, but someone may be using this branch on purpose: ${doctor}.`
      : `HEAD left the state branch during this session, and Desk never switches it back on its own mid-session. If the move was not deliberate, ${doctor}; its preconditions for a safe switch hold.`)
  }
  return {
    code,
    summary: `${here}, not on the state branch ${inspection.branch}. Desk serves reads; writes wait until the checkout is back on ${inspection.branch}.`,
    fix: steps.join(" "),
    blockers: inspection.blockers,
  }
}

function blockerFix(blocker, inspection, then) {
  const where = JSON.stringify(inspection.toplevel)
  const branch = inspection.branch
  const fixes = {
    state_branch_missing: `The local branch ${branch} does not exist; create it from the remote (git -C ${where} branch --track ${branch} origin/${branch}), ${then}.`,
    tracked_changes: `Tracked files have changes (git -C ${where} status); commit them on a pushed branch or move them elsewhere, ${then}.`,
    operation_in_progress: `A Git operation is in progress (git -C ${where} status names it); finish or abort it, ${then}.`,
    index_locked: `Another Git process holds ${path.join(inspection.gitDir, "index.lock")}; wait for it to finish (remove the lock only if no Git process is running), ${then}.`,
    local_only_commits: inspection.kind === "detached"
      ? `HEAD has commits that are on no remote branch; keep them on a pushed branch (git -C ${where} push origin HEAD:refs/heads/<name>), ${then}.`
      : `Branch ${inspection.head.branch} has commits that are on no remote branch; push them (git -C ${where} push -u origin ${inspection.head.branch}), ${then}.`,
  }
  return fixes[blocker]
}

function shortSha(sha) {
  return typeof sha === "string" ? sha.slice(0, 12) : "unknown"
}
