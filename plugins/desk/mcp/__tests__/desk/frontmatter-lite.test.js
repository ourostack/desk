// parseFrontmatterLite — the dependency-free card reader the tidy
// migration's Detect uses when gray-matter isn't installed (M4-5).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import matter from "gray-matter"
import { parseFrontmatterLite } from "../../src/desk/frontmatter-lite.js"

test("a file without frontmatter is all content", () => {
  assert.deepEqual(parseFrontmatterLite("just a body\n"), { data: {}, content: "just a body\n", matter: "" })
  assert.deepEqual(parseFrontmatterLite(""), { data: {}, content: "", matter: "" })
})

test("top-level scalars read as YAML reads them", () => {
  const text = [
    "---",
    "double: \"say \\\"hi\\\" \\\\ there\"",
    "single: 'it''s'",
    "plain: processing",
    "commented: active # a note",
    "empty:",
    "tilde: ~",
    "nothing: null",
    "yes: true",
    "no: false",
    "count: 3",
    "day: 2026-08-01",
    "stamp: 2026-08-01T00:00:00Z",
    "spaced: 2026-08-01 10:00:00 +02:00",
    "quoted_stamp: '2026-08-01T00:00:00Z'",
    "scope: billing; not payroll",
    "list:",
    "  - https://github.com/o/r/pull/7",
    "not a key line",
    "---",
    "body line",
  ].join("\r\n")
  const { data, content, matter: raw } = parseFrontmatterLite(text)
  assert.equal(data.double, 'say "hi" \\ there')
  assert.equal(data.single, "it's")
  assert.equal(data.plain, "processing")
  assert.equal(data.commented, "active")
  assert.equal(data.empty, null)
  assert.equal(data.tilde, null)
  assert.equal(data.nothing, null)
  assert.equal(data.yes, true)
  assert.equal(data.no, false)
  assert.equal(data.count, 3)
  assert.ok(data.day instanceof Date)
  assert.ok(data.stamp instanceof Date)
  assert.equal(data.stamp.toISOString(), "2026-08-01T00:00:00.000Z")
  assert.ok(data.spaced instanceof Date)
  assert.equal(data.quoted_stamp, "2026-08-01T00:00:00Z")
  assert.equal(data.scope, "billing; not payroll")
  assert.equal(data.list, null, "nested values are not parsed")
  assert.equal(content, "body line")
  assert.match(raw, /https:\/\/github\.com\/o\/r\/pull\/7/)
  assert.ok(raw.startsWith("\ndouble:"))
})

test("an unclosed frontmatter block is all frontmatter", () => {
  const { data, content } = parseFrontmatterLite("---\nstatus: processing\n")
  assert.equal(data.status, "processing")
  assert.equal(content, "")
})

test("the reader agrees with gray-matter on what a Desk tool writes", () => {
  const text = matter.stringify("Body\n", {
    schema_version: 1,
    title: "refund-flow-cleanup",
    status: "processing",
    created: "2026-09-20T00:00:00Z",
    updated: "2026-09-20T00:00:00Z",
    scope: "billing disputes; not payroll",
  })
  const expected = matter(text)
  const actual = parseFrontmatterLite(text)
  assert.deepEqual(actual.data, expected.data)
  assert.equal(actual.content, expected.content)
})
