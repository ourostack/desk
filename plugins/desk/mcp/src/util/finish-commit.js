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
// entries), reads the branch and HEAD again, and makes the commit the way git commit does, with every step Git's own: the
// pre-commit, prepare-commit-msg and commit-msg hooks through `git hook run` on that private index (so the card guard still
// refuses a hand commit of a live task card; a hook that changes what would be committed is held), the message cleaned by
// `git stripspace`, the commit object by `git commit-tree` on the qualified HEAD (signed when commit.gpgSign says so). The one
// dispatch that moves anything is `git update-ref` of the branch from exactly the qualified HEAD, a compare-and-swap: a
// branch another writer moved after the read is refused and their commit stands, never undone (git commit itself would take
// whatever HEAD is when it starts as the parent). Then post-commit runs. The shared index and the working tree are never
// written. The hooks, commit-tree and the branch update get a 600 s bound, since a slow hook is what left the commit
// unfinished; every read keeps 10 s. A hook or branch update cut off at that bound is `unknown`. One dispatch, never repeated.

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { indexEntries, readBackCommit } from "./git-stage.js"
import { TOOL_COMMIT_ENV } from "../desk/card-commit-guard.js"

const GIT_TIMEOUT_MS = 10_000
// The finish runs from a shell, not inside a tool call, and a slow hook is what left the commit unfinished: the one commit
// dispatch gets room for it. A dispatch cut off still ends in the read-back below, never in a second dispatch.
const COMMIT_TIMEOUT_MS = 600_000
const ZERO = "0".repeat(40)

