// The machine's record that an agent told the operator, once, that Desk can contribute to a store (ms-desk dry runs, 2026-10-12: one
// session said the line twice and the next session said it again).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { CONSENT_MENTIONED_DIR, consentMentioned, mentionedFile, noteConsentMentioned } from "../../../../../plugins/desk/mcp/src/runtime/consent-mentioned.js"

const ROOT = mkdtempSync(path.join(tmpdir(), "consent-mentioned-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = () => path.join(ROOT, `state-${(counter += 1)}`)
const STORE = "ourostack/factory-intake"

test("nothing is recorded until an agent says it did; the record is per store and keeps the first time", () => {
  const stateDir = fresh()
  assert.equal(consentMentioned(stateDir, STORE), false)
  assert.deepEqual(noteConsentMentioned(stateDir, STORE, { now: () => "2026-10-12T16:26:41.000Z" }), { store: STORE, mentioned_at: "2026-10-12T16:26:41.000Z" })
  assert.equal(mentionedFile(stateDir, STORE), path.join(stateDir, CONSENT_MENTIONED_DIR, "ourostack__factory-intake.json"))
  assert.deepEqual(JSON.parse(readFileSync(mentionedFile(stateDir, STORE), "utf8")), { store: STORE, mentioned_at: "2026-10-12T16:26:41.000Z" })
  assert.equal(consentMentioned(stateDir, STORE), true)
  assert.equal(consentMentioned(stateDir, "ourostack/other"), false, "another store has its own record")
  assert.deepEqual(noteConsentMentioned(stateDir, STORE, { now: () => "2026-10-13T00:00:00.000Z" }), { store: STORE, mentioned_at: "2026-10-12T16:26:41.000Z" }, "a second note keeps the first time")
  assert.deepEqual(noteConsentMentioned(stateDir, "Ourostack/Factory-Intake", { now: () => "2026-10-14T00:00:00.000Z" }), { store: "Ourostack/Factory-Intake", mentioned_at: "2026-10-12T16:26:41.000Z" }, "another spelling of the store is the same store")
  assert.equal(consentMentioned(stateDir, "OUROSTACK/factory-intake"), true)
  assert.match(noteConsentMentioned(stateDir, "ourostack/other").mentioned_at, /^\d{4}-\d{2}-\d{2}T/u, "the default clock is the real one")
})

test("a store that is not owner/repo names no file: it reads as not mentioned and cannot be noted", () => {
  const stateDir = fresh()
  for (const store of ["../../etc", "a/b/c", "", null, undefined, 7]) {
    assert.equal(consentMentioned(stateDir, store), false, String(store))
    assert.throws(() => noteConsentMentioned(stateDir, store), /store must be <owner\/repo>/u, String(store))
  }
  assert.equal(consentMentioned("", STORE), false, "no state folder")
  assert.equal(consentMentioned(undefined, STORE), false)
})

test("a record that cannot be read or is not this store's reads as not mentioned, and a note replaces it", () => {
  const stateDir = fresh()
  const file = mentionedFile(stateDir, STORE)
  mkdirSync(path.dirname(file), { recursive: true })
  for (const text of ["not json", "null", "[]", JSON.stringify({ store: "someone/else", mentioned_at: "2026-10-12T00:00:00.000Z" }), JSON.stringify({ store: STORE }), JSON.stringify({ store: 7, mentioned_at: "2026-10-12T00:00:00.000Z" }), JSON.stringify({ store: STORE, mentioned_at: "" })]) {
    writeFileSync(file, text)
    assert.equal(consentMentioned(stateDir, STORE), false, text)
  }
  assert.equal(noteConsentMentioned(stateDir, STORE, { now: () => "2026-10-12T17:00:00.000Z" }).mentioned_at, "2026-10-12T17:00:00.000Z")
  assert.equal(consentMentioned(stateDir, STORE), true)
})

test("under the test runner, the real state folder is refused: a read says not mentioned and a note throws", () => {
  const real = path.join(path.parse(process.cwd()).root, "not-the-temp-dir", "desk")
  assert.equal(consentMentioned(real, STORE), false)
  assert.throws(() => noteConsentMentioned(real, STORE), (error) => error.code === "DESK_TEST_REAL_STATE")
})
