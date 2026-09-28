// task_archive — happy path moves dir, bumps status to done, idempotent on
// already-archived; refuses if neither source nor archive exists.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import {
  task_create,
  task_archive,
} from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

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
