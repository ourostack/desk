// The shared one-at-a-time lock: taking, refusing, taking over, releasing and listing child process ids.
// Every folder here is a throwaway; no process is ever signalled (liveness is an injected answer).

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { LOCK_OUTER_AGE_MS, processAlive, releaseLock, takeLock, touchLock, trackChild } from "../../../../../plugins/desk/mcp/src/factory/process-lock.js"

async function scratch(run) {
  const root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-process-lock-")))
  try {
    return await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const read = async (lock) => JSON.parse(await fs.readFile(lock.file, "utf8"))

test("a lock holds the holder's process id, start time, a token and the extra record; a second taker is refused", () => scratch(async (root) => {
  const lock = await takeLock(root, { name: "x.running", record: { children: [] } })
  assert.equal(path.basename(lock.file), "x.running")
  const record = await read(lock)
  assert.equal(record.pid, process.pid)
  assert.equal(record.token, lock.token)
  assert.deepEqual(record.children, [])
  assert.ok(Number.isFinite(Date.parse(record.started_at)))
  assert.equal(await takeLock(root, { name: "x.running", alive: () => true }), null)
  assert.ok(await takeLock(root, { name: "y.running" }), "another name is another lock")
}))

test("a clock that jumps forward does not let a second holder in while the recorded process is alive, but past the outer age it does", () => scratch(async (root) => {
  await takeLock(root, { name: "x.running" })
  const real = Date.now()
  const probed = []
  const alive = (pid) => { probed.push(pid); return true }
  assert.equal(await takeLock(root, { name: "x.running", alive, clock: () => real + 2 * 60 * 60 * 1000 }), null, "two hours on, the live holder still has it")
  assert.equal(await takeLock(root, { name: "x.running", alive, clock: () => real + LOCK_OUTER_AGE_MS - 60 * 1000 }), null)
  assert.deepEqual([...new Set(probed)], [process.pid], "only the recorded id is probed")
  assert.ok(await takeLock(root, { name: "x.running", alive, clock: () => real + LOCK_OUTER_AGE_MS + 60 * 1000 }), "past the outer age a recycled id cannot hold it")
}))

test("a lock whose process is gone is taken over; an unreadable record is held", () => scratch(async (root) => {
  const first = await takeLock(root, { name: "x.running" })
  const second = await takeLock(root, { name: "x.running", alive: () => false })
  assert.ok(second)
  assert.notEqual(second.token, first.token)
  await fs.writeFile(second.file, "not json")
  assert.equal(await takeLock(root, { name: "x.running", alive: () => false }), null)
}))

test("release removes the lock only while it holds the holder's own token", () => scratch(async (root) => {
  const lock = await takeLock(root, { name: "x.running" })
  await fs.writeFile(lock.file, JSON.stringify({ pid: 1, token: "someone-else" }))
  await releaseLock(lock)
  assert.equal((await read(lock)).token, "someone-else")
  await fs.writeFile(lock.file, JSON.stringify({ pid: 1, token: lock.token }))
  await releaseLock(lock)
  await assert.rejects(fs.stat(lock.file))
  await releaseLock(lock)
}))

test("touching a lock rewrites it unchanged for its own holder only, and a lock that is gone is left alone", () => scratch(async (root) => {
  const lock = await takeLock(root, { name: "t.running", record: { children: [7] } })
  const old = new Date(Date.now() - 60 * 60 * 1000)
  await fs.utimes(lock.file, old, old)
  const record = await read(lock)
  await touchLock({ file: lock.file, token: "not-mine" })
  assert.ok(Date.now() - (await fs.stat(lock.file)).mtimeMs > 50 * 60 * 1000, "another token does not refresh it")
  await touchLock(lock)
  assert.ok(Date.now() - (await fs.stat(lock.file)).mtimeMs < 60 * 1000, "its holder refreshes it")
  assert.deepEqual(await read(lock), record, "the record is unchanged")
  await releaseLock(lock)
  await touchLock(lock)
  await assert.rejects(fs.stat(lock.file), "a released lock is not written back")
}))

test("child ids are added and removed in the lock file, only for the holder's own token, and bad input changes nothing", () => scratch(async (root) => {
  const lock = await takeLock(root, { name: "x.running", record: { children: [] } })
  await trackChild(lock, 111, true)
  await trackChild(lock, 222, true)
  await trackChild(lock, 111, true)
  assert.deepEqual((await read(lock)).children, [222, 111])
  await trackChild(lock, 222, false)
  assert.deepEqual((await read(lock)).children, [111])
  await trackChild(lock, -3, true)
  await trackChild(lock, 1.5, true)
  await trackChild({ file: lock.file, token: "not-mine" }, 333, true)
  assert.deepEqual((await read(lock)).children, [111])
  await fs.writeFile(lock.file, JSON.stringify({ pid: process.pid, token: lock.token }))
  await trackChild(lock, 5, true)
  assert.deepEqual((await read(lock)).children, [5], "a record with no list starts one")
  for (let pid = 100; pid < 200; pid += 1) await trackChild(lock, pid, true)
  assert.equal((await read(lock)).children.length, 64, "the list is bounded")
  await fs.rm(lock.file)
  await trackChild(lock, 9, true)
  await assert.rejects(fs.stat(lock.file), "a missing lock is not recreated")
}))

test("the default liveness probe answers for this process, for a gone one and for one that may not be signalled", () => {
  assert.equal(processAlive(process.pid), true)
  const kill = process.kill
  try {
    process.kill = (pid, signal) => {
      assert.equal(signal, 0, "only the existence probe is ever sent")
      throw Object.assign(new Error("x"), { code: pid === 1 ? "EPERM" : "ESRCH" })
    }
    assert.equal(processAlive(1), true)
    assert.equal(processAlive(2), false)
  } finally {
    process.kill = kill
  }
})

test("a takeover that fails always removes its guard file, and the next taker is not held up by it", () => scratch(async (root) => {
  const dir = path.join(root, "locks")
  await fs.mkdir(path.join(dir, "x.running", "inside"), { recursive: true })
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
  await fs.utimes(path.join(dir, "x.running"), old, old)
  await assert.rejects(takeLock(root, { name: "x.running", alive: () => false }), "a lock path that is a directory cannot be removed")
  await assert.rejects(fs.stat(path.join(dir, "x.running.takeover")), "the guard is gone")
  await fs.rm(path.join(dir, "x.running"), { recursive: true })
  assert.ok(await takeLock(root, { name: "x.running" }))
}))
