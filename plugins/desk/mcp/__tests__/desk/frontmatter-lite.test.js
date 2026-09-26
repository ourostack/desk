// parseFrontmatterLite — the dependency-free card reader the tidy
// migration's Detect uses when gray-matter isn't installed (M4-5).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import matter from "gray-matter"
import { parseFrontmatterLite } from "../../src/desk/frontmatter-lite.js"

// gray-matter caches parses by content, so each call gets a fresh string.
let salt = 0
function grayMatterData(text) {
  salt += 1
  return matter(`${text}${" ".repeat(salt % 7)}`).data
}

function sameAsGrayMatter(text, fields) {
  const expected = grayMatterData(text)
  const actual = parseFrontmatterLite(text).data
  for (const field of fields) assert.deepEqual(actual[field], expected[field], `${field} in ${JSON.stringify(text)}`)
}

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
    "hash_only: # nothing",
    "tilde: ~",
    "nothing: null",
    "yes: true",
    "no: false",
    "count: 3",
    "day: 2026-08-01",
    "stamp: 2026-08-01T00:00:00Z",
    "local: 2026-08-01T10:00:00",
    "spaced: 2026-08-01 10:00:00 +02:00",
    "short_zone: 2026-08-01T1:00:00+2",
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
  assert.equal(data.hash_only, null)
  assert.equal(data.tilde, null)
  assert.equal(data.nothing, null)
  assert.equal(data.yes, true)
  assert.equal(data.no, false)
  assert.equal(data.count, 3)
  assert.equal(data.day.toISOString(), "2026-08-01T00:00:00.000Z")
  assert.equal(data.stamp.toISOString(), "2026-08-01T00:00:00.000Z")
  assert.equal(data.local.toISOString(), "2026-08-01T10:00:00.000Z")
  assert.equal(data.spaced.toISOString(), "2026-08-01T08:00:00.000Z")
  assert.equal(data.short_zone.toISOString(), "2026-07-31T23:00:00.000Z")
  assert.equal(data.quoted_stamp, "2026-08-01T00:00:00Z")
  assert.equal(data.scope, "billing; not payroll")
  assert.equal(data.list, null, "nested values are not parsed")
  assert.equal(content, "body line")
  assert.match(raw, /https:\/\/github\.com\/o\/r\/pull\/7/)
  assert.ok(raw.startsWith("\ndouble:"))
})

test("the fields the checks read agree with gray-matter on the review's edge cases", () => {
  for (const text of [
    '---\nstatus: "done" # note\n---\n',
    "---\nstatus: 'it''s' # x\n---\n",
    "---\nscope: >\n  billing disputes;\n  not payroll\n---\n",
    "---\nscope: >-\n  billing disputes;\n  not payroll\n\n  second\n---\n",
    "---\nscope: |\n  a\n  b\n---\n",
    "---\nscope: |+ # kept\n  a\n\n---\n",
    "---\nscope: >\nstatus: x\n---\n",
    "---\nupdated: 2026-08-01 10:00:00 +02:00\n---\n",
    "---\nupdated: 2026-08-01T10:00:00.5-0130\n---\n",
    "---\nupdated: 2026-08-01T10:00:00.5-01:30\n---\n",
    "---\nartifacts: [a,\n  b]\nstatus: x\n---\n",
    "---\nartifacts: {a: '[', b: \"]\"}\nstatus: x\n---\n",
    "---\nstatus: processing\n",
  ]) {
    sameAsGrayMatter(text, ["status", "updated", "scope"])
  }
})

test("a block gray-matter rejects is rejected, so the card is skipped on both paths", () => {
  for (const text of [
    "---\nstatus: a\nstatus: b\n---\n",
    '---\nstatus: "a\n---\n',
    "---\nstatus: 'a\n---\n",
    '---\nstatus: "a" b\n---\n',
    "---\ntitle: [unclosed\nstatus: processing\n---\n",
  ]) {
    assert.throws(() => grayMatterData(text), undefined, `gray-matter must reject ${JSON.stringify(text)}`)
    assert.throws(() => parseFrontmatterLite(text), /^Error: frontmatter: /, JSON.stringify(text))
  }
})

test("an unclosed frontmatter block runs to the end of the file, as under gray-matter", () => {
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
