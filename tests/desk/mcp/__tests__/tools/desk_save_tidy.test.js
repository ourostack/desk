// desk_save with tidy: true commits a desk tidy (moved task cards and the record) and its undo, through Desk's own commit path.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { stagedChanges } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { ensureCardGuard } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { assertRoute } from "./_route_around.js"
import { beforeLanding } from "../_index_commit_seam.js"

const CARD = "---\ntitle: One\nstatus: active\n---\nBody of the card.\n"

function git(root, args, { allowFail = false } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  if (!allowFail) assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result
}

async function makeDesk() {
  const root = await mkTempDeskRoot()
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "t@example.com"])
  git(root, ["config", "user.name", "T"])
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await fs.mkdir(path.join(root, "old-track", "job"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", ".keep"), "")
  await fs.writeFile(path.join(root, "_archive", ".keep"), "")
  await fs.writeFile(path.join(root, "old-track", "job", "task.md"), CARD)
  await fs.writeFile(path.join(root, "other.md"), "other\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "seed"])
  ensureCardGuard(root)
  return root
}

const save = (root, input) => desk_save({ deskRoot: root, input, schedulePush: () => {} })
const subject = (root) => git(root, ["log", "-1", "--format=%B"]).stdout

async function stageTidy(root) {
  await fs.mkdir(path.join(root, "new-track"), { recursive: true })
  git(root, ["mv", "old-track/job", "new-track/job"])
  await fs.writeFile(path.join(root, "_meta", "organization.json"), "{}\n")
}

test("desk_save tidy commits a moved card with the record and the trailer", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  const paths = ["old-track/job/task.md", "new-track/job/task.md", "_meta/organization.json"]
  const result = await save(root, { paths, message: "Move one task", tidy: true })
  assert.equal(result.status, "committed")
  assert.match(subject(root), /^Move one task\n\nDesk-Tidy: true\n*$/u)
  const files = git(root, ["show", "--name-status", "--format=", "-M", "HEAD"]).stdout
  assert.match(files, /R100\told-track\/job\/task\.md\tnew-track\/job\/task\.md/u)
  assert.match(files, /A\t_meta\/organization\.json/u)
  assert.equal(git(root, ["status", "--short"]).stdout, "")
})

// The Agency dry run of 2026-10-12: a tidy moved a track card and a loose file with git mv and wrote the record. The old side of each
// move is neither on disk nor in the index, and `git add` refuses such a path, so the tidy's own commit failed with "pathspec did not match".
test("a tidy that moved files other than task cards commits them with the untracked record", async () => {
  const root = await makeDesk()
  await fs.writeFile(path.join(root, "old-track", "track.md"), "# old-track\n")
  await fs.writeFile(path.join(root, "status-notes.md"), "notes\n")
  git(root, ["add", "--", "old-track/track.md", "status-notes.md"])
  git(root, ["commit", "-q", "-m", "a track card and a loose file"])
  await fs.mkdir(path.join(root, "_archive", "old-track"), { recursive: true })
  git(root, ["mv", "old-track/track.md", "_archive/old-track/track.md"])
  git(root, ["mv", "status-notes.md", "_meta/status-notes.md"])
  await fs.writeFile(path.join(root, "_meta", "organization.json"), "{}\n")
  // A file the tidy fixed by hand and did not stage is still staged here.
  await fs.writeFile(path.join(root, "other.md"), "fixed by the tidy\n")
  const paths = ["old-track/track.md", "_archive/old-track/track.md", "status-notes.md", "_meta/status-notes.md", "_meta/organization.json", "other.md"]
  const result = await save(root, { paths, message: "File the notes and archive the old track", tidy: true })
  assert.deepEqual(result, { status: "committed" })
  const files = git(root, ["show", "--name-status", "--format=", "-M", "HEAD"]).stdout
  assert.match(files, /R100\told-track\/track\.md\t_archive\/old-track\/track\.md/u)
  assert.match(files, /R100\tstatus-notes\.md\t_meta\/status-notes\.md/u)
  assert.match(files, /A\t_meta\/organization\.json/u)
  assert.match(files, /M\tother\.md/u)
  assert.equal(git(root, ["status", "--short"]).stdout, "")
})

test("the trailer is not added twice", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  await save(root, { paths: ["old-track/job/task.md", "new-track/job/task.md", "_meta/organization.json"], message: "Move\n\nDesk-Tidy: true\n", tidy: true })
  assert.equal(subject(root).match(/Desk-Tidy: true/gu).length, 1)
})

