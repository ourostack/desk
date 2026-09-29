// lesson_add — initial write vs subsequent update; slugify topic; reject empty.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { lesson_add } from "../../../../../plugins/desk/mcp/src/tools/lesson.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"

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

test("lesson_add creates _meta/tips/<topic-slug>.md with header on first write", async () => {
  const root = await mkTempDeskRoot()
  const result = await lesson_add({
    deskRoot: root,
    input: {
      topic: "Working with gh CLI on EMU",
      body: "Use `gh auth switch -u <alias>_microsoft`.",
    },
  })
  assert.equal(result.status, "added")
  assert.equal(
    result.path,
    path.join("_meta", "tips", "working-with-gh-cli-on-emu.md"),
  )
  const filePath = path.join(root, result.path)
  assert.ok(await exists(filePath))

  const content = await fs.readFile(filePath, "utf8")
  assert.match(content, /^# Working with gh CLI on EMU/, "h1 header derived from topic")
  assert.match(content, /gh auth switch/)
})

test("lesson_add appends an `## Update <date>` section when file exists", async () => {
  const root = await mkTempDeskRoot()
  await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "First lesson." },
  })
  await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "Second lesson, learned later." },
  })
  const content = await fs.readFile(
    path.join(root, "_meta", "tips", "topic-x.md"),
    "utf8",
  )
  assert.match(content, /First lesson/)
  assert.match(content, /## Update \d{4}-\d{2}-\d{2}/)
  assert.match(content, /Second lesson/)
  assert.ok(
    content.indexOf("First lesson") < content.indexOf("Second lesson"),
    "first lesson precedes the update",
  )
})

test("lesson_add normalizes trailing newlines and appends to a file without one", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "_meta", "tips", "topic-x.md")
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, "# topic-x", "utf8")

  await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "New lesson.\n" },
  })

  const content = await fs.readFile(filePath, "utf8")
  assert.match(content, /# topic-x\n\n## Update \d{4}-\d{2}-\d{2}\n\nNew lesson\.\n$/)
})

test("lesson_add rejects empty topic or body", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => lesson_add({ deskRoot: root }),
    /topic.*required/,
  )
  await assert.rejects(
    () => lesson_add({ deskRoot: root, input: { body: "x" } }),
    /topic.*required/,
  )
  await assert.rejects(
    () => lesson_add({ deskRoot: root, input: { topic: "x" } }),
    /body.*required/,
  )
  await assert.rejects(
    () => lesson_add({ deskRoot: root, input: { topic: 123, body: "x" } }),
    /topic.*required/,
  )
  await assert.rejects(
    () => lesson_add({ deskRoot: root, input: { topic: "x", body: 123 } }),
    /body.*required/,
  )
  await assert.rejects(
    () => lesson_add({ deskRoot: root, input: { topic: "!!!", body: "x" } }),
    /slugified to empty/,
  )
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("lesson_add stages and commits exactly the lesson file it wrote", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "First lesson." },
    schedulePush: () => {},
  })

  assert.equal(result.status, "added")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "lesson_add: topic-x")
  assert.deepEqual(lastCommitFiles(root), [path.join("_meta", "tips", "topic-x.md")])
})

test("lesson_add commits only its own file, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)

  // Simulates another process staging an unrelated path in the window
  // between lesson_add's dirty check and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "First lesson." },
    schedulePush: () => {},
  })

  assert.equal(result.commit, undefined, "lesson_add's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("_meta", "tips", "topic-x.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("lesson_add reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "First lesson." },
    spawnGit,
    schedulePush,
  })

  assert.equal(result.status, "added", "the write itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "_meta", "tips", "topic-x.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(calls.length, 0, "schedulePush is never called when the commit fails")
})

test("lesson_add reports a staging failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }

  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "First lesson." },
    spawnGit,
  })

  assert.equal(result.status, "added", "the write itself is never lost to a staging failure")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" }, "a stage failure is reported, not swallowed as a silent success")
  assert.ok(await exists(path.join(root, "_meta", "tips", "topic-x.md")))
})

