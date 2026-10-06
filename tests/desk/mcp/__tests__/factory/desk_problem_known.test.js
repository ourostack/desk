// The known-hit record: pure reader and bounded recorder. Every state directory is a scratch directory.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DROPPED_KEY, KNOWN_KEY, MAX_KNOWN_ISSUES, SINCE_KEY, armKnownHits, compareVersions, knownHitsSince, recordKnownHit, recordLostHit } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-known.js"
import { readStatus, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-problem-known-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run({ env })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const T1 = Date.parse("2026-10-01T00:00:00Z")

test("compareVersions orders release numbers and prereleases, and refuses what it cannot read", () => {
  assert.equal(compareVersions("3.2.0-alpha.179", "3.2.0-alpha.179"), 0)
  assert.equal(compareVersions("3.2.0-alpha.180", "3.2.0-alpha.179"), 1)
  assert.equal(compareVersions("3.2.0-alpha.99", "3.2.0-alpha.179"), -1)
  assert.equal(compareVersions("3.2.0", "3.2.0-alpha.179"), 1)
  assert.equal(compareVersions("3.2.0-alpha.179", "3.2.0"), -1)
  assert.equal(compareVersions("3.10.0", "3.9.9"), 1)
  assert.equal(compareVersions("3.2", "3.2.0"), 0)
  assert.equal(compareVersions("3", "3.0.0"), 0)
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1)
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha"), 1)
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1)
  assert.equal(compareVersions("1.0.0-alpha.beta", "1.0.0-alpha.1"), 1)
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1)
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-alpha"), 1)
  for (const bad of ["", "x", "1.a.0", null, 3, undefined, "1.2.3.4"]) {
    assert.equal(compareVersions(bad, "1.0.0"), null)
    assert.equal(compareVersions("1.0.0", bad), null)
  }
})

test("a known hit records count 1, the version and the time; a second hit makes count 2", () => scratch(async ({ env }) => {
  assert.deepEqual(await recordKnownHit(env, 7, { version: "3.2.0-alpha.179", now: () => T1 }), { recorded: true })
  assert.deepEqual((await readStatus(env))[KNOWN_KEY], { 7: { count: 1, last_at: "2026-10-01T00:00:00.000Z", last_version: "3.2.0-alpha.179" } })
  await recordKnownHit(env, 7, { version: "3.2.0-alpha.179", now: () => T1 + 1000 })
  assert.deepEqual((await readStatus(env))[KNOWN_KEY][7], { count: 2, last_at: "2026-10-01T00:00:01.000Z", last_version: "3.2.0-alpha.179" })
}))

test("last_version keeps the highest version hit, so a later hit from an older Desk does not hide a newer one", () => scratch(async ({ env }) => {
  await recordKnownHit(env, 7, { version: "3.2.0-alpha.180", now: () => T1 })
  await recordKnownHit(env, 7, { version: "3.2.0-alpha.100", now: () => T1 + 1 })
  assert.equal((await readStatus(env))[KNOWN_KEY][7].last_version, "3.2.0-alpha.180")
  await recordKnownHit(env, 7, { version: "3.2.0-alpha.181", now: () => T1 + 2 })
  assert.equal((await readStatus(env))[KNOWN_KEY][7].last_version, "3.2.0-alpha.181")
}))

test("recording keeps the rest of status.json and other issues", () => scratch(async ({ env }) => {
  await writeStatus(env, { last_flush: { "a/b": { at: "x", result: "ok" } }, desk_problem_filed: { k: ["z"] } })
  await recordKnownHit(env, 1, { version: "1.0.0", now: () => T1 })
  await recordKnownHit(env, 2, { version: "1.0.0", now: () => T1 })
  const status = await readStatus(env)
  assert.deepEqual(status.last_flush, { "a/b": { at: "x", result: "ok" } })
  assert.deepEqual(status.desk_problem_filed, { k: ["z"] })
  assert.deepEqual(Object.keys(status[KNOWN_KEY]).sort(), ["1", "2"])
}))

test("the record holds only integers, a timestamp and a version string", () => scratch(async ({ env }) => {
  await recordKnownHit(env, 9, { version: "3.2.0", now: () => T1 })
  const entry = (await readStatus(env))[KNOWN_KEY][9]
  assert.deepEqual(Object.keys(entry).sort(), ["count", "last_at", "last_version"])
  assert.equal(Number.isInteger(entry.count), true)
  assert.match(entry.last_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u)
  assert.equal(typeof entry.last_version, "string")
  assert.equal(JSON.stringify(await readStatus(env)).includes("/"), false)
}))