test("a path outside the desk is refused, tidy or not", async () => {
  const root = await makeDesk()
  await assert.rejects(save(root, { paths: ["../outside.md"], message: "m", tidy: true }), /outside the resolved write prefix/u)
})

test("other staged work stays staged and out of the tidy commit", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  await fs.writeFile(path.join(root, "other.md"), "someone else's change\n")
  git(root, ["add", "other.md"])
  await save(root, { paths: ["old-track/job/task.md", "new-track/job/task.md", "_meta/organization.json"], message: "Move one task", tidy: true })
  assert.equal(git(root, ["diff", "--cached", "--name-only"]).stdout.trim(), "other.md")
  assert.doesNotMatch(git(root, ["show", "--name-only", "--format=", "HEAD"]).stdout, /other\.md/u)
})

test("a card edit cannot ride through tidy: it is refused and nothing is committed", async () => {
  const root = await makeDesk()
  await fs.writeFile(path.join(root, "old-track", "job", "task.md"), CARD.replace("active", "done"))
  git(root, ["add", "old-track/job/task.md"])
  const before = git(root, ["rev-parse", "HEAD"]).stdout
  await assert.rejects(save(root, { paths: ["old-track/job/task.md"], message: "m", tidy: true }), /unstage old-track\/job\/task\.md.*task_update/u)
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout, before)
})

test("an unstaged card edit is never staged by tidy", async () => {
  const root = await makeDesk()
  await fs.writeFile(path.join(root, "old-track", "job", "task.md"), CARD.replace("active", "done"))
  await assert.rejects(save(root, { paths: ["old-track/job/task.md"], message: "m", tidy: true }), /unstaged change, is untracked/u)
  assert.equal(git(root, ["diff", "--cached", "--name-only"]).stdout, "")
})

test("tidy with nothing staged reports nothing_to_commit", async () => {
  const root = await makeDesk()
  assert.equal((await save(root, { paths: ["other.md"], message: "m", tidy: true })).status, "nothing_to_commit")
})

test("a non-git desk reports nothing_to_commit for a tidy", async () => {
  const root = await mkTempDeskRoot()
  assert.equal((await save(root, { paths: ["other.md"], message: "m", tidy: true })).status, "nothing_to_commit")
})

// The undo the tidy migration (02-tidy-desk.md) prescribes, run for real in three cases: one tidy commit reverted cleanly, one
// whose revert conflicts, and a sequence of tidy commits reverted in one call, cleanly and with a conflict. Each runs
// git revert --no-commit, restores the record and calls desk_save, reading Git's own state back at every step rather than assuming
// it (#632: Desk commits nothing while a revert is in progress, or while a path it would commit is in conflict). Another session's
// staged selection, other.md, rides along untouched through every step.
const UNDO_PATHS = ["old-track/job/task.md", "new-track/job/task.md", "_meta/organization.json"]
const staged = (root) => git(root, ["diff", "--cached", "-M", "--name-status"]).stdout
const index = (root) => git(root, ["ls-files", "-s"]).stdout
const head = (root) => git(root, ["rev-parse", "HEAD"]).stdout.trim()
const gitPath = (root, name) => git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]).stdout.trim()

// What Git says is in progress: the revert marker, the sequencer's folder and the paths held in conflict.
async function gitState(root) {
  const exists = (name) => fs.stat(gitPath(root, name)).then(() => true, () => false)
  return { revert: await exists("REVERT_HEAD"), sequence: await exists("sequencer"), unmerged: git(root, ["ls-files", "-u"]).stdout }
}

// Everything a held desk_save must leave exactly as it was.
async function snapshot(root) {
  return { head: head(root), index: index(root), state: await gitState(root), status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout }
}

async function tidyCommit(root, write, paths, message) {
  await write()
  const result = await save(root, { paths, message, tidy: true })
  assert.equal(result.status, "committed")
  return head(root)
}

