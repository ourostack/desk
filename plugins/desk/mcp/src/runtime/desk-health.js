// The `desk-health` boot check and its detached state-branch fast-forward.
//
// `deskHealthCheck({ env, root })` runs inside the session-start hooks, so it
// only reads small local files and never runs Git or the network. It reads the
// bound root's own `last-start/<root key>.json` record in Desk's state
// directory (`last-start.js`; written by every Desk session on each admission
// change) and returns:
//
//   - `{ line }` when that record says Desk was degraded, for example
//     `Desk: degraded (crew checkout on feature-x; writes paused); run
//     desk_doctor`. The line is for the agent: state-branch problems point at
//     desk_doctor's switch_state_branch repair, everything else at the fix
//     desk_status names;
//   - `{ fastForward: true }` when Desk last admitted the root and the root's
//     checkout has a branch checked out: the caller starts
//     `fastForwardStateBranch` detached;
//   - `{}` otherwise (no record, a detached HEAD, not a Git checkout).
//
// `fastForwardStateBranch({ env, root })` runs detached. It never touches a
// branch that is not the state branch (`--state-branch`/`desk.state_branch`
// as the Desk server resolves it, else `main`), that has tracked changes, a Git
// operation or an index lock in progress, no upstream, or commits its upstream
// lacks. It fetches the upstream's remote in the background, checks all of
// that again, and then runs `git merge --ff-only @{u}`. A fast-forward is
// recorded in Desk's `repairs.log`.

import { closeSync, constants, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import * as path from "node:path"

import { appendRepairLog, lastStartPath, resolveDeskStateDir } from "./last-start.js"
import { isStateBranchName, runGit } from "./state-branch.js"
import { resolveStartupStateBranch } from "./startup-resolve.js"

const RECORD_BYTES = 16 * 1024
const HEAD_BYTES = 4096
const CODE = /^[a-z][a-z0-9_]{0,63}$/u
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]
// Launcher codes that keep reads and pause writes (desk-session.js LAUNCHER_READ_ONLY_CODES).
const WRITES_PAUSED = new Set([
  "state_branch_detached", "state_branch_mismatch", "crew_state_unavailable", "crew_state_not_main", "repository_mismatch", "authority_invalid",
  "identity_unavailable", "identity_not_emu", "identity_unregistered", "identity_ambiguous",
])

/** A small regular file's text, never following a symlink; `null` when absent, unsafe or larger than `limit`. */
function readSmall(file, limit) {
  let descriptor
  try {
    const before = lstatSync(file)
    if (!before.isFile() || before.size > limit) return null
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(limit)
    return buffer.toString("utf8", 0, readSync(descriptor, buffer, 0, limit, 0))
  } finally {
    closeSync(descriptor)
  }
}

function readRecord(stateDir, root) {
  const roots = [root]
  try {
    roots.push(realpathSync(root))
  } catch {
    // A root that cannot be resolved has only the record under its own spelling.
  }
  for (const candidate of new Set(roots)) {
    const text = readSmall(lastStartPath({ stateDir, root: candidate }), RECORD_BYTES)
    if (text === null) continue
    try {
      const record = JSON.parse(text)
      if (record !== null && typeof record === "object" && typeof record.state === "string") return record
    } catch {
      // A torn or foreign record says nothing.
    }
  }
  return null
}

/** The branch checked out at `root` read from its HEAD file (following a worktree's `.git` file), or `null`. */
export function checkedOutBranch(root) {
  let gitDir = path.join(root, ".git")
  const pointer = readSmall(gitDir, HEAD_BYTES)
  if (pointer !== null) {
    const match = /^gitdir: (.+)$/mu.exec(pointer)
    if (match === null) return null
    gitDir = path.resolve(root, match[1].trim())
  }
  const head = readSmall(path.join(gitDir, "HEAD"), HEAD_BYTES)
  const branch = head === null ? null : /^ref: refs\/heads\/(.+)$/u.exec(head.trim())?.[1] ?? null
  return branch !== null && isStateBranchName(branch) ? branch : null
}

