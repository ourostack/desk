// The flush carries the capture record: due locally with no network, sent with the facts under capture/<intake_id>.json only when the store's
// capture.json says {"capture":1}, settled by the default branch, retracted once, and never allowed to quarantine facts. Every GitHub
// interaction goes through the in-memory model in `_fake_github.js`; every fixture is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { captureOnBranch, contributingStores, judge } from "../../../../../plugins/desk/mcp/src/factory/capture-flush.js"
import { CAPTURE_INVALID, EMPTY_RECORD, captureFor } from "../../../../../plugins/desk/mcp/src/factory/capture-publish.js"
import { coverageNow } from "../../../../../plugins/desk/mcp/src/factory/capture-sweep.js"
import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { gitBlobSha, readConsent, readStatus, setConsent, writeLocalFacts, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const ACCOUNT = "contributor"
const READY = '{"capture":1}\n'
const NOT_READY = '{"andon":{"plugins":[]}}\n'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.parse("2026-10-05T12:00:00.000Z")
const SENTINEL = "SENTINEL-sentinel-corp/private-desk-store"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

function localFacts(n) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  return value
}

const owner = STORE.toLowerCase()
const zero = { derived: 0, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 0 }
// A counted Claude host whose sessions belong to this store, plus an optional other store's rows.
function coverageAt(ranAt, { mine = { derived: 3, not_seen: 2 }, other = null } = {}) {
  const rows = { [owner]: { ...zero, ...mine }, ...(other === null ? {} : { [other.store]: { ...zero, ...other.row } }) }
  const keys = Object.keys(zero)
  const total = Object.fromEntries(keys.map((key) => [key, Object.values(rows).reduce((sum, row) => sum + row[key], 0)]))
  return { method: 1, ran_at: ranAt, hosts: { "claude-code": { state: "counted", on_disk: keys.reduce((sum, key) => sum + total[key], 0), ...total, unverified: false, frozen_by_reason: {}, by_owner: rows } } }
}
const iso = (ms) => new Date(ms).toISOString()

async function setup(env, { facts = 0, coverage = coverageAt(iso(T0 - HOUR)), status = {} } = {}) {
  await setConsent(env, { store: STORE, contribute: true, account: ACCOUNT })
  // With the receipt a sweep of this Desk writes on a positive route (`checked_route`).
  for (let n = 1; n <= facts; n += 1) {
    const written = await writeLocalFacts(env, STORE, localFacts(n))
    assert.equal(written.written, true)
    await writeStatus(env, { derivations: { [written.name]: { store: STORE, checked_route: STORE } } })
  }
  await writeStatus(env, { ...(coverage === null ? {} : { coverage }), ...status })
  return (await readConsent(env)).stores[STORE].intake_id
}

const run = (env, github, clock, extra = {}) => flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup, now: () => clock.t, ...extra })
const expected = (coverage, intakeId, over = {}) => captureFor(coverage, { store: STORE, intakeId, sentBefore: false, contributing: 1, ...over })
const apiCalls = (github, method, pattern) => github.calls.filter((call) => call.args[0] === "api" && call.args[call.args.indexOf("--method") + 1] === method && pattern.test(call.args.find((arg) => /^repos\//u.test(arg)) ?? ""))
const capture = async (env) => (await readStatus(env)).capture?.[STORE]

test("a changed record is sent in the same intake pull request as facts and under capture/<intake_id>.json", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 2 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  const result = await run(env, github, clock)
  assert.equal(result.result, "delivered_pr_open")
  const want = expected((await readStatus(env)).coverage, id)
  assert.equal(want.path, `capture/${id}.json`)
  const files = github.headFiles(STORE, `intake/${id}`)
  assert.equal(files.get(want.path), want.sha)
  assert.equal(github.blobs.get(want.sha), want.bytes)
  assert.equal([...files.keys()].filter((name) => name.startsWith("facts/")).length, 2)
  assert.equal(github.pulls[0].body, "3", "the file count includes the record")
  const saved = await capture(env)
  assert.deepEqual(Object.keys(saved).sort(), ["pr", "sent_at", "sent_bytes"])
  assert.equal(saved.pr, 101)
  assert.equal(saved.sent_at, iso(T0))
  // The default branch's capture.json is the only handshake read, and it names the default branch.
  const reads = apiCalls(github, "GET", /\/contents\/capture\.json/u)
  assert.equal(reads.length, 1)
  assert.match(reads[0].args.at(-1), /\?ref=main$/u)
}))

test("a record alone opens an intake pull request", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const github = fakeGitHub({ captureJson: READY })
  const result = await run(env, github, { t: T0 })
  assert.deepEqual(result, { result: "delivered_pr_open", pr: { number: 101, url: `https://github.com/${STORE}/pull/101` } })
  assert.equal(github.pulls[0].title, "Factory intake")
  assert.equal(github.pulls[0].body, "1")
  assert.deepEqual([...github.headFiles(STORE, `intake/${id}`).keys()], [`capture/${id}.json`])
}))