async function otherSessionStages(root) {
  await fs.writeFile(path.join(root, "other.md"), "staged elsewhere\n")
  git(root, ["add", "other.md"])
}

// The fixed file a tidy changed, edited again by a later commit, so reverting the tidy conflicts on it.
async function laterEdit(root, file) {
  await fs.writeFile(path.join(root, file), "edited after the tidy\n")
  git(root, ["add", file])
  git(root, ["commit", "-q", "-m", "a later edit"])
}

const fixFile = (root, file) => async () => {
  await stageTidy(root)
  await fs.writeFile(path.join(root, file), "fixed by the tidy\n")
}

async function heldUnchanged(root, paths, before, why) {
  const result = await save(root, { paths, message: "Undo the tidy", tidy: true })
  assert.deepEqual(await snapshot(root), before, "a held undo changes nothing: not HEAD, the index, Git's state or the working tree")
  assert.notEqual(result.status, "committed")
  assert.match(result.commit.reason, why)
  return result
}

async function quitKeeps(root) {
  const before = await snapshot(root)
  assert.equal(git(root, ["revert", "--quit"]).status, 0)
  const after = await snapshot(root)
  assert.equal(after.state.revert || after.state.sequence, false, "--quit ends the revert")
  assert.equal(after.head, before.head, "--quit moves nothing")
  assert.equal(after.index, before.index, "--quit keeps the index exactly as the revert left it, conflicts included")
  assert.equal(after.status, before.status)
  return after
}

test("undo case 1: a tidy reverted cleanly holds while the revert is in progress and commits once git revert --quit ends it", async () => {
  const root = await makeDesk()
  const tidySha = await tidyCommit(root, () => stageTidy(root), UNDO_PATHS, "Move one task")
  await otherSessionStages(root)
  assert.equal(git(root, ["revert", "--no-commit", tidySha]).status, 0, "the revert applies without a conflict")
  git(root, ["checkout", tidySha, "--", "_meta/organization.json"]) // the record is restored, as the migration says
  const reverted = await snapshot(root)
  assert.equal(reverted.state.unmerged, "")
  assert.match(staged(root), /^R\d+\tnew-track\/job\/task\.md\told-track\/job\/task\.md$/mu, "the card is staged as a move back")
  // The state Git actually leaves decides what the documented desk_save does: a marked revert holds, an unmarked one commits.
  if (reverted.state.revert || reverted.state.sequence) await heldUnchanged(root, UNDO_PATHS, reverted, /revert is in progress/u)
  await quitKeeps(root)
  const result = await save(root, { paths: UNDO_PATHS, message: "Undo the tidy", tidy: true })
  assert.equal(result.status, "committed")
  assert.match(subject(root), /Undo the tidy\n\nDesk-Tidy: true/u)
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).stdout.trim(), tidySha, "one commit, on the tidy")
  assert.match(git(root, ["show", "--name-status", "--format=", "-M", "HEAD"]).stdout, /^R100\tnew-track\/job\/task\.md\told-track\/job\/task\.md\n$/u, "the undo is the move back, and only that")
  assert.equal(git(root, ["show", "HEAD:old-track/job/task.md"]).stdout, CARD)
  assert.equal(git(root, ["show", `${tidySha}:_meta/organization.json`]).stdout, git(root, ["show", "HEAD:_meta/organization.json"]).stdout, "the record stays")
  assert.equal(git(root, ["status", "--short"]).stdout, "M  other.md\n", "the other staged selection is still staged, and only it")
})

