import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, rename, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { osEnv } from "../_os_env.js"

const api = await import("../../../../../plugins/desk/mcp/src/factory/copilot-turn-index.js").catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {}
  throw error
})
const SESSION = "12345678-1234-4123-8123-123456789abc"
const OTHER = "87654321-1234-4123-8123-123456789abc"
const UNTIL = "2026-10-28T15:11:08.000Z"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desk-turn-index-"))
  const env = osEnv({ COPILOT_HOME: join(root, "copilot") })
  await mkdir(env.COPILOT_HOME)
  const file = join(env.COPILOT_HOME, "session-store.db")
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT); CREATE TABLE turns (session_id TEXT, turn_index INTEGER, timestamp TEXT, user_message TEXT, assistant_response TEXT)")
  db.prepare("INSERT INTO sessions VALUES (?, ?)").run(SESSION, root)
  const insert = (index, user = "Explain the reader", response = "The result is still pending", timestamp = "2026-10-27 17:51:39", session = SESSION) =>
    db.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?)").run(session, index, timestamp, user, response)
  return { root, env, file, db, insert, read: () => api.readCopilotConversation({ env, sessionId: SESSION, recordedUntil: UNTIL, expectedDesk: root }) }
}

test("GivenNativeTurns_WhenRead_ReturnsOnlyThatSessionWithoutActionClocks", async t => {
  assert.equal(typeof api.readCopilotConversation, "function")
  const f = await fixture()
  t.after(() => f.db.close())
  f.insert(0)
  f.insert(1, null, null)
  f.insert(0, "OTHER PRIVATE CONTENT", null, undefined, OTHER)
  const value = f.read()
  assert.equal(value.status, "available")
  assert.deepEqual(value.turns, [
    { turn_index: 0, user_message: "Explain the reader", assistant_response: "The result is still pending" },
    { turn_index: 1, user_message: null, assistant_response: null },
  ])
  assert.equal(value.excluded_rows, 0)
  assert.match(value.digest, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(value).includes("17:51"))
  assert.ok(!JSON.stringify(value).includes("OTHER PRIVATE"))
})

test("GivenChangedOrUnrelatedRows_WhenRead_OnlyOwnContentChangesDigest", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  f.insert(0)
  const first = f.read().digest
  f.insert(0, "other", null, undefined, OTHER)
  assert.equal(f.read().digest, first)
  f.db.prepare("UPDATE turns SET assistant_response = ? WHERE session_id = ?").run("Changed retained reply", SESSION)
  assert.notEqual(f.read().digest, first)
})

test("GivenOutsideWindowOrUnknownIndexTimes_WhenRead_ExcludesAndCountsThem", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  f.insert(0)
  f.insert(1, "late", null, "2026-10-29T00:00:00Z")
  f.insert(2, "unknown", null, "not an instant")
  const value = f.read()
  assert.equal(value.status, "available")
  assert.equal(value.excluded_rows, 2)
  assert.equal(value.turns.length, 1)
  const digest = value.digest
  f.db.prepare("UPDATE turns SET user_message = 'changed excluded source' WHERE turn_index = 2").run()
  assert.notEqual(f.read().digest, digest)
})

test("GivenOnlyUncorrelatableTurns_WhenRead_ReportsNoAttributableTurns", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  f.insert(0, "later", null, "2026-10-29T00:00:00Z")
  assert.equal(f.read().status, "no_attributable_turns")
})

test("GivenIndexedRowsWithoutText_WhenRead_DoesNotClaimAvailableConversation", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  f.insert(0, null, null)
  assert.equal(f.read().status, "no_attributable_turns")
})

test("GivenOverRowLimit_WhenRead_ReturnsNoPartialText", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  for (let i = 0; i < 257; i++) f.insert(i)
  assert.equal(f.read().status, "too_large")
  assert.deepEqual(f.read().turns, [])
})

test("GivenOverRawTextOrProjectionLimit_WhenRead_ReturnsNoPrefix", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  f.insert(0, "x".repeat(2 * 1024 * 1024 + 1), null)
  assert.equal(f.read().status, "too_large")
  f.db.exec("DELETE FROM turns")
  f.insert(0, "x".repeat(256 * 1024), null)
  assert.equal(f.read().status, "too_large")
  assert.deepEqual(f.read().turns, [])
})

