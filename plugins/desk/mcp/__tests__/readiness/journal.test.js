import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { mkTempRoot } from "../_temp_roots.js"
import { task_create, task_update, task_archive } from "../../src/tools/task.js"
import { track_create, track_update } from "../../src/tools/track.js"
import { friction_add } from "../../src/tools/friction.js"
import { lesson_add } from "../../src/tools/lesson.js"
import { callTool, connectOrStartController, createMcpServer, startServer } from "../../src/server.js"
import { main } from "../../index.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

async function fixture() {
  const root = await mkTempRoot("desk-journal-")
  const stateDir = path.join(root, "controller")
  const module = await import("../../src/readiness/journal.js").catch((error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
    return {}
  })
  assert.equal(typeof module.openChangeJournal, "function", "durable journal must exist")
  return { root, stateDir, open: (options = {}) => module.openChangeJournal({ root, stateDir, ...options }) }
}

const observedAt = "2026-09-19T16:00:00.000Z"

test("journal acknowledges only fsynced records and replays after restart", async () => {
  const f = await fixture()
  let syncs = 0
  const journal = await f.open({ io: { ...fs, fsyncSync(fd) { syncs++; fs.fsyncSync(fd) } } })
  const before = syncs
  const record = await journal.appendChange({ root: f.root, path: "track/task/task.md", operation: "write", observedAt })
  assert.ok(syncs > before, "acknowledgement requires file fsync")
  assert.deepEqual(record, { sequence: 1, path: "track/task/task.md", operation: "write", observed_at: observedAt })
  await journal.close()
  const restarted = await f.open()
  assert.deepEqual(restarted.replay().changes, [record])
  assert.equal((await restarted.appendChange({ path: "track/task/doing.md" })).sequence, 2)
  await restarted.close()
})

test("journal fsync failure is not acknowledged and poisons freshness", async () => {
  const f = await fixture()
  let fail = false
  const journal = await f.open({ io: { ...fs, fsyncSync(fd) {
    if (fail) throw new Error("injected disk sync failure")
    fs.fsyncSync(fd)
  } } })
  fail = true
  await assert.rejects(journal.appendChange({ path: "task.md" }), /disk sync failure/)
  assert.equal(journal.replay().certain, false)
  assert.equal(journal.replay().reason, "journal_write_failed")
  await assert.rejects(journal.appendChange({ path: "next.md" }), /journal.*recover/i)
  fail = false
  await journal.close()
})

test("journal retains append history but coalesces each path to its latest operation", async () => {
  const f = await fixture()
  const journal = await f.open()
  await journal.appendChange({ path: "track\\task\\task.md", observedAt })
  await journal.appendChange({ path: "other.md", observedAt })
  await journal.appendChange({ path: "track/task/task.md", operation: "delete", observedAt })
  assert.deepEqual(journal.replay().changes.map(({ sequence, path, operation }) => ({ sequence, path, operation })), [
    { sequence: 2, path: "other.md", operation: "write" },
    { sequence: 3, path: "track/task/task.md", operation: "delete" },
  ])
  assert.equal(fs.readFileSync(path.join(f.stateDir, "changes.jsonl"), "utf8").trim().split("\n").length, 3)
  await journal.close()
})

test("corrupt tail is quarantined, valid prefix replays, and cursor identity changes", async () => {
  const f = await fixture()
  const first = await f.open()
  await first.appendChange({ path: "task.md", observedAt })
  const oldCursor = first.cursor
  await first.close()
  fs.appendFileSync(path.join(f.stateDir, "changes.jsonl"), '{"sequence":2,"path":')
  const recovered = await f.open()
  const replay = recovered.replay()
  assert.equal(replay.reason, "journal_corrupt")
  assert.equal(replay.certain, false)
  assert.equal(replay.changes[0].path, "task.md")
  assert.notEqual(recovered.cursor.journal_id, oldCursor.journal_id)
  const quarantine = fs.readdirSync(f.stateDir).find((name) => name.startsWith("changes.corrupt-"))
  assert.ok(quarantine)
  assert.match(fs.readFileSync(path.join(f.stateDir, quarantine), "utf8"), /"path":$/)
  assert.equal((await recovered.appendChange({ path: "new.md" })).sequence, 2)
  await recovered.close()
})