test("undo case 2: a tidy whose revert conflicts holds, before and after git revert --quit, and sweeps nothing into the index", async () => {
  const root = await makeDesk()
  await fs.writeFile(path.join(root, "fixed.md"), "loose\n")
  git(root, ["add", "fixed.md"])
  git(root, ["commit", "-q", "-m", "a file the tidy fixes"])
  const paths = [...UNDO_PATHS, "fixed.md"]
  const tidySha = await tidyCommit(root, fixFile(root, "fixed.md"), paths, "Move one task and fix a file")
  await laterEdit(root, "fixed.md")
  await otherSessionStages(root)
  assert.notEqual(git(root, ["revert", "--no-commit", tidySha], { allowFail: true }).status, 0, "the revert reports the conflict")
  git(root, ["checkout", tidySha, "--", "_meta/organization.json"])
  const conflicted = await snapshot(root)
  assert.match(conflicted.state.unmerged, /\tfixed\.md$/mu, "Git holds the fixed file in conflict")
  assert.match(await fs.readFile(path.join(root, "fixed.md"), "utf8"), /^<<<<<<< /mu)
  await heldUnchanged(root, paths, conflicted, /Git holds fixed\.md in conflict/u)
  // A --quit taken anyway ends the revert but leaves the conflict in the index: desk_save still holds and still stages nothing.
  const quit = await quitKeeps(root)
  assert.equal(quit.state.unmerged, conflicted.state.unmerged)
  await heldUnchanged(root, paths, quit, /Git holds fixed\.md in conflict/u)
  assert.doesNotMatch(git(root, ["log", "--format=%B", "-1"]).stdout, /Undo the tidy/u)
})

test("undo case 3: a sequence of tidy commits reverted in one call holds while in progress and commits once ended", async () => {
  const root = await makeDesk()
  const first = await tidyCommit(root, () => stageTidy(root), UNDO_PATHS, "Move one task")
  await fs.writeFile(path.join(root, "fixed.md"), "loose\n")
  git(root, ["add", "fixed.md"])
  git(root, ["commit", "-q", "-m", "a file the tidy fixes"])
  const second = await tidyCommit(root, async () => { await fs.writeFile(path.join(root, "fixed.md"), "fixed by the tidy\n"); await fs.writeFile(path.join(root, "_meta", "organization.json"), "{\"second\":true}\n") }, ["fixed.md", "_meta/organization.json"], "Fix a file")
  await otherSessionStages(root)
  assert.equal(git(root, ["revert", "--no-commit", second, first]).status, 0, "both reverts apply without a conflict")
  git(root, ["checkout", second, "--", "_meta/organization.json"])
  const paths = [...UNDO_PATHS, "fixed.md"]
  const reverted = await snapshot(root)
  assert.equal(reverted.state.unmerged, "")
  if (reverted.state.revert || reverted.state.sequence) await heldUnchanged(root, paths, reverted, /(revert|sequence) is in progress/u)
  await quitKeeps(root)
  const result = await save(root, { paths, message: "Undo the tidy", tidy: true })
  assert.equal(result.status, "committed")
  assert.equal(git(root, ["rev-parse", "HEAD~1"]).stdout.trim(), second, "one commit, on the last tidy")
  assert.equal(git(root, ["show", "HEAD:old-track/job/task.md"]).stdout, CARD)
  assert.equal(git(root, ["show", "HEAD:fixed.md"]).stdout, "loose\n")
  assert.equal(git(root, ["status", "--short"]).stdout, "M  other.md\n", "the other staged selection is still staged, and only it")
})

test("undo case 3, conflicted: a sequence whose revert stops on a conflict holds, before and after git revert --quit", async () => {
  const root = await makeDesk()
  await fs.writeFile(path.join(root, "fixed.md"), "loose\n")
  git(root, ["add", "fixed.md"])
  git(root, ["commit", "-q", "-m", "a file the tidy fixes"])
  const first = await tidyCommit(root, async () => { await fs.writeFile(path.join(root, "fixed.md"), "fixed by the tidy\n"); await fs.writeFile(path.join(root, "_meta", "organization.json"), "{}\n") }, ["fixed.md", "_meta/organization.json"], "Fix a file")
  const second = await tidyCommit(root, async () => { await fs.mkdir(path.join(root, "new-track"), { recursive: true }); git(root, ["mv", "old-track/job", "new-track/job"]) }, ["old-track/job/task.md", "new-track/job/task.md"], "Move one task")
  await laterEdit(root, "fixed.md")
  await otherSessionStages(root)
  assert.notEqual(git(root, ["revert", "--no-commit", second, first], { allowFail: true }).status, 0, "the sequence stops on the conflict")
  git(root, ["checkout", second, "--", "_meta/organization.json"])
  const paths = [...UNDO_PATHS, "fixed.md"]
  const stopped = await snapshot(root)
  assert.match(stopped.state.unmerged, /\tfixed\.md$/mu)
  await heldUnchanged(root, paths, stopped, /Git holds fixed\.md in conflict/u)
  const quit = await quitKeeps(root)
  assert.equal(quit.state.unmerged, stopped.state.unmerged)
  await heldUnchanged(root, paths, quit, /Git holds fixed\.md in conflict/u)
})

