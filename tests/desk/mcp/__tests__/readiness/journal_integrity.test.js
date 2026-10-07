import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { mkTempRoot } from "../_temp_roots.js"
import {
  CanonicalWriteRecordingError,
  JournalIntegrityError,
  ensurePrivateJournalDirectory,
  openChangeJournal,
  recordCanonicalChanges,
} from "../../../../../plugins/desk/mcp/src/readiness/journal.js"

const WHEN = "2026-09-19T16:00:00.000Z"

async function fixture(prefix = "desk-journal-integrity-") {
  const root = await mkTempRoot(prefix)
  const stateDir = path.join(root, "controller")
  return { root, realRoot: fs.realpathSync(root), stateDir }
}

const io = (overrides = {}) => ({ ...fs, ...overrides })
const withStat = (stat, patch) => Object.create(stat, Object.fromEntries(
  Object.entries(patch).map(([key, value]) => [key, { value }]),
))
const record = (sequence, extra = {}) => JSON.stringify({
  sequence, path: `file-${sequence}.md`, operation: "write", observed_at: WHEN, ...extra,
})
function seedState({ stateDir }, { log, meta }) {
  fs.mkdirSync(stateDir, { mode: 0o700 })
  fs.chmodSync(stateDir, 0o700)
  if (log !== undefined) fs.writeFileSync(path.join(stateDir, "changes.jsonl"), log, { mode: 0o600 })
  if (meta !== undefined) fs.writeFileSync(path.join(stateDir, "journal.json"), JSON.stringify(meta), { mode: 0o600 })
}
function compactionDb(cursor) {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE lexical_generations (id INTEGER PRIMARY KEY, event_cursor TEXT NOT NULL)")
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  db.prepare("INSERT INTO lexical_generations VALUES (1, ?)").run(JSON.stringify(cursor))
  db.prepare("INSERT INTO meta VALUES ('active_lexical_generation', '1')").run()
  db.prepare("INSERT INTO meta VALUES ('covered_event_cursor', ?)").run(JSON.stringify(cursor))
  return db
}

test("a state directory that other users can read is refused", { skip: process.platform === "win32" }, async () => {
  const f = await fixture()
  fs.mkdirSync(f.stateDir, { mode: 0o755 })
  fs.chmodSync(f.stateDir, 0o755)
  await assert.rejects(openChangeJournal({ root: f.root, stateDir: f.stateDir }), /unsafe state directory ownership or permissions/)
})

test("metadata for another root or without an identity is refused", async () => {
  const f = await fixture()
  seedState(f, { meta: { root: "/somewhere/else", id: "abc", clean_shutdown: true } })
  await assert.rejects(openChangeJournal({ root: f.root, stateDir: f.stateDir }), /metadata root or identity is invalid/)
  fs.writeFileSync(path.join(f.stateDir, "journal.json"), JSON.stringify({ root: f.realRoot, id: "" }), { mode: 0o600 })
  await assert.rejects(openChangeJournal({ root: f.root, stateDir: f.stateDir }), /metadata root or identity is invalid/)
})

test("a missing change log under existing metadata starts a new journal identity", async () => {
  const f = await fixture()
  seedState(f, { meta: { root: f.realRoot, id: "previous-id", clean_shutdown: true } })
  const journal = await openChangeJournal({ root: f.root, stateDir: f.stateDir })
  assert.equal(journal.replay().reason, "journal_integrity_failed")
  assert.notEqual(journal.cursor.journal_id, "previous-id")
  await journal.close()
})

test("a sequence gap or an invalid record quarantines the log and keeps the valid prefix", async () => {
  for (const log of [`${record(1)}\n${record(3)}\n`, `${record(1)}\n${record(2, { operation: "rename" })}\n`]) {
    const f = await fixture()
    seedState(f, { log })
    const journal = await openChangeJournal({ root: f.root, stateDir: f.stateDir })
    const replay = journal.replay()
    assert.equal(replay.reason, "journal_corrupt")
    assert.deepEqual(replay.changes.map((change) => change.path), ["file-1.md"])
    await journal.close()
  }
})

