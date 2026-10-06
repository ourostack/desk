// The improvement card library: one file per card, a stable key, a claim and legal moves.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { mkTempRoot } from "../_temp_roots.js"
import {
  SOURCES,
  STATES,
  MOVES,
  CLAIM_TTL_HOURS,
  MAX_CLAIMS_PER_DAY,
  MAX_LIVE_CLAIMS,
  MAX_CARD_FILES,
  SET_ASIDE_FOLDER,
  LOOP_ALARMS,
  EVALUATOR_NAMES,
  FLUSH_HEALTH_CODES,
  CLOSE_REASONS,
  CHECK_RESULTS,
  RECONCILE_REASONS,
  MEASURE_IDS,
  cardKey,
  cardFile,
  cardTitle,
  isClaimLive,
  openImprovement,
  readCards,
  claimNext,
  updateCard,
  machineKey,
} from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { RECONCILE_REASONS as SOURCE_REASONS } from "../../../../../plugins/desk/mcp/src/factory/reconcile-reasons.js"
import { MEASURE_IDS as SOURCE_MEASURES } from "../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"

const JOB = "0123456789abcdef0123456789abcdef"
const FP = "fedcba9876543210fedcba9876543210"
const PR_URL = "https://github.com/ourostack/desk/pull/12"
const ISSUE_URL = "https://github.com/ourostack/factory/issues/7"
const MACHINE = "a1b2c3d4e5f60718"
const MACHINE2 = "99887766554433ff"
const ANDON = "andon:ourostack/factory#1"

// UTC clocks: the day cap counts the UTC day.
const at = (day, hour = 12) => new Date(Date.UTC(2026, 9, day, hour, 0, 0, 0))
const iso = (date) => date.toISOString()

// A machine is a factory state folder: two state folders are two machines.
async function machineEnv() {
  const base = await mkTempRoot("desk-cards-state-")
  return { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
}

async function desk(prefix = "") {
  const deskRoot = await mkTempRoot("desk-cards-")
  return { deskRoot, personPrefix: prefix, env: await machineEnv() }
}

async function open(where, over = {}) {
  const key = over.key ?? ANDON
  return openImprovement({ ...where, key, source: typeof key === "string" ? key.split(":")[0] : "andon", evidence: ["issue:ourostack/factory#1"], plugin: "desk", signal: null, now: at(1), ...over })
}

const claim = (where, over = {}) => claimNext({ ...where, now: at(2), ...over })
const read = async (where) => (await readCards(where)).cards
const folderOf = (where) => path.dirname(cardFile(where.deskRoot, where.personPrefix, ANDON))
const reason = (n) => RECONCILE_REASONS[n]
const fileOf = (where, key) => cardFile(where.deskRoot, where.personPrefix, key)

// Writes a copy of an existing card under another key, without the library (for large folders).
async function plant(where, templateKey, key) {
  const text = await fs.readFile(fileOf(where, templateKey), "utf8")
  const file = fileOf(where, key)
  await fs.writeFile(file, text.replace(`key: ${JSON.stringify(templateKey)}`, `key: ${JSON.stringify(key)}`))
  return file
}

test("constants and vocabularies are single named, frozen values", () => {
  assert.equal(CLAIM_TTL_HOURS, 4)
  assert.equal(MAX_CLAIMS_PER_DAY, 2)
  assert.equal(MAX_LIVE_CLAIMS, 1)
  assert.equal(MAX_CARD_FILES, 2000)
  assert.equal(SET_ASIDE_FOLDER, "invalid")
  assert.deepEqual([...SOURCES], ["andon", "friction_candidate", "reconcile_class", "desk_problem", "store_build", "evaluator", "loop_alarm", "flush_health"])
  assert.deepEqual([...STATES], ["open", "claimed", "shipped", "verifying", "closed_confirmed", "closed_unverified"])
  for (const list of [SOURCES, STATES, MOVES, LOOP_ALARMS, EVALUATOR_NAMES, FLUSH_HEALTH_CODES, CLOSE_REASONS, CHECK_RESULTS]) assert.ok(Object.isFrozen(list))
  assert.deepEqual(MOVES.open, ["claimed", "closed_unverified"])
  assert.deepEqual(MOVES.closed_confirmed, ["open"])
  assert.deepEqual(MOVES.shipped, ["verifying", "closed_confirmed", "closed_unverified", "open"])
  assert.deepEqual([...EVALUATOR_NAMES], ["expired_requests", "gave_up"])
  assert.deepEqual([...FLUSH_HEALTH_CODES], ["no_account", "auth_failed", "gh_missing", "account_cannot_deliver", "route_unknown", "held_markers", "frozen"])
  assert.ok(LOOP_ALARMS.includes("cards_invalid") && LOOP_ALARMS.includes("step_stale:verify"))
  assert.equal(RECONCILE_REASONS, SOURCE_REASONS)
  assert.equal(MEASURE_IDS, SOURCE_MEASURES)
  for (const code of [...CLOSE_REASONS, ...CHECK_RESULTS]) assert.match(code, /^[a-z][a-z0-9_]*$/)
  for (const code of ["confirmed", "thin_data_after_14_checks", "merged_without_signal", "version_unavailable"]) assert.ok(CLOSE_REASONS.includes(code))
  for (const code of ["version_set", "confirmed", "not_confirmed", "thin_data", "countermeasure_not_merged"]) assert.ok(CHECK_RESULTS.includes(code))
})

test("cardKey builds and validates a key for every source", () => {
  assert.equal(cardKey("andon", "ourostack/factory#4"), "andon:ourostack/factory#4")
  assert.equal(cardKey("friction_candidate", FP), `friction_candidate:${FP}`)
  for (const name of RECONCILE_REASONS) assert.equal(cardKey("reconcile_class", name), `reconcile_class:${name}`)
  assert.equal(cardKey("desk_problem", "ourostack/desk#9"), "desk_problem:ourostack/desk#9")
  assert.equal(cardKey("store_build", "ourostack/factory#3"), "store_build:ourostack/factory#3")
  for (const name of EVALUATOR_NAMES) assert.equal(cardKey("evaluator", name), `evaluator:${name}`)
  for (const code of FLUSH_HEALTH_CODES) assert.equal(cardKey("flush_health", code), `flush_health:${code}`)
  for (const name of LOOP_ALARMS) assert.equal(cardKey("loop_alarm", name), `loop_alarm:${name}`)
  for (const [source, id] of [
    ["andon", "no-number"], ["desk_problem", "other/repo#9"], ["loop_alarm", "made_up"], ["nope", "x"], ["friction_candidate", "short"],
    ["reconcile_class", "made_up"], ["evaluator", "made_up"], ["flush_health", "made_up"],
  ]) assert.throws(() => cardKey(source, id), /invalid_source/, `${source}:${id}`)
})

test("cardFile is absolute and named source--12 hex of the key hash, in a crew desk under its prefix", () => {
  const key = cardKey("reconcile_class", "pr_open")
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 12)
  assert.equal(cardFile("/desk", "", key), path.join("/desk", "_meta", "improvement", `reconcile_class--${hex}.md`))
  assert.equal(cardFile("/desk", "desks/ari", key), path.join("/desk", "desks", "ari", "_meta", "improvement", `reconcile_class--${hex}.md`))
  assert.throws(() => cardFile("relative", "", key), /invalid_location/)
  assert.throws(() => cardFile("/desk", "../x", key), /invalid_location/)
  assert.throws(() => cardFile("/desk", "/abs", key), /invalid_location/)
  assert.throws(() => cardFile("/desk", "a//b", key), /invalid_location/)
  assert.throws(() => cardFile("/desk", "", "bad"), /invalid_source/)
})

test("cardTitle builds every title from a frozen table, a friction candidate from fixed words and closed-list values only", () => {
  assert.equal(cardTitle("andon", "ourostack/factory#1"), "Store build andon is open")
  assert.equal(cardTitle("store_build", "ourostack/factory#1"), "Store build is failing")
  assert.equal(cardTitle("desk_problem", "ourostack/desk#1"), "Desk problem filed as a GitHub issue")
  assert.equal(cardTitle("reconcile_class", "pr_open"), "Reconcile mismatch: pr_open")
  assert.equal(cardTitle("evaluator", "expired_requests"), "Evaluation requests expired without a label")
  assert.equal(cardTitle("evaluator", "gave_up"), "Evaluation requests were given up after repeated attempts")
  assert.equal(cardTitle("loop_alarm", "step_stale:route"), "Loop step route is stale")
  assert.equal(cardTitle("nope", FP), null)
  assert.equal(cardTitle("friction_candidate", FP), "System friction")
  assert.equal(cardTitle("friction_candidate", FP, { plugin: "desk", signal: null }), "System friction in the desk plugin")
  assert.equal(cardTitle("friction_candidate", FP, { plugin: "desk", signal: "tool_failures" }), "System friction in the desk plugin moving tool_failures")
  assert.equal(cardTitle("friction_candidate", FP, { plugin: "ms-tools", signal: "not_a_measure" }), "System friction")
  const all = [
    ...FLUSH_HEALTH_CODES.map((code) => cardTitle("flush_health", code)),
    ...LOOP_ALARMS.map((name) => cardTitle("loop_alarm", name)),
  ]
  for (const title of all) assert.match(title, /^[A-Za-z][A-Za-z ]{5,119}$/)
  assert.equal(new Set(all).size, all.length)
})

