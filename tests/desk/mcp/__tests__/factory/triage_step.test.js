// The triage step: the mechanical refresh, the one bounded agent run and the step's acceptance against the live basis. Real Git (a
// temporary bare remote and a clone), real cards, the real shared launch ledger, the real candidate validator, protected state,
// safe transform and Git writer. Only the runner's custody is replaced, by a fake that reads the real prepared input.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"

import { cardFile, openImprovement, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { factoryStateRoot, readStatus, setConsent, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { prepareTriageCatalog, readTriagePreparedFile } from "../../../../../plugins/desk/mcp/src/factory/triage-catalog.js"
import { readTriageBasis } from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"
import { refreshTriage, triagePaths } from "../../../../../plugins/desk/mcp/src/factory/triage-state.js"
import { QUALIFICATION_SEGMENTS, TRIAGE_BATCH_LIMIT, TRIAGE_RUN_MS, runTriageCommand, runTriageStep, writeTriagePreparedInput } from "../../../../../plugins/desk/mcp/src/factory/triage-step.js"
import { KEYS, NEEDS_PREPARED_RUN, SENTINELS, STORE, fakeRunner, git, pushDesk, qualifiedSeams, remoteBlobs, remoteJson, row, triageWorld } from "./_triage_world.js"

const T0 = Date.parse("2026-10-12T01:00:00.000Z")
const HOUR = 3600 * 1000
const at = (hours) => new Date(T0 + hours * HOUR)
const later = () => new Date(Date.now() + 20 * 60 * 1000)

const step = (w, { now = at(0), seams = qualifiedSeams(), deadline = later(), generation = "gen-1", personPrefix = "" } = {}) =>
  runTriageStep(w.env, { deskRoot: w.deskRoot, personPrefix, pluginVersion: "9.9.9", now, deadline, generation, impls: seams })

const annotation = (w, key) => remoteJson(w.origin, triagePaths(w.deskRoot, "", key).annotation)

async function editCard(w, key, fields) {
  const file = cardFile(w.deskRoot, "", key)
  let text = await fs.readFile(file, "utf8")
  for (const [name, value] of Object.entries(fields)) text = text.replace(new RegExp(`^${name}: .*$`, "m"), () => `${name}: ${JSON.stringify(value)}`)
  await fs.writeFile(file, text)
}
const claim = (expires) => ({ state: "claimed", claim: { claim_id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60", claimed_at: at(-1).toISOString(), expires_at: expires.toISOString(), machine: "ab".repeat(8), session: null }, claim_log: [{ at: at(-1).toISOString(), machine: "ab".repeat(8) }] })

test("valid_private_result_never_enters_git_review", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0) })
  const runner = fakeRunner(({ brief }) => brief.cards.map((card) => row(card, "human_decision")))
  const result = await step(w, { seams: qualifiedSeams({ runner }) })
  assert.equal(result.result, "ran", JSON.stringify(result))
  assert.equal(result.ok, true)
  assert.equal(result.launched, true)
  assert.deepEqual([result.reviewed, result.refused, result.deferred, result.unreviewed], [3, 0, 0, 0])
  assert.equal(runner.calls.length, 1)
  // Git holds only the closed safe codes: every blob of the remote's whole history is free of the private text.
  const blobs = remoteBlobs(w.origin).join("\n")
  for (const sentinel of SENTINELS) assert.ok(!blobs.includes(sentinel), `${sentinel} reached Git`)
  for (const key of KEYS) {
    const saved = annotation(w, key)
    assert.equal(saved.attempt.state, "reviewed")
    assert.deepEqual(Object.keys(saved.review).sort(), ["authority_code", "duplicate_keys", "evidence", "gate", "producer_version", "protected_result", "related_keys", "route", "rubric_version", "summary_codes"])
    assert.equal(saved.review.route, "human_decision")
    assert.equal(saved.review.gate, "irreversible")
    assert.deepEqual(saved.review.evidence, [{ kind: "issue", ref: `https://github.com/example-org/example-repo/issues/${key.split("#")[1]}`, revision: 3 }])
    // The full row is kept only in owner-protected state, under the review's opaque token.
    const root = await factoryStateRoot(w.env)
    const runs = await fs.readdir(path.join(root, "triage", "results"))
    const file = path.join(root, "triage", "results", runs[0], `${saved.review.protected_result}.json`)
    const kept = JSON.parse(await fs.readFile(file, "utf8"))
    assert.equal(kept.key, key)
    assert.match(kept.result.decision, /PRIVATE-DECISION-SENTINEL/)
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  }
  const status = await readStatus(w.env)
  assert.equal(status.triage.result, "ran")
  assert.deepEqual(status.triage.counts, { reviewed: 3, refused: 0, deferred: 0, unreviewed: 0 })
  assert.ok(Date.parse(status.triage.last_success_at) >= at(0).getTime())
  assert.deepEqual(Object.keys(status.triage.last_review).sort(), ["at", "authority_code", "gate", "key", "producer_version", "revision", "route", "rubric_version", "summary_codes"])
  assert.ok(!JSON.stringify(status).includes("PRIVATE"), "the status holds codes only")
  assert.equal(status.loop.steps.triage.last_result, "ran")
  assert.equal(status.loop.agent_launch_highwater.last_triage_at !== null, true, "the launch was reserved in the shared ledger")
})

test("partial_results_preserve_last_success", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS })
  assert.equal((await step(w)).reviewed, 3)
  const before = Object.fromEntries(KEYS.map((key) => [key, annotation(w, key)]))
  // Three reviewed cards change; a fourth card is new and never reviewed.
  for (const key of KEYS) await editCard(w, key, { evidence: [`issue:${key.slice(6)}`, "issue:example-org/example-repo#900"] })
  const fresh = "andon:example-org/example-repo#104"
  await openImprovement({ deskRoot: w.deskRoot, personPrefix: "", key: fresh, source: "andon", evidence: ["issue:example-org/example-repo#104"], plugin: "desk", signal: null, now: at(1) })
  pushDesk(w)
  const [a, b, c] = KEYS
  const runner = fakeRunner(({ brief }) => {
    const card = (key) => brief.cards.find((item) => item.key === key)
    return [
      // An unsupported route for its authority, a duplicate without shared evidence, and no row at all for b.
      row(card(a), "agent_ready", { authority: { code: "investigation_only", ruling_ids: [] } }),
      row(card(c), "investigate", { duplicates: [{ key: fresh, evidence_ids: card(c).evidence_ids.slice(0, 1) }] }),
      row(card(fresh), "investigate"),
    ]
  })
  const result = await step(w, { now: at(7), seams: qualifiedSeams({ runner }) })
  assert.equal(result.result, "ran", JSON.stringify(result))
  assert.deepEqual([result.reviewed, result.refused], [1, 3])
  assert.equal(annotation(w, fresh).attempt.state, "reviewed", "the valid sibling is accepted")
  for (const key of [a, b, c]) {
    const saved = annotation(w, key)
    assert.equal(saved.attempt.state, "stale", key)
    assert.deepEqual(saved.review, before[key].review, "the last valid review is kept as context")
    assert.ok(saved.revision > before[key].revision)
  }
  // The rejected cards rotate: the next run tries them again, by last attempt, and the reviewed one is not selected.
  const attempts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(w.env), "triage", "attempts.json"), "utf8")).attempts
  assert.deepEqual(Object.fromEntries(Object.entries(attempts).map(([key, value]) => [key, value.state])), { [a]: "refused", [b]: "refused", [c]: "refused", [fresh]: "reviewed" })
  const third = fakeRunner()
  assert.equal((await step(w, { now: at(14), seams: qualifiedSeams({ runner: third }) })).reviewed, 3)
  assert.deepEqual(third.calls.length, 1)
  const status = await readStatus(w.env)
  assert.deepEqual(status.triage.counts, { reviewed: 3, refused: 0, deferred: 0, unreviewed: 0 })
})

