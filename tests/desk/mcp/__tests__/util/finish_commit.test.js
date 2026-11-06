// R2, R3 (0972 on #625): a route finishes exactly the change Desk captured before it dispatched, never whatever the paths hold
// later. finish-commit reads where that change stands and commits it once, building the commit from a private index and moving the branch only by a compare-and-swap against the HEAD it qualified, only when every check passes; anything it cannot qualify is held or unknown and changes nothing.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { finishCommit, runFinishCommitCli } from "../../../../../plugins/desk/mcp/src/util/finish-commit.js"
import { commitIndexPaths, commitPaths, indexEntries } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { commitFailure, commitFailureWords, commitRoute, heldFileRouteFor } from "../../../../../plugins/desk/mcp/src/util/route-around.js"
import { installCardGuard, TOOL_COMMIT_ENV } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"

const env = (() => { const { [TOOL_COMMIT_ENV]: _drop, ...rest } = process.env; return rest })()

function git(root, args, options = {}) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env, ...options })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout
}

function repo() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "finish-commit-")))
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "t"])
  git(root, ["config", "user.email", "t@example.com"])
  writeFileSync(path.join(root, "base.md"), "base\n")
  git(root, ["add", "base.md"])
  git(root, ["commit", "-q", "-m", "base"])
  return root
}

const head = (root) => git(root, ["rev-parse", "HEAD"]).trim()
const snapshot = (root, paths) => ({ head: head(root), index: git(root, ["ls-files", "-s", "--", ...paths]), cached: git(root, ["diff", "--cached", "--", ...paths]), worktree: git(root, ["diff", "--", ...paths]) })

// A commit dispatch Git refuses before it lands: what a pre-commit hook that runs out of time leaves.
const refused = (cmd, args, opts) => (args.includes("commit") && !args.includes("rev-parse") ? { status: 1, stdout: "", stderr: "hook said no" } : spawnSync(cmd, args, opts))

// The commit runs for real, then the call reports a timeout and every later read of HEAD fails: Desk cannot classify it.
function landedUnreadable() {
  let landed = false
  return (cmd, args, opts) => {
    if (args.includes("commit") && !args.includes("rev-parse")) {
      const real = spawnSync(cmd, args, opts)
      landed = true
      return { ...real, status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) }
    }
    if (landed && args.includes("rev-parse")) return { status: 128, stdout: "", stderr: "fatal: cannot lock ref" }
    return spawnSync(cmd, args, opts)
  }
}

function capturedFailure(root, paths, message, spawnGit = refused) {
  git(root, ["add", "--", ...paths])
  const committed = commitPaths(root, paths, message, spawnGit)
  assert.equal(committed.ok, false)
  assert.ok(committed.capture, "the failure carries the captured change")
  return committed
}

const finish = (root, paths, message, committed, extra = {}) => finishCommit({ root, paths, message, ...committed.capture, env, ...extra })

test("a captured change that did not land is ready, then committed exactly once, leaving another session's staged and unstaged work as it was", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  writeFileSync(path.join(root, "other.md"), "theirs staged\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  git(root, ["add", "other.md"])
  writeFileSync(path.join(root, "base.md"), "theirs unstaged\n")
  const before = head(root)
  assert.equal(finish(root, ["notes.md"], "save notes", committed).state, "ready")
  assert.equal(head(root), before, "the read changed nothing")
  const done = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(done.state, "finished", done.reason)
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).trim(), before, "exactly one commit, on the HEAD it read")
  assert.equal(git(root, ["diff", "--name-only", "HEAD~1", "HEAD"]), "notes.md\n")
  assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "save notes")
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "other.md\n", "another session's staged entry is still staged")
  assert.equal(git(root, ["diff", "--name-only"]), "base.md\n", "another session's unstaged edit is still unstaged")
  assert.equal(finish(root, ["notes.md"], "save notes", committed).state, "committed", "read back again, it is in")
  assert.equal(finish(root, ["notes.md"], "save notes", committed, { commit: true }).state, "committed", "never committed twice")
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).trim(), before)
})