test("no network call is made when nothing is due", () => scratch(async ({ env }) => {
  // No coverage at all sends nothing and goes nowhere. (A store that holds the record and a record sent an hour ago are the next test.)
  await setup(env, { coverage: null })
  const github = fakeGitHub({ captureJson: READY })
  assert.deepEqual(await run(env, github, { t: T0 }), { result: "nothing_pending" })
  assert.equal(github.calls.length, 0)
}))

test("a record is not re-sent within 20 hours or when its bytes are unchanged", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
  github.mergeOpenPr()
  // The default branch holds the bytes: settled, bookkept as the blob, and no more calls follow.
  clock.t = T0 + HOUR
  assert.equal((await run(env, github, clock)).result, "nothing_pending")
  const want = expected((await readStatus(env)).coverage, id)
  assert.deepEqual(await capture(env), { blob: want.sha, sent_at: iso(T0) })
  const before = github.calls.length
  clock.t = T0 + 2 * DAY
  assert.equal((await run(env, github, clock)).result, "nothing_pending")
  assert.equal(github.calls.length, before, "unchanged bytes are never sent again, whatever the age")
  // A changed record 2 hours after the send waits; at 21 hours it goes, replacing the file.
  const next = coverageAt(iso(T0 + 2 * DAY), { mine: { derived: 4, not_seen: 2 } })
  await writeStatus(env, { coverage: next })
  await writeStatus(env, { capture: { [STORE]: { blob: want.sha, sent_at: iso(T0 + 2 * DAY - 2 * HOUR) } } })
  assert.equal((await run(env, github, clock)).result, "nothing_pending")
  assert.equal(github.calls.length, before, "a replacement waits for 20 hours")
  await writeStatus(env, { capture: { [STORE]: { blob: want.sha, sent_at: iso(T0 + 2 * DAY - 21 * HOUR) } } })
  assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
  assert.equal(github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`), expected(next, id).sha)
}))

test("a store without the capture flag gets no record and is asked again after a day", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 1 })
  const github = fakeGitHub({ factoryJson: NOT_READY })
  const clock = { t: T0 }
  const result = await run(env, github, clock)
  assert.equal(result.result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, `intake/${id}`).keys()].filter((name) => !name.startsWith("facts/")), [])
  assert.equal(github.pulls[0].body, "1")
  assert.deepEqual(await capture(env), { skipped: "store_not_ready", retry_after: iso(T0 + DAY) })
  // Within the day the record is not even considered: no handshake read.
  clock.t = T0 + 12 * HOUR
  await run(env, github, clock)
  assert.equal(apiCalls(github, "GET", /\/contents\/capture\.json/u).length, 1)
  // After the day it asks again, and a store that now has the flag gets the record.
  const ready = fakeGitHub({ captureJson: READY })
  clock.t = T0 + DAY + HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR)) })
  assert.equal((await run(env, ready, clock)).result, "delivered_pr_open")
  assert.ok(ready.headFiles(STORE, `intake/${id}`).has(`capture/${id}.json`))
  const saved = await capture(env)
  assert.equal(saved.skipped, undefined)
  assert.equal(saved.retry_after, undefined)
}))

test("a missing, unreadable or malformed capture.json is a store that is not ready", () => scratch(async ({ env }) => {
  const bad = [null, "", "not json", '{"capture":"1"}', '{"capture":2}', '{"capture":true}', '{"capture":1.5}', '{"capture":0}', '{}', "[]", "null", "1", '{"capture":1,"andon":{"plugins":[]}}', '{"capture":1,"x":null}']
  for (const captureJson of bad) {
    await setup(env)
    const github = fakeGitHub({ captureJson })
    await run(env, github, { t: T0 })
    assert.equal((await capture(env)).skipped, "store_not_ready", String(captureJson))
    assert.equal(github.pulls.length, 0)
    await writeStatus(env, { capture: {} })
  }
  // The flag lives only in capture.json: a factory.json that carries `capture: 1` does not enable sending.
  for (const factoryJson of ['{"andon":{"plugins":[]},"capture":1}\n', '{"capture":1}\n']) {
    await setup(env)
    const github = fakeGitHub({ factoryJson })
    await run(env, github, { t: T0 })
    assert.equal((await capture(env)).skipped, "store_not_ready", factoryJson)
    assert.equal(github.pulls.length, 0)
    assert.equal(apiCalls(github, "GET", /\/contents\/factory\.json/u).length, 0)
    await writeStatus(env, { capture: {} })
  }
  // An answer that is not a file (a server error) is treated the same way.
  const broken = fakeGitHub({ captureJson: READY, intercept: (call) => (call.args.at(-1).includes("/contents/capture.json") ? { code: 1, stdout: "{}", stderr: "gh: Server Error (HTTP 500)\n" } : undefined) })
  await run(env, broken, { t: T0 })
  assert.equal((await capture(env)).skipped, "store_not_ready")
  const odd = fakeGitHub({ captureJson: READY, intercept: (call) => (call.args.at(-1).includes("/contents/capture.json") ? { code: 0, stdout: JSON.stringify({ encoding: "utf-8", content: 5 }), stderr: "" } : undefined) })
  await writeStatus(env, { capture: {} })
  await run(env, odd, { t: T0 })
  assert.equal((await capture(env)).skipped, "store_not_ready")
}))

test("a refusal naming the record leaves facts unquarantined, sends them again without the record and backs off a week", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 2 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
  const path = `capture/${id}.json`
  github.rejectOpenPr("factory-rejected: capture_keys\n\nthe record names a key it must not")
  clock.t = T0 + 3 * HOUR
  const again = await run(env, github, clock)
  assert.equal(again.result, "intake_stale_retried")
  assert.equal(again.stale_retries, 1)
  const files = github.headFiles(STORE, `intake/${id}`)
  assert.equal(files.has(path), false, "the record is not in the retried batch")
  assert.equal([...files.keys()].filter((name) => name.startsWith("facts/")).length, 2, "both facts go again")
  assert.deepEqual(await capture(env), { sent_at: iso(T0), refused: "capture_keys", retry_after: iso(clock.t + 7 * DAY) })
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_unmatched, undefined, "the record's file is not an unmatched file")
  // No quarantine anywhere.
  const delivered = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js").then((m) => m.readDelivered(env, STORE))
  assert.equal(delivered.quarantined.size, 0)
  // Within the week it is not sent; after it, it is tried again.
  github.mergeOpenPr()
  clock.t = T0 + 5 * DAY
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR)) })
  await run(env, github, clock)
  assert.equal(github.mainFiles().has(path), false)
  clock.t = T0 + 3 * HOUR + 7 * DAY + HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR)) })
  assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
  assert.ok(github.headFiles(STORE, `intake/${id}`).has(path))
  assert.equal((await capture(env)).refused, undefined)
}))

test("a path refusal of the pull request that carried the record is a refusal of the record, and of no other pull request", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 1 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  assert.equal((await run(env, github, clock)).pr.number, 101)
  github.rejectOpenPr("factory-rejected: path")
  clock.t = T0 + HOUR
  const again = await run(env, github, clock)
  assert.equal(again.result, "intake_stale_retried")
  assert.equal((await capture(env)).refused, "path")
  // A path refusal of some other pull request is a data refusal, as before: its facts are quarantined.
  const other = await scratch(async ({ env: env2 }) => {
    await setup(env2, { facts: 1 })
    const g2 = fakeGitHub({ captureJson: READY })
    const c2 = { t: T0 }
    await run(env2, g2, c2)
    await writeStatus(env2, { capture: {} })
    g2.rejectOpenPr("factory-rejected: path")
    c2.t = T0 + HOUR
    await run(env2, g2, c2)
    return { saved: (await readStatus(env2)).capture?.[STORE], delivered: await import("../../../../../plugins/desk/mcp/src/factory/outbox.js").then((m) => m.readDelivered(env2, STORE)) }
  })
  assert.equal(other.saved?.refused, undefined)
  assert.equal(other.delivered.quarantined.size, 1)
  assert.ok(id)
}))

test("a data code beside a record code on the recorded pull request is a refusal of the record, not of the facts", () => scratch(async ({ env }) => {
  await setup(env, { facts: 1 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  github.rejectOpenPr("factory-rejected: capture_keys\nfactory-rejected: invalid_facts")
  clock.t = T0 + HOUR
  assert.equal((await run(env, github, clock)).result, "intake_stale_retried")
  assert.equal((await capture(env)).refused, "capture_keys")
  const delivered = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js").then((m) => m.readDelivered(env, STORE))
  assert.equal(delivered.quarantined.size, 0)
}))

test("a flush with a hostile status.capture key delivers facts as before and keeps the key (an older Desk's view of it)", () => scratch(async ({ env }) => {
  // The same facts flushed with no capture key and with an unknown, hostile one deliver identically, and the key is kept as it was.
  const keep = { blob: "f".repeat(40), sent_at: "2020-01-01T00:00:00.000Z", pr: 7, refused: "capture_keys", retry_after: "2999-01-01T00:00:00.000Z", skipped: "store_not_ready", invalid: CAPTURE_INVALID, future: { x: 1 } }
  await setup(env, { facts: 2, coverage: null, status: { capture: { [STORE]: keep } } })
  const github = fakeGitHub({ captureJson: READY })
  const result = await run(env, github, { t: T0 })
  assert.equal(result.result, "delivered_pr_open")
  assert.equal(github.pulls[0].body, "2")
  // Every other key is kept as it was; only the pending pull request number goes, because this push rebuilt the branch without a record.
  const { pr: _pr, ...rest } = keep
  assert.deepEqual((await readStatus(env)).capture[STORE], rest)
  // And the other direction: an older flush wrote last_flush only, so a status without `capture` is a status like any other.
  assert.equal((await readStatus(env)).last_flush[STORE].result, "delivered_pr_open")
}))

test("facts delivery is identical with and without coverage", () => scratch(async ({ env: envA }) => {
  const outcome = async (env, { coverage, captureJson }) => {
    await setup(env, { facts: 3, coverage })
    const github = fakeGitHub({ captureJson })
    const clock = { t: T0 }
    const result = await run(env, github, clock)
    const id = (await readConsent(env)).stores[STORE].intake_id
    const files = github.headFiles(STORE, `intake/${id}`)
    const facts = [...files].filter(([name]) => name.startsWith("facts/"))
    const status = (await readStatus(env)).last_flush[STORE]
    return { result, facts, status, body: github.pulls[0].body, labels: [...files.keys()].filter((name) => name.startsWith("labels/")), callsWithoutCapture: github.calls.filter((call) => !call.args.at(-1).includes("/contents/capture.json") && !/\/git\/trees\/|\/branches\//u.test(call.args.at(-1))).length }
  }
  const plain = await outcome(envA, { coverage: null, captureJson: READY })
  const withCoverage = await scratch((scratchB) => outcome(scratchB.env, { coverage: coverageAt(iso(T0 - HOUR)), captureJson: null }))
  const ready = await scratch((scratchC) => outcome(scratchC.env, { coverage: coverageAt(iso(T0 - HOUR)), captureJson: READY }))
  // Fact file names are keyed by the machine secret, so compare the sets of paths shapes and the delivery's own result.
  for (const other of [withCoverage, ready]) {
    assert.equal(other.result.result, plain.result.result)
    assert.equal(other.facts.length, plain.facts.length)
    assert.deepEqual(other.labels, plain.labels)
    assert.deepEqual(Object.keys(other.status).sort(), Object.keys(plain.status).sort())
    assert.equal(other.status.result, plain.status.result)
    assert.equal(other.callsWithoutCapture, plain.callsWithoutCapture)
  }
  assert.equal(plain.body, "3")
  assert.equal(withCoverage.body, "3")
  assert.equal(ready.body, "4")
}))

test("facts bytes are the same on the branch whether or not a record travels with them", () => scratch(async ({ env }) => {
  await setup(env, { facts: 2, coverage: null })
  const without = fakeGitHub({ captureJson: READY })
  await run(env, without, { t: T0 })
  const id = (await readConsent(env)).stores[STORE].intake_id
  const factsWithout = [...without.headFiles(STORE, `intake/${id}`)].sort()
  await scratch(async ({ env: env2 }) => {
    await setup(env2, { facts: 2, coverage: coverageAt(iso(T0 - HOUR)) })
    // The same machine secret and intake id are not shared across scratch homes, so compare each file's content shape instead of its name.
    const withRecord = fakeGitHub({ captureJson: READY })
    await run(env2, withRecord, { t: T0 })
    const id2 = (await readConsent(env2)).stores[STORE].intake_id
    const files = [...withRecord.headFiles(STORE, `intake/${id2}`)].filter(([name]) => name.startsWith("facts/"))
    assert.equal(files.length, factsWithout.length)
    for (const [, sha] of files) assert.match(withRecord.blobs.get(sha), /^\{"schema":"desk\.factory\.published\//u)
  })
}))

test("coverage older than three days is not published", () => scratch(async ({ env }) => {
  const stale = [
    ["older than three days", iso(T0 - 3 * DAY - 1000)],
    ["exactly three days", iso(T0 - 3 * DAY)],
    ["in the future", iso(T0 + HOUR)],
    ["unparsable", "yesterday-ish"],
    ["missing", undefined],
  ]
  for (const [label, ranAt] of stale) {
    const coverage = coverageAt(ranAt ?? iso(T0))
    if (ranAt === undefined) delete coverage.ran_at
    else coverage.ran_at = ranAt
    await setup(env, { coverage })
    await writeStatus(env, { capture: {} })
    const github = fakeGitHub({ captureJson: READY })
    assert.deepEqual(await run(env, github, { t: T0 }), { result: "nothing_pending" }, label)
    assert.equal(github.calls.length, 0, label)
  }
  // Fresh just inside the limit goes.
  await setup(env, { coverage: coverageAt(iso(T0 - 3 * DAY + 1000)) })
  const github = fakeGitHub({ captureJson: READY })
  assert.equal((await run(env, github, { t: T0 })).result, "delivered_pr_open")
}))

test("a failed coverage pass uses the kept coverage only while it is fresh, and no coverage at all sends and retracts nothing", async () => {
  await scratch(async ({ env }) => {
    await setup(env, { coverage: coverageAt(iso(T0 - HOUR)), status: { coverage_failed: "count_failed" } })
    const fresh = fakeGitHub({ captureJson: READY })
    assert.equal((await run(env, fresh, { t: T0 })).result, "delivered_pr_open")
  })
  await scratch(async ({ env }) => {
    await setup(env, { coverage: coverageAt(iso(T0 - 4 * DAY)), status: { coverage_failed: "count_failed" } })
    const aged = fakeGitHub({ captureJson: READY })
    assert.equal((await run(env, aged, { t: T0 })).result, "nothing_pending")
    assert.equal(aged.calls.length, 0)
  })
  // A first-ever failure leaves no coverage: a record sent before is not retracted.
  await scratch(async ({ env }) => {
    const sentBefore = { blob: "a".repeat(40), sent_at: iso(T0 - 5 * DAY) }
    await setup(env, { coverage: null, status: { coverage_failed: "state_unreadable", capture: { [STORE]: sentBefore } } })
    const none = fakeGitHub({ captureJson: READY })
    assert.equal((await run(env, none, { t: T0 })).result, "nothing_pending")
    assert.equal(none.calls.length, 0)
    assert.deepEqual(await capture(env), sentBefore)
  })
  // The same with an aged coverage kept and a record sent before: not retracted either, even though this store's scope is empty in it.
  await scratch(async ({ env }) => {
    const sentBefore = { blob: "a".repeat(40), sent_at: iso(T0 - 5 * DAY) }
    await setup(env, { coverage: coverageAt(iso(T0 - 4 * DAY), { mine: {}, other: { store: "acme/other", row: { derived: 5 } } }), status: { coverage_failed: "count_failed", capture: { [STORE]: sentBefore } } })
    const aged = fakeGitHub({ captureJson: READY })
    assert.equal((await run(env, aged, { t: T0 })).result, "nothing_pending")
    assert.equal(aged.calls.length, 0)
  })
})

test("an invalid capture records only the fixed code, sends nothing and tries again after a day", async () => {
  const bad = coverageAt(iso(T0 - HOUR))
  bad.hosts["claude-code"].on_disk += 1
  await scratch(async ({ env }) => {
    await setup(env, { facts: 1, coverage: bad })
    const github = fakeGitHub({ captureJson: READY })
    const result = await run(env, github, { t: T0 })
    assert.equal(result.result, "delivered_pr_open")
    assert.equal(github.pulls[0].body, "1", "only the fact travels")
    assert.deepEqual(await capture(env), { invalid: CAPTURE_INVALID, retry_after: iso(T0 + DAY) })
    assert.equal(apiCalls(github, "GET", /\/contents\/capture\.json/u).length, 0)
  })
  await scratch(async ({ env }) => {
    await setup(env, { coverage: bad })
    const github = fakeGitHub({ captureJson: READY })
    const clock = { t: T0 }
    assert.equal((await run(env, github, clock)).result, "nothing_pending")
    assert.equal(github.calls.length, 0, "an invalid record alone is not work")
    assert.deepEqual(await capture(env), { invalid: CAPTURE_INVALID, retry_after: iso(T0 + DAY) })
    // Within the day nothing is rewritten; once the coverage is valid again and the day has passed, the record goes and the code is dropped.
    clock.t = T0 + 2 * HOUR
    await run(env, github, clock)
    assert.deepEqual(await capture(env), { invalid: CAPTURE_INVALID, retry_after: iso(T0 + DAY) })
    await writeStatus(env, { coverage: coverageAt(iso(T0 + DAY)) })
    clock.t = T0 + DAY + 2 * HOUR
    assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
    assert.equal((await capture(env)).invalid, undefined)
  })
})

test("the empty record is sent once when the scope empties, then forgotten", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  github.mergeOpenPr()
  clock.t = T0 + HOUR
  await run(env, github, clock)
  const first = expected((await readStatus(env)).coverage, id)
  assert.equal((await capture(env)).blob, first.sha)
  // Every desk moves to another store: this store's scope is empty.
  const moved = coverageAt(iso(T0 + 2 * DAY), { mine: {}, other: { store: "acme/other", row: { derived: 5 } } })
  await writeStatus(env, { coverage: moved })
  clock.t = T0 + 2 * DAY + HOUR
  const gone = await run(env, github, clock)
  assert.equal(gone.result, "delivered_pr_open")
  assert.equal(github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`), gitBlobSha(Buffer.from(EMPTY_RECORD)))
  assert.equal(github.blobs.get(gitBlobSha(Buffer.from(EMPTY_RECORD))), EMPTY_RECORD)
  github.mergeOpenPr()
  clock.t = T0 + 2 * DAY + 2 * HOUR
  assert.equal((await run(env, github, clock)).result, "nothing_pending")
  assert.equal((await capture(env))?.blob, undefined, "forgotten once the empty record is on the default branch")
  // Once is once: later flushes send nothing, even a long time after.
  const before = github.calls.length
  clock.t = T0 + 9 * DAY
  await writeStatus(env, { coverage: coverageAt(iso(T0 + 9 * DAY - HOUR), { mine: {}, other: { store: "acme/other", row: { derived: 5 } } }) })
  assert.equal((await run(env, github, clock)).result, "nothing_pending")
  assert.equal(github.calls.length, before)
}))

