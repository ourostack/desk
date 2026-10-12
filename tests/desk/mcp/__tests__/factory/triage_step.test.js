// The triage step: the mechanical refresh, the one bounded agent run and the step's acceptance against the live basis. Real Git (a
// temporary bare remote and a clone), real cards, the real shared launch ledger, the real candidate validator, protected state,
// safe transform and Git writer. Only the runner's custody is replaced, by a fake that reads the real prepared input.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"

import { MAX_CARD_FILES, cardFile, openImprovement, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { evaluateDue, newestRequestAt, triageKickDue } from "../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js"
import { createEvaluationContinuation, evaluationQuotaOpen, finishAgentLaunch, reserveAgentLaunch } from "../../../../../plugins/desk/mcp/src/factory/headless-ledger.js"
import { runMeasureStep } from "../../../../../plugins/desk/mcp/src/factory/loop-health.js"
import { staleSteps } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"
import { factoryStateRoot, readStatus, setConsent, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { prepareTriageCatalog, readTriagePreparedFile } from "../../../../../plugins/desk/mcp/src/factory/triage-catalog.js"
import { readTriageBasis } from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"
import { refreshTriage, triagePaths } from "../../../../../plugins/desk/mcp/src/factory/triage-state.js"
import { KEPT_UNACCEPTED_RUNS, QUALIFICATION_SEGMENTS, TRIAGE_ENGINE_CARD, TRIAGE_BATCH_LIMIT, TRIAGE_RUN_MS, runTriageCommand, runTriageStep, writeTriagePreparedInput } from "../../../../../plugins/desk/mcp/src/factory/triage-step.js"
import { FAKE_RUNTIME, KEYS, NEEDS_PREPARED_RUN, SENTINELS, STORE, fakeRunner, git, pushDesk, qualifiedSeams, remoteBlobs, remoteJson, row, triageWorld } from "./_triage_world.js"

const T0 = Date.parse("2026-10-12T01:00:00.000Z")
const HOUR = 3600 * 1000
const at = (hours) => new Date(T0 + hours * HOUR)
const later = () => new Date(Date.now() + 20 * 60 * 1000)

// Every step in this file runs under one more check: a continuation is minted only when an evaluation was waiting before the step began
// (the step's own guard, asked here independently of the ledger, which would refuse the token anyway).
async function step(w, { now = at(0), seams = qualifiedSeams(), deadline = later(), generation = "gen-1", personPrefix = "", lock = null } = {}) {
  const before = await readStatus(w.env)
  const waiting = evaluateDue(before, now, { newWorkAt: await newestRequestAt(w.env) }) && evaluationQuotaOpen(before, now)
  const mint = seams.createEvaluationContinuation ?? createEvaluationContinuation
  let minted = 0
  const counted = async (...args) => {
    minted += 1
    return mint(...args)
  }
  const result = await runTriageStep(w.env, { deskRoot: w.deskRoot, personPrefix, pluginVersion: "9.9.9", now, deadline, generation, lock, impls: { ...seams, createEvaluationContinuation: counted } })
  if (!waiting) assert.equal(minted, 0, "no continuation is minted with no evaluation waiting")
  return result
}
const runFolders = async (w) => (await fs.readdir(path.join(await factoryStateRoot(w.env), "triage", "runs")).catch(() => [])).sort()

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
  assert.deepEqual([second.result, second.ok, second.reviewed, second.refused], ["nothing_accepted", false, 0, 1], JSON.stringify(second))
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
  // Past the card bound the refresh is partial and says so; it is not a failure, and the card it did not reach is unknown, not held.
  assert.deepEqual([unknown.result, unknown.ok, unknown.unreviewed], ["not_due", true, null])
  const partial = (await readStatus(w.env)).triage.refresh
  assert.deepEqual([partial.scan, partial.unknown, partial.held, partial.written], ["truncated", 1, 0, 0])
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
  // No time for a whole run before the deadline: nothing is probed, prepared or reserved, and it is no failure.
  const short = await step(w, { seams: { ...untouched, probeSignIn: async () => assert.fail("no probe") }, deadline: new Date(Date.now() + TRIAGE_RUN_MS - 1000) })
  assert.deepEqual([short.result, short.ok, short.launched], ["no_time_for_a_run", true, false])
  assert.equal((await readStatus(w.env)).loop.agent_launch_highwater, undefined)
  assert.deepEqual(await runFolders(w), [])
  // An unsupported host, a host with no qualification installed and one whose record no longer restores are quiet; only a damaged record is not.
  const linux = await step(w, { seams: { ...untouched, hostSupport: async () => ({ provenance: false }) } })
  assert.deepEqual([linux.result, linux.ok], ["runner_unavailable", true])
  assert.equal((await readStatus(w.env)).triage.runner.state, "unsupported_host")
  const thrown = await step(w, { seams: { ...untouched, hostSupport: async () => { throw new Error("no custody") } } })
  assert.equal(thrown.result, "runner_unavailable")
  // The real runtime, its record reader, loader and install identity.
  const { restoreQualification: _drop, loadRunner: _fake, ...defaults } = untouched
  const missing = await step(w, { seams: defaults })
  assert.deepEqual([missing.result, missing.ok], ["runner_unavailable", true])
  assert.equal((await readStatus(w.env)).triage.runner.qualification, "missing")
  const file = path.join(await factoryStateRoot(w.env), ...QUALIFICATION_SEGMENTS)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // A whole canonical document that does not restore here is stale: quiet, with a reason, nothing reserved, no failure counted. The
  // document reader, the loader and the install identity are the runner's own.
  await fs.writeFile(file, "{}\n", { mode: 0o600 })
  const stale = await step(w, { seams: defaults })
  assert.deepEqual([stale.result, stale.ok, stale.launched], ["runner_unavailable", true, false], JSON.stringify(stale))
  const staleRunner = (await readStatus(w.env)).triage.runner
  assert.deepEqual([staleRunner.state, staleRunner.qualification], ["scope_unqualified", "stale"])
  assert.ok(["source_changed", "engine_changed"].includes(staleRunner.reason), staleRunner.reason)
  // Each stale reason the step can tell, then the loader's own.
  const loader = (reason) => ({ ...defaults, loadTriageQualification: async () => ({ state: "scope_unqualified", ...(reason === undefined ? {} : { reason }) }) })
  const reasonOf = async (seams) => {
    const result = await step(w, { seams })
    assert.deepEqual([result.result, result.ok, result.launched], ["runner_unavailable", true, false])
    return (await readStatus(w.env)).triage.runner.reason
  }
  assert.equal(await reasonOf({ ...loader(), sourceIdentity: async () => ({ files: { "/elsewhere/triage-runner.js": "0" } }) }), "source_changed")
  assert.equal(await reasonOf({ ...loader(), sourceIdentity: async () => undefined }), "engine_changed")
  assert.equal(await reasonOf({ ...loader(), sourceIdentity: async () => { throw new Error("no identity") } }), "engine_changed")
  await fs.rm(file)
  await fs.writeFile(file, `{"cli":${JSON.stringify(process.execPath)}}\n`, { mode: 0o600 })
  assert.equal(await reasonOf({ ...loader("effective_policy_unknown"), sourceIdentity: async () => undefined }), "qualification_failed")
  const passes = (await readStatus(w.env)).loop.steps.triage
  assert.deepEqual([passes.failures, passes.failures_in_a_row], [0, 0], "a stale or missing record never counts towards the alarm")
  assert.equal(triageKickDue(await readStatus(w.env), at(48)), false, "and the end of a turn starts no worker for it")
  // A file that is not the canonical document the qualifier wrote is damaged: the one qualification failure.
  await fs.rm(file)
  await fs.writeFile(file, "{ not the canonical document", { mode: 0o600 })
  const broken = await step(w, { seams: defaults })
  assert.deepEqual([broken.result, broken.ok, broken.launched], ["runner_blocked", false, false])
  assert.deepEqual((await readStatus(w.env)).triage.runner, { state: "scope_unqualified", reason: "unreadable", qualification: "damaged" })
  const odd = await step(w, { seams: { ...untouched, restoreQualification: async () => ({ state: "invalid" }) } })
  assert.deepEqual([odd.result, odd.ok], ["runner_unavailable", true])
  assert.deepEqual((await readStatus(w.env)).triage.runner, { state: "scope_unqualified", reason: "qualification_failed", qualification: "stale" })
  const thrownLoader = await step(w, { seams: { ...untouched, restoreQualification: async () => { throw new Error("x") } } })
  assert.deepEqual([thrownLoader.result, (await readStatus(w.env)).triage.runner.qualification], ["runner_unavailable", "stale"])
  // The default runner refuses a record it did not restore itself.
  const { runTriageChild: _runner, loadRunner: _runtime, ...realRunner } = qualifiedSeams()
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
  // A launch that returns and has no review accepted is a failure, whatever the reasons.
  const stale = await step(w, { now: at(7), seams: qualifiedSeams({ publishOwnedTriage: async () => ({ state: "stale_basis", resources: [] }) }) })
  assert.deepEqual([stale.result, stale.ok, stale.refused], ["nothing_accepted", false, 2])
  const thrown = await step(w, { now: at(14), seams: qualifiedSeams({ runTriageChild: async () => { throw new Error("boom") } }) })
  assert.deepEqual([thrown.result, thrown.launched], ["failed", true])
  // The deadline arrives while rows are being accepted: the rest are deferred, not dropped or refused.
  let now = Date.now()
  const runner = fakeRunner(({ brief }) => {
    now += 30 * 60 * 1000
    return brief.cards.map((card) => row(card))
  })
  const late = await step(w, { now: at(21), deadline: new Date(now + 16 * 60 * 1000), seams: qualifiedSeams({ runner, clock: () => now }) })
  assert.deepEqual([late.result, late.ok, late.reviewed, late.deferred], ["nothing_accepted", false, 0, 2])
  const attempts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(w.env), "triage", "attempts.json"), "utf8")).attempts
  assert.deepEqual(Object.values(attempts).map((value) => value.state), ["deferred", "deferred"])
  // A candidate file that cannot be read is no candidate.
  const vanished = fakeRunner(() => ({ state: "ran", resultFile: path.join(w.base, "nowhere.json") }))
  const gone = await step(w, { now: at(28), seams: qualifiedSeams({ runner: vanished }) })
  assert.deepEqual([gone.result, gone.reviewed, gone.refused], ["nothing_accepted", 0, 2])
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
  // A change the refresh could not judge on an unreadable scan is held, and the pass fails.
  const blindRefresh = async () => ({ state: "unreadable", changes: [{ key: KEYS[0], operation: null, state: "source_unknown", reason: "source_incomplete" }], coverage: { scan: "unreadable", reviewed: null, unreviewed: null } })
  const blind = await step(w, { seams: qualifiedSeams({ refreshTriage: blindRefresh, hostSupport: async () => ({ provenance: false }) }) })
  assert.deepEqual([blind.result, blind.ok, (await readStatus(w.env)).triage.refresh.held], ["refresh_incomplete", false, 1])
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
  // A ledger that refuses or cannot answer leaves no continuation; the run itself goes on.
  for (const mint of [async () => ({ state: "not_runnable" }), async () => { throw new Error("ledger") }]) {
    const fresh = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
    await updateStatus(fresh.env, (status) => ({ ...status, evaluator: { ...status.evaluator, ready_now: 2, ready_later: 0 } }))
    const calls = []
    const result = await step(fresh, { seams: qualifiedSeams({ createEvaluationContinuation: async (...args) => { calls.push(args); return mint() } }) })
    assert.deepEqual([result.result, result.launched, result.continuation, calls.length], ["ran", true, undefined, 1])
  }
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
  // The loop's own switch stops the command as it stops every step.
  assert.deepEqual(await runTriageCommand({ argv: ["--desk", w.deskRoot], env: { ...w.env, DESK_FACTORY_LOOP: "0" }, pluginVersion: "9.9.9", impls: { refreshTriage: async () => assert.fail("nothing runs") } }), { result: "disabled", ok: true, failed: 0, reviewed: null, refused: null, deferred: null, unreviewed: null })
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
    // No card could be put in a brief: nothing to send, said and counted, and no failure.
    assert.deepEqual([held.result, held.ok, held.launched, held.deferred], ["brief_empty", true, false, 2], id)
  }
  assert.deepEqual(await runFolders(w), [], "no run folder is made for an empty brief")
  const blind = await step(w, { seams: qualifiedSeams({ readStatus: async () => { throw new Error("x") }, runTriageChild: never }) })
  assert.deepEqual([blind.result, blind.ok], ["status_unavailable", false])
  // The installed record is asked of the runner's own loader: only `qualified` loads.
  const file = path.join(await factoryStateRoot(w.env), ...QUALIFICATION_SEGMENTS)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, "{}\n", { mode: 0o600 })
  const { restoreQualification: _injected, loadRunner: _fake, ...viaLoader } = qualifiedSeams({ runTriageChild: never, sourceIdentity: async () => undefined })
  const asked = []
  const held = await step(w, { seams: { ...viaLoader, loadTriageQualification: async (options) => { asked.push(options); return { state: "scope_unqualified" } } } })
  assert.deepEqual([held.result, held.ok, (await readStatus(w.env)).triage.runner.qualification], ["runner_unavailable", true, "stale"])
  assert.deepEqual(asked, [{ recordFile: file, env: w.env }])

  // A review the safe transform refuses is not written, whatever the candidate said.
  let prepared
  const unsafe = await step(w, { seams: qualifiedSeams({ toSafeTriageReview: () => ({ state: "refused" }), runner: fakeRunner((input) => { prepared = input; return input.brief.cards.map((card) => row(card)) }) }) })
  assert.deepEqual([unsafe.result, unsafe.reviewed, unsafe.refused], ["nothing_accepted", 0, 2])
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
  assert.deepEqual([folder.result, folder.reviewed, folder.refused], ["nothing_accepted", 0, 2])

  // One card's ruling cannot be read: the other is reviewed. The runner names no file, so the one the step asked for is read; a refresh
  // that was incomplete is still said after a run.
  const quiet = fakeRunner()
  const partial = await step(w, { now: at(21), seams: {
    ...viaLoader, loadTriageQualification: async () => ({ state: "qualified" }), readTriageBasis: rulings("missing.md", a),
    refreshTriage: async (options) => ({ ...(await refreshTriage(options)), state: "unreadable" }),
    runTriageChild: async (options) => { await quiet(options); return { state: "ran" } },
  } })
  assert.deepEqual([partial.result, partial.ok, partial.reviewed, partial.deferred], ["refresh_incomplete", false, 1, 1], JSON.stringify(partial))
  assert.equal(annotation(w, b).attempt.state, "reviewed")
  assert.equal(annotation(w, a), null)

  // The host check is the custody module's own unless a test replaces it: only macOS can run the runner.
  const { hostSupport: _host, loadRunner: _runtime, ...ownHost } = qualifiedSeams()
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
    const { hostSupport: _injected, loadRunner: _runtime, ...rest } = qualifiedSeams({ runTriageChild: never, reserveAgentLaunch: never, restoreQualification: never })
    const seams = hostSupport === undefined ? rest : { ...rest, hostSupport }
    for (const hour of [0, 1, 2, 3]) {
      const result = await step(w, { now: at(hour), seams })
      assert.deepEqual(result, { ok: true, result: "runner_unavailable", launched: false, reviewed: null, refused: null, deferred: null, unreviewed: 2 })
    }
  }
  const status = await readStatus(w.env)
  // Where the runtime itself cannot be loaded (a host the runner was never built for) that is said instead, just as quietly.
  const unloadable = process.platform === "win32" && status.triage.runner.state === "runtime_unavailable"
  assert.deepEqual(status.triage.runner, unloadable ? { state: "runtime_unavailable", reason: "runtime_unloadable", qualification: "not_checked" } : { state: "unsupported_host", reason: null, qualification: "not_checked" }, "the reason is visible")
  assert.deepEqual([status.triage.refresh.changes, status.triage.refresh.held], [0, 0])
  assert.deepEqual([status.loop.steps.triage.failures, status.loop.steps.triage.failures_in_a_row, status.loop.steps.triage.last_result], [0, 0, "runner_unavailable"])
  assert.equal(status.loop.agent_launch_highwater, undefined, "no launch was reserved")
  assert.equal(annotation(w, KEYS[0]), null)
  assert.deepEqual(await fs.readdir(path.join(await factoryStateRoot(w.env), "triage")).catch(() => []), [], "no run folder was made")
  // The end of a turn never starts a worker for a runner this host cannot start.
  assert.equal(triageKickDue(status, at(48)), false)
})