test("opening a new key writes one file with every field, state open, the library's title and no absolute path", async () => {
  const where = await desk()
  const result = await open(where)
  assert.equal(result.result, "opened")
  assert.equal(result.file, fileOf(where, ANDON))
  assert.ok(path.isAbsolute(result.file))
  const names = await fs.readdir(folderOf(where))
  assert.deepEqual(names, [path.basename(result.file)])
  assert.match(names[0], /^andon--[0-9a-f]{12}\.md$/)
  const [card] = await read(where)
  assert.deepEqual(Object.keys(card).sort(), [
    "checks_run", "claim", "claim_log", "close_reason", "closed_at", "countermeasure", "evidence", "kaizen_url", "key", "last_check_at",
    "last_check_result", "last_opened_at", "opened_at", "plugin", "recurrences", "reopened", "schema", "shipped_version", "signal", "source", "state", "title", "verifying_since",
  ])
  assert.equal(card.schema, "desk.improvement/1")
  assert.equal(card.key, ANDON)
  assert.equal(card.title, "Store build andon is open")
  assert.equal(card.state, "open")
  assert.equal(card.opened_at, iso(at(1)))
  assert.equal(card.last_opened_at, iso(at(1)))
  assert.deepEqual(card.evidence, ["issue:ourostack/factory#1"])
  assert.equal(card.claim, null)
  assert.deepEqual(card.claim_log, [])
  assert.equal(card.recurrences, 0)
  const text = await fs.readFile(result.file, "utf8")
  assert.ok(text.startsWith("---\n"))
  assert.ok(!text.includes(where.deskRoot))
  assert.deepEqual((await fs.readdir(path.dirname(folderOf(where)))).filter((n) => n.startsWith(".")), [])
})

test("a crew desk keeps its cards under its own prefix", async () => {
  const where = await desk("desks/ari")
  const result = await open(where)
  assert.equal(result.result, "opened")
  assert.ok(result.file.includes(path.join("desks", "ari", "_meta", "improvement")))
  assert.equal((await read(where)).length, 1)
})

test("opening the same key again is a duplicate and changes no byte", async () => {
  const where = await desk()
  const first = await open(where)
  const before = await fs.readFile(first.file, "utf8")
  const again = await open(where, { now: at(3), evidence: [`job:${JOB}`] })
  assert.deepEqual(again, { result: "duplicate", file: first.file })
  assert.equal(await fs.readFile(first.file, "utf8"), before)
})

test("opening a key whose card is closed reopens it, counts the recurrence, clears the mirror link and merges evidence up to 10", async () => {
  const where = await desk()
  const first = await open(where)
  const claimed = await claim(where)
  const closed = await updateCard({ ...where, key: ANDON, claim_id: claimed.claim_id, now: at(2), patch: { state: "closed_unverified", close_reason: "wont_fix", kaizen_url: ISSUE_URL } })
  assert.equal(closed.result, "updated")
  const reopened = await open(where, { now: at(5), evidence: [`job:${JOB}`] })
  assert.deepEqual(reopened, { result: "reopened", file: first.file })
  const [card] = await read(where)
  assert.equal(card.state, "open")
  assert.equal(card.recurrences, 1)
  assert.equal(card.last_opened_at, iso(at(5)))
  assert.equal(card.opened_at, iso(at(1)))
  assert.deepEqual(card.evidence, ["issue:ourostack/factory#1", `job:${JOB}`])
  for (const field of ["closed_at", "close_reason", "countermeasure", "shipped_version", "kaizen_url", "last_check_at", "last_check_result"]) assert.equal(card[field], null, field)
  assert.equal(card.checks_run, 0)
  assert.equal(card.claim.expires_at, null)

  const second = await claim(where, { now: at(5, 13) })
  await updateCard({ ...where, key: ANDON, claim_id: second.claim_id, now: at(5, 13), patch: { state: "closed_unverified", close_reason: "duplicate" } })
  const many = Array.from({ length: 10 }, (_, i) => `job:${String(i).padStart(32, "0")}`)
  await open(where, { now: at(6), evidence: many })
  const [merged] = await read(where)
  assert.equal(merged.recurrences, 2)
  assert.deepEqual(merged.evidence, many)

  const third = await claim(where, { now: at(6, 13) })
  await updateCard({ ...where, key: ANDON, claim_id: third.claim_id, now: at(6, 13), patch: { state: "closed_unverified", close_reason: "duplicate" } })
  await open(where, { now: at(7), evidence: [many[0]] })
  assert.deepEqual((await read(where))[0].evidence, many)
})

test("every source builds its own title; a supplied title is refused, a friction candidate's too", async () => {
  const where = await desk()
  const key = `friction_candidate:${FP}`
  for (const title of ["Fails: password=hunter2", "git push --force origin main fails", "Look in /Users/someone/work", "", undefined === 1 ? "" : "Anything"]) {
    assert.equal((await open(where, { key, title })).result, "title_not_allowed", title)
  }
  assert.equal((await open(where, { key, signal: "tool_failures" })).result, "opened")
  assert.equal((await read(where))[0].title, "System friction in the desk plugin moving tool_failures")
  assert.equal((await open(where, { title: "Anything" })).result, "title_not_allowed")
  assert.equal((await open(where, { title: "token is hunter2 for prod" })).result, "title_not_allowed")
  assert.equal((await open(where, { key: "loop_alarm:headless_blocked", evidence: [] })).result, "opened")
  assert.equal((await open(where, { key: "loop_alarm:step_stale:mirror", evidence: [] })).result, "opened")
  assert.deepEqual((await read(where)).map((card) => card.title).sort(), ["Loop step mirror is stale", "System friction in the desk plugin moving tool_failures", "The headless evaluator is blocked"])
})

test("evidence that is not one of the five pointer shapes is refused invalid_evidence", async () => {
  const where = await desk()
  const bad = [
    "/Users/me/file", "https://github.com/ourostack/factory/issues/1", "job:short", "issue:nope#1", "issue:ourostack/factory#x",
    "reconcile:pr_open", "reconcile:PR@2", "reconcile:made_up@2", "fingerprint:xyz", "pr:bad#1", "", 5,
  ]
  for (const item of bad) assert.equal((await open(where, { evidence: [item] })).result, "invalid_evidence", String(item))
  assert.equal((await open(where, { evidence: "job" })).result, "invalid_evidence")
  assert.equal((await open(where, { evidence: Array.from({ length: 11 }, (_, i) => `job:${String(i).padStart(32, "0")}`) })).result, "invalid_evidence")
  const good = [`job:${JOB}`, "issue:ourostack/factory#1", "reconcile:pr_open@3", `fingerprint:${FP}`, "pr:ourostack/desk#5"]
  assert.equal((await open(where, { evidence: good })).result, "opened")
  assert.deepEqual((await read(where))[0].evidence, good)
  assert.equal((await open(where, { key: cardKey("reconcile_class", "pr_open"), evidence: [] })).result, "opened")
})

test("an unknown source or a source and key mismatch is refused invalid_source", async () => {
  const where = await desk()
  assert.equal((await open(where, { key: ANDON, source: "evaluator" })).result, "invalid_source")
  assert.equal((await open(where, { key: ANDON, source: "nope" })).result, "invalid_source")
  assert.equal((await open(where, { key: "andon:bad" })).result, "invalid_source")
  assert.equal((await open(where, { key: 5 })).result, "invalid_source")
})

test("a bad plugin or signal is refused, and a location outside the desk is refused invalid_location", async () => {
  const where = await desk()
  assert.equal((await open(where, { plugin: "Bad Name" })).result, "invalid_plugin")
  assert.equal((await open(where, { signal: "Not A Measure" })).result, "invalid_signal")
  assert.equal((await open(where, { signal: "lead_time_made_up" })).result, "invalid_signal")
  assert.equal((await open(where, { signal: "flow_efficiency" })).result, "opened")
  assert.equal((await openImprovement({ deskRoot: "relative", personPrefix: "", key: ANDON, source: "andon", evidence: [], plugin: "desk", signal: null, now: at(1) })).result, "invalid_location")
  assert.equal((await open({ deskRoot: where.deskRoot, personPrefix: "../out" })).result, "invalid_location")
})