test("an empty record is dropped when the store holds no record to retract", () => scratch(async ({ env }) => {
  const id = await setup(env, { coverage: coverageAt(iso(T0 - HOUR), { mine: {}, other: { store: "acme/other", row: { derived: 5 } } }), status: { capture: { [STORE]: { blob: "c".repeat(40), sent_at: iso(T0 - 2 * DAY) } } } })
  const github = fakeGitHub({ captureJson: READY })
  const result = await run(env, github, { t: T0 })
  assert.equal(result.result, "nothing_pending")
  assert.equal(github.pulls.length, 0)
  assert.equal((await capture(env))?.blob, undefined)
  assert.ok(id)
}))

test("unowned sessions are left out of the record while a second store contributes", () => scratch(async ({ env }) => {
  const id = await setup(env)
  await setConsent(env, { store: "acme/second", contribute: true, account: ACCOUNT })
  const unowned = coverageAt(iso(T0 - HOUR))
  unowned.hosts["claude-code"].by_owner["-"] = { ...zero, not_in_a_desk: 4 }
  unowned.hosts["claude-code"].not_in_a_desk += 4
  unowned.hosts["claude-code"].on_disk += 4
  await writeStatus(env, { coverage: unowned })
  const github = fakeGitHub({ captureJson: READY })
  await run(env, github, { t: T0 })
  const sent = JSON.parse(github.blobs.get(github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`)))
  assert.equal(sent.hosts["claude-code"].on_disk, 5, "the four unowned sessions are not in it")
  assert.equal(sent.hosts["claude-code"].not_in_a_desk, 0)
}))

test("the record stays in an open pull request's branch while it waits to merge, and a pull request for the record alone is not closed", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  clock.t = T0 + HOUR
  const again = await run(env, github, clock)
  assert.equal(again.result, "delivered_pr_open")
  assert.equal(github.pulls.filter((pr) => pr.state === "open").length, 1)
  assert.ok(github.headFiles(STORE, `intake/${id}`).has(`capture/${id}.json`))
  // A pull request closed without a merge or a comment: within 20 hours nothing is carried or sent; after 20 hours the record goes again.
  github.pulls[0].state = "closed"
  clock.t = T0 + 2 * HOUR
  assert.equal((await run(env, github, clock)).result, "nothing_pending")
  assert.equal(github.pulls.length, 1)
  clock.t = T0 + 21 * HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR)) })
  assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
  assert.equal(github.pulls.length, 2)
}))

test("the pull request body and the file count include the record", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 3 })
  const github = fakeGitHub({ captureJson: READY })
  await run(env, github, { t: T0 })
  assert.equal(github.pulls[0].body, "4")
  assert.equal(github.headFiles(STORE, `intake/${id}`).size, 4)
}))

test("a record already on the default branch with these exact bytes is settled and not sent again", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const want = expected((await readStatus(env)).coverage, id)
  const github = fakeGitHub({ captureJson: READY, mainCapture: { [`${id}.json`]: want.bytes } })
  const result = await run(env, github, { t: T0 })
  assert.equal(result.result, "nothing_pending")
  assert.equal(github.pulls.length, 0)
  assert.deepEqual(await capture(env), { blob: want.sha })
}))

test("a truncated listing cannot show that there is nothing to retract, so the empty record is sent and not forgotten", () => scratch(async ({ env }) => {
  const sent = { blob: "c".repeat(40), sent_at: iso(T0 - 2 * DAY) }
  const id = await setup(env, { coverage: coverageAt(iso(T0 - HOUR), { mine: {}, other: { store: "acme/other", row: { derived: 5 } } }), status: { capture: { [STORE]: sent } } })
  const github = fakeGitHub({ captureJson: READY })
  github.setTruncated(() => true)
  assert.equal((await run(env, github, { t: T0 })).result, "delivered_pr_open")
  assert.equal(github.blobs.get(github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`)), EMPTY_RECORD)
  assert.deepEqual(await capture(env), { ...sent, pr: 101, sent_at: iso(T0), sent_bytes: EMPTY_RECORD })
}))