test("unclean shutdown cannot claim external writes are covered by replay", async () => {
  const f = await fixture()
  const first = await f.open()
  await first.appendChange({ path: "known.md" })
  fs.writeFileSync(path.join(f.root, "external.md"), "# outside Desk\n")
  const restarted = await f.open()
  assert.equal(restarted.replay().reason, "unclean_shutdown")
  assert.equal(restarted.replay().certain, false)
  assert.deepEqual(restarted.replay().changes.map((change) => change.path), ["known.md"])
  assert.equal(fs.readFileSync(path.join(f.root, "external.md"), "utf8"), "# outside Desk\n")
  await restarted.close()
})

test("compaction requires committed matching generation coverage and preserves sequence on restart", async () => {
  const f = await fixture()
  const journal = await f.open()
  await journal.appendChange({ path: "a.md" })
  await journal.appendChange({ path: "b.md" })
  const covered = journal.cursor
  await journal.appendChange({ path: "c.md" })
  const db = new Database(":memory:")
  db.exec("CREATE TABLE lexical_generations (id INTEGER PRIMARY KEY, event_cursor TEXT NOT NULL)")
  try {
    assert.throws(() => journal.compact({ db, generationId: 1 }), /committed generation/)
    db.prepare("INSERT INTO lexical_generations VALUES (1, ?)").run(JSON.stringify(covered))
    assert.throws(() => db.transaction(() => journal.compact({ db, generationId: 1 }))(), /committed generation/)
    await journal.compact({ db, generationId: 1 })
    assert.deepEqual(journal.replay().changes.map((change) => change.path), ["c.md"])
    await journal.close()
    const restarted = await f.open()
    assert.equal((await restarted.appendChange({ path: "d.md" })).sequence, 4)
    assert.deepEqual(restarted.replay().changes.map((change) => change.path), ["c.md", "d.md"])
    db.prepare("UPDATE lexical_generations SET event_cursor = ?").run(JSON.stringify({ journal_id: "other", sequence: 99 }))
    assert.throws(() => restarted.compact({ db, generationId: 1 }), /coverage/)
    await restarted.close()
  } finally { db.close() }
})