// R2: a clean status is no proof. The change was unstaged and its file removed: status is clean, HEAD does not hold the change.
test("a clean but absent effect is held, never committed, and changes nothing", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  git(root, ["rm", "-q", "--cached", "notes.md"])
  git(root, ["clean", "-q", "-f", "--", "notes.md"])
  assert.equal(git(root, ["status", "--porcelain"]), "", "status is clean")
  const before = snapshot(root, ["notes.md"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(answer.state, "held", answer.reason)
  assert.deepEqual(snapshot(root, ["notes.md"]), before)
})

// R2: wrong content that is clean and matches the upstream (another session committed other bytes to the path) is held.
test("another commit's bytes at the captured paths are unknown, never reported as this change", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  writeFileSync(path.join(root, "notes.md"), "theirs\n")
  git(root, ["add", "notes.md"])
  git(root, ["commit", "-q", "-m", "theirs"])
  assert.equal(git(root, ["status", "--porcelain"]), "")
  const before = snapshot(root, ["notes.md"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(answer.state, "unknown", answer.reason)
  assert.deepEqual(snapshot(root, ["notes.md"]), before)
})

// R2: after an UNKNOWN dispatch that landed, later dirt at the path may be another session's edit. It is never committed.
test("dirt that appears after an unknown dispatch that landed is never committed: the change is already in", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes", landedUnreadable())
  assert.equal(committed.readback, "unknown")
  writeFileSync(path.join(root, "notes.md"), "mine\nand someone else's line\n")
  git(root, ["add", "notes.md"])
  writeFileSync(path.join(root, "notes.md"), "mine\nand someone else's line\nand more\n")
  const before = snapshot(root, ["notes.md"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(answer.state, "committed", answer.reason)
  assert.deepEqual(snapshot(root, ["notes.md"]), before, "nothing was committed or reset")
  assert.equal(git(root, ["show", "HEAD:notes.md"]), "mine\n")
})

// R2 with a dispatch that did not land: a later edit staged over the captured one is held, never committed as this change.
test("a later edit staged over a captured change that did not land is held", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  writeFileSync(path.join(root, "notes.md"), "mine\nand someone else's line\n")
  git(root, ["add", "notes.md"])
  const before = snapshot(root, ["notes.md"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(answer.state, "held", answer.reason)
  assert.deepEqual(snapshot(root, ["notes.md"]), before)
})

// R4 carried into the route: it happened, but HEAD no longer holds it. Not completion, and nothing is replayed.
test("a captured change that landed but a later commit overwrote is held with both commits named, and nothing is replayed", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes", landedUnreadable())
  const ours = head(root)
  writeFileSync(path.join(root, "notes.md"), "theirs\n")
  git(root, ["commit", "-q", "-m", "theirs", "--", "notes.md"])
  const before = snapshot(root, ["notes.md"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(answer.state, "held", answer.reason)
  assert.deepEqual(answer.landed, { commit: ours, head: head(root) })
  assert.deepEqual(snapshot(root, ["notes.md"]), before)
})

// The design rule (0972 and the drain on #625): no shared-index reset and no blind ref write. The commit is built from a private
// index, the repository's hooks run through Git itself in git commit's order, and the branch moves by one compare-and-swap
// against the HEAD that was qualified, so a moved branch is refused, never overwritten.
test("the finish builds the commit from a private index, runs every hook through Git, and moves the branch by one compare-and-swap", () => {
  const root = repo()
  const hooks = path.join(root, ".git", "hooks")
  writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\ntest -n \"$GIT_INDEX_FILE\" && git ls-files -s > \"$(git rev-parse --git-dir)/pre-commit-saw\"\n", { mode: 0o755 })
  writeFileSync(path.join(hooks, "prepare-commit-msg"), "#!/bin/sh\ntest \"$2\" = message && printf '\\nPrepared-By: hook\\n' >> \"$1\"\n", { mode: 0o755 })
  writeFileSync(path.join(hooks, "commit-msg"), "#!/bin/sh\ngrep -q 'Prepared-By: hook' \"$1\" && printf 'Checked-By: hook\\n' >> \"$1\"\n", { mode: 0o755 })
  writeFileSync(path.join(hooks, "post-commit"), "#!/bin/sh\ngit rev-parse HEAD > \"$(git rev-parse --git-dir)/post-commit-saw\"\n", { mode: 0o755 })
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const qualified = head(root)
  const calls = []
  const spy = (cmd, args, opts) => { calls.push({ args, index: opts?.env?.GIT_INDEX_FILE ?? null }); return spawnSync(cmd, args, opts) }
  const done = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: spy })
  assert.equal(done.state, "finished", done.reason)
  const verbs = calls.map(({ args }) => args[2])
  for (const banned of ["commit", "reset", "checkout", "add", "restore", "stash"]) assert.equal(verbs.includes(banned), false, `never ${banned}: ${verbs.join(" ")}`)
  const refs = calls.filter(({ args }) => args[2] === "update-ref")
  assert.equal(refs.length, 1, "one ref dispatch")
  assert.deepEqual(refs[0].args.slice(-3), ["refs/heads/main", done.commit, qualified], "a compare-and-swap from the qualified HEAD")
  for (const call of calls.filter(({ args }) => args[2] === "hook")) assert.ok(call.index && !call.index.startsWith(root), "hooks see the private index, never the shared one")
  assert.deepEqual(calls.filter(({ args }) => args[2] === "hook").map(({ args }) => args[5]), ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"], "git commit's hooks, in its order")
  const body = git(root, ["log", "-1", "--format=%B"])
  assert.match(body, /^save notes\n\nPrepared-By: hook\nChecked-By: hook\n/u, "prepare-commit-msg and commit-msg ran on the message")
  assert.match(readFileSync(path.join(root, ".git", "pre-commit-saw"), "utf8"), /notes\.md/u, "pre-commit saw the change")
  assert.equal(readFileSync(path.join(root, ".git", "post-commit-saw"), "utf8").trim(), done.commit, "post-commit ran after the branch moved")
  assert.equal(done.commit, head(root))
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).trim(), qualified)
  assert.match(git(root, ["reflog", "-1", "--format=%gs", "main"]), /^commit: save notes/u, "the reflog says commit, as git commit would")
  assert.equal(git(root, ["diff", "--cached", "--name-only"]).trim(), "", "the shared index agrees with HEAD")
})

test("a pre-commit hook that changes what would be committed is held: Desk commits only the captured change", () => {
  const root = repo()
  writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho extra > extra.md && git add extra.md\n", { mode: 0o755 })
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const before = snapshot(root, ["notes.md"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(answer.state, "held", answer.reason)
  assert.match(answer.reason, /changed what would be committed/u)
  assert.deepEqual(snapshot(root, ["notes.md"]), before)
})

test("a hook cut off at the bound is unknown and moves nothing; a cut-off branch update is unknown and names the commit", () => {
  for (const verb of ["hook", "update-ref"]) {
    const root = repo()
    writeFileSync(path.join(root, "notes.md"), "mine\n")
    const committed = capturedFailure(root, ["notes.md"], "save notes")
    const qualified = head(root)
    const cut = (cmd, args, opts) => args[2] === verb ? { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) } : spawnSync(cmd, args, opts)
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: cut })
    assert.equal(answer.state, "unknown", `${verb}: ${answer.reason}`)
    assert.match(answer.reason, /cut off at the 600 s bound/u)
    assert.equal(head(root), qualified, `${verb}: the branch did not move`)
    if (verb === "update-ref") assert.match(answer.commit, /^[0-9a-f]{40}$/u, "the reply names the commit it built")
  }
})