test("nothing from the machine's wider coverage, the cache or another store reaches a request or the bookkeeping", () => scratch(async ({ env }) => {
  const coverage = coverageAt(iso(T0 - HOUR), { other: { store: SENTINEL.toLowerCase(), row: { derived: 40, held: 3 } } })
  const id = await setup(env, { facts: 1, coverage, status: { coverage_cache: { [`rollout-2026-10-05T01-02-03-${SENTINEL}.jsonl`]: { cwd: SENTINEL } } } })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  github.rejectOpenPr("factory-rejected: capture_keys")
  clock.t = T0 + HOUR
  await run(env, github, clock)
  const everything = JSON.stringify([github.calls.map((call) => [call.args, call.input]), [...github.blobs.values()], (await readStatus(env)).capture, (await readStatus(env)).last_flush])
  assert.doesNotMatch(everything, /sentinel/iu)
  assert.ok(id)
  // The bookkeeping holds only blob, sent_at, pr, refused, retry_after, skipped and invalid.
  for (const key of Object.keys((await capture(env)) ?? {})) assert.ok(["blob", "sent_at", "pr", "sent_bytes", "refused", "retry_after", "skipped", "invalid"].includes(key), key)
}))

test("a full batch leaves room for the record: at most maxFiles paths, every fact there or still pending", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 3 })
  const github = fakeGitHub({ captureJson: READY })
  const result = await run(env, github, { t: T0 }, { maxFiles: 3 })
  assert.equal(result.result, "delivered_pr_open")
  const files = github.headFiles(STORE, `intake/${id}`)
  assert.equal(files.size, 3)
  assert.equal(files.has(`capture/${id}.json`), true)
  assert.equal([...files.keys()].filter((name) => name.startsWith("facts/")).length, 2)
  assert.equal((await readStatus(env)).last_flush[STORE].intake_pushed, true)
  const delivered = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js").then((m) => m.readDelivered(env, STORE))
  assert.equal(delivered.quarantined.size, 0)
  // The third fact is not lost: once this pull request merges it goes in the next batch.
  github.mergeOpenPr()
  const next = await run(env, github, { t: T0 + HOUR }, { maxFiles: 3 })
  assert.equal(next.result, "delivered_pr_open")
  assert.equal([...github.mainFiles().keys()].filter((name) => name.startsWith("facts/")).length, 2)
  assert.equal([...github.headFiles(STORE, `intake/${id}`).keys()].filter((name) => name.startsWith("facts/")).length, 3)
}))