const TIDY_PATHS = ["old-track/job/task.md", "new-track/job/task.md", "_meta/organization.json"]

test("an edit made after the move, still unstaged, never lands in the tidy commit (a)", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  await fs.appendFile(path.join(root, "new-track", "job", "task.md"), "rewritten after the move\n")
  const before = git(root, ["rev-parse", "HEAD"]).stdout
  await assert.rejects(save(root, { paths: TIDY_PATHS, message: "m", tidy: true }), /unstaged change, is untracked/u)
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout, before)
})

test("a card deleted and recreated unstaged is refused (b)", async () => {
  const root = await makeDesk()
  git(root, ["rm", "-q", "old-track/job/task.md"])
  await fs.mkdir(path.join(root, "old-track", "job"), { recursive: true })
  await fs.writeFile(path.join(root, "old-track", "job", "task.md"), CARD.replace("active", "done"))
  const before = git(root, ["rev-parse", "HEAD"]).stdout
  await assert.rejects(save(root, { paths: ["old-track/job/task.md"], message: "m", tidy: true }), /unstaged change, is untracked/u)
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout, before)
})

test("a link at a card path is refused, unstaged or staged (c)", async () => {
  const root = await makeDesk()
  git(root, ["rm", "-q", "old-track/job/task.md"])
  await fs.mkdir(path.join(root, "old-track", "job"), { recursive: true })
  await fs.symlink("/etc/hosts", path.join(root, "old-track", "job", "task.md"))
  await assert.rejects(save(root, { paths: ["old-track/job/task.md"], message: "m", tidy: true }), /unstaged change, is untracked/u)
  git(root, ["add", "old-track/job/task.md"])
  const before = git(root, ["rev-parse", "HEAD"]).stdout
  await assert.rejects(save(root, { paths: ["old-track/job/task.md"], message: "m", tidy: true }), /unstage old-track\/job\/task\.md|not a regular file/u)
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout, before)
})

test("a tracked link moved to a new card path is refused as not a regular file", async () => {
  const root = await makeDesk()
  await fs.mkdir(path.join(root, "link-track", "job"), { recursive: true })
  await fs.symlink("/etc/hosts", path.join(root, "link-track", "job", "task.md"))
  git(root, ["add", "link-track/job/task.md"])
  git(root, ["commit", "-q", "-m", "a link as a card"])
  await fs.mkdir(path.join(root, "moved-track"), { recursive: true })
  git(root, ["mv", "link-track/job", "moved-track/job"])
  const before = git(root, ["rev-parse", "HEAD"]).stdout
  await assert.rejects(save(root, { paths: ["link-track/job/task.md", "moved-track/job/task.md"], message: "m", tidy: true }), /not a regular file/u)
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout, before)
})

test("a link staged as a moved card path is refused as not a regular file", async () => {
  const root = await makeDesk()
  await fs.mkdir(path.join(root, "link-track", "job"), { recursive: true })
  await fs.symlink("/etc/hosts", path.join(root, "link-track", "job", "task.md"))
  git(root, ["add", "link-track/job/task.md"])
  // Staged as an add the status is A, so the card check refuses it first; the mode check backs it for any status that slips past.
  await assert.rejects(save(root, { paths: ["link-track/job/task.md"], message: "m", tidy: true }), /unstage link-track\/job\/task\.md/u)
})

test("a folder or a pattern is refused before anything is staged", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  await fs.appendFile(path.join(root, "new-track", "job", "task.md"), "edit\n")
  await assert.rejects(save(root, { paths: ["new-track"], message: "m", tidy: true }), /replace new-track with the file paths/u)
  await assert.rejects(save(root, { paths: ["new-track/*/task.md"], message: "m", tidy: true }), /never a folder or a pattern/u)
  assert.equal(git(root, ["diff", "--cached", "--name-only"]).stdout.includes("new-track/job/task.md"), true)
  assert.match(git(root, ["status", "--short"]).stdout, /^RM /mu, "the unstaged edit is still unstaged")
})