// The finish runs from a shell, outside the tool call's budget. A hook slower than the tool's 10-second bound is what left the
// commit unfinished, so the one commit dispatch gets room for it; every read keeps the short bound.
test("the commit's hooks, commit-tree and branch update outlast a hook slower than the tool's bound, and every read keeps the short bound", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const calls = []
  const spy = (cmd, args, opts) => { calls.push({ verb: args[2], timeout: opts?.timeout }); return spawnSync(cmd, args, opts) }
  assert.equal(finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: spy }).state, "finished")
  const slow = new Set(["hook", "commit-tree", "update-ref"])
  for (const call of calls.filter(({ verb }) => slow.has(verb))) assert.equal(call.timeout, 600_000, `${call.verb} gets the 600 s bound`)
  for (const call of calls.filter(({ verb }) => !slow.has(verb))) assert.equal(call.timeout, 10_000, `${call.verb} keeps the short bound`)
  assert.ok(calls.some(({ verb }) => verb === "hook") && calls.some(({ verb }) => verb === "update-ref"))
})

function lateCommit(root) {
  writeFileSync(path.join(root, "late.md"), "late\n")
  spawnSync("git", ["-C", root, "add", "late.md"], { env })
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "late", "--", "late.md"], { env })
}

test("the branch moving after the checks and before the dispatch is held: nothing is committed", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  let moved = false
  const commits = []
  const racing = (cmd, args, opts) => {
    if (!moved && args[2] === "read-tree") { moved = true; lateCommit(root) }
    if (args[2] === "commit") commits.push(args)
    return spawnSync(cmd, args, opts)
  }
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: racing })
  assert.equal(answer.state, "held", answer.reason)
  assert.equal(commits.length, 0, "never dispatched")
  assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "late", "the other writer's commit stands")
  assert.equal(git(root, ["show", "HEAD:late.md"]), "late\n")
})

// 0972/drain on #625: the window between the last read of HEAD and the moment the commit is made. A commit built from the
// qualified HEAD must never land on a HEAD another writer moved in that window: that would silently undo their commit. The
// branch moves only by a compare-and-swap against the HEAD that was qualified, so the other writer's commit stands.
const MUTATING = new Set(["commit", "hook", "commit-tree", "update-ref"])
test("HEAD moving after the last read and before the commit is made never undoes the other commit: held, nothing moved", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  let moved = false
  const refs = []
  const racing = (cmd, args, opts) => {
    if (!moved && MUTATING.has(args[2])) { moved = true; lateCommit(root) }
    if (args[2] === "commit" || args[2] === "update-ref") refs.push(args)
    return spawnSync(cmd, args, opts)
  }
  const late = () => git(root, ["log", "-1", "--format=%H", "--", "late.md"]).trim()
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: racing })
  assert.ok(moved, "the race was injected")
  assert.equal(git(root, ["ls-tree", "--name-only", "HEAD", "--", "late.md"]).trim(), "late.md", "the other writer's file is still in HEAD")
  assert.equal(git(root, ["log", "--format=%H", "--diff-filter=D", "--", "late.md"]).trim(), "", "no commit on the branch deleted it")
  assert.equal(head(root), late(), "the branch is exactly where the other writer left it")
  assert.equal(answer.state, "held", answer.reason)
  assert.match(answer.reason, /moved|nothing was committed/u)
  assert.ok(refs.length <= 1, "at most one ref dispatch, never repeated")
})

