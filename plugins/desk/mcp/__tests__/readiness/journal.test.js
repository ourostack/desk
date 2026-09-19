import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { mkTempRoot } from "../_temp_roots.js"

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
