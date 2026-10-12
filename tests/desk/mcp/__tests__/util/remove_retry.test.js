// removeWithRetry: a removal refused for a moment is retried briefly, with a real wait; nothing else is.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { removeWithRetry } from "../../../../../plugins/desk/mcp/src/util/remove-retry.js"

const refuse = (code) => Object.assign(new Error(`${code}: refused, rm`), { code })

function flaky(code, times) {
  const calls = []
  const remove = (target, options) => {
    calls.push([target, options])
    if (calls.length <= times) throw refuse(code)
  }
  return { calls, remove }
}

for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]) {
  test(`a removal refused once with ${code} succeeds on the next attempt`, () => {
    const { calls, remove } = flaky(code, 1)
    const slept = []
    removeWithRetry("dir", { recursive: true, remove, sleep: (ms) => slept.push(ms) })
    assert.deepEqual(calls, [["dir", { recursive: true, force: false }], ["dir", { recursive: true, force: false }]])
    assert.deepEqual(slept, [25])
  })
}

test("the retry is bounded: ten attempts, a capped wait between them, then the last error unchanged", () => {
  const { calls, remove } = flaky("EPERM", Infinity)
  const slept = []
  assert.throws(() => removeWithRetry("dir", { remove, sleep: (ms) => slept.push(ms) }), { code: "EPERM" })
  assert.equal(calls.length, 10)
  assert.deepEqual(slept, [25, 50, 75, 100, 125, 150, 175, 200, 200])
})

test("a target refused with EBUSY that is then gone counts as removed", () => {
  const codes = ["EBUSY", "ENOENT"]
  const calls = []
  removeWithRetry("dir", { recursive: true, remove: (target) => { calls.push(target); throw refuse(codes.shift()) }, sleep: () => {} })
  assert.equal(calls.length, 2)
})

test("a missing target is removed with force and an error without it, as rmSync answers", () => {
  const missing = () => { throw refuse("ENOENT") }
  removeWithRetry("dir", { force: true, remove: missing, sleep: () => assert.fail("no wait") })
  assert.throws(() => removeWithRetry("dir", { remove: missing, sleep: () => assert.fail("no wait") }), { code: "ENOENT" })
})

test("any other error is thrown at once", () => {
  const { calls, remove } = flaky("EISDIR", Infinity)
  assert.throws(() => removeWithRetry("dir", { remove, sleep: () => assert.fail("no wait") }), { code: "EISDIR" })
  assert.equal(calls.length, 1)
})

test("the default wait really waits, and the default removal removes a real folder", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-remove-retry-"))
  mkdirSync(path.join(root, "inner"))
  writeFileSync(path.join(root, "inner", "file.txt"), "x")
  const started = Date.now()
  let refused = false
  removeWithRetry(root, {
    recursive: true,
    force: true,
    remove: (target, options) => {
      if (!refused) {
        refused = true
        throw refuse("EPERM")
      }
      return removeWithRetry(target, options)
    },
  })
  assert.ok(Date.now() - started >= 20, "the 25 ms wait is not rounded away")
  assert.equal(existsSync(root), false)
})

test("with no options it removes a single file, as rmSync does", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-remove-retry-file-"))
  const file = path.join(root, "only.txt")
  writeFileSync(file, "x")
  removeWithRetry(file)
  assert.equal(existsSync(file), false)
  removeWithRetry(root, { recursive: true })
})