test("six launches that time out reach the stale alarm through the step itself, whatever quiet passes run between them", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  const timeout = () => qualifiedSeams({ runner: fakeRunner(() => ({ state: "timeout" })) })
  const never = qualifiedSeams({ runTriageChild: async () => assert.fail("no run") })
  // A damaged streak counts from nothing.
  await updateStatus(w.env, (status) => ({ ...status, triage: { run: { failures_in_a_row: "many" } } }))
  const hours = [0, 7, 14, 21, 31, 38]
  for (const [index, hour] of hours.entries()) {
    const launched = await step(w, { now: at(hour), seams: timeout() })
    assert.deepEqual([launched.result, launched.ok, launched.launched], ["timeout", false, true], `launch ${index + 1}`)
    // The six-hour gap after every launch: a quiet pass, ok for the refresh, that is no success of the run.
    const cooling = await step(w, { now: at(hour + 1), seams: never })
    assert.deepEqual([cooling.result, cooling.ok, cooling.launched], ["not_due", true, false])
    const status = await readStatus(w.env)
    const record = status.loop.steps.triage
    assert.deepEqual([record.failures, record.failures_in_a_row, record.last_ok_at, record.last_result, record.runs], [index + 1, index + 1, null, "not_due", 2 * (index + 1)])
    assert.deepEqual([status.triage.run.failures_in_a_row, status.triage.run.last_result, status.triage.run.last_ok_at ?? null, status.triage.run.last_at], [index + 1, "timeout", null, at(hour).toISOString()])
    assert.deepEqual(staleSteps(status, at(hour + 1), ["triage"]), index >= 2 ? ["triage"] : [], "three failed launches in a row are stale")
    assert.equal(triageKickDue(status, at(hour + 6.5)), false, "a failing run is retried by a session-start worker, never by a kick")
  }
  // The real measure step opens the real card from what the step recorded.
  const measured = await runMeasureStep(w.env, { deskRoot: w.deskRoot, personPrefix: "", now: at(39), attempted: ["triage"] })
  assert.deepEqual([measured.ok, measured.counts.opened], [true, 1], JSON.stringify(measured))
  assert.ok((await readCards({ deskRoot: w.deskRoot, personPrefix: "" })).cards.some((card) => card.key === "loop_alarm:step_stale:triage" && card.state === "open"))
  const health = (await readStatus(w.env)).loop.health.triage
  assert.deepEqual([health.run.last_result, health.run.failures_in_a_row.value, health.run.last_ok_at, health.scan], ["timeout", 6, null, "complete"])
  // A launch with an accepted review is the run's success: both streaks clear. (The measure step commits the alarm card locally; it is
  // pushed first, as the desk's own sync would, so it is reviewed too.)
  git(w.deskRoot, ["push", "-q", "origin", "HEAD:main"])
  const good = await step(w, { now: at(45) })
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.ok(good.reviewed >= 1)
  const after = await readStatus(w.env)
  assert.deepEqual([after.loop.steps.triage.failures_in_a_row, after.triage.run.failures_in_a_row, after.triage.run.last_ok_at, after.triage.run.last_result], [0, 0, at(45).toISOString(), "ran"])
  assert.deepEqual(staleSteps(after, at(45), ["triage"]), [])

  // With no card left for a run to fail on, a failed launch's streak clears without a launch.
  const other = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  assert.equal((await step(other, { seams: timeout() })).result, "timeout")
  assert.equal((await step(other, { now: at(1), seams: never })).result, "not_due")
  assert.equal((await readStatus(other.env)).loop.steps.triage.failures_in_a_row, 1)
  await fs.rm(cardFile(other.deskRoot, "", KEYS[0]))
  pushDesk(other)
  const settled = await step(other, { now: at(7), seams: never })
  assert.deepEqual([settled.result, settled.ok], ["nothing_to_review", true])
  const cleared = await readStatus(other.env)
  assert.deepEqual([cleared.loop.steps.triage.failures_in_a_row, cleared.triage.run.failures_in_a_row, cleared.loop.steps.triage.last_ok_at], [0, 0, at(7).toISOString()])
})