test("the record is bounded: past the limit the entries with the oldest last_at are dropped", () => scratch(async ({ env }) => {
  assert.equal(MAX_KNOWN_ISSUES, 50)
  for (let n = 1; n <= MAX_KNOWN_ISSUES + 3; n += 1) await recordKnownHit(env, n, { version: "1.0.0", now: () => T1 + n * 1000 })
  const map = (await readStatus(env))[KNOWN_KEY]
  assert.equal(Object.keys(map).length, MAX_KNOWN_ISSUES)
  for (const dropped of [1, 2, 3]) assert.equal(Object.hasOwn(map, dropped), false)
  assert.equal(Object.hasOwn(map, 4), true)
  // A hit on an old issue makes it recent, so it survives the next drop.
  await recordKnownHit(env, 4, { version: "1.0.0", now: () => T1 + 999000 })
  await recordKnownHit(env, 100, { version: "1.0.0", now: () => T1 + 1000000 })
  const next = (await readStatus(env))[KNOWN_KEY]
  assert.equal(Object.hasOwn(next, 4), true)
  assert.equal(Object.hasOwn(next, 5), false)
}))

test("a damaged existing record is rebuilt rather than failing the write", () => scratch(async ({ env }) => {
  await writeStatus(env, { [KNOWN_KEY]: { 3: "junk", 4: { count: "x" }, 5: { count: 2, last_at: "2026-09-01T00:00:00.000Z", last_version: "1.0.0" } } })
  assert.deepEqual(await recordKnownHit(env, 3, { version: "1.0.0", now: () => T1 }), { recorded: true })
  const map = (await readStatus(env))[KNOWN_KEY]
  assert.equal(map[3].count, 1)
  assert.equal(map[5].count, 2)
  assert.equal(Object.hasOwn(map, 4), false)
  await writeStatus(env, { [KNOWN_KEY]: [1, 2] })
  assert.deepEqual(await recordKnownHit(env, 8, { version: "1.0.0", now: () => T1 }), { recorded: true })
  assert.deepEqual(Object.keys((await readStatus(env))[KNOWN_KEY]), ["8"])
  await writeStatus(env, { [KNOWN_KEY]: "junk" })
  await recordKnownHit(env, 9, { version: "1.0.0", now: () => T1 })
  assert.deepEqual(Object.keys((await readStatus(env))[KNOWN_KEY]), ["9"])
  await writeStatus(env, { [KNOWN_KEY]: null })
  await recordKnownHit(env, 10, { version: "1.0.0", now: () => T1 })
  assert.deepEqual(Object.keys((await readStatus(env))[KNOWN_KEY]), ["10"])
}))

test("a headless factory session records nothing", () => scratch(async ({ env }) => {
  for (const flag of ["1", "yes"]) {
    assert.deepEqual(await recordKnownHit({ ...env, DESK_FACTORY_HEADLESS: flag }, 7, { version: "1.0.0", now: () => T1 }), { recorded: false, code: "headless_session" })
  }
  assert.equal((await readStatus(env))[KNOWN_KEY], undefined)
  for (const flag of ["", "0"]) assert.deepEqual(await recordKnownHit({ ...env, DESK_FACTORY_HEADLESS: flag }, 7, { version: "1.0.0", now: () => T1 }), { recorded: true })
}))

test("a refused or failing write is reported with a stable code and never thrown", () => scratch(async ({ env }) => {
  assert.deepEqual(await recordKnownHit(env, "7", { version: "1.0.0", now: () => T1 }), { recorded: false, code: "bad_issue_number" })
  assert.deepEqual(await recordKnownHit(env, 0, { version: "1.0.0", now: () => T1 }), { recorded: false, code: "bad_issue_number" })
  assert.deepEqual(await recordKnownHit(env, 7, { version: "nonsense", now: () => T1 }), { recorded: false, code: "bad_version" })
  assert.deepEqual(await recordKnownHit({ HOME: "relative" }, 7, { version: "1.0.0", now: () => T1 }), { recorded: false, code: "status_write_failed" })
}))

