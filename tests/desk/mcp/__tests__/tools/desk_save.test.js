// desk_save — commits files written directly with Write/Edit, not through a
// structured Desk tool.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { mkTempDeskRoot } from "./_helpers.js"

function initGit(root) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  }
  run(["init", "-q"])
  run(["config", "user.email", "test@example.com"])
  run(["config", "user.name", "Test"])
}

function gitStatus(root) {
  const result = spawnSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function lastCommitMessage(root) {
  const result = spawnSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function lastCommitFiles(root) {
  const result = spawnSync("git", ["-C", root, "show", "--stat", "--format=", "--name-only", "HEAD"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split("\n").filter(Boolean).sort()
}

function commitCount(root) {
  const result = spawnSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" })
  if (result.status !== 0) return 0 // no commits yet at all
  return result.stdout.trim() === "" ? 0 : result.stdout.trim().split("\n").length
}

test("desk_save stages and commits exactly the given path", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save planning notes" },
    schedulePush: () => {},
  })

  assert.equal(result.status, "committed")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "save planning notes")
  assert.deepEqual(lastCommitFiles(root), ["notes.md"])
})

test("desk_save commits several paths together as one commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "planning"), { recursive: true })
  await fs.writeFile(path.join(root, "planning", "spec.md"), "Spec.\n", "utf8")
  await fs.writeFile(path.join(root, "planning", "plan.md"), "Plan.\n", "utf8")

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["planning/spec.md", "planning/plan.md"], message: "save spec and plan" },
    schedulePush: () => {},
  })

  assert.equal(result.status, "committed")
  assert.equal(commitCount(root), 1)
  assert.deepEqual(
    lastCommitFiles(root),
    ["planning/plan.md", "planning/spec.md"],
  )
})

test("desk_save reports nothing_to_commit for a path that was never written, and creates no commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "seed.md"), "seed\n", "utf8")
  await spawnSync("git", ["-C", root, "add", "--", "seed.md"], { encoding: "utf8" })
  await spawnSync("git", ["-C", root, "commit", "-q", "-m", "seed"], { encoding: "utf8" })
  const before = commitCount(root)
  const calls = []
  const schedulePush = (opts) => calls.push(opts)

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["never-written.md"], message: "save nothing" },
    schedulePush,
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.equal(result.commit, undefined)
  assert.equal(commitCount(root), before, "no empty commit was created")
  assert.equal(gitStatus(root), "")
  assert.equal(calls.length, 0, "schedulePush is never called when there is nothing to commit")
})

test("desk_save reports nothing_to_commit for a path that is already committed and unchanged", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  await desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: "save notes" }, schedulePush: () => {} })
  const before = commitCount(root)

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes again" },
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.equal(commitCount(root), before, "no empty commit was created")
})

test("desk_save refuses a path outside the resolved --person write prefix", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "desks", "bob"), { recursive: true })
  await fs.writeFile(path.join(root, "desks", "bob", "x.md"), "bob's file\n", "utf8")

  await assert.rejects(
    () => desk_save({
      deskRoot: root,
      person: "alex",
      input: { paths: ["desks/bob/x.md"], message: "m" },
    }),
    /outside the resolved write prefix/,
  )
  assert.equal(gitStatus(root).trim(), "?? desks/", "nothing was staged or committed by the refused call")
})

test("desk_save commits a path inside the resolved --person write prefix", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "desks", "alex"), { recursive: true })
  await fs.writeFile(path.join(root, "desks", "alex", "notes.md"), "alex's notes\n", "utf8")

  const result = await desk_save({
    deskRoot: root,
    person: "alex",
    input: { paths: ["desks/alex/notes.md"], message: "save alex's notes" },
    schedulePush: () => {},
  })

  assert.equal(result.status, "committed")
  assert.deepEqual(lastCommitFiles(root), ["desks/alex/notes.md"])
})

test("desk_save commits only its own paths, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")

  // Simulates another process staging an unrelated path in the window
  // between desk_save's own check and its stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
    schedulePush: () => {},
  })

  assert.equal(result.status, "committed")
  assert.deepEqual(lastCommitFiles(root), ["notes.md"])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