test("the checkout on another branch now is held: the tool's branch refusal is checked again", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  git(root, ["switch", "-q", "-c", "elsewhere"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(answer.state, "held")
  assert.match(answer.reason, /elsewhere/u)
})

// R3: the admitted index entry travels with its mode. With core.symlinks=false a link is a placeholder file holding its target;
// committing the path from disk would make it a regular file (100644). The route commits the admitted 120000 entry.
test("a temporary-index commit that did not land is finished with the admitted entry's mode, a link kept a link", () => {
  const root = repo()
  git(root, ["config", "core.symlinks", "false"])
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  writeFileSync(path.join(root, "_archive", "link"), "../base.md")
  const blob = git(root, ["hash-object", "-w", "_archive/link"]).trim()
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},_archive/link`])
  const entries = indexEntries(root, ["_archive/link"], spawnSync)
  // #632: the temporary-index commit runs no `git commit` to refuse, so a real pre-commit hook refuses it, then is taken away.
  const hooks = mkdtempSync(path.join(tmpdir(), "finish-commit-hooks-"))
  writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho 'finish-commit-test-297: pre-commit refused' >&2\nexit 1\n", { mode: 0o755 })
  git(root, ["config", "core.hooksPath", hooks])
  const before = head(root)
  const committed = commitIndexPaths(root, ["_archive/link"], entries, "task_archive: link", spawnSync)
  assert.match(committed.stderr, /finish-commit-test-297: pre-commit refused/u)
  assert.equal(head(root), before)
  assert.deepEqual(committed.capture, { before, branch: "main", expected: [`120000 ${blob}\t_archive/link`] })
  git(root, ["config", "--unset", "core.hooksPath"])
  assert.equal(committed.ok, false)
  const route = commitFailure({ root, paths: ["_archive/link"], message: "task_archive: link", committed }).route_around
  const check = route.steps[0].argv
  const ready = spawnSync(check[0], check.slice(1), { encoding: "utf8", env })
  assert.equal(ready.status, 3, ready.stdout)
  const commit = route.steps[1].argv
  const done = spawnSync(commit[0], commit.slice(1), { encoding: "utf8", env })
  assert.equal(done.status, 0, done.stdout)
  assert.match(git(root, ["ls-tree", "HEAD", "--", "_archive/link"]), /^120000 blob /u)
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "", "the shared index agrees with HEAD")
})

test("the repository's own pre-commit hook still runs: the card guard refuses a hand commit of a live task card", () => {
  const root = repo()
  for (const dir of ["_meta", "_archive", "greenhouse/watering-api"]) mkdirSync(path.join(root, dir), { recursive: true })
  writeFileSync(path.join(root, "_meta", "keep.md"), "x\n")
  writeFileSync(path.join(root, "greenhouse", "watering-api", "task.md"), "---\ntitle: x\nstatus: processing\n---\n\nbody\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "seed"])
  installCardGuard(root)
  writeFileSync(path.join(root, "greenhouse", "watering-api", "task.md"), "---\ntitle: x\nstatus: validating\n---\n\nbody\n")
  const committed = capturedFailure(root, ["greenhouse/watering-api/task.md"], "card", refused)
  const before = snapshot(root, ["greenhouse/watering-api/task.md"])
  const answer = finish(root, ["greenhouse/watering-api/task.md"], "card", committed, { commit: true })
  assert.equal(answer.state, "held")
  assert.match(answer.reason, /pre-commit hook refused the commit/u)
  assert.match(answer.reason, /task/u, "the guard's own words come through")
  assert.deepEqual(snapshot(root, ["greenhouse/watering-api/task.md"]), before)
  const overridden = finish(root, ["greenhouse/watering-api/task.md"], "card", committed, { env: { ...env, [TOOL_COMMIT_ENV]: "1" } })
  assert.equal(overridden.state, "held", "never runs with the guard's override set")
  assert.equal(overridden.reason.includes(TOOL_COMMIT_ENV), false, "the reply never names the override, so an agent cannot copy it")
})

test("the command line prints JSON and exits 0 done, 3 ready, 4 held, 5 unknown, 2 usage", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const args = ["--root", root, "--branch", committed.capture.branch, "--before", committed.capture.before, "--message", "save notes", "--path", "notes.md", ...committed.capture.expected.flatMap((line) => ["--entry", line])]
  const run = (argv) => { let text = ""; const code = runFinishCommitCli(argv, { env, out: { write: (s) => { text += s } } }); return { code, answer: JSON.parse(text) } }
  assert.deepEqual([run(args).code, run(args).answer.state], [3, "ready"])
  assert.deepEqual([run([...args, "--commit"]).code, run(args).answer.state], [0, "committed"])
  assert.equal(run(["--root"]).code, 2)
  assert.equal(run(["--bogus", "x"]).code, 2)
  assert.equal(run(["--root", root, "--branch", "main", "--before", "", "--message", "m"]).code, 4, "no captured change: held")
})

test("the command line answers unknown, exit 5, and changes nothing when the finish itself throws before it can commit", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const args = ["--root", root, "--branch", committed.capture.branch, "--before", committed.capture.before, "--message", "save notes", "--path", "notes.md", ...committed.capture.expected.flatMap((line) => ["--entry", line])]
  const before = snapshot(root, ["notes.md"])
  // The private index lives under the temporary folder; one that does not exist makes the finish throw before any dispatch.
  const missing = path.join(root, "no-such-tmp")
  const script = path.resolve(import.meta.dirname, "../../../../../plugins/desk/mcp/scripts/finish-commit.js")
  const cli = spawnSync(process.execPath, [script, ...args, "--commit"], { encoding: "utf8", env: { ...env, TMPDIR: missing, TMP: missing, TEMP: missing } })
  assert.equal(cli.status, 5, cli.stderr)
  const answer = JSON.parse(cli.stdout)
  assert.equal(answer.state, "unknown")
  assert.match(answer.reason, /ENOENT/)
  assert.deepEqual(snapshot(root, ["notes.md"]), before, "HEAD, index and working tree are as they were")
})

// 0972 #1 on ae1395e4: a captured change at a folder is the folder's leaves. Desk saves and moves name folders, so the finish
// removes every leaf HEAD holds under a captured path that the capture does not keep (a deleted or renamed file), and checks
// the whole tree it built against the capture before the compare-and-swap.
function docsRepo() {
  const root = repo()
  mkdirSync(path.join(root, "docs"), { recursive: true })
  writeFileSync(path.join(root, "docs", "keep.md"), "keep\n")
  writeFileSync(path.join(root, "docs", "old.md"), "old\n")
  git(root, ["add", "docs"])
  git(root, ["commit", "-q", "-m", "docs"])
  return root
}
const leaves = (root, rev, paths) => git(root, ["ls-tree", "-r", "--name-only", rev, "--", ...paths]).split("\n").filter(Boolean)

test("a captured folder with a deleted file is finished without that file: every leaf under the folder is reconciled", () => {
  const root = docsRepo()
  writeFileSync(path.join(root, "docs", "keep.md"), "kept, edited\n")
  git(root, ["rm", "-q", "docs/old.md"])
  const committed = capturedFailure(root, ["docs"], "tidy docs")
  assert.deepEqual(committed.capture.expected.map((line) => line.split("\t")[1]), ["docs/keep.md"])
  const done = finish(root, ["docs"], "tidy docs", committed, { commit: true })
  assert.equal(done.state, "finished", done.reason)
  assert.deepEqual(leaves(root, "HEAD", ["docs"]), ["docs/keep.md"], "the deleted file is gone from the commit")
  assert.equal(git(root, ["show", "HEAD:docs/keep.md"]), "kept, edited\n")
  assert.equal(finish(root, ["docs"], "tidy docs", committed).state, "committed", "the read-back agrees")
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "", "the shared index agrees with HEAD")
})

test("a captured folder with a renamed file is finished as the rename, never as a copy", () => {
  const root = docsRepo()
  git(root, ["mv", "docs/old.md", "docs/new.md"])
  const committed = capturedFailure(root, ["docs"], "rename doc")
  const done = finish(root, ["docs"], "rename doc", committed, { commit: true })
  assert.equal(done.state, "finished", done.reason)
  assert.deepEqual(leaves(root, "HEAD", ["docs"]), ["docs/keep.md", "docs/new.md"], "the old name is gone")
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "", "the shared index agrees with HEAD")
})

test("a private index that does not build exactly the captured tree is held before the compare-and-swap, and nothing moves", () => {
  const root = docsRepo()
  git(root, ["rm", "-q", "docs/old.md"])
  const committed = capturedFailure(root, ["docs"], "tidy docs")
  const before = snapshot(root, ["docs"])
  // Git drops the removals it was given: the tree it builds still holds docs/old.md.
  const lossy = (cmd, args, opts) => args[2] === "update-index" && opts?.input
    ? spawnSync(cmd, args, { ...opts, input: opts.input.split("\0").filter((r) => r && !r.startsWith("0 ")).map((r) => `${r}\0`).join("") })
    : spawnSync(cmd, args, opts)
  const refs = []
  const spy = (cmd, args, opts) => { if (args[2] === "update-ref" || args[2] === "hook") refs.push(args[2]); return lossy(cmd, args, opts) }
  const answer = finish(root, ["docs"], "tidy docs", committed, { commit: true, spawnGit: spy })
  assert.equal(answer.state, "held", answer.reason)
  assert.match(answer.reason, /does not match the captured change/u)
  assert.deepEqual(refs, [], "no hook ran and the branch was never dispatched")
  assert.deepEqual(snapshot(root, ["docs"]), before)
})

// 0972 #4 on ae1395e4: git commit has rules for a merge, cherry-pick, revert or rebase in progress (a merge commit takes every
// staged change and both parents, so `git commit -- <paths>` refuses a partial one). The finish makes one-parent commits only,
// so while any such operation is in progress it holds, before and after it builds the commit, and moves nothing.
test("a resolved merge in progress is held: no partial one-parent commit, MERGE_HEAD and the branch left as they were", () => {
  const root = repo()
  git(root, ["switch", "-q", "-c", "side"])
  writeFileSync(path.join(root, "side.md"), "side\n")
  git(root, ["add", "side.md"])
  git(root, ["commit", "-q", "-m", "side"])
  git(root, ["switch", "-q", "main"])
  writeFileSync(path.join(root, "main.md"), "main\n")
  git(root, ["add", "main.md"])
  git(root, ["commit", "-q", "-m", "main"])
  git(root, ["merge", "-q", "--no-commit", "--no-ff", "side"])
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  git(root, ["add", "notes.md"])
  const native = spawnSync("git", ["-C", root, "commit", "-q", "-m", "save notes", "--", "notes.md"], { encoding: "utf8", env })
  assert.notEqual(native.status, 0, "git commit itself refuses a partial merge commit")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const before = snapshot(root, ["notes.md", "side.md"])
  for (const commit of [false, true]) {
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit })
    assert.equal(answer.state, "held", answer.reason)
    assert.match(answer.reason, /merge is in progress/u)
  }
  assert.deepEqual(snapshot(root, ["notes.md", "side.md"]), before, "HEAD, the index and the working tree are as they were")
  assert.equal(git(root, ["rev-parse", "MERGE_HEAD"]).trim(), git(root, ["rev-parse", "side"]).trim(), "the merge is still in progress")
})

test("a cherry-pick, revert, sequence or rebase in progress is held, and one that starts while the commit is built is held before the branch moves", () => {
  for (const marker of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "rebase-merge", "rebase-apply"]) {
    const root = repo()
    writeFileSync(path.join(root, "notes.md"), "mine\n")
    const committed = capturedFailure(root, ["notes.md"], "save notes")
    const qualified = head(root)
    const place = () => (marker.startsWith("rebase") || marker === "sequencer" ? mkdirSync(path.join(root, ".git", marker)) : writeFileSync(path.join(root, ".git", marker), `${qualified}\n`))
    let late = false
    const starting = (cmd, args, opts) => { if (!late && args[2] === "commit-tree") { late = true; place() } return spawnSync(cmd, args, opts) }
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: starting })
    assert.ok(late, `${marker}: the operation started while the commit was built`)
    assert.equal(answer.state, "held", `${marker}: ${answer.reason}`)
    assert.equal(head(root), qualified, `${marker}: the branch did not move`)
    assert.equal(finish(root, ["notes.md"], "save notes", committed).state, "held", `${marker}: a read with it in progress is held`)
  }
})

test("Git unable to say whether an operation is in progress is unknown, and nothing moves", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const before = snapshot(root, ["notes.md"])
  const blind = (cmd, args, opts) => (args.includes("--git-path") ? { status: 128, stdout: "", stderr: "fatal: not a git repository" } : spawnSync(cmd, args, opts))
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: blind })
  assert.equal(answer.state, "unknown", answer.reason)
  assert.match(answer.reason, /in progress/u)
  assert.deepEqual(snapshot(root, ["notes.md"]), before)
})

// 0972 #3 on ae1395e4: post-commit runs after the branch moved, so its outcome is a separate fact. The finish reads the branch
// and HEAD again after it; a hook that moved or replaced the commit, failed or was cut off makes the answer unknown, naming
// the commit that was made and the hook's outcome. Nothing is replayed.
function postCommit(root, script) {
  writeFileSync(path.join(root, ".git", "hooks", "post-commit"), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

test("a post-commit hook that moves the branch back or replaces the commit is unknown, naming the commit made", () => {
  const scripts = {
    back: "git update-ref refs/heads/main HEAD~1",
    replaced: "c=$(echo replaced | git commit-tree HEAD~1^{tree} -p HEAD~1) && git update-ref refs/heads/main $c",
  }
  for (const [name, script] of Object.entries(scripts)) {
    const root = repo()
    writeFileSync(path.join(root, "notes.md"), "mine\n")
    const committed = capturedFailure(root, ["notes.md"], "save notes")
    postCommit(root, script)
    const refs = []
    const spy = (cmd, args, opts) => { if (args[2] === "update-ref") refs.push(args); return spawnSync(cmd, args, opts) }
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: spy })
    assert.equal(answer.state, "unknown", `${name}: ${answer.reason}`)
    assert.match(answer.commit, /^[0-9a-f]{40}$/u, `${name}: the commit made is named`)
    assert.equal(answer.post_commit, "ran", `${name}: the hook's own outcome is reported apart`)
    assert.notEqual(head(root), answer.commit, `${name}: the hook moved the branch`)
    assert.equal(answer.head, head(root), `${name}: the reply names where HEAD is now`)
    assert.equal(refs.length, 1, `${name}: one ref dispatch, never replayed`)
  }
})