test("a missing or invalid clock is a programming error", async () => {
  const where = await desk()
  await assert.rejects(() => open(where, { now: "tomorrow" }), /now/)
  const result = await openImprovement({ ...where, key: "andon:ourostack/factory#2", source: "andon", evidence: [], plugin: "desk", signal: null })
  assert.equal(result.result, "opened")
  assert.ok(Math.abs(Date.parse((await read(where))[0].opened_at) - Date.now()) < 5000)
  await open(where, { key: "andon:ourostack/factory#3", now: at(1).getTime() })
  assert.equal((await read(where)).length, 2)
})

test("readCards returns the empty shape for a desk with no cards and flags an unreadable folder", async () => {
  const where = await desk()
  const empty = { cards: [], unreadable: false, truncated: false, skipped: {}, set_aside_total: 0, unreadable_files: 0 }
  assert.deepEqual(await readCards(where), empty)
  await fs.mkdir(path.join(where.deskRoot, "_meta"), { recursive: true })
  await fs.writeFile(path.join(where.deskRoot, "_meta", "improvement"), "a file, not a folder")
  assert.deepEqual(await readCards(where), { ...empty, unreadable: true })
  assert.deepEqual(await readCards({ deskRoot: "relative", personPrefix: "" }), { ...empty, unreadable: true })
  const linked = await desk()
  const target = await mkTempRoot("desk-cards-target-")
  await fs.mkdir(path.join(linked.deskRoot, "_meta"), { recursive: true })
  await fs.symlink(target, path.join(linked.deskRoot, "_meta", "improvement"))
  assert.equal((await readCards(linked)).unreadable, true)
  assert.deepEqual(await open(linked), { result: "unreadable_folder" })
})

test("readCards skips a symlink, an oversized file, a non-regular entry and files that do not parse, and counts each kind; it never reads invalid/", async () => {
  const where = await desk()
  const good = await open(where)
  const dir = folderOf(where)
  const goodText = await fs.readFile(good.file, "utf8")
  const outside = await mkTempRoot("desk-cards-outside-")
  await fs.writeFile(path.join(outside, "x.md"), goodText)
  await fs.symlink(path.join(outside, "x.md"), path.join(dir, "evaluator--aaaaaaaaaaaa.md"))
  await fs.writeFile(path.join(dir, "evaluator--bbbbbbbbbbbb.md"), goodText + "x".repeat(17 * 1024))
  await fs.mkdir(path.join(dir, "evaluator--cccccccccccc.md"))
  await fs.writeFile(path.join(dir, "evaluator--dddddddddddd.md"), "no front matter at all")
  await fs.writeFile(path.join(dir, "evaluator--eeeeeeeeeeee.md"), goodText.replace('schema: "desk.improvement/1"', "schema: {broken"))
  await fs.writeFile(path.join(dir, "evaluator--ffffffffffff.md"), goodText.replace('"andon"', '"nope"'))
  await fs.writeFile(path.join(dir, "notes.txt"), "stray")
  await fs.writeFile(path.join(dir, "andon--000000000000.md"), goodText)
  await fs.mkdir(path.join(dir, SET_ASIDE_FOLDER))
  await fs.writeFile(path.join(dir, SET_ASIDE_FOLDER, "junk.md"), "junk")
  const result = await readCards(where)
  assert.deepEqual(result.cards.map((card) => card.key), [ANDON])
  assert.deepEqual(result.skipped, { symlink: 1, too_large: 1, not_regular: 1, unparseable: 2, invalid: 1, foreign: 1, misnamed: 1 })
  assert.equal(result.truncated, false)
  assert.equal(result.unreadable, false)
})

test("front matter that is malformed in any way is never read as a card", async () => {
  const where = await desk()
  const good = await open(where)
  const dir = folderOf(where)
  const text = await fs.readFile(good.file, "utf8")
  const variants = [
    text.replace(/^---\n/, ""),
    text.replace(/\n---\n/, "\n"),
    text.replace('state: "open"', 'state: "open"\nstate: "open"'),
    text.replace('state: "open"', "state open"),
    text.replace('state: "open"', "state: open"),
    text.replace('state: "open"', 'state: "open"\nextra: 1'),
    text.replace('state: "open"\n', ""),
  ]
  for (const [i, body] of variants.entries()) await fs.writeFile(path.join(dir, `evaluator--00000000000${i}.md`), body)
  const result = await readCards(where)
  assert.equal(result.cards.length, 1)
  assert.equal(result.skipped.unparseable + result.skipped.invalid, 7)
})

test("a card whose fields break a rule is not read as a card", async () => {
  const where = await desk()
  const good = await open(where)
  const dir = folderOf(where)
  const text = await fs.readFile(good.file, "utf8")
  const swap = (from, to) => {
    assert.ok(text.includes(from), from)
    return text.replace(from, to)
  }
  const liveClaim = '{"claim_id":"11111111-1111-4111-8111-111111111111","claimed_at":"' + iso(at(1)) + '","expires_at":null,"machine":"' + MACHINE + '","session":null}'
  const cases = [
    swap('title: "Store build andon is open"', 'title: "Look in /Users/x/y"'),
    swap('title: "Store build andon is open"', 'title: "Some other words"'),
    swap('title: "Store build andon is open"', "title: 5"),
    swap('evidence: ["issue:ourostack/factory#1"]', 'evidence: ["/Users/x"]'),
    swap("countermeasure: null", 'countermeasure: "https://example.com/pull/1"'),
    swap("kaizen_url: null", 'kaizen_url: "https://github.com/a/b/pull/1"'),
    swap('state: "open"', 'state: "claimed"'),
    swap('state: "open"', 'state: "shipped"'),
    swap('state: "open"', 'state: "verifying"'),
    swap('state: "open"', 'state: "closed_confirmed"'),
    swap('state: "open"', 'state: "sleeping"'),
    swap('opened_at: "' + iso(at(1)) + '"', 'opened_at: "yesterday"'),
    swap("recurrences: 0", "recurrences: -1"),
    swap("reopened: 0", 'reopened: "0"'),
    swap("claim: null", "claim: []"),
    swap("claim: null", "claim: 5"),
    swap("claim_log: []", 'claim_log: ["x"]'),
    swap("claim_log: []", 'claim_log: [{"at":"x","machine":"' + MACHINE + '"}]'),
    swap("claim_log: []", 'claim_log: [{"at":"' + iso(at(1)) + '","machine":"HOST"}]'),
    swap("claim_log: []", "claim_log: {}"),
    swap("claim_log: []", "claim_log: [" + Array.from({ length: 11 }, () => '{"at":"' + iso(at(1)) + '","machine":"' + MACHINE + '"}').join(",") + "]"),
    swap('plugin: "desk"', 'plugin: "Bad Name"'),
    swap("shipped_version: null", 'shipped_version: "v1"'),
    swap("last_check_result: null", 'last_check_result: "free_text"'),
    swap("closed_at: null", 'closed_at: "' + iso(at(1)) + '"'),
    swap("close_reason: null", 'close_reason: "confirmed"'),
    swap("signal: null", 'signal: "Not A Measure"'),
    swap('schema: "desk.improvement/1"', 'schema: "desk.improvement/2"'),
    swap('source: "andon"', 'source: "evaluator"'),
    swap('key: "andon:ourostack/factory#1"', 'key: "andon:other"'),
    swap('last_opened_at: "' + iso(at(1)) + '"', 'last_opened_at: "x"'),
    swap('state: "open"', 'state: "claimed"').replace("claim: null", `claim: ${liveClaim}`),
    swap("claim: null", `claim: ${liveClaim.replace('"session":null', '"session":"x"')}`),
    swap("claim: null", `claim: ${liveClaim.replace('"session":null', '"session":null,"extra":1')}`),
    swap("claim: null", `claim: ${liveClaim.replace("11111111-1111-4111-8111-111111111111", "bad")}`),
    swap("claim: null", `claim: ${liveClaim.replace(`"machine":"${MACHINE}"`, '"machine":"host.local"')}`),
  ]
  for (const [i, body] of cases.entries()) await fs.writeFile(path.join(dir, `evaluator--${String(i).padStart(12, "0")}.md`), body)
  const result = await readCards({ ...where, limit: 500 })
  assert.equal(result.cards.length, 1, JSON.stringify(result.skipped))
  assert.equal(result.skipped.invalid + (result.skipped.misnamed ?? 0), cases.length)
})