function degradedLine(code, root) {
  const known = CODE.test(code ?? "") ? code : "unknown"
  const kind = existsSync(path.join(root, "desks")) ? "crew" : "desk"
  if (known === "state_branch_mismatch") {
    const branch = checkedOutBranch(root)
    return `Desk: degraded (${kind} checkout on ${branch ?? "another branch"}; writes paused); run desk_doctor`
  }
  if (known === "state_branch_detached") return `Desk: degraded (${kind} checkout detached; writes paused); run desk_doctor`
  return `Desk: degraded (${known}${WRITES_PAUSED.has(known) ? "; writes paused" : ""}); run desk_status for the fix`
}

/** See the header. */
export function deskHealthCheck({ env = process.env, root }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return {}
  const record = readRecord(resolveDeskStateDir({ env }), root)
  if (record === null) return {}
  if (record.state.startsWith("degraded")) return { line: degradedLine(record.code, root) }
  return checkedOutBranch(root) === null ? {} : { fastForward: true }
}

// ---------------------------------------------------------------------------
// The detached fast-forward.
// ---------------------------------------------------------------------------

async function inspect(git, toplevel, gitDir, branch) {
  const head = await git({ cwd: toplevel, args: ["symbolic-ref", "--quiet", "--short", "HEAD"] })
  if (!head.ok || head.stdout !== branch) return { skip: "not_on_state_branch" }
  const status = await git({ cwd: toplevel, args: ["status", "--porcelain=v1", "--untracked-files=no"] })
  if (!status.ok || status.stdout !== "") return { skip: "tracked_changes" }
  if (OPERATION_MARKERS.some((marker) => existsSync(path.join(gitDir, marker))) || existsSync(path.join(gitDir, "index.lock"))) return { skip: "operation_in_progress" }
  const sha = await git({ cwd: toplevel, args: ["rev-parse", "--verify", "--quiet", "HEAD"] })
  return { sha: sha.stdout }
}

/** See the header. Resolves `{ result: "fast_forwarded" | "up_to_date" | "skipped", reason?, commits? }`; never rejects. */
export async function fastForwardStateBranch({ env = process.env, root, git = runGit, stateBranch = undefined }) {
  try {
    const branch = stateBranch ?? resolveStartupStateBranch({ env }) ?? "main"
    if (!isStateBranchName(branch)) return { result: "skipped", reason: "no_state_branch" }
    const located = await git({ cwd: root, args: ["rev-parse", "--show-toplevel", "--absolute-git-dir"] })
    if (!located.ok) return { result: "skipped", reason: "not_a_checkout" }
    const [toplevel, gitDir] = located.stdout.split(/\r?\n/u)
    if (realpathSync(toplevel) !== realpathSync(root)) return { result: "skipped", reason: "not_a_checkout" }
    const before = await inspect(git, toplevel, gitDir, branch)
    if (before.skip) return { result: "skipped", reason: before.skip }
    const remote = await git({ cwd: toplevel, args: ["config", "--get", `branch.${branch}.remote`] })
    const upstream = await git({ cwd: toplevel, args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"] })
    if (!remote.ok || !upstream.ok || remote.stdout === "" || remote.stdout === ".") return { result: "skipped", reason: "no_upstream" }
    const fetched = await git({ cwd: toplevel, args: ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", remote.stdout], env: { ...env, GIT_TERMINAL_PROMPT: "0" } })
    if (!fetched.ok) return { result: "skipped", reason: "fetch_failed" }
    const after = await inspect(git, toplevel, gitDir, branch)
    if (after.skip) return { result: "skipped", reason: after.skip }
    if (after.sha !== before.sha) return { result: "skipped", reason: "head_moved" }
    const counts = await git({ cwd: toplevel, args: ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"] })
    const [ahead, behind] = counts.stdout.split(/\s+/u).map(Number)
    if (!counts.ok || !Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return { result: "skipped", reason: "no_upstream" }
    if (ahead > 0) return { result: "skipped", reason: "diverged" }
    if (behind === 0) return { result: "up_to_date" }
    const merged = await git({ cwd: toplevel, args: ["merge", "--ff-only", "--quiet", "@{upstream}"] })
    if (!merged.ok) return { result: "skipped", reason: "merge_refused" }
    try {
      appendRepairLog({ stateDir: resolveDeskStateDir({ env }), root, line: `fast-forwarded ${branch} to ${upstream.stdout} (${behind} commit${behind === 1 ? "" : "s"})` })
    } catch {
      // The fast-forward happened; a log that cannot be written changes nothing.
    }
    return { result: "fast_forwarded", commits: behind }
  } catch {
    return { result: "skipped", reason: "unexpected" }
  }
}
