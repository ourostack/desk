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
  })

  assert.equal(result.status, "committed")
  assert.equal(commitCount(root), 1)
  assert.deepEqual(
    lastCommitFiles(root),
    [path.join("planning", "plan.md"), path.join("planning", "spec.md")],
  )
})

test("desk_save reports nothing_to_commit for a path that was never written, and creates no commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "seed.md"), "seed\n", "utf8")
  await spawnSync("git", ["-C", root, "add", "--", "seed.md"], { encoding: "utf8" })
  await spawnSync("git", ["-C", root, "commit", "-q", "-m", "seed"], { encoding: "utf8" })
  const before = commitCount(root)

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["never-written.md"], message: "save nothing" },
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.equal(result.commit, undefined)
  assert.equal(commitCount(root), before, "no empty commit was created")
  assert.equal(gitStatus(root), "")
})

test("desk_save reports nothing_to_commit for a path that is already committed and unchanged", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  await desk_save({ deskRoot: root, input: { paths: ["notes.md"], message: "save notes" } })
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
  })

  assert.equal(result.status, "committed")
  assert.deepEqual(lastCommitFiles(root), [path.join("desks", "alex", "notes.md")])
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
  })

  assert.equal(result.status, "committed")
  assert.deepEqual(lastCommitFiles(root), ["notes.md"])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("desk_save reports a commit failure as nothing_to_commit with the reason, and creates no commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
    spawnGit,
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(commitCount(root), 0)
})

test("desk_save reports a staging failure as nothing_to_commit with the reason", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
    spawnGit,
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" })
})

test("desk_save reports nothing_to_commit on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")

  const result = await desk_save({
    deskRoot: root,
    input: { paths: ["notes.md"], message: "save notes" },
  })

  assert.equal(result.status, "nothing_to_commit")
  assert.equal(result.commit, undefined)
})

test("desk_save accepts `paths` sent as a JSON-encoded array string", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "notes.md"), "Hand-written notes.\n", "utf8")

  const result = await desk_save({
    deskRoot: root,
    input: { paths: JSON.stringify(["notes.md"]), message: "save notes" },
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