test("a post-commit hook that fails or is cut off is unknown: the commit stands, and the hook's outcome is reported apart", () => {
  for (const outcome of ["failed", "cut"]) {
    const root = repo()
    writeFileSync(path.join(root, "notes.md"), "mine\n")
    const committed = capturedFailure(root, ["notes.md"], "save notes")
    postCommit(root, "echo lfs push broke >&2; exit 1")
    const cut = (cmd, args, opts) => (outcome === "cut" && args.includes("post-commit") ? { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) } : spawnSync(cmd, args, opts))
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: cut })
    assert.equal(answer.state, "unknown", `${outcome}: ${answer.reason}`)
    assert.equal(answer.commit, head(root), `${outcome}: the commit was made and the branch holds it`)
    assert.match(answer.post_commit, outcome === "cut" ? /cut off at the 600 s bound/u : /failed: lfs push broke/u)
    assert.equal(finish(root, ["notes.md"], "save notes", committed).state, "committed", `${outcome}: a read-back says committed; nothing replays`)
  }
})

// 0972 #5 on ae1395e4: a first commit on an unborn branch is captured with before "". The finish treats HEAD as unborn only on
// positive proof (the checkout is on the branch, and Git lists no such branch while HEAD does not resolve); any other failure to
// read HEAD stays unknown.
function unbornWithOrigin() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "finish-unborn-")))
  const origin = `${root}-origin.git`
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "t"])
  git(root, ["config", "user.email", "t@example.com"])
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8", env })
  git(root, ["remote", "add", "origin", origin])
  return { root, origin }
}