test("a data code on the pull request that carried the record is a refusal of the record, and a facts-only pull request refused the same way quarantines", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 2 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  github.rejectOpenPr("factory-rejected: unknown_key")
  clock.t = T0 + HOUR
  const again = await run(env, github, clock)
  assert.equal(again.result, "intake_stale_retried")
  assert.deepEqual(await capture(env), { sent_at: iso(T0), refused: "unknown_key", retry_after: iso(clock.t + 7 * DAY) })
  const outbox = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  assert.equal((await outbox.readDelivered(env, STORE)).quarantined.size, 0)
  const files = github.headFiles(STORE, `intake/${id}`)
  assert.equal(files.has(`capture/${id}.json`), false)
  assert.equal([...files.keys()].filter((name) => name.startsWith("facts/")).length, 2)
  // The facts-only pull request, refused with a facts code, quarantines as before.
  github.rejectOpenPr("factory-rejected: unknown_key")
  clock.t = T0 + 2 * HOUR
  await run(env, github, clock)
  assert.equal((await outbox.readDelivered(env, STORE)).quarantined.size, 2)
}))

test("a facts code on a pull request that is not the recorded one quarantines and never counts as a record refusal; the record's own file is not unmatched", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 1 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  await writeStatus(env, { capture: { [STORE]: { sent_at: iso(T0), pr: 999 } } })
  github.rejectOpenPr("factory-rejected: facts_invalid")
  clock.t = T0 + HOUR
  await run(env, github, clock)
  const outbox = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  assert.equal((await outbox.readDelivered(env, STORE)).quarantined.size, 1)
  assert.equal((await capture(env))?.refused, undefined)
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_unmatched, undefined, `the record file of ${id} is skipped, not counted`)
}))

