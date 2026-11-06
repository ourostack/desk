// Finishing a commit Desk could not finish, by hand, without guessing (R2, R3, 0972 on #625). A route never commits whatever is
// on disk now: it carries what the call meant to commit, captured before Desk dispatched it (the index entries at exactly those
// paths, with their modes, so a symlink stays a symlink), the HEAD it was made on and its message. This module reads where
// that change stands and, only when asked and only when every check passes, commits exactly it once.
//
// What it reads, in order, all without changing anything:
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
// entries), reads the branch and HEAD again, and dispatches one plain `git commit` of that private index. Git moves the branch
// itself and runs every hook the repository has (so the card guard still refuses a hand commit of a live task card); nothing
// here moves a ref by hand. The shared index and the working tree are never written: they already hold this change, and
// another session's edit beside it stays exactly where it is. The commit is then read back: exactly this change on the HEAD it
// read is `finished`; anything else that landed is `unknown`, named, and left alone. One dispatch, never repeated.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { indexEntries, readBackCommit } from "./git-stage.js"

const TOOL_COMMIT_ENV = "DESK_TOOL_COMMIT"
const GIT_TIMEOUT_MS = 10_000
const ZERO = "0".repeat(40)

function git(spawnGit, root, args, { env, input } = {}) {
  const answer = spawnGit("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env, input })
  return { ok: !answer.error && answer.status === 0, stdout: String(answer.stdout ?? ""), stderr: String(answer.stderr ?? answer.error?.message ?? "").trim() }
}

function treeLines(spawnGit, root, commit, paths) {
  const tree = git(spawnGit, root, ["ls-tree", "-r", "-z", commit, "--", ...paths])
  if (!tree.ok) return null
  return tree.stdout.split("\0").filter(Boolean).map((record) => {
    const [meta, entryPath] = record.split("\t")
    const [mode, , sha] = meta.split(" ")
    return `${mode} ${sha}\t${entryPath}`
  }).sort()
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const held = (reason, extra = {}) => ({ state: "held", reason, ...extra })

/**
 * Where a captured change stands, and with `commit: true` the one commit that finishes it. `root` is the folder the paths are
 * relative to (any folder inside the checkout), `paths` exactly the paths the call committed, `expected` the captured entries
 * there as sorted `mode sha\tpath` lines (a path with no line is meant to be absent), `before` the HEAD the call read before
 * it dispatched (`""` for unborn), `branch` the branch it committed on. Returns `{ state, reason, ... }`, `state` one of
 * `committed`, `ready`, `finished` (this call made the commit), `held` or `unknown`. Never throws on a Git failure.
 */
export function finishCommit({ root, paths, expected, before, branch, message, commit = false, spawnGit = spawnSync, env = process.env }) {
  if (env[TOOL_COMMIT_ENV]) return held(`${TOOL_COMMIT_ENV} is set; this check runs only without it, so the card guard keeps its say`)
  if (!Array.isArray(paths) || paths.length === 0 || !Array.isArray(expected) || typeof before !== "string" || !branch || !message)
    return held("the route does not carry the captured change (paths, entries, HEAD, branch and message), so nothing can be checked")
  const wanted = [...expected].sort()
  const onBranch = git(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
  if (!onBranch.ok) return held("the checkout is not on a branch now")
  if (onBranch.stdout.trim() !== branch) return held(`the checkout is on ${onBranch.stdout.trim()} now, not ${branch}, where the change was made`)
  const headRead = git(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"])
  const head = headRead.ok ? headRead.stdout.trim() : null
  if (head === null) return { state: "unknown", reason: "Git could not read HEAD" }
  const now = treeLines(spawnGit, root, head, paths)
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
  return commitCaptured({ root, paths, wanted, head, branch, message, spawnGit, env })
}

function commitCaptured({ root, paths, wanted, head, branch, message, spawnGit, env }) {
  const prefixRead = git(spawnGit, root, ["rev-parse", "--show-prefix"])
  if (!prefixRead.ok) return { state: "unknown", reason: "Git could not place these paths in the repository" }
  const prefix = prefixRead.stdout.trim()
  const full = (p) => path.posix.join(prefix, p)
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-finish-"))
  try {
    const { [TOOL_COMMIT_ENV]: _dropped, ...rest } = env
    const own = { ...rest, GIT_INDEX_FILE: path.join(dir, "index") }
    const kept = new Set(wanted.map((line) => line.split("\t")[1]))
    const lines = [
      ...wanted.map((line) => { const [meta, p] = line.split("\t"); return `${meta}\t${full(p)}\0` }),
      ...paths.filter((p) => !kept.has(p)).map((p) => `0 ${ZERO}\t${full(p)}\0`),
    ].join("")
    const seed = git(spawnGit, root, ["read-tree", head === "" ? "--empty" : head], { env: own })
    if (!seed.ok) return held(`nothing was committed: git read-tree failed: ${seed.stderr}`)
    const update = git(spawnGit, root, ["update-index", "-z", "--index-info"], { env: own, input: lines })
    if (!update.ok) return held(`nothing was committed: building the private index failed: ${update.stderr}`)
    // Read again just before the one dispatch: the private index is HEAD plus this change, so it is right only on that HEAD.
    const branchNow = git(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
    const headNow = git(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"])
    if (!branchNow.ok || branchNow.stdout.trim() !== branch || (headNow.ok ? headNow.stdout.trim() : "") !== head)
      return held(`nothing was committed: ${branch} moved after the checks; read back again from the start`)
    // The one dispatch that changes anything: a plain commit, so Git moves the branch and runs every hook the repository has.
    const made = git(spawnGit, root, ["commit", "-q", "-m", message], { env: own })
    const afterRead = git(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"])
    const after = afterRead.ok ? afterRead.stdout.trim() : null
    if (after === null) return { state: "unknown", reason: `Git could not read HEAD after the commit dispatch${made.ok ? "" : ` (${made.stderr})`}; read back before anything else` }
    if (after === head) return made.ok
      ? { state: "unknown", reason: "the commit dispatch reported success but HEAD did not move; read back before anything else" }
      : held(`nothing was committed: Git or one of the repository's hooks refused the commit: ${made.stderr || "no reason given"}`)
    const parentRead = git(spawnGit, root, ["rev-parse", "--verify", "-q", `${after}^`])
    const parent = parentRead.ok ? parentRead.stdout.trim() : ""
    const body = git(spawnGit, root, ["log", "-1", "--format=%B", after])
    const entries = treeLines(spawnGit, root, after, paths)
    const others = git(spawnGit, root, ["diff-tree", "--no-commit-id", "-r", "--name-only", "-z", ...(head === "" ? ["--root", after] : [head, after])])
    const outside = others.ok ? others.stdout.split("\0").filter(Boolean).filter((p) => !paths.map(full).includes(p)) : null
    if (parent === head && body.ok && body.stdout.startsWith(message) && same(entries, wanted) && outside !== null && outside.length === 0)
      return { state: "finished", reason: "committed exactly the captured change", commit: after }
    // HEAD moved, but not to exactly this change on the HEAD it read: another writer was inside the window. Nothing more is done.
    return { state: "unknown", reason: `HEAD moved to ${after.slice(0, 12)}, which is not exactly this change on ${head.slice(0, 12) || "an unborn branch"} (another commit landed while it ran, or a hook changed it); it may undo or include another writer's commit, so only a person can say what is right`, commit: after }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Exit codes the route's steps branch on: done (committed or finished), ready (read-only run, nothing changed), held, unknown, bad usage. */
export const FINISH_EXIT = { done: 0, ready: 3, held: 4, unknown: 5, usage: 2 }

/** `--root R --branch B --before H --message M --path P... --entry "mode sha<TAB>path"... [--commit]`: prints the answer as JSON and returns its exit code. */
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
    else if (flag === "--path") options.paths.push(value)
    else if (flag === "--entry") options.expected.push(value)
    else { out.write(`${JSON.stringify({ state: "usage", reason: `unknown option ${flag}` })}\n`); return FINISH_EXIT.usage }
  }
  if (!options.root) { out.write(`${JSON.stringify({ state: "usage", reason: "--root is required" })}\n`); return FINISH_EXIT.usage }
  const answer = finishCommit({ ...options, spawnGit, env })
  out.write(`${JSON.stringify(answer)}\n`)
  return answer.state === "committed" || answer.state === "finished" ? FINISH_EXIT.done : FINISH_EXIT[answer.state]
}