test("journal rejects path escape, foreign roots, hard links and symlinked state directories", async () => {
  const f = await fixture()
  const journal = await f.open()
  for (const invalid of ["../escape.md", "/outside.md", "C:\\outside.md", "a/../escape.md", "a\0b", ""]) {
    await assert.rejects(journal.appendChange({ path: invalid }), /relative.*path/)
  }
  await assert.rejects(journal.appendChange({ root: path.dirname(f.root), path: "task.md" }), /root/)
  await journal.appendChange({ path: "task.md" })
  await journal.close()
  fs.linkSync(path.join(f.stateDir, "changes.jsonl"), path.join(f.root, "hardlink"))
  await assert.rejects(f.open(), /unsafe.*file/)
  const other = await fixture()
  const destination = path.join(other.root, "real")
  fs.mkdirSync(destination)
  fs.symlinkSync(destination, other.stateDir, "junction")
  await assert.rejects(other.open(), /unsafe.*directory/)
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test("canonical mutation cannot return success while durable recording is pending", async () => {
  const root = await mkTempRoot("desk-mutation-journal-")
  const entered = deferred()
  const release = deferred()
  let recorded = false
  let settled = false
  const readiness = { async recordChange(change) {
    assert.equal(change.path, "track/task/task.md")
    assert.match(fs.readFileSync(path.join(root, change.path), "utf8"), /Canonical title/)
    recorded = true
    entered.resolve()
    await release.promise
    return { recorded: true }
  } }
  const pending = task_create({ deskRoot: root, readiness, input: { track: "track", slug: "task", title: "Canonical title" } })
    .then((value) => { settled = true; return value })
  try {
    // The old implementation finishes without ever entering recordChange.
    await Promise.race([entered.promise, pending])
    assert.equal(recorded, true)
    assert.equal(settled, false)
    release.resolve()
    assert.equal((await pending).status, "created")
  } finally { release.resolve(); await pending }
})

const mutations = [
  ["task_create", task_create, { track: "track", slug: "task", title: "new" }, "track/task/task.md"],
  ["task_update", task_update, { track: "track", slug: "task", body_append: "updated" }, "track/task/task.md"],
  ["task_archive", task_archive, { track: "track", slug: "task" }, "track/_archive/task/task.md"],
  ["track_create", track_create, { slug: "track", title: "new" }, "track/track.md"],
  ["track_update", track_update, { slug: "track", body_append: "updated" }, "track/track.md"],
  ["friction_add", friction_add, { body: "new friction" }, "_meta/friction.md"],
  ["lesson_add", lesson_add, { topic: "Journal", body: "new lesson" }, "_meta/tips/journal.md"],
]

for (const [name, tool, input, changedPath] of mutations) {
  test(`${name} preserves canonical work and reports a typed partial operation on recording failure`, async () => {
    const root = await mkTempRoot("desk-mutation-journal-")
    if (name === "task_update" || name === "task_archive") {
      await task_create({ deskRoot: root, input: { track: "track", slug: "task", title: "before" } })
    }
    if (name === "track_update") await track_create({ deskRoot: root, input: { slug: "track", title: "before" } })
    const invalidations = []
    const readiness = {
      async recordChange() { throw new Error("injected journal unavailable") },
      async markUncertain(reason) { invalidations.push(reason) },
    }
    await assert.rejects(tool({ deskRoot: root, input, readiness }), (error) => {
      assert.equal(error.code, "canonical_write_recording_failed")
      assert.equal(error.canonical_written, true)
      assert.equal(error.journal_recorded, false)
      assert.equal(error.retryable, false)
      assert.match(error.message, /canonical.*written/i)
      assert.ok(error.paths.length > 0)
      return true
    })
    assert.equal(fs.existsSync(path.join(root, changedPath)), true)
    assert.deepEqual(invalidations, ["journal_write_failed"])
  })
}

test("normal MCP dispatch preserves partial-write fields and invalidation failure diagnostics", async () => {
  const root = await mkTempRoot("desk-mutation-dispatch-")
  const result = await callTool({
    deskRoot: root, name: "task_create", input: { track: "track", slug: "task", title: "kept" },
    statusContext: { admission: { controller: {
      async recordChange() { throw new Error("offline journal") },
      async markUncertain() { throw new Error("controller unreachable") },
    } } },
  })
  assert.equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  assert.equal(body.status, "partial_operation")
  assert.equal(body.code, "canonical_write_recording_failed")
  assert.equal(body.canonical_written, true)
  assert.equal(body.journal_recorded, false)
  assert.equal(body.retryable, false)
  assert.deepEqual(body.paths, ["track/task/task.md"])
  assert.match(body.invalidation_error, /controller unreachable/)
  assert.equal(fs.existsSync(path.join(root, "track", "task", "task.md")), true)
})

test("archive and legacy lesson rename record both removed and new paths", async () => {
  const root = await mkTempRoot("desk-mutation-moves-")
  const changes = []
  const readiness = { async recordChange(change) { changes.push(change); return { recorded: true } } }
  await task_create({ deskRoot: root, input: { track: "track", slug: "task", title: "before" } })
  await task_archive({ deskRoot: root, input: { track: "track", slug: "task" }, readiness })
  assert.deepEqual(changes.map(({ path, operation }) => ({ path, operation })), [
    { path: "track/task", operation: "delete" },
    { path: "track/_archive/task", operation: "write" },
    { path: "track/_archive/task/task.md", operation: "write" },
  ])
  changes.length = 0
  fs.mkdirSync(path.join(root, "_meta", "tips"), { recursive: true })
  fs.writeFileSync(path.join(root, "_meta", "tips", "Journal.md"), "# Journal\n\nbefore\n")
  await lesson_add({ deskRoot: root, input: { topic: "Journal", body: "after" }, readiness })
  // Existing filename-equivalence rules may retain case on case-insensitive hosts.
  assert.ok(changes.some((change) => change.operation === "write"))
  assert.match(fs.readFileSync(path.join(root, changes.at(-1).path), "utf8"), /after/)
})

test("failed canonical validation never appends a journal event", async () => {
  const root = await mkTempRoot("desk-mutation-validation-")
  let calls = 0
  await assert.rejects(task_create({
    deskRoot: root, input: { track: "..", slug: "task", title: "invalid" },
    readiness: { recordChange() { calls++ } },
  }))
  assert.equal(calls, 0)
  assert.deepEqual(fs.readdirSync(root), [])
})

test("invalid UTF-8 is quarantined byte-for-byte rather than accepted as a changed path", async () => {
  const f = await fixture()
  const journal = await f.open()
  await journal.appendChange({ path: "valid.md" })
  await journal.close()
  const corrupt = Buffer.concat([
    Buffer.from('{"sequence":2,"path":"'),
    Buffer.from([0xff]),
    Buffer.from('.md","operation":"write","observed_at":"2026-09-19T16:00:00.000Z"}\n'),
  ])
  fs.appendFileSync(path.join(f.stateDir, "changes.jsonl"), corrupt)
  const original = fs.readFileSync(path.join(f.stateDir, "changes.jsonl"))
  const recovered = await f.open()
  try {
    assert.equal(recovered.replay().reason, "journal_corrupt")
    const quarantined = fs.readdirSync(f.stateDir).find((name) => name.startsWith("changes.corrupt-"))
    assert.deepEqual(fs.readFileSync(path.join(f.stateDir, quarantined)), original)
    assert.deepEqual(recovered.replay().changes.map((change) => change.path), ["valid.md"])
  } finally { await recovered.close() }
})

test("live journal corruption invalidates a fence and prevents another successful append", async () => {
  const f = await fixture()
  const journal = await f.open()
  try {
    await journal.appendChange({ path: "valid.md" })
    journal.reconciled(journal.cursor)
    fs.appendFileSync(path.join(f.stateDir, "changes.jsonl"), "damaged tail")
    assert.equal(journal.replay().certain, false)
    assert.equal(journal.replay().reason, "journal_corrupt")
    await assert.rejects(journal.appendChange({ path: "later.md" }), /recover/)
  } finally { await journal.close() }
})

test("valid CRLF JSONL replays and remains appendable on either platform", async () => {
  const f = await fixture()
  const first = await f.open()
  await first.appendChange({ path: "first.md" })
  await first.close()
  const logPath = path.join(f.stateDir, "changes.jsonl")
  fs.writeFileSync(logPath, fs.readFileSync(logPath, "utf8").replaceAll("\n", "\r\n"))
  const restarted = await f.open()
  try {
    assert.equal(restarted.replay().reason, "watcher_downtime")
    assert.equal((await restarted.appendChange({ path: "second.md" })).sequence, 2)
    assert.deepEqual(restarted.replay().changes.map((change) => change.path), ["first.md", "second.md"])
  } finally { await restarted.close() }
})

for (const scenario of [
  { name: "workspace", policy: "workspace", expected: null },
  { name: "matching person", policy: "person", raw: "ari", expected: "ari" },
  { name: "matching provider", policy: "person", raw: "ari", provider: { mode: "person", person: "ari" }, expected: "ari" },
  { name: "provider-derived person", policy: "person", provider: { mode: "person", person: "ari" }, expected: "ari" },
]) {
  test(`admitted ${scenario.name} authority journals a real MCP mutation without widening writes`, async () => {
    const directory = await mkTempRoot("desk-journal-authority-")
    const root = path.join(directory, "workspace")
    fs.mkdirSync(root)
    const server = createMcpServer()
    const client = new Client({ name: "task4-authority", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    let controller
    let effectivePerson
    try {
      await main({
        argv: ["--root", root, ...(scenario.raw ? ["--person", scenario.raw] : [])],
        env: {},
        readinessPolicy: {
          write_authority: scenario.policy, semantic: "unsupported",
          authority_provider: scenario.provider ? "registry" : null,
        },
        authorityProviders: { registry: async () => scenario.provider },
        runtimeImporter: async () => ({
          async connectOrStartController(options) {
            controller = await connectOrStartController({
              ...options, stateHome: path.join(directory, "state"), ephemeral: true,
            })
            return controller
          },
          async startServer(options) {
            effectivePerson = options.person
            await startServer({ ...options, server, transport: serverTransport })
          },
        }),
      })
      await client.connect(clientTransport)
      const result = await client.callTool({
        name: "task_create",
        arguments: { track: "ops", slug: "bound", title: "durable", person: "bob" },
      })
      assert.equal(result.isError, undefined)
      assert.equal(effectivePerson, scenario.expected)
      const prefix = scenario.expected ? ["desks", scenario.expected] : []
      assert.equal(JSON.parse(result.content[0].text).path, path.join(...prefix, "ops", "bound", "task.md"))
      assert.equal(fs.existsSync(path.join(root, ...prefix, "ops", "bound", "task.md")), true)
      assert.equal(fs.existsSync(path.join(root, "desks", "bob")), false)
      await controller.barrier({ capability: "lexical", wait: true })
      assert.equal((await controller.status()).freshness.cursor.sequence, 1)
    } finally {
      await client.close()
      await server.close()
      await controller?.close()
    }
  })
}
