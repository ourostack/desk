import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { openDb, closeDb, getMeta, runMigrations } from "../../src/db/init.js"
import { connectOrStartController } from "../../src/server.js"
import { mkTempRoot } from "../_temp_roots.js"

const identities = {
  schema_version: 1,
  chunker_id: "fixture-chunker",
  normalization_id: "fixture-normalization",
  embedding_spec: { id: "fixture-embedding", dimension: 768 },
  tombstone_identity: "none",
  policy_identity: "fixture-policy",
}
const eventCursor = { journal_id: "fixture-journal", sequence: 42 }

async function generationModule() {
  const module = await import("../../src/readiness/generations.js").catch((error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
    return {}
  })
  assert.equal(typeof module.commitLexicalGeneration, "function", "coherent generation primitive must exist")
  return module
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

test("controller reconciliation hashes canonical files even when mtimes look fresh and compacts only covered events", async () => {
  const directory = await mkTempRoot("desk-generation-controller-")
  const root = path.join(directory, "workspace")
  const stateHome = path.join(directory, "controller")
  fs.mkdirSync(root)
  const file = path.join(root, "task.md")
  fs.writeFileSync(file, "# old content")
  const client = await connectOrStartController({
    deskRoot: root, stateHome, ephemeral: true,
    policy: { lexical: "required", semantic: "unsupported" },
  })
  try {
    await client.beginConvergence()
    const previous = fs.statSync(file)
    fs.writeFileSync(file, "# changed content")
    fs.utimesSync(file, previous.atime, previous.mtime)
    await client.recordChange("task.md")
    await client.barrier({ capability: "lexical", wait: true })
    const db = openDb(root)
    try {
      assert.equal(db.prepare("SELECT text FROM chunks").get().text, "# changed content")
      const generation = db.prepare("SELECT * FROM lexical_generations ORDER BY id DESC LIMIT 1").get()
      assert.equal(JSON.parse(generation.event_cursor).sequence, 1)
      assert.notEqual(generation.policy_identity, "desk-lexical-required-v1")
    } finally { closeDb(db) }
    const log = fs.readFileSync(path.join(stateHome, client.id, "journal", "changes.jsonl"), "utf8")
    assert.equal(JSON.parse(log.trim()).checkpoint, true)
  } finally { await client.close() }
})
