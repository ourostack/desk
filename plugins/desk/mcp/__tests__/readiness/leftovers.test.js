// Leftover readiness-controller folders are pruned only when their owner is dead and their root is gone.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, linkSync, lstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { onUnmountedVolume, processIsAlive, pruneReadinessLeftovers, socketAccepts } from "../../src/readiness/leftovers.js"
import { mkTempRoot } from "../_temp_roots.js"

const id = (digit) => digit.repeat(64)

function controllerDir(stateHome, name, { owner, journalRoot } = {}) {
  const dir = path.join(stateHome, name)
  mkdirSync(path.join(dir, "journal"), { recursive: true })
  if (owner !== undefined) writeFileSync(path.join(dir, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner))
  if (journalRoot !== undefined) writeFileSync(path.join(dir, "journal", "journal.json"), JSON.stringify({ id: "j", root: journalRoot }))
  return dir
}

test("prunes dead-owner folders whose root is gone, and keeps everything else", async () => {
  const base = await mkTempRoot("desk-leftovers-")
  const stateHome = path.join(base, "readiness")
  const liveRoot = path.join(base, "live-root")
  mkdirSync(liveRoot)
  const goneRoot = path.join(base, "gone-root")
  const dead = 999999
  const alive = (pid) => pid === process.pid
  const prunedOwner = controllerDir(stateHome, id("a"), { owner: { identity: { root: goneRoot }, owner: { pid: dead } } })
  const prunedJournal = controllerDir(stateHome, id("b"), { journalRoot: goneRoot })
  const liveOwner = controllerDir(stateHome, id("c"), { owner: { identity: { root: goneRoot }, owner: { pid: process.pid } } })
  const rootExists = controllerDir(stateHome, id("d"), { owner: { identity: { root: liveRoot }, owner: { pid: dead } } })
  const unknownRoot = controllerDir(stateHome, id("e"), { owner: "{corrupt", journalRoot: goneRoot })
  const notAController = controllerDir(stateHome, "notes", { journalRoot: goneRoot })
  writeFileSync(path.join(stateHome, id("f")), "a file, not a folder")
  symlinkSync(prunedOwner, path.join(stateHome, id("9")))

  const result = await pruneReadinessLeftovers({ stateHome, isAlive: alive })
  assert.deepEqual(result.pruned.map((entry) => entry.id).sort(), [id("a"), id("b")])
  assert.deepEqual(result.pruned.find((entry) => entry.id === id("a")), { id: id("a"), root: goneRoot, pid: dead })
  assert.deepEqual(result.pruned.find((entry) => entry.id === id("b")), { id: id("b"), root: goneRoot, pid: null })
  assert.equal(result.kept, 6)
  assert.equal(existsSync(prunedOwner), false)
  assert.equal(existsSync(prunedJournal), false)
  for (const dir of [liveOwner, rootExists, unknownRoot, notAController]) assert.equal(existsSync(dir), true)
})

test("a stale socket the dead owner published is removed with its folder; a replaced one is kept", { skip: process.platform === "win32" ? "unix sockets" : false }, async () => {
  const base = await mkTempRoot("desk-leftovers-socket-")
  const stateHome = path.join(base, "readiness")
  const endpoint = path.join(base, "s.sock")
  const server = net.createServer()
  await new Promise((resolve) => server.listen(endpoint, resolve))
  const { dev, ino } = lstatSync(endpoint)
  // Keep the file while closing the listener, the way a crashed process leaves it.
  const keep = path.join(base, "keep.sock")
  linkSync(endpoint, keep)
  await new Promise((resolve) => server.close(resolve))
  renameSync(keep, endpoint)
  const gone = path.join(base, "gone")
  controllerDir(stateHome, id("b"), { owner: { identity: { root: gone }, owner: { pid: 999999 }, endpoint, socket: { dev, ino: ino + 1 } } })
  controllerDir(stateHome, id("d"), { owner: { identity: { root: gone }, owner: { pid: 999999 }, endpoint, socket: null } })
  controllerDir(stateHome, id("c"), { owner: { identity: { root: gone }, owner: { pid: 999999 }, endpoint: path.join(base, "missing.sock"), socket: { dev, ino } } })
  assert.equal((await pruneReadinessLeftovers({ stateHome, isAlive: () => false })).pruned.length, 3)
  assert.equal(existsSync(endpoint), true, "a socket that is not the recorded one is kept")
  controllerDir(stateHome, id("a"), { owner: { identity: { root: gone }, owner: { pid: 999999 }, endpoint, socket: { dev, ino } } })
  assert.equal((await pruneReadinessLeftovers({ stateHome, isAlive: () => false, uid: undefined })).pruned.length, 1)
  assert.equal(existsSync(endpoint), false, "the socket matching the record is removed")
})

