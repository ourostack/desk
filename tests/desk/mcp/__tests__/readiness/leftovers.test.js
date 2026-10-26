// Folders older Desk versions' readiness controllers left are removed once no live process owns them.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { processIsAlive, removeReadinessLeftovers } from "../../../../../plugins/desk/mcp/src/readiness/leftovers.js"
import { mkTempRoot } from "../_temp_roots.js"

const id = (digit) => digit.repeat(64)

function controllerDir(stateHome, name, owner) {
  const dir = path.join(stateHome, name)
  mkdirSync(path.join(dir, "journal"), { recursive: true })
  writeFileSync(path.join(dir, "journal", "changes.jsonl"), "")
  if (owner !== undefined) writeFileSync(path.join(dir, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner))
  return dir
}

test("removes folders no live process owns, and keeps everything else", async () => {
  const base = await mkTempRoot("desk-leftovers-")
  const stateHome = path.join(base, "readiness")
  const dead = 999999
  const alive = (pid) => pid === process.pid
  const deadOwner = controllerDir(stateHome, id("a"), { owner: { pid: dead } })
  const closedCleanly = controllerDir(stateHome, id("b"))
  const noPid = controllerDir(stateHome, id("c"), { owner: {} })
  const liveOwner = controllerDir(stateHome, id("d"), { owner: { pid: process.pid } })
  const unreadable = controllerDir(stateHome, id("e"), "{corrupt")
  const notAController = controllerDir(stateHome, "notes")
  writeFileSync(path.join(stateHome, id("f")), "a file, not a folder")
  symlinkSync(liveOwner, path.join(stateHome, id("9")))

  assert.deepEqual(await removeReadinessLeftovers({ stateHome, isAlive: alive }), { removed: 3, kept: 5 })
  for (const dir of [deadOwner, closedCleanly, noPid]) assert.equal(existsSync(dir), false, dir)
  for (const dir of [liveOwner, unreadable, notAController, path.join(stateHome, id("9"))]) assert.equal(existsSync(dir), true, dir)
})

test("the state home goes once it is empty, and a missing one removes nothing", async () => {
  const base = await mkTempRoot("desk-leftovers-empty-")
  const stateHome = path.join(base, "readiness")
  controllerDir(stateHome, id("a"))
  assert.deepEqual(await removeReadinessLeftovers({ stateHome }), { removed: 1, kept: 0 })
  assert.equal(existsSync(stateHome), false)
  assert.deepEqual(await removeReadinessLeftovers({ stateHome }), { removed: 0, kept: 0 })
})

test("a folder owned by someone else is kept, and a failure on one folder never stops the rest", async () => {
  const base = await mkTempRoot("desk-leftovers-owner-")
  const stateHome = path.join(base, "readiness")
  controllerDir(stateHome, id("a"), { owner: { pid: 999999 } })
  controllerDir(stateHome, id("b"), { owner: { pid: 999999 } })
  assert.deepEqual(await removeReadinessLeftovers({ stateHome, uid: -1, isAlive: () => false }), { removed: 0, kept: 2 })
  let calls = 0
  const result = await removeReadinessLeftovers({
    stateHome,
    isAlive: () => { calls += 1; if (calls === 1) throw new Error("probe failed"); return false },
  })
  assert.deepEqual(result, { removed: 1, kept: 1 })
})

test("without process.getuid (Windows), a folder is judged by its owner record alone", async (t) => {
  const base = await mkTempRoot("desk-leftovers-nouid-")
  const stateHome = path.join(base, "readiness")
  controllerDir(stateHome, id("a"))
  const getuid = process.getuid
  process.getuid = undefined
  t.after(() => { process.getuid = getuid })
  assert.deepEqual(await removeReadinessLeftovers({ stateHome }), { removed: 1, kept: 0 })
})

test("processIsAlive treats EPERM as alive and ESRCH as dead", () => {
  assert.equal(processIsAlive(process.pid), true)
  assert.equal(processIsAlive(1, () => { throw Object.assign(new Error("perm"), { code: "EPERM" }) }), true)
  assert.equal(processIsAlive(1, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }) }), false)
  assert.equal(processIsAlive(1, () => { throw null }), false)
})
