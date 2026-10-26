import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { openDb, closeDb, getMeta, setMeta, runMigrations } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { openChangeJournal } from "../../../../../plugins/desk/mcp/src/readiness/journal.js"
import { mkTempRoot } from "../_temp_roots.js"
import {
  RETAINED_LEXICAL_GENERATIONS, commitLexicalGeneration, generationContent, readGenerationContent, withActiveLexicalGeneration,
} from "../../../../../plugins/desk/mcp/src/readiness/generations.js"

const identities = {
  schema_version: 1,
  chunker_id: "fixture-chunker",
  normalization_id: "fixture-normalization",
  embedding_spec: { id: "fixture-embedding", dimension: 768 },
  tombstone_identity: "none",
  policy_identity: "fixture-policy",
}
const eventCursor = { journal_id: "fixture-journal", sequence: 42 }

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function generationModule() {
  return { RETAINED_LEXICAL_GENERATIONS, commitLexicalGeneration, generationContent, readGenerationContent, withActiveLexicalGeneration }
}

test("generation tables migrate idempotently and use durable SQLite commits", async () => {
  const root = await mkTempRoot("desk-generation-")
  const db = openDb(root)
  try {
    runMigrations(db)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    assert.ok(tables.includes("lexical_generations"))
    assert.ok(tables.includes("readiness_operations"))
    assert.equal(db.pragma("synchronous", { simple: true }), 2, "compaction requires FULL durability")
  } finally { closeDb(db) }
})

test("generation persists exact identities, document hashes, completion and coverage together", async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-generation-")
  const db = openDb(root)
  try {
    const documents = [{ path: "task.md", hash: "sha256:fixture" }]
    const id = commitLexicalGeneration({ db, documents, eventCursor, identities, apply() {
      db.prepare("INSERT INTO docs(path, kind, hash, mtime) VALUES (?, 'task', ?, 1)")
        .run("task.md", "sha256:fixture")
    } })
    const row = db.prepare("SELECT * FROM lexical_generations WHERE id = ?").get(id)
    assert.equal(row.schema_version, 1)
    assert.equal(row.chunker_id, "fixture-chunker")
    assert.equal(row.normalization_id, "fixture-normalization")
    assert.deepEqual(JSON.parse(row.embedding_spec), identities.embedding_spec)
    assert.equal(row.tombstone_identity, "none")
    assert.equal(row.policy_identity, "fixture-policy")
    assert.deepEqual(JSON.parse(row.documents), documents)
    assert.deepEqual(JSON.parse(row.event_cursor), eventCursor)
    assert.ok(Number.isFinite(Date.parse(row.completed_at)))
    assert.equal(getMeta(db, "active_lexical_generation"), String(id))
    assert.deepEqual(JSON.parse(getMeta(db, "covered_event_cursor")), eventCursor)
    const operation = db.prepare("SELECT * FROM readiness_operations WHERE id = ?").get(row.operation_id)
    assert.equal(operation.status, "committed")
    assert.equal(operation.completed_at, row.completed_at)
    closeDb(db)
    const restarted = openDb(root)
    try { assert.equal(getMeta(restarted, "active_lexical_generation"), String(id)) } finally { closeDb(restarted) }
  } finally { closeDb(db) }
})

test("invalid generation identities and cursors cannot bless document state", async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-generation-")
  const db = openDb(root)
  try {
    for (const invalid of [{ ...identities, policy_identity: "" }, { ...identities, schema_version: null }]) {
      assert.throws(() => commitLexicalGeneration({ db, documents: [], eventCursor, identities: invalid }), /identit/)
    }
    for (const cursor of [{ journal_id: "", sequence: 1 }, { journal_id: "j", sequence: -1 }, { journal_id: "j", sequence: 0.5 }]) {
      assert.throws(() => commitLexicalGeneration({ db, documents: [], eventCursor: cursor, identities }), /cursor/)
    }
    assert.throws(() => commitLexicalGeneration({
      db, documents: [{ path: "missing.md", hash: "not-in-db" }], eventCursor, identities,
    }), /document/)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lexical_generations").get().n, 0)
  } finally { closeDb(db) }
})