test("claim_or_ruling_changes_after_submission_not_accepted", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2) })
  const [a, b] = KEYS
  // A claim taken on one card while the child runs rejects only that card.
  const claimed = fakeRunner(async ({ brief }) => {
    await editCard(w, a, claim(at(2)))
    return brief.cards.map((card) => row(card))
  })
  const first = await step(w, { seams: qualifiedSeams({ runner: claimed }) })
  assert.deepEqual([first.result, first.reviewed, first.refused], ["ran", 1, 1])
  assert.equal(annotation(w, a), null, "the changed card gets no annotation")
  assert.equal(annotation(w, b).attempt.state, "reviewed")
  git(w.deskRoot, ["checkout", "--", "."])
  // A ruling that changes after submission rejects every card that relied on it.
  const ruled = fakeRunner(async ({ brief }) => {
    await fs.writeFile(path.join(w.deskRoot, "AGENTS.md"), "Agents may not fix anything without asking.\n")
    return brief.cards.map((card) => row(card))
  })
  const second = await step(w, { now: at(7), seams: qualifiedSeams({ runner: ruled }) })
  assert.deepEqual([second.result, second.reviewed, second.refused], ["ran", 0, 1], JSON.stringify(second))
  assert.equal(annotation(w, a), null)
})

test("mechanical_pass_invalidates_without_agent", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS })
  const [a, b, c] = KEYS
  await editCard(w, b, claim(at(9)))
  pushDesk(w)
  assert.equal((await step(w)).reviewed, 3)
  const revision = (key) => annotation(w, key).revision
  const start = Object.fromEntries(KEYS.map((key) => [key, revision(key)]))
  const noAgent = qualifiedSeams({ hostSupport: async () => ({ provenance: false }), runTriageChild: async () => assert.fail("no agent runs") })

  // Unchanged card bytes, revoked authority: the ruling changed.
  await fs.writeFile(path.join(w.deskRoot, "AGENTS.md"), "Agents may only investigate.\n")
  pushDesk(w)
  const revoked = await step(w, { now: at(1), seams: noAgent })
  assert.equal(revoked.launched, false)
  for (const key of KEYS) {
    assert.equal(annotation(w, key).attempt.state, "stale")
    assert.equal(annotation(w, key).attempt.reason, "authority_changed")
    assert.ok(revision(key) > start[key])
  }
  // Review again, then let b's unchanged claim expire.
  assert.equal((await step(w, { now: at(7) })).reviewed, 3, "b's claim is still live at review time")
  const expired = await step(w, { now: at(9.5), seams: noAgent })
  assert.equal(expired.launched, false)
  assert.equal(annotation(w, a).attempt.state, "reviewed")
  assert.deepEqual([annotation(w, b).attempt.state, annotation(w, b).attempt.reason], ["stale", "claim_changed"])

  // A card removed on a complete read is withdrawn; one missing from a truncated read is only unknown, nothing written.
  await fs.rm(cardFile(w.deskRoot, "", c))
  pushDesk(w)
  const truncated = async (options) => ({ ...(await readCards(options)), truncated: true })
  const before = revision(c)
  const unknown = await step(w, { now: at(10), seams: { ...noAgent, readCards: truncated } })
  assert.equal(unknown.result, "refresh_incomplete")
  assert.equal(revision(c), before, "an incomplete read never withdraws")
  const withdrawn = await step(w, { now: at(10), seams: noAgent })
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn))
  assert.equal(annotation(w, c).attempt.state, "withdrawn")
  assert.equal(annotation(w, c).review, null)
  assert.ok(revision(c) > before)
})