test("lesson_add skips staging and committing silently on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "First lesson." },
    schedulePush,
  })
  assert.equal(result.status, "added")
  assert.equal(result.commit, undefined)
  assert.equal(calls.length, 0, "schedulePush is never called on a non-Git desk")
})

test("lesson_add skips staging and committing when the file held unstaged changes before the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await lesson_add({ deskRoot: root, input: { topic: "topic-x", body: "First lesson." }, schedulePush: () => {} })
  const filePath = path.join(root, "_meta", "tips", "topic-x.md")

  // Another session's unstaged edit to this same file, in place before
  // lesson_add's own append.
  await fs.appendFile(filePath, "\nanother session's note\n")

  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "Second lesson." },
    schedulePush,
  })

  assert.equal(result.status, "added", "the write always happens")
  assert.equal(result.commit, undefined, "no commit attempted when the file was already dirty")
  assert.match(gitStatus(root), /_meta\/tips\/topic-x\.md/, "the file is left as an uncommitted change")
  assert.equal(calls.length, 0, "schedulePush is never called when the commit is skipped")
})

test("lesson_add commits both the rename and the write as one commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const legacyPath = path.join(root, "_meta", "tips", "con.md")
  await fs.mkdir(path.dirname(legacyPath), { recursive: true })
  await fs.writeFile(legacyPath, "# CON\n\nOriginal reserved lesson.\n", "utf8")
  spawnSync("git", ["-C", root, "add", "--", "_meta/tips/con.md"], { encoding: "utf8" })
  spawnSync("git", ["-C", root, "commit", "-q", "-m", "seed legacy lesson"], { encoding: "utf8" })

  // "CON" slugifies to the reserved-name-escaped "_con", so the legacy,
  // unprefixed "con.md" is renamed onto the canonical "_con.md" as
  // housekeeping (see fm.test.js's "legacy paths are reused only when their
  // identity is provable" for the same mechanism unrelated to Git). The
  // append that follows changes enough of the file's bytes that Git's own
  // similarity heuristic does not label this a rename in the commit — it
  // records a delete of the old path and an add of the new one — but both
  // land in the one commit lesson_add makes, and nothing else does.
  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "CON", body: "Updated reserved lesson." },
    schedulePush: () => {},
  })

  assert.equal(result.path, path.join("_meta", "tips", "_con.md"))
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "lesson_add: _con")
  assert.deepEqual(lastCommitFiles(root), [path.join("_meta", "tips", "_con.md"), path.join("_meta", "tips", "con.md")])
  assert.equal(await exists(legacyPath), false, "the legacy path is gone")
  const content = await fs.readFile(path.join(root, result.path), "utf8")
  assert.match(content, /Original reserved lesson/)
  assert.match(content, /Updated reserved lesson/)
})

test("lesson_add skips staging and committing when the pre-rename file held unstaged changes, even though the rename and write still happen", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const legacyPath = path.join(root, "_meta", "tips", "con.md")
  await fs.mkdir(path.dirname(legacyPath), { recursive: true })
  await fs.writeFile(legacyPath, "# CON\n\nOriginal reserved lesson.\n", "utf8")
  // Left untracked by another session — it's the pre-rename identity that
  // must be checked for dirtiness, not the (as yet nonexistent) destination.

  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "CON", body: "Updated reserved lesson." },
    schedulePush,
  })

  assert.equal(result.path, path.join("_meta", "tips", "_con.md"))
  assert.equal(result.commit, undefined, "no commit attempted when the pre-rename file was already dirty")
  assert.equal(await exists(legacyPath), false, "the rename still happens despite the dirty pre-rename identity")
  const destPath = path.join(root, result.path)
  assert.match(await fs.readFile(destPath, "utf8"), /Updated reserved lesson/)
  const log = spawnSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" })
  assert.equal(log.stdout.trim(), "", "nothing was ever committed")
  assert.equal(calls.length, 0, "schedulePush is never called when the commit is skipped")
})

// ── M4-6 Part 3: schedule push ──────────────────────────────────────────────

test("lesson_add schedules a push exactly once with the desk root after a successful, silent commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await lesson_add({
    deskRoot: root,
    input: { topic: "topic-x", body: "First lesson." },
    schedulePush,
  })
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.deepEqual(calls, [{ root }])
})
