// renameWithRetry: a rename Windows refuses for a moment is retried briefly; nothing else is.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { renameWithRetry } from "../../../../../plugins/desk/mcp/src/util/rename-retry.js"

const refuse = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })

function flaky(code, times) {
  const calls = []
  const rename = (source, destination) => {
    calls.push([source, destination])
    if (calls.length <= times) throw refuse(code)
  }
  return { calls, rename }
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`on Windows a rename refused once with ${code} succeeds on the next attempt`, () => {
    const { calls, rename } = flaky(code, 1)
    const slept = []
    renameWithRetry("a.tmp", "a", { rename, sleep: (ms) => slept.push(ms), platform: "win32" })
    assert.deepEqual(calls, [["a.tmp", "a"], ["a.tmp", "a"]])
    assert.deepEqual(slept, [25])
  })
}

test("the retry is bounded: ten attempts, a capped wait between them, then the last error unchanged", () => {
  const { calls, rename } = flaky("EPERM", Infinity)
  const slept = []
  assert.throws(() => renameWithRetry("a.tmp", "a", { rename, sleep: (ms) => slept.push(ms), platform: "win32" }), { code: "EPERM" })
  assert.equal(calls.length, 10)
  assert.deepEqual(slept, [25, 50, 75, 100, 125, 150, 175, 200, 200])
})

test("any other error is thrown at once, on every platform", () => {
  for (const platform of ["win32", "linux"]) {
    const { calls, rename } = flaky("ENOENT", Infinity)
    assert.throws(() => renameWithRetry("a.tmp", "a", { rename, sleep: () => assert.fail("no wait"), platform }), { code: "ENOENT" })
    assert.equal(calls.length, 1)
  }
  assert.throws(() => renameWithRetry("a", "b", { rename: () => { throw "plain" }, sleep: () => {}, platform: "win32" }), (error) => error === "plain")
})

test("off Windows an EPERM is a real permission error and is not retried", () => {
  const { calls, rename } = flaky("EPERM", Infinity)
  assert.throws(() => renameWithRetry("a.tmp", "a", { rename, sleep: () => assert.fail("no wait"), platform: "linux" }), { code: "EPERM" })
  assert.equal(calls.length, 1)
})

test("with the real rename and real wait it moves a file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-rename-retry-"))
  writeFileSync(path.join(root, "a.tmp"), "x")
  renameWithRetry(path.join(root, "a.tmp"), path.join(root, "a"))
  assert.equal(readFileSync(path.join(root, "a"), "utf8"), "x")
  let failures = 0
  renameWithRetry("a", "b", { platform: "win32", rename: () => { if (failures++ === 0) throw refuse("EBUSY") } })
  assert.equal(failures, 2, "the default wait sleeps for real and the second attempt runs")
})
