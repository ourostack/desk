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

test("the undo of a tidy commits through the same call", async () => {
  const root = await makeDesk()
  await stageTidy(root)
  const paths = ["old-track/job/task.md", "new-track/job/task.md", "_meta/organization.json"]
  await save(root, { paths, message: "Move one task", tidy: true })
  const tidySha = git(root, ["rev-parse", "HEAD"]).stdout.trim()
  git(root, ["revert", "--no-commit", tidySha])
  git(root, ["checkout", tidySha, "--", "_meta/organization.json"]) // the record is restored, as the migration says
  const result = await save(root, { paths, message: "Undo the tidy", tidy: true })
  assert.equal(result.status, "committed")
  assert.match(subject(root), /Undo the tidy\n\nDesk-Tidy: true/u)
  const stat = await fs.stat(path.join(root, "old-track", "job", "task.md"))
  assert.ok(stat.isFile())
  assert.equal(git(root, ["status", "--short"]).stdout, "")
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
  assert.equal((await run(failing("add"))).commit.status, "failed")
  assert.match((await run(failing("diff", "--cached"))).commit.reason, /list the staged changes/u)
  assert.match((await run(failing("ls-files", "-s"))).commit.reason, /read the index/u)
  assert.equal((await run(failing("read-tree"))).commit.reason, "read-tree failed")
  assert.equal((await run(failing("update-index"))).commit.reason, "update-index failed")
  assert.equal((await run(failing("commit"))).commit.reason, "commit failed")
  const slow = (cmd, args, options) => (args[2] === "commit" ? { status: null, stdout: "", stderr: "", error: Object.assign(new Error("slow"), { code: "ETIMEDOUT" }) } : spawnSync(cmd, args, options))
  assert.equal((await run(slow)).commit.reason, "timeout")
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
