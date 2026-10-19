import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"
import { interrupted } from "./_archive_state_helpers.js"

async function fixture(status = "done") {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "s", title: "S", status }, schedulePush() {} })
  const source = path.join(root, "t", "s"), destination = path.join(root, "t", "_archive", "s")
  await fs.writeFile(path.join(source, "companion"), "original")
  return { root, source, destination, card: path.join(source, "task.md") }
}
const call = (f, extra = {}) => task_archive({ deskRoot: f.root, input: { track: "t", slug: "s" }, schedulePush() {}, ...extra })

test("controlled factory: capture precedes the corresponding real preparation; settled close precedes card/publication", async () => {
  const f = await fixture(), trace = []
  const result = await call(f, { openArchiveMove: async pair => {
    assert.deepEqual(pair, { source: f.source, destination: f.destination })
    trace.push("capture")
    // This is admitted by the actual preparation only if capture is before it.
    await fs.writeFile(path.join(f.source, "companion"), "captured-before-preparation")
    return {
      async admit() { trace.push("admit"); assert.equal(await exists(path.dirname(f.destination)), true) },
      async move(atUse) { await atUse(); trace.push("move"); await fs.rename(f.source, f.destination) },
      async close() { trace.push("close") },
    }
  } })
  assert.equal(result.status, "archived")
  assert.deepEqual(trace, ["capture", "admit", "move", "close"])
  assert.equal(await fs.readFile(path.join(f.destination, "companion"), "utf8"), "captured-before-preparation")
})

test("controlled factory: real preparation failure retires the live baseline and preserves its exact error", async t => {
  const f = await fixture(), primary = new Error("controlled corresponding preparation failure")
  let captured = false, closes = 0
  const read = fs.readFile
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (captured && file === path.join(f.source, "companion")) throw primary
    return read(file, ...args)
  })
  await assert.rejects(call(f, { openArchiveMove: async () => {
    captured = true
    return { async admit() { assert.fail("preparation must fail") }, async move() { assert.fail("must not move") },
      async close() { closes++ } }
  } }), error => error === primary)
  assert.equal(closes, 1)
  assert.equal(await exists(f.source), true)
  assert.equal(await exists(f.destination), false)
})

test("controlled factory: released uncertainty retains newly created parents and makes no card/publication changes", async () => {
  const f = await fixture(), original = await fs.readFile(f.card)
  const primary = Object.assign(new Error("controlled native uncertainty"), {
    archiveMove: { released: true, closed: false, forced: true, movement: "unconfirmed", retirement: "unconfirmed" },
  })
  let closes = 0
  await assert.rejects(call(f, { openArchiveMove: async () => ({
    async admit() {}, async move(atUse) { await atUse(); throw primary },
    async close() { closes++; throw new Error("separate cleanup failure") },
  }) }), error => {
    assert.equal(error, primary)
    assert.equal(error.archive_phase, "relocation_outcome_uncertain")
    assert.equal(error.possible_late_effect, true)
    assert.equal(error.created_parents, "retained_until_native_retirement_resolved")
    assert.match(error.native_close_failure, /cleanup/)
    return true
  })
  assert.equal(closes, 1)
  assert.deepEqual(await fs.readFile(f.card), original)
  assert.equal(await exists(path.dirname(f.destination)), true)
  assert.equal(await exists(f.destination), false)
})

test("controlled factory: policy checks precede capture, and archived/interrupted paths never capture", async () => {
  const f = await fixture("processing")
  let captures = 0
  const openArchiveMove = async () => { captures++; assert.fail("not a fresh admitted relocation") }
  await assert.rejects(call(f, { openArchiveMove }))
  assert.equal(captures, 0)
  const setupTrace = []
  const openSetupMove = async pair => {
    assert.deepEqual(pair, { source: f.source, destination: f.destination })
    setupTrace.push("capture")
    return {
      async admit() {},
      async move(atUse) { await atUse(); setupTrace.push("move"); await fs.rename(f.source, f.destination) },
      async close() { setupTrace.push("close") },
    }
  }
  const archived = await call(f, { input: { track: "t", slug: "s", outcome: "cancelled" }, openArchiveMove: openSetupMove })
  assert.equal(archived.status, "archived")
  assert.deepEqual(setupTrace, ["capture", "move", "close"])
  assert.equal(await exists(f.source), false)
  assert.match(await fs.readFile(path.join(f.destination, "task.md"), "utf8"), /status: cancelled/u)
  assert.equal((await call(f, { openArchiveMove })).status, "already_archived")
  assert.equal(captures, 0)
})

test("legacy moveArchive injection is explicit, separate from capture-factory/default proof", async () => {
  const f = await fixture(), trace = []
  await call(f, { openArchiveMove() { assert.fail("legacy injection must not be tagged default capture") },
    async moveArchive(source, destination, atUse) {
      trace.push("legacy-injected-transport")
      await atUse()
      await fs.rename(source, destination)
    } })
  assert.deepEqual(trace, ["legacy-injected-transport"])
})

test("controlled factory: frozen preparation error survives a later cleanup failure", async t => {
  const f = await fixture(), primary = Object.freeze(new Error("frozen preparation error"))
  let captured = false, closed = false
  const read = fs.readFile
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (captured && file === path.join(f.source, "companion")) throw primary
    return read(file, ...args)
  })
  await assert.rejects(call(f, { openArchiveMove: async () => {
    captured = true
    return { async admit() {}, async move() {}, async close() { closed = true; throw new Error("later cleanup") } }
  } }), error => error === primary)
  assert.equal(closed, true)
})

test("controlled factory: close is settled before a cancelled card patch, not discovered after publication", async () => {
  const f = await fixture("processing")
  let closed = false
  const result = await call(f, { input: { track: "t", slug: "s", outcome: "cancelled" }, openArchiveMove: async () => ({
    async admit() {},
    async move(atUse) { await atUse(); await fs.rename(f.source, f.destination) },
    async close() {
      assert.match(await fs.readFile(path.join(f.destination, "task.md"), "utf8"), /status: processing/u)
      closed = true
    },
  }) })
  assert.equal(closed, true)
  assert.equal(result.status, "archived")
  assert.match(await fs.readFile(path.join(f.destination, "task.md"), "utf8"), /status: cancelled/u)
})

test("real interrupted publication reconciles without capturing or releasing a second relocation", async () => {
  const f = await interrupted()
  const result = await task_archive({ deskRoot: f.root, input: { track: "t", slug: "mode-proof" }, schedulePush() {},
    openArchiveMove() { assert.fail("relocated publication must not capture the absent source") } })
  assert.equal(result.status, "archived")
})