test("more than the limit returns the first files sorted by name and sets truncated", async () => {
  const where = await desk()
  for (let i = 0; i < 4; i += 1) await open(where, { key: cardKey("reconcile_class", reason(i)), evidence: [] })
  const all = (await fs.readdir(folderOf(where))).sort()
  const result = await readCards({ ...where, limit: 3 })
  assert.equal(result.truncated, true)
  assert.deepEqual(result.cards.map((card) => path.basename(fileOf(where, card.key))), all.slice(0, 3))
  assert.equal((await readCards({ ...where, limit: 4 })).truncated, false)
  assert.equal((await readCards(where)).cards.length, 4)
})

test("claimNext takes the open card with the oldest last_opened_at and sets a claim with a 4-hour expiry", async () => {
  const where = await desk()
  await open(where, { key: cardKey("reconcile_class", reason(0)), now: at(3), evidence: [] })
  await open(where, { key: cardKey("reconcile_class", reason(1)), now: at(2), evidence: [] })
  await open(where, { key: cardKey("reconcile_class", reason(3)), now: at(4), evidence: [] })
  await open(where, { key: cardKey("reconcile_class", reason(2)), now: at(4), evidence: [] })
  const session = "22222222-2222-4222-8222-222222222222"
  const now = at(10)
  const got = await claim(where, { now, session })
  assert.equal(got.result, "claimed")
  assert.equal(got.card.key, `reconcile_class:${reason(1)}`)
  assert.match(got.claim_id, /^[0-9a-f-]{36}$/)
  assert.equal(got.card.state, "claimed")
  assert.deepEqual(got.card.claim, { claim_id: got.claim_id, claimed_at: iso(now), expires_at: iso(new Date(now.getTime() + 4 * 3600 * 1000)), machine: await machineKey(where.env), session })
  assert.deepEqual(got.card.claim_log, [{ at: iso(now), machine: await machineKey(where.env) }])
  assert.equal(got.file, fileOf(where, got.card.key))
  const stored = (await read(where)).find((card) => card.key === got.card.key)
  assert.deepEqual(stored, got.card)
  assert.equal(isClaimLive(stored, at(10, 15)), true)
  assert.equal(isClaimLive(stored, at(10, 16)), false)
  assert.equal(isClaimLive({ claim: null }, at(10)), false)
  // the next oldest, by key order on equal age, once the first claim is released
  await updateCard({ ...where, key: got.card.key, claim_id: got.claim_id, now, patch: { state: "open" } })
  const next = await claim(where, { now: at(11) })
  assert.equal(next.card.key, `reconcile_class:${reason(1)}`)
})

test("equal ages are taken in key order", async () => {
  const where = await desk()
  await open(where, { key: cardKey("reconcile_class", reason(3)), now: at(4), evidence: [] })
  await open(where, { key: cardKey("reconcile_class", reason(2)), now: at(4), evidence: [] })
  assert.equal((await claim(where)).card.key, `reconcile_class:${reason(3)}`)
})

test("claimNext also takes a claimed card whose claim expired, and logs the new claim", async () => {
  const where = await desk()
  await open(where, { now: at(1) })
  const first = await claim(where, { now: at(2, 8) })
  const held = await claim(where, { now: at(2, 9) })
  assert.deepEqual(held, { result: "claim_held", key: ANDON })
  const again = await claim(where, { now: at(2, 13) })
  assert.equal(again.result, "claimed")
  assert.notEqual(again.claim_id, first.claim_id)
  assert.equal(again.card.claim.session, null)
  assert.deepEqual(again.card.claim_log, [{ at: iso(at(2, 8)), machine: await machineKey(where.env) }, { at: iso(at(2, 13)), machine: await machineKey(where.env) }])
  const old = await updateCard({ ...where, key: ANDON, claim_id: first.claim_id, now: at(2, 14), patch: { countermeasure: PR_URL } })
  assert.equal(old.result, "not_your_claim")
})

test("claimNext keeps only the last ten claim times", async () => {
  const where = await desk()
  await open(where, { now: at(1) })
  for (let i = 0; i < 12; i += 1) await claim(where, { now: at(2 + i, 8) })
  const [card] = await read(where)
  assert.equal(card.claim_log.length, 10)
  assert.equal(card.claim_log.at(-1).at, iso(at(13, 8)))
})

test("claimNext says claim_held for a live claim, cap_reached after 2 claims in the UTC day and none_open when nothing is open", async () => {
  const where = await desk()
  assert.deepEqual(await claim(where), { result: "none_open" })
  for (let i = 0; i < 3; i += 1) await open(where, { key: cardKey("reconcile_class", reason(i)), evidence: [], now: at(1) })
  const one = await claim(where, { now: at(2, 8) })
  assert.deepEqual(await claim(where, { now: at(2, 9) }), { result: "claim_held", key: one.card.key })
  await updateCard({ ...where, key: one.card.key, claim_id: one.claim_id, now: at(2, 9), patch: { state: "open" } })
  const two = await claim(where, { now: at(2, 10) })
  assert.equal(two.result, "claimed")
  await updateCard({ ...where, key: two.card.key, claim_id: two.claim_id, now: at(2, 10), patch: { state: "open" } })
  assert.deepEqual(await claim(where, { now: at(2, 23) }), { result: "cap_reached" })
  assert.equal((await claim(where, { now: at(3, 0) })).result, "claimed")
})

test("the live claim and the day cap are per machine, and a card with another machine's live claim is not offered", async () => {
  const where = await desk()
  for (let i = 0; i < 2; i += 1) await open(where, { key: cardKey("reconcile_class", reason(i)), evidence: [], now: at(1) })
  const a = await claim(where, { now: at(2, 8) })
  const two = { ...where, env: await machineEnv() }
  const b = await claim(two, { now: at(2, 9) })
  assert.equal(b.result, "claimed")
  assert.notEqual(b.card.key, a.card.key)
  assert.equal(b.card.claim.machine, await machineKey(two.env))
  assert.match(b.card.claim.machine, /^[0-9a-f]{32}$/)
  assert.notEqual(b.card.claim.machine, a.card.claim.machine)
  assert.deepEqual(await claim(two, { now: at(2, 10) }), { result: "claim_held", key: b.card.key })
  assert.deepEqual(await claim(where, { now: at(2, 10) }), { result: "claim_held", key: a.card.key })
  await updateCard({ ...where, key: a.card.key, claim_id: a.claim_id, now: at(2, 10), patch: { state: "open" } })
  await updateCard({ ...where, key: b.card.key, claim_id: b.claim_id, now: at(2, 10), patch: { state: "open" } })
  // machine A has used one claim today, machine B one: each may claim once more
  assert.equal((await claim(where, { now: at(2, 11) })).result, "claimed")
  assert.equal((await claim(two, { now: at(2, 11) })).result, "claimed")
  // with only the other machine's live claim left to take, nothing is offered
  const solo = await desk()
  await open(solo, { now: at(1) })
  await claim(solo, { now: at(2, 8) })
  assert.deepEqual(await claim({ ...solo, env: await machineEnv() }, { now: at(2, 9) }), { result: "none_open" })
})

test("two simultaneous claimNext calls on one open card give exactly one claimed", async () => {
  const where = await desk()
  await open(where)
  const results = await Promise.all([claim(where), claim(where), claim(where)])
  assert.equal(results.filter((r) => r.result === "claimed").length, 1)
  assert.equal(results.filter((r) => r.result === "claim_held").length, 2)
  assert.equal((await read(where))[0].claim_log.length, 1)
})

test("claimNext refuses a bad machine, a bad session and a bad location", async () => {
  const where = await desk()
  assert.deepEqual(await claim(where, { session: "not-a-session" }), { result: "invalid_session" })
  // no caller supplies a key: with no readable factory state there is no key, and no claim
  const blocker = path.join(where.deskRoot, "a-file")
  await fs.writeFile(blocker, "x")
  for (const env of [{ ...where.env, XDG_STATE_HOME: path.join(blocker, "state") }]) {
    assert.deepEqual(await claim(where, { env }), { result: "machine_key_unavailable" })
  }
  assert.equal(await machineKey({ ...where.env, XDG_STATE_HOME: path.join(blocker, "state") }), null)
  assert.equal(await machineKey(where.env), await machineKey(where.env))
  assert.notEqual(await machineKey(where.env), await machineKey(await machineEnv()))
  assert.deepEqual(await claim(where, { machine: "abcdef012345" }).then((r) => r.result), "none_open")
  const blocked = await desk()
  await fs.mkdir(path.join(blocked.deskRoot, "_meta"), { recursive: true })
  await fs.writeFile(path.join(blocked.deskRoot, "_meta", "improvement"), "x")
  assert.deepEqual(await claim(blocked), { result: "unreadable_folder" })
  assert.deepEqual(await claim({ deskRoot: "relative", personPrefix: "" }), { result: "invalid_location" })
  assert.deepEqual(await claim(where), { result: "none_open" })
})

