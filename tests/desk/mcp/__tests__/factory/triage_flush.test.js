// Triage publication through the flush: an acknowledged annotation of a synthetic desk becomes one immutable `triage/<batch>.json`
// in a fake store, and nothing marks it delivered but its exact bytes on the store's default branch. Real Git (a temporary bare
// remote and a clone), real cards, the real annotation writer and the real flush; GitHub is the in-memory model
// (`_fake_github.js`), whose validate and merge use the real immutable-change gate. Nothing reaches the network or a real account.
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { cardFile, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import * as outbox from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { readTriageBasis } from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"
import { validateTriageBytes } from "../../../../../plugins/desk/mcp/src/factory/triage-schema.js"
import { triagePaths } from "../../../../../plugins/desk/mcp/src/factory/triage-state.js"
import { runTriageStep } from "../../../../../plugins/desk/mcp/src/factory/triage-step.js"
import { publishOwnedTriage } from "../../../../../plugins/desk/mcp/src/factory/triage-write.js"
import { fakeGitHub, httpError } from "./_fake_github.js"
import { KEYS, NEEDS_PREPARED_RUN, STORE, git, pushDesk, qualifiedSeams, remoteJson, resolveIssue, triageWorld } from "./_triage_world.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/factory/triage-outbox.js", import.meta.url)
async function load() {
  assert.ok(existsSync(moduleUrl), "the triage outbox module must exist")
  return import(moduleUrl)
}

// The triage outbox readers are new with this module: read through the namespace, so a Desk without them fails the module check above, not the import.
const { gitBlobSha, readConsent, readStatus, setConsent, writeLocalFacts, writeMarker, writeStatus } = outbox
const readTriageOutbox = (...args) => outbox.readTriageOutbox(...args)
const updateTriageOutbox = (...args) => outbox.updateTriageOutbox(...args)

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const T0 = Date.parse("2026-10-12T01:00:00.000Z")
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const READY = "{\"triage\":1}\n"
const ACCOUNT = "someone"
const KEY = KEYS[0]
const ISSUE_REPO = "example-org/example-repo"
const hex = (bytes) => randomBytes(bytes).toString("hex")
const issueOf = (key) => ({ kind: "issue", ref: `https://github.com/${ISSUE_REPO}/issues/${key.split("#")[1]}`, revision: 3 })

/** A triage world whose desk declares the store as its route, as a desk that reports there does. */
async function world({ keys = [KEY], route = STORE } = {}) {
  const w = await triageWorld({ now: new Date(T0), keys })
  if (route !== null) await declareRoute(w, route)
  return w
}