test("prepared_writer_round_trips_through_the_runner_reader_and_splits_long_rulings", { skip: NEEDS_PREPARED_RUN }, async () => {
  const long = `${"Rule line with words and a tab\tand a quote \" here.\n".repeat(900)}`
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1), agents: long })
  let seen
  const runner = fakeRunner(async (prepared) => {
    seen = prepared
    return prepared.brief.cards.map((card) => row(card, "agent_ready"))
  })
  const result = await step(w, { seams: qualifiedSeams({ runner }) })
  assert.equal(result.reviewed, 1, JSON.stringify(result))
  const card = seen.brief.cards[0]
  assert.ok(card.ruling_ids.length > 1, "a long ruling is split into parts, never truncated")
  const rulingText = seen.records.filter((record) => record.kind === "ruling").map((record) => record.text).join("")
  assert.equal(rulingText, long)
  const catalog = prepareTriageCatalog({ brief: seen.brief, records: seen.records, recordRefs: seen.recordRefs, generation: "ab".repeat(32) })
  assert.match(catalog.snapshotSha256, /^[0-9a-f]{64}$/u)
  assert.equal(annotation(w, KEYS[0]).review.authority_code, "existing_scope")
  // The exported writer writes exactly the file the runner reads.
  const dir = path.join(await factoryStateRoot(w.env), "prepared-check")
  await fs.mkdir(dir, { mode: 0o700 })
  const written = await writeTriagePreparedInput({ inputDir: await fs.realpath(dir), brief: seen.brief, records: seen.records, recordRefs: seen.recordRefs })
  const read = await readTriagePreparedFile({ inputDir: await fs.realpath(dir) })
  assert.equal(read.sha256, written.sha256)
  assert.deepEqual(read.brief, seen.brief)
})