test("more than 200 card files: the refresh reads up to the card bound and every pass is whole and ok", async () => {
  const keys = Array.from({ length: 201 }, (_, index) => `andon:example-org/example-repo#${1000 + index}`)
  const w = await triageWorld({ now: at(0), keys })
  const limits = []
  const seams = qualifiedSeams({ hostSupport: async () => ({ provenance: false }), runTriageChild: async () => assert.fail("no run"), readCards: async (options) => { limits.push(options.limit); return readCards(options) } })
  for (const hour of [0, 1, 2]) {
    const result = await step(w, { now: at(hour), seams })
    assert.deepEqual(result, { ok: true, result: "runner_unavailable", launched: false, reviewed: null, refused: null, deferred: null, unreviewed: 201 })
  }
  const status = await readStatus(w.env)
  assert.deepEqual([status.triage.refresh.scan, status.triage.coverage.unreviewed, status.loop.steps.triage.failures, status.loop.steps.triage.last_ok_at], ["complete", 201, 0, at(2).toISOString()])
  assert.deepEqual([...new Set(limits)], [MAX_CARD_FILES], "every listing asks for the card library's own bound, not the default 200")
})

test("refusals seen before a launch spend nothing: a billing variable, no sign-in and no time are quiet and reserve no launch", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  const never = (what) => async () => assert.fail(what)
  const guarded = (extra = {}) => qualifiedSeams({ runTriageChild: never("no run"), reserveAgentLaunch: never("nothing is reserved"), restoreQualification: async () => ({ state: "qualified", qualification: { state: "qualified", cli: "/opt/engine/claude" } }), ...extra })
  const quietly = async (world, seams, runner, options = {}) => {
    const result = await step(world, { seams, ...options })
    assert.deepEqual([result.result, result.ok, result.launched], ["runner_unavailable", true, false], JSON.stringify(result))
    assert.deepEqual((await readStatus(world.env)).triage.runner, runner)
  }
  // A billing variable: the person's decision, seen before the record is even loaded.
  await quietly({ ...w, env: { ...w.env, ANTHROPIC_API_KEY: "placeholder" } }, guarded({ restoreQualification: never("not loaded"), probeSignIn: never("not probed") }), { state: "disabled_would_bill", reason: null, qualification: "not_checked" })
  // The engine's own sign-in, asked of the qualified engine before anything is prepared.
  const asked = []
  await quietly(w, guarded({ probeSignIn: async (options) => { asked.push([options.cli, options.env === w.env]); return { state: "no_credentials" } } }), { state: "no_credentials", reason: null, qualification: "loaded" })
  assert.deepEqual(asked, [["/opt/engine/claude", true]])
  await quietly(w, guarded({ probeSignIn: async () => ({ state: "disabled_would_bill" }) }), { state: "disabled_would_bill", reason: null, qualification: "loaded" })
  await quietly(w, guarded({ probeSignIn: async () => ({ state: "something_new" }) }), { state: "sign_in_unknown", reason: null, qualification: "loaded" })
  await quietly(w, guarded({ probeSignIn: async () => { throw new Error("no engine") } }), { state: "sign_in_unknown", reason: null, qualification: "loaded" })
  // The probe asks the pinned engine the runtime locates, never a path from the record; no engine located is no sign-in, without a probe.
  const noProbe = never("not probed")
  await quietly(w, guarded({ locateEngine: async () => null, probeSignIn: noProbe }), { state: "sign_in_unknown", reason: null, qualification: "loaded" })
  const located = []
  const runtimeWith = (locatePinnedEngine) => async () => ({ ...FAKE_RUNTIME, qualify: locatePinnedEngine === undefined ? {} : { locatePinnedEngine } })
  for (const [locatePinnedEngine, found] of [[async () => "/opt/pinned/claude", "/opt/pinned/claude"], [async () => ({ path: "/opt/pinned/other" }), "/opt/pinned/other"], [async () => ({ path: "relative/claude" }), null], [async () => null, null], [undefined, null]]) {
    const { locateEngine: _seam, ...ownLocator } = guarded({ loadRunner: runtimeWith(locatePinnedEngine), probeSignIn: async (options) => { located.push(options.cli); return { state: "no_credentials" } } })
    const probes = located.length
    await step(w, { seams: ownLocator })
    assert.equal((await readStatus(w.env)).triage.runner.state, found === null ? "sign_in_unknown" : "no_credentials")
    assert.equal(located.length, probes + (found === null ? 0 : 1))
  }
  assert.deepEqual(located, ["/opt/pinned/claude", "/opt/pinned/other"])
  // The real probe on an engine that does not exist answers without a launch too.
  const { probeSignIn: _fake, ...realProbe } = guarded()
  const probed = await step(w, { seams: realProbe })
  assert.deepEqual([probed.result, probed.ok, probed.launched], ["runner_unavailable", true, false])
  assert.deepEqual(await runFolders(w), [], "nothing was prepared")
  // The probe used up the time for a whole run: the prepared folder is removed and nothing is reserved.
  let now = Date.now()
  const slow = await step(w, { deadline: new Date(now + TRIAGE_RUN_MS + 60 * 1000), seams: guarded({ clock: () => now, probeSignIn: async () => { now += 5 * 60 * 1000; return { state: "subscription" } } }) })
  assert.deepEqual([slow.result, slow.ok, slow.launched, slow.deferred], ["no_time_for_a_run", true, false, 1])
  assert.deepEqual(await runFolders(w), [], "a prepared run that is not launched leaves no folder")
  // So does a reservation the quota refuses.
  const refusedQuota = await step(w, { seams: guarded({ reserveAgentLaunch: async () => ({ state: "window_used" }) }) })
  assert.deepEqual([refusedQuota.result, refusedQuota.ok, await runFolders(w)], ["window_used", true, []])
  const status = await readStatus(w.env)
  assert.deepEqual([status.loop.steps.triage.failures, status.loop.agent_launch_highwater], [0, undefined], "no failure counted and no launch spent")
})

