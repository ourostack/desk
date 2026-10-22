// The search index records which Desk build wrote it, so two builds on one desk agree on one owner instead of taking the index from each other.

import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { indexWriterRecord, outranks, readIndexWriter, writerRuns } from "../../../../../plugins/desk/mcp/src/readiness/index-writer.js"

const cursor = { journal_id: "journal-a", sequence: 4 }

test("a writer record counts only for the generation written under its journal", () => {
  const record = indexWriterRecord({ version: "3.2.0-alpha.342", build: "b".repeat(64), controller: "c".repeat(64) }, cursor)
  assert.deepEqual(readIndexWriter(record, cursor), { version: "3.2.0-alpha.342", build: "b".repeat(64), controller: "c".repeat(64) })
  assert.equal(readIndexWriter(JSON.stringify({ journal_id: "journal-a", controller: "../elsewhere" }), cursor).controller, null, "only a controller id can name a state folder")
  assert.equal(readIndexWriter(record, { journal_id: "journal-b", sequence: 4 }), null, "a build that records no writer wrote the index since")
  assert.equal(readIndexWriter(record, null), null)
  assert.equal(readIndexWriter(undefined, cursor), null)
  assert.equal(readIndexWriter("{not json", cursor), null)
  assert.equal(readIndexWriter("null", cursor), null)
  assert.deepEqual(readIndexWriter(JSON.stringify({ journal_id: "journal-a", version: 3, build: null }), cursor), { version: null, build: null, controller: null })
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

test("a writer counts as running until its controller's owner record shows it has ended", async () => {
  const id = "c".repeat(64)
  const own = path.join("/state-home", "d".repeat(64))
  const seen = []
  const inspect = (state) => async ({ stateDir }) => { seen.push(stateDir); return { state } }
  assert.equal(await writerRuns({ controller: id }, own, { inspect: inspect("live") }), true)
  assert.equal(await writerRuns({ controller: id }, own, { inspect: inspect("self") }), true)
  assert.equal(await writerRuns({ controller: id }, own, { inspect: inspect("dead") }), false)
  assert.equal(await writerRuns({ controller: id }, own, { inspect: inspect("missing") }), false)
  assert.deepEqual([...new Set(seen)], [path.join("/state-home", id)], "the writer's folder sits beside this controller's")
  assert.equal(await writerRuns({ controller: null }, own, { inspect: inspect("dead") }), true, "an unknown writer is never displaced")
  assert.equal(await writerRuns({ controller: id }, undefined, { inspect: inspect("dead") }), true)
  assert.equal(await writerRuns({ controller: id }, own, { inspect: async () => { throw new Error("unreadable") } }), true)
  const home = await mkTempRoot("desk-writer-")
  assert.equal(await writerRuns({ controller: id }, path.join(home, "d".repeat(64))), false, "no owner record: the writer's sessions have ended")
})