test("the first commit on an unborn branch is ready, then finished, and reaches an initially empty origin", () => {
  const { root, origin } = unbornWithOrigin()
  writeFileSync(path.join(root, "notes.md"), "first\n")
  const committed = capturedFailure(root, ["notes.md"], "first notes")
  assert.equal(committed.capture.before, "", "captured on an unborn branch")
  assert.equal(finish(root, ["notes.md"], "first notes", committed).state, "ready")
  const done = finish(root, ["notes.md"], "first notes", committed, { commit: true })
  assert.equal(done.state, "finished", done.reason)
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]).trim(), "1", "one root commit")
  assert.equal(finish(root, ["notes.md"], "first notes", committed).state, "committed")
  git(root, ["push", "-q", "-u", "origin", "main"])
  assert.equal(spawnSync("git", ["--git-dir", origin, "show", "main:notes.md"], { encoding: "utf8", env }).stdout, "first\n", "the origin holds the content")
})

test("HEAD that will not resolve while the branch exists is unknown, never treated as unborn", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  const before = snapshot(root, ["notes.md"])
  const blind = (cmd, args, opts) => (args.includes("rev-parse") && args.at(-1) === "HEAD" ? { status: 1, stdout: "", stderr: "" } : spawnSync(cmd, args, opts))
  for (const commit of [false, true]) assert.equal(finish(root, ["notes.md"], "save notes", committed, { commit, spawnGit: blind }).state, "unknown")
  const broken = (cmd, args, opts) => (args.includes("for-each-ref") ? { status: 128, stdout: "", stderr: "fatal" } : spawnSync(cmd, args, opts))
  const { root: unborn } = unbornWithOrigin()
  writeFileSync(path.join(unborn, "notes.md"), "first\n")
  const first = capturedFailure(unborn, ["notes.md"], "first notes")
  assert.equal(finish(unborn, ["notes.md"], "first notes", first, { spawnGit: broken }).state, "unknown", "no positive proof of unborn: unknown")
  assert.deepEqual(snapshot(root, ["notes.md"]), before)
})

test("a branch that is unborn now but had a HEAD when the change was captured is unknown, never restarted from a root commit", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  git(root, ["update-ref", "-d", "refs/heads/main"])
  for (const commit of [false, true]) {
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit })
    assert.equal(answer.state, "unknown", answer.reason)
  }
  assert.equal(spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { env }).status, 1, "the branch is still unborn")
})

// Every answer finish-commit gives, reached: each read Git cannot make, each step Git refuses, and each hook outcome. A read that
// fails is unknown or held, a mutation that fails before the branch moves is held, and nothing moves in either case.
const answered = (verb, reply, { nth = 1, when = () => true } = {}) => {
  let seen = 0
  return (cmd, args, opts) => (args[2] === verb && when(args) && ++seen === nth ? { stdout: "", stderr: "", ...reply } : spawnSync(cmd, args, opts))
}
const no = { status: 1, stdout: "", stderr: "it failed" }
function readyChange() {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  return { root, committed: capturedFailure(root, ["notes.md"], "save notes") }
}
function hook(root, name, script) {
  writeFileSync(path.join(root, ".git", "hooks", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}
function assertNothingMoved(root, before, label) {
  assert.deepEqual(snapshot(root, ["notes.md"]), before, label)
}

test("a Git answer with no output streams at all is read as a failure with nothing to say, never as success", () => {
  const { root, committed } = readyChange()
  const answer = finish(root, ["notes.md"], "save notes", committed, { spawnGit: answered("rev-parse", { status: 1, stdout: undefined, stderr: undefined }) })
  assert.equal(answer.state, "unknown", answer.reason)
  const missing = finish(root, ["notes.md"], "save notes", committed, { spawnGit: (cmd, args, opts) => spawnSync(args[2] === "symbolic-ref" ? "git-that-does-not-exist" : cmd, args, opts) })
  assert.equal(missing.state, "held", "a Git that cannot start is not on a branch")
})

test("each read the qualification needs and cannot make is unknown, and nothing moves", () => {
  const cases = {
    "HEAD read fails outright": answered("rev-parse", { status: 128, stderr: "fatal" }, { when: (args) => args.includes("--verify") }),
    "HEAD's entries cannot be read": answered("ls-tree", no),
    "the index cannot be read": answered("ls-files", no),
  }
  for (const [label, spawnGit] of Object.entries(cases)) {
    const { root, committed } = readyChange()
    const before = snapshot(root, ["notes.md"])
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit })
    assert.equal(answer.state, "unknown", `${label}: ${answer.reason}`)
    assertNothingMoved(root, before, label)
  }
})