test("a missing state home prunes nothing", async () => {
  assert.deepEqual(await pruneReadinessLeftovers(), { state_home: undefined, pruned: [], kept: 0, skipped: [] })
  assert.deepEqual(await pruneReadinessLeftovers({ stateHome: "/nonexistent/desk-readiness" }), { state_home: "/nonexistent/desk-readiness", pruned: [], kept: 0, skipped: [] })
})

test("a folder owned by someone else is kept", async () => {
  const base = await mkTempRoot("desk-leftovers-owner-")
  controllerDir(base, id("a"), { journalRoot: path.join(base, "gone") })
  const result = await pruneReadinessLeftovers({ stateHome: base, uid: -1 })
  assert.deepEqual(result.pruned, [])
  assert.equal(result.kept, 1)
})

test("processIsAlive treats EPERM as alive and ESRCH as dead", () => {
  assert.equal(processIsAlive(process.pid), true)
  assert.equal(processIsAlive(1, () => { throw Object.assign(new Error("perm"), { code: "EPERM" }) }), true)
  assert.equal(processIsAlive(1, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }) }), false)
  assert.equal(processIsAlive(1, () => { throw null }), false)
})

test("a folder whose recorded socket still accepts connections is kept, and an error on one folder never stops the rest", async () => {
  const base = await mkTempRoot("desk-leftovers-live-")
  const gone = path.join(base, "gone")
  controllerDir(base, id("a"), { owner: { identity: { root: gone }, owner: { pid: 999999 }, endpoint: "/live.sock" } })
  controllerDir(base, id("b"), { owner: { identity: { root: gone }, owner: { pid: 999999 }, endpoint: "/broken.sock" } })
  controllerDir(base, id("c"), { journalRoot: gone })
  const result = await pruneReadinessLeftovers({
    stateHome: base,
    isAlive: () => false,
    accepts: async (endpoint) => {
      if (endpoint === "/broken.sock") throw new Error("probe broke")
      return true
    },
  })
  assert.deepEqual(result.pruned.map((entry) => entry.id), [id("c")])
  assert.deepEqual(result.skipped, [{ id: id("b"), message: "probe broke" }])
  assert.equal(result.kept, 2)
  const thrown = await pruneReadinessLeftovers({ stateHome: base, isAlive: () => false, accepts: async () => { throw "not an error" } })
  assert.deepEqual(thrown.skipped.map((entry) => entry.message), ["not an error", "not an error"])
})

test("a root on an unmounted volume is not treated as gone", async () => {
  const exists = (target) => target === "/Volumes" || target === "/media/ari"
  assert.equal(onUnmountedVolume("/Volumes/Backup/desk", exists), true)
  assert.equal(onUnmountedVolume("/media/ari/usb/desk", exists), true)
  assert.equal(onUnmountedVolume("/mnt/share/desk", exists), true)
  assert.equal(onUnmountedVolume("/run/media/ari/usb/desk", exists), true)
  assert.equal(onUnmountedVolume("/Volumes/Backup/desk", () => true), false, "a mounted volume whose root is gone")
  assert.equal(onUnmountedVolume("/tmp/desk-test/desk", exists), false)
  assert.equal(onUnmountedVolume("/Volumes", exists), false)
  assert.equal(typeof onUnmountedVolume("/Volumes/desk-test-missing-volume-3a2/desk"), "boolean", "the default check reads the real file system")
  const base = await mkTempRoot("desk-leftovers-volume-")
  controllerDir(base, id("a"), { journalRoot: "/Volumes/desk-test-missing-volume-3a2/desk" })
  const result = await pruneReadinessLeftovers({ stateHome: base })
  assert.deepEqual(result.pruned, [])
})

test("socketAccepts answers true for a listener, false for nothing or a silent timeout", { skip: process.platform === "win32" ? "unix sockets" : false }, async () => {
  const base = await mkTempRoot("desk-leftovers-accepts-")
  const endpoint = path.join(base, "s.sock")
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => server.listen(endpoint, resolve))
  assert.equal(await socketAccepts(endpoint), true)
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await socketAccepts(endpoint), false)
  const { EventEmitter } = await import("node:events")
  assert.equal(await socketAccepts("/x", { timeoutMs: 5, connect: () => Object.assign(new EventEmitter(), { destroy() {} }) }), false)
})
