import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { mkTempDeskRoot } from "./_helpers.js"

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

async function fixture(t) {
  const root = await mkTempDeskRoot()
  t.diagnostic(`Owned fixture: ${root}; removed by the exact-root registry at file teardown.`)
  git(root, "init", "-q")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  await fs.writeFile(path.join(root, "notes.md"), "before\n", { mode: 0o755 })
  git(root, "add", "--", "notes.md")
  git(root, "commit", "-qm", "seed")
  await fs.writeFile(path.join(root, "unrelated.md"), "outside staged bytes\n")
  git(root, "add", "--", "unrelated.md")
  return { root, head: git(root, "rev-parse", "HEAD"), index: git(root, "ls-files", "-s") }
}

for (const observation of ["repository", "unstaged", "staged"]) test(`a failed ${observation} observation is not an unchanged save`, async t => {
  const f = await fixture(t)
  if (observation === "staged") {
    await fs.writeFile(path.join(f.root, "notes.md"), "pending\n")
    git(f.root, "add", "--", "notes.md")
  }
  const index = git(f.root, "ls-files", "-s")
  let mutations = 0
  const result = await desk_save({
    deskRoot: f.root, input: { paths: ["notes.md"], message: "save" },
    schedulePush: () => assert.fail("failed inspection must not schedule delivery"),
    spawnGit(command, args, options) {
      if (["add", "commit"].includes(args[2])) mutations++
      const fail = observation === "repository" ? args.includes("--is-inside-work-tree")
        : observation === "unstaged" ? args[2] === "diff" && !args.includes("--cached")
        : args.includes("--cached")
      return fail
        ? { status: 128, stdout: "", stderr: `owned ${observation} observation failure` }
        : spawnSync(command, args, options)
    },
  })
  assert.equal(result.status, "failed")
  assert.equal(result.commit.status, "failed")
  assert.equal(mutations, 0)
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), index)
})

for (const kind of ["error", "object", "frozen error"]) test(`a later file failure from an ${kind} reports completed and uncertain writes without rollback`, async t => {
  const f = await fixture(t)
  const open = fs.open
  const failure = kind === "object" ? { message: "owned later open failure", code: "EIO", mutation: { operation: "owned open" } }
    : Object.assign(new Error("owned later open failure"), { code: "EIO", mutation: { operation: "owned open" } })
  if (kind === "frozen error") Object.freeze(failure)
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file === path.join(f.root, "later.md")) throw failure
    return open(file, ...args)
  })
  await assert.rejects(desk_save({
    deskRoot: f.root,
    input: { files: [{ path: "notes.md", content: "applied\n" }, { path: "later.md", content: "later\n" }], message: "save" },
    schedulePush: () => assert.fail("partial write must not push"),
  }), error => {
    assert.equal(error.mutation?.status, "partial")
    assert.deepEqual(error.mutation.applied_paths, ["notes.md"])
    assert.deepEqual(error.mutation.uncertain_paths, ["later.md"])
    assert.equal(error.mutation.readback_required, true)
    assert.equal(error.mutation.operation, "owned open")
    assert.equal(error.cause, failure)
    assert.equal(error.code, "EIO")
    return true
  })
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "applied\n")
  assert.equal((await fs.stat(path.join(f.root, "notes.md"))).mode & 0o777, 0o755)
  await assert.rejects(fs.stat(path.join(f.root, "later.md")), { code: "ENOENT" })
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), f.index)
})

test("failed Git inspection after successful file writes reports applied bytes separately", async t => {
  const f = await fixture(t)
  const result = await desk_save({
    deskRoot: f.root, input: { files: [{ path: "notes.md", content: "written\n" }], message: "save" },
    schedulePush: () => assert.fail("failed inspection must not push"),
    spawnGit: () => ({ status: null, stdout: "", stderr: "owned repository observation failure" }),
  })
  assert.equal(result.status, "failed")
  assert.deepEqual(result.effects, { status: "partial", applied_paths: ["notes.md"], readback_required: true })
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "written\n")
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), f.index)
})