test("a detached checkout is held: the change was made on a branch", () => {
  const { root, committed } = readyChange()
  git(root, ["checkout", "-q", "--detach"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.deepEqual([answer.state, answer.reason], ["held", "the checkout is not on a branch now"])
})

test("with no environment given, the finish reads the process's own and still commits through the card guard's rules", () => {
  const { root, committed } = readyChange()
  const saved = process.env[TOOL_COMMIT_ENV]
  delete process.env[TOOL_COMMIT_ENV]
  try {
    const answer = finishCommit({ root, paths: ["notes.md"], message: "save notes", ...committed.capture })
    assert.equal(answer.state, "ready", answer.reason)
  } finally {
    if (saved !== undefined) process.env[TOOL_COMMIT_ENV] = saved
  }
})

test("HEAD that moved only by another commit to other paths is still ready, then finished on the new HEAD", () => {
  const { root, committed } = readyChange()
  writeFileSync(path.join(root, "other.md"), "theirs\n")
  git(root, ["add", "other.md"])
  git(root, ["commit", "-q", "-m", "theirs", "--", "other.md"])
  const theirs = head(root)
  assert.equal(finish(root, ["notes.md"], "save notes", committed).state, "ready")
  const done = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(done.state, "finished", done.reason)
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).trim(), theirs, "on top of the other commit, which stands")
})

test("an unborn capture whose branch got another session's root commit at other paths is ready", () => {
  const { root } = unbornWithOrigin()
  writeFileSync(path.join(root, "notes.md"), "first\n")
  const committed = capturedFailure(root, ["notes.md"], "first notes")
  writeFileSync(path.join(root, "other.md"), "theirs\n")
  git(root, ["add", "other.md"])
  git(root, ["commit", "-q", "-m", "theirs", "--", "other.md"])
  assert.equal(finish(root, ["notes.md"], "first notes", committed).state, "ready")
})

test("a branch rewound to before the capture, with these paths different there, is held", () => {
  const root = repo()
  writeFileSync(path.join(root, "notes.md"), "old\n")
  git(root, ["add", "notes.md"])
  git(root, ["commit", "-q", "-m", "old notes"])
  writeFileSync(path.join(root, "notes.md"), "mine\n")
  const committed = capturedFailure(root, ["notes.md"], "save notes")
  git(root, ["update-ref", "refs/heads/main", "HEAD~1"])
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.deepEqual([answer.state, answer.reason], ["held", "another commit changed these paths after this change was captured"])
})

test("HEAD that moved, when the earlier HEAD's entries cannot be read, is unknown", () => {
  const { root, committed } = readyChange()
  git(root, ["update-ref", "refs/heads/main", git(root, ["commit-tree", "-p", "HEAD", "-m", "theirs", "HEAD^{tree}"]).trim()])
  const answer = finish(root, ["notes.md"], "save notes", committed, { spawnGit: answered("ls-tree", no, { when: (args) => args.includes(committed.capture.before) }) })
  assert.deepEqual([answer.state, answer.reason], ["unknown", "Git could not read the earlier HEAD's entries at these paths"])
})

test("conflict stages at the captured paths, with no merge in progress, are held", () => {
  const { root, committed } = readyChange()
  const sha = git(root, ["rev-parse", ":notes.md"]).trim()
  git(root, ["update-index", "-z", "--index-info"], { input: `0 ${"0".repeat(40)}\tnotes.md\x00100644 ${sha} 1\tnotes.md\x00100644 ${sha} 2\tnotes.md\x00100644 ${sha} 3\tnotes.md\0` })
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.deepEqual([answer.state, answer.reason], ["held", "the index holds a merge conflict at these paths"])
})

test("each step that builds the commit and fails before any hook runs is held or unknown, and nothing moves", () => {
  const cases = {
    "the repository prefix cannot be read": [answered("rev-parse", no, { when: (args) => args.includes("--show-prefix") }), "unknown"],
    "HEAD's leaves cannot be read again": [answered("ls-tree", no, { nth: 2 }), "unknown"],
    "read-tree fails": [answered("read-tree", no), "held"],
    "update-index fails": [answered("update-index", no), "held"],
    "write-tree fails": [answered("write-tree", no), "held"],
    "the built tree cannot be read": [answered("ls-tree", no, { nth: 3 }), "held"],
    "the built tree cannot be compared with HEAD": [answered("diff-tree", no), "held"],
  }
  for (const [label, [spawnGit, state]] of Object.entries(cases)) {
    const { root, committed } = readyChange()
    const before = snapshot(root, ["notes.md"])
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit })
    assert.equal(answer.state, state, `${label}: ${answer.reason}`)
    assertNothingMoved(root, before, label)
  }
})

test("a private index that gains an entry outside the captured paths is held before the compare-and-swap", () => {
  const { root, committed } = readyChange()
  const before = snapshot(root, ["notes.md"])
  const sha = git(root, ["rev-parse", ":notes.md"]).trim()
  const widened = (cmd, args, opts) => spawnSync(cmd, args, args[2] === "update-index" ? { ...opts, input: `${opts.input}100644 ${sha}\textra.md\0` } : opts)
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: widened })
  assert.equal(answer.state, "held", answer.reason)
  assert.match(answer.reason, /outside the captured paths: extra\.md/u)
  assertNothingMoved(root, before, "nothing moved")
})

test("each commit hook that refuses, silently or with a reason, or that empties the message, is held, and nothing moves", () => {
  const cases = {
    "pre-commit": ["pre-commit", "exit 1", /pre-commit hook refused the commit: no reason given/u],
    "prepare-commit-msg": ["prepare-commit-msg", "echo no template >&2; exit 1", /prepare-commit-msg hook refused the commit: no template/u],
    "commit-msg": ["commit-msg", "echo bad subject >&2; exit 1", /commit-msg hook refused the commit: bad subject/u],
    "an emptied message": ["commit-msg", ": > \"$1\"", /the commit message is empty after the hooks ran/u],
    "a hook that switches branch": ["commit-msg", "git symbolic-ref HEAD refs/heads/elsewhere", /the checkout left main while the hooks ran/u],
  }
  for (const [label, [name, script, reason]] of Object.entries(cases)) {
    const { root, committed } = readyChange()
    hook(root, name, script)
    const before = git(root, ["rev-parse", "refs/heads/main"]).trim()
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
    assert.equal(answer.state, "held", `${label}: ${answer.reason}`)
    assert.match(answer.reason, reason, label)
    assert.equal(git(root, ["rev-parse", "refs/heads/main"]).trim(), before, `${label}: the branch did not move`)
  }
})

