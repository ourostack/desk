// task_update — frontmatter merge, body append, preservation of
// schema_version + created, refusal on missing task.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

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

test("task_update merges frontmatter and refreshes `updated`", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", body: "Hello" },
  })
  const filePath = path.join(root, "t", "book-flights", "task.md")
  const before = await readFront(filePath)

  // Force a small wait so `updated` will differ at second-precision.
  await new Promise((r) => setTimeout(r, 1100))

  const result = await task_update({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      frontmatter: { status: "in_progress", category: "general" },
    },
  })
  assert.equal(result.status, "updated")

  const after = await readFront(filePath)
  assert.equal(after.data.status, "in_progress")
  assert.equal(after.data.category, "general")
  assert.equal(after.data.title, "T", "title preserved")
  assert.notEqual(after.data.updated, before.data.updated, "updated bumped")
  assert.equal(after.data.created, before.data.created, "created preserved")
  assert.equal(after.data.schema_version, 1)
})

test("task_update preserves schema_version + created even if caller overrides them", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T" },
  })
  const filePath = path.join(root, "t", "book-flights", "task.md")
  const before = await readFront(filePath)

  await task_update({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      frontmatter: {
        schema_version: 99,
        created: "1900-01-01T00:00:00Z",
        status: "blocked",
      },
    },
  })
  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1, "schema_version locked to 1")
  assert.equal(after.data.created, before.data.created, "created locked")
  assert.equal(after.data.status, "blocked")
})

test("task_update adds schema_version to a legacy task without inventing created", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "t", "s", "task.md")
  await writeMarkdown(filePath, { title: "Legacy" }, "Legacy body")

  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "s", frontmatter: { status: "active" } },
  })

  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1)
  assert.equal(after.data.created, undefined)
})

test("task_update appends to body with a blank-line separator", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", body: "Original body" },
  })
  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", body_append: "Second paragraph" },
  })
  const { content } = await readFront(
    path.join(root, "t", "book-flights", "task.md"),
  )
  assert.match(content, /Original body/)
  assert.match(content, /Second paragraph/)
  assert.ok(
    content.indexOf("Original body") < content.indexOf("Second paragraph"),
    "appended content follows existing body",
  )
})

test("task_update appends without a separator to empty or blank-line-terminated bodies", async () => {
  const root = await mkTempDeskRoot()
  const emptyPath = path.join(root, "t", "empty", "task.md")
  const terminatedPath = path.join(root, "t", "terminated", "task.md")
  await fs.mkdir(path.dirname(emptyPath), { recursive: true })
  await fs.mkdir(path.dirname(terminatedPath), { recursive: true })
  await fs.writeFile(emptyPath, "---\ntitle: Empty\n---\n", "utf8")
  await fs.writeFile(
    terminatedPath,
    "---\ntitle: Terminated\n---\nBody\n\n",
    "utf8",
  )

  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "empty", body_append: "First" },
  })
  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "terminated", body_append: "Next" },
  })

  assert.match((await readFront(emptyPath)).content, /^\n?First/)
  assert.match((await readFront(terminatedPath)).content, /Body\n\nNext/)
})

test("task_update ignores an empty body append", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", body: "Original" },
  })

  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", body_append: "" },
  })

  assert.match(
    (await readFront(path.join(root, "t", "book-flights", "task.md"))).content,
    /Original/,
  )
})

test("task_update refuses to update a missing task", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_update({
        deskRoot: root,
        input: { track: "nope", slug: "nada", frontmatter: { status: "x" } },
      }),
    /does not exist/,
  )
})

test("task_update requires both task identifiers", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    task_update({ deskRoot: root }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_update({
      deskRoot: root,
      input: { slug: "s", frontmatter: { status: "x" } },
    }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_update({
      deskRoot: root,
      input: { track: "t", frontmatter: { status: "x" } },
    }),
    /track.*slug.*required/,
  )
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("task_update stages and commits exactly the task.md it updated", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "in_progress" } },
    schedulePush: () => {},
  })

  assert.equal(result.status, "updated")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_update: t/book-flights")
  assert.deepEqual(lastCommitFiles(root), [path.join("t", "book-flights", "task.md")])
})

test("task_update calls schedulePush exactly once with { root: deskRoot } on a successful commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  const calls = []
  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "in_progress" } },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "updated")
  assert.deepEqual(calls, [{ root }], "schedulePush is called exactly once, with the desk root")
})

test("task_update commits only its own file, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  // Simulates another process staging an unrelated path in the window
  // between task_update's dirty check and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "in_progress" } },
    schedulePush: () => {},
  })

  assert.equal(result.commit, undefined, "task_update's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("t", "book-flights", "task.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("task_update reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  const calls = []
  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "in_progress" } },
    spawnGit,
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "updated", "the write itself is never lost to a commit failure")
  const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
  assert.equal(data.status, "in_progress")
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(calls.length, 0, "schedulePush is never called when the commit fails")
})

test("task_update skips staging and committing when the file held unstaged changes before the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })
  const filePath = path.join(root, "t", "book-flights", "task.md")

  // Another session's unstaged edit to this same file, in place before
  // task_update writes.
  await fs.appendFile(filePath, "\nanother session's note\n")

  const calls = []
  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "in_progress" } },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "updated", "the write always happens")
  assert.equal(result.commit, undefined, "no commit attempted when the file was already dirty")
  const { data } = await readFront(filePath)
  assert.equal(data.status, "in_progress")
  assert.match(gitStatus(root), /t\/book-flights\/task\.md/, "the file is left as an uncommitted change")
  assert.equal(calls.length, 0, "schedulePush is never called when staging was skipped for a pre-existing dirty file")
})

// A real `.git/index.lock`, held the way a concurrent Git command (or a
// crashed one) would hold it, must fail `git add` for real, not through a
// mocked `spawnGit` — proving the fix against genuine git behavior
// (independent review, fix round).
test("task_update reports a real staging failure without losing the write, when .git/index.lock is genuinely held", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  const lockPath = path.join(root, ".git", "index.lock")
  await fs.writeFile(lockPath, "")
  try {
    const result = await task_update({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", frontmatter: { status: "in_progress" } },
    })

    assert.equal(result.status, "updated", "the write itself is never lost to a genuinely held lock")
    const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
    assert.equal(data.status, "in_progress", "the frontmatter merge is on disk despite the lock")
    assert.equal(result.commit.status, "failed", "a real `git add` failure is reported, not swallowed as a silent success")
    assert.match(result.commit.reason, /index\.lock/)
  } finally {
    await fs.rm(lockPath, { force: true })
  }
})
