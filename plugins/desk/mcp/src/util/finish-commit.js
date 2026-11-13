// Finishing a commit Desk could not finish, by hand, without guessing (R2, R3, 0972 on #625). A route never commits whatever is
// on disk now: it carries what the call meant to commit, captured before Desk dispatched it (the index entries at exactly those
// paths, with their modes, so a symlink stays a symlink), the HEAD it was made on and its message. This module reads where
// that change stands and, only when asked and only when every check passes, commits exactly it once.
//
// What it reads, in order, all without changing anything:
//   - no merge, cherry-pick, revert or rebase is in progress (git commit has its own rules for those; a finish never applies them);
//   - the checkout is still on the branch the call committed on (the tool's branch refusal, checked again);
//   - HEAD already holds exactly the captured entries at those paths: `committed`, so there is nothing left but to publish;
//   - HEAD moved: Desk's own read-back. A commit of this call's that landed but is not what HEAD holds now is `held`
//     (it happened, it is not in effect, and only a person can say what is right); anything it cannot attribute is `unknown`;
//     another session's commit to these same paths since is `held`;
//   - the shared index holds exactly the captured entries at those paths. Anything else there (another session's staged
//     selection, or a later edit staged over this one) is `held`: the index is someone's, and nothing here resets it.
// When all of that passes the answer is `ready`.
//
// With `commit: true` and a `ready` answer it builds a private temporary index (the HEAD it read plus exactly the captured
// entries, with every leaf HEAD holds under a captured folder that the capture does not keep removed), checks the whole tree
// it built against the capture, reads the branch and HEAD again, and makes the commit the way git commit does, with every step Git's own: the
// pre-commit, prepare-commit-msg and commit-msg hooks through `git hook run` on that private index (so the card guard still
// refuses a hand commit of a live task card; a hook that changes what would be committed is held), the message cleaned by
// `git stripspace`, the commit object by `git commit-tree` on the qualified HEAD (signed when commit.gpgSign says so). The one
// dispatch that moves anything is `git update-ref` of the branch from exactly the qualified HEAD, a compare-and-swap: a
// branch another writer moved after the read is refused and their commit stands, never undone (git commit itself would take
// whatever HEAD is when it starts as the parent). Then post-commit runs, and HEAD is read again: the commit, the hook's
// outcome and where HEAD is afterwards are reported apart, and only all three as wanted is `finished`. The shared index and the
// working tree are never written. Each hook, commit-tree and the branch update get their own 600 s bound (not one total), since
// a slow hook is what left the commit unfinished; every read keeps 10 s. A hook before the commit cut off at its bound is
// `unknown` with the branch unmoved; a commit-tree that fails is `held`; a branch update cut off is `unknown`, naming the
// commit; a post-commit hook that fails, is cut off or moves HEAD is `unknown`, naming the commit. One dispatch, never repeated.

import { spawnSync } from "node:child_process"

import { indexEntries, readBackCommit } from "./git-stage.js"
import { TOOL_COMMIT_ENV } from "../desk/card-commit-guard.js"
import { commitCaptured, git, headOf, held, operationAnswer, same, treeLines } from "./cas-commit.js"
import { readCaptureRecord, removeCaptureRecord } from "./capture-record.js"
import { resolveDeskStateDir } from "../runtime/last-start.js"

/**
 * Where a captured change stands, and with `commit: true` the one commit that finishes it. `root` is the folder the paths are
 * relative to (any folder inside the checkout), `paths` exactly the paths the call committed, `expected` the captured entries
 * there as sorted `mode sha\tpath` lines (a path with no line is meant to be absent), `before` the HEAD the call read before
 * it dispatched (`""` for unborn), `branch` the branch it committed on. Returns `{ state, reason, ... }`, `state` one of
 * `committed`, `ready`, `finished` (this call made the commit), `held` or `unknown`. Never throws on a Git failure.
 */