test("a commit-tree that fails, with a reason or with none, is held and moves nothing; a signing config is honoured", () => {
  const { root, committed } = readyChange()
  git(root, ["config", "commit.gpgSign", "true"])
  git(root, ["config", "gpg.program", "false"])
  const before = head(root)
  const signed = finish(root, ["notes.md"], "save notes", committed, { commit: true })
  assert.equal(signed.state, "held", signed.reason)
  assert.match(signed.reason, /git commit-tree failed: .+/u)
  assert.doesNotMatch(signed.reason, /no reason given/u)
  git(root, ["config", "commit.gpgSign", "false"])
  const silent = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: answered("commit-tree", { status: 1 }) })
  assert.deepEqual([silent.state, silent.reason], ["held", "nothing was committed: git commit-tree failed: no reason given"])
  assert.equal(head(root), before)
})

test("a branch update that reports success but leaves another commit, or fails with the branch gone, is unknown and names the commit", () => {
  const raced = (root) => (cmd, args, opts) => {
    const real = spawnSync(cmd, args, opts)
    if (args[2] === "update-ref") git(root, ["update-ref", "refs/heads/main", git(root, ["commit-tree", "-p", "HEAD", "-m", "theirs", "HEAD^{tree}"]).trim()])
    return real
  }
  const gone = (root) => (cmd, args, opts) => {
    if (args[2] === "update-ref") git(root, ["update-ref", "-d", "refs/heads/main"])
    return spawnSync(cmd, args, opts)
  }
  for (const [label, wrap, said] of [["raced", raced, /reported success/u], ["gone", gone, /failed and refs\/heads\/main/u]]) {
    const { root, committed } = readyChange()
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: wrap(root) })
    assert.equal(answer.state, "unknown", `${label}: ${answer.reason}`)
    assert.match(answer.reason, said, label)
    assert.match(answer.commit, /^[0-9a-f]{40}$/u, label)
  }
})

test("a compare-and-swap Git refuses without a reason is held: the branch is where it was", () => {
  const { root, committed } = readyChange()
  const before = head(root)
  const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true, spawnGit: answered("update-ref", { status: 1 }) })
  assert.equal(answer.state, "held", answer.reason)
  assert.match(answer.reason, /refused to overwrite it \(no reason given\)/u)
  assert.equal(head(root), before)
})

test("a post-commit hook that fails silently, deletes the branch or detaches HEAD is unknown, naming the commit made", () => {
  const cases = {
    silent: ["exit 1", /post-commit hook failed: no reason given/u, true],
    deleted: ["git update-ref -d refs/heads/main", /Git could not read HEAD/u, false],
    detached: ["git checkout -q --detach", /on no branch/u, false],
  }
  for (const [label, [script, said, holds]] of Object.entries(cases)) {
    const { root, committed } = readyChange()
    hook(root, "post-commit", script)
    const answer = finish(root, ["notes.md"], "save notes", committed, { commit: true })
    assert.equal(answer.state, "unknown", `${label}: ${answer.reason}`)
    assert.match(answer.reason, said, label)
    assert.match(answer.commit, /^[0-9a-f]{40}$/u, label)
    if (holds) assert.equal(head(root), answer.commit, `${label}: the commit stands`)
  }
})

test("the command line without --root is bad usage, exit 2, and reads nothing", () => {
  let out = ""
  let calls = 0
  const code = runFinishCommitCli(["--branch", "main"], { out: { write: (text) => { out += text } }, spawnGit: () => { calls++; return { status: 1 } }, env })
  assert.equal(code, 2)
  assert.deepEqual(JSON.parse(out), { state: "usage", reason: "--root is required" })
  assert.equal(calls, 0)
})

// The routes' own defaults and wording, reached directly: a live card's route names every other path its next write would commit,
// a route with no read-back given is the unknown one, a held file's route publishes from its own folder when no desk root is
// given, and a commit that landed but is no longer in effect says both, naming the two commits.
test("a live card's held route names the other paths a new task_update would commit, such as its track.md", () => {
  const capture = { before: "a".repeat(40), branch: "main", expected: [] }
  const route = commitRoute({ root: "/desk", paths: ["t/x.md", "t/track.md"], message: "m", readback: "absent", card: "t/x", capture })
  assert.equal(route.held, true)
  assert.match(route.steps[1].step, /commits whatever the card and t\/track\.md hold by then/u)
  const alone = commitRoute({ root: "/desk", paths: ["t/x.md"], message: "m", readback: "absent", card: "t/x", capture })
  assert.doesNotMatch(alone.steps[1].step, /track\.md/u, "a card alone names no other path")
})

test("a captured route given no read-back is the unknown route: read first, never a blind repeat", () => {
  const route = commitRoute({ root: "/desk", paths: ["notes.md"], message: "m", capture: { before: "a".repeat(40), branch: "main", expected: [] } })
  assert.match(route.summary, /^Desk cannot tell whether its commit landed/u)
})

test("a held file's route with no desk root given commits and publishes from the file's own folder", () => {
  const route = heldFileRouteFor({ dir: "/desk/meta", names: ["AGENTS.md"], message: "lesson", change: "one line" })
  assert.deepEqual(route.steps[1].arguments.paths, ["AGENTS.md"])
  assert.ok(route.steps[2].argv.flat().includes("/desk/meta"), JSON.stringify(route.steps[2].argv))
})

test("a commit that landed but HEAD no longer holds is worded as landed and not in effect, naming both commits", () => {
  const words = commitFailureWords({ status: "unknown", reason: "timeout", landed: { commit: "1".repeat(40), head: "2".repeat(40) } })
  assert.equal(words, `Desk's commit ${"1".repeat(12)} landed (timeout), but HEAD ${"2".repeat(12)} no longer holds it, so Desk cannot tell whether it is in effect; route_around reads it back and changes nothing on its own`)
})
