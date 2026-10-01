// Object-valued tool arguments (task_update / track_update `frontmatter`,
// desk_search `filters`) that arrive as JSON strings or as non-objects.
//
// Regression (2026-09-27): Claude Code saw every Desk tool with an empty
// input schema, so it sent `frontmatter` as a JSON string. task_update
// spread that string into the card, one key per character ("0": "{",
// "1": "\"", ...), and corrupted the card.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create, track_update } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { objectInput } from "../../../../../plugins/desk/mcp/src/util/object-input.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const SCOPE = "desk plugin work; not personal errands"

async function taskFixture() {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" } })
  return { root, filePath: path.join(root, "t", "book-flights", "task.md") }
}

async function trackFixture() {
  const root = await mkTempDeskRoot()
  await track_create({ deskRoot: root, input: { slug: "desk-plugin", title: "Desk", scope: SCOPE } })
  return { root, filePath: path.join(root, "desk-plugin", "track.md") }
}

test("task_update never spreads a JSON-string frontmatter into character keys", async () => {
  const { root, filePath } = await taskFixture()
  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: JSON.stringify({ status: "processing" }) },
  })
  const after = await readFront(filePath)
  assert.equal(Object.hasOwn(after.data, "0"), false, "no character keys")
  assert.equal(after.data.status, "processing", "the JSON object's fields are merged")
  assert.equal(after.data.title, "T")
})

test("task_update rejects a non-object frontmatter and leaves the card byte-identical", async () => {
  const { root, filePath } = await taskFixture()
  const before = await fs.readFile(filePath, "utf8")
  for (const frontmatter of ["status: done", "[1,2]", "\"done\"", "42", ["a"], 42, true]) {
    await assert.rejects(
      task_update({ deskRoot: root, input: { track: "t", slug: "book-flights", frontmatter } }),
      /task_update: `frontmatter` must be an object/,
    )
  }
  assert.equal(await fs.readFile(filePath, "utf8"), before, "nothing written")
})

test("task_update still treats a null or absent frontmatter as no change", async () => {
  const { root, filePath } = await taskFixture()
  await task_update({ deskRoot: root, input: { track: "t", slug: "book-flights", frontmatter: null, body_append: "x" } })
  const after = await readFront(filePath)
  assert.equal(after.data.status, "drafting")
})

test("track_update parses a JSON-string frontmatter and validates its scope", async () => {
  const { root, filePath } = await trackFixture()
  await track_update({ deskRoot: root, input: { slug: "desk-plugin", frontmatter: JSON.stringify({ status: "paused" }) } })
  const after = await readFront(filePath)
  assert.equal(Object.hasOwn(after.data, "0"), false)
  assert.equal(after.data.status, "paused")
  await assert.rejects(
    track_update({ deskRoot: root, input: { slug: "desk-plugin", frontmatter: JSON.stringify({ scope: "" }) } }),
    /track_update: invalid `scope`/,
  )
})

test("track_update rejects a non-object frontmatter and leaves the card byte-identical", async () => {
  const { root, filePath } = await trackFixture()
  const before = await fs.readFile(filePath, "utf8")
  for (const frontmatter of ["{not json", "[]", 7]) {
    await assert.rejects(
      track_update({ deskRoot: root, input: { slug: "desk-plugin", frontmatter } }),
      /track_update: `frontmatter` must be an object/,
    )
  }
  assert.equal(await fs.readFile(filePath, "utf8"), before)
})

test("objectInput accepts objects, parses JSON-string objects and rejects the rest", () => {
  const where = { tool: "t", field: "f" }
  assert.equal(objectInput(undefined, where), undefined)
  assert.equal(objectInput(null, where), undefined)
  const value = { a: 1 }
  assert.equal(objectInput(value, where), value)
  assert.deepEqual(objectInput(" {\"a\":1} ", where), { a: 1 })
  const bare = Object.create(null)
  assert.equal(objectInput(bare, where), bare)
  assert.throws(() => objectInput("{", where), /t: `f` must be an object.*a string that is not valid JSON/)
  assert.throws(() => objectInput("null", where), /got JSON null/)
  assert.throws(() => objectInput("[1]", where), /got a JSON array/)
  assert.throws(() => objectInput([], where), /got an array/)
  assert.throws(() => objectInput(3, where), /got a number/)
  assert.throws(() => objectInput(new Date(0), where), /got a Date/)
})

test("desk_search parses a JSON-string filters object and refuses a non-object", async () => {
  const { desk_search } = await import("../../../../../plugins/desk/mcp/src/tools/search.js")
  const seen = []
  const queryRouter = { lexical: async (request) => { seen.push(request); return { ok: true } } }
  await desk_search({ deskRoot: "/r", input: { query: "q", filters: JSON.stringify({ track: "t" }) }, queryRouter })
  await desk_search({ deskRoot: "/r", input: { query: "q" }, queryRouter })
  assert.deepEqual(seen[0].filters, { track: "t" })
  assert.equal(Object.hasOwn(seen[1], "filters"), false)
  await assert.rejects(
    desk_search({ deskRoot: "/r", input: { query: "q", filters: "track=t" }, queryRouter }),
    (error) => {
      assert.match(error.message, /desk_search: `filters` must be an object/)
      assert.match(error.message, /nothing was searched\. Pass it as a JSON object, for example \{"track": "desk-plugin"/)
      assert.doesNotMatch(error.message, /written|implementing"\}/, "a read's error never talks about a write")
      return true
    },
  )
  assert.equal(seen.length, 2)
})