test("a claim whose card sits past the 200th file still holds, and the oldest card past it is still offered", async () => {
  const where = await desk()
  await open(where, { now: at(3) })
  await open(where, { key: "store_build:ourostack/factory#1", now: at(1) })
  await fs.rm(fileOf(where, ANDON)) // replaced by 205 copies below
  await open(where, { now: at(3) })
  const held = await claim(where)
  assert.equal(held.card.key, "store_build:ourostack/factory#1")
  for (let i = 2; i < 207; i += 1) await plant(where, ANDON, `andon:ourostack/factory#${i}`)
  assert.equal((await readCards(where)).truncated, true)
  assert.deepEqual(await claim(where, { now: at(2, 9) }), { result: "claim_held", key: "store_build:ourostack/factory#1" })
  // release it: the oldest open card is the store_build one, which sorts after the 200th name
  await updateCard({ ...where, key: "store_build:ourostack/factory#1", claim_id: held.claim_id, now: at(2, 9), patch: { state: "open" } })
  const next = await claim({ ...where, env: await machineEnv() }, { now: at(2, 10) })
  assert.equal(next.card.key, "store_build:ourostack/factory#1")
})

test("claimNext, openImprovement and updateCard refuse too_many_cards past 2000 files instead of guessing", async () => {
  const where = await desk()
  await open(where)
  await open(where, { key: "store_build:ourostack/factory#1" })
  for (let i = 2; i < MAX_CARD_FILES + 2; i += 1) await plant(where, ANDON, `andon:ourostack/factory#${i}`)
  assert.deepEqual(await claim(where), { result: "too_many_cards" })
  // the card at the key's own path sorts past the bound and is not a card: it cannot be repaired, so it is refused
  await fs.writeFile(fileOf(where, "store_build:ourostack/factory#1"), "garbage")
  assert.deepEqual(await open(where, { key: "store_build:ourostack/factory#1" }), { result: "too_many_cards" })
  assert.deepEqual(await updateCard({ ...where, key: "store_build:ourostack/factory#1", now: at(2), patch: { checks_run: 1 } }), { result: "too_many_cards" })
  assert.equal(await fs.readFile(fileOf(where, "store_build:ourostack/factory#1"), "utf8"), "garbage")
})

test("an invalid, oversized or symlinked card is moved aside by rename, never rewritten, and its claim no longer counts", async () => {
  const where = await desk()
  const dir = folderOf(where)
  await open(where, { now: at(1) })
  await open(where, { key: "store_build:ourostack/factory#1", now: at(2) })
  const held = await claim(where, { now: at(3, 8) })
  assert.equal(held.card.key, ANDON)
  const original = await fs.readFile(held.file, "utf8")
  const conflicted = `<<<<<<< HEAD\n${original}`
  await fs.writeFile(held.file, conflicted)
  const outside = await mkTempRoot("desk-cards-outside-")
  await fs.writeFile(path.join(outside, "target.md"), original)
  const linkName = path.join(dir, "evaluator--aaaaaaaaaaaa.md")
  await fs.symlink(path.join(outside, "target.md"), linkName)
  await fs.writeFile(path.join(dir, "evaluator--bbbbbbbbbbbb.md"), original + "x".repeat(17 * 1024))
  await fs.mkdir(path.join(dir, "evaluator--cccccccccccc.md"))
  await fs.writeFile(path.join(dir, "notes.txt"), "a stray file is left alone")
  const next = await claim(where, { now: at(3, 9) })
  assert.equal(next.result, "claimed")
  assert.equal(next.card.key, "store_build:ourostack/factory#1")
  assert.equal(next.set_aside, 4)
  assert.equal((await readCards(where)).set_aside_total, 4)
  assert.equal((await readCards(where)).unreadable_files, 0)
  assert.equal(next.set_aside_files.length, 8)
  assert.ok(next.set_aside_files.every((file) => path.isAbsolute(file)))
  assert.equal(next.set_aside_files[0], held.file)
  const moved = next.set_aside_files[1]
  assert.ok(moved.startsWith(path.join(dir, SET_ASIDE_FOLDER, path.basename(held.file))))
  assert.equal(await fs.readFile(moved, "utf8"), conflicted)
  await assert.rejects(() => fs.lstat(held.file))
  await assert.rejects(() => fs.lstat(linkName))
  assert.ok((await fs.lstat(next.set_aside_files.find((file) => file.includes("aaaaaaaaaaaa") && file.includes(SET_ASIDE_FOLDER)))).isSymbolicLink())
  assert.equal(await fs.readFile(path.join(outside, "target.md"), "utf8"), original)
  assert.equal(await fs.readFile(path.join(dir, "notes.txt"), "utf8"), "a stray file is left alone")
  assert.equal((await readCards(where)).skipped.foreign, 1)
  // a later call has nothing left to move, so it reports nothing
  const quiet = await claim(where, { now: at(3, 10) })
  assert.equal(quiet.set_aside, undefined)
  assert.ok(LOOP_ALARMS.includes("cards_invalid"))
})

test("a bad file at a key's own path is moved aside before openImprovement and updateCard act", async () => {
  const where = await desk()
  const first = await open(where)
  await fs.writeFile(first.file, "garbage")
  const reopened = await open(where, { now: at(2) })
  assert.equal(reopened.result, "opened")
  assert.equal(reopened.set_aside, 1)
  assert.equal(await fs.readFile(reopened.set_aside_files[1], "utf8"), "garbage")
  assert.equal((await read(where))[0].opened_at, iso(at(2)))
  await fs.writeFile(first.file, "garbage again")
  const updated = await updateCard({ ...where, key: ANDON, now: at(3), patch: { checks_run: 1 } })
  assert.equal(updated.result, "not_found")
  assert.equal(updated.set_aside, 1)
})

const lockOf = (where) => path.join(path.dirname(folderOf(where)), ".improvement.lock")
const OLD = new Date(Date.now() - 3 * 60 * 1000)
async function makeLock(lock, token, stale) {
  await fs.mkdir(path.join(lock, token), { recursive: true })
  if (stale) await fs.utimes(path.join(lock, token), OLD, OLD)
}

test("a stale lock older than two minutes is taken over, a fresh one makes the call wait and then give up as lock_busy", async () => {
  const where = await desk()
  await open(where)
  const lock = lockOf(where)
  await makeLock(lock, "old-token", true)
  assert.equal((await claim(where)).result, "claimed")
  await assert.rejects(() => fs.stat(lock))
  await makeLock(lock, "fresh-token", false)
  const started = Date.now()
  assert.deepEqual(await updateCard({ ...where, key: ANDON, now: at(2), patch: { kaizen_url: ISSUE_URL }, lockWaitMs: 60 }), { result: "lock_busy" })
  assert.ok(Date.now() - started < 1500)
  assert.deepEqual(await claim(where, { lockWaitMs: 30 }), { result: "lock_busy" })
  assert.equal((await open(where, { key: "andon:ourostack/factory#9", lockWaitMs: 30 })).result, "lock_busy")
  assert.deepEqual(await fs.readdir(lock), ["fresh-token"])
  // an empty lock directory older than two minutes (its creator died between the two steps) is stale too, a fresh empty one is not
  await fs.rm(lock, { recursive: true })
  await fs.mkdir(lock)
  assert.deepEqual(await claim(where, { lockWaitMs: 30 }), { result: "lock_busy" })
  await fs.utimes(lock, OLD, OLD)
  assert.equal((await claim(where, { now: at(3) })).result, "claimed")
  // a lock path that is not a directory never makes the caller spin past its wait
  await fs.writeFile(lock, "not a directory")
  assert.deepEqual(await claim(where, { lockWaitMs: 30 }), { result: "lock_busy" })
  await fs.rm(lock)
})