test("the agent waits: cooldown, no time, unavailable host, missing or broken qualification, nothing to review", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  const untouched = qualifiedSeams({ runTriageChild: async () => assert.fail("no run") })
  // No time for a whole run before the deadline: nothing is reserved.
  const short = await step(w, { seams: untouched, deadline: new Date(Date.now() + TRIAGE_RUN_MS - 1000) })
  assert.deepEqual([short.result, short.ok, short.launched], ["no_time_for_a_run", false, false])
  assert.equal((await readStatus(w.env)).loop.agent_launch_highwater, undefined)
  // An unsupported host and a host with no qualification installed are quiet; an installed record that does not restore is not.
  const linux = await step(w, { seams: { ...untouched, hostSupport: async () => ({ provenance: false }) } })
  assert.deepEqual([linux.result, linux.ok], ["runner_unavailable", true])
  assert.equal((await readStatus(w.env)).triage.runner.state, "unsupported_host")
  const thrown = await step(w, { seams: { ...untouched, hostSupport: async () => { throw new Error("no custody") } } })
  assert.equal(thrown.result, "runner_unavailable")
  const { loadQualification: _drop, ...defaults } = untouched
  const missing = await step(w, { seams: defaults })
  assert.deepEqual([missing.result, missing.ok], ["runner_unavailable", true])
  assert.equal((await readStatus(w.env)).triage.runner.qualification, "missing")
  const file = path.join(await factoryStateRoot(w.env), ...QUALIFICATION_SEGMENTS)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, "{}\n", { mode: 0o600 })
  const broken = await step(w, { seams: defaults })
  assert.deepEqual([broken.result, broken.ok], ["runner_blocked", false])
  assert.equal((await readStatus(w.env)).triage.runner.qualification, "invalid")
  const odd = await step(w, { seams: { ...untouched, loadQualification: async () => ({ state: "invalid" }) } })
  assert.equal(odd.result, "runner_blocked")
  assert.equal((await readStatus(w.env)).triage.runner.reason, "diagnostic_inadequate")
  // The default runner refuses a record it did not restore itself.
  const { runTriageChild: _runner, ...realRunner } = qualifiedSeams()
  const unrestored = await step(w, { seams: realRunner })
  assert.deepEqual([unrestored.result, unrestored.launched], ["scope_unqualified", true])
  // That attempt used the window: the next generation is not due.
  const cooling = await step(w, { now: at(1), seams: untouched })
  assert.deepEqual([cooling.result, cooling.ok], ["not_due", true])
  assert.equal((await readStatus(w.env)).triage.ledger, "window_used")
  // Reviewed and current: nothing to review.
  assert.equal((await step(w, { now: at(7) })).reviewed, 1)
  const idle = await step(w, { now: at(14), seams: untouched })
  assert.deepEqual([idle.result, idle.ok, idle.reviewed], ["nothing_to_review", true, 0])
})

test("ledger, preparation and runner failures are stated, never success", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2), agents: "A ruling with a NUL \u0000 byte.\n" })
  const held = await step(w)
  assert.deepEqual([held.result, held.ok, held.launched], ["preparation_held", false, false])
  await fs.writeFile(path.join(w.deskRoot, "AGENTS.md"), "Agents may fix factory defects.\n")
  pushDesk(w)
  // A reservation the ledger refuses outright is a problem; one that is only the quota is quiet.
  const blocked = await step(w, { seams: qualifiedSeams({ reserveAgentLaunch: async () => ({ state: "witness_invalid" }) }) })
  assert.deepEqual([blocked.result, blocked.ok, blocked.launched], ["ledger_blocked", false, false])
  const quota = await step(w, { seams: qualifiedSeams({ reserveAgentLaunch: async () => ({ state: "quota_exhausted" }) }) })
  assert.deepEqual([quota.result, quota.ok], ["quota_exhausted", true])
  // A run that times out spends its launch and reviews nothing; every selected card counts as refused.
  const timeout = await step(w, { seams: qualifiedSeams({ runner: fakeRunner(() => ({ state: "timeout" })) }) })
  assert.deepEqual([timeout.result, timeout.ok, timeout.launched, timeout.reviewed, timeout.refused], ["timeout", false, true, 0, 2])
  const status = await readStatus(w.env)
  assert.equal(status.loop.steps.triage.failures_in_a_row, 1)
  // A damaged witness blocks before anything is prepared.
  await updateStatus(w.env, (current) => ({ ...current, loop: { ...current.loop, agent_launch_highwater: { schema: "nope" } } }))
  const damaged = await step(w, { now: at(7) })
  assert.deepEqual([damaged.result, damaged.ok], ["ledger_blocked", false])
})

test("a run whose writes are not acknowledged, a throwing runner and a deadline reached during acceptance", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2) })
  const unacked = await step(w, { seams: qualifiedSeams({ publishOwnedTriage: async () => ({ state: "unacknowledged", resources: [] }) }) })
  assert.deepEqual([unacked.result, unacked.ok, unacked.reviewed, unacked.refused], ["write_incomplete", false, 0, 2])
  const stale = await step(w, { now: at(7), seams: qualifiedSeams({ publishOwnedTriage: async () => ({ state: "stale_basis", resources: [] }) }) })
  assert.deepEqual([stale.result, stale.ok, stale.refused], ["ran", true, 2])
  const thrown = await step(w, { now: at(14), seams: qualifiedSeams({ runTriageChild: async () => { throw new Error("boom") } }) })
  assert.deepEqual([thrown.result, thrown.launched], ["failed", true])
  // The deadline arrives while rows are being accepted: the rest are deferred, not dropped or refused.
  let now = Date.now()
  const runner = fakeRunner(({ brief }) => {
    now += 30 * 60 * 1000
    return brief.cards.map((card) => row(card))
  })
  const late = await step(w, { now: at(21), deadline: new Date(now + 16 * 60 * 1000), seams: qualifiedSeams({ runner, clock: () => now }) })
  assert.deepEqual([late.result, late.reviewed, late.deferred], ["ran", 0, 2])
  const attempts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(w.env), "triage", "attempts.json"), "utf8")).attempts
  assert.deepEqual(Object.values(attempts).map((value) => value.state), ["deferred", "deferred"])
  // A candidate file that cannot be read is no candidate.
  const vanished = fakeRunner(() => ({ state: "ran", resultFile: path.join(w.base, "nowhere.json") }))
  const gone = await step(w, { now: at(28), seams: qualifiedSeams({ runner: vanished }) })
  assert.deepEqual([gone.result, gone.reviewed, gone.refused], ["ran", 0, 2])
})