test("GivenLostOrUnsafeDatabase_WhenRead_DistinguishesMissingFromUnreadable", async () => {
  const f = await fixture()
  f.db.close()
  await rename(f.file, `${f.file}.retained`)
  assert.equal(f.read().status, "missing")
  await symlink(`${f.file}.retained`, f.file)
  assert.equal(f.read().status, "unreadable")
})

test("GivenMissingIdentityEmptyTurnsOrWrongSchema_WhenRead_ReportsExplicitStatus", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  assert.equal(f.read().status, "no_attributable_turns")
  f.db.exec("DELETE FROM sessions")
  assert.equal(f.read().status, "session_missing")
  f.db.exec("DROP TABLE sessions")
  assert.equal(f.read().status, "unreadable")
})

test("GivenMalformedIdentityOrClock_WhenRead_RefusesBeforeOpeningSource", () => {
  assert.throws(() => api.readCopilotConversation({ sessionId: "../other", recordedUntil: UNTIL }), TypeError)
  assert.throws(() => api.readCopilotConversation({ sessionId: SESSION, recordedUntil: "2026" }), TypeError)
})

test("GivenLocalFullShare_WhenIdentified_UsesNativeIdentityAndRefusesAmbiguousOwnership", () => {
  assert.equal(typeof api.copilotContextIdentity, "function")
  const local = { session: { host: "copilot-cli", id: SESSION, started_at: "2026-10-01T00:00:00Z", derived_through: "2026-10-01T00:00:02Z" },
    jobs: [{ job: "1".repeat(32), agents: [0, 1], segments: [{ start_ms: 0, end_ms: 2000 }] }] }
  assert.deepEqual(api.copilotContextIdentity(local), { session: SESSION, job: "1".repeat(32),
    started_at: "2026-10-01T00:00:00.000Z", duration_ms: 2000, full_share: true })
  local.jobs[0].segments[0].start_ms = 1
  assert.equal(api.copilotContextIdentity(local), null)
  local.jobs[0].segments[0].start_ms = 0
  local.jobs.push({ ...local.jobs[0], job: "2".repeat(32) })
  assert.equal(api.copilotContextIdentity(local), null)
})

test("GivenMalformedNativeRows_WhenRead_RefusesRatherThanCoercingThem", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  for (const index of [null, -1, 1.5, 9007199254740993n]) {
    f.db.exec("DELETE FROM turns")
    f.insert(index)
    assert.equal(f.read().status, "unreadable")
  }
  f.db.exec("DELETE FROM turns")
  f.insert(0)
  f.insert(0)
  assert.equal(f.read().status, "unreadable")
  f.db.exec("DELETE FROM turns")
  f.insert(0, Buffer.from("not a text value"), null)
  assert.equal(f.read().status, "unreadable")
})

test("GivenUnavailableDriver_WhenRead_ReportsItAndDoesNotHideUnexpectedFaults", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  const args = { env: f.env, sessionId: SESSION, recordedUntil: UNTIL, expectedDesk: f.root }
  const missing = Object.assign(new Error("runtime without SQLite"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" })
  assert.equal(api.readCopilotConversation({ ...args, load: () => { throw missing } }).reason, "driver_unavailable")
  assert.throws(() => api.readCopilotConversation({ ...args, load: () => { throw new Error("unexpected source fault") } }), /unexpected source fault/)
})

test("GivenIneligibleLocalBindings_WhenIdentified_RejectsForeignHostsClocksAndShares", () => {
  for (const local of [
    null,
    { session: { host: "claude-code", id: SESSION }, jobs: [] },
    { session: { host: "copilot-cli", id: "../foreign" }, jobs: [{}] },
    { session: { host: "copilot-cli", id: SESSION, started_at: "2026", derived_through: "2026" }, jobs: [{}] },
    { session: { host: "copilot-cli", id: SESSION, started_at: UNTIL, derived_through: UNTIL }, jobs: [{}] },
  ]) assert.equal(api.copilotContextIdentity(local), null)
})

test("GivenNativeIdentityFromAnotherDesk_WhenRead_RefusesItsConversation", async t => {
  const f = await fixture()
  t.after(() => f.db.close())
  f.insert(0, "not this desk", null)
  f.db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run(tmpdir(), SESSION)
  assert.equal(f.read().status, "not_eligible")
  assert.deepEqual(f.read().turns, [])
})