test("a generation refuses an enclosing transaction, malformed documents and an asynchronous apply", async () => {
  const { commitLexicalGeneration, withActiveLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-generation-")
  const db = openDb(root)
  try {
    assert.throws(() => db.transaction(() => commitLexicalGeneration({ db, documents: [], eventCursor, identities }))(),
      /a lexical generation must own its commit/)
    for (const documents of ["task.md", [{ path: "task.md" }], [{ path: "task.md", hash: "a" }, { path: "task.md", hash: "b" }]]) {
      assert.throws(() => commitLexicalGeneration({ db, documents, eventCursor, identities }), /invalid lexical generation documents/)
    }
    assert.throws(() => commitLexicalGeneration({ db, documents: [], eventCursor, identities, apply: () => Promise.resolve() }),
      /apply must be synchronous/)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lexical_generations").get().n, 0)
    const generationId = commitLexicalGeneration({ db, documents: [], eventCursor, identities })
    let replaced = false
    assert.throws(() => db.transaction(() => withActiveLexicalGeneration({ db, generationId, eventCursor }, () => { replaced = true }))(),
      /journal compaction requires a committed generation/)
    assert.equal(replaced, false)
  } finally { closeDb(db) }
})

test("compaction treats an unreadable covered cursor as superseded and rethrows any other cursor failure", async () => {
  const { commitLexicalGeneration, withActiveLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-generation-")
  const db = openDb(root)
  try {
    const generationId = commitLexicalGeneration({ db, documents: [], eventCursor, identities })
    let replaced = false
    const replace = () => { replaced = true }
    // A caller without an expected cursor is a programming error, not a superseded generation.
    assert.throws(() => withActiveLexicalGeneration({ db, generationId, eventCursor: undefined }, replace), TypeError)
    setMeta(db, "covered_event_cursor", "{not json")
    assert.throws(() => withActiveLexicalGeneration({ db, generationId, eventCursor }, replace), { code: "generation_superseded" })
    assert.equal(replaced, false)
  } finally { closeDb(db) }
})

test("a failure at SQLite COMMIT rolls back generation, operations and canonical-index changes", async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-generation-")
  const db = openDb(root)
  try {
    const before = commitLexicalGeneration({ db, documents: [], eventCursor, identities })
    db.exec(`CREATE TABLE commit_guard (
      doc_id INTEGER REFERENCES docs(id) DEFERRABLE INITIALLY DEFERRED
    )`)
    assert.throws(() => commitLexicalGeneration({
      db, documents: [], eventCursor: { ...eventCursor, sequence: 43 }, identities,
      apply() { db.exec("INSERT INTO commit_guard VALUES (999)") },
    }), /FOREIGN KEY/)
    assert.equal(getMeta(db, "active_lexical_generation"), String(before))
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lexical_generations").get().n, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM readiness_operations").get().n, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM commit_guard").get().n, 0)
  } finally { closeDb(db) }
})