test("the step's own guards: headless, no store, a failed or incomplete refresh, an unreadable status, the batch limit and a bad call", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  assert.equal((await runTriageStep({ ...w.env, DESK_FACTORY_HEADLESS: "1" }, { deskRoot: w.deskRoot, now: at(0), deadline: later() })).result, "headless_session")
  await assert.rejects(() => runTriageStep(w.env, { deskRoot: "relative", now: at(0), deadline: later() }), /deskRoot/u)
  await assert.rejects(() => runTriageStep(w.env, { deskRoot: w.deskRoot, now: "never", deadline: later() }), /valid times/u)
  await assert.rejects(() => runTriageStep(w.env, { deskRoot: w.deskRoot, personPrefix: "../x", now: at(0), deadline: later() }))
  const refreshFailed = await step(w, { seams: qualifiedSeams({ refreshTriage: async () => { throw new Error("x") } }) })
  assert.deepEqual([refreshFailed.result, refreshFailed.ok], ["refresh_failed", false])
  const selectFailed = await step(w, { seams: qualifiedSeams({ readCards: async () => { throw new Error("x") }, refreshTriage: async () => ({ state: "complete", changes: [], coverage: { scan: "complete", reviewed: 0, unreviewed: 1 } }) }) })
  assert.equal(selectFailed.result, "refresh_failed")
  // A change the refresh cannot write (the card cannot be read now) is held and said.
  const heldRefresh = async () => ({ state: "complete", changes: [{ key: KEYS[0], operation: "invalidate", reason: "basis_changed" }, { key: KEYS[0], operation: "withdraw", reason: "card_removed" }], coverage: { scan: "complete", reviewed: 1, unreviewed: 0 } })
  const incomplete = await step(w, { seams: qualifiedSeams({ refreshTriage: heldRefresh, readTriageBasis: async () => { throw new Error("x") }, hostSupport: async () => ({ provenance: false }) }) })
  assert.deepEqual([incomplete.result, incomplete.ok], ["refresh_incomplete", false])
  const alarmed = await step(w, { seams: qualifiedSeams({ refreshTriage: heldRefresh, publishOwnedTriage: async () => ({ state: "busy", alarm: "triage_resource_unrecoverable", resources: [] }), hostSupport: async () => ({ provenance: false }) }) })
  assert.equal(alarmed.result, "refresh_incomplete")
  assert.equal((await readStatus(w.env)).triage.refresh.alarm, "triage_resource_unrecoverable")
  // A refresh that runs into the deadline defers what is left.
  const past = await step(w, { deadline: new Date(Date.now() - 1000), seams: qualifiedSeams({ refreshTriage: heldRefresh, hostSupport: async () => ({ provenance: false }) }) })
  assert.equal(past.result, "refresh_incomplete")
  assert.equal((await readStatus(w.env)).triage.refresh.deferred, 2)
  const statusFailed = await step(w, { seams: qualifiedSeams({ newestRequestAt: async () => null }) , now: at(0) })
  assert.equal(statusFailed.ok, true)
  // No consenting store: nothing to keep identities for.
  const noStore = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  await fs.rm(path.join(await factoryStateRoot(noStore.env), "consent.json"))
  assert.deepEqual([(await step(noStore)).result, (await step(noStore)).ok], ["no_consenting_store", true])
  // More than twenty cards: twenty are prepared, the rest deferred.
  const many = await triageWorld({ now: at(0), keys: Array.from({ length: TRIAGE_BATCH_LIMIT + 2 }, (_, index) => `andon:example-org/example-repo#${200 + index}`) })
  const big = await step(many)
  assert.deepEqual([big.reviewed, big.deferred, big.unreviewed], [TRIAGE_BATCH_LIMIT, 2, 2])
})

test("an evaluation the slot deferred gets one continuation; none without a waiting evaluation", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  await updateStatus(w.env, (status) => ({ ...status, evaluator: { ...status.evaluator, ready_now: 2, ready_later: 0 } }))
  const first = await step(w, { generation: "gen-a" })
  assert.equal(first.continuation.state, "issued")
  assert.deepEqual((await readStatus(w.env)).loop.evaluation_continuation, first.continuation.token)
  const other = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  await updateStatus(other.env, (status) => ({ ...status, loop: { ...(status.loop ?? {}), steps: { evaluate: { last_ran_at: at(0).toISOString(), last_ok_at: at(0).toISOString(), last_result: "ran", runs: 1, failures: 0, failures_in_a_row: 0 } } } }))
  const none = await step(other, { generation: "gen-b" })
  assert.equal(none.continuation, undefined, "an evaluation inside its gap was not deferred by triage")
  const refused = await step(w, { now: at(7), generation: "gen-c", seams: qualifiedSeams({ createEvaluationContinuation: async () => ({ state: "not_runnable" }) }) })
  assert.equal(refused.continuation, undefined)
})