const SINCE = "2026-10-01T00:00:00.000Z"
const ARMED = "2026-09-01T00:00:00.000Z"
const GOOD = { count: 1, last_at: "2026-10-01T00:00:00.000Z", last_version: "1.0.0" }
const armed = (extra = {}) => ({ last_flush: {}, [SINCE_KEY]: ARMED, ...extra })

test("knownHitsSince reads a hit at or after the version as a hit and an older hit as none", () => {
  const status = armed({ [KNOWN_KEY]: { 7: { count: 3, last_at: "2026-10-01T00:00:00.000Z", last_version: "3.2.0-alpha.180" } } })
  assert.deepEqual(knownHitsSince(status, 7, "3.2.0-alpha.180", { since: SINCE }), { state: "measured", hit: true })
  assert.deepEqual(knownHitsSince(status, 7, "3.2.0-alpha.179", { since: SINCE }), { state: "measured", hit: true })
  assert.deepEqual(knownHitsSince(status, 7, "3.2.0-alpha.181", { since: SINCE }), { state: "measured", hit: false })
})

test("knownHitsSince reads a missing or damaged record as unavailable, never as no hits", () => {
  const dropped = { count: 1, last_dropped_at: SINCE }
  const cases = [
    [undefined, 7, "1.0.0", "not_recorded"],
    [null, 7, "1.0.0", "not_recorded"],
    [{ last_flush: {} }, 7, "1.0.0", "not_recorded"],
    [armed({ [KNOWN_KEY]: [] }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: "junk" }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: null }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: { 8: GOOD }, [DROPPED_KEY]: dropped }), 7, "1.0.0", "not_recorded"],
    [armed({ [DROPPED_KEY]: { count: 2, last_dropped_at: SINCE } }), 7, "1.0.0", "not_recorded"],
    [armed({ [KNOWN_KEY]: {}, [DROPPED_KEY]: "junk" }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: {}, [DROPPED_KEY]: { count: -1, last_dropped_at: SINCE } }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: {}, [DROPPED_KEY]: { count: 1, last_dropped_at: "x" } }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: {}, [DROPPED_KEY]: null }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: { 7: "junk" } }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: { 7: { ...GOOD, count: 0 } } }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: { 7: { ...GOOD, last_version: "zzz" } } }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: { 7: { ...GOOD, last_at: "yesterday" } } }), 7, "1.0.0", "damaged"],
    [armed({ [KNOWN_KEY]: { 7: GOOD } }), 7, "zzz", "bad_version"],
    [armed({ [KNOWN_KEY]: { 7: GOOD } }), "7", "1.0.0", "bad_issue_number"],
  ]
  for (const [status, number, version, reason] of cases) assert.deepEqual(knownHitsSince(status, number, version, { since: SINCE }), { state: "unavailable", reason }, JSON.stringify([status, number, version]))
})

test("with nothing ever dropped and recording started, an issue with no entry reads as measured no hit", () => {
  for (const status of [armed(), armed({ [KNOWN_KEY]: {} }), armed({ [KNOWN_KEY]: { 8: GOOD } }), armed({ [DROPPED_KEY]: { count: 0, last_dropped_at: null } })]) {
    assert.deepEqual(knownHitsSince(status, 7, "1.0.0", { since: SINCE }), { state: "measured", hit: false }, JSON.stringify(status))
  }
})

test("a reset status (no recording_since) or one that started recording after `since` reads not_recorded, even with a hit entry", () => {
  assert.deepEqual(knownHitsSince({ last_flush: {} }, 7, "1.0.0", { since: SINCE }), { state: "unavailable", reason: "not_recorded" })
  assert.deepEqual(knownHitsSince({ last_flush: {}, [KNOWN_KEY]: {} }, 7, "1.0.0", { since: SINCE }), { state: "unavailable", reason: "not_recorded" })
  const late = { last_flush: {}, [SINCE_KEY]: "2026-10-02T00:00:00.000Z" }
  assert.deepEqual(knownHitsSince(late, 7, "1.0.0", { since: SINCE }), { state: "unavailable", reason: "not_recorded" })
  assert.deepEqual(knownHitsSince({ last_flush: {}, [SINCE_KEY]: SINCE }, 7, "1.0.0", { since: SINCE }), { state: "measured", hit: false })
  assert.deepEqual(knownHitsSince({ last_flush: {}, [SINCE_KEY]: "junk" }, 7, "1.0.0", { since: SINCE }), { state: "unavailable", reason: "damaged" })
})