test("each generation records its writer, and only the newest generations are kept", async () => {
  const { commitLexicalGeneration, RETAINED_LEXICAL_GENERATIONS } = await generationModule()
  const root = await mkTempRoot("desk-generation-")
  const db = openDb(root)
  try {
    const writer = { version: "3.2.0-alpha.342", build: "b".repeat(64), controller: "c".repeat(64) }
    assert.equal(getMeta(db, "index_writer"), null)
    commitLexicalGeneration({ db, documents: [], eventCursor, identities, writer })
    assert.deepEqual(JSON.parse(getMeta(db, "index_writer")), { journal_id: eventCursor.journal_id, ...writer })
    commitLexicalGeneration({ db, documents: [], identities, writer })
    assert.equal(getMeta(db, "index_writer"), null, "a generation without a journal names no writer")
    commitLexicalGeneration({ db, documents: [], eventCursor, identities, writer })
    commitLexicalGeneration({ db, documents: [], eventCursor, identities })
    assert.equal(getMeta(db, "index_writer"), null, "a commit that names no writer clears the last one")

    let last
    for (let sequence = 0; sequence < RETAINED_LEXICAL_GENERATIONS + 4; sequence += 1) {
      last = commitLexicalGeneration({ db, documents: [], eventCursor: { ...eventCursor, sequence }, identities, writer })
    }
    const ids = db.prepare("SELECT id FROM lexical_generations ORDER BY id").all().map((row) => row.id)
    assert.equal(ids.length, RETAINED_LEXICAL_GENERATIONS)
    assert.equal(ids.at(-1), last)
    assert.equal(ids[0], last - RETAINED_LEXICAL_GENERATIONS + 1)
    assert.equal(getMeta(db, "active_lexical_generation"), String(last))
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM readiness_operations").get().n, RETAINED_LEXICAL_GENERATIONS,
      "the operation row of each removed generation goes with it")
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM lexical_generations g
      JOIN readiness_operations o ON o.id = g.operation_id`).get().n, RETAINED_LEXICAL_GENERATIONS)
  } finally { closeDb(db) }
})

test("F1 compaction rejects generation A when B becomes active before queued compaction", async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-r1-generation-")
  const stateDir = path.join(root, "journal")
  const journal = await openChangeJournal({ root, stateDir })
  const db = openDb(root)
  try {
    await journal.appendChange({ path: "task.md" })
    const original = fs.readFileSync(path.join(stateDir, "changes.jsonl"))
    const covered = journal.cursor
    const generationA = commitLexicalGeneration({ db, documents: [], eventCursor: covered, identities })
    const compacting = journal.compact({ db, generationId: generationA })
    // Even B with identical coverage supersedes A when it indexes the desk differently: the active generation must be checked.
    const generationB = commitLexicalGeneration({ db, documents: [], eventCursor: covered, identities: { ...identities, policy_identity: "other-policy" } })
    await assert.rejects(compacting, { code: "generation_superseded" })
    assert.equal(getMeta(db, "active_lexical_generation"), String(generationB))
    assert.deepEqual(fs.readFileSync(path.join(stateDir, "changes.jsonl")), original)
  } finally { await journal.close(); closeDb(db) }
})

test("compaction goes ahead when another Desk build committed a generation with the same content", async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-r1-generation-")
  const stateDir = path.join(root, "journal")
  const journal = await openChangeJournal({ root, stateDir })
  const db = openDb(root)
  try {
    await journal.appendChange({ path: "task.md" })
    const generationA = commitLexicalGeneration({ db, documents: [], eventCursor: journal.cursor, identities })
    const compacting = journal.compact({ db, generationId: generationA })
    // An older build that cannot stand aside commits the unchanged desk under its own journal and records no writer.
    const generationB = commitLexicalGeneration({ db, documents: [], eventCursor: { journal_id: "older-build", sequence: 7 }, identities })
    await compacting
    assert.equal(getMeta(db, "active_lexical_generation"), String(generationB))
    assert.deepEqual(journal.replay().changes, [], "the change log is cleaned up: B covers the same desk as A")
  } finally { await journal.close(); closeDb(db) }
})

test("F1 compaction rechecks expected cursor identity after staging and immediately before replacement", async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-r1-generation-")
  const stateDir = path.join(root, "journal")
  const db = openDb(root)
  const writer = openDb(root)
  let race = null
  const journal = await openChangeJournal({ root, stateDir, io: {
    ...fs, fsyncSync(fd) { fs.fsyncSync(fd); const intervene = race; race = null; intervene?.() },
  } })
  try {
    await journal.appendChange({ path: "task.md" })
    const original = fs.readFileSync(path.join(stateDir, "changes.jsonl"))
    const generationA = commitLexicalGeneration({ db, documents: [], eventCursor: journal.cursor, identities })
    race = () => {
      const replaced = JSON.stringify({ journal_id: "foreign-journal", sequence: 1 })
      writer.transaction(() => {
        writer.prepare("UPDATE lexical_generations SET event_cursor = ? WHERE id = ?").run(replaced, generationA)
        writer.prepare("UPDATE meta SET value = ? WHERE key = 'covered_event_cursor'").run(replaced)
      })()
    }
    await assert.rejects(journal.compact({ db, generationId: generationA }), { code: "generation_superseded" })
    assert.equal(race, null, "the change must happen during staging, not before compact was called")
    assert.deepEqual(fs.readFileSync(path.join(stateDir, "changes.jsonl")), original)
  } finally { race = null; await journal.close(); closeDb(writer); closeDb(db) }
})

test("F1 another SQLite writer cannot advance the generation inside journal replacement", async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-r1-generation-")
  const stateDir = path.join(root, "journal")
  const db = openDb(root)
  const writer = openDb(root)
  writer.pragma("busy_timeout = 0")
  let competingWrite = null
  let attempted = false
  const journal = await openChangeJournal({ root, stateDir, io: {
    ...fs, renameSync(source, target) {
      if (competingWrite && target === path.join(stateDir, "changes.jsonl")) {
        attempted = true
        assert.throws(competingWrite, { code: "SQLITE_BUSY" })
      }
      fs.renameSync(source, target)
    },
  } })
  try {
    await journal.appendChange({ path: "task.md" })
    const generationA = commitLexicalGeneration({ db, documents: [], eventCursor: journal.cursor, identities })
    competingWrite = () => commitLexicalGeneration({ db: writer, documents: [], eventCursor: null, identities })
    await journal.compact({ db, generationId: generationA })
    assert.equal(attempted, true)
    assert.equal(getMeta(db, "active_lexical_generation"), String(generationA))
    assert.deepEqual(journal.replay().changes, [])
    competingWrite = null
    assert.ok(commitLexicalGeneration({ db: writer, documents: [], eventCursor: null, identities }) > generationA)
  } finally { competingWrite = null; await journal.close(); closeDb(writer); closeDb(db) }
})

test("a generation's content ignores document order and how the embedding settings are stored", async () => {
  const { generationContent } = await generationModule()
  const docs = [{ path: "b.md", hash: "sha256:b" }, { path: "a.md", hash: "sha256:a" }, { path: "a.md", hash: "sha256:a" }]
  const content = generationContent(docs, identities)
  assert.match(content, /^sha256:[0-9a-f]{64}$/)
  assert.equal(generationContent([...docs].reverse(), identities), content, "the same documents in another order are the same content")
  const stored = { ...identities, embedding_spec: JSON.stringify(identities.embedding_spec) }
  assert.notEqual(generationContent(docs, stored), generationContent(docs, { ...stored, policy_identity: "other-policy" }), "other settings are other content")
  assert.notEqual(generationContent(docs.slice(1), identities), content, "other documents are other content")
})

test("a stored generation's content is unknown when its row is gone or its documents are unreadable", async () => {
  const { commitLexicalGeneration, generationContent, readGenerationContent } = await generationModule()
  const root = await mkTempRoot("desk-generation-content-")
  const db = openDb(root)
  try {
    const documents = [{ path: "task.md", hash: "sha256:fixture" }]
    const id = commitLexicalGeneration({ db, documents, eventCursor, identities, apply() {
      db.prepare("INSERT INTO docs(path, kind, hash, mtime) VALUES (?, 'task', ?, 1)").run("task.md", "sha256:fixture")
    } })
    const stored = db.prepare("SELECT * FROM lexical_generations WHERE id = ?").get(id)
    assert.equal(readGenerationContent(db, id), generationContent(documents, stored))
    assert.equal(readGenerationContent(db, id), generationContent(documents, stored), "a second read of the same row is answered from the cache")
    assert.equal(readGenerationContent(db, id + 100), null)
    db.prepare("UPDATE lexical_generations SET documents = ? WHERE id = ?").run("not json", id)
    assert.equal(readGenerationContent(db, id), null)
    db.prepare("UPDATE lexical_generations SET documents = ? WHERE id = ?").run("{}", id)
    assert.equal(readGenerationContent(db, id), null)
  } finally { closeDb(db) }
})
