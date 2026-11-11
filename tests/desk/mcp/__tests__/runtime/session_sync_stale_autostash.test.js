// session-sync.js's repair of one stuck state: a `git pull --rebase --autostash` replayed its commits, re-applying its
// autostash conflicted, and git stopped before it removed `rebase-merge/`, which then holds only `autostash`. Git calls
// the checkout mid-rebase from then on, so every later pull refuses. The fixtures build that state with real Git: the
// autostash is a real stash commit, re-applied after a real rebase so the index really has unmerged entries, and the
// leftover marker is written where git keeps it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import {
  STALE_AUTOSTASH_REBASE,
  repairStaleAutostashRebase,
  runSessionSyncCli,
  staleAutostashSentence,
  syncWorkspace,
} from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { readSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"

const env = process.env
const noDelivery = () => {}
const noFiling = () => ({ file: "none" })

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function gitStatus(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status
}

function configure(root) {
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
}

async function writeAndCommit(root, name, content, message) {
  await fs.writeFile(path.join(root, name), content)
  git(root, ["add", "--", name])
  git(root, ["commit", "-q", "-m", message])
}

const read = (root, name) => fs.readFile(path.join(root, name), "utf8")
const gitDirOf = (root) => path.resolve(root, git(root, ["rev-parse", "--git-dir"]).trim())
const markerOf = (root) => path.join(gitDirOf(root), "rebase-merge")
const unmergedOf = (root) => git(root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter((line) => line !== "")
const stashCommits = (root) => git(root, ["stash", "list", "--format=%H"]).split("\n").filter((line) => line !== "")

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * The stuck state, in a clone (or, with `worktree`, a linked worktree of one) of a bare origin. Origin and the
 * checkout both changed seed.md: origin in a pushed commit, the checkout as an uncommitted edit. The checkout also has
 * one local commit, so the pull really replays something. The uncommitted edit becomes a stash commit (what
 * `--autostash` makes), the pull rebases, and re-applying the stash conflicts in seed.md; the marker git left behind
 * is then written as the one file `rebase-merge/autostash`.
 */
async function mkStuckFixture({ worktree = false } = {}) {
  const origin = await mkTempRoot("desk-stale-autostash-origin-")
  git(origin, ["init", "--bare", "-q"])
  const clone = await mkTempRoot("desk-stale-autostash-clone-")
  git(clone, ["clone", "-q", origin, "."])
  configure(clone)
  git(clone, ["symbolic-ref", "HEAD", "refs/heads/main"])
  await writeAndCommit(clone, "seed.md", "seed\n", "seed")
  await writeAndCommit(clone, "notes.md", "notes\n", "notes")
  git(clone, ["push", "-q", "-u", "origin", "main"])

  let root = clone
  if (worktree) {
    root = await mkTempRoot("desk-stale-autostash-worktree-")
    git(clone, ["worktree", "add", "-q", "-b", "desk-state", root, "origin/main"])
  }

  const other = await mkTempRoot("desk-stale-autostash-other-")
  git(other, ["clone", "-q", origin, "."])
  configure(other)
  git(other, ["checkout", "-q", "-B", "main", "origin/main"])
  await writeAndCommit(other, "seed.md", "seed\nfrom origin\n", "origin edits seed")
  git(other, ["push", "-q", "origin", "main"])

  await writeAndCommit(root, "local.md", "local\n", "local commit")
  // A second real stash commit, touching only notes.md, for the tests that need one besides the autostash.
  await fs.writeFile(path.join(root, "notes.md"), "notes\nedited\n")
  const elsewhere = git(root, ["stash", "create"]).trim()
  git(root, ["checkout", "-q", "--", "notes.md"])
  await fs.writeFile(path.join(root, "seed.md"), "seed\nfrom local\n")
  const autostash = git(root, ["stash", "create", "autostash"]).trim()
  git(root, ["checkout", "-q", "--", "seed.md"])
  git(root, ["pull", "-q", "--rebase"])
  assert.notEqual(gitStatus(root, ["stash", "apply", autostash]), 0, "re-applying the autostash conflicts")
  assert.deepEqual(unmergedOf(root), ["seed.md"])
  await fs.mkdir(markerOf(root))
  await fs.writeFile(path.join(markerOf(root), "autostash"), `${autostash}\n`)
  return { origin, clone, root, other, autostash, elsewhere }
}

// The stuck state is untouched: same HEAD, same marker files, same unmerged path, nothing stored in the stash list.
async function assertUntouched(root, head, markerFiles) {
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head)
  assert.deepEqual((await fs.readdir(markerOf(root))).sort(), markerFiles)
  assert.deepEqual(unmergedOf(root), ["seed.md"])
  assert.deepEqual(stashCommits(root), [])
}

test("the stuck state is repaired: the autostash is kept in the stash list, the marker goes and HEAD stays", async () => {
  const { root, autostash } = await mkStuckFixture()
  const head = git(root, ["rev-parse", "HEAD"]).trim()
  assert.match(git(root, ["status"]), /rebas/u, "git calls the checkout mid-rebase")
  assert.notEqual(gitStatus(root, ["pull", "-q", "--rebase", "--autostash"]), 0, "and every pull refuses")
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head)

  const repair = await repairStaleAutostashRebase({ root })

  assert.deepEqual(repair, { stash: "stash@{0}", commit: autostash, paths: ["seed.md"] })
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head, "HEAD does not move")
  assert.equal(await exists(markerOf(root)), false, "the marker is gone")
  assert.deepEqual(unmergedOf(root), [])
  assert.equal(git(root, ["status", "--porcelain", "--untracked-files=no"]), "", "nothing is left modified")
  assert.equal(await read(root, "seed.md"), "seed\nfrom origin\n", "the conflicted file is back as HEAD has it")
  assert.deepEqual(stashCommits(root), [autostash], "stored once")
  assert.match(git(root, ["stash", "list"]), /autostash Desk preserved from an interrupted pull/u)
  assert.equal(git(root, ["show", `${autostash}:seed.md`]), "seed\nfrom local\n", "the local change is kept")
  assert.doesNotMatch(git(root, ["status"]), /rebas/u)
})

