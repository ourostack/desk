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
import { commitFailure } from "../../../../../plugins/desk/mcp/src/util/route-around.js"
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
  const committed = commitIndexPaths(root, ["_archive/link"], entries, "task_archive: link", refused)
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