test("the takeover interleaving cannot remove a lock that replaced the stale one", async () => {
  const where = await desk()
  await open(where)
  const lock = lockOf(where)
  // Waiter W saw the stale lock; before W acts, the lock is taken over and a live holder makes a fresh one.
  await makeLock(lock, "old-token", true)
  const replaced = await claim(where, {
    lockWaitMs: 60,
    lockHooks: { afterStale: async () => { await fs.rm(lock, { recursive: true }); await makeLock(lock, "live-token", false) } },
  })
  assert.deepEqual(replaced, { result: "lock_busy" })
  assert.deepEqual(await fs.readdir(lock), ["live-token"])
  // the stale lock vanished on its own while the waiter looked: the waiter just takes the free lock
  await fs.rm(lock, { recursive: true })
  await makeLock(lock, "old-token", true)
  const vanished = await claim(where, { lockHooks: { afterStale: async () => { await fs.rm(lock, { recursive: true }) } } })
  assert.equal(vanished.result, "claimed")
  // a creator whose lock directory is removed before it can make its token directory starts again
  let fired = false
  const retried = await claim(where, {
    now: at(3),
    lockHooks: { afterLockDir: async () => { if (!fired) { fired = true; await fs.rmdir(lock) } } },
  })
  assert.equal(fired, true)
  assert.equal(retried.result, "claimed")
})

test("a holder whose lock was taken over does not remove the new holder's lock", async () => {
  const where = await desk()
  await open(where)
  const lock = lockOf(where)
  const result = await claim(where, { lockHooks: { beforeRelease: async () => { await fs.rm(lock, { recursive: true }); await makeLock(lock, "someone-else", false) } } })
  assert.equal(result.result, "claimed")
  assert.deepEqual(await fs.readdir(lock), ["someone-else"])
  await fs.rm(lock, { recursive: true })
  assert.equal((await claim(where, { now: at(2, 13) })).result, "claim_held")
  await assert.rejects(() => fs.stat(lock))
})

async function shipped(where, key = ANDON) {
  await open(where, { key })
  const got = await claim(where)
  await updateCard({ ...where, key, claim_id: got.claim_id, now: at(2), patch: { state: "shipped", countermeasure: PR_URL } })
  return got
}

test("updateCard accepts the edges it may make, refuses the others with invalid_move, and keeps the counts honest", async () => {
  const where = await desk()
  const state = async () => (await read(where))[0].state
  const upd = (patch, claim_id, hour = 3) => updateCard({ ...where, key: ANDON, claim_id, now: at(2, hour), patch })
  await open(where)
  const c1 = await claim(where, { now: at(2, 1) })
  // claimed -> open (release) does not count as a reopen
  assert.equal((await upd({ state: "open" }, c1.claim_id)).result, "updated")
  assert.equal(await state(), "open")
  assert.equal((await read(where))[0].claim.expires_at, null)
  assert.equal((await read(where))[0].reopened, 0)
  for (const next of ["shipped", "verifying", "closed_confirmed", "claimed"]) {
    assert.deepEqual(await upd({ state: next, countermeasure: PR_URL, shipped_version: "1.0.0", close_reason: "wont_fix" }), { result: "invalid_move", allowed: ["closed_unverified"] })
  }
  const c2 = await claim(where, { now: at(2, 4) })
  assert.deepEqual(await upd({ state: "shipped" }, c2.claim_id), { result: "missing_countermeasure" })
  const toShipped = await upd({ state: "shipped", countermeasure: PR_URL }, c2.claim_id)
  assert.equal(toShipped.file, fileOf(where, ANDON))
  assert.equal(toShipped.card.state, "shipped")
  assert.equal((await read(where))[0].claim.expires_at, null)
  assert.deepEqual(await upd({ state: "verifying" }), { result: "missing_version" })
  assert.deepEqual(await upd({ state: "claimed" }), { result: "invalid_move", allowed: ["verifying", "closed_confirmed", "closed_unverified", "open"] })
  assert.equal((await upd({ state: "verifying", shipped_version: "1.4.0-alpha.7", kaizen_url: ISSUE_URL, last_check_result: "version_set" })).result, "updated")
  // verifying -> open (a failed verification) always counts and clears the cycle
  assert.equal((await upd({ checks_run: 1 })).result, "updated")
  assert.equal((await upd({ state: "open", evidence: ["issue:ourostack/factory#1", "issue:ourostack/factory#2"] })).result, "updated")
  const reopened = (await read(where))[0]
  assert.equal(reopened.reopened, 1)
  for (const field of ["countermeasure", "shipped_version", "last_check_at", "last_check_result"]) assert.equal(reopened[field], null, field)
  assert.equal(reopened.checks_run, 0)
  assert.equal(reopened.kaizen_url, ISSUE_URL)
  assert.equal(reopened.last_opened_at, iso(at(1)))
  // shipped -> open counts too
  const c3 = await claim(where, { now: at(3, 5) })
  await upd({ state: "shipped", countermeasure: PR_URL }, c3.claim_id)
  assert.equal((await upd({ state: "open" })).result, "updated")
  assert.equal((await read(where))[0].reopened, 2)
  // shipped -> closed_unverified
  const c4 = await claim(where, { now: at(4, 5) })
  await upd({ state: "shipped", countermeasure: PR_URL }, c4.claim_id)
  assert.deepEqual(await upd({ state: "closed_unverified" }), { result: "missing_close_reason" })
  const closedU = await upd({ state: "closed_unverified", close_reason: "thin_data_after_14_checks" })
  assert.equal(closedU.card.closed_at, iso(at(2, 3)))
  assert.equal(closedU.card.close_reason, "thin_data_after_14_checks")
  // closed -> open is made by openImprovement, not by updateCard
  assert.deepEqual(await upd({ state: "open" }), { result: "invalid_move", allowed: [] })
  assert.equal((await open(where, { now: at(9) })).result, "reopened")
  const c5 = await claim(where, { now: at(5, 5) })
  await upd({ state: "shipped", countermeasure: PR_URL }, c5.claim_id)
  await upd({ state: "verifying", shipped_version: "1.4.0" })
  assert.equal((await upd({ state: "closed_confirmed", close_reason: "confirmed" })).card.state, "closed_confirmed")
  assert.deepEqual(await upd({ state: "shipped" }), { result: "invalid_move", allowed: [] })
  await open(where, { now: at(10) })
  const c6 = await claim(where, { now: at(6, 5) })
  await upd({ state: "shipped", countermeasure: PR_URL }, c6.claim_id)
  await upd({ state: "verifying", shipped_version: "1.4.0" })
  assert.equal((await upd({ state: "closed_unverified", close_reason: "version_unavailable" })).result, "updated")
  await open(where, { now: at(11) })
  const c7 = await claim(where, { now: at(7, 5) })
  assert.equal((await upd({ state: "closed_unverified", close_reason: "wont_fix" }, c7.claim_id)).result, "updated")
})

test("system patches on a card nobody has claimed are accepted, a wrong claim_id on a claimed card is refused", async () => {
  const where = await desk()
  await shipped(where)
  const patch = { kaizen_url: ISSUE_URL, shipped_version: "1.4.0", last_check_at: iso(at(3)), last_check_result: "thin_data", plugin: "desk", signal: "flow_efficiency", evidence: ["issue:ourostack/factory#1", "issue:ourostack/factory#4"] }
  assert.equal((await updateCard({ ...where, key: ANDON, now: at(3), patch: { ...patch, state: "verifying" } })).result, "updated")
  const card = (await read(where))[0]
  for (const [field, value] of Object.entries(patch)) assert.deepEqual(card[field], value, field)
  assert.equal(card.state, "verifying")
  assert.equal(card.checks_run, 0)

  const other = await desk()
  await open(other)
  const live = await claim(other)
  const upd = (extra) => updateCard({ ...other, key: ANDON, now: at(2), patch: { countermeasure: PR_URL }, ...extra })
  assert.deepEqual(await upd({ claim_id: "99999999-9999-4999-8999-999999999999" }), { result: "not_your_claim" })
  assert.deepEqual(await upd({}), { result: "not_your_claim" })
  assert.equal((await upd({ claim_id: live.claim_id })).result, "updated")
  const late = { now: at(2, 20), patch: { last_check_result: "waiting" } }
  assert.equal((await upd({ ...late })).result, "updated")
  assert.equal((await upd({ ...late, claim_id: "99999999-9999-4999-8999-999999999999" })).result, "not_your_claim")
  assert.equal((await upd({ ...late, claim_id: live.claim_id, patch: { state: "shipped" } })).result, "updated")
})