test("a reserved launch is always finished, a throw after the reservation is a stated failure, and one card's failure is that card's alone", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 2) })
  const finished = []
  const finish = async (env, options) => { finished.push(options.state); return finishAgentLaunch(env, options) }
  const timeout = await step(w, { seams: qualifiedSeams({ finishAgentLaunch: finish, runner: fakeRunner(() => ({ state: "timeout" })) }) })
  assert.deepEqual([timeout.result, finished], ["timeout", ["failed"]])
  // The clock fails right after the reservation, with no evaluation waiting: the launch is finished in the ledger and the step says so.
  await updateStatus(w.env, (status) => ({ ...status, loop: { ...status.loop, steps: { ...status.loop.steps, evaluate: { last_ran_at: at(7).toISOString(), last_ok_at: at(7).toISOString(), last_result: "ran", runs: 1, failures: 0, failures_in_a_row: 0 } } } }))
  let armed = false
  const clock = () => {
    if (armed) {
      armed = false
      throw new Error("clock")
    }
    return Date.now()
  }
  const reserve = async (env, options) => {
    const reserved = await reserveAgentLaunch(env, options)
    armed = true
    return reserved
  }
  const thrown = await step(w, { now: at(7), seams: qualifiedSeams({ clock, reserveAgentLaunch: reserve, finishAgentLaunch: finish, runTriageChild: async () => assert.fail("no run") }) })
  assert.deepEqual(thrown, { ok: false, result: "step_error", launched: true, reviewed: null, refused: null, deferred: null, unreviewed: 2 })
  assert.deepEqual(finished, ["failed", "failed"], "the reservation was finished")
  const failing = await readStatus(w.env)
  assert.deepEqual([failing.triage.result, failing.triage.run.failures_in_a_row, failing.loop.steps.triage.failures_in_a_row], ["step_error", 2, 2])
  // The protected row of one card cannot be stored: that card is refused, the other is accepted, and the pass is not a success.
  const { writeProtectedTriageFile } = await import("../../../../../plugins/desk/mcp/src/factory/triage-write.js")
  let rows = 0
  const store = async (...args) => {
    rows += 1
    if (rows === 1) throw new Error("disk full")
    return writeProtectedTriageFile(...args)
  }
  const partial = await step(w, { now: at(14), seams: qualifiedSeams({ finishAgentLaunch: finish, writeProtectedTriageFile: store }) })
  assert.deepEqual([partial.result, partial.ok, partial.reviewed, partial.refused], ["write_incomplete", false, 1, 1], JSON.stringify(partial))
  const attempts = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(w.env), "triage", "attempts.json"), "utf8")).attempts
  assert.deepEqual(Object.values(attempts).map((value) => value.state).sort(), ["refused", "reviewed"])
  assert.equal((await readStatus(w.env)).triage.run.failures_in_a_row, 0, "a review was accepted: the run itself succeeded")
  const last = await step(w, { now: at(21), seams: qualifiedSeams({ finishAgentLaunch: finish }) })
  assert.deepEqual([last.result, last.ok, last.reviewed], ["ran", true, 1])
  assert.deepEqual(finished, ["failed", "failed", "ran", "ran"], "every reserved launch was finished exactly once")
})