test("syncWorkspace repairs the stuck state before pulling, then pulls, and says so where boot and desk_status read it", async () => {
  const { root, other, autostash } = await mkStuckFixture()
  await writeAndCommit(other, "later.md", "later\n", "origin moves on")
  git(other, ["push", "-q", "origin", "main"])

  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, fileProblem: noFiling })

  assert.equal(result.state, "synced")
  assert.equal(result.repaired, STALE_AUTOSTASH_REBASE)
  assert.equal(result.repairedStash, "stash@{0}")
  assert.equal(result.repairedCommit, autostash)
  assert.deepEqual(result.repairedPaths, ["seed.md"])
  const sentence = `An earlier pull had stopped before finishing; the local change it held is kept as stash@{0} (commit ${autostash.slice(0, 12)}).`
  assert.equal(result.repairedNote, sentence)
  assert.equal(await read(root, "later.md"), "later\n", "the pull that follows the repair succeeds")
  assert.deepEqual(stashCommits(root), [autostash])

  const recorded = readSyncStatus({ root, env }).last_repair
  assert.equal(recorded.kind, STALE_AUTOSTASH_REBASE)
  assert.equal(recorded.stash, "stash@{0}")
  assert.equal(recorded.note, sentence)
  const status = await desk_status({ deskRoot: root, env })
  assert.equal(status.sync.last_repair.note, sentence)
  assert.ok(compactStatus({ ...status, state: "ready" }).notes.includes(sentence), "the compact answer says it in one sentence")

  const again = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, fileProblem: noFiling })
  assert.equal(again.state, "synced")
  assert.equal("repaired" in again, false, "nothing is repaired twice")
  assert.equal(readSyncStatus({ root, env }).last_repair, undefined, "a later sync clears the record")
})

test("the stuck state is repaired in a linked worktree, whose marker lives in its own git directory", async () => {
  const { root, autostash } = await mkStuckFixture({ worktree: true })
  assert.notEqual(gitDirOf(root), path.join(root, ".git"))
  const head = git(root, ["rev-parse", "HEAD"]).trim()

  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, fileProblem: noFiling })

  assert.equal(result.state, "synced")
  assert.equal(result.repaired, STALE_AUTOSTASH_REBASE)
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head)
  assert.equal(await exists(markerOf(root)), false)
  assert.deepEqual(stashCommits(root), [autostash])
})

test("an autostash git already kept in the stash list is not stored a second time", async () => {
  const { root, autostash, elsewhere } = await mkStuckFixture()
  git(root, ["stash", "store", "-m", "autostash", autostash])
  git(root, ["stash", "store", "-m", "unrelated", elsewhere])
  assert.equal(stashCommits(root)[1], autostash)

  const repair = await repairStaleAutostashRebase({ root })

  assert.equal(repair.stash, "stash@{1}")
  assert.equal(stashCommits(root).length, 2, "no duplicate entry, not even from git rebase --quit")
  assert.equal(stashCommits(root)[1], autostash)
  assert.equal(await exists(markerOf(root)), false)
})

test("a marker holding anything besides autostash is left untouched, and the sync reports it as before", async () => {
  const { root } = await mkStuckFixture()
  await fs.writeFile(path.join(markerOf(root), "head-name"), "refs/heads/main\n")
  const head = git(root, ["rev-parse", "HEAD"]).trim()

  assert.equal(await repairStaleAutostashRebase({ root }), null)
  await assertUntouched(root, head, ["autostash", "head-name"])

  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env, fileProblem: noFiling })
  assert.equal(result.state, "unresolved")
  assert.equal("repaired" in result, false)
  assert.equal(readSyncStatus({ root, env }).last_repair, undefined)
  assert.deepEqual(stashCommits(root), [])
})

