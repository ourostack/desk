// Capture coverage that does not raise false alarms: a corrected record replaces a wrong one at once, a pass taken during a quarantine release is not
// recorded, and a host that cannot tell a non-desk session from a miss does not charge its unowned sessions to a store as misses. Every fixture is synthetic.
import assert from "node:assert/strict"
import { utimesSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import test from "node:test"
import { SHARE_JUMP, planCapture, saveSent, saveSettled, sharesOf } from "../../../../../plugins/desk/mcp/src/factory/capture-flush.js"
import { captureFor } from "../../../../../plugins/desk/mcp/src/factory/capture-publish.js"
import { HELD_MAJORITY, KEEP_LIMIT_MS, QUARANTINE_SETTLE_MS, recordCoverage } from "../../../../../plugins/desk/mcp/src/factory/capture-sweep.js"
import { BINDING_VERSION } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { factoryStateRoot, readStatus, setConsent, writeMarker, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { STORE, recent, scratch, session } from "./_session_helpers.js"

const HOUR = 60 * 60 * 1000
const T0 = Date.parse("2026-10-05T12:00:00.000Z")
const ID = "0123456789abcdef"
const owner = STORE.toLowerCase()
const zero = { derived: 0, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 0 }
const KEYS = Object.keys(zero)

function host(byOwner, { withDesk = true } = {}) {
  const total = Object.fromEntries(KEYS.map((key) => [key, Object.values(byOwner).reduce((sum, row) => sum + (row[key] ?? 0), 0)]))
  if (!withDesk) total.not_in_a_desk = null
  return { state: "counted", on_disk: KEYS.reduce((sum, key) => sum + (total[key] ?? 0), 0), ...total, unverified: false, frozen_by_reason: {}, by_owner: byOwner }
}
const row = (over) => ({ ...zero, ...over })
const claudeAt = (ranAt, mine) => ({ method: 1, ran_at: new Date(ranAt).toISOString(), hosts: { "claude-code": host({ [owner]: row(mine) }) } })
const record = (coverage) => captureFor(coverage, { store: STORE, intakeId: ID, sentBefore: false, contributing: 1 })
const consent = { [STORE]: { contribute: true } }
const plan = (coverage, cap, nowMs = T0) => planCapture({ status: { coverage, capture: cap === null ? {} : { [STORE]: cap } }, consent, store: STORE, intakeId: ID, nowMs, mayBeOpen: false })

// The two ends of the live case: 1 of 32 capturable, then 241 of 272.
const WRONG = { derived: 1, not_seen: 31 }
const RIGHT = { derived: 241, not_seen: 31 }
const wrongRecord = record(claudeAt(T0 - 2 * HOUR, WRONG))

test("a corrected record replaces a wrong one at once, inside the 20 hours", () => {
  const cap = { blob: wrongRecord.sha, sent_at: new Date(T0 - HOUR).toISOString(), sent_share: sharesOf(wrongRecord.bytes) }
  const got = plan(claudeAt(T0 - 60000, RIGHT), cap)
  assert.equal(got.due, true)
  assert.equal(got.work, true)
  assert.equal(JSON.parse(got.record.bytes).hosts["claude-code"].derived, 241)
})

test("a wrong record taken from the bytes an open pull request carries is replaced at once too", () => {
  const cap = { pr: 7, sent_bytes: wrongRecord.bytes, sent_at: new Date(T0 - HOUR).toISOString() }
  const got = planCapture({ status: { coverage: claudeAt(T0 - 60000, RIGHT), capture: { [STORE]: cap } }, consent, store: STORE, intakeId: ID, nowMs: T0, mayBeOpen: true })
  assert.equal(got.due, true)
  assert.equal(got.work, true)
})

test("a normal small change still waits for the interval", () => {
  const cap = { blob: wrongRecord.sha, sent_at: new Date(T0 - HOUR).toISOString(), sent_share: sharesOf(wrongRecord.bytes) }
  // 1 of 32 (0.031) to 5 of 32 (0.156): a move of 0.125, under SHARE_JUMP.
  const got = plan(claudeAt(T0 - 60000, { derived: 5, not_seen: 27 }), cap)
  assert.equal(got.due, false)
  assert.equal(got.work, false)
  assert.equal(got.record, null)
})

test("a move of exactly SHARE_JUMP is due, in either direction", () => {
  const before = record(claudeAt(T0, { derived: 20, not_seen: 80 }))
  const cap = { blob: before.sha, sent_at: new Date(T0 - HOUR).toISOString(), sent_share: sharesOf(before.bytes) }
  assert.equal(SHARE_JUMP, 0.15)
  assert.equal(plan(claudeAt(T0 - 1, { derived: 35, not_seen: 65 }), cap).due, true)
  assert.equal(plan(claudeAt(T0 - 1, { derived: 5, not_seen: 95 }), cap).due, true)
  assert.equal(plan(claudeAt(T0 - 1, { derived: 34, not_seen: 66 }), cap).due, false)
})

test("with no share to compare against, the interval stands", () => {
  const cap = { blob: wrongRecord.sha, sent_at: new Date(T0 - HOUR).toISOString() }
  assert.equal(plan(claudeAt(T0 - 60000, RIGHT), cap).due, false)
  assert.equal(plan(claudeAt(T0 - 60000, RIGHT), { ...cap, sent_share: "junk" }).due, false)
})

test("a host the last record did not name is not compared", () => {
  const cap = { blob: wrongRecord.sha, sent_at: new Date(T0 - HOUR).toISOString(), sent_share: { "copilot-cli": 0.9 } }
  assert.equal(plan(claudeAt(T0 - 60000, RIGHT), cap).due, false)
})

test("the share of the record last sent is kept through settling, and an empty record forgets it", () => scratch(async (ctx) => {
  const item = { bytes: Buffer.from(wrongRecord.bytes), sha: wrongRecord.sha, empty: false }
  await saveSent(ctx.env, STORE, item, 9, T0)
  assert.deepEqual((await readStatus(ctx.env)).capture[STORE].sent_share, sharesOf(wrongRecord.bytes))
  await saveSettled(ctx.env, STORE, item)
  const settled = (await readStatus(ctx.env)).capture[STORE]
  assert.equal(settled.sent_bytes, undefined)
  assert.deepEqual(settled.sent_share, sharesOf(wrongRecord.bytes))
  await saveSettled(ctx.env, STORE, { ...item, empty: true })
  assert.equal((await readStatus(ctx.env)).capture?.[STORE], undefined)
}))

test("sharesOf reads only counted hosts with something capturable", () => {
  const bytes = JSON.stringify({ hosts: { "claude-code": { derived: 1, frozen: 1, pending: 0, not_seen: 2 }, "codex-cli": { not_counted: true }, "copilot-cli": { derived: 0, frozen: 0, pending: 0, not_seen: 0 } } })
  assert.deepEqual(sharesOf(bytes), { "claude-code": 0.25 })
  assert.deepEqual(sharesOf("not json"), {})
})

// A host with no desk to tell: Copilot CLI and Codex.
const copilot = (unowned, mine = {}) => host({ [owner]: row(mine), "-": row(unowned) }, { withDesk: false })

test("unowned sessions of a host that cannot say 'not in a desk' are withheld, and the host keeps not_in_a_desk null so the store can tell", () => {
  for (const name of ["copilot-cli", "codex-cli"]) {
    const got = JSON.parse(record({ method: 1, ran_at: "2026-10-05T12:00:00Z", hosts: { [name]: copilot({ not_seen: 124, held: 1 }, { derived: 1 }) } }).bytes)
    // The unowned misses are out of every count; the unowned held session stays, as before. The record never turns them into a zero it presents as a measure:
    // `not_in_a_desk: null` is what tells the store this host cannot say, so the store reads its shares as unavailable (`host_does_not_say_desk`).
    assert.deepEqual(got.hosts[name], { on_disk: 2, derived: 1, held: 1, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: null, unverified: false })
    assert.equal(got.hosts[name].not_in_a_desk, null)
  }
  // A host that can say keeps a number there.
  const claude = JSON.parse(record({ method: 1, ran_at: "2026-10-05T12:00:00Z", hosts: { "claude-code": host({ [owner]: row({ derived: 1 }), "-": row({ not_in_a_desk: 3 }) }) } }).bytes)
  assert.equal(claude.hosts["claude-code"].not_in_a_desk, 3)
})

test("a host with only unowned misses is left out, never written as a zero", () => {
  const result = record({ method: 1, ran_at: "2026-10-05T12:00:00Z", hosts: { "copilot-cli": copilot({ not_seen: 124 }) } })
  assert.equal(result, null)
})

test("owned misses of such a host, and unowned misses of a host that can say, are unchanged", () => {
  const cov = { method: 1, ran_at: "2026-10-05T12:00:00Z", hosts: { "copilot-cli": copilot({ not_seen: 9 }, { derived: 2, not_seen: 3 }), "claude-code": host({ [owner]: row({ derived: 1 }), "-": row({ not_seen: 4 }) }) } }
  const got = JSON.parse(record(cov).bytes)
  assert.equal(got.hosts["copilot-cli"].not_seen, 3)
  assert.equal(got.hosts["copilot-cli"].on_disk, 5)
  assert.equal(got.hosts["claude-code"].not_seen, 4)
})

test("with two contributing stores the unowned sessions stay out as before", () => {
  const cov = { method: 1, ran_at: "2026-10-05T12:00:00Z", hosts: { "copilot-cli": copilot({ not_seen: 9 }, { derived: 2 }) } }
  const got = JSON.parse(captureFor(cov, { store: STORE, intakeId: ID, sentBefore: false, contributing: 2 }).bytes)
  assert.equal(got.hosts["copilot-cli"].on_disk, 2)
})

// Coverage recording during a quarantine release.
const NAME = (n) => `claude-code-${String(n).padStart(8, "0")}-8a1d-4c2e-9f3a-1b2c3d4e5f60.json`
const PREVIOUS = { method: 1, ran_at: "2026-10-01T00:00:00.000Z", hosts: {} }
const options = { bindingVersion: BINDING_VERSION }

async function quarantine(ctx, { names, ageMs }) {
  // `ageMs` may be negative: a folder dated in the future.
  const root = await factoryStateRoot(ctx.env)
  const slug = path.join(root, "quarantine", "ourostack__factory")
  await mkdir(slug, { recursive: true })
  for (const name of names) await writeFile(path.join(slug, name), "{}")
  const at = new Date(Date.now() - ageMs)
  utimesSync(slug, at, at)
  utimesSync(path.join(root, "quarantine"), at, at)
}
const putTranscript = async (ctx, n) => {
  const file = path.join(ctx.base, ".claude", "projects", "-Users-someone-work", NAME(n).replace("claude-code-", "").replace(".json", ".jsonl"))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{"type":"user"}\n')
}
const seed = async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeStatus(ctx.env, { coverage: PREVIOUS })
}

test("a pass taken while the quarantine folder changed within the settle time keeps the previous coverage", () => scratch(async (ctx) => {
  assert.equal(QUARANTINE_SETTLE_MS, 5 * 60 * 1000)
  await seed(ctx)
  await putTranscript(ctx, 1)
  await quarantine(ctx, { names: [NAME(1)], ageMs: 60 * 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "kept")
  assert.deepEqual((await readStatus(ctx.env)).coverage, PREVIOUS)
}))

test("a quarantine that was emptied a moment ago still counts as changing", () => scratch(async (ctx) => {
  await seed(ctx)
  await quarantine(ctx, { names: [], ageMs: 10 * 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "kept")
  assert.deepEqual((await readStatus(ctx.env)).coverage, PREVIOUS)
}))

test("a quarantine that held still past the settle time and holds most sessions keeps the previous coverage", () => scratch(async (ctx) => {
  assert.equal(HELD_MAJORITY, 0.5)
  await seed(ctx)
  const root = await factoryStateRoot(ctx.env)
  for (const n of [1, 2, 3, 4]) {
    await putTranscript(ctx, n)
    await mkdir(path.join(root, "outbox", "ourostack__factory"), { recursive: true })
    await writeFile(path.join(root, "outbox", "ourostack__factory", NAME(n)), "{}")
  }
  await quarantine(ctx, { names: [NAME(1), NAME(2), NAME(3)], ageMs: QUARANTINE_SETTLE_MS + 60 * 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "kept")
  assert.deepEqual((await readStatus(ctx.env)).coverage, PREVIOUS)
}))

test("a settled quarantine that holds a minority of sessions is recorded", () => scratch(async (ctx) => {
  await seed(ctx)
  const root = await factoryStateRoot(ctx.env)
  for (const n of [1, 2, 3, 4]) {
    await putTranscript(ctx, n)
    await mkdir(path.join(root, "outbox", "ourostack__factory"), { recursive: true })
    await writeFile(path.join(root, "outbox", "ourostack__factory", NAME(n)), "{}")
  }
  await quarantine(ctx, { names: [NAME(1)], ageMs: QUARANTINE_SETTLE_MS + 60 * 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "written")
  const { coverage } = await readStatus(ctx.env)
  assert.equal(coverage.hosts["claude-code"].held, 1)
}))

test("a settled quarantine that is empty is recorded", () => scratch(async (ctx) => {
  await seed(ctx)
  await quarantine(ctx, { names: [], ageMs: QUARANTINE_SETTLE_MS + 60 * 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "written")
  assert.notDeepEqual((await readStatus(ctx.env)).coverage, PREVIOUS)
}))

test("a machine with no quarantine folder records as before", () => scratch(async (ctx) => {
  await seed(ctx)
  assert.equal(await recordCoverage(ctx.env, options), "written")
}))

async function outboxCopies(ctx, ns) {
  const root = await factoryStateRoot(ctx.env)
  await mkdir(path.join(root, "outbox", "ourostack__factory"), { recursive: true })
  for (const n of ns) {
    await putTranscript(ctx, n)
    await writeFile(path.join(root, "outbox", "ourostack__factory", NAME(n)), "{}")
  }
}
const SETTLED = QUARANTINE_SETTLE_MS + 60 * 1000

test("sessions held for a reason other than quarantine do not make a quarantine majority", () => scratch(async (ctx) => {
  // A session whose marker names a store with no consent is held, and one old unrelated file sits in quarantine.
  await seed(ctx)
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: false })
  await writeMarker(ctx.env, { ...marker, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  await quarantine(ctx, { names: [NAME(9)], ageMs: 7 * 24 * 60 * 60 * 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "written")
  const claude = (await readStatus(ctx.env)).coverage.hosts["claude-code"]
  assert.equal(claude.held, 1)
  assert.equal(claude.held / claude.on_disk, 1, "the host is entirely held, and it is recorded as it is")
}))

test("exactly half of a host's sessions in quarantine is recorded, more than half is kept", () => scratch(async (ctx) => {
  await seed(ctx)
  await outboxCopies(ctx, [1, 2, 3, 4])
  await quarantine(ctx, { names: [NAME(1), NAME(2)], ageMs: SETTLED })
  assert.equal(await recordCoverage(ctx.env, options), "written")
  await quarantine(ctx, { names: [NAME(3)], ageMs: SETTLED })
  assert.equal(await recordCoverage(ctx.env, options), "kept")
}))

test("a quarantine folder dated in the future is settled, not kept", () => scratch(async (ctx) => {
  await seed(ctx)
  await quarantine(ctx, { names: [], ageMs: -3 * 24 * 60 * 60 * 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "written")
}))

test("the keep has a time limit: after an hour the pass is recorded anyway and the status says so, and it clears when the quarantine settles", () => scratch(async (ctx) => {
  assert.equal(KEEP_LIMIT_MS, 60 * 60 * 1000)
  await seed(ctx)
  await outboxCopies(ctx, [1, 2, 3, 4])
  await quarantine(ctx, { names: [NAME(1), NAME(2), NAME(3)], ageMs: SETTLED })
  const t0 = Date.now()
  assert.equal(await recordCoverage(ctx.env, { ...options, now: () => t0 }), "kept")
  const kept = (await readStatus(ctx.env)).coverage_kept
  assert.equal(kept.code, "quarantine_in_flux")
  assert.equal(kept.since, new Date(t0).toISOString())
  // Still in flux 59 minutes later: kept, and `since` does not move.
  assert.equal(await recordCoverage(ctx.env, { ...options, now: () => t0 + KEEP_LIMIT_MS - 60000 }), "kept")
  assert.equal((await readStatus(ctx.env)).coverage_kept.since, kept.since)
  assert.deepEqual((await readStatus(ctx.env)).coverage, PREVIOUS)
  // At the limit the pass is recorded as it is, held and all, and says why.
  assert.equal(await recordCoverage(ctx.env, { ...options, now: () => t0 + KEEP_LIMIT_MS }), "written")
  const status = await readStatus(ctx.env)
  assert.equal(status.coverage_kept.code, "quarantine_not_settling")
  assert.equal(status.coverage_kept.since, kept.since)
  assert.equal(status.coverage.hosts["claude-code"].held, 3)
  // Once nothing is in flux the note clears.
  await quarantine(ctx, { names: [], ageMs: SETTLED })
  for (const n of [1, 2, 3]) await rm(path.join(await factoryStateRoot(ctx.env), "quarantine", "ourostack__factory", NAME(n)))
  utimesSync(path.join(await factoryStateRoot(ctx.env), "quarantine", "ourostack__factory"), new Date(Date.now() - SETTLED), new Date(Date.now() - SETTLED))
  assert.equal(await recordCoverage(ctx.env, { ...options, now: () => t0 + 2 * KEEP_LIMIT_MS }), "written")
  assert.equal((await readStatus(ctx.env)).coverage_kept, undefined)
}))

test("a kept pass clears coverage_failed, stores the Codex cache and leaves the coverage", () => scratch(async (ctx) => {
  await seed(ctx)
  await writeStatus(ctx.env, { coverage_failed: "count_failed" })
  await quarantine(ctx, { names: [], ageMs: 1000 })
  assert.equal(await recordCoverage(ctx.env, options), "kept")
  const status = await readStatus(ctx.env)
  assert.equal(status.coverage_failed, undefined)
  assert.deepEqual(status.coverage_cache, {})
  assert.deepEqual(status.coverage, PREVIOUS)
}))
