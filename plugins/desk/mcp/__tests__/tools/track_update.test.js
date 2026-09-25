// track_update — merge frontmatter, preserve schema_version + created,
// body append, refusal on missing track, scope validation (M4-1).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { track_create, track_update } from "../../src/tools/track.js"
import { writeMarkdown } from "../../src/util/fm.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const SCOPE = "billing disputes and refund flows; not payroll"

test("track_update merges frontmatter and refreshes `updated`", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const filePath = path.join(root, "billing-disputes", "track.md")
  const before = await readFront(filePath)

  await new Promise((r) => setTimeout(r, 1100))

  const result = await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { status: "closed" } },
  })
  assert.equal(result.status, "updated")

  const after = await readFront(filePath)
  assert.equal(after.data.status, "closed")
  assert.equal(after.data.title, "T")
  assert.notEqual(after.data.updated, before.data.updated)
  assert.equal(after.data.created, before.data.created)
})

test("track_update preserves schema_version + created against override", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const filePath = path.join(root, "billing-disputes", "track.md")
  const before = await readFront(filePath)

  await track_update({
    deskRoot: root,
    input: {
      slug: "billing-disputes",
      frontmatter: { schema_version: 42, created: "1999-01-01T00:00:00Z" },
    },
  })
  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1)
  assert.equal(after.data.created, before.data.created)
})

test("track_update adds schema_version to a legacy track without inventing created", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "legacy-track", "track.md")
  await writeMarkdown(filePath, { title: "Legacy" }, "Legacy body")

  await track_update({
    deskRoot: root,
    input: { slug: "legacy-track", frontmatter: { status: "active" } },
  })

  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1)
  assert.equal(after.data.created, undefined)
})

test("track_update appends to body", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: {
      slug: "billing-disputes",
      title: "T",
      scope: SCOPE,
      body: "## Scope\n\nOriginal.",
    },
  })
  await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", body_append: "## Update\n\nMore." },
  })
  const { content } = await readFront(path.join(root, "billing-disputes", "track.md"))
  assert.match(content, /Original\./)
  assert.match(content, /## Update/)
})

test("track_update appends without a separator to empty or blank-line-terminated bodies", async () => {
  const root = await mkTempDeskRoot()
  const emptyPath = path.join(root, "empty-track", "track.md")
  const terminatedPath = path.join(root, "terminated-track", "track.md")
  await fs.mkdir(path.dirname(emptyPath), { recursive: true })
  await fs.mkdir(path.dirname(terminatedPath), { recursive: true })
  await fs.writeFile(emptyPath, "---\ntitle: Empty\n---\n", "utf8")
  await fs.writeFile(
    terminatedPath,
    "---\ntitle: Terminated\n---\nBody\n\n",
    "utf8",
  )

  await track_update({
    deskRoot: root,
    input: { slug: "empty-track", body_append: "First" },
  })
  await track_update({
    deskRoot: root,
    input: { slug: "terminated-track", body_append: "Next" },
  })

  assert.match((await readFront(emptyPath)).content, /^\n?First/)
  assert.match((await readFront(terminatedPath)).content, /Body\n\nNext/)
})

test("track_update ignores an empty body append", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE, body: "Original" },
  })

  await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", body_append: "" },
  })

  assert.match((await readFront(path.join(root, "billing-disputes", "track.md"))).content, /Original/)
})

test("track_update refuses to update a missing track", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_update({
        deskRoot: root,
        input: { slug: "ghost-track", frontmatter: { status: "active" } },
      }),
    /does not exist/,
  )
})

test("track_update requires a slug", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    track_update({ deskRoot: root }),
    /slug.*required/,
  )
  await assert.rejects(
    track_update({
      deskRoot: root,
      input: { frontmatter: { status: "active" } },
    }),
    /slug.*required/,
  )
})

// ── M4-1: scope validation ──────────────────────────────────────────────

test("track_update sets a well-formed scope", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const newScope = "refund disputes only; not chargebacks"
  await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { scope: newScope } },
  })
  const { data } = await readFront(path.join(root, "billing-disputes", "track.md"))
  assert.equal(data.scope, newScope)
})

test("track_update rejects an invalid scope and leaves the file untouched", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const before = await readFront(path.join(root, "billing-disputes", "track.md"))

  await assert.rejects(
    () =>
      track_update({
        deskRoot: root,
        input: {
          slug: "billing-disputes",
          frontmatter: { scope: "line one\nline two" },
        },
      }),
    /single line/,
  )

  const after = await readFront(path.join(root, "billing-disputes", "track.md"))
  assert.deepEqual(after.data, before.data)
})

test("track_update leaves an existing badly named track's scope alone when scope isn't in the update", async () => {
  // The slug itself is never re-validated by track_update (only creation
  // and renaming validate names) — a track created before these rules
  // existed still updates fine as long as the update doesn't touch scope.
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "misc", "track.md")
  await writeMarkdown(filePath, { title: "Misc", status: "active" }, "")

  const result = await track_update({
    deskRoot: root,
    input: { slug: "misc", frontmatter: { status: "closed" } },
  })
  assert.equal(result.status, "updated")
  const { data } = await readFront(filePath)
  assert.equal(data.status, "closed")
})