test("a move needs both halves in paths, and the refusal names the missing one", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  await assert.rejects(save(root, { paths: ["new-track/job/task.md"], message: "m", tidy: true }), /add old-track\/job\/task\.md to `paths`/u)
  await assert.rejects(save(root, { paths: ["old-track/job/task.md"], message: "m", tidy: true }), /add new-track\/job\/task\.md to `paths`/u)
})

test("a tidy on a desk with no commit yet commits through an empty temporary index", async () => {
  const root = await mkTempDeskRoot()
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "t@example.com"])
  git(root, ["config", "user.name", "T"])
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "organization.json"), "{}\n")
  assert.equal((await save(root, { paths: ["_meta/organization.json"], message: "first", tidy: true })).status, "committed")
  assert.equal(git(root, ["log", "--format=%s"]).stdout.trim(), "first")
})

// A spawn that behaves as git does except that one git subcommand (optionally only when its arguments carry `needle`) fails.
const failing = (sub, needle) => (cmd, args, options) =>
  args[2] === sub && (needle === undefined || args.includes(needle)) ? { status: 1, stdout: "", stderr: `${sub} failed`, error: undefined } : spawnSync(cmd, args, options)

test("git failures are reported, not thrown", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  const run = (spawnGit) => desk_save({ deskRoot: root, input: { paths: TIDY_PATHS, message: "m", tidy: true }, spawnGit, schedulePush: () => {} })
  // Each failure also carries the route that finishes the tidy commit by hand (#623).
  const routed = async (spawnGit) => {
    const { commit } = await run(spawnGit)
    assertRoute(commit.route_around)
    return commit
  }
  assert.equal((await routed(failing("add"))).status, "failed")
  assert.match((await routed(failing("diff", "--cached"))).reason, /list the staged changes/u)
  assert.match((await routed(failing("ls-files", "-s"))).reason, /read the index/u)
  // Since #632 the tidy commit is hooks, `git commit-tree` and one compare-and-swap `git update-ref`, never a `git commit`; each
  // failure says which step failed and why.
  assert.match((await routed(failing("read-tree"))).reason, /git read-tree failed: read-tree failed/u)
  assert.match((await routed(failing("update-index"))).reason, /building the private index failed: update-index failed/u)
  const refused = (cmd, args, options) => (beforeLanding(args) ? { status: 1, stdout: "", stderr: "commit failed", error: undefined } : spawnSync(cmd, args, options))
  assert.match((await routed(refused)).reason, /pre-commit hook refused the commit: commit failed/u)
  const slow = (cmd, args, options) => (beforeLanding(args) ? { status: null, stdout: "", stderr: "", error: Object.assign(new Error("slow"), { code: "ETIMEDOUT" }) } : spawnSync(cmd, args, options))
  const timedOut = await routed(slow)
  assert.match(timedOut.reason, /pre-commit hook was cut off/u)
  assert.equal(timedOut.status, "failed", "a timed-out tidy commit that left HEAD where it was is read back as not landed")
})

test("the temporary index leaves the real index and the working tree alone", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  await fs.writeFile(path.join(root, "other.md"), "staged elsewhere\n")
  git(root, ["add", "other.md"])
  await fs.writeFile(path.join(root, "other.md"), "and edited again\n")
  await save(root, { paths: TIDY_PATHS, message: "m", tidy: true })
  assert.match(git(root, ["status", "--short"]).stdout, /^MM other\.md$/mu)
})

test("stagedChanges parses renames, deletes and a failing git", () => {
  const spawn = (stdout, status = 0) => () => ({ status, stdout, stderr: "" })
  assert.deepEqual(stagedChanges("/r", ["a"], spawn("R100\0a\0b\0D\0c\0")), [{ status: "R100", paths: ["a", "b"] }, { status: "D", paths: ["c"] }])
  assert.deepEqual(stagedChanges("/r", ["a"], spawn("")), [])
  assert.equal(stagedChanges("/r", ["a"], spawn("", 1)), null)
})