test("runTriageCommand takes only --desk and --person-prefix, runs under the loop lock and kicks once for a new continuation", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  for (const argv of [[], ["--desk"], ["--desk", "relative"], ["--desk", w.deskRoot, "--store", STORE], ["--desk", w.deskRoot, "--desk", w.deskRoot], ["--desk", w.deskRoot, "--person-prefix", "../x"], "nope"]) {
    await assert.rejects(() => runTriageCommand({ argv, env: w.env, pluginVersion: "9.9.9" }), /Usage: factory\.js triage/u)
  }
  await updateStatus(w.env, (status) => ({ ...status, evaluator: { ...status.evaluator, ready_now: 1, ready_later: 0 } }))
  const kicks = []
  const kick = async (env, options) => { kicks.push(options); return { kicked: true } }
  const done = await runTriageCommand({ argv: ["--desk", w.deskRoot, "--person-prefix", ""], env: w.env, pluginVersion: "9.9.9", impls: qualifiedSeams(), kick })
  assert.deepEqual(done, { result: "ran", ok: true, failed: 0, reviewed: 1, refused: 0, deferred: 0, unreviewed: 0 })
  assert.deepEqual(kicks, [{ continuation: true }])
  const again = await runTriageCommand({ argv: ["--desk", w.deskRoot], env: w.env, pluginVersion: "9.9.9", impls: qualifiedSeams(), kick })
  assert.equal(again.result, "not_due")
  assert.equal(kicks.length, 1, "no continuation, no kick")
  const lock = path.join(await factoryStateRoot(w.env), "locks", "loop-worker.running")
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: "t", started_at: new Date().toISOString() }))
  assert.equal((await runTriageCommand({ argv: ["--desk", w.deskRoot], env: w.env, pluginVersion: "9.9.9" })).result, "busy")
  await fs.rm(lock)
  assert.deepEqual(await runTriageCommand({ argv: ["--desk", w.deskRoot], env: { ...w.env, DESK_FACTORY_HEADLESS: "1" }, pluginVersion: "9.9.9" }), { result: "headless_session", ok: false, failed: 1, reviewed: null, refused: null, deferred: null, unreviewed: null })
  const bare = { ...w.env, XDG_STATE_HOME: path.join(w.base, "empty-state") }
  assert.equal((await runTriageCommand({ argv: ["--desk", w.deskRoot], env: bare, pluginVersion: "9.9.9" })).result, "no_factory_state")
  assert.ok(readFileSync(path.join(w.deskRoot, "README.md"), "utf8").length > 0)
})

