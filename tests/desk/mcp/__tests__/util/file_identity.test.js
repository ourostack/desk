import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fsp, writeFileSync } from "node:fs"
import * as path from "node:path"
import { EXACT, lstatExactIfPresent, matchesRecordedFile, sameFile } from "../../../../../plugins/desk/mcp/src/util/file-identity.js"
import { mkTempRoot } from "../_temp_roots.js"

// A file id measured on a Windows CI runner; as Numbers it and its successor are the same value.
const WINDOWS_ID = 10414574139658612n
const file = (ino, dev = 5n) => ({ dev, ino })

test("two ids that are one Number are two files when read exactly", () => {
  assert.equal(Number(WINDOWS_ID), Number(WINDOWS_ID + 1n), "the premise: a Number cannot tell these ids apart")
  assert.equal(sameFile(file(WINDOWS_ID), file(WINDOWS_ID)), true)
  assert.equal(sameFile(file(WINDOWS_ID), file(WINDOWS_ID + 1n)), false)
  assert.equal(sameFile(file(WINDOWS_ID), file(WINDOWS_ID, 6n)), false)
})

test("a stat read without bigint is refused rather than compared as lossy Numbers", () => {
  assert.throws(() => sameFile({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), /needs a stat read with \{ bigint: true \}/u)
  assert.throws(() => sameFile(file(1n), { dev: 1, ino: 2 }), TypeError)
  assert.throws(() => sameFile({ dev: 1n, ino: 2 }, file(2n)), TypeError)
  assert.throws(() => matchesRecordedFile({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), TypeError)
})

test("a recorded identity is matched exactly when it holds a string or a BigInt, and as closely as a Number allows otherwise", () => {
  const actual = file(WINDOWS_ID)
  assert.equal(matchesRecordedFile(actual, { dev: "5", ino: String(WINDOWS_ID) }), true)
  assert.equal(matchesRecordedFile(actual, { dev: "5", ino: String(WINDOWS_ID + 1n) }), false)
  assert.equal(matchesRecordedFile(actual, { dev: 5n, ino: WINDOWS_ID }), true)
  assert.equal(matchesRecordedFile(actual, { dev: 5n, ino: WINDOWS_ID + 1n }), false)
  assert.equal(matchesRecordedFile(file(42n), { dev: 5, ino: 42 }), true, "a safe Number is exact")
  assert.equal(matchesRecordedFile(file(42n), { dev: 5, ino: 43 }), false)
  assert.equal(matchesRecordedFile(actual, { dev: 5, ino: Number(WINDOWS_ID) }), true, "a recorded Number above 2^53 has lost its low bits; the exact id rounding to it is the best answer")
  assert.equal(matchesRecordedFile(actual, { dev: 5, ino: Number(WINDOWS_ID) * 2 }), false)
  for (const recorded of [undefined, null, {}, { dev: 5n }, { ino: 42n }, { dev: 5n, ino: "4x2" }, { dev: 5n, ino: -1 }, { dev: 5n, ino: {} }, { dev: 5n, ino: "-42" }]) {
    assert.equal(matchesRecordedFile(file(42n), recorded), false, JSON.stringify(recorded, (key, value) => (typeof value === "bigint" ? String(value) : value)))
  }
})

test("lstatExactIfPresent reads a BigInt stat, answers null for a missing path and names any other failure", async (t) => {
  const root = await mkTempRoot("desk-file-identity-")
  const present = path.join(root, "present")
  writeFileSync(present, "x")
  const naming = { label: "outbox", subject: "state" }
  const stat = await lstatExactIfPresent(present, naming)
  assert.equal(typeof stat.ino, "bigint")
  assert.equal(sameFile(stat, await lstatExactIfPresent(present, naming)), true)
  assert.equal(await lstatExactIfPresent(path.join(root, "missing"), naming), null)
  // Which error a path below a file gives differs by platform (ENOTDIR, or ENOENT on Windows), so the failure is injected.
  t.mock.method(fsp, "lstat", async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) })
  await assert.rejects(lstatExactIfPresent(present, naming), /^Error: outbox: private state path .* could not be inspected \(EACCES\)$/u)
  assert.equal(EXACT.bigint, true)
})
