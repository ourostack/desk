// task_archive — happy path moves dir, bumps status to done, idempotent on
// already-archived; refuses if neither source nor archive exists.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import {
  task_create,
  task_archive,
} from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

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

test("task_archive moves the dir into _archive/ and marks status=done", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "Some task" },
  })
  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights" },
  })
  assert.equal(result.status, "archived")

  const srcExists = await exists(path.join(root, "t", "book-flights"))
  assert.equal(srcExists, false, "source dir should be gone")
  const archived = path.join(root, "t", "_archive", "book-flights", "task.md")
  assert.ok(await exists(archived), "archived task.md should exist")

  const { data } = await readFront(archived)
  assert.equal(data.status, "done")
})

test("task_archive preserves an already-terminal status", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      title: "Done already",
      status: "cancelled",
    },
  })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })
  const { data } = await readFront(
    path.join(root, "t", "_archive", "book-flights", "task.md"),
  )
  assert.equal(data.status, "cancelled", "terminal status preserved")
})

test("task_archive is idempotent when source already archived", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T" },
  })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })
  const second = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights" },
  })
  assert.equal(second.status, "already_archived")
  assert.equal(
    second.path,
    path.join("t", "_archive", "book-flights", "task.md"),
  )
})

test("task_archive throws when neither source nor archive exists", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_archive({
        deskRoot: root,
        input: { track: "ghost", slug: "phantom" },
      }),
    /does not exist/,
  )
})

test("task_archive refuses an existing archive destination while the source exists", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T" },
  })
  await fs.mkdir(path.join(root, "t", "_archive", "book-flights"), { recursive: true })

  await assert.rejects(
    task_archive({
      deskRoot: root,
      input: { track: "t", slug: "book-flights" },
    }),
    /archive destination already exists/i,
  )
})

test("task_archive requires both task identifiers", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    task_archive({ deskRoot: root }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_archive({ deskRoot: root, input: { slug: "book-flights" } }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_archive({ deskRoot: root, input: { track: "t" } }),
    /track.*slug.*required/,
  )
})

test("task_archive moves a task directory even when its task card is absent", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "t", "s"), { recursive: true })

  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "s" },
  })

  assert.equal(result.status, "archived")
  assert.equal(await exists(path.join(root, "t", "s")), false)
  assert.equal(await exists(path.join(root, "t", "_archive", "s")), true)
})

test("task_archive creates _archive/ dir if missing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "fresh", slug: "task-one", title: "T" },
  })
  // No _archive dir exists yet — the tool must create it.
  await task_archive({
    deskRoot: root,
    input: { track: "fresh", slug: "task-one" },
  })
  const stat = await fs.stat(path.join(root, "fresh", "_archive"))
  assert.ok(stat.isDirectory())
})

test("task_archive's status bump preserves every other frontmatter byte untouched: a date-only value, a long single-line scalar, quoted and unquoted values, and a note: | block", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "byte-preserve", title: "Byte preserve" },
  })
  const filePath = path.join(root, "t", "byte-preserve", "task.md")
  const handWritten = [
    "---",
    "schema_version: 1",
    "title: Byte preserve",
    "track: t",
    "status: processing",
    "created: 2026-05-26",
    "requester: \"ari\"",
    "reviewer: ari",
    "purpose: A long single-line scalar describing the task in one uninterrupted run of prose, with no wrapping at all.",
    "note: |",
    "  first literal line",
    "  second literal line",
    "updated: \"2026-09-20T10:00:00Z\"",
    "---",
    "",
    "# Byte preserve",
    "",
    "Body text.",
    "",
  ].join("\n")
  await fs.writeFile(filePath, handWritten, "utf8")

  await task_archive({ deskRoot: root, input: { track: "t", slug: "byte-preserve" } })

  const archivedPath = path.join(root, "t", "_archive", "byte-preserve", "task.md")
  const raw = await fs.readFile(archivedPath, "utf8")
  assert.match(raw, /\nstatus: done\n/u, "status is bumped to done")
  assert.doesNotMatch(raw, /updated: "2026-09-20T10:00:00Z"/u, "updated is refreshed")
  assert.match(raw, /\ncreated: 2026-05-26\n/u, "the date-only created value is untouched")
  assert.match(raw, /\nrequester: "ari"\n/u, "the quoted requester value is untouched")
  assert.match(raw, /\nreviewer: ari\n/u, "the unquoted reviewer value is untouched")
  assert.match(
    raw,
    /\npurpose: A long single-line scalar describing the task in one uninterrupted run of prose, with no wrapping at all\.\n/u,
    "the long single-line purpose scalar is untouched",
  )
  assert.match(raw, /\nnote: \|\n {2}first literal line\n {2}second literal line\n/u, "the note: | block is untouched")
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("task_archive stages and commits exactly the moved paths", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" } })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })

  assert.equal(result.status, "archived")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_archive: t/book-flights")
  assert.deepEqual(lastCommitFiles(root), [path.join("t", "_archive", "book-flights", "task.md")])
})

test("task_archive commits only its own paths, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" } })

  // Simulates another process staging an unrelated path in the window
  // between task_archive's move and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })

  assert.equal(result.commit, undefined, "task_archive's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("t", "_archive", "book-flights", "task.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("task_archive reports a commit failure without losing the move", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" } })
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" }, spawnGit })

  assert.equal(result.status, "archived", "the move itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "t", "_archive", "book-flights", "task.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
})

test("task_archive reports a staging failure without losing the move", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" } })
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" }, spawnGit })

  assert.equal(result.status, "archived", "the move itself is never lost to a staging failure")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" }, "a stage failure is reported, not swallowed as a silent success")
  assert.ok(await exists(path.join(root, "t", "_archive", "book-flights", "task.md")))
})

test("task_archive skips staging and committing silently on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" } })
  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })
  assert.equal(result.status, "archived")
  assert.equal(result.commit, undefined)
})

test("already_archived stages and commits nothing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" } })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })

  const before = lastCommitMessage(root)
  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })

  assert.equal(result.status, "already_archived")
  assert.equal(result.commit, undefined)
  assert.equal(lastCommitMessage(root), before, "nothing changed, so nothing was committed")
  assert.equal(gitStatus(root), "")
})