test("an autostash file that names no commit is left untouched", async () => {
  const { root } = await mkStuckFixture()
  const head = git(root, ["rev-parse", "HEAD"]).trim()
  const blob = spawnSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "not a commit\n", encoding: "utf8" }).stdout.trim()
  for (const content of [`${blob}\n`, "0123456789abcdef0123456789abcdef01234567\n", "not a sha\n", ""]) {
    await fs.writeFile(path.join(markerOf(root), "autostash"), content)
    assert.equal(await repairStaleAutostashRebase({ root }), null, JSON.stringify(content))
    await assertUntouched(root, head, ["autostash"])
  }
})

test("an unmerged path the autostash did not touch is left untouched", async () => {
  const { root, elsewhere } = await mkStuckFixture()
  const head = git(root, ["rev-parse", "HEAD"]).trim()
  // A real stash commit that touched only notes.md, not the unmerged seed.md.
  await fs.writeFile(path.join(markerOf(root), "autostash"), `${elsewhere}\n`)

  assert.equal(await repairStaleAutostashRebase({ root }), null)
  await assertUntouched(root, head, ["autostash"])
})

test("a modified or staged tracked file outside the autostash's paths is left untouched", async () => {
  for (const stage of [false, true]) {
    const { root } = await mkStuckFixture()
    const head = git(root, ["rev-parse", "HEAD"]).trim()
    await fs.writeFile(path.join(root, "notes.md"), "notes\nsomeone else's edit\n")
    if (stage) git(root, ["add", "--", "notes.md"])

    assert.equal(await repairStaleAutostashRebase({ root }), null, stage ? "staged" : "modified")
    await assertUntouched(root, head, ["autostash"])
    assert.equal(await read(root, "notes.md"), "notes\nsomeone else's edit\n")
  }
})

test("another git operation in progress beside the marker is left untouched", async () => {
  const { root } = await mkStuckFixture()
  const head = git(root, ["rev-parse", "HEAD"]).trim()
  await fs.writeFile(path.join(gitDirOf(root), "MERGE_HEAD"), `${head}\n`)

  assert.equal(await repairStaleAutostashRebase({ root }), null)
  await fs.unlink(path.join(gitDirOf(root), "MERGE_HEAD"))
  await assertUntouched(root, head, ["autostash"])
})

test("a checkout with no marker at all is not repaired", async () => {
  const root = await mkTempRoot("desk-stale-autostash-plain-")
  git(root, ["init", "-q"])
  assert.equal(await repairStaleAutostashRebase({ root }), null)
  assert.equal(await repairStaleAutostashRebase({ root: path.join(root, "missing") }), null)
})

// A `spawnGit` that answers the git calls `intercept` returns a result for, and runs every other call for real.
function scripted(intercept) {
  return (command, args, options) => intercept(args.slice(2)) ?? spawnSync(command, args, options)
}
const failed = { status: 1, stdout: "", stderr: "scripted failure" }
const starts = (args, ...prefix) => prefix.every((word, index) => args[index] === word)

test("each git read the check depends on, failing or answering oddly, leaves the state untouched", async () => {
  const cases = [
    ["git directory unreadable", (args) => starts(args, "rev-parse", "--git-dir") ? failed : undefined],
    ["git directory empty", (args) => starts(args, "rev-parse", "--git-dir") ? { status: 0, stdout: "\n" } : undefined],
    ["git directory output missing", (args) => starts(args, "rev-parse", "--git-dir") ? { status: 0, stdout: undefined } : undefined],
    ["autostash paths unreadable", (args) => starts(args, "diff", "--name-only", "-z", "--no-renames") ? failed : undefined],
    ["unmerged paths unreadable", (args) => args.includes("--diff-filter=U") ? failed : undefined],
    ["no unmerged path", (args) => args.includes("--diff-filter=U") ? { status: 0, stdout: "" } : undefined],
    ["status unreadable", (args) => starts(args, "status") ? failed : undefined],
    ["a rename outside the autostash", (args) => starts(args, "status") ? { status: 0, stdout: "R  moved.md\0notes.md\0UU seed.md\0" } : undefined],
    ["a rename entry cut short", (args) => starts(args, "status") ? { status: 0, stdout: "UU seed.md\0C  copied.md\0" } : undefined],
    ["unmerged path not in HEAD", (args) => starts(args, "cat-file", "-e", "HEAD:seed.md") ? failed : undefined],
    ["stash list unreadable", (args) => starts(args, "stash", "list") ? failed : undefined],
  ]
  for (const [name, intercept] of cases) {
    const { root } = await mkStuckFixture()
    const head = git(root, ["rev-parse", "HEAD"]).trim()
    assert.equal(await repairStaleAutostashRebase({ root, spawnGit: scripted(intercept) }), null, name)
    await assertUntouched(root, head, ["autostash"])
  }
})