test("`since` is required: a missing or unparseable one is refused; a Date and epoch milliseconds are accepted", () => {
  const status = armed()
  for (const options of [undefined, {}, { since: "yesterday" }, { since: null }, { since: {} }]) {
    assert.deepEqual(knownHitsSince(status, 7, "1.0.0", options), { state: "unavailable", reason: "bad_since" })
  }
  assert.deepEqual(knownHitsSince(status, 7, "1.0.0", { since: new Date(SINCE) }), { state: "measured", hit: false })
  assert.deepEqual(knownHitsSince(status, 7, "1.0.0", { since: Date.parse(SINCE) }), { state: "measured", hit: false })
})

test("the first recording stamps recording_since once and never moves it", () => scratch(async ({ env }) => {
  await recordKnownHit(env, 1, { version: "1.0.0", now: () => T1 })
  assert.equal((await readStatus(env))[SINCE_KEY], "2026-10-01T00:00:00.000Z")
  await recordKnownHit(env, 2, { version: "1.0.0", now: () => T1 + 9000 })
  assert.equal((await readStatus(env))[SINCE_KEY], "2026-10-01T00:00:00.000Z")
  assert.equal((await readStatus(env))[DROPPED_KEY], undefined)
}))

test("armKnownHits sets recording_since if absent, keeps it if present, refuses headless and reports a failed write", () => scratch(async ({ env }) => {
  assert.deepEqual(await armKnownHits(env, { now: () => T1 }), { armed: true })
  assert.equal((await readStatus(env))[SINCE_KEY], "2026-10-01T00:00:00.000Z")
  assert.deepEqual(await armKnownHits(env, { now: () => T1 + 5000 }), { armed: true })
  assert.equal((await readStatus(env))[SINCE_KEY], "2026-10-01T00:00:00.000Z")
  assert.equal((await readStatus(env))[DROPPED_KEY], undefined)
  assert.deepEqual(await armKnownHits({ ...env, DESK_FACTORY_HEADLESS: "1" }, { now: () => T1 }), { armed: false, code: "headless_session" })
  assert.deepEqual(await armKnownHits({ HOME: "relative" }, { now: () => T1 }), { armed: false, code: "status_write_failed" })
  assert.deepEqual(await armKnownHits(env), { armed: true })
}))

test("a damaged recording_since is replaced by now and counted as a drop, by arming and by recording", () => scratch(async ({ env }) => {
  await writeStatus(env, { [SINCE_KEY]: 5 })
  await armKnownHits(env, { now: () => T1 })
  assert.deepEqual((await readStatus(env))[DROPPED_KEY], { count: 1, last_dropped_at: "2026-10-01T00:00:00.000Z" })
  assert.equal((await readStatus(env))[SINCE_KEY], "2026-10-01T00:00:00.000Z")
  await writeStatus(env, { [SINCE_KEY]: "junk" })
  await recordKnownHit(env, 4, { version: "1.0.0", now: () => T1 + 1000 })
  assert.equal((await readStatus(env))[DROPPED_KEY].count, 2)
}))

test("a write never turns damage into a clean record: each kind of damage is counted as dropped", () => scratch(async ({ env }) => {
  const cases = [
    { [DROPPED_KEY]: { count: "x" } },
    { [DROPPED_KEY]: "junk" },
    { [KNOWN_KEY]: [1, 2] },
    { [KNOWN_KEY]: "junk" },
    { [KNOWN_KEY]: null },
    { [KNOWN_KEY]: { 5: { count: "q", last_at: "2026-10-01T00:00:00.000Z", last_version: "9.0.0" } } },
  ]
  for (const damage of cases) {
    await writeStatus(env, { [KNOWN_KEY]: undefined, [DROPPED_KEY]: undefined, ...damage })
    await recordKnownHit(env, 5, { version: "1.0.0", now: () => T1 })
    const status = await readStatus(env)
    assert.equal(status[DROPPED_KEY].count >= 1, true, JSON.stringify(damage))
    assert.deepEqual(knownHitsSince(status, 6, "1.0.0", { since: new Date(T1).toISOString() }), { state: "unavailable", reason: "not_recorded" }, JSON.stringify(damage))
    // Whatever the damage lost was recorded no later than the write that found it, so a window that starts after it is measured.
    assert.deepEqual(knownHitsSince(status, 6, "1.0.0", { since: "2026-12-01T00:00:00Z" }), { state: "measured", hit: false }, JSON.stringify(damage))
  }
}))

