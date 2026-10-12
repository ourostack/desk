// last-start.json and the repair log live in Desk's state directory, never in the desk.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  appendRepairLog, createLastStartWriter, LAST_START_FILE, LAST_START_ROOTS_DIR, lastStartPath, lastStartRootKey, REPAIR_LOG_FILE, resolveDeskStateDir, resolveReadinessStateHome, writeLastStart,
} from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { existsSync } from "node:fs"
import { mkTempRoot } from "../_temp_roots.js"

test("the state directory follows XDG_STATE_HOME, then HOME, then the account home", () => {
  assert.equal(resolveDeskStateDir({ env: { XDG_STATE_HOME: "/x/state", HOME: "/h" } }), path.join("/x/state", "ouroboros-skills", "desk"))
  assert.equal(resolveDeskStateDir({ env: { HOME: "/h" } }), path.join("/h", ".local", "state", "ouroboros-skills", "desk"))
  assert.equal(resolveDeskStateDir({ env: { XDG_STATE_HOME: " " }, homeDir: "/given" }), path.join("/given", ".local", "state", "ouroboros-skills", "desk"))
  assert.equal(resolveDeskStateDir({ env: {} }), path.join(os.homedir(), ".local", "state", "ouroboros-skills", "desk"))
  assert.equal(resolveReadinessStateHome({ env: { HOME: "/h" } }), path.join("/h", ".cache", "ouroboros-skills", "desk", "readiness"))
  assert.equal(resolveReadinessStateHome({ env: {}, homeDir: "/given" }), path.join("/given", ".cache", "ouroboros-skills", "desk", "readiness"))
  assert.equal(resolveReadinessStateHome({ env: {} }), path.join(os.homedir(), ".cache", "ouroboros-skills", "desk", "readiness"))
  assert.equal(typeof resolveDeskStateDir(), "string")
  assert.equal(typeof resolveReadinessStateHome(), "string")
})

