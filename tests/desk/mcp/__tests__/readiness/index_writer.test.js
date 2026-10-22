// The search index records which Desk build wrote it, so two builds on one desk agree on one owner instead of taking the index from each other.

import { test } from "node:test"
import assert from "node:assert/strict"
import { indexWriterRecord, outranks, readIndexWriter } from "../../../../../plugins/desk/mcp/src/readiness/index-writer.js"

const cursor = { journal_id: "journal-a", sequence: 4 }

test("a writer record counts only for the generation written under its journal", () => {
  const record = indexWriterRecord({ version: "3.2.0-alpha.342", build: "b".repeat(64) }, cursor)
  assert.deepEqual(readIndexWriter(record, cursor), { version: "3.2.0-alpha.342", build: "b".repeat(64) })
  assert.equal(readIndexWriter(record, { journal_id: "journal-b", sequence: 4 }), null, "a build that records no writer wrote the index since")
  assert.equal(readIndexWriter(record, null), null)
  assert.equal(readIndexWriter(undefined, cursor), null)
  assert.equal(readIndexWriter("{not json", cursor), null)
  assert.equal(readIndexWriter("null", cursor), null)
  assert.deepEqual(readIndexWriter(JSON.stringify({ journal_id: "journal-a", version: 3, build: null }), cursor), { version: null, build: null })
})

test("the newer Desk version owns the index, and the build digest settles a tie", () => {
  const older = { version: "3.2.0-alpha.341", build: "f".repeat(64) }
  const newer = { version: "3.2.0-alpha.342", build: "0".repeat(64) }
  assert.equal(outranks(newer, older), true)
  assert.equal(outranks(older, newer), false, "version ranks before the digest")
  assert.equal(outranks({ ...older, build: "a".repeat(64) }, { ...older, build: "b".repeat(64) }), false)
  assert.equal(outranks({ ...older, build: "b".repeat(64) }, { ...older, build: "a".repeat(64) }), true)
  assert.equal(outranks({ version: null, build: "b" }, { version: "3.2.0", build: "a" }), true, "an unreadable version falls back to the digest")
  assert.equal(outranks({ version: null, build: null }, { version: null, build: "a" }), false)
  assert.equal(outranks({ version: null, build: "a" }, { version: null, build: null }), true)
  assert.equal(outranks({ version: null, build: null }, { version: null, build: null }), false, "the same build never outranks itself")
})