test("a later rename refusal retains writes completed before staging and refusal", async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, "old.md"), "move\n")
  git(f.root, "add", "old.md")
  git(f.root, "commit", "-qm", "seed move", "--", "old.md")
  const before = git(f.root, "rev-parse", "HEAD")
  const unrelated = git(f.root, "ls-files", "-s", "--", "unrelated.md")
  git(f.root, "mv", "old.md", "new.md")
  await assert.rejects(desk_save({
    deskRoot: f.root, input: { paths: ["new.md"], files: [{ path: "notes.md", content: "applied\n" }], message: "save" },
    schedulePush: () => assert.fail("a refused incomplete move must not push"),
  }), error => {
    assert.match(error.message, /add old\.md/u)
    assert.deepEqual(error.mutation, { status: "partial", applied_paths: ["notes.md"], readback_required: true })
    return true
  })
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "applied\n")
  assert.equal(git(f.root, "show", ":notes.md"), "applied\n")
  assert.equal(git(f.root, "rev-parse", "HEAD"), before)
  assert.equal(git(f.root, "ls-files", "-s", "--", "unrelated.md"), unrelated)
})

for (const kind of ["error", "object", "frozen error"]) test(`completed file writes preserve a later ${kind} exception receipt`, async t => {
  const f = await fixture(t)
  const mutation = {
    status: "unknown", uncertain_paths: ["notes.md"], operation: "owned stage",
    readback: { head_before: f.head.trim(), head_after: null, attribution: "unverified" },
  }
  const failure = kind === "object" ? { message: "owned stage response lost", mutation }
    : Object.assign(new Error("owned stage response lost"), { mutation })
  if (kind === "frozen error") Object.freeze(failure)
  await assert.rejects(desk_save({
    deskRoot: f.root, input: { files: [{ path: "notes.md", content: "applied\n" }], message: "save" },
    schedulePush: () => assert.fail("uncertain staging must not push"),
    spawnGit(command, args, options) {
      const result = spawnSync(command, args, options)
      if (args[2] === "add") throw failure
      return result
    },
  }), error => {
    assert.equal(error.message, "owned stage response lost")
    assert.equal(error.cause, failure)
    assert.deepEqual(error.mutation, { ...mutation, status: "partial", applied_paths: ["notes.md"], readback_required: true })
    return true
  })
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "applied\n")
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
})

for (const applied of [false, true]) test(`a lost commit response retains the ${applied ? "applied" : "unapplied"} effect until destination readback`, async t => {
  const f = await fixture(t)
  const beforeUnrelated = git(f.root, "ls-files", "-s", "--", "unrelated.md")
  let dispatches = 0
  const result = await desk_save({
    deskRoot: f.root, input: { files: [{ path: "notes.md", content: "after\n" }], message: "save" },
    schedulePush: () => assert.fail("uncertain commit must not schedule delivery"),
    spawnGit(command, args, options) {
      if (args[2] !== "commit") return spawnSync(command, args, options)
      dispatches++
      if (applied) {
        const actual = spawnSync(command, args, options)
        assert.equal(actual.status, 0, actual.stderr)
      }
      return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("lost response"), { code: "ETIMEDOUT" }) }
    },
  })
  assert.equal(result.status, "failed")
  assert.equal(result.commit.reason, "timeout")
  assert.equal(dispatches, 1)
  const observed = git(f.root, "rev-parse", "HEAD").trim()
  assert.equal(observed === f.head.trim(), !applied)
  assert.deepEqual(result.commit.effects, {
    status: "unknown", readback_required: true,
    readback: { head_before: f.head.trim(), head_after: observed, attribution: "unverified" },
  })
  assert.equal(git(f.root, "ls-files", "-s", "--", "unrelated.md"), beforeUnrelated)
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "after\n")
  if (applied) {
    assert.equal(git(f.root, "show", "HEAD:notes.md"), "after\n")
    assert.equal(git(f.root, "show", "--format=", "--name-only", "HEAD"), "notes.md\n")
  }
  const recovered = await desk_save({ deskRoot: f.root, input: { paths: ["notes.md"], message: "save" }, schedulePush: () => {} })
  assert.equal(recovered.status, applied ? "nothing_to_commit" : "committed")
  assert.equal(git(f.root, "rev-list", "--count", "HEAD").trim(), "2")
  assert.equal(git(f.root, "ls-files", "-s", "--", "unrelated.md"), beforeUnrelated)
})
