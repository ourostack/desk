// The commit core Desk's hand finish uses (moved here unchanged from finish-commit.js): it publishes exactly a captured change
// on exactly the HEAD that was qualified, through a private index, Git's own hooks, `git commit-tree` and one compare-and-swap
// `git update-ref` of the branch. What it does and why is described at the top of finish-commit.js; it stays the one place
// that knows how, so every caller that needs a commit published only against a qualified parent shares it.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { TOOL_COMMIT_ENV } from "../desk/card-commit-guard.js"

const GIT_TIMEOUT_MS = 10_000
// The finish runs from a shell, not inside a tool call, and a slow hook is what left the commit unfinished: the one commit
// dispatch gets room for it. A dispatch cut off still ends in the read-back below, never in a second dispatch.
const COMMIT_TIMEOUT_MS = 600_000
const ZERO = "0".repeat(40)

function git(spawnGit, root, args, { env, input, timeout = GIT_TIMEOUT_MS } = {}) {
  const answer = spawnGit("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout, env, input })
  return { ok: !answer.error && answer.status === 0, status: answer.status, cut: Boolean(answer.error || answer.signal), notRun: answer === NOT_RUN, stdout: String(answer.stdout ?? ""), stderr: String(answer.stderr ?? answer.error?.message ?? "").trim() }
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

/**
 * HEAD's hash; `""` only on positive proof that `branch` is unborn (HEAD does not resolve, with no error, and Git lists no such
 * branch); null for anything else, which callers answer `unknown` (0972 #5 on ae1395e4).
 */
function headOf(spawnGit, root, branch) {
  const read = git(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"])
  if (read.ok) return read.stdout.trim()
  if (read.cut || !/^1$/u.test(String(read.status)) || read.stdout.trim() !== "") return null
  const listed = git(spawnGit, root, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])
  return listed.ok && listed.stdout.trim() === "" ? "" : null
}

// A cut-off-shaped answer for a step the time budget left no room for: it was never run, so nothing it does can have happened.
const NOT_RUN = { status: null, signal: null, stdout: "", stderr: "the time budget was spent before this step, so it was not run", error: { code: "ETIMEDOUT" } }

/**
 * `spawnGit` held to one total time budget ending at `deadline` (a `Date.now()` time): each call gets what is left, or no more
 * than it asked for, and a call with nothing left is not run. `deadline` null means no budget: `spawnGit` itself.
 */
function budgeted(spawnGit, deadline) {
  if (deadline === null) return spawnGit
  return (command, args, options) => {
    const left = deadline - Date.now()
    return left <= 0 ? NOT_RUN : spawnGit(command, args, { ...options, timeout: Math.min(options.timeout, left) })
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const held = (reason, extra = {}) => ({ state: "held", reason, ...extra })

/**
 * The one commit of exactly `wanted` at `paths` on exactly `head` of `branch`. Two options a caller other than the hand finish
 * needs, both off by default so the hand finish is unchanged: `toolCommit` keeps Desk's own commit marker in what Git and the
 * hooks see (a Desk tool's commit, which the card guard lets through), and `deadline` holds every Git call it makes, the reads
 * after the branch update included, to one total time budget ending then (see `budgeted`), in place of each step's own bound.
 */
function commitCaptured({ root, paths, wanted, head, branch, message, spawnGit: unbudgeted, env, toolCommit = false, deadline = null }) {
  const spawnGit = budgeted(unbudgeted, deadline)
  const bound = deadline === null ? `the ${COMMIT_TIMEOUT_MS / 1000} s bound` : "the end of the commit's time budget"
  const prefixRead = git(spawnGit, root, ["rev-parse", "--show-prefix"])
  if (!prefixRead.ok) return { state: "unknown", reason: "Git could not place these paths in the repository" }
  const prefix = prefixRead.stdout.trim()
  const full = (p) => path.posix.join(prefix, p)
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-finish-"))
  try {
    const { [TOOL_COMMIT_ENV]: _dropped, ...rest } = env
    const own = { ...(toolCommit ? env : rest), GIT_INDEX_FILE: path.join(dir, "index") }
    const refEnv = toolCommit ? env : undefined
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
    if (!branchNow.ok || branchNow.stdout.trim() !== branch || headOf(spawnGit, root, branch) !== head)
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
      ? { state: "unknown", reason: `the ${name} hook was cut off at ${bound} and may still be running; the branch was not moved, but read back before anything else` }
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
    const made = git(spawnGit, root, ["commit-tree", tree.stdout.trim(), ...(head === "" ? [] : ["-p", head]), "-F", messageFile, ...(sign ? ["-S"] : [])], { env: refEnv, timeout: COMMIT_TIMEOUT_MS })
    if (!made.ok) return held(`nothing was committed: git commit-tree failed: ${made.stderr || "no reason given"}`)
    const commitId = made.stdout.trim()
    if (deadline !== null && Date.now() >= deadline) return held("nothing was committed: the commit's time budget ran out before the branch was moved")
    const branchLast = git(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
    if (!branchLast.ok || branchLast.stdout.trim() !== branch) return held(`nothing was committed: the checkout left ${branch} while the hooks ran`)
    const operationLast = operationAnswer(spawnGit, root)
    if (operationLast) return operationLast
    // The one dispatch that moves anything: a compare-and-swap of the branch from exactly the HEAD that was qualified. If any
    // other writer moved it since, Git refuses and nothing is overwritten; it is never repeated.
    const subject = cleaned.stdout.split("\n")[0]
    const ref = `refs/heads/${branch}`
    const moved = git(spawnGit, root, ["update-ref", "-m", `commit${head === "" ? " (initial)" : ""}: ${subject}`, ref, commitId, head === "" ? ZERO : head], { env: refEnv, timeout: COMMIT_TIMEOUT_MS })
    // Read back inside the same budget (the hand finish has none): whatever the branch update did, what the branch holds now is
    // the answer, and a read the budget left no room for leaves it unknown.
    const nowRead = git(spawnGit, root, ["rev-parse", "--verify", "-q", ref])
    const now = nowRead.ok ? nowRead.stdout.trim() : null
    if (now === commitId) {
      const post = hook("post-commit")
      if (post.notRun) return { state: "unknown", reason: `the branch holds the commit, but the commit's time budget ran out before the post-commit hook could run, so it was not run; read back before anything else and never commit it again`, commit: commitId }
      return afterPostCommit({ spawnGit, root, branch, commitId, post, bound })
    }
    if (moved.ok || moved.cut || now === null)
      return { state: "unknown", reason: `the branch update ${moved.cut ? `was cut off at ${bound}` : moved.ok ? "reported success" : "failed"} and ${ref} ${nowRead.notRun ? "could not be read back inside the commit's time budget, so the post-commit hook was not run" : `does not hold ${commitId.slice(0, 12)}`}; read back before anything else`, commit: commitId }
    return held(`nothing was committed: ${branch} moved after it was qualified, so the compare-and-swap refused to overwrite it (${moved.stderr || "no reason given"}); the other writer's commit stands`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// post-commit runs after the branch moved, so the commit, the hook's outcome and where HEAD is afterwards are three facts, read
// apart (0972 #3 on ae1395e4). Only all three as wanted is `finished`; anything else is `unknown`, naming the commit, and is
// never replayed: the commit stands, and only a read-back says what is in effect.
function afterPostCommit({ spawnGit, root, branch, commitId, post, bound }) {
  const post_commit = post.ok ? "ran" : post.cut ? `cut off at ${bound} and may still be running` : `failed: ${post.stderr || "no reason given"}`
  const branchAfter = git(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
  const headAfter = git(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"])
  const at = headAfter.ok ? headAfter.stdout.trim() : null
  const facts = { commit: commitId, post_commit, head: at }
  if (!branchAfter.ok || branchAfter.stdout.trim() !== branch || at !== commitId)
    return { state: "unknown", reason: `the commit was made, but after the post-commit hook ${at === null ? "Git could not read HEAD" : `HEAD is ${at.slice(0, 12)} on ${branchAfter.ok ? branchAfter.stdout.trim() : "no branch"}, not the commit on ${branch}`}; read back before anything else and never commit it again`, ...facts }
  if (!post.ok) return { state: "unknown", reason: `the commit was made and HEAD holds it, but the post-commit hook ${post_commit}; read back before anything else and never commit it again`, ...facts }
  return { state: "finished", reason: "committed exactly the captured change", ...facts }
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

export { git, treeLines, operationAnswer, headOf, same, held, commitCaptured, budgeted }