test("a detached HEAD, or an autostash marker that is not a file, is left untouched", async () => {
  const detached = await mkStuckFixture()
  const head = git(detached.root, ["rev-parse", "HEAD"]).trim()
  git(detached.root, ["update-ref", "--no-deref", "HEAD", head])
  assert.equal(await repairStaleAutostashRebase({ root: detached.root }), null)
  await assertUntouched(detached.root, head, ["autostash"])

  const directory = await mkStuckFixture()
  const marker = markerOf(directory.root)
  await fs.unlink(path.join(marker, "autostash"))
  await fs.mkdir(path.join(marker, "autostash"))
  assert.equal(await repairStaleAutostashRebase({ root: directory.root }), null)
  assert.deepEqual(await fs.readdir(marker), ["autostash"])
})

test("a store that fails, or a stash entry that cannot be found after it, stops the repair before any file changes", async () => {
  for (const intercept of [
    (args) => starts(args, "stash", "store") ? failed : undefined,
    (args) => starts(args, "stash", "store") ? { status: 0, stdout: "" } : undefined,
  ]) {
    const { root } = await mkStuckFixture()
    const head = git(root, ["rev-parse", "HEAD"]).trim()
    assert.equal(await repairStaleAutostashRebase({ root, spawnGit: scripted(intercept) }), null)
    await assertUntouched(root, head, ["autostash"])
  }
})

test("a checkout or quit that fails leaves the marker for a later sync, with the local change already kept", async () => {
  const checkout = await mkStuckFixture()
  assert.equal(await repairStaleAutostashRebase({ root: checkout.root, spawnGit: scripted((args) => args.includes("checkout") ? failed : undefined) }), null)
  assert.deepEqual(await fs.readdir(markerOf(checkout.root)), ["autostash"])
  assert.deepEqual(stashCommits(checkout.root), [checkout.autostash])
  // The next sync recognises the same state, and keeps the change once, not twice.
  assert.equal((await repairStaleAutostashRebase({ root: checkout.root })).stash, "stash@{0}")
  assert.deepEqual(stashCommits(checkout.root), [checkout.autostash])

  const quit = await mkStuckFixture()
  assert.equal(await repairStaleAutostashRebase({ root: quit.root, spawnGit: scripted((args) => starts(args, "rebase", "--quit") ? failed : undefined) }), null)
  assert.equal(await read(path.dirname(markerOf(quit.root)), "rebase-merge/autostash"), `${quit.autostash}\n`, "the marker is put back as it was")
  assert.deepEqual(unmergedOf(quit.root), [], "its checkout had already run")
  assert.deepEqual(await repairStaleAutostashRebase({ root: quit.root }), { stash: "stash@{0}", commit: quit.autostash, paths: [] })
  assert.equal(await exists(markerOf(quit.root)), false)
  assert.deepEqual(stashCommits(quit.root), [quit.autostash])

  // A quit that did its work but reported failure: nothing to put back.
  const reported = await mkStuckFixture()
  const quitThenFail = (command, args, options) => {
    const result = spawnSync(command, args, options)
    return starts(args.slice(2), "rebase", "--quit") ? { ...result, status: 1 } : result
  }
  assert.equal(await repairStaleAutostashRebase({ root: reported.root, spawnGit: quitThenFail }), null)
  assert.equal(await exists(markerOf(reported.root)), false)
  assert.deepEqual(stashCommits(reported.root), [reported.autostash])
})

test("a git call that throws never escapes the repair", async () => {
  const { root } = await mkStuckFixture()
  assert.equal(await repairStaleAutostashRebase({ root, spawnGit: () => { throw new Error("spawn failed") } }), null)
  assert.deepEqual(await fs.readdir(markerOf(root)), ["autostash"])
})

test("the CLI says what it repaired in one sentence", async () => {
  const written = []
  const io = { stdout: { write: (text) => written.push(text) }, stderr: { write: (text) => written.push(text) } }
  const repaired = { state: "synced", repaired: STALE_AUTOSTASH_REBASE, repairedStash: "stash@{0}", repairedCommit: "a".repeat(40), repairedNote: staleAutostashSentence({ stash: "stash@{0}", commit: "a".repeat(40) }) }
  assert.equal(await runSessionSyncCli({ argv: ["--root", "/desk"], env: {}, io, syncFn: async () => repaired }), 0)
  assert.deepEqual(written, ["session-sync: An earlier pull had stopped before finishing; the local change it held is kept as stash@{0} (commit aaaaaaaaaaaa).\n"])
})