test("a journal file that is swapped while it is being read poisons the journal", async () => {
  for (const which of ["opened", "after"]) {
    const f = await fixture()
    const logPath = path.join(f.stateDir, "changes.jsonl")
    let swap = false
    let lstats = 0
    const journal = await openChangeJournal({
      root: f.root,
      stateDir: f.stateDir,
      io: io({
        fstatSync: (fd) => {
          const stat = fs.fstatSync(fd)
          return swap && which === "opened" ? withStat(stat, { ino: stat.ino + 1 }) : stat
        },
        lstatSync: (file, options) => {
          const stat = fs.lstatSync(file, options)
          if (swap && which === "after" && file === logPath && ++lstats === 2) return withStat(stat, { ino: stat.ino + 1 })
          return stat
        },
      }),
    })
    swap = true
    assert.throws(() => journal.replay(), { code: "journal_integrity_failed" })
  }
})

test("an append that opens a different file than it checked is refused and poisons the journal", async () => {
  const f = await fixture()
  let swapAt = Infinity
  let fstats = 0
  const journal = await openChangeJournal({
    root: f.root,
    stateDir: f.stateDir,
    io: io({
      fstatSync: (fd) => {
        const stat = fs.fstatSync(fd)
        return ++fstats === swapAt ? withStat(stat, { ino: stat.ino + 1 }) : stat
      },
    }),
  })
  swapAt = fstats + 2
  await assert.rejects(journal.appendChange({ path: "a.md" }), /unsafe replaced file/)
  assert.throws(() => journal.reconciled({ journal_id: journal.cursor.journal_id, sequence: 0 }), /must recover after a write failure/)
  assert.throws(() => journal.compact({ db: {}, generationId: 1 }), /must recover before compaction/)
})

test("a platform without O_NOFOLLOW still reads and appends", async () => {
  const f = await fixture()
  const journal = await openChangeJournal({
    root: f.root,
    stateDir: f.stateDir,
    io: io({ constants: { ...fs.constants, O_NOFOLLOW: undefined } }),
  })
  await journal.appendChange({ path: "a.md" })
  assert.deepEqual(journal.replay().changes.map((change) => change.path), ["a.md"])
  await journal.close()
})

test("a failed append that never opened the file poisons the journal without an integrity error", async () => {
  const f = await fixture()
  let failOpen = false
  const journal = await openChangeJournal({
    root: f.root,
    stateDir: f.stateDir,
    io: io({
      openSync: (file, flags, mode) => {
        if (failOpen && typeof flags === "number" && (flags & fs.constants.O_APPEND)) throw new Error("open refused")
        return fs.openSync(file, flags, mode)
      },
    }),
  })
  await journal.appendChange({ path: "a.md" })
  const cursor = journal.cursor
  const db = compactionDb(cursor)
  try {
    failOpen = true
    const failing = journal.appendChange({ path: "b.md" })
    const compacting = journal.compact({ db, generationId: 1 })
    await assert.rejects(failing, /open refused/)
    await assert.rejects(compacting, JournalIntegrityError)
    assert.throws(() => journal.reconciled(cursor), /must recover after a write failure/)
  } finally { db.close() }
})

test("reconciling with a different cursor leaves the journal uncertain", async () => {
  const f = await fixture()
  const journal = await openChangeJournal({ root: f.root, stateDir: f.stateDir })
  journal.reconciled(undefined)
  journal.reconciled({ journal_id: "other", sequence: 0 })
  assert.equal(journal.replay().certain, false)
  journal.reconciled(journal.cursor)
  assert.equal(journal.replay().certain, true)
  await journal.close()
})

test("closing after the state directory was removed does not recreate it", async () => {
  const f = await fixture()
  const journal = await openChangeJournal({ root: f.root, stateDir: f.stateDir })
  fs.rmSync(f.stateDir, { recursive: true })
  await journal.close()
  assert.equal(fs.existsSync(f.stateDir), false)
})

