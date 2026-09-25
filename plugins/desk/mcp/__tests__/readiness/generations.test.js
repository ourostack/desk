import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { openDb, closeDb, getMeta, runMigrations } from "../../src/db/init.js"
import { connectOrStartController } from "../../src/server.js"
import { connectOrStartController as connectController } from "../../src/readiness/controller-client.js"
import { openChangeJournal } from "../../src/readiness/journal.js"
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

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

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

test("controller reports a forced generation after a fresh fast path as built", async () => {
  const directory = await mkTempRoot("desk-generation-status-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const client = await connectOrStartController({
    deskRoot: root, stateHome: path.join(directory, "state"), ephemeral: true,
    policy: { lexical: "required", semantic: "unsupported" },
  })
  try {
    await client.beginConvergence()
    const refreshed = await client.beginConvergence()
    assert.equal(refreshed.built, true, "status must describe the actual full lexical pass")
    assert.equal(refreshed.reason, "journal_reconciled")
  } finally { await client.close() }
})

test("support smoke: process restart replays durable mutations and discovers external downtime writes", async () => {
  const directory = await mkTempRoot("desk-task4-restart-")
  const root = path.join(directory, "workspace")
  const stateHome = path.join(directory, "state")
  fs.mkdirSync(root)
  const options = { deskRoot: root, stateHome, ephemeral: true, policy: { lexical: "required", semantic: "unsupported" } }
  const serverUrl = new URL("../../src/server.js", import.meta.url).href
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { connectOrStartController, callTool } from ${JSON.stringify(serverUrl)};
    const options = ${JSON.stringify(options)};
    const controller = await connectOrStartController(options);
    const result = await callTool({
      deskRoot: options.deskRoot, name: 'task_create',
      input: { track: 'track', slug: 'durable-task', title: 'durable mutation', body: 'kept across restart' },
      statusContext: { admission: { controller } },
    });
    if (result.isError) throw new Error(JSON.stringify(result));
    console.log(controller.id);
    process.exit(0); // Deliberately omit controller.close(): simulate an unclean owner exit.
  `], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  assert.equal(code, 0, stderr)
  const id = stdout.trim()
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateHome, id, "journal", "journal.json"))).clean_shutdown, false)
  const canonicalBefore = fs.readFileSync(path.join(root, "track", "durable-task", "task.md"), "utf8")
  fs.writeFileSync(path.join(root, "track", "durable-task", "doing.md"), "# external downtime write\n")
  const restarted = await connectOrStartController(options)
  try {
    assert.equal((await restarted.status()).state, "CONTROL_READY")
    await restarted.beginConvergence()
    assert.equal((await restarted.barrier({ capability: "lexical" })).current, true)
    const db = openDb(root)
    try {
      const docs = db.prepare("SELECT path FROM docs ORDER BY path").all().map((row) => row.path)
      assert.deepEqual(docs, [path.join("track", "durable-task", "doing.md"), path.join("track", "durable-task", "task.md")])
      assert.equal(JSON.parse(getMeta(db, "covered_event_cursor")).sequence, 1)
    } finally { closeDb(db) }
    assert.equal(fs.readFileSync(path.join(root, "track", "durable-task", "task.md"), "utf8"), canonicalBefore)
  } finally { await restarted.close() }
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
    // Even B with identical coverage supersedes A: the active generation must be checked.
    const generationB = commitLexicalGeneration({ db, documents: [], eventCursor: covered, identities })
    await assert.rejects(compacting, { code: "generation_superseded" })
    assert.equal(getMeta(db, "active_lexical_generation"), String(generationB))
    assert.deepEqual(fs.readFileSync(path.join(stateDir, "changes.jsonl")), original)
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

for (const [finding, failure] of [["F1", "generation_superseded"], ["F2", "journal_integrity_failed"]]) {
test(`${finding} failed compaction keeps controller barriers uncertain and schedules a fresh reconciliation`, async () => {
  const { commitLexicalGeneration } = await generationModule()
  const root = await mkTempRoot("desk-r1-generation-controller-")
  const db = openDb(root)
  const finished = deferred()
  const recovering = deferred()
  const release = deferred()
  let passes = 0
  let original
  const options = { root, stateHome: path.join(root, "state"), ephemeral: true, handlers: {
    async beginConvergence({ journal, eventCursor }) {
      const pass = ++passes
      if (pass === 3) { recovering.resolve(); await release.promise }
      const id = commitLexicalGeneration({ db, documents: [], eventCursor, identities })
      const compacting = journal.compact({ db, generationId: id })
      if (pass === 2) {
        if (failure === "journal_integrity_failed") {
          fs.appendFileSync(path.join(options.stateHome, client.id, "journal", "changes.jsonl"), "corrupt\n")
        }
        original = fs.readFileSync(path.join(options.stateHome, client.id, "journal", "changes.jsonl"))
        if (failure === "generation_superseded") {
          commitLexicalGeneration({ db, documents: [], eventCursor: null, identities })
        }
        try {
          await compacting
          finished.resolve(null)
        } catch (error) {
          finished.resolve(error.code)
          throw error
        }
      } else {
        await compacting
      }
      return { indexed: true }
    },
  } }
  const client = await connectController(options)
  try {
    await client.beginConvergence()
    await client.recordChange("task.md")
    assert.equal(await finished.promise, failure)
    await recovering.promise
    const status = await client.status()
    assert.equal(status.freshness.certain, false)
    assert.equal(status.freshness.reason, failure)
    assert.equal((await client.barrier({ capability: "lexical" })).current, false)
    const journalDir = path.join(options.stateHome, client.id, "journal")
    const evidenceFile = failure === "generation_superseded" ? "changes.jsonl"
      : fs.readdirSync(journalDir).find((name) => name.startsWith("changes.corrupt-"))
    assert.ok(evidenceFile)
    assert.deepEqual(fs.readFileSync(path.join(journalDir, evidenceFile)), original)
    release.resolve()
    assert.equal((await client.barrier({ capability: "lexical", wait: true })).current, true)
    assert.equal(passes, 3)
  } finally { release.resolve(); await client.close(); closeDb(db) }
})
}