function git(spawnGit, root, args, { env, input, timeout = GIT_TIMEOUT_MS } = {}) {
  const answer = spawnGit("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout, env, input })
  return { ok: !answer.error && answer.status === 0, cut: Boolean(answer.error || answer.signal), stdout: String(answer.stdout ?? ""), stderr: String(answer.stderr ?? answer.error?.message ?? "").trim() }
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

// What git commit refuses to commit partially, or commits with more than one parent (0972 #4 on ae1395e4). The finish makes a
// one-parent commit of a few paths, so while any of these is in progress it holds and moves nothing.
const OPERATIONS = [["MERGE_HEAD", "a merge"], ["CHERRY_PICK_HEAD", "a cherry-pick"], ["REVERT_HEAD", "a revert"], ["sequencer", "a cherry-pick or revert sequence"], ["rebase-merge", "a rebase"], ["rebase-apply", "a rebase or git am"]]

/** The Git operation in progress in this checkout, `null` for none, or a held/unknown answer when it holds or cannot be read. */
function operationAnswer(spawnGit, root) {
  const where = git(spawnGit, root, ["rev-parse", "--path-format=absolute", ...OPERATIONS.flatMap(([name]) => ["--git-path", name])])
  const files = where.stdout.split("\n").filter(Boolean)
  if (!where.ok || files.length !== OPERATIONS.length) return { state: "unknown", reason: "Git could not say whether a merge, cherry-pick, revert or rebase is in progress" }
  const found = OPERATIONS.find((_, i) => existsSync(files[i]))
  return found ? held(`${found[1]} is in progress in this checkout; git commit has its own rules for it, so Desk does not finish the change by hand and nothing was committed`) : null
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
  if (env[TOOL_COMMIT_ENV]) return held("the card guard's own override is set in this environment; this check runs only without it, so the card guard keeps its say")
  if (!Array.isArray(paths) || paths.length === 0 || !Array.isArray(expected) || typeof before !== "string" || !branch || !message)
    return held("the route does not carry the captured change (paths, entries, HEAD, branch and message), so nothing can be checked")
  const wanted = [...expected].sort()
  const operation = operationAnswer(spawnGit, root)
  if (operation) return operation
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
    // A captured path can be a folder (a save or a move names folders): every leaf HEAD holds under it that the capture does
    // not keep is removed, so a deleted or renamed file does not survive from HEAD (0972 #1 on ae1395e4).
    const headLeaves = head === "" ? [] : treeLines(spawnGit, root, head, paths)
    if (headLeaves === null) return { state: "unknown", reason: "Git could not read HEAD's entries at these paths" }
    const gone = [...new Set([...paths, ...headLeaves.map((line) => line.split("\t")[1])])].filter((p) => !kept.has(p))
    const lines = [
      ...wanted.map((line) => { const [meta, p] = line.split("\t"); return `${meta}\t${full(p)}\0` }),
      ...gone.map((p) => `0 ${ZERO}\t${full(p)}\0`),
    ].join("")
    const seed = git(spawnGit, root, ["read-tree", head === "" ? "--empty" : head], { env: own })
    if (!seed.ok) return held(`nothing was committed: git read-tree failed: ${seed.stderr}`)
    const update = git(spawnGit, root, ["update-index", "-z", "--index-info"], { env: own, input: lines })
    if (!update.ok) return held(`nothing was committed: building the private index failed: ${update.stderr}`)
    // Read again before running anything: the private index is HEAD plus this change, so it is right only on that HEAD.
    const branchNow = git(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
    const headNow = git(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"])
    if (!branchNow.ok || branchNow.stdout.trim() !== branch || (headNow.ok ? headNow.stdout.trim() : "") !== head)
      return held(`nothing was committed: ${branch} moved after the checks; read back again from the start`)
    const tree = git(spawnGit, root, ["write-tree"], { env: own })
    if (!tree.ok) return held(`nothing was committed: git write-tree failed: ${tree.stderr}`)
    // The whole tree built is checked against the capture before anything runs: exactly the captured entries at these paths,
    // and HEAD's own entries everywhere else.
    const built = builtAgainst({ spawnGit, root, head, tree: tree.stdout.trim(), paths, wanted, scope: paths.map(full) })
    if (built !== null) return held(`nothing was committed: the tree built for the commit does not match the captured change (${built})`)
    // The hooks git commit runs, run by Git itself on the private index, in git commit's order and with its arguments.
    const hookEnv = { ...own, GIT_EDITOR: ":" }
    const hook = (name, ...args) => git(spawnGit, root, ["hook", "run", "--ignore-missing", name, ...(args.length > 0 ? ["--", ...args] : [])], { env: hookEnv, timeout: COMMIT_TIMEOUT_MS })
    const stopped = (name, answer) => answer.cut
      ? { state: "unknown", reason: `the ${name} hook was cut off at the ${COMMIT_TIMEOUT_MS / 1000} s bound and may still be running; the branch was not moved, but read back before anything else` }
      : held(`nothing was committed: the repository's ${name} hook refused the commit: ${answer.stderr || "no reason given"}`)
    const pre = hook("pre-commit")
    if (!pre.ok) return stopped("pre-commit", pre)
    const treeAfter = git(spawnGit, root, ["write-tree"], { env: own })
    if (!treeAfter.ok || treeAfter.stdout.trim() !== tree.stdout.trim())
      return held("nothing was committed: the pre-commit hook changed what would be committed; Desk commits only the captured change")
    const messageFile = path.join(dir, "COMMIT_EDITMSG")
    writeFileSync(messageFile, `${message}\n`)
    const prepare = hook("prepare-commit-msg", messageFile, "message")
    if (!prepare.ok) return stopped("prepare-commit-msg", prepare)
    const msg = hook("commit-msg", messageFile)
    if (!msg.ok) return stopped("commit-msg", msg)
    const cleaned = git(spawnGit, root, ["stripspace"], { input: readFileSync(messageFile, "utf8") })
    if (!cleaned.ok || cleaned.stdout.trim() === "") return held("nothing was committed: the commit message is empty after the hooks ran")
    writeFileSync(messageFile, cleaned.stdout)
    const sign = git(spawnGit, root, ["config", "--type=bool", "--get", "commit.gpgSign"]).stdout.trim() === "true"
    const made = git(spawnGit, root, ["commit-tree", tree.stdout.trim(), ...(head === "" ? [] : ["-p", head]), "-F", messageFile, ...(sign ? ["-S"] : [])], { timeout: COMMIT_TIMEOUT_MS })
    if (!made.ok) return held(`nothing was committed: git commit-tree failed: ${made.stderr || "no reason given"}`)
    const commitId = made.stdout.trim()
    const branchLast = git(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
    if (!branchLast.ok || branchLast.stdout.trim() !== branch) return held(`nothing was committed: the checkout left ${branch} while the hooks ran`)
    const operationLast = operationAnswer(spawnGit, root)
    if (operationLast) return operationLast
    // The one dispatch that moves anything: a compare-and-swap of the branch from exactly the HEAD that was qualified. If any
    // other writer moved it since, Git refuses and nothing is overwritten; it is never repeated.
    const subject = cleaned.stdout.split("\n")[0]
    const ref = `refs/heads/${branch}`
    const moved = git(spawnGit, root, ["update-ref", "-m", `commit${head === "" ? " (initial)" : ""}: ${subject}`, ref, commitId, head === "" ? ZERO : head], { timeout: COMMIT_TIMEOUT_MS })
    const nowRead = git(spawnGit, root, ["rev-parse", "--verify", "-q", ref])
    const now = nowRead.ok ? nowRead.stdout.trim() : null
    if (now === commitId) {
      hook("post-commit")
      return { state: "finished", reason: "committed exactly the captured change", commit: commitId }
    }
    if (moved.ok || moved.cut || now === null)
      return { state: "unknown", reason: `the branch update ${moved.cut ? `was cut off at the ${COMMIT_TIMEOUT_MS / 1000} s bound` : moved.ok ? "reported success" : "failed"} and ${ref} does not hold ${commitId.slice(0, 12)}; read back before anything else`, commit: commitId }
    return held(`nothing was committed: ${branch} moved after it was qualified, so the compare-and-swap refused to overwrite it (${moved.stderr || "no reason given"}); the other writer's commit stands`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const inScope = (scope, name) => scope.some((p) => p === "." || name === p || name.startsWith(`${p}/`))

/** null when `tree` holds exactly `wanted` at `paths` and HEAD's entries everywhere else; otherwise what differs. */
function builtAgainst({ spawnGit, root, head, tree, paths, wanted, scope }) {
  const atPaths = treeLines(spawnGit, root, tree, paths)
  if (atPaths === null) return "Git could not read it"
  if (!same(atPaths, wanted)) return "at the captured paths"
  const changed = head === ""
    ? git(spawnGit, root, ["ls-tree", "-r", "-z", "--full-tree", "--name-only", tree])
    : git(spawnGit, root, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", head, tree])
  if (!changed.ok) return "Git could not compare it with HEAD"
  const outside = changed.stdout.split("\0").filter(Boolean).filter((name) => !inScope(scope, name))
  return outside.length === 0 ? null : `outside the captured paths: ${outside.join(", ")}`
}

/** Exit codes the route's steps branch on: done (committed or finished), ready (read-only run, nothing changed), held, unknown, bad usage. */
const FINISH_EXIT = { done: 0, ready: 3, held: 4, unknown: 5, usage: 2 }

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