test("defaults and edges: an empty ruling, unreadable rulings, an unsafe review, a deadline lost after the reservation, a candidate that is no file, and damaged attempts", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2), agents: "" })
  const [a, b] = KEYS
  const never = async () => assert.fail("no run")
  await assert.rejects(() => runTriageStep(w.env), /deskRoot/u)
  await assert.rejects(() => runTriageStep(w.env, { deskRoot: w.deskRoot }), /valid times/u)
  await assert.rejects(() => runTriageCommand(), /Usage: factory\.js triage/u)

  // A ruling the basis names that cannot be read as it was read (an unsafe path, a missing file, a folder) leaves its card for a later run.
  const rulings = (id, only = null) => async (options) => {
    const read = await readTriageBasis(options)
    return only !== null && options.key !== only ? read : { ...read, basis: { ...read.basis, rulings: [{ id, revision: "0".repeat(40) }] } }
  }
  for (const id of ["../outside.md", "missing.md", "_meta"]) {
    const held = await step(w, { seams: qualifiedSeams({ readTriageBasis: rulings(id), runTriageChild: never }) })
    assert.deepEqual([held.result, held.ok, held.launched], ["preparation_held", false, false], id)
  }
  const blind = await step(w, { seams: qualifiedSeams({ readStatus: async () => { throw new Error("x") }, runTriageChild: never }) })
  assert.deepEqual([blind.result, blind.ok], ["status_unavailable", false])
  // The installed record is asked of the runner's own loader: only `qualified` loads.
  const file = path.join(await factoryStateRoot(w.env), ...QUALIFICATION_SEGMENTS)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, "{}\n", { mode: 0o600 })
  const { loadQualification: _injected, ...viaLoader } = qualifiedSeams({ runTriageChild: never })
  const asked = []
  const held = await step(w, { seams: { ...viaLoader, loadTriageQualification: async (options) => { asked.push(options); return { state: "scope_unqualified" } } } })
  assert.deepEqual([held.result, (await readStatus(w.env)).triage.runner.reason], ["runner_blocked", "diagnostic_inadequate"])
  assert.deepEqual(asked, [{ recordFile: file, env: w.env }])
  await step(w, { seams: { ...viaLoader, loadTriageQualification: async () => ({ state: "scope_unqualified", reason: "record_stale" }) } })
  assert.equal((await readStatus(w.env)).triage.runner.reason, "record_stale")

  // A review the safe transform refuses is not written, whatever the candidate said.
  let prepared
  const unsafe = await step(w, { seams: qualifiedSeams({ toSafeTriageReview: () => ({ state: "refused" }), runner: fakeRunner((input) => { prepared = input; return input.brief.cards.map((card) => row(card)) }) }) })
  assert.deepEqual([unsafe.result, unsafe.reviewed, unsafe.refused], ["ran", 0, 2])
  assert.equal(annotation(w, a), null)
  assert.deepEqual(prepared.records.filter((record) => record.kind === "ruling").map((record) => record.text), ["(empty)"], "an empty ruling is still a record")

  // The deadline passes between the reservation and the spawn: the launch is spent, no child starts, and it is said.
  let now = Date.now()
  const reserve = async (env, options) => {
    const { reserveAgentLaunch } = await import("../../../../../plugins/desk/mcp/src/factory/headless-ledger.js")
    const reserved = await reserveAgentLaunch(env, options)
    now += 20 * 60 * 1000
    return reserved
  }
  const lost = await step(w, { now: at(7), generation: null, deadline: new Date(now + TRIAGE_RUN_MS + 60 * 1000), seams: qualifiedSeams({ clock: () => now, reserveAgentLaunch: reserve, runTriageChild: never }) })
  assert.deepEqual([lost.result, lost.ok, lost.launched, lost.reviewed], ["no_time_for_a_run", false, true, 0])
  assert.equal((await readStatus(w.env)).triage.runner.state, "no_time_for_a_run")

  // A candidate that is not a regular file is no candidate.
  const folder = await step(w, { now: at(14), seams: qualifiedSeams({ runner: fakeRunner(() => ({ state: "ran", resultFile: w.base })) }) })
  assert.deepEqual([folder.result, folder.reviewed, folder.refused], ["ran", 0, 2])

  // One card's ruling cannot be read: the other is reviewed. The runner names no file, so the one the step asked for is read; a refresh
  // that was incomplete is still said after a run.
  const quiet = fakeRunner()
  const partial = await step(w, { now: at(21), seams: {
    ...viaLoader, loadTriageQualification: async () => ({ state: "qualified" }), readTriageBasis: rulings("missing.md", a),
    refreshTriage: async (options) => ({ ...(await refreshTriage(options)), state: "truncated" }),
    runTriageChild: async (options) => { await quiet(options); return { state: "ran" } },
  } })
  assert.deepEqual([partial.result, partial.ok, partial.reviewed, partial.deferred], ["refresh_incomplete", false, 1, 1], JSON.stringify(partial))
  assert.equal(annotation(w, b).attempt.state, "reviewed")
  assert.equal(annotation(w, a), null)

  // The host check is the custody module's own unless a test replaces it: only macOS can run the runner.
  const { hostSupport: _host, ...ownHost } = qualifiedSeams()
  const native = await step(w, { now: at(28), seams: ownHost })
  assert.deepEqual([native.result, native.reviewed], process.platform === "darwin" ? ["ran", 1] : ["runner_unavailable", null])
  if (process.platform !== "darwin") assert.equal((await readStatus(w.env)).triage.runner.state, "unsupported_host")

  // A damaged attempts record loses only the queue's order: reviews the refresh finds current are still current.
  const attemptsFile = path.join(await factoryStateRoot(w.env), "triage", "attempts.json")
  await fs.writeFile(attemptsFile, JSON.stringify({ schema: "nope", attempts: { [b]: {} } }))
  const after = await step(w, { now: at(35) })
  assert.deepEqual([after.result, after.reviewed], process.platform === "darwin" ? ["nothing_to_review", 0] : ["ran", 1])
  // An attempt for a card that is gone is dropped at the next run.
  await fs.writeFile(attemptsFile, JSON.stringify({ schema: "desk.factory.triage-attempts/1", attempts: { "andon:example-org/example-repo#999": { at: at(1).toISOString(), state: "refused", fingerprint: "x", review_fingerprint: null } } }))
  await editCard(w, a, { evidence: ["issue:example-org/example-repo#101", "issue:example-org/example-repo#900"] })
  pushDesk(w)
  const rerun = await step(w, { now: at(42) })
  assert.deepEqual([rerun.result, rerun.reviewed], ["ran", 1], JSON.stringify(rerun))
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(attemptsFile, "utf8")).attempts), [a], "only cards that still exist keep an attempt")
})

