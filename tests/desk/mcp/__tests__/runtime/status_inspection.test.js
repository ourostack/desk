import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { createStatusInspection, inspectStatusDb, waitForStatusInspection } from "../../../../../plugins/desk/mcp/src/runtime/status-inspection.js"
import { attachStatusInspectionChild, inspectStatusInputs } from "../../../../../plugins/desk/mcp/src/runtime/status-inspection-child.js"
import { closeDb, indexDbPath, openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { callTool, ensureIndex } from "../../../../../plugins/desk/mcp/src/server.js"
import { mkTempRoot } from "../_temp_roots.js"
import { statusObservedSince } from "./_status_observation.js"

function childFixture(reply, { code = 0, error, sendError } = {}) {
  const child = new EventEmitter()
  child.killed = 0
  child.kill = () => {
    child.killed += 1
    setImmediate(() => child.emit("exit", null))
    return true
  }
  child.disconnect = () => setImmediate(() => child.emit("exit", code))
  child.send = (input, callback) => {
    if (sendError) return callback(sendError)
    callback(null)
    setImmediate(() => {
      if (error) child.emit("error", error)
      else {
        if (reply !== undefined) child.emit("message", reply)
        if (reply === undefined || code !== 0) child.emit("exit", code)
      }
    })
  }
  return child
}

test("native inspection returns plain current metadata, closes SQLite, and preserves null/missing states", async () => {
  const root = await mkTempRoot("status-inspect-")
  const missing = await inspectStatusDb(root)
  assert.equal(missing.local_db.state, "missing")
  assert.equal(await inspectStatusDb(root, { phase: "index" }), null)
  const db = openDb(root)
  closeDb(db)
  const result = await inspectStatusDb(root)
  assert.equal(result.local_db.state, "available")
  const index = await inspectStatusDb(root, { phase: "index" })
  assert.equal(index.generation, null)
  assert.equal(Object.hasOwn(index, "db"), false, "SQLite handles must never cross IPC")
  // Reopen and write after the child has exited: no held DB transaction or process.
  const reopened = openDb(root)
  reopened.exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('status_test', 'closed')")
  closeDb(reopened)
  const defaultReader = createStatusInspection(root)
  assert.equal((await defaultReader.inspect("local")).local_db.state, "available")
  await defaultReader.close()
})

test("corrupt DB and malformed generation retain their different diagnostic paths", async () => {
  const root = await mkTempRoot("status-inspect-errors-")
  mkdirSync(path.dirname(indexDbPath(root)), { recursive: true })
  writeFileSync(indexDbPath(root), "not SQLite")
  const corrupt = inspectStatusInputs({ deskRoot: root })
  assert.equal(corrupt.local_db.state, "corrupt")
  assert.throws(() => inspectStatusInputs({ deskRoot: root, phase: "index" }), { code: "SQLITE_NOTADB" })
  const directoryRoot = await mkTempRoot("status-inspect-directory-")
  mkdirSync(indexDbPath(directoryRoot), { recursive: true })
  const unreadable = (error) => error.name === "SqliteError" &&
    ["SQLITE_IOERR_READ", "SQLITE_CANTOPEN", "SQLITE_CANTOPEN_ISDIR"].includes(error.code)
  const { default: Database } = await import("better-sqlite3")
  assert.equal(unreadable(new Database.SqliteError("unable to open database file", "SQLITE_CANTOPEN_ISDIR")), true,
    "SQLite's Windows VFS reports opening a directory with the extended CANTOPEN_ISDIR code")
  assert.equal(unreadable(new Error("unable to open database file")), false)
  assert.equal(unreadable(new Database.SqliteError("file is not a database", "SQLITE_NOTADB")), false)
  assert.throws(() => inspectStatusInputs({ deskRoot: directoryRoot }), unreadable)
  await assert.rejects(inspectStatusDb(directoryRoot), unreadable)
  assert.throws(() => inspectStatusInputs({ deskRoot: root, phase: "unsupported" }), /unknown status inspection phase/u)
})

test("inspection child attaches only to an IPC port and reports success and exceptions explicitly", () => {
  assert.equal(attachStatusInspectionChild(null), false)
  for (const input of [{ deskRoot: "absent" }, null]) {
    const port = new EventEmitter()
    const replies = []
    port.send = (reply) => { replies.push(reply) }
    let exitCode = null
    port.exit = (code) => { exitCode = code }
    assert.equal(attachStatusInspectionChild(port), true)
    port.emit("message", input)
    assert.equal(replies[0].ok, input !== null)
    if (input === null) assert.equal(replies[0].error.name, "TypeError")
    port.emit("disconnect")
    assert.equal(exitCode, 0)
  }
})

test("inspection transport admits only successful replies after the owned process closes", async () => {
  const child = childFixture({ ok: true, value: { localDb: { state: "available" }, index: null } })
  const controller = new AbortController()
  const result = inspectStatusDb("root", { signal: controller.signal, spawn: () => child })
  const closed = waitForStatusInspection(controller.signal)
  assert.deepEqual(await result, { localDb: { state: "available" }, index: null })
  await closed
  await waitForStatusInspection(controller.signal)
  await waitForStatusInspection(new AbortController().signal)
})

test("inspection transport preserves auth/state/error fields rather than using success fallback", async () => {
  for (const error of [
    { name: "Error", message: "authority rejected", code: "AUTH", detail: { phase: "verify" } },
    { name: "RangeError", message: "invalid state", code: "SQLITE_CORRUPT" },
  ]) {
    const child = childFixture({ ok: false, error })
    await assert.rejects(inspectStatusDb("root", { spawn: () => child }), (actual) =>
      actual.message === error.message && actual.code === error.code && actual.name === error.name)
    assert.equal(child.killed, 0, "an ordinary inspection error closes its reader without overriding the diagnostic")
  }
})

test("inspection transport diagnoses invalid replies, exits, send failures and child exceptions", async () => {
  const cases = [
    [childFixture({ unknown: true }), /invalid reply/u],
    [childFixture(undefined), /exited before completing/u],
    [childFixture({ ok: true, value: {} }, { code: 1 }), /exited before completing/u],
    [childFixture(undefined, { error: new Error("spawn failed") }), /spawn failed/u],
    [childFixture(undefined, { sendError: new Error("channel refused") }), /channel refused/u],
  ]
  for (const [child, message] of cases) {
    await assert.rejects(inspectStatusDb("root", { spawn: () => child }), message)
  }
})

test("cancelled status inspection kills only its owned child and waits for that child's close", async () => {
  const cancelled = new AbortController()
  cancelled.abort(new Error("already cancelled"))
  assert.throws(() => inspectStatusDb("root", { signal: cancelled.signal }), /already cancelled/u)
  const controller = new AbortController()
  const child = new EventEmitter()
  child.send = (_, callback) => callback(null)
  child.disconnect = () => {}
  let killCalls = 0
  child.kill = () => { killCalls += 1; return true }
  const pending = inspectStatusDb("root", { signal: controller.signal, spawn: () => child })
  const closed = waitForStatusInspection(controller.signal)
  controller.abort(new Error("context replaced"))
  let finished = false
  closed.then(() => { finished = true }, () => { finished = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false)
  assert.equal(killCalls, 1)
  child.emit("exit", null)
  await assert.rejects(pending, /context replaced/u)
  await closed
  assert.equal(finished, true)
})

test("status generation metadata is sampled after controller observation, not ahead of it", async () => {
  const root = await mkTempRoot("status-observation-order-")
  writeFileSync(path.join(root, "task.md"), "# Generation observation ordering\n")
  await ensureIndex(root, { skipEmbed: true, snapshots: false, vectorPacks: false })
  const before = openDb(root)
  assert.ok(before.prepare("SELECT COUNT(*) AS n FROM chunks").get().n > 0)
  closeDb(before)
  let changed = false
  const controller = {
    async status() {
      if (!changed) {
        changed = true
        const db = openDb(root)
        db.prepare("DELETE FROM chunks").run()
        closeDb(db)
      }
      return { state: "READY", convergence: { status: "complete" } }
    },
  }
  const response = await callTool({ deskRoot: root, name: "desk_status", statusContext: { admission: { controller } } })
  assert.notEqual(response.isError, true)
  const payload = JSON.parse(response.content[0].text)
  assert.ok(payload.document_vectors.chunks_total > 0, "local inspection retains its original earlier sampling point")
  assert.equal(payload.semantic.missing_vectors, 0, "generation metadata must observe the later DB, after controller status")
})

test("the owned reader serializes its jobs and refuses use after close", async () => {
  const child = new EventEmitter()
  child.send = (_, callback) => callback(null)
  child.disconnect = () => { child.emit("exit", 0); child.emit("close", 0) }
  const reader = createStatusInspection("root", { spawn: () => child })
  const first = reader.inspect("local")
  await assert.rejects(reader.inspect("index"), /already running/u)
  child.emit("message", { ok: true, value: null })
  assert.equal(await first, null)
  await reader.close()
  await reader.close()
  await assert.rejects(reader.inspect("local"), /already closed/u)
})

test("an unsolicited reply and a spawn failure never become successful status", async () => {
  const child = new EventEmitter()
  child.kill = () => { child.emit("exit", 1); child.emit("close", 1) }
  child.disconnect = () => {}
  const reader = createStatusInspection("root", { spawn: () => child })
  child.emit("message", { ok: true, value: {} })
  await assert.rejects(reader.close(), /unexpected reply/u)
  await assert.rejects(reader.inspect("local"), /unexpected reply/u)
  assert.throws(() => createStatusInspection("root", { spawn() { throw new Error("spawn refused") } }), /spawn refused/u)
})

test("a close-only spawn error also retires its exact-owned reader", async () => {
  const child = new EventEmitter()
  child.send = (_, callback) => callback(null)
  child.kill = () => { child.emit("close", null) }
  child.disconnect = () => {}
  const reader = createStatusInspection("root", { spawn: () => child })
  const pending = reader.inspect("local")
  child.emit("error", new Error("native spawn error"))
  await assert.rejects(pending, /native spawn error/u)
  await assert.rejects(reader.close(), /native spawn error/u)
})

test("consumer qualification rejects old-root, old-time, undated and silently relabeled cached detail", () => {
  const recent = {
    root: { path: "root" }, readiness: { detail: {} },
    status_detail: "cached: completed same-context computation", status_detail_from: "2026-10-10T01:00:00.000Z",
  }
  const checkpoint = { root: "root", since: Date.parse("2026-10-10T00:59:59.999Z") }
  assert.equal(statusObservedSince(recent, checkpoint), true)
  assert.equal(statusObservedSince(recent, { ...checkpoint, since: checkpoint.since + 2 }), false)
  assert.equal(statusObservedSince(recent, { ...checkpoint, root: "old-root" }), false)
  assert.equal(statusObservedSince({ ...recent, status_detail_from: undefined }, checkpoint), false)
  assert.throws(() => statusObservedSince({ ...recent, status_detail: "fresh" }, checkpoint), /cached/u)
  assert.throws(() => statusObservedSince({ ...recent, status_detail: undefined }, checkpoint))
})