test("run folders are bounded: launched runs without an accepted review keep only the newest, and a run with one is kept", { skip: NEEDS_PREPARED_RUN }, async () => {
  assert.equal(KEPT_UNACCEPTED_RUNS, 8)
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  const root = path.join(await factoryStateRoot(w.env), "triage")
  const name = (index) => index.toString(16).padStart(2, "0").repeat(16)
  for (const folder of ["runs", "results"]) await fs.mkdir(path.join(root, folder), { recursive: true, mode: 0o700 })
  // Ten old run folders, the higher the index the older; the oldest had a review accepted. One folder is not a run's.
  for (let index = 0; index < 10; index += 1) {
    await fs.mkdir(path.join(root, "runs", name(index)), { mode: 0o700 })
    await fs.writeFile(path.join(root, "runs", name(index), "candidate.json"), "{}")
    const when = new Date(Date.now() - (index + 1) * HOUR)
    await fs.utimes(path.join(root, "runs", name(index)), when, when)
  }
  await fs.mkdir(path.join(root, "results", name(9)), { mode: 0o700 })
  await fs.mkdir(path.join(root, "runs", "notes"), { mode: 0o700 })
  assert.equal((await step(w)).reviewed, 1)
  const kept = await runFolders(w)
  const made = kept.filter((entry) => entry !== "notes" && !Array.from({ length: 10 }, (_, index) => name(index)).includes(entry))
  assert.equal(made.length, 1, "this run's own folder")
  assert.deepEqual(kept.filter((entry) => !made.includes(entry)), [...Array.from({ length: 8 }, (_, index) => name(index)), name(9), "notes"].sort(), "the ninth unaccepted run is gone; the accepted one and the stray folder stay")
})