test("cards whose evidence the loop cannot resolve by itself are held and counted, never reviewed on a guess", async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2) })
  const { evidence: _resolver, ...selfDescribing } = qualifiedSeams({ runTriageChild: async () => assert.fail("no run") })
  const result = await step(w, { seams: selfDescribing })
  assert.deepEqual([result.result, result.ok, result.launched, result.reviewed, result.unreviewed], ["nothing_to_review", true, false, 0, 2])
  const status = await readStatus(w.env)
  assert.deepEqual([status.triage.held, status.triage.eligible], [2, 0])
})

test("a second machine on the same desk: reviews it cannot recheck are not a fault, raise nothing, and are reviewed again where a run can start", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2) })
  assert.equal((await step(w)).reviewed, 2)
  const before = Object.fromEntries(KEYS.slice(0, 2).map((key) => [key, annotation(w, key)]))
  // Another machine: its own clone and its own factory state, which holds none of the first machine's protected bases.
  const deskRoot = path.join(w.base, "desk-two")
  git(w.base, ["clone", "-q", w.origin, deskRoot])
  git(deskRoot, ["config", "user.email", "test@example.com"])
  git(deskRoot, ["config", "user.name", "Test"])
  const env = { ...w.env, XDG_STATE_HOME: path.join(w.base, "state-two") }
  await setConsent(env, { store: STORE, contribute: true, account: "someone" })
  await updateStatus(env, (status) => ({ ...status, evaluator: { headless: { day: at(0).toISOString().slice(0, 10), jobs: 0 } } }))
  const second = { ...w, deskRoot, env }
  // Where no run can start (any host but macOS), every pass is quiet and ok: no failure to count towards an alarm.
  for (const hour of [1, 2, 3, 4]) {
    const quiet = await step(second, { now: at(hour), seams: qualifiedSeams({ hostSupport: async () => ({ provenance: false }), runTriageChild: async () => assert.fail("no run") }) })
    assert.deepEqual([quiet.result, quiet.ok, quiet.launched], ["runner_unavailable", true, false])
  }
  const status = await readStatus(env)
  assert.deepEqual([status.triage.refresh.foreign, status.triage.refresh.held, status.triage.runner.state], [2, 0, "unsupported_host"])
  assert.deepEqual([status.loop.steps.triage.failures, status.loop.steps.triage.failures_in_a_row], [0, 0])
  for (const key of KEYS.slice(0, 2)) assert.deepEqual(annotation(w, key), before[key], "nothing was rewritten")
  // Where one can, the cards are reviewed again and the matching review is adopted, so this machine holds its own basis from then on.
  const again = await step(second, { now: at(5) })
  assert.deepEqual([again.result, again.ok, again.reviewed], ["ran", true, 2], JSON.stringify(again))
  const settled = await step(second, { now: at(12), seams: qualifiedSeams({ runTriageChild: async () => assert.fail("no run") }) })
  assert.deepEqual([settled.result, (await readStatus(env)).triage.refresh.foreign], ["nothing_to_review", 0])
})

test("off macOS the step degrades cleanly: the refresh still runs, nothing is prepared, reserved or launched, and no failure is counted", async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2) })
  const never = async () => assert.fail("nothing is prepared or launched")
  // The host answer the custody module gives off macOS, and that module's own answer on this platform when it is not macOS.
  const hosts = [async () => ({ provenance: false })]
  if (process.platform !== "darwin") hosts.push(undefined)
  for (const hostSupport of hosts) {
    const { hostSupport: _injected, ...rest } = qualifiedSeams({ runTriageChild: never, reserveAgentLaunch: never, loadQualification: never })
    const seams = hostSupport === undefined ? rest : { ...rest, hostSupport }
    for (const hour of [0, 1, 2, 3]) {
      const result = await step(w, { now: at(hour), seams })
      assert.deepEqual(result, { ok: true, result: "runner_unavailable", launched: false, reviewed: null, refused: null, deferred: null, unreviewed: 2 })
    }
  }
  const status = await readStatus(w.env)
  assert.deepEqual(status.triage.runner, { state: "unsupported_host", reason: null, qualification: "not_checked" }, "the reason is visible")
  assert.deepEqual([status.triage.refresh.changes, status.triage.refresh.held], [0, 0])
  assert.deepEqual([status.loop.steps.triage.failures, status.loop.steps.triage.failures_in_a_row, status.loop.steps.triage.last_result], [0, 0, "runner_unavailable"])
  assert.equal(status.loop.agent_launch_highwater, undefined, "no launch was reserved")
  assert.equal(annotation(w, KEYS[0]), null)
  assert.deepEqual(await fs.readdir(path.join(await factoryStateRoot(w.env), "triage")).catch(() => []), [], "no run folder was made")
  // The end of a turn never starts a worker for a runner this host cannot start.
  const { triageKickDue } = await import("../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js")
  assert.equal(triageKickDue(status, at(48)), false)
})