test("a write that fails mid-replacement closes the descriptor and removes the temporary file", async () => {
  const f = await fixture()
  let fail = false
  const journal = await openChangeJournal({
    root: f.root,
    stateDir: f.stateDir,
    io: io({
      writeFileSync: (target, contents, options) => {
        if (fail) throw new Error("disk full")
        return fs.writeFileSync(target, contents, options)
      },
    }),
  })
  fail = true
  await assert.rejects(journal.close(), /disk full/)
  assert.deepEqual(fs.readdirSync(f.stateDir).filter((name) => name.endsWith(".tmp")), [])
})

test("on Windows every created and existing journal path is protected", async () => {
  const f = await fixture()
  const protectedPaths = []
  let firstCall = true
  const protect = async (entries) => {
    if (firstCall) protectedPaths.push(...entries)
    firstCall = false
  }
  const first = await openChangeJournal({ root: f.root, stateDir: f.stateDir, platform: "win32", protect })
  await first.close()
  assert.ok(protectedPaths.length > 0)
  assert.ok(protectedPaths.every((entry) => entry.created === true))
  protectedPaths.length = 0
  firstCall = true
  const second = await openChangeJournal({ root: f.root, stateDir: f.stateDir, platform: "win32", protect })
  assert.deepEqual(protectedPaths.map((entry) => entry.kind), ["directory", "file", "file"])
  assert.ok(protectedPaths.every((entry) => entry.created === false))
  await second.close()
})

test("ensurePrivateJournalDirectory uses host defaults and rejects missing input", async () => {
  const f = await fixture()
  assert.equal(await ensurePrivateJournalDirectory({ stateDir: f.stateDir }), true)
  assert.equal(await ensurePrivateJournalDirectory({ stateDir: f.stateDir }), false)
  await assert.rejects(ensurePrivateJournalDirectory(), TypeError)
})

test("Windows directory publication handles a lost race and cleans up after other failures", async () => {
  const f = await fixture()
  const protect = async () => {}
  const code = (value) => Object.assign(new Error(value), { code: value })

  const lost = path.join(f.root, "lost")
  assert.equal(await ensurePrivateJournalDirectory({
    stateDir: lost, platform: "win32", protect,
    io: io({ renameSync: (from, to) => { fs.mkdirSync(to); throw code("EEXIST") } }),
  }), false)
  assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.includes(".creating-")), [])

  const refused = path.join(f.root, "refused")
  await assert.rejects(ensurePrivateJournalDirectory({
    stateDir: refused, platform: "win32", protect,
    io: io({ renameSync: () => { throw code("EPERM") } }),
  }), { code: "EPERM" })
  assert.deepEqual(fs.readdirSync(f.root).filter((name) => name.includes(".creating-")), [])

  const stuck = path.join(f.root, "stuck")
  await assert.rejects(ensurePrivateJournalDirectory({
    stateDir: stuck, platform: "win32", protect,
    io: io({ renameSync: () => { throw code("EIO") }, rmdirSync: () => { throw code("EBUSY") } }),
  }), { code: "EIO" })
})

test("a controller that does not acknowledge a change is reported as a recording failure", async () => {
  const marked = []
  await assert.rejects(recordCanonicalChanges({
    root: "/workspace",
    readiness: { recordChange: async () => ({ recorded: false }), markUncertain: async (reason) => { marked.push(reason) } },
    changes: [{ path: "a.md" }],
  }), (error) => error instanceof CanonicalWriteRecordingError && error.recorded_paths.length === 0)
  assert.deepEqual(marked, ["journal_write_failed"])
})

test("a recording error serializes a cause that is not an Error", () => {
  const error = new CanonicalWriteRecordingError({ paths: ["a.md"], recordedPaths: [], cause: "boom" })
  assert.equal(error.toJSON().recording_error, "boom")
})