test("the bound remembers that it dropped entries, with a count and the time, and nothing else", () => scratch(async ({ env }) => {
  await recordKnownHit(env, 1, { version: "1.0.0", now: () => T1 })
  assert.equal((await readStatus(env))[DROPPED_KEY], undefined)
  for (let n = 2; n <= MAX_KNOWN_ISSUES + 2; n += 1) await recordKnownHit(env, n, { version: "1.0.0", now: () => T1 + n * 1000 })
  const status = await readStatus(env)
  assert.deepEqual(status[DROPPED_KEY], { count: 2, last_dropped_at: new Date(T1 + (MAX_KNOWN_ISSUES + 2) * 1000).toISOString() })
  const dropAt = new Date(T1 + (MAX_KNOWN_ISSUES + 2) * 1000).toISOString()
  assert.deepEqual(knownHitsSince(status, 1, "1.0.0", { since: dropAt }), { state: "unavailable", reason: "not_recorded" })
  assert.deepEqual(knownHitsSince(status, 4, "1.0.0", { since: dropAt }).state, "measured")
  // A drop before the window cannot hide a hit inside it.
  assert.deepEqual(knownHitsSince(status, 1, "1.0.0", { since: "2026-12-01T00:00:00Z" }), { state: "measured", hit: false })
}))

test("an invalid entry removed while recording counts as dropped, and a damaged drop record is rebuilt as dropped, never as zero", () => scratch(async ({ env }) => {
  await writeStatus(env, { [KNOWN_KEY]: { 3: "junk" }, [DROPPED_KEY]: "junk" })
  await recordKnownHit(env, 8, { version: "1.0.0", now: () => T1 })
  assert.deepEqual((await readStatus(env))[DROPPED_KEY], { count: 2, last_dropped_at: "2026-10-01T00:00:00.000Z" })
  await recordKnownHit(env, 9, { version: "1.0.0", now: () => T1 + 5000 })
  assert.deepEqual((await readStatus(env))[DROPPED_KEY], { count: 2, last_dropped_at: "2026-10-01T00:00:00.000Z" })
}))

test("reproduction r6: a recurrence the filer could not record is a drop, so the answer is not_recorded, never a measured no hit", () => scratch(async ({ env }) => {
  await armKnownHits(env, { now: () => T1 })
  const since = new Date(T1 + 1000).toISOString()
  assert.deepEqual(knownHitsSince(await readStatus(env), 123, "3.2.0", { since }), { state: "measured", hit: false }, "armed and nothing lost")
  assert.deepEqual(await recordLostHit(env, { now: () => T1 + 5000 }), { recorded: true })
  const status = await readStatus(env)
  assert.deepEqual(status[DROPPED_KEY], { count: 1, last_dropped_at: new Date(T1 + 5000).toISOString() })
  assert.equal(status[SINCE_KEY], new Date(T1).toISOString(), "the start time never moves")
  assert.deepEqual(knownHitsSince(status, 123, "3.2.0", { since }), { state: "unavailable", reason: "not_recorded" })
  // Variants: a window that starts after the drop is measured again; a drop count with no time is in every window.
  assert.deepEqual(knownHitsSince(status, 123, "3.2.0", { since: new Date(T1 + 6000).toISOString() }), { state: "measured", hit: false })
  assert.deepEqual(knownHitsSince({ ...status, [DROPPED_KEY]: { count: 1, last_dropped_at: null } }, 123, "3.2.0", { since: "2027-01-01T00:00:00Z" }), { state: "unavailable", reason: "not_recorded" })
  // A recorded hit still answers for its own issue.
  await recordKnownHit(env, 123, { version: "3.2.0", now: () => T1 + 7000 })
  assert.deepEqual(knownHitsSince(await readStatus(env), 123, "3.2.0", { since }), { state: "measured", hit: true })
}))

test("recordLostHit writes nothing in a headless session and reports a status it cannot write", () => scratch(async ({ env }) => {
  assert.deepEqual(await recordLostHit({ ...env, DESK_FACTORY_HEADLESS: "1" }), { recorded: false, code: "headless_session" })
  assert.equal((await readStatus(env))[DROPPED_KEY], undefined)
  assert.deepEqual(await recordLostHit(env), { recorded: true }, "the default clock")
  assert.deepEqual(await recordLostHit({ HOME: "relative" }, { now: () => T1 }), { recorded: false, code: "status_write_failed" })
}))