test("the runner is loaded through one seam: a runtime that does not load is quiet, with its reason, and spends nothing", async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  const never = async () => assert.fail("nothing past the loader")
  const seams = (loadRunner) => qualifiedSeams({ loadRunner, hostSupport: never, restoreQualification: never, reserveAgentLaunch: never, runTriageChild: never })
  for (const [loadRunner, reason] of [
    [async () => { const error = new Error("Cannot find package"); error.code = "ERR_MODULE_NOT_FOUND"; throw error }, "runtime_unloadable"],
    [async () => ({ state: "unavailable", reason: "runtime_unavailable" }), "runtime_unavailable"],
    [async () => ({ state: "unavailable", reason: "runtime_unloadable" }), "runtime_unloadable"],
    [async () => ({ state: "unavailable", reason: "Something Else" }), "runtime_unloadable"],
    [async () => null, "runtime_unloadable"],
  ]) {
    const result = await step(w, { seams: seams(loadRunner) })
    assert.deepEqual([result.result, result.ok, result.launched], ["runner_unavailable", true, false])
    assert.deepEqual((await readStatus(w.env)).triage.runner, { state: "runtime_unavailable", reason, qualification: "not_checked" })
  }
  const status = await readStatus(w.env)
  assert.deepEqual([status.loop.steps.triage.failures, status.loop.agent_launch_highwater], [0, undefined])
  assert.equal(triageKickDue(status, at(48)), false, "a host whose runtime does not load is not kicked")
  // The host check and the run are asked of the loaded runtime.
  const runtime = { state: "loaded", custody: { ownedCatalogHostSupport: () => ({ provenance: false }) }, runner: {}, qualify: {} }
  const { hostSupport: _host, ...own } = qualifiedSeams({ loadRunner: async () => runtime })
  assert.equal((await step(w, { seams: own })).result, "runner_unavailable")
  assert.equal((await readStatus(w.env)).triage.runner.state, "unsupported_host")
})