test("an open pull request keeps carrying the bytes sent, and newer bytes wait for the 20 hours", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  const first = github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`)
  const sentAt = (await capture(env)).sent_at
  for (const hours of [1, 2, 3]) {
    clock.t = T0 + hours * HOUR
    await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR), { mine: { derived: 3 + hours, not_seen: 2 } }) })
    assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
    assert.equal(github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`), first)
    assert.equal((await capture(env)).sent_at, sentAt)
  }
  clock.t = T0 + 21 * HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR), { mine: { derived: 9, not_seen: 2 } }) })
  await run(env, github, clock)
  assert.notEqual(github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`), first)
  assert.equal((await capture(env)).sent_at, iso(clock.t))
}))

test("a recorded pull request that is no longer pushed-and-open is not carried", () => scratch(async ({ env }) => {
  await setup(env, { status: { capture: { [STORE]: { pr: 101, sent_at: iso(T0 - HOUR), sent_bytes: EMPTY_RECORD } } } })
  const github = fakeGitHub({ captureJson: READY })
  assert.equal((await run(env, github, { t: T0 })).result, "nothing_pending")
  assert.equal(github.calls.length, 0, "no intake_pushed in last_flush, so nothing is open to carry")
}))

test("a record still in an open pull request is retracted when the scope empties", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  clock.t = T0 + 21 * HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR), { mine: {}, other: { store: "acme/other", row: { derived: 5 } } }) })
  assert.equal((await run(env, github, clock)).result, "delivered_pr_open")
  assert.equal(github.blobs.get(github.headFiles(STORE, `intake/${id}`).get(`capture/${id}.json`)), EMPTY_RECORD)
}))

test("consent counts a store once however its name is spelled, and only when every spelling contributes", () => {
  const yes = { contribute: true }
  const no = { contribute: false }
  assert.equal(contributingStores({}), 0)
  assert.equal(contributingStores({ "a/b": yes, "c/d": no, "e/f": null }), 1)
  assert.equal(contributingStores({ "a/b": yes, "A/B": yes }), 1)
  assert.equal(contributingStores({ "a/b": yes, "A/B": no }), 0)
  assert.equal(contributingStores({ "a/b": no, "A/B": yes }), 0)
  assert.equal(contributingStores({ "a/b": yes, "c/d": yes }), 2)
})

test("the byte limit leaves room for the record too", () => scratch(async ({ env: probeEnv }) => {
  await setup(probeEnv, { facts: 2, coverage: null })
  const probe = fakeGitHub({ captureJson: READY })
  await run(probeEnv, probe, { t: T0 })
  const probeId = (await readConsent(probeEnv)).stores[STORE].intake_id
  const [[, sha]] = [...probe.headFiles(STORE, `intake/${probeId}`)]
  const factBytes = probe.blobs.get(sha).length
  await scratch(async ({ env }) => {
    const id = await setup(env, { facts: 2 })
    const recordBytes = expected((await readStatus(env)).coverage, id).bytes.length
    const github = fakeGitHub({ captureJson: READY })
    await run(env, github, { t: T0 }, { maxBytes: 2 * factBytes + recordBytes - 1 })
    const files = github.headFiles(STORE, `intake/${id}`)
    assert.equal([...files.keys()].filter((name) => name.startsWith("facts/")).length, 1, "one fact leaves room for the record")
    assert.equal(files.has(`capture/${id}.json`), true)
  })
}))

test("a stale code on the recorded pull request does not back off the record", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 1 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  github.rejectOpenPr("factory-rejected: merge_conflict")
  clock.t = T0 + HOUR
  const again = await run(env, github, clock)
  assert.equal(again.result, "intake_stale_retried")
  const saved = await capture(env)
  assert.equal(saved.refused, undefined)
  assert.equal(saved.retry_after, undefined)
  assert.ok(id)
}))

test("the store's own check failing to read the commits is no refusal: no week's wait, no quarantine, the record goes again", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 2 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  github.rejectOpenPr("factory-rejected: capture_check_unavailable")
  clock.t = T0 + HOUR
  const again = await run(env, github, clock)
  assert.equal(again.result, "intake_stale_retried")
  const saved = await capture(env)
  assert.equal(saved.refused, undefined)
  assert.equal(saved.retry_after, undefined)
  const delivered = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js").then((m) => m.readDelivered(env, STORE))
  assert.equal(delivered.quarantined.size, 0)
  // The record goes again once its 20 hours are up, not after a week.
  github.mergeOpenPr()
  clock.t = T0 + 21 * HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR)) })
  await run(env, github, clock)
  assert.ok(github.headFiles(STORE, `intake/${id}`).has(`capture/${id}.json`) || github.mainFiles().has(`capture/${id}.json`))
}))

test("a store whose own check keeps failing is counted, never blamed on the record, and the count clears once a record lands", () => scratch(async ({ env }) => {
  const id = await setup(env, { facts: 1 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  const fail = async () => {
    github.rejectOpenPr("factory-rejected: capture_check_unavailable")
    clock.t += 21 * HOUR
    await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR)) })
    assert.equal((await run(env, github, clock)).result, "intake_stale_retried")
  }
  await fail()
  assert.equal((await capture(env)).check_unavailable, 1)
  assert.equal((await capture(env)).refused, undefined)
  await fail()
  await fail()
  const saved = await capture(env)
  assert.equal(saved.check_unavailable, 3)
  const { captureCheckLines } = await import("../../../../../plugins/desk/mcp/src/factory/retention.js")
  assert.equal(captureCheckLines(await readStatus(env)).length, 1)
  // The record lands: merged and seen on the default branch, the count is cleared with the other delivery signals.
  github.mergeOpenPr()
  clock.t += 21 * HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR)) })
  await run(env, github, clock)
  assert.equal((await capture(env))?.check_unavailable, undefined)
  assert.ok(github.mainFiles().has(`capture/${id}.json`))
}))

test("a record whose pull request was closed unmerged is not retracted when the scope empties", () => scratch(async ({ env }) => {
  const id = await setup(env)
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  github.pulls[0].state = "closed"
  clock.t = T0 + 21 * HOUR
  await writeStatus(env, { coverage: coverageAt(iso(clock.t - HOUR), { mine: {}, other: { store: "acme/other", row: { derived: 5 } } }) })
  assert.equal((await run(env, github, clock)).result, "nothing_pending")
  assert.equal(github.pulls.length, 1)
  assert.equal((await capture(env))?.pr, undefined)
  assert.ok(id)
}))

test("a push that leaves the record out clears the pending pull request, so a facts refusal of it is not the record's", () => scratch(async ({ env }) => {
  await setup(env, { facts: 1 })
  const github = fakeGitHub({ captureJson: READY })
  const clock = { t: T0 }
  await run(env, github, clock)
  assert.equal((await capture(env)).pr, 101)
  // The coverage goes stale: the open pull request is rebuilt without the record.
  clock.t = T0 + 4 * DAY
  await run(env, github, clock)
  const saved = await capture(env)
  assert.equal(saved?.pr, undefined)
  assert.equal(saved?.sent_bytes, undefined)
  github.rejectOpenPr("factory-rejected: unknown_key")
  clock.t = T0 + 4 * DAY + HOUR
  await run(env, github, clock)
  const outbox = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  assert.equal((await outbox.readDelivered(env, STORE)).quarantined.size, 1)
  assert.equal((await capture(env))?.refused, undefined)
}))

test("judge needs no options, and a capture folder keeps only blobs with a record's file name", async () => {
  assert.equal(judge({ sha: "a", empty: true }, undefined), "forget")
  assert.equal(judge({ sha: "a", empty: true }, "b"), "send")
  assert.equal(judge({ sha: "a", empty: false }, "a"), "settled")
  const good = "capture/0123456789abcdef.json"
  const tree = new Map([["capture", { type: "tree", sha: "t1" }]])
  const folder = new Map([
    ["0123456789abcdef.json", { type: "blob", sha: "b1" }],
    ["notes.txt", { type: "blob", sha: "b2" }],
    ["0123456789abcdee.json", { type: "tree", sha: "t2" }],
  ])
  const read = async (sha) => (sha === "t1" ? folder : tree)
  assert.deepEqual([...(await captureOnBranch(read, "root"))], [[good, "b1"]])
  assert.equal((await captureOnBranch(async () => new Map(), "root")).size, 0)
})

test("coverageNow answers a fixed code, never throws, when it is given no options", () => scratch(async (ctx) => {
  const result = await coverageNow(ctx.env)
  assert.equal(typeof result.ok, "boolean")
}))
