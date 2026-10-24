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

test("the index owner is the highest-ranked running build on this desk, from owner records and the last writer", async () => {
  const { indexOwner } = await import("../../../../../plugins/desk/mcp/src/readiness/index-writer.js")
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const home = await mkTempRoot("desk-index-owner-")
  const root = "/desks/personal"
  const self = { version: "3.2.0-alpha.348", build: "5".repeat(64), controller: "5".repeat(64) }
  const record = (name, body) => {
    mkdirSync(path.join(home, name), { recursive: true })
    if (body !== undefined) writeFileSync(path.join(home, name, "owner.json"), typeof body === "string" ? body : JSON.stringify(body))
  }
  const owner = { pid: 1, token: "t", started_at: "2026-10-23T00:00:00.000Z" }
  record(self.controller, { identity: { root, build: self.build }, owner, desk_version: self.version })
  record("a".repeat(64), { identity: { root, build: "a".repeat(64) }, owner, desk_version: "3.2.0-alpha.350" })
  record("b".repeat(64), { identity: { root, build: "b".repeat(64) }, owner, desk_version: "3.2.0-alpha.349" })
  record("c".repeat(64), { identity: { root, build: null }, owner, desk_version: "3.2.0-alpha.351" })
  record("d".repeat(64), { identity: { root: "/desks/other", build: "d".repeat(64) }, owner, desk_version: "9.0.0" })
  record("e".repeat(64), { identity: { root, build: "e".repeat(64) }, owner })
  record("f".repeat(64), "{not json")
  record("1".repeat(64))
  record("not-a-controller", { identity: { root }, owner, desk_version: "9.0.0" })
  const running = new Set(["a".repeat(64), "b".repeat(64)])
  const inspect = async ({ stateDir }) => ({ state: running.has(path.basename(stateDir)) ? "live" : "dead" })
  const stateDir = path.join(home, self.controller)

  // c ranks highest but has ended; a ranks next and runs. The other desk, the record without a version and the unreadable ones are not candidates.
  assert.deepEqual(await indexOwner({ self, root, stateDir, inspect }), { version: "3.2.0-alpha.350", build: "a".repeat(64), controller: "a".repeat(64) })
  running.delete("a".repeat(64))
  assert.equal((await indexOwner({ self, root, stateDir, inspect })).controller, "b".repeat(64))
  // The last writer counts too, once: here it is b itself, so b is not listed twice.
  const writerB = { version: "3.2.0-alpha.349", build: "b".repeat(64), controller: "b".repeat(64) }
  assert.equal((await indexOwner({ self, root, stateDir, inspect, indexWriter: writerB })).controller, "b".repeat(64))
  running.delete("b".repeat(64))
  assert.equal(await indexOwner({ self, root, stateDir, inspect }), null, "no higher build runs: this build owns the index")
  // A writer whose controller is unknown can never be checked, so it never stops this build from writing; this build as the last writer is no other owner.
  assert.equal(await indexOwner({ self, root, stateDir, inspect, indexWriter: { version: "9.0.0", build: null, controller: null } }), null)
  assert.equal(await indexOwner({ self, root, stateDir, inspect, indexWriter: self }), null)
  // A lower build is never the owner, and a missing state home means no other controller has run.
  running.add("2".repeat(64))
  record("2".repeat(64), { identity: { root, build: "2".repeat(64) }, owner, desk_version: "3.2.0-alpha.300" })
  assert.equal(await indexOwner({ self, root, stateDir, inspect }), null)
  assert.equal(await indexOwner({ self, root, stateDir: path.join(home, "missing", self.controller), inspect }), null)
  // Two running higher builds: the higher wins whichever order they are listed in.
  running.add("a".repeat(64))
  running.add("b".repeat(64))
  const listed = ["b".repeat(64), "a".repeat(64)]
  assert.equal((await indexOwner({ self, root, stateDir, inspect, list: () => listed })).controller, "a".repeat(64))
  assert.equal((await indexOwner({ self, root, stateDir, inspect, list: () => [...listed].reverse() })).controller, "a".repeat(64))
  // Two controllers of one build rank alike; the first listed is the owner.
  record("3".repeat(64), { identity: { root, build: "a".repeat(64) }, owner, desk_version: "3.2.0-alpha.350" })
  running.add("3".repeat(64))
  assert.equal((await indexOwner({ self, root, stateDir, inspect, list: () => ["3".repeat(64), "a".repeat(64)] })).controller, "3".repeat(64))
})

test("the index owner is named in one plain sentence", async () => {
  const { indexOwnerSentence } = await import("../../../../../plugins/desk/mcp/src/readiness/index-writer.js")
  assert.equal(indexOwnerSentence({ version: "3.2.0-alpha.349", this_controller: true }), "Desk 3.2.0-alpha.349 (this session) owns the search index.")
  assert.equal(indexOwnerSentence({ version: "3.2.0-alpha.349", this_controller: false }), "Desk 3.2.0-alpha.349 (another session) owns the search index; this session only reads it.")
  assert.equal(indexOwnerSentence(null), null)
  assert.equal(indexOwnerSentence({ version: null }), null)
})