test("the restore's answer: the runner's own restore is used when it has one, its reasons are kept, and anything unknown is read conservatively", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
  const asked = []
  const runtime = (answer) => ({ ...FAKE_RUNTIME, runner: { restoreTriageQualification: async (options) => { asked.push(options); return answer } } })
  const { restoreQualification: _drop, ...viaRuntime } = qualifiedSeams({ reserveAgentLaunch: async () => assert.fail("nothing reserved") })
  const check = async (answer, expected) => {
    const result = await step(w, { seams: { ...viaRuntime, loadRunner: async () => runtime(answer) } })
    assert.deepEqual([result.result, result.ok, result.launched], expected.ok ? ["runner_unavailable", true, false] : ["runner_blocked", false, false], JSON.stringify(answer))
    assert.deepEqual((await readStatus(w.env)).triage.runner, { state: "scope_unqualified", reason: expected.reason, qualification: expected.qualification })
  }
  for (const reason of ["engine_unpinned", "engine_mismatch", "host_unsupported", "measurement_active"]) {
    await check({ state: "stale", reason, requalify: false }, { ok: true, reason, qualification: "stale" })
  }
  // A reason qualifying again can fix goes to the qualifier first; with none loaded, it is the same quiet state.
  for (const reason of ["record_version", "qualification_failed", "source_changed", "runtime_changed", "engine_changed", "environment_changed", "chain_changed", "policy_changed"]) {
    await check({ state: "stale", reason, requalify: true }, { ok: true, reason, qualification: "stale" })
  }
  await check({ state: "stale", reason: "Not a reason" }, { ok: true, reason: "qualification_failed", qualification: "stale" })
  await check({ state: "missing" }, { ok: true, reason: null, qualification: "missing" })
  for (const reason of ["unreadable", "noncanonical", "structure", "receipts", "restore_failed"]) await check({ state: "damaged", reason }, { ok: false, reason, qualification: "damaged" })
  await check({ state: "damaged", reason: "Not a reason" }, { ok: false, reason: "unreadable", qualification: "damaged" })
  assert.deepEqual(asked[0], { recordFile: path.join(await factoryStateRoot(w.env), ...QUALIFICATION_SEGMENTS), env: w.env })
  const record = (await readStatus(w.env)).loop.steps.triage
  assert.equal(record.failures, 6, "only the six damaged records counted")
  // A qualified record is handed to the runner as the restore gave it.
  const qualification = { state: "qualified", cli: "/opt/engine/claude" }
  const runs = []
  const ran = await step(w, { now: at(1), seams: { ...viaRuntime, reserveAgentLaunch, loadRunner: async () => runtime({ state: "qualified", qualification }), runTriageChild: async (options, loaded) => { runs.push([options.qualification, loaded.state]); return fakeRunner()(options) } } })
  assert.deepEqual([ran.result, ran.reviewed, runs], ["ran", 1, [[qualification, "loaded"]]])
  assert.equal(TRIAGE_ENGINE_CARD, "triage_engine_unpinned")
})