// https://github.com/ourostack/desk/issues/414: a deletion or rename already staged with `git rm` or `git mv` was "nothing to commit".
test("desk_save commits a staged deletion and a staged rename at listed paths", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const git = (args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  }
  for (const name of ["gone.md", "old.md", "edited.md", "other.md"]) await fs.writeFile(path.join(root, name), `${name}\n`, "utf8")
  git(["add", "--", "gone.md", "old.md", "edited.md", "other.md"])
  git(["commit", "-q", "-m", "seed"])
  git(["rm", "-q", "--", "gone.md"])
  git(["mv", "old.md", "new.md"])
  await fs.writeFile(path.join(root, "edited.md"), "edited\n", "utf8")
  // Another session's staged work, at a path this call does not list.
  await fs.writeFile(path.join(root, "other.md"), "another session\n", "utf8")
  git(["add", "--", "other.md"])

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["gone.md", "old.md", "new.md", "edited.md"], message: "remove and rename" },
    schedulePush: () => {},
  })

  assert.equal(result.status, "committed", JSON.stringify(result))
  const shown = spawnSync("git", ["-C", root, "show", "--name-status", "--no-renames", "--format=", "HEAD"], { encoding: "utf8" })
  assert.deepEqual(shown.stdout.trim().split("\n").sort(), ["A\tnew.md", "D\tgone.md", "D\told.md", "M\tedited.md"])
  assert.equal(gitStatus(root), "M  other.md\n", "the path the call did not list stays staged")

  // Only a staged change at the listed paths, with nothing unstaged anywhere among them.
  git(["rm", "-q", "--", "edited.md"])
  const deletion = await desk_save({ deskRoot: root, input: { paths: ["edited.md"], message: "remove edited" }, schedulePush: () => {} })
  assert.equal(deletion.status, "committed", JSON.stringify(deletion))
  assert.deepEqual(lastCommitFiles(root), ["edited.md"])
})

// A staged rename committed by one side only either keeps both files (new name listed) or deletes the file on the remote while
// its content stays behind, staged and unpushed (old name listed). Like a tidy, desk_save refuses and names the other side.
for (const [listed, missing] of [["new.md", "old.md"], ["old.md", "new.md"]]) {
  test(`desk_save refuses a staged rename when only ${listed} is listed, and names ${missing}`, async () => {
    const root = await mkTempDeskRoot()
    initGit(root)
    await fs.writeFile(path.join(root, "old.md"), "content\n", "utf8")
    spawnSync("git", ["-C", root, "add", "--", "old.md"], { encoding: "utf8" })
    spawnSync("git", ["-C", root, "commit", "-q", "-m", "seed"], { encoding: "utf8" })
    spawnSync("git", ["-C", root, "mv", "old.md", "new.md"], { encoding: "utf8" })

    await assert.rejects(
      desk_save({ deskRoot: root, input: { paths: [listed], message: "half a move" }, schedulePush: () => { throw new Error("must not push") } }),
      new RegExp(`add ${missing.replace(".", "\\.")} to \`paths\`: a move is committed with both its old and its new path`, "u"),
    )
    assert.equal(commitCount(root), 1, "nothing was committed")
    assert.equal(gitStatus(root), "R  old.md -> new.md\n", "the staged move is left as it was")
  })
}

test("desk_save commits a staged rename listed by both paths, inside a listed folder", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "notes"), { recursive: true })
  await fs.writeFile(path.join(root, "notes", "old.md"), "content\n", "utf8")
  spawnSync("git", ["-C", root, "add", "--", "notes"], { encoding: "utf8" })
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "seed"], { encoding: "utf8" })
  spawnSync("git", ["-C", root, "mv", "notes/old.md", "notes/new.md"], { encoding: "utf8" })

  const both = await desk_save({ deskRoot: root, input: { paths: ["notes/old.md", "./notes/new.md"], message: "rename" }, schedulePush: () => {} })
  assert.equal(both.status, "committed", JSON.stringify(both))
  assert.equal(gitStatus(root), "")

  spawnSync("git", ["-C", root, "mv", "notes/new.md", "notes/newer.md"], { encoding: "utf8" })
  const folder = await desk_save({ deskRoot: root, input: { paths: ["notes/"], message: "rename again" }, schedulePush: () => {} })
  assert.equal(folder.status, "committed", JSON.stringify(folder))
  assert.equal(gitStatus(root), "")

  spawnSync("git", ["-C", root, "mv", "notes/newer.md", "notes/newest.md"], { encoding: "utf8" })
  const whole = await desk_save({ deskRoot: root, input: { paths: ["."], message: "rename once more" }, schedulePush: () => {} })
  assert.equal(whole.status, "committed", JSON.stringify(whole))
  assert.equal(gitStatus(root), "")
  assert.equal(commitCount(root), 4)
})