test("last-start.json is replaced atomically with state, code and repair, owner-only", async () => {
  const base = await mkTempRoot("desk-last-start-")
  const stateDir = path.join(base, "state")
  const snapshot = { state: "degraded:state_branch_detached", code: "state_branch_detached", repair: null, fix: "push it" }
  const file = await writeLastStart({ stateDir, snapshot, root: "/desk", pid: 42, now: () => new Date("2026-09-25T00:00:00Z") })
  assert.equal(path.basename(file), LAST_START_FILE)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    schema_version: 1, state: "degraded:state_branch_detached", code: "state_branch_detached", repair: null,
    fix: "push it", root: "/desk", pid: 42, updated_at: "2026-09-25T00:00:00.000Z",
  })
  const perRoot = path.join(stateDir, LAST_START_ROOTS_DIR, `${lastStartRootKey("/desk")}.json`)
  assert.equal(JSON.parse(readFileSync(perRoot, "utf8")).state, "degraded:state_branch_detached", "each root keeps its own record")
  assert.match(lastStartRootKey("/desk"), /^[0-9a-f]{16}$/u)
  assert.equal(lastStartPath({ stateDir }), path.join(stateDir, LAST_START_FILE), "no root: the shared record")
  assert.equal(lastStartPath({ stateDir, root: "/desk" }), perRoot)
  assert.notEqual(lastStartRootKey("/desk"), lastStartRootKey("/other-desk"))
  await writeLastStart({ stateDir, snapshot: { state: "ready", code: null, repair: "repaired: x", fix: null } })
  assert.equal(JSON.parse(readFileSync(perRoot, "utf8")).state, "degraded:state_branch_detached", "a record without a root leaves the per-root records alone")
  assert.equal(existsSync(path.join(stateDir, LAST_START_ROOTS_DIR)), true)
  const record = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(record.state, "ready")
  assert.equal(record.root, null)
  assert.equal(record.pid, process.pid)
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("the repair log gets one line per repair", async () => {
  const base = await mkTempRoot("desk-repair-log-")
  const stateDir = path.join(base, "state")
  appendRepairLog({ stateDir, line: "repaired: detached HEAD → main (was abc)", root: "/desk", now: () => new Date("2026-09-25T01:00:00Z") })
  const file = appendRepairLog({ stateDir, line: "repaired: second", root: "/desk" })
  assert.equal(path.basename(file), REPAIR_LOG_FILE)
  const lines = readFileSync(file, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.equal(lines[0], "2026-09-25T01:00:00.000Z /desk repaired: detached HEAD → main (was abc)")
})

test("the session's writer runs one write at a time, keeps the latest waiting record per root, writes the newest last, and keeps going after a failure", async () => {
  const written = []
  const errors = []
  let release
  const held = new Promise((resolve) => { release = resolve })
  const writer = createLastStartWriter({
    onError: (error) => errors.push(error.message),
    write: async ({ snapshot, root, now }) => {
      if (snapshot.state === "first") await held
      if (snapshot.state === "broken") throw new Error("disk full")
      written.push([root ?? null, snapshot.state, now().toISOString()])
    },
  })
  writer.record({ snapshot: { state: "first" }, root: "/a" })
  // Let the first write start (and hold); everything recorded now waits behind it.
  await new Promise((resolve) => setImmediate(resolve))
  writer.record({ snapshot: { state: "a-skipped" }, root: "/a" })
  writer.record({ snapshot: { state: "broken" }, root: "/b" })
  writer.record({ snapshot: { state: "shared" } })
  writer.record({ snapshot: { state: "a-latest" }, root: "/a" })
  const recordedBy = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(written, [], "a running write holds the ones after it")
  release()
  await writer.written()
  assert.deepEqual(written.map(([root, state]) => [root, state]), [["/a", "first"], [null, "shared"], ["/a", "a-latest"]],
    "the waiting /a record is replaced by the latest and, as the newest, written last")
  assert.ok(Date.parse(written[2][2]) <= recordedBy, "stamped when recorded, not 20 ms later when written")
  assert.deepEqual(errors, ["disk full"])
  // A record made while a write runs is still written, by the running drain or the next one.
  writer.record({ snapshot: { state: "late" }, root: "/c" })
  await writer.written()
  assert.deepEqual(written.at(-1).slice(0, 2), ["/c", "late"])
})

test("an error report that itself throws does not stop the records after it", async () => {
  const written = []
  const writer = createLastStartWriter({
    onError: () => { throw new Error("log closed") },
    write: async ({ snapshot }) => { if (snapshot.state === "broken") throw new Error("disk full"); written.push(snapshot.state) },
  })
  writer.record({ snapshot: { state: "broken" } })
  await writer.written()
  writer.record({ snapshot: { state: "after" } })
  await writer.written()
  assert.deepEqual(written, ["after"])
})

test("the real writer leaves the record in place, and a failed write leaves no temporary file behind", async () => {
  const base = await mkTempRoot("desk-last-start-writer-")
  const stateDir = path.join(base, "state")
  const writer = createLastStartWriter({ onError: assert.fail })
  writer.record({ stateDir, snapshot: { state: "ready", code: null, repair: null, fix: null }, root: "/desk" })
  await writer.written()
  assert.equal(JSON.parse(readFileSync(path.join(stateDir, LAST_START_FILE), "utf8")).state, "ready")
  // A directory where the record goes: the rename fails, and the temporary file it wrote is removed.
  mkdirSync(path.join(stateDir, LAST_START_ROOTS_DIR, `${lastStartRootKey("/blocked")}.json`), { recursive: true })
  const errors = []
  const failing = createLastStartWriter({ onError: (error) => errors.push(error.code) })
  failing.record({ stateDir, snapshot: { state: "ready", code: null, repair: null, fix: null }, root: "/blocked" })
  await failing.written()
  assert.equal(errors.length, 1)
  assert.deepEqual(readdirSync(path.join(stateDir, LAST_START_ROOTS_DIR)).filter((name) => name.endsWith(".tmp")), [])
  assert.deepEqual(readdirSync(stateDir).filter((name) => name.endsWith(".tmp")), [])
})