test("a missing or requalifiable record asks the qualifier first; a launch it made takes the slot, and only its failure counts", { skip: NEEDS_PREPARED_RUN }, async () => {
  const fresh = async () => {
    const w = await triageWorld({ now: at(0), keys: KEYS.slice(0, 1) })
    await updateStatus(w.env, (status) => ({ ...status, evaluator: { ...status.evaluator, ready_now: 1, ready_later: 0 } }))
    return w
  }
  const calls = []
  const seams = ({ restore = [{ state: "missing" }], qualify, ...extra }) => {
    const answers = [...restore]
    return qualifiedSeams({
      restoreQualification: async () => answers.length > 1 ? answers.shift() : answers[0],
      autoQualify: async (env, options, runtime) => { calls.push([options, runtime === FAKE_RUNTIME]); return typeof qualify === "function" ? qualify() : qualify },
      ...extra,
    })
  }
  const noRun = { runTriageChild: async () => assert.fail("no triage run"), reserveAgentLaunch: async () => assert.fail("the step reserves nothing") }

  // Launched and qualified: the slot is spent, the evaluation it deferred gets its continuation, and the run is a success.
  let w = await fresh()
  const lock = { proof: "the worker's lock" }
  const qualified = await step(w, { generation: "gen-q", lock, seams: seams({ qualify: { state: "qualified", reason: null, launched: true }, ...noRun }) })
  assert.deepEqual([qualified.result, qualified.ok, qualified.launched, qualified.continuation?.state], ["runner_qualified", true, true, "issued"])
  const [options, sameRuntime] = calls.at(-1)
  assert.deepEqual(Object.keys(options).sort(), ["deadline", "generation", "legacyEvaluator", "lock", "now"])
  assert.deepEqual([options.now instanceof Date, options.deadline instanceof Date, options.generation, options.lock, sameRuntime], [true, true, "gen-q", lock, true])
  assert.deepEqual(options.legacyEvaluator, (await readStatus(w.env)).evaluator)
  let status = await readStatus(w.env)
  assert.deepEqual([status.triage.runner, status.triage.run.failures_in_a_row, status.triage.run.last_result], [{ state: "qualifying", reason: null, qualification: "qualified" }, 0, "runner_qualified"])

  // Launched and failed: a failed run for the alarm.
  w = await fresh()
  const failed = await step(w, { seams: seams({ qualify: { state: "failed", reason: "chain_changed", launched: true }, ...noRun }) })
  assert.deepEqual([failed.result, failed.ok, failed.launched], ["qualification_failed", false, true])
  status = await readStatus(w.env)
  assert.deepEqual([status.triage.run.failures_in_a_row, status.loop.steps.triage.failures_in_a_row, status.triage.runner.reason], [1, 1, "chain_changed"])
  assert.equal(triageKickDue(status, at(48)), false)

  // Launched and skipped: quiet, the slot still spent, the run's health unchanged.
  w = await fresh()
  const skippedLaunch = await step(w, { seams: seams({ qualify: { state: "skipped", reason: 7, launched: true }, ...noRun }) })
  assert.deepEqual([skippedLaunch.result, skippedLaunch.ok, skippedLaunch.launched], ["runner_unavailable", true, true])
  assert.deepEqual([(await readStatus(w.env)).triage.run.failures_in_a_row, (await readStatus(w.env)).triage.runner.reason], [0, null])

  // With no evaluation waiting, a launch the qualifier made mints no continuation.
  w = await fresh()
  await updateStatus(w.env, (status) => ({ ...status, loop: { ...(status.loop ?? {}), steps: { evaluate: { last_ran_at: at(0).toISOString(), last_ok_at: at(0).toISOString(), last_result: "ran", runs: 1, failures: 0, failures_in_a_row: 0 } } } }))
  const idle = await step(w, { seams: seams({ qualify: { state: "qualified", launched: true }, ...noRun }) })
  assert.deepEqual([idle.result, idle.launched, idle.continuation], ["runner_qualified", true, undefined])

  // A qualifier that throws may have launched: the slot is spent and it is a failed run.
  w = await fresh()
  const thrown = await step(w, { seams: seams({ qualify: () => { throw new Error("qualifier") }, ...noRun }) })
  assert.deepEqual([thrown.result, thrown.ok, thrown.launched], ["qualification_failed", false, true])

  // Not launched: skipped is quiet, failed counts, and qualified restores again and runs in the same generation.
  w = await fresh()
  const skipped = await step(w, { seams: seams({ qualify: { state: "skipped", reason: "already_today", launched: false }, ...noRun }) })
  assert.deepEqual([skipped.result, skipped.ok, skipped.launched], ["runner_unavailable", true, false])
  assert.deepEqual((await readStatus(w.env)).triage.runner, { state: "scope_unqualified", reason: "already_today", qualification: "missing" })
  const refusedEarly = await step(w, { seams: seams({ qualify: { state: "failed", reason: "no_credentials", launched: false }, ...noRun }) })
  assert.deepEqual([refusedEarly.result, refusedEarly.ok, refusedEarly.launched], ["qualification_failed", false, false])
  assert.equal((await readStatus(w.env)).triage.run.failures_in_a_row, 1)
  const ready = await step(w, { seams: seams({ restore: [{ state: "missing" }, { state: "qualified", qualification: { state: "qualified" } }], qualify: { state: "qualified", launched: false } }) })
  assert.deepEqual([ready.result, ready.ok, ready.launched, ready.reviewed], ["ran", true, true, 1])

  // A qualifier suspended after repeated host-side failures is a counted failure with its reason, whether it says skipped or failed.
  for (const suspended of ["skipped", "failed"]) {
    w = await fresh()
    const result = await step(w, { seams: seams({ qualify: { state: suspended, reason: "auto_suspended", launched: false }, ...noRun }) })
    assert.deepEqual([result.result, result.ok, result.launched], ["qualification_failed", false, false])
    const status = await readStatus(w.env)
    assert.deepEqual([status.triage.runner.reason, status.triage.run.failures_in_a_row, status.loop.steps.triage.failures_in_a_row], ["auto_suspended", 1, 1])
  }

  // A stale record is offered to the qualifier only when its reason is one qualifying again can fix, by the runtime's own map when it
  // has one (else the mirror); with no qualifier nothing is attempted.
  w = await fresh()
  const before = calls.length
  for (const reason of ["engine_unpinned", "engine_mismatch", "host_unsupported", "measurement_active"]) {
    const kept = await step(w, { seams: seams({ restore: [{ state: "stale", reason, requalify: true }], qualify: { state: "qualified", launched: true }, ...noRun }) })
    assert.deepEqual([kept.result, kept.ok, calls.length, (await readStatus(w.env)).triage.runner.reason], ["runner_unavailable", true, before, reason])
  }
  const requalify = await step(w, { seams: seams({ restore: [{ state: "stale", reason: "engine_changed", requalify: false }], qualify: { state: "skipped", reason: "budget", launched: false }, ...noRun }) })
  assert.deepEqual([requalify.result, calls.length, (await readStatus(w.env)).triage.runner.qualification], ["runner_unavailable", before + 1, "stale"])
  const theirMap = { ...FAKE_RUNTIME, qualify: { TRIAGE_STALE_REASONS: { engine_changed: false, brand_new: true } } }
  const mapped = await step(w, { seams: seams({ loadRunner: async () => theirMap, restore: [{ state: "stale", reason: "engine_changed" }], qualify: { state: "qualified", launched: true }, ...noRun }) })
  assert.deepEqual([mapped.result, calls.length], ["runner_unavailable", before + 1], "the runtime's map says qualifying again cannot fix it")
  const offered = await step(w, { seams: seams({ loadRunner: async () => ({ ...FAKE_RUNTIME, runner: { TRIAGE_STALE_REASONS: { brand_new: true } } }), restore: [{ state: "stale", reason: "brand_new" }], qualify: { state: "skipped", reason: "budget", launched: false }, ...noRun }) })
  assert.deepEqual([offered.result, calls.length, (await readStatus(w.env)).triage.runner.reason], ["runner_unavailable", before + 2, "budget"])
  await step(w, { seams: seams({ loadRunner: async () => theirMap, restore: [{ state: "stale", reason: "record_version" }], ...noRun }) })
  assert.equal((await readStatus(w.env)).triage.runner.reason, "qualification_failed", "a reason the map does not name is read as the generic one")
  const { autoQualify: _none, ...noQualifier } = seams({ ...noRun })
  assert.equal((await step(w, { seams: noQualifier })).result, "runner_unavailable")
  // The default asks the loaded runtime's own qualifier.
  const own = []
  const { autoQualify: _q, ...defaultQualifier } = seams({ ...noRun, loadRunner: async () => ({ ...FAKE_RUNTIME, qualify: { autoQualifyTriage: async (env, options) => { own.push(options.generation); return { state: "skipped", reason: "budget", launched: false } } } }) })
  assert.equal((await step(w, { generation: "gen-own", seams: defaultQualifier })).result, "runner_unavailable")
  assert.deepEqual(own, ["gen-own"])
})
