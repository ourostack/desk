// The owner record decides whether a controller may be taken over: never while its owner runs.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { controllerIdentity } from "../../src/readiness/identity.js"
import { ownerLiveness, ownerState, readOwnerRecord } from "../../src/readiness/owner-record.js"
import { mkTempRoot } from "../_temp_roots.js"

const NOW = Date.parse("2026-09-26T12:00:00.000Z")
// Booted an hour before NOW.
const clock = { now: () => NOW, uptimeSeconds: () => 3600, selfPid: 100 }

function record(identity, owner) {
  return { schema_version: 1, identity, endpoint: "/tmp/x.sock", socket: { dev: 1, ino: 2 }, owner }
}

test("owner.json is missing, corrupt (unreadable, malformed, incomplete or another identity) or valid", async () => {
  const root = await mkTempRoot("desk-owner-record-")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  mkdirSync(path.join(root, "other"))
  const other = controllerIdentity({ root: path.join(root, "other"), protocolVersion: 1, lexicalContract: {} })
  const stateDir = path.join(root, "state")
  mkdirSync(stateDir, { recursive: true })
  assert.deepEqual(readOwnerRecord(stateDir), { status: "missing", record: null })
  writeFileSync(path.join(stateDir, "owner.json"), "{corrupt")
  assert.deepEqual(readOwnerRecord(stateDir), { status: "corrupt", record: null })
  const owner = { pid: 4242, token: "t", started_at: "2026-09-26T11:30:00.000Z" }
  for (const broken of [{ ...owner, pid: "4242" }, { ...owner, pid: 0 }, { ...owner, token: 7 }, { ...owner, started_at: 7 }, { ...owner, started_at: "later" }]) {
    writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify(record(identity, broken)))
    assert.equal(readOwnerRecord(stateDir, identity).status, "corrupt", JSON.stringify(broken))
  }
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify(record(identity, owner)))
  assert.equal(readOwnerRecord(stateDir, identity).status, "valid")
  assert.equal(readOwnerRecord(stateDir).status, "valid", "without an identity to match, any identity will do")
  assert.equal(readOwnerRecord(stateDir, other).status, "corrupt", "a record for another controller")
  const unreadable = path.join(root, "unreadable")
  mkdirSync(path.join(unreadable, "owner.json"), { recursive: true })
  assert.deepEqual(readOwnerRecord(unreadable), { status: "corrupt", record: null }, "a folder where owner.json should be")
})

test("an owner is this process, dead (no such process, or started before this boot) or alive (running, or another user's PID)", async () => {
  const owner = (pid, startedAt = "2026-09-26T11:30:00.000Z") => ({ owner: { pid, token: "t", started_at: startedAt } })
  const fails = (code) => () => { throw Object.assign(new Error(code), { code }) }
  const unread = { processStart: async () => { throw new Error("a record without a start time never reads one") } }
  assert.equal(await ownerLiveness(owner(100), { ...clock, kill: fails("ESRCH") }), "self")
  assert.equal(await ownerLiveness(owner(7), { ...clock, ...unread, kill: () => true }), "alive")
  assert.equal(await ownerLiveness(owner(7), { ...clock, kill: fails("ESRCH") }), "dead")
  assert.equal(await ownerLiveness(owner(7), { ...clock, ...unread, kill: fails("EPERM") }), "alive")
  assert.equal(await ownerLiveness(owner(7), { ...clock, ...unread, kill: fails("EINVAL") }), "alive", "anything but 'no such process' keeps the owner")
  // Booted at 11:00; a few minutes of clock slack are allowed.
  assert.equal(await ownerLiveness(owner(7, "2026-09-26T10:58:00.000Z"), { ...clock, ...unread, kill: () => true }), "alive")
  assert.equal(await ownerLiveness(owner(7, "2026-09-25T09:00:00.000Z"), { ...clock, kill: () => true }), "dead", "a PID from an earlier boot names some other process now")
  assert.equal(await ownerLiveness(owner(process.pid)), "self", "the defaults read this process")
})

test("an owner is its PID plus its start time: a live PID that started at another time is a later process that reused the PID", async () => {
  const owner = (processStart) => ({ owner: { pid: 7, token: "t", started_at: "2026-09-26T11:30:00.000Z", process_start: processStart } })
  const reads = []
  const startedAt = (value) => async (pid) => { reads.push(pid); return value }
  const fails = (code) => () => { throw Object.assign(new Error(code), { code }) }
  assert.equal(await ownerLiveness(owner("darwin:2026-09-26T11:29:59.000Z"), { ...clock, kill: () => true, processStart: startedAt("darwin:2026-09-26T11:29:59.000Z") }), "alive", "the same process")
  assert.equal(await ownerLiveness(owner("darwin:2026-09-26T11:29:59.000Z"), { ...clock, kill: () => true, processStart: startedAt("darwin:2026-09-26T11:50:00.000Z") }), "dead", "the PID was reused")
  assert.equal(await ownerLiveness(owner("darwin:2026-09-26T11:29:59.000Z"), { ...clock, kill: fails("EPERM"), processStart: startedAt("darwin:2026-09-26T11:50:00.000Z") }), "dead", "another user's process that reused the PID")
  assert.equal(await ownerLiveness(owner("darwin:2026-09-26T11:29:59.000Z"), { ...clock, kill: () => true, processStart: startedAt(null) }), "alive", "a start time that cannot be read keeps the owner")
  assert.deepEqual(reads, [7, 7, 7, 7])
  assert.equal(await ownerLiveness(owner(42), { ...clock, kill: () => true, processStart: startedAt("x") }), "alive", "a start time that is not text is no start time: the PID alone decides")
  assert.equal(reads.length, 4)
})

test("ownerState: a valid record names a live, dead or self owner; anything else passes its status through", async () => {
  const root = await mkTempRoot("desk-owner-state-")
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const stateDir = path.join(root, "state")
  mkdirSync(stateDir, { recursive: true })
  assert.equal((await ownerState({ stateDir, identity })).state, "missing")
  assert.equal((await ownerState({ stateDir })).state, "missing", "the identity is optional")
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify(record(identity, { pid: 7, token: "t", started_at: "2026-09-26T11:30:00.000Z" })))
  assert.equal((await ownerState({ stateDir, identity, ...clock, kill: () => true })).state, "live")
  assert.equal((await ownerState({ stateDir, identity, ...clock, kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }) } })).state, "dead")
  assert.equal((await ownerState({ stateDir, identity, ...clock, selfPid: 7 })).state, "self")
  assert.equal((await ownerState({ stateDir, identity, ...clock, kill: () => true })).record.owner.pid, 7)
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify(record(identity, { pid: 7, token: "t", started_at: "2026-09-26T11:30:00.000Z", process_start: "linux:boot:100" })))
  assert.equal((await ownerState({ stateDir, identity, ...clock, kill: () => true, processStart: async () => "linux:boot:900" })).state, "dead", "a reused PID")
  assert.equal((await ownerState({ stateDir, identity, ...clock, kill: () => true, processStart: async () => "linux:boot:100" })).state, "live")
})
