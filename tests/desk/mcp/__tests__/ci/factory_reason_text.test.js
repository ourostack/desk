// The CI check that every reason Desk can emit has display text in the factory store (scripts/check-factory-reason-text.cjs).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { REASON_TEXT } from "../../../../../plugins/desk/mcp/src/factory/pipeline/report.js"

const require = createRequire(import.meta.url)
const check = require("../../../../../scripts/check-factory-reason-text.cjs")
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))

const storeFile = (codes) => `(function () {\n  "use strict";\n  const REASON_TEXT = {\n${codes.map((code) => `    ${code}: "words for ${code}",\n`).join("")}    // a comment\n  };\n  function hasReasonText() {}\n})()\n`
const all = Object.keys(REASON_TEXT)

test("the reasons the check reads from Desk are the ones Desk's reports carry, and there are some", async () => {
  const codes = await check.deskReasonCodes(repoRoot)
  assert.deepEqual(codes.sort(), [...all].sort())
  assert.ok(codes.includes("no_turn_records"))
})

test("a store with text for every Desk reason passes", () => {
  assert.deepEqual(check.compareReasons({ deskReasons: all, storeSource: storeFile(all) }), { state: "checked", missing: [] })
})

test("a Desk reason the store has no text for is named", () => {
  const without = all.filter((code) => code !== "no_turn_records")
  assert.deepEqual(check.compareReasons({ deskReasons: all, storeSource: storeFile(without) }), { state: "checked", missing: ["no_turn_records"] })
})

test("a store file with no reason table is unreadable, not a pass", () => {
  assert.deepEqual(check.compareReasons({ deskReasons: all, storeSource: "const OTHER = {}" }), { state: "unreadable" })
  assert.deepEqual(check.compareReasons({ deskReasons: all, storeSource: "const REASON_TEXT = {\n  };" }), { state: "unreadable" })
})

const respond = (body, status = 200) => async () => ({ ok: status === 200, status, text: async () => body })

test("run fails and names the reason when the store lacks it", async () => {
  const result = await check.run({ env: {}, root: repoRoot, fetchImpl: respond(storeFile(all.filter((code) => code !== "no_turn_records"))) })
  assert.equal(result.code, 1)
  assert.equal(result.lines.length, 1)
  assert.match(result.lines[0], /^::error .*`no_turn_records`/u)
  assert.match(result.summary, /FAILED/u)
})

test("run passes only when every reason has text", async () => {
  const result = await check.run({ env: {}, root: repoRoot, fetchImpl: respond(storeFile(all)) })
  assert.equal(result.code, 0)
  assert.match(result.lines[0], /all \d+ Desk reasons have display text/u)
})

test("an unreachable store is reported as NOT CHECKED with a warning, never as a pass", async () => {
  let attempts = 0
  const down = async () => { attempts += 1; throw new Error("getaddrinfo ENOTFOUND") }
  const result = await check.run({ env: {}, root: repoRoot, fetchImpl: down, attempts: 2 })
  assert.equal(attempts, 2)
  assert.equal(result.code, 0)
  assert.match(result.lines[0], /^::warning .*NOT CHECKED.*ENOTFOUND.*not a pass/u)
  assert.match(result.summary, /NOT CHECKED/u)
  assert.doesNotMatch(result.summary, /checked\n/u)
  const refused = await check.run({ env: {}, root: repoRoot, fetchImpl: respond("", 503), attempts: 1 })
  assert.match(refused.lines[0], /NOT CHECKED.*HTTP 503/u)
})

test("an unreadable store file fails the run", async () => {
  const result = await check.run({ env: {}, root: repoRoot, fetchImpl: respond("nothing here") })
  assert.equal(result.code, 1)
  assert.match(result.summary, /NOT CHECKED/u)
})

test("a local copy of the store file can be named instead of fetching", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "desk-reason-text-"))
  try {
    const file = path.join(dir, "format.js")
    writeFileSync(file, storeFile(all))
    const never = async () => { throw new Error("must not fetch") }
    const result = await check.run({ env: { FACTORY_REASON_TEXT_FILE: file }, root: repoRoot, fetchImpl: never })
    assert.equal(result.code, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
