import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { progressOf, readEndings } from "../../../../../plugins/desk/mcp/src/runtime/outcomes.js"

const PR1 = "https://github.com/ourostack/desk/pull/1"
const PR2 = "https://github.com/ourostack/desk/pull/2"
const done = (card, shipped, at = "2026-11-26T10:00:00Z") => ({ card, at, ending: { kind: "done", shipped } })
const lookup = (url) => ({ [PR1]: { merged: true, mergedAt: "2026-11-26T11:00:00Z" }, [PR2]: { merged: false, mergedAt: null } })[url] ?? null

test("a merged pull request counts, once, however often it is claimed", () => {
  const r = progressOf({ card: "t/c", endings: [done("t/c", PR1), done("t/c", PR1)], lookup })
  assert.equal(r.count, 1)
})

test("gaming: an unmerged pull request, an unknown one, a bare sha and another card's pull request add nothing", () => {
  const r = progressOf({ card: "t/c", endings: [done("t/c", PR2), done("t/c", "https://github.com/ourostack/desk/pull/9"), done("t/c", "abcdef1"), done("t/other", PR1)], lookup })
  assert.equal(r.count, 0)
  assert.equal(r.unverified.length, 3)
})

test("gaming: waiting, blocked, no-ready-work endings, messages and busy never count", () => {
  const endings = [{ card: "t/c", ending: { kind: "waiting", on: "ci" } }, { card: "t/c", ending: { kind: "no_ready_work", checked: "x" } }, { card: "t/c", ending: { kind: "unverified" } }]
  assert.equal(progressOf({ card: "t/c", endings, lookup, messages: 500, commits: 50, busy: true }).count, 0)
})

test("an acceptance check counts only as passed on a named version", () => {
  const acceptance = [{ card: "t/c", check: "smoke", version: "v1.2.0", passed: true }, { card: "t/c", check: "smoke", version: "", passed: true }, { card: "t/c", check: "smoke", version: "v1.2.0", passed: false }]
  const r = progressOf({ card: "t/c", acceptance, lookup })
  assert.equal(r.count, 1)
  assert.equal(r.shipped[0].ref, "smoke@v1.2.0")
})

test("readEndings skips damaged lines and orders by time", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "endings-"))
  writeFileSync(path.join(dir, "a.jsonl"), `${JSON.stringify({ at: "2", card: "b" })}\nnot json\n${JSON.stringify({ at: "1", card: "a" })}\n`)
  assert.deepEqual(readEndings(dir).map((e) => e.card), ["a", "b"])
})