test("counters can only rise by their own rules, and close fields are null unless the card is closed", async () => {
  const where = await desk()
  await shipped(where)
  const upd = (patch) => updateCard({ ...where, key: ANDON, now: at(2), patch })
  assert.deepEqual(await upd({ reopened: 0 }), { result: "unknown_field", field: "reopened" })
  assert.deepEqual(await upd({ recurrences: 5 }), { result: "unknown_field", field: "recurrences" })
  assert.deepEqual(await upd({ checks_run: 2 }), { result: "invalid_patch", field: "checks_run" })
  assert.deepEqual(await upd({ checks_run: 0 }), { result: "invalid_patch", field: "checks_run" })
  assert.equal((await upd({ checks_run: 1 })).result, "updated")
  assert.deepEqual(await upd({ checks_run: 1 }), { result: "invalid_patch", field: "checks_run" })
  assert.equal((await upd({ checks_run: 2 })).card.checks_run, 2)
  assert.deepEqual(await upd({ close_reason: "wont_fix" }), { result: "invalid_patch", field: "close_reason" })
  assert.deepEqual(await upd({ closed_at: iso(at(2)) }), { result: "unknown_field", field: "closed_at" })
  assert.equal((await read(where))[0].close_reason, null)
  // a check is recorded only on a shipped or verifying card, not on an open or claimed one, nor in a move to open
  assert.deepEqual(await upd({ state: "open", checks_run: 3 }), { result: "invalid_patch", field: "checks_run" })
  const other = await desk()
  await open(other)
  assert.deepEqual(await updateCard({ ...other, key: ANDON, now: at(2), patch: { checks_run: 1 } }), { result: "invalid_patch", field: "checks_run" })
  const held = await claim(other)
  assert.deepEqual(await updateCard({ ...other, key: ANDON, claim_id: held.claim_id, now: at(2), patch: { checks_run: 1 } }), { result: "invalid_patch", field: "checks_run" })
})

test("updateCard refuses immutable fields, unknown fields, empty patches and values outside the vocabularies", async () => {
  const where = await desk()
  await open(where)
  const upd = (patch) => updateCard({ ...where, key: ANDON, now: at(2), patch })
  for (const field of ["key", "source", "opened_at"]) assert.deepEqual(await upd({ [field]: "x" }), { result: "immutable_field", field })
  for (const field of ["claim", "claim_log", "last_opened_at", "closed_at", "schema", "title", "mystery"]) assert.deepEqual(await upd({ [field]: "x" }), { result: "unknown_field", field })
  assert.deepEqual(await upd({ countermeasure: "https://github.com/ourostack/desk/issues/1" }), { result: "invalid_countermeasure" })
  assert.deepEqual(await upd({ countermeasure: "https://example.com/o/r/pull/1" }), { result: "invalid_countermeasure" })
  assert.deepEqual(await upd({ countermeasure: 5 }), { result: "invalid_countermeasure" })
  assert.deepEqual(await upd({ kaizen_url: "https://github.com/ourostack/factory/pull/1" }), { result: "invalid_kaizen_url" })
  assert.deepEqual(await upd({ kaizen_url: "https://github.com/ourostack/factory/issues/7?x=/Users/a" }), { result: "invalid_kaizen_url" })
  for (const patch of [
    { state: "sleeping" }, { plugin: "A B" }, { signal: "A B" }, { signal: "made_up" }, { shipped_version: "v1" }, { checks_run: -1 }, { checks_run: 1.5 }, { checks_run: "1" },
    { last_check_at: "now" }, { last_check_result: "Some free text" }, { last_check_result: "made_up" }, { close_reason: "has spaces" }, { close_reason: "made_up" },
    { evidence: ["/Users/x"] }, { evidence: "job" }, { evidence: Array.from({ length: 11 }, (_, i) => `job:${String(i).padStart(32, "0")}`) },
  ]) {
    const [field] = Object.keys(patch)
    assert.deepEqual(await upd(patch), { result: "invalid_patch", field }, JSON.stringify(patch))
  }
  for (const empty of [null, [], "x", {}]) assert.deepEqual(await updateCard({ ...where, key: ANDON, now: at(2), patch: empty }), { result: "invalid_patch", field: "patch" })
  for (const code of CLOSE_REASONS) assert.equal(typeof code, "string")
  for (const code of CHECK_RESULTS) assert.equal((await upd({ last_check_result: code })).result, "updated", code)
  const deduped = await upd({ evidence: [`job:${JOB}`, `job:${JOB}`, "issue:ourostack/factory#1"] })
  assert.deepEqual(deduped.card.evidence, [`job:${JOB}`, "issue:ourostack/factory#1"])
  assert.equal((await upd({ state: "open", signal: null })).result, "updated")
})

test("updateCard reports not_found, invalid_source, invalid_location and a bad clock", async () => {
  const where = await desk()
  assert.deepEqual(await updateCard({ ...where, key: ANDON, now: at(2), patch: { signal: null } }), { result: "not_found" })
  assert.deepEqual(await updateCard({ ...where, key: "andon:bad", now: at(2), patch: {} }), { result: "invalid_source" })
  assert.deepEqual(await updateCard({ deskRoot: "relative", personPrefix: "", key: ANDON, now: at(2), patch: {} }), { result: "invalid_location" })
  await assert.rejects(() => updateCard({ ...where, key: ANDON, now: NaN, patch: {} }), /now/)
})

test("a failed write leaves no temp file or lock behind and the old card intact", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") return t.skip("permission bits do not stop this user")
  const where = await desk()
  const first = await open(where)
  const before = await fs.readFile(first.file, "utf8")
  const meta = path.dirname(folderOf(where))
  await fs.chmod(folderOf(where), 0o500)
  try {
    await assert.rejects(() => updateCard({ ...where, key: ANDON, now: at(2), patch: { kaizen_url: ISSUE_URL } }), { code: "EACCES" })
  } finally {
    await fs.chmod(folderOf(where), 0o700)
  }
  assert.equal(await fs.readFile(first.file, "utf8"), before)
  assert.deepEqual((await fs.readdir(meta)).filter((name) => name.startsWith(".")), [])
})

test("a card file or folder the process cannot read is counted and left in place", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") return t.skip("permission bits do not stop this user")
  const where = await desk()
  const good = await open(where)
  const dir = folderOf(where)
  await fs.chmod(good.file, 0o000)
  try {
    assert.deepEqual((await readCards(where)).skipped, { unreadable: 1 })
  } finally {
    await fs.chmod(good.file, 0o600)
  }
  await fs.chmod(dir, 0o000)
  try {
    assert.equal((await readCards(where)).unreadable, true)
    assert.deepEqual(await claim(where), { result: "unreadable_folder" })
  } finally {
    await fs.chmod(dir, 0o700)
  }
  const readOnly = await desk()
  await fs.mkdir(path.join(readOnly.deskRoot, "_meta"), { recursive: true })
  await fs.chmod(path.join(readOnly.deskRoot, "_meta"), 0o500)
  try {
    await assert.rejects(() => claim(readOnly), { code: "EACCES" })
  } finally {
    await fs.chmod(path.join(readOnly.deskRoot, "_meta"), 0o700)
  }
  // a file that cannot be read is not known to be bad: it stays where it is, is counted, and does not block a claim
  await open(where, { key: "store_build:ourostack/factory#1" })
  await fs.chmod(good.file, 0o000)
  try {
    const next = await claim(where, { now: at(3) })
    assert.equal(next.result, "claimed")
    assert.equal(next.card.key, "store_build:ourostack/factory#1")
    assert.equal(next.set_aside, undefined)
    const after = await readCards(where)
    assert.equal(after.unreadable_files, 1)
    assert.equal(after.set_aside_total, 0)
    assert.equal((await fs.lstat(good.file)).isFile(), true)
  } finally {
    await fs.chmod(good.file, 0o600)
  }
})

test("a meta folder that is a file is refused", async () => {
  const asFile = await desk()
  await fs.writeFile(path.join(asFile.deskRoot, "_meta"), "a file")
  assert.equal((await readCards(asFile)).unreadable, true)
  assert.deepEqual(await claim(asFile), { result: "unreadable_folder" })
})