async function declareRoute(w, store) {
  await fs.mkdir(path.join(w.deskRoot, "_meta"), { recursive: true })
  await fs.writeFile(path.join(w.deskRoot, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
  pushDesk(w, "route")
}

const github = (options = {}) => fakeGitHub({ store: STORE, account: ACCOUNT, triageJson: READY, visibility: { [ISSUE_REPO]: "public" }, ...options })
const run = (w, hub, now, extra = {}) => flush(w.env, { store: STORE, runner: hub.runner, anonymousLookup: hub.anonymousLookup, now: () => now, ...extra })
const state = (w) => readTriageOutbox(w.env, STORE, "state.json")
const record = (w, batch) => readTriageOutbox(w.env, STORE, `${batch}.json`)
const registry = (w) => remoteJson(w.origin, triagePaths(w.deskRoot, "", KEY).registry)
const annotationOf = (w, key = KEY) => remoteJson(w.origin, triagePaths(w.deskRoot, "", key).annotation)
const branchOf = async (w) => `intake/${(await readConsent(w.env)).stores[STORE].intake_id}`
const triageFiles = (files) => [...(files ?? [])].filter(([name]) => name.startsWith("triage/"))
const headTriage = async (w, hub, repo = STORE) => triageFiles(hub.headFiles(repo, await branchOf(w)))
const mainTriage = (hub) => triageFiles(hub.mainFiles())
const apiCalls = (hub, pattern) => hub.calls.filter((call) => call.args[0] === "api" && pattern.test(call.args.find((arg) => /^repos\//u.test(arg)) ?? ""))

/** One review of `key` written through the real writer, noted in the triage outbox exactly as the triage step notes its own writes. */
async function review(w, key = KEY, { now = T0, route = "investigate" } = {}) {
  const { beginTriageEmission, settleTriageEmission } = await load()
  const read = await readTriageBasis({ deskRoot: w.deskRoot, personPrefix: "", key, now: new Date(now), evidence: { resolve: resolveIssue }, env: w.env })
  assert.equal(read.state, "ready", JSON.stringify(read.state))
  const human = route === "human_decision"
  const safe = {
    route, gate: human ? "intent" : null, authority_code: human ? "human_gate" : "investigation_only",
    summary_codes: ["source:andon", `route:${route}`, ...(human ? ["gate:intent"] : [])], evidence: [issueOf(key)], related_keys: [], duplicate_keys: [],
    producer_version: read.basis.producer_version, rubric_version: read.basis.rubric_version, protected_result: hex(16),
  }
  const noted = await beginTriageEmission(w.env, { store: STORE, key, deskRoot: w.deskRoot, personPrefix: "" })
  const written = await publishOwnedTriage({ env: w.env, deskRoot: w.deskRoot, personPrefix: "", key, store: STORE, expectedBasis: read.basis, review: safe, operation: "review", now: new Date(now), evidence: { resolve: resolveIssue } })
  await settleTriageEmission(w.env, { store: STORE, key, written, prior: noted.prior, now })
  assert.equal(written.state, "acknowledged", JSON.stringify(written))
  return written
}

/** The triage step on a host that cannot run the runner: the mechanical refresh, its writes, and the coverage and runner state a batch says. */
const step = (w, now = T0, seams = {}) => runTriageStep(w.env, {
  deskRoot: w.deskRoot, personPrefix: "", pluginVersion: "9.9.9", now: new Date(now), deadline: new Date(Date.now() + 20 * 60 * 1000), generation: "gen-1",
  impls: { hostSupport: async () => ({ provenance: false }), evidence: { resolve: resolveIssue }, ...seams },
})

/** A reviewed, acknowledged card and a recorded scan: everything a first publication needs on the desk side. */
async function reviewedWorld(options = {}) {
  const w = await world(options)
  const written = await review(w)
  const stepped = await step(w)
  assert.equal(stepped.result, "runner_unavailable", JSON.stringify(stepped))
  return { w, written }
}

async function putFacts(w, n = 1) {
  const facts = structuredClone(GOLDEN)
  facts.session.id = `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
  facts.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  const written = await writeLocalFacts(w.env, STORE, facts)
  assert.equal(written.written, true, JSON.stringify(written))
  await writeStatus(w.env, { derivations: { [written.name]: { store: STORE, checked_route: STORE } } })
  return written.name
}

const batchValue = (hub, sha) => JSON.parse(hub.blobText(sha))

test("an acknowledged review is published once, through the intake pull request, and delivered only from the default branch", async () => {
  const { w, written } = await reviewedWorld()
  const hub = github()
  const first = await run(w, hub, T0 + HOUR)
  assert.equal(first.result, "delivered_pr_open", JSON.stringify(first))
  const [[file, sha]] = await headTriage(w, hub)
  const value = batchValue(hub, sha)
  assert.equal(validateTriageBytes(hub.blobText(sha)).ok, true)
  assert.equal(file, `triage/${value.batch}.json`)
  // The row is the acknowledged registry's ID and revision, the review's closed codes and the one public pointer.
  assert.deepEqual(value.rows, [{
    id: written.id, revision: 1, state: "reviewed", source: "andon", lifecycle: "open", ownership: "not_published", route: "investigate", gate: null,
    evidence: [issueOf(KEY)], basis: { generation: annotationOf(w).basis.generation, evidence_revisions: [issueOf(KEY)] }, related_ids: [], duplicate_ids: [],
    age: "recent", producer_version: annotationOf(w).review.producer_version, rubric_version: 1,
  }])
  assert.equal(registry(w).entries[0].id, written.id)
  assert.deepEqual(value.coverage, { generation: (await state(w)).coverage.generation, scan: "complete", reviewed: 1, unreviewed: 0, refused: null, deferred: null, more_unreviewed: false })
  assert.deepEqual(value.runner, { state: "unsupported_host", last_success_age: "never" })
  // Nothing of the desk beyond that: no canonical key, no path, no token, no account.
  const text = hub.blobText(sha)
  for (const secret of [KEY, w.deskRoot, annotationOf(w).review.protected_result, annotationOf(w).basis.protected_basis, annotationOf(w).basis.canonical_revision, ACCOUNT]) assert.ok(!text.includes(secret), `${secret} reached the store`)
  // Pushed is not delivered.
  let kept = await state(w)
  assert.deepEqual([kept.pending, kept.emitted, Object.keys(kept.requests), kept.pr], [[value.batch], {}, [KEY], first.pr.number])
  assert.deepEqual([(await record(w, value.batch)).state, (await record(w, value.batch)).pr], ["pending", first.pr.number])
  assert.equal(hub.pulls.at(-1).body, "1", "the pull request counts the batch as its one file")
  // The store's trusted validate and merge accept it; the next flush reads the default branch and settles.
  assert.equal(hub.settleOpenPr().merged, true)
  assert.deepEqual(await run(w, hub, T0 + 2 * HOUR), { result: "nothing_pending" })
  kept = await state(w)
  assert.deepEqual([kept.pending, kept.emitted, kept.requests], [[], { [written.id]: 1 }, {}])
  const delivered = await record(w, value.batch)
  assert.deepEqual([delivered.state, delivered.bytes, delivered.rows], ["delivered", undefined, [{ id: written.id, revision: 1 }]])
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE], { at: new Date(T0 + 2 * HOUR).toISOString(), pending: 0, waiting: 0, delivered_at: new Date(T0 + 2 * HOUR).toISOString(), scan: "complete" })
  // Settled: a later flush has nothing to ask the store.
  const calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 3 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
})

test("publication_failure_keeps_pending", async () => {
  const { w, written } = await reviewedWorld()
  const facts = await putFacts(w)
  const hub = github()
  const pendingBatch = async () => {
    const kept = await state(w)
    assert.equal(kept.pending.length, 1, JSON.stringify(kept))
    assert.deepEqual(kept.emitted, {}, "nothing is delivered")
    assert.equal((await record(w, kept.pending[0])).state, "pending")
    return kept.pending[0]
  }
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  const batch = await pendingBatch()
  const [[file, sha]] = await headTriage(w, hub)
  assert.equal(file, `triage/${batch}.json`)
  assert.equal(hub.pulls.at(-1).body, "2", "one facts file and one batch")

  // The deadline passes before the store answers: nothing is delivered.
  assert.deepEqual(await run(w, hub, T0 + HOUR, { deadlineMs: 0 }), { result: "deadline" })
  await pendingBatch()

  // The store's own check could not run: its failure, not the batch's. Everything goes again at once, byte for byte.
  hub.rejectOpenPr("factory-rejected: triage_authority_check_unavailable")
  const retried = await run(w, hub, T0 + 2 * HOUR)
  assert.deepEqual([retried.result, retried.stale_retries], ["intake_stale_retried", 1])
  assert.deepEqual(await headTriage(w, hub), [[file, sha]])
  assert.equal((await state(w)).held, undefined)

  // Someone closes the pull request with no word from the store: the batch is still pending and goes again.
  hub.pulls.at(-1).state = "closed"
  assert.equal((await run(w, hub, T0 + 3 * HOUR)).result, "delivered_pr_open")
  assert.deepEqual(await headTriage(w, hub), [[file, sha]])
  await pendingBatch()

  // The intake branch is force-pushed away: the next flush rebuilds it from what is pending.
  hub.dropBranch(STORE, await branchOf(w))
  assert.equal((await run(w, hub, T0 + 4 * HOUR)).result, "delivered_pr_open")
  assert.deepEqual(await headTriage(w, hub), [[file, sha]])
  await pendingBatch()

  // The store's intake refuses the batch. The facts beside it are not blamed, and the batch waits a day.
  hub.rejectOpenPr("factory-rejected: triage_batch_mismatch")
  const refused = await run(w, hub, T0 + 5 * HOUR)
  assert.deepEqual([refused.result, refused.stale_retries], ["intake_stale_retried", 1])
  assert.deepEqual(await headTriage(w, hub), [], "the facts go again without the batch")
  assert.ok(hub.headFiles(STORE, await branchOf(w)).has(`facts/${facts}`))
  const held = await state(w)
  assert.deepEqual([held.held, held.pr], [{ code: "triage_batch_mismatch", until: new Date(T0 + 5 * HOUR + DAY).toISOString() }, undefined])
  await pendingBatch()
  assert.equal((await readStatus(w.env)).triage_publication[STORE].held, "triage_batch_mismatch")
  // A plain schema code on the pull request that carried a batch names the batch too, not the facts.
  hub.mergeOpenPr()
  assert.equal((await run(w, hub, T0 + 5 * HOUR + DAY)).result, "delivered_pr_open")
  assert.deepEqual(await headTriage(w, hub), [[file, sha]], "the same immutable bytes after the day")
  hub.rejectOpenPr("factory-rejected: canonical")
  assert.equal((await run(w, hub, T0 + 6 * HOUR + DAY)).result, "nothing_pending")
  assert.equal((await state(w)).held.code, "canonical")
  assert.deepEqual((await readStatus(w.env)).last_flush[STORE].result, "nothing_pending")
  await pendingBatch()

  // Only the exact blob on the trusted default branch delivers.
  assert.equal((await run(w, hub, T0 + 7 * HOUR + 2 * DAY)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  assert.deepEqual(mainTriage(hub), [[file, sha]])
  assert.deepEqual(await run(w, hub, T0 + 8 * HOUR + 2 * DAY), { result: "nothing_pending" })
  assert.deepEqual([(await state(w)).pending, (await state(w)).emitted], [[], { [written.id]: 1 }])
})

test("batch_collision_and_idempotent_retry", async () => {
  const { triageBatchDisposition, stageTriageBatch } = await load()
  const bytes = Buffer.from("{\"a\":1}\n")
  const at = "triage/0123456789abcdef.json"
  assert.equal(triageBatchDisposition({ path: at, bytes }), "add")
  assert.equal(triageBatchDisposition({ path: at, bytes, remoteBytes: Buffer.from(bytes) }), "already_acknowledged")
  assert.equal(triageBatchDisposition({ path: at, bytes, remoteBytes: bytes.toString("utf8") }), "already_acknowledged")
  assert.equal(triageBatchDisposition({ path: at, bytes, remoteSha: gitBlobSha(bytes) }), "already_acknowledged")
  assert.equal(triageBatchDisposition({ path: at, bytes, remoteBytes: "{\"a\":2}\n" }), "collision")
  assert.equal(triageBatchDisposition({ path: at, bytes, remoteSha: "f".repeat(40) }), "collision")
  assert.equal(triageBatchDisposition({ path: at, bytes, remoteBytes: null }), "unknown", "a read that could not say")
  assert.equal(triageBatchDisposition({ path: at, bytes, remoteSha: null }), "unknown")
  assert.equal(triageBatchDisposition({ path: "facts/x.json", bytes }), "unknown")
  assert.equal(triageBatchDisposition({ bytes }), "unknown")

  const { w, written } = await reviewedWorld()
  const first = github()
  assert.equal((await run(w, first, T0 + HOUR)).result, "delivered_pr_open")
  const [[file, sha]] = await headTriage(w, first)
  const staged = first.blobText(sha)
  const batch = path.posix.basename(file, ".json")

  // A listing of the default branch that cannot say holds the batch: no change is sent on a guess.
  const blind = github()
  blind.setTruncated(() => true)
  await run(w, blind, T0 + 2 * HOUR)
  assert.deepEqual(await headTriage(w, blind), [])
  assert.deepEqual([(await state(w)).held.code, (await state(w)).pending], ["triage_main_unknown", [batch]])

  // The path holds other bytes on the default branch: the staged batch is never sent as a change to it. The same rows go under a fresh random batch ID.
  const other = `${JSON.stringify({ ...JSON.parse(staged), rows: [] })}\n`
  const collided = github({ mainTriage: { [`${batch}.json`]: other } })
  assert.equal((await run(w, collided, T0 + 2 * HOUR + DAY)).result, "delivered_pr_open")
  const head = new Map(await headTriage(w, collided))
  assert.equal(head.get(file), gitBlobSha(other), "the existing file is untouched")
  assert.equal(head.size, 2)
  const [[fresh, freshSha]] = [...head].filter(([name]) => name !== file)
  const again = batchValue(collided, freshSha)
  assert.notEqual(again.batch, batch)
  assert.deepEqual({ ...again, batch }, JSON.parse(staged), "the same rows, coverage and runner")
  assert.deepEqual([(await record(w, batch)).state, (await record(w, batch)).replaced_by, (await state(w)).pending, (await state(w)).requests[KEY].batch], ["replaced", again.batch, [again.batch], again.batch])
  // The store's gate sees one added file and no modification.
  assert.equal(collided.settleOpenPr().merged, true)

  // The exact bytes are already on the default branch (the merge above, read by another flush): an acknowledged no-op, with nothing pushed.
  const settled = github({ mainTriage: { [`${again.batch}.json`]: collided.blobText(freshSha) } })
  assert.deepEqual(await run(w, settled, T0 + 3 * HOUR + DAY), { result: "nothing_pending" })
  assert.equal(settled.pullCount(), 0)
  assert.deepEqual([(await state(w)).pending, (await state(w)).emitted, (await state(w)).requests], [[], { [written.id]: 1 }, {}])

  // Staging is idempotent and never overwrites: the same projection again is the record that exists, other bytes for its batch are a conflict.
  const projection = { path: fresh, bytes: Buffer.from(collided.blobText(freshSha)), sha: freshSha }
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection }), { state: "exists", path: fresh, sha: freshSha })
  assert.deepEqual((await state(w)).pending, [], "a delivered batch is not pending again")
  const changed = Buffer.from(`${JSON.stringify({ ...again, rows: [] })}\n`)
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection: { path: fresh, bytes: changed, sha: gitBlobSha(changed) } }), { state: "conflict" })
  assert.equal((await record(w, again.batch)).sha, freshSha)
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection: { path: fresh, bytes: changed, sha: freshSha } }), { state: "invalid" }, "a blob ID that is not the bytes'")
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection: { path: "triage/ffffffffffffffff.json", bytes: changed, sha: gitBlobSha(changed) } }), { state: "invalid" }, "a path that is not the batch's")
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection: { held: "unacknowledged" } }), { state: "invalid" })
  const lone = Buffer.from(`${JSON.stringify({ ...again, batch: "00000000000000aa", rows: [] })}\n`)
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection: { path: "triage/00000000000000aa.json", bytes: lone.toString("utf8"), sha: gitBlobSha(lone) }, now: T0 }), { state: "staged", path: "triage/00000000000000aa.json", sha: gitBlobSha(lone) })
  assert.deepEqual([(await state(w)).pending, (await record(w, "00000000000000aa")).staged_at], [["00000000000000aa"], new Date(T0).toISOString()])
})

test("complete removal publishes a withdrawal in a new batch, a truncated scan says so, and an old batch cannot restore", async () => {
  const { planTriage } = await load()
  const { w, written } = await reviewedWorld()
  const hub = github()
  await run(w, hub, T0 + HOUR)
  const [[oldFile, oldSha]] = await headTriage(w, hub)
  hub.settleOpenPr()
  await run(w, hub, T0 + 2 * HOUR)

  // The card is removed on a complete read: the step withdraws the annotation, acknowledged at a higher revision.
  await fs.unlink(cardFile(w.deskRoot, "", KEY))
  pushDesk(w, "remove the card")
  assert.equal((await step(w, T0 + 3 * HOUR)).result, "runner_unavailable")
  assert.deepEqual([annotationOf(w).attempt.state, annotationOf(w).revision], ["withdrawn", 2])
  assert.equal((await run(w, hub, T0 + 4 * HOUR)).result, "delivered_pr_open")
  const added = (await headTriage(w, hub)).filter(([name]) => name !== oldFile)
  assert.equal(added.length, 1)
  const withdrawal = batchValue(hub, added[0][1])
  assert.deepEqual(withdrawal.rows.map((row) => [row.id, row.revision, row.state, row.route, row.gate, row.lifecycle, row.evidence]), [[written.id, 2, "withdrawn", null, null, null, []]])
  assert.deepEqual([withdrawal.coverage.reviewed, withdrawal.coverage.unreviewed], [0, 0])
  // The old transport file is immutable: the same blob before and after the withdrawal merges.
  assert.equal(hub.settleOpenPr().merged, true)
  assert.deepEqual(new Map(mainTriage(hub)).get(oldFile), oldSha)
  assert.equal(mainTriage(hub).length, 2)
  await run(w, hub, T0 + 5 * HOUR)
  assert.deepEqual((await state(w)).emitted, { [written.id]: 2 })

  // A late request for the old revision is dropped, not staged: revision 1 can never follow revision 2.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", revision: 1, at: new Date(T0).toISOString() } } }))
  const plan = await planTriage(w.env, { store: STORE, now: T0 + 6 * HOUR })
  assert.deepEqual([plan.work, plan.candidates, plan.state.requests], [false, [], {}])

  // A write of this machine that never settled is not published, even when an annotation of that card is on the remote's main: it
  // may be another machine's revision. It waits until a write of this machine settles with the revision it saw acknowledged.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", intent: true } } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 6 * HOUR })).held, { triage_unacknowledged: 1 })
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", intent: true, revision: 1 } } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 6 * HOUR })).held, { triage_unacknowledged: 1 }, "a later revision while a write is unsettled")
  // Settled at revision 1 with revision 2 on the remote: revision 2 is another write's, and this request has nothing left.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, emitted: {}, requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", revision: 1 } } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 6 * HOUR })).state.requests, {})
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, emitted: { [written.id]: 2 } }))

  // A truncated card scan: the step withdraws nothing, and the next batch carries the scan's state with no counts and no rows.
  const truncated = async (options) => ({ ...(await readCards(options)), truncated: true })
  await step(w, T0 + 7 * HOUR, { readCards: truncated })
  assert.equal((await readStatus(w.env)).triage.coverage.scan, "truncated")
  assert.equal((await run(w, hub, T0 + 8 * HOUR)).result, "delivered_pr_open")
  const scanBatch = batchValue(hub, (await headTriage(w, hub)).filter(([name]) => !new Map(mainTriage(hub)).has(name))[0][1])
  assert.deepEqual([scanBatch.rows, scanBatch.coverage.scan, scanBatch.coverage.reviewed, scanBatch.coverage.unreviewed, scanBatch.coverage.more_unreviewed], [[], "truncated", null, null, null])
  assert.notEqual(scanBatch.coverage.generation, withdrawal.coverage.generation)
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 9 * HOUR)
  assert.equal((await readStatus(w.env)).triage_publication[STORE].scan, "truncated")
  // The same scan state again is nothing new to say.
  await step(w, T0 + 10 * HOUR, { readCards: truncated })
  const calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 11 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
})

test("untrusted_account_cannot_emit_triage", async () => {
  const { w, written } = await reviewedWorld()
  const facts = await putFacts(w)
  // The account cannot push to the store. Its facts still go through its fork, as before; triage does not.
  const visibility = {}
  const hub = github({ push: false, fork: "ready", visibility })
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.ok(hub.headFiles(hub.forkName, await branchOf(w)).has(`facts/${facts}`))
  assert.deepEqual(await headTriage(w, hub, hub.forkName), [])
  let kept = await state(w)
  assert.deepEqual([kept.held.code, kept.pending, Object.keys(kept.requests)], ["triage_untrusted_account", [], [KEY]])
  assert.equal(apiCalls(hub, /contents\/triage\.json/u).length, 0, "an untrusted account does not even ask")
  hub.mergeOpenPr()

  // The account is granted push and publishes; then the grant is withdrawn before the store's trusted check reads the actor's
  // permission. The first assignment of an ID from a producer the store does not trust is refused there, whatever the file says,
  // and so is a row with no public issue (the issue's repository is not known public, so the row names none).
  hub.setPush(true)
  assert.equal((await run(w, hub, T0 + HOUR + DAY)).result, "delivered_pr_open")
  const [[file, sha]] = await headTriage(w, hub)
  assert.deepEqual(batchValue(hub, sha).rows.map((row) => [row.id, row.revision, row.evidence]), [[written.id, 1, []]])
  hub.setPush(false)
  assert.deepEqual([hub.settleOpenPr().merged, mainTriage(hub)], [false, []])
  assert.match(hub.pulls.at(-1).state, /closed/u)
  hub.setPush(true)
  await run(w, hub, T0 + 2 * HOUR + DAY)
  kept = await state(w)
  assert.deepEqual([kept.held.code, kept.pending.length, kept.emitted], ["triage_untrusted_producer", 1, {}], "refused is not delivered")
  // Trusted again, a day later: the same bytes are accepted.
  assert.equal((await run(w, hub, T0 + 3 * HOUR + 2 * DAY)).result, "delivered_pr_open")
  assert.deepEqual(await headTriage(w, hub), [[file, sha]])
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 4 * HOUR + 2 * DAY)
  assert.deepEqual((await state(w)).emitted, { [written.id]: 1 })

  // A higher revision of an accepted ID from an untrusted producer is refused the same way: it cannot pass as the acknowledged one.
  visibility[ISSUE_REPO] = "public"
  const text = await fs.readFile(cardFile(w.deskRoot, "", KEY), "utf8")
  await fs.writeFile(cardFile(w.deskRoot, "", KEY), text.replace(/^recurrences: .*$/mu, "recurrences: 7"))
  pushDesk(w, "the card changed")
  await step(w, T0 + 5 * HOUR + 2 * DAY)
  assert.deepEqual([annotationOf(w).attempt.state, annotationOf(w).revision], ["stale", 2])
  assert.equal((await run(w, hub, T0 + 6 * HOUR + 2 * DAY)).result, "delivered_pr_open")
  const higher = (await headTriage(w, hub)).filter(([name]) => name !== file)
  assert.deepEqual(batchValue(hub, higher[0][1]).rows.map((row) => [row.id, row.revision, row.state, row.route, row.evidence]), [[written.id, 2, "stale", "investigate", [issueOf(KEY)]]])
  hub.setPush(false)
  assert.equal(hub.settleOpenPr().code, "triage_untrusted_producer")
  assert.deepEqual(mainTriage(hub), [[file, sha]], "the default branch still holds only the trusted revision")
  hub.setPush(true)
  await run(w, hub, T0 + 7 * HOUR + 2 * DAY)
  assert.deepEqual([(await state(w)).held.code, (await state(w)).emitted, (await state(w)).pending.length], ["triage_untrusted_producer", { [written.id]: 1 }, 1])
  // The facts in those pull requests were never quarantined for the triage refusals.
  const status = await readStatus(w.env)
  assert.equal(status.last_flush[STORE].rejections_unmatched, undefined)
})

test("readiness_requires_exact_current_switch", async () => {
  const { readTriageReadiness } = await load()
  const { w } = await reviewedWorld()
  let now = T0 + HOUR
  // No switch, a malformed one, another value, an extra key: not ready. Nothing is sent, and the store is asked again only after a day.
  for (const triageJson of [null, "not json", "[1]", "{\"triage\":2}", "{\"triage\":\"1\"}", "{\"triage\":1,\"extra\":true}", "{}"]) {
    const hub = github({ triageJson })
    assert.deepEqual(await run(w, hub, now), { result: "nothing_pending" }, String(triageJson))
    assert.equal(hub.pullCount(), 0)
    assert.equal(apiCalls(hub, /contents\/triage\.json/u).length, 1)
    assert.deepEqual((await state(w)).held, { code: "triage_store_not_ready", until: new Date(now + DAY).toISOString() })
    const calls = hub.calls.length
    assert.deepEqual(await run(w, hub, now + DAY - 1), { result: "nothing_pending" })
    assert.equal(hub.calls.length, calls, "a cached negative answer costs no call")
    now += DAY
  }
  // An answer that is not the file: unknown, kept for a day the same way.
  for (const answer of [httpError(500, "Server Error"), { code: 0, stdout: JSON.stringify({ type: "dir" }), stderr: "" }]) {
    const hub = github({ intercept: (call) => (call.args.some((arg) => /contents\/triage\.json/u.test(arg)) ? answer : undefined) })
    assert.deepEqual(await run(w, hub, now), { result: "nothing_pending" })
    assert.equal((await state(w)).held.code, answer.code === 0 ? "triage_store_not_ready" : "triage_readiness_unknown")
    assert.deepEqual(await readTriageReadiness(w.env, { store: STORE, client: null, branch: "main", now: now + HOUR }), { state: answer.code === 0 ? "not_ready" : "unknown", cached: true })
    now += DAY
  }
  // The annotation was never forgotten: after the cached answer expires and the default branch proves the switch, it goes.
  assert.deepEqual([Object.keys((await state(w)).requests), (await state(w)).pending], [[KEY], []])
  const hub = github()
  assert.equal((await run(w, hub, now)).result, "delivered_pr_open")
  const [[file, sha]] = await headTriage(w, hub)
  assert.equal((await state(w)).held, undefined)
  const client = { api: async () => ({ status: 200, json: { encoding: "base64", content: Buffer.from(READY).toString("base64") } }) }
  assert.deepEqual(await readTriageReadiness(w.env, { store: STORE, client, branch: "main", now }), { state: "ready", blob: gitBlobSha(READY) })

  // The switch is removed while the batch waits in the open pull request: the very next flush reads it afresh and holds. The
  // pull request loses the batch; the pending batch and the acknowledged annotation stay.
  hub.setTriageJson(null)
  assert.deepEqual(await run(w, hub, now + HOUR), { result: "nothing_pending" })
  assert.equal(hub.pulls.at(-1).state, "closed")
  assert.deepEqual(triageFiles(hub.headFiles(STORE, await branchOf(w))), [])
  assert.deepEqual([(await state(w)).held.code, (await state(w)).pending.length], ["triage_store_not_ready", 1])
  assert.equal(annotationOf(w).attempt.state, "reviewed")
  // Switched back on inside the day: the cached removal still holds, with no call.
  hub.setTriageJson(READY)
  const calls = hub.calls.length
  assert.deepEqual(await run(w, hub, now + 2 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
  // After the day, fresh proof from the default branch releases the same bytes.
  assert.equal((await run(w, hub, now + HOUR + DAY)).result, "delivered_pr_open")
  assert.deepEqual(await headTriage(w, hub), [[file, sha]])
})

test("route-back retains the consent, routing and identity gates", async () => {
  const { planTriage, readAcknowledged, beginTriageEmission, settleTriageEmission } = await load()
  // The desk declares no route of its own and no session recorded one: its triage is not this store's to receive.
  const { w, written } = await reviewedWorld({ route: null })
  const hub = github()
  const offline = async (now, code) => {
    const calls = hub.calls.length
    assert.deepEqual(await run(w, hub, now), { result: "nothing_pending" })
    assert.equal(hub.calls.length, calls, "held locally: the store is not asked")
    assert.deepEqual((await readStatus(w.env)).triage_publication[STORE].held_requests, { [code]: 1 })
  }
  await offline(T0 + HOUR, "triage_route_elsewhere")
  // A session hook recorded another store for this desk, then this one: the newest record decides.
  const marker = (n, store, updated) => writeMarker(w.env, {
    schema_version: 1, host: "claude-code", session_id: `0000000${n}-0000-4000-8000-000000000000`, log_path: path.join(w.base, `log-${n}.jsonl`), cwd: w.deskRoot, desk_root: w.deskRoot, end_reason: null, ended_at: null,
    plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date(Date.now() - updated).toISOString(), routing: { store, source: "overlay", warnings: [] },
  })
  await marker(1, "example-org/another-store", 1000)
  await offline(T0 + HOUR, "triage_route_elsewhere")
  await marker(2, STORE, 0)
  await marker(3, STORE, 5000)
  assert.equal((await planTriage(w.env, { store: STORE, now: T0 + HOUR })).candidates.length, 1)
  // The desk declares another store: held again, whatever a session recorded.
  await declareRoute(w, "example-org/another-store")
  await offline(T0 + 2 * HOUR, "triage_route_elsewhere")
  // Routed back: the gates that held before still hold. Consent first.
  await declareRoute(w, STORE)
  await setConsent(w.env, { store: STORE, contribute: false, account: ACCOUNT })
  assert.deepEqual(await run(w, hub, T0 + 3 * HOUR), { result: "not_opted_in" })
  assert.equal(hub.calls.length, 0)
  await setConsent(w.env, { store: STORE, contribute: true, account: ACCOUNT })

  // Identity: only what the remote's main holds is published. A local commit that rewrites the annotation is not it.
  const paths = triagePaths(w.deskRoot, "", KEY)
  const local = { ...annotationOf(w), revision: 9 }
  await fs.writeFile(path.join(w.deskRoot, ...paths.annotation.split("/")), `${JSON.stringify(local)}\n`)
  git(w.deskRoot, ["commit", "-q", "-am", "local only"])
  assert.equal(readAcknowledged({ deskRoot: w.deskRoot, personPrefix: "", key: KEY }).annotation.revision, 1)
  // A card this machine meant to write but whose push never reached the remote has no acknowledged annotation: it waits.
  const unpushed = KEYS[1]
  assert.deepEqual(await beginTriageEmission(w.env, { store: STORE, key: unpushed, deskRoot: w.deskRoot, personPrefix: "" }), { prior: false })
  await settleTriageEmission(w.env, { store: STORE, key: unpushed, written: { state: "unacknowledged", resources: [] }, prior: false, now: T0 })
  assert.deepEqual((await state(w)).requests[unpushed], { desk_root: w.deskRoot, person_prefix: "", intent: true })
  assert.equal(readAcknowledged({ deskRoot: w.deskRoot, personPrefix: "", key: unpushed }), null)
  assert.equal(readAcknowledged({ deskRoot: w.base, personPrefix: "", key: KEY }), null, "not a Git checkout with a remote main")
  assert.equal(readAcknowledged({ deskRoot: w.deskRoot, personPrefix: "not/a/prefix", key: KEY }), null)
  assert.equal(readAcknowledged({ deskRoot: w.deskRoot, personPrefix: "", key: "not a card key" }), null)
  const plan = await planTriage(w.env, { store: STORE, now: T0 + 4 * HOUR })
  assert.deepEqual([plan.candidates.map((candidate) => [candidate.key, candidate.annotation.revision]), plan.held], [[[KEY, 1]], { triage_unacknowledged: 1 }])
  assert.equal((await run(w, hub, T0 + 4 * HOUR)).result, "delivered_pr_open")
  const [[, sha]] = await headTriage(w, hub)
  assert.deepEqual(batchValue(hub, sha).rows.map((row) => [row.id, row.revision]), [[written.id, 1]])
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE].held_requests, { triage_unacknowledged: 1 })
})

test("the outbox notes only this machine's writes, and a row a revision cannot give waits for the next revision", async () => {
  const { beginTriageEmission, settleTriageEmission, recordTriageCoverage, planTriage, namesTriage } = await load()
  const w = await world({ keys: KEYS })
  const note = async (key, written, { begin = true } = {}) => {
    const noted = begin ? await beginTriageEmission(w.env, { store: STORE, key, deskRoot: w.deskRoot, personPrefix: "" }) : { prior: false }
    await settleTriageEmission(w.env, { store: STORE, key, written, prior: noted.prior, now: T0 })
    return (await state(w)).requests[key]
  }
  // A foreign or unknown state file reads as empty.
  await updateTriageOutbox(w.env, STORE, "state.json", () => ({ schema: "another/9", requests: { x: {} } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 })).state, { schema: "desk.factory.triage-outbox/1", requests: {}, pending: [], emitted: {} })
  // Results that wrote nothing leave nothing; an adopted annotation is another machine's unless this machine's own intent was left open.
  for (const stateName of ["stale_basis", "identity_conflict", "busy", "policy_refused", "write_failed", "adopted"]) assert.equal(await note(KEY, { state: stateName, revision: 4 }), undefined, stateName)
  assert.equal(await note(KEY, { state: "write_failed" }, { begin: false }), undefined, "a settle with no intent noted")
  assert.deepEqual(await note(KEY, { state: "unacknowledged" }), { desk_root: w.deskRoot, person_prefix: "", intent: true })
  assert.deepEqual(await note(KEY, { state: "adopted", revision: 4 }), { desk_root: w.deskRoot, person_prefix: "", revision: 4, at: new Date(T0).toISOString() }, "its own write, found again")
  // A failed later write keeps the acknowledged revision; a new acknowledged one replaces it and frees its batch and hold.
  assert.equal((await note(KEY, { state: "stale_basis" })).revision, 4)
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { ...current.requests[KEY], batch: "0123456789abcdef", held: { code: "identity_not_random", revision: 4 } } } }))
  assert.deepEqual(await note(KEY, { state: "acknowledged", revision: 5 }), { desk_root: w.deskRoot, person_prefix: "", revision: 5, at: new Date(T0).toISOString() })
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: {} }))

  // Coverage: counts only from a complete scan, refused and deferred from the last step that knew them, one generation while nothing changes.
  const cover = async (coverage, counts = {}, runner = null) => {
    await recordTriageCoverage(w.env, { store: STORE, coverage, counts, runner })
    return state(w)
  }
  const complete = { scan: "complete", reviewed: 2, unreviewed: 3, refused: null, deferred: null, more_unreviewed: true }
  let kept = await cover(complete)
  const { generation } = kept.coverage
  assert.deepEqual([kept.coverage, kept.runner_state], [{ generation, scan: "complete", reviewed: 2, unreviewed: 3, refused: null, deferred: null, more_unreviewed: true }, null])
  kept = await cover(complete, { reviewed: null, refused: null, deferred: null }, "not a state")
  assert.deepEqual([kept.coverage.generation, kept.runner_state], [generation, null], "nothing changed")
  kept = await cover(complete, { reviewed: 3, refused: 1, deferred: 2 }, "ran")
  assert.deepEqual([{ ...kept.coverage, generation: null }, kept.runner_state], [{ generation: null, scan: "complete", reviewed: 5, unreviewed: 0, refused: 1, deferred: 2, more_unreviewed: false }, "ran"])
  assert.notEqual(kept.coverage.generation, generation)
  kept = await cover(complete, {}, null)
  assert.deepEqual([kept.coverage.refused, kept.coverage.deferred, kept.runner_state], [1, 2, "ran"], "the last known run counts and runner state stay")
  kept = await cover({ scan: "unreadable", reviewed: null, unreviewed: null, refused: null, deferred: null, more_unreviewed: null }, { reviewed: 1 })
  assert.deepEqual({ ...kept.coverage, generation: null }, { generation: null, scan: "unreadable", reviewed: null, unreviewed: null, refused: null, deferred: null, more_unreviewed: null })
  kept = await cover({ scan: "complete", reviewed: -1, unreviewed: 1.5 })
  assert.deepEqual([kept.coverage.reviewed, kept.coverage.unreviewed, kept.coverage.more_unreviewed], [null, null, null], "a count that is not a count is not known")

  // Which refusals name triage.
  const stale = { has: (code) => code.endsWith("_check_unavailable") }
  assert.equal(namesTriage("triage_immutable", { onTriagePr: false, stale }), true)
  assert.equal(namesTriage("schema", { onTriagePr: true, stale }), true)
  assert.equal(namesTriage("schema", { onTriagePr: false, stale }), false)
  assert.equal(namesTriage("triage_authority_check_unavailable", { onTriagePr: true, stale }), false)

  // Three reviewed cards. One has an ID that is a digest of its key: that row is never built, the others are published without it.
  for (const key of KEYS) await review(w, key, { route: key === KEYS[1] ? "human_decision" : "investigate" })
  await step(w)
  const hub = github()
  const { createHash } = await import("node:crypto")
  const paths = triagePaths(w.deskRoot, "", KEY)
  git(w.deskRoot, ["pull", "-q", "--rebase", "origin", "main"])
  const tampered = registry(w)
  tampered.entries = tampered.entries.map((entry) => (entry.key === KEYS[2] ? { ...entry, id: createHash("sha256").update(entry.key).digest("hex").slice(0, 32) } : entry))
  await fs.writeFile(path.join(w.deskRoot, ...paths.registry.split("/")), `${JSON.stringify(tampered)}\n`)
  pushDesk(w, "a registry with a fingerprint for an ID")
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  const [[, sha]] = await headTriage(w, hub)
  const value = batchValue(hub, sha)
  assert.deepEqual(value.rows.map((row) => [row.route, row.gate]).sort(), [["human_decision", "intent"], ["investigate", null]])
  kept = await state(w)
  assert.deepEqual(kept.requests[KEYS[2]].held, { code: "identity_not_random", revision: 1 })
  assert.deepEqual([kept.requests[KEYS[0]].batch, kept.requests[KEYS[1]].batch], [value.batch, value.batch])
  // The held row is not tried again while the annotation stays at that revision.
  const plan = await planTriage(w.env, { store: STORE, now: T0 + 2 * HOUR })
  assert.deepEqual([plan.candidates, plan.held, plan.work], [[], { identity_not_random: 1 }, true])
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE], { at: new Date(T0 + 2 * HOUR).toISOString(), pending: 1, waiting: 1, held_requests: { identity_not_random: 1 }, scan: "complete" })

  // The protected batch record is lost before the store merges: nothing claims delivery, and its rows are staged again.
  await updateTriageOutbox(w.env, STORE, `${value.batch}.json`, () => ({ schema: "desk.factory.triage-batch/1", state: "delivered" }))
  await run(w, hub, T0 + 3 * HOUR)
  assert.deepEqual([(await state(w)).pending, (await state(w)).emitted], [[], {}])
  assert.equal((await run(w, hub, T0 + 4 * HOUR)).result, "delivered_pr_open")
  assert.equal((await state(w)).pending.length, 1)
  assert.notEqual((await state(w)).pending[0], value.batch)
})

test("a listing names only triage batch files, and a batch whose every row is held stages nothing", async () => {
  const { triageOnBranch } = await load()
  const trees = new Map([
    ["root", new Map([["triage", { type: "tree", sha: "dir" }]])],
    ["dir", new Map([["0123456789abcdef.json", { type: "blob", sha: "1".repeat(40) }], ["notes.md", { type: "blob", sha: "2".repeat(40) }], ["fedcba9876543210.json", { type: "tree", sha: "3".repeat(40) }]])],
    ["empty", new Map([["triage", { type: "blob", sha: "4".repeat(40) }]])],
  ])
  const read = async (sha) => trees.get(sha)
  assert.deepEqual(await triageOnBranch(read, "root"), new Map([["triage/0123456789abcdef.json", "1".repeat(40)]]))
  assert.deepEqual(await triageOnBranch(read, "empty"), new Map())

  // The only acknowledged row has an ID that is a fingerprint of its key: no batch, no pull request, and the row waits for its next revision.
  const { createHash } = await import("node:crypto")
  const { w } = await reviewedWorld()
  git(w.deskRoot, ["pull", "-q", "--rebase", "origin", "main"])
  const paths = triagePaths(w.deskRoot, "", KEY)
  const tampered = registry(w)
  tampered.entries = tampered.entries.map((entry) => ({ ...entry, id: createHash("sha256").update(entry.key).digest("hex").slice(0, 32) }))
  await fs.writeFile(path.join(w.deskRoot, ...paths.registry.split("/")), `${JSON.stringify(tampered)}\n`)
  pushDesk(w, "a registry with a fingerprint for an ID")
  const hub = github()
  assert.deepEqual(await run(w, hub, T0 + HOUR), { result: "nothing_pending" })
  assert.equal(hub.pullCount(), 0)
  assert.deepEqual([(await state(w)).pending, (await state(w)).held, (await state(w)).requests[KEY].held], [[], undefined, { code: "identity_not_random", revision: 1 }])
})

test("a machine with no scan or runner state recorded holds its rows, and unknown store visibility holds the batch for a day", async () => {
  const { planTriage } = await load()
  const w = await world()
  await review(w)
  const hub = github()
  // No step has recorded a scan on this machine: there is no coverage to say.
  let plan = await planTriage(w.env, { store: STORE, now: T0 + HOUR })
  assert.deepEqual([plan.work, plan.held], [false, { triage_coverage_unknown: 1 }])
  // A scan, but no runner state yet: the step ended before it looked at the host.
  const { recordTriageCoverage } = await load()
  await recordTriageCoverage(w.env, { store: STORE, coverage: { scan: "complete", reviewed: 1, unreviewed: 0, more_unreviewed: false }, counts: {}, runner: null })
  plan = await planTriage(w.env, { store: STORE, now: T0 + HOUR })
  assert.deepEqual([plan.work, plan.held], [false, { triage_runner_unknown: 1 }])
  assert.deepEqual(await run(w, hub, T0 + HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, 0)
  await recordTriageCoverage(w.env, { store: STORE, coverage: { scan: "complete", reviewed: 1, unreviewed: 0, more_unreviewed: false }, counts: {}, runner: "no_agent_cli" })
  // The store's own visibility cannot be learned (its repository answer says neither public nor private): nothing is built.
  // The first answer about the store is the one that tells the flush its default branch; the visibility question after it is answered oddly.
  let asked = 0
  const odd = github({ intercept: (call) => (call.args.at(-1) === `repos/${STORE}` && (asked += 1) > 1 ? { code: 0, stdout: JSON.stringify({ full_name: STORE }), stderr: "" } : undefined) })
  assert.deepEqual(await run(w, odd, T0 + 2 * HOUR), { result: "nothing_pending" })
  assert.deepEqual([(await state(w)).held.code, (await state(w)).pending, Object.keys((await state(w)).requests)], ["triage_visibility_unknown", [], [KEY]])
  assert.equal((await run(w, hub, T0 + 2 * HOUR + DAY)).result, "delivered_pr_open")
  const [[, sha]] = await headTriage(w, hub)
  assert.deepEqual(batchValue(hub, sha).runner, { state: "no_agent_cli", last_success_age: "never" })
})

test("more than twenty acknowledged rows go in immutable batches of at most twenty", { timeout: 600000 }, async () => {
  const keys = Array.from({ length: 21 }, (_, index) => `andon:example-org/example-repo#${200 + index}`)
  const w = await world({ keys })
  for (const key of keys) await review(w, key)
  await step(w)
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  const sizes = (await headTriage(w, hub)).map(([, sha]) => batchValue(hub, sha).rows.length).sort((a, b) => a - b)
  assert.deepEqual(sizes, [1, 20])
  assert.equal(hub.pulls.at(-1).body, "2")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * HOUR)
  assert.equal(Object.keys((await state(w)).emitted).length, 21)
})

test("the triage step notes its own acknowledged reviews for publication", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await world({ keys: KEYS })
  const result = await runTriageStep(w.env, { deskRoot: w.deskRoot, personPrefix: "", pluginVersion: "9.9.9", now: new Date(T0), deadline: new Date(Date.now() + 20 * 60 * 1000), generation: "gen-1", impls: qualifiedSeams() })
  assert.equal(result.result, "ran", JSON.stringify(result))
  const kept = await state(w)
  assert.deepEqual(Object.keys(kept.requests).sort(), [...KEYS].sort())
  for (const key of KEYS) assert.deepEqual(kept.requests[key], { desk_root: w.deskRoot, person_prefix: "", revision: 1, at: kept.requests[key].at })
  assert.deepEqual([{ ...kept.coverage, generation: null }, kept.runner_state], [{ generation: null, scan: "complete", reviewed: 3, unreviewed: 0, refused: 0, deferred: 0, more_unreviewed: false }, "ran"])
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  const [[, sha]] = await headTriage(w, hub)
  const value = batchValue(hub, sha)
  assert.equal(value.rows.length, 3)
  assert.deepEqual(value.runner, { state: "ran", last_success_age: "recent" })
  assert.ok(!hub.blobText(sha).includes("PRIVATE"), "no protected result text")
})

test("an outbox the step cannot write never changes what an annotation write answers", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await world()
  // A file where the outbox folder belongs: every outbox write fails.
  const blocked = path.join(await outbox.factoryStateRoot(w.env), "triage-outbox")
  await fs.writeFile(blocked, "not a folder")
  const refresh = async () => ({ state: "complete", changes: [{ key: KEY, operation: "withdraw", reason: "card_removed" }], coverage: { scan: "complete", reviewed: 1, unreviewed: 0 } })
  let wrote = 0
  const result = await runTriageStep(w.env, { deskRoot: w.deskRoot, personPrefix: "", pluginVersion: "9.9.9", now: new Date(T0), deadline: new Date(Date.now() + 20 * 60 * 1000), generation: "gen-1", impls: qualifiedSeams({ refreshTriage: refresh, readTriageBasis: async () => ({ state: "card_missing", basis: {} }), publishOwnedTriage: async () => { wrote += 1; return { state: "acknowledged", revision: 2, resources: [] } }, hostSupport: async () => ({ provenance: false }) }) })
  assert.equal(wrote, 1)
  assert.equal((await readStatus(w.env)).triage.refresh.written, 1, JSON.stringify(result))
  assert.equal(await fs.readFile(blocked, "utf8"), "not a folder")
})