test("desk_save reports a failure when git cannot list the staged changes before committing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "notes\n", "utf8")
  const spawnGit = (cmd, args, opts) => (args.includes("-M") ? { status: 1, stdout: "", stderr: "diff boom" } : spawnSync(cmd, args, opts))
  const result = await desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: "save" }, spawnGit, schedulePush: () => {} })
  assert.deepEqual(result, { status: "nothing_to_commit", commit: { status: "failed", reason: "git could not list the staged changes" } })
  assert.equal(commitCount(root), 0)
})

test("desk_save reports nothing_to_commit when nothing is unstaged at the paths and git cannot list what is staged", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "notes\n", "utf8")
  spawnSync("git", ["-C", root, "add", "--", "notes.md"], { encoding: "utf8" })
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "seed"], { encoding: "utf8" })
  const spawnGit = (cmd, args, opts) => (args.includes("--cached") ? { status: 1, stdout: "", stderr: "diff boom" } : spawnSync(cmd, args, opts))
  const result = await desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: "save" }, spawnGit, schedulePush: () => {} })
  assert.deepEqual(result, { status: "nothing_to_commit" })
  assert.equal(commitCount(root), 1)
})

test("desk_save reports a commit failure as nothing_to_commit with the reason, and creates no commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }
  const calls = []
  const schedulePush = (opts) => calls.push(opts)

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
    spawnGit,
    schedulePush,
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(commitCount(root), 0)
  assert.equal(calls.length, 0, "schedulePush is never called after a commit failure")
})

test("desk_save reports a staging failure as nothing_to_commit with the reason", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }
  const calls = []
  const schedulePush = (opts) => calls.push(opts)

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
    spawnGit,
    schedulePush,
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" })
  assert.equal(calls.length, 0, "schedulePush is never called after a staging failure")
})

test("desk_save reports nothing_to_commit on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  const calls = []
  const schedulePush = (opts) => calls.push(opts)

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
    schedulePush,
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.equal(result.commit, undefined)
  assert.equal(calls.length, 0, "schedulePush is never called on a non-Git desk")
})

test("desk_save schedules a push after a successful commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  const calls = []
  const schedulePush = (opts) => calls.push(opts)

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
    schedulePush,
  })

  assert.equal(result.status, "committed")
  assert.equal(calls.length, 1, "schedulePush is called exactly once")
  assert.deepEqual(calls[0], { root })
})

test("desk_save accepts `paths` sent as a JSON-encoded array string", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")

  const result = await desk_save({
    deskRoot: root,
    input: { paths: JSON.stringify(["notes.md"]), message: "save notes" },
    schedulePush: () => {},
  })

  assert.equal(result.status, "committed")
  assert.deepEqual(lastCommitFiles(root), ["notes.md"])
})

test("desk_save rejects malformed input without touching the working tree", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")

  await assert.rejects(() => desk_save({ deskRoot: root }), /paths.*non-empty array/)
  await assert.rejects(() => desk_save({ deskRoot: root, input: {} }), /paths.*non-empty array/)
  await assert.rejects(() => desk_save({ deskRoot: root, input: { paths: [] } }), /paths.*non-empty array/)
  await assert.rejects(() => desk_save({ deskRoot: root, input: { paths: [""] } }), /paths.*non-empty array/)
  await assert.rejects(() => desk_save({ deskRoot: root, input: { paths: [123] } }), /paths.*non-empty array/)
  await assert.rejects(() => desk_save({ deskRoot: root, input: { paths: "not json" } }), /paths.*non-empty array/)
  await assert.rejects(() => desk_save({ deskRoot: root, input: { paths: ["notes.md"] } }), /message.*required/)
  await assert.rejects(() => desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: 5 } }), /message.*required/)

  assert.equal(gitStatus(root).trim(), "?? notes.md", "no rejected call staged or committed anything")
})