test("reading checks shape only: a well-formed card the tables do not know is a valid card and is never moved aside", async () => {
  const where = await desk()
  await open(where, { key: "flush_health:frozen", evidence: [] })
  await open(where, { key: "loop_alarm:headless_blocked", evidence: [] })
  await open(where, { key: ANDON, evidence: ["reconcile:pr_open@2"] })
  const reworded = fileOf(where, "flush_health:frozen")
  await fs.writeFile(reworded, (await fs.readFile(reworded, "utf8")).replace("Factory delivery is frozen", "Factory delivery stopped"))
  await plant(where, "loop_alarm:headless_blocked", "loop_alarm:future_alarm")
  const futureReason = await plant(where, "loop_alarm:headless_blocked", "reconcile_class:future_reason")
  await fs.writeFile(futureReason, (await fs.readFile(futureReason, "utf8")).replace('source: "loop_alarm"', 'source: "reconcile_class"'))
  const future = fileOf(where, ANDON)
  const text = await fs.readFile(future, "utf8")
  await fs.writeFile(future, text.replace('"reconcile:pr_open@2"', '"reconcile:future_reason@2"'))
  // a closed card with an unknown close reason, check result and measure from a newer Desk
  await open(where, { key: "desk_problem:ourostack/desk#4", evidence: [] })
  const held = await claim(where, { now: at(1, 13) })
  assert.equal(held.card.key, ANDON)
  await updateCard({ ...where, key: ANDON, claim_id: held.claim_id, now: at(1, 13), patch: { state: "closed_unverified", close_reason: "wont_fix" } })
  const closed = fileOf(where, ANDON)
  await fs.writeFile(closed, (await fs.readFile(closed, "utf8")).replace('"wont_fix"', '"newer_reason"').replace("last_check_result: null", 'last_check_result: "newer_result"').replace("signal: null", 'signal: "future.measure"'))
  const result = await readCards(where)
  assert.deepEqual(result.skipped, {})
  assert.equal(result.cards.length, 6)
  const card = result.cards.find((c) => c.key === ANDON)
  assert.deepEqual([card.close_reason, card.last_check_result, card.signal], ["newer_reason", "newer_result", "future.measure"])
  assert.equal(result.cards.find((c) => c.key === "flush_health:frozen").title, "Factory delivery stopped")
  // nothing is moved, and a claim goes to the oldest card as before
  const next = await claim(where, { now: at(3) })
  assert.equal(next.result, "claimed")
  assert.equal(next.set_aside, undefined)
  assert.equal((await readCards(where)).set_aside_total, 0)
  // an update of a card from a newer Desk works; what this version writes must be in its tables
  const upd = (key, patch, extra = {}) => updateCard({ ...where, key, now: at(3), patch, ...extra })
  assert.equal((await upd("reconcile_class:future_reason", { kaizen_url: ISSUE_URL })).result, "updated")
  assert.deepEqual(await upd(ANDON, { close_reason: "another_new_reason" }), { result: "invalid_patch", field: "close_reason" })
  assert.deepEqual(await upd(ANDON, { last_check_result: "newer_result" }), { result: "invalid_patch", field: "last_check_result" })
  assert.deepEqual(await upd(ANDON, { signal: "future.measure" }), { result: "invalid_patch", field: "signal" })
  assert.deepEqual(await upd(ANDON, { evidence: ["reconcile:future_reason@2"] }), { result: "invalid_patch", field: "evidence" })
  assert.equal((await upd(ANDON, { kaizen_url: ISSUE_URL })).result, "updated")
  assert.equal((await open(where, { key: "reconcile_class:future_reason", evidence: [] })).result, "invalid_source")
  assert.equal((await open(where, { key: "flush_health:future_code", evidence: [] })).result, "invalid_source")
  assert.equal((await open(where, { key: "loop_alarm:future_alarm", evidence: [] })).result, "invalid_source")
  assert.equal((await open(where, { key: "desk_problem:other/repo#4", evidence: [] })).result, "invalid_source")
  // a card from a newer Desk that is not well formed is still moved aside
  await fs.writeFile(fileOf(where, "flush_health:frozen"), (await fs.readFile(fileOf(where, "flush_health:frozen"), "utf8")).replace('close_reason: null', 'close_reason: "Not A Code"'))
  assert.equal((await claim(where, { now: at(4) })).set_aside, 1)
})

test("an invalid entry that is not a folder is refused as unreadable_folder and nothing is moved", async () => {
  const where = await desk()
  const first = await open(where)
  await fs.writeFile(first.file, "garbage")
  await fs.writeFile(path.join(folderOf(where), SET_ASIDE_FOLDER), "a file")
  assert.equal((await readCards(where)).unreadable, true)
  assert.deepEqual(await claim(where), { result: "unreadable_folder" })
  assert.deepEqual(await open(where), { result: "unreadable_folder" })
  assert.equal(await fs.readFile(first.file, "utf8"), "garbage")
  await fs.rm(path.join(folderOf(where), SET_ASIDE_FOLDER))
  await fs.mkdir(path.join(folderOf(where), SET_ASIDE_FOLDER))
  await fs.chmod(path.join(folderOf(where), SET_ASIDE_FOLDER), 0o000).catch(() => {})
  const listed = await readCards(where)
  await fs.chmod(path.join(folderOf(where), SET_ASIDE_FOLDER), 0o700)
  assert.equal(listed.unreadable, process.getuid?.() === 0 ? false : true)
})

test("a claim_id never reaches a card that is no longer claimed by that claim", async () => {
  const where = await desk()
  await open(where)
  const got = await claim(where)
  await updateCard({ ...where, key: ANDON, claim_id: got.claim_id, now: at(2), patch: { state: "shipped", countermeasure: PR_URL } })
  const before = await fs.readFile(cardFile(where.deskRoot, "", ANDON), "utf8")
  assert.deepEqual(await updateCard({ ...where, key: ANDON, claim_id: got.claim_id, now: at(2), patch: { state: "closed_unverified", close_reason: "wont_fix" } }), { result: "not_your_claim" })
  assert.equal(await fs.readFile(cardFile(where.deskRoot, "", ANDON), "utf8"), before)
  // a system patch without a claim_id still works on the shipped card
  assert.equal((await updateCard({ ...where, key: ANDON, now: at(2), patch: { state: "closed_unverified", close_reason: "wont_fix" } })).result, "updated")
})

test("an open card closes unverified as source_recovered by a system patch, and a claimed one needs its own claim id", async () => {
  assert.ok(CLOSE_REASONS.includes("source_recovered"))
  const where = await desk()
  await open(where)
  const closed = await updateCard({ ...where, key: ANDON, now: at(3), patch: { state: "closed_unverified", close_reason: "source_recovered" } })
  assert.equal(closed.result, "updated")
  assert.equal(closed.card.state, "closed_unverified")
  assert.equal(closed.card.close_reason, "source_recovered")
  assert.equal(closed.card.closed_at, iso(at(3)))
  await open(where, { now: at(4) })
  const held = await claim(where, { now: at(5) })
  assert.deepEqual(await updateCard({ ...where, key: ANDON, now: at(5, 13), patch: { state: "closed_unverified", close_reason: "source_recovered" } }), { result: "not_your_claim" })
  const done = await updateCard({ ...where, key: ANDON, claim_id: held.claim_id, now: at(5, 13), patch: { state: "closed_unverified", close_reason: "source_recovered" } })
  assert.equal(done.result, "updated")
  assert.equal(done.card.claim.expires_at, null)
})

test("a card records when it entered verification: stamped on the move to verifying with checks_run back at zero, cleared on a reopen", async () => {
  const where = await desk()
  await open(where)
  const held = await claim(where, { now: at(2, 1) })
  await updateCard({ ...where, key: ANDON, claim_id: held.claim_id, now: at(2, 2), patch: { state: "shipped", countermeasure: PR_URL } })
  for (const n of [1, 2, 3]) await updateCard({ ...where, key: ANDON, now: at(2 + n), patch: { checks_run: n, last_check_at: iso(at(2 + n)) } })
  assert.equal((await read(where))[0].verifying_since, null)
  const moved = await updateCard({ ...where, key: ANDON, now: at(9, 5), patch: { state: "verifying", shipped_version: "3.2.0" } })
  assert.equal(moved.card.verifying_since, iso(at(9, 5)))
  assert.equal(moved.card.checks_run, 0)
  const next = await updateCard({ ...where, key: ANDON, now: at(10), patch: { checks_run: 1 } })
  assert.equal(next.card.verifying_since, iso(at(9, 5)))
  const reopened = await updateCard({ ...where, key: ANDON, now: at(11), patch: { state: "open" } })
  assert.equal(reopened.card.verifying_since, null)
  assert.equal(reopened.card.reopened, 1)
})

test("verifying_since is null on a new or reopened card, a card file without it reads as null, and a badly shaped one is set aside", async () => {
  const where = await desk()
  await open(where)
  assert.equal((await read(where))[0].verifying_since, null)
  const file = fileOf(where, ANDON)
  const text = await fs.readFile(file, "utf8")
  await fs.writeFile(file, text.split("\n").filter((line) => !line.startsWith("verifying_since:")).join("\n"))
  assert.equal((await read(where))[0].verifying_since, null)
  await fs.writeFile(file, text.replace("verifying_since: null", 'verifying_since: "yesterday"'))
  const result = await readCards(where)
  assert.equal(result.cards.length, 0)
  assert.equal(result.skipped.invalid, 1)
})

test("checks_not_green is a check result a system patch may write", () => {
  assert.ok(CHECK_RESULTS.includes("checks_not_green"))
})
