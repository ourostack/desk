// task_create — happy path, refusal on duplicate, optional runtime fields,
// name validation (M4-1).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { task_create } from "../../src/tools/task.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

test("task_create writes a v1 task.md with required + default fields", async () => {
  const root = await mkTempDeskRoot()
  const result = await task_create({
    deskRoot: root,
    input: {
      track: "europe-trip",
      slug: "book-flights",
      title: "Book the Paris flights",
    },
  })

  assert.equal(result.status, "created")
  assert.equal(result.path, path.join("europe-trip", "book-flights", "task.md"))

  const filePath = path.join(root, "europe-trip", "book-flights", "task.md")
  assert.ok(await exists(filePath), "task.md should exist on disk")

  const { data } = await readFront(filePath)
  assert.equal(data.schema_version, 1)
  assert.equal(data.title, "Book the Paris flights")
  assert.equal(data.status, "drafting")
  assert.equal(data.track, "europe-trip")
  assert.ok(data.created, "created should be set")
  assert.equal(data.created, data.updated, "created and updated match at create time")
  assert.match(data.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test("task_create refuses to overwrite an existing task", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "trip-planning", slug: "book-hotel", title: "first" },
  })
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "trip-planning", slug: "book-hotel", title: "second" },
      }),
    /already exists/,
  )
})

test("task_create accepts optional runtime fields and passes them through", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: {
      track: "infra",
      slug: "reminder-x",
      title: "Reminder",
      status: "scheduled",
      category: "reminder",
      cadence: "30m",
      requester: "ari",
      artifacts: ["https://example.com/pr/1"],
      body: "Reminder body",
    },
  })
  const filePath = path.join(root, "infra", "reminder-x", "task.md")
  const { data, content } = await readFront(filePath)
  assert.equal(data.status, "scheduled")
  assert.equal(data.category, "reminder")
  assert.equal(data.cadence, "30m")
  assert.equal(data.requester, "ari")
  assert.deepEqual(data.artifacts, ["https://example.com/pr/1"])
  assert.match(content, /Reminder body/)
})

test("task_create rejects missing required fields", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_create({ deskRoot: root }),
    /track.*required/,
  )
  await assert.rejects(
    () => task_create({ deskRoot: root, input: { slug: "x", title: "y" } }),
    /track.*required/,
  )
  await assert.rejects(
    () => task_create({ deskRoot: root, input: { track: "x", title: "y" } }),
    /slug.*required/,
  )
  await assert.rejects(
    () => task_create({ deskRoot: root, input: { track: "x", slug: "y" } }),
    /title.*required/,
  )
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "x", slug: "y", title: 123 },
      }),
    /title.*required/,
  )
})

// ── M4-1: name validation ────────────────────────────────────────────────

test("task_create accepts well-formed outcome names", async () => {
  const root = await mkTempDeskRoot()
  for (const slug of ["factory-slice-1", "oauth-login-p0-fix"]) {
    const result = await task_create({
      deskRoot: root,
      input: { track: "engineering", slug, title: "Title" },
    })
    assert.equal(result.status, "created")
  }
})

test("task_create rejects a prompt-copied name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "engineering", slug: "hello-please-do-a-deep-dive", title: "Title" },
      }),
    /invalid slug/,
  )
})

test("task_create rejects a name with a credential-like token without echoing it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: {
          track: "engineering",
          slug: "deploy-a1b2c3d4e5f6a7b8c9d0",
          title: "Title",
        },
      }),
    (err) => {
      assert.match(err.message, /secret's value/)
      assert.equal(err.message.includes("a1b2c3d4e5f6a7b8c9d0"), false)
      return true
    },
  )
})

test("task_create rejects an IPv4-looking name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "engineering", slug: "connect-100-73-66-84", title: "Title" },
      }),
    /invalid slug/,
  )
})

test("task_create rejects a 7-word name as shape", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: {
          track: "engineering",
          slug: "one-two-three-four-five-six-seven",
          title: "Title",
        },
      }),
    /invalid slug/,
  )
})

test("reading (updating) an existing badly named task still works — only creation validates", async () => {
  const root = await mkTempDeskRoot()
  const { writeMarkdown } = await import("../../src/util/fm.js")
  const { task_update } = await import("../../src/tools/task.js")
  const filePath = path.join(root, "engineering", "hi-do-the-thing", "task.md")
  await writeMarkdown(
    filePath,
    { schema_version: 1, title: "Old", status: "drafting", track: "engineering" },
    "",
  )

  const result = await task_update({
    deskRoot: root,
    input: { track: "engineering", slug: "hi-do-the-thing", frontmatter: { status: "doing" } },
  })
  assert.equal(result.status, "updated")
  const { data } = await readFront(filePath)
  assert.equal(data.status, "doing")
})