export function finishCommit({ root, paths, expected, before, branch, message, commit = false, recorded = false, spawnGit = spawnSync, env = process.env }) {
  if (env[TOOL_COMMIT_ENV]) return held("the card guard's own override is set in this environment; this check runs only without it, so the card guard keeps its say")
  if (!Array.isArray(paths) || paths.length === 0 || !Array.isArray(expected) || typeof before !== "string" || !branch || !message)
    return held("the route does not carry the captured change (paths, entries, HEAD, branch and message), so nothing can be checked")
  const wanted = [...expected].sort()
  const operation = operationAnswer(spawnGit, root)
  if (operation) return operation
  const onBranch = git(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
  if (!onBranch.ok) return held("the checkout is not on a branch now")
  if (onBranch.stdout.trim() !== branch) return held(`the checkout is on ${onBranch.stdout.trim()} now, not ${branch}, where the change was made`)
  const head = headOf(spawnGit, root, branch)
  if (head === null) return { state: "unknown", reason: "Git could not read HEAD" }
  const now = head === "" ? [] : treeLines(spawnGit, root, head, paths)
  if (now === null) return { state: "unknown", reason: "Git could not read HEAD's entries at these paths" }
  if (same(now, wanted)) return { state: "committed", reason: "HEAD holds exactly the captured change at these paths", head }
  if (head !== before) {
    const back = readBackCommit(root, paths, message, before, wanted, spawnGit)
    if (back.landed) return held("the change was committed, but HEAD no longer holds it there; only a person can say what these paths should hold now", { landed: back.landed })
    if (back.readback === "unknown") return { state: "unknown", reason: "HEAD moved and Git cannot say whether this change is among the new commits" }
    const was = before === "" ? [] : treeLines(spawnGit, root, before, paths)
    if (was === null) return { state: "unknown", reason: "Git could not read the earlier HEAD's entries at these paths" }
    if (!same(was, now)) return held("another commit changed these paths after this change was captured")
  }
  const index = indexEntries(root, paths, spawnGit)
  if (index === null) return { state: "unknown", reason: "Git could not read the index at these paths" }
  if (index.some((entry) => entry.stage !== "0")) return held("the index holds a merge conflict at these paths")
  const staged = index.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}`).sort()
  if (!same(staged, wanted)) return held("the shared index holds something other than the captured change at these paths (another session's staged work, or a later edit); it is left exactly as it is")
  if (!commit) return { state: "ready", reason: "the index holds exactly the captured change, HEAD does not yet, and nothing else changed these paths", head }
  // A recorded change (Desk's own record, see capture-record.js) is committed the way Desk's tool commits are: with the card guard's marker, for this commit only.
  return commitCaptured({ root, paths, wanted, head, branch, message, spawnGit, env: recorded ? { ...env, [TOOL_COMMIT_ENV]: "1" } : env, toolCommit: recorded })
}

/** Exit codes the route's steps branch on: done (committed or finished), ready (read-only run, nothing changed), held, unknown, bad usage. */
const FINISH_EXIT = { done: 0, ready: 3, held: 4, unknown: 5, usage: 2 }

/** `--root R --branch B --before H --message M --path P... --entry "mode sha<TAB>path"... [--commit]`, or `--root R --capture-id ID --message M --path P... [--commit]` for Desk's recorded change: prints the answer as JSON and returns its exit code. */
export function runFinishCommitCli(argv = process.argv.slice(2), { spawnGit = spawnSync, env = process.env, out = process.stdout } = {}) {
  const options = { paths: [], expected: [], commit: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === "--commit") { options.commit = true; continue }
    const value = argv[i + 1]
    if (value === undefined) { out.write(`${JSON.stringify({ state: "usage", reason: `${flag} needs a value` })}\n`); return FINISH_EXIT.usage }
    i += 1
    if (flag === "--root") options.root = value
    else if (flag === "--branch") options.branch = value
    else if (flag === "--before") options.before = value
    else if (flag === "--message") options.message = value
    else if (flag === "--capture-id") options.captureId = value
    else if (flag === "--path") options.paths.push(value)
    else if (flag === "--entry") options.expected.push(value)
    else { out.write(`${JSON.stringify({ state: "usage", reason: `unknown option ${flag}` })}\n`); return FINISH_EXIT.usage }
  }
  if (!options.root) { out.write(`${JSON.stringify({ state: "usage", reason: "--root is required" })}\n`); return FINISH_EXIT.usage }
  const answer = options.captureId === undefined ? finishCommit({ ...options, spawnGit, env }) : finishRecorded(options, { spawnGit, env })
  out.write(`${JSON.stringify(answer)}\n`)
  return answer.state === "committed" || answer.state === "finished" ? FINISH_EXIT.done : FINISH_EXIT[answer.state]
}

/**
 * A finish that names Desk's record by its id: the record supplies the change, and the command line must name the same checkout,
 * paths and message as the record, or the finish is held. The record is removed once its commit is proven landed.
 */
function finishRecorded(options, { spawnGit, env }) {
  const stateDir = resolveDeskStateDir({ env })
  const loaded = readCaptureRecord({ stateDir, id: options.captureId })
  if (loaded.error) return held(loaded.error)
  const { record } = loaded
  if (record.root !== options.root) return held("Desk's record of this change is for another checkout, so it is not finished from here")
  if (JSON.stringify([...record.paths].sort()) !== JSON.stringify([...options.paths].sort())) return held("the paths named are not the paths Desk recorded for this change")
  if (record.message !== options.message) return held("the message named is not the one Desk recorded for this change")
  const answer = finishCommit({ root: record.root, paths: record.paths, expected: record.expected, before: record.before, branch: record.branch, message: record.message, commit: options.commit, recorded: true, spawnGit, env })
  if (answer.state === "committed" || answer.state === "finished") removeCaptureRecord({ stateDir, id: record.id })
  return answer
}
