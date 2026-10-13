// Triage publication through the flush: an acknowledged annotation of a synthetic desk becomes one immutable `triage/<batch>.json`
// in a fake store, and nothing marks it delivered but its exact bytes on the store's default branch. Real Git (a temporary bare
// remote and a clone), real cards, the real annotation writer and the real flush; GitHub is the in-memory model
// (`_fake_github.js`), whose validate and merge use the real immutable-change gate. Nothing reaches the network or a real account.
import { test } from "node:test"
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { randomBytes } from "node:crypto"
import nodeFs, { existsSync, promises as fs, readFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { cardFile, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import * as outbox from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { readTriageBasis } from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"
import { triageBatchOf } from "../../../../../plugins/desk/mcp/src/factory/triage-publish.js"
import { validateTriageBytes } from "../../../../../plugins/desk/mcp/src/factory/triage-schema.js"
import { triagePaths } from "../../../../../plugins/desk/mcp/src/factory/triage-state.js"
import { runTriageStep } from "../../../../../plugins/desk/mcp/src/factory/triage-step.js"
import { publishOwnedTriage } from "../../../../../plugins/desk/mcp/src/factory/triage-write.js"
import { triagePublicationHealth } from "../../../../../plugins/desk/mcp/src/factory/local-status.js"
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
const ATTEST = 2 * DAY
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
  const mark = { store: STORE, key, operation: "review", at: now }
  await beginTriageEmission(w.env, { ...mark, deskRoot: w.deskRoot, personPrefix: "" })
  const written = await publishOwnedTriage({ env: w.env, deskRoot: w.deskRoot, personPrefix: "", key, store: STORE, expectedBasis: read.basis, review: safe, operation: "review", now: new Date(now), evidence: { resolve: resolveIssue } })
  await settleTriageEmission(w.env, { ...mark, written })
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
const at = (ms) => new Date(ms).toISOString()
const stateFile = async (w) => path.join(await outbox.factoryStateRoot(w.env), "triage-outbox", STORE.replace("/", "__"), "state.json")
const contentsCalls = (hub) => apiCalls(hub, /contents\/triage\.json/u).length

/** `prepareTriage` on its own, as the flush calls it, against a store that is ready, lists nothing under `triage/` and knows every repository as public. */
async function prepare(w, now, extra = {}) {
  const { planTriage, prepareTriage } = await load()
  return prepareTriage(w.env, {
    store: STORE, plan: await planTriage(w.env, { store: STORE, now }), ref: "main", direct: true, consent: { contribute: true }, status: await readStatus(w.env), now,
    client: { api: async () => ({ status: 200, json: { type: "file", encoding: "base64", content: Buffer.from(READY).toString("base64") } }) },
    visibility: async (repos) => new Map(repos.map((repo) => [repo.toLowerCase(), "public"])),
    publishedJobs: () => new Set(),
    readMain: async () => ({ blobs: new Map(), unknown: false }),
    ...extra,
  })
}

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
  assert.deepEqual(value.coverage, { generation: (await state(w)).generation, scan: "complete", reviewed: 1, unreviewed: 0, refused: null, deferred: null, more_unreviewed: false })
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
  assert.deepEqual([delivered.state, delivered.bytes, delivered.rows], ["delivered", undefined, [{ id: written.id, revision: 1, desk_root: w.deskRoot, key: KEY, person_prefix: "" }]])
  // The delivered row is kept exactly as the store has it, to be sent again unchanged.
  assert.deepEqual(kept.rows, { [written.id]: { desk_root: w.deskRoot, key: KEY, person_prefix: "", revision: 1, row: value.rows[0], attested_at: new Date(T0 + 2 * HOUR).toISOString() } })
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE], { at: new Date(T0 + 2 * HOUR).toISOString(), pending: 0, waiting: 0, delivered_at: new Date(T0 + 2 * HOUR).toISOString(), coverage_known: false, scan: "complete", rows_oldest_at: new Date(T0 + 2 * HOUR).toISOString(), rows_held: 0 })
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
  assert.deepEqual([held.held, held.pr], [{ code: "triage_batch_mismatch", until: new Date(T0 + 5 * HOUR + DAY).toISOString(), since: new Date(T0 + 5 * HOUR).toISOString() }, undefined])
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
  assert.deepEqual([(await record(w, batch)).state, (await record(w, batch)).reason, (await record(w, batch)).bytes, (await state(w)).pending, (await state(w)).requests[KEY].batch], ["replaced", "collision", undefined, [again.batch], again.batch])
  // The store's gate sees one added file and no modification.
  assert.equal(collided.settleOpenPr().merged, true)

  // The exact bytes are already on the default branch (the merge above, read by another flush): an acknowledged no-op, with nothing pushed.
  const settled = github({ mainTriage: { [`${again.batch}.json`]: collided.blobText(freshSha) } })
  assert.deepEqual(await run(w, settled, T0 + 3 * HOUR + DAY), { result: "nothing_pending" })
  assert.equal(settled.pullCount(), 0)
  assert.deepEqual([(await state(w)).pending, (await state(w)).emitted, (await state(w)).requests], [[], { [written.id]: 1 }, {}])

  // Staging is idempotent and never overwrites: the same projection again is the record that exists, other bytes for its batch are a conflict.
  const projection = { path: fresh, bytes: Buffer.from(collided.blobText(freshSha)), sha: freshSha }
  const rowsOf = [{ id: written.id, revision: 1, desk_root: w.deskRoot, key: KEY, person_prefix: "" }]
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection, rows: rowsOf }), { state: "exists", path: fresh, sha: freshSha })
  assert.deepEqual(await stageTriageBatch(w.env, { store: STORE, projection }), { state: "invalid" }, "a row whose desk the record would not know")
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

  // A write of this machine that never settled is not published while the remote's main shows another write of that card: it
  // waits, and after three days with nothing of its own there the intent is dropped and the request with it.
  const meant = [{ at: new Date(T0 + 5 * HOUR).toISOString(), state: "reviewed" }]
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", intent: true, intended: meant } } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 6 * HOUR })).held, { triage_unacknowledged: 1 })
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", intent: true, intended: meant, revision: 1 } } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 6 * HOUR })).held, { triage_unacknowledged: 1 }, "a later revision while a write is unsettled")
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 5 * HOUR + 3 * DAY + 1 })).state.requests, {}, "never written: the later revision is another machine's")
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
  assert.equal(scanBatch.coverage.generation, withdrawal.coverage.generation, "one generation for the life of the source")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 9 * HOUR)
  assert.equal((await readStatus(w.env)).triage_publication[STORE].scan, "truncated")
  // The same scan state again is nothing new to say.
  await step(w, T0 + 10 * HOUR, { readCards: truncated })
  const calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 11 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
  // Two days on, no row is left to carry the coverage (the only one is withdrawn): a batch with no rows says it again, so the store
  // does not read this source as gone. Without a scan in the last three days there is nothing to say again.
  assert.deepEqual(await run(w, hub, T0 + 4 * DAY), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls, "no scan in three days")
  await step(w, T0 + 4 * DAY, { readCards: truncated })
  assert.equal((await run(w, hub, T0 + 4 * DAY + HOUR)).result, "delivered_pr_open")
  const alone = batchValue(hub, (await headTriage(w, hub)).filter(([name]) => !new Map(mainTriage(hub)).has(name))[0][1])
  assert.deepEqual([alone.rows, alone.coverage], [[], scanBatch.coverage])
  assert.notEqual(alone.batch, scanBatch.batch)
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
    assert.deepEqual((await state(w)).held, { code: "triage_store_not_ready", until: new Date(now + DAY).toISOString(), since: new Date(T0 + HOUR).toISOString() }, "held since the first time, without a break")
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
    assert.deepEqual(await readTriageReadiness(w.env, { store: STORE, client: null, ref: "main", now: now + HOUR }), { state: answer.code === 0 ? "not_ready" : "unknown", cached: true })
    now += DAY
  }
  // The annotation was never forgotten: after the cached answer expires and the default branch proves the switch, it goes.
  assert.deepEqual([Object.keys((await state(w)).requests), (await state(w)).pending], [[KEY], []])
  const hub = github()
  assert.equal((await run(w, hub, now)).result, "delivered_pr_open")
  const [[file, sha]] = await headTriage(w, hub)
  assert.equal((await state(w)).held, undefined)
  // The switch is read at the commit the flush builds on, never at a branch tip that may have moved since.
  const asked = apiCalls(hub, /contents\/triage\.json/u).at(-1).args.find((arg) => /contents\/triage\.json/u.test(arg))
  assert.match(asked, /\?ref=[0-9a-f]{40}$/u)
  const answering = (json) => ({ api: async () => ({ status: 200, json }) })
  const content = Buffer.from(READY).toString("base64")
  assert.deepEqual(await readTriageReadiness(w.env, { store: STORE, client: answering({ type: "file", encoding: "base64", content }), ref: "main", now }), { state: "ready", blob: gitBlobSha(READY) })
  // Only a regular file is the switch: a symbolic link with the same content is not.
  const linked = await world()
  assert.deepEqual(await readTriageReadiness(linked.env, { store: STORE, client: answering({ type: "symlink", encoding: "base64", content }), ref: "main", now }), { state: "not_ready" })

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
  const mark = { store: STORE, key: unpushed, operation: "review", at: T0 }
  assert.deepEqual(await beginTriageEmission(w.env, { ...mark, deskRoot: w.deskRoot, personPrefix: "" }), { prior: false })
  await settleTriageEmission(w.env, { ...mark, written: { state: "unacknowledged", resources: [] } })
  assert.deepEqual((await state(w)).requests[unpushed], { desk_root: w.deskRoot, person_prefix: "", since: new Date(T0).toISOString(), intent: true, intended: [{ at: new Date(T0).toISOString(), state: "reviewed" }] })
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
  // A store with no triage state has no plan, and none is made for it.
  assert.deepEqual([(await planTriage(w.env, { store: STORE, now: T0 })).work, await readTriageOutbox(w.env, STORE, "state.json")], [false, null])
  const at = new Date(T0).toISOString()
  const base = { desk_root: w.deskRoot, person_prefix: "", since: at }
  const note = async (key, written, { begin = true, time = T0, operation = "review" } = {}) => {
    const mark = { store: STORE, key, operation, at: time }
    if (begin) await beginTriageEmission(w.env, { ...mark, deskRoot: w.deskRoot, personPrefix: "" })
    await settleTriageEmission(w.env, { ...mark, written })
    return (await state(w)).requests[key]
  }
  const clear = () => updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: {} }))
  // Answers that wrote nothing leave nothing.
  for (const stateName of ["stale_basis", "identity_conflict", "busy", "policy_refused"]) assert.equal(await note(KEY, { state: stateName, revision: 4 }), undefined, stateName)
  assert.equal(await note(KEY, { state: "busy" }, { begin: false }), undefined, "a settle with no intent noted")
  // Answers after which the write may be on the remote keep the intent, with the attempt time and state it meant to write: a push
  // that was not read back, a write that threw, and an annotation found already there (this machine's or another's).
  for (const stateName of ["unacknowledged", "write_failed", "adopted"]) {
    assert.deepEqual(await note(KEY, { state: stateName, revision: 4 }), { ...base, intent: true, intended: [{ at, state: "reviewed" }] }, stateName)
    await clear()
  }
  // A later write that wrote nothing takes back only its own intent; the earlier one stays open.
  await note(KEY, { state: "unacknowledged" })
  assert.deepEqual(await note(KEY, { state: "stale_basis" }, { time: T0 + HOUR, operation: "invalidate" }), { ...base, intent: true, intended: [{ at, state: "reviewed" }] })
  // An acknowledged write settles everything before it. A failed later write keeps the acknowledged revision; a new acknowledged one replaces it and frees its batch and hold.
  assert.deepEqual(await note(KEY, { state: "acknowledged", revision: 4 }), { ...base, revision: 4, at })
  assert.equal((await note(KEY, { state: "stale_basis" })).revision, 4)
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { ...current.requests[KEY], batch: "0123456789abcdef", held: { code: "identity_not_random", revision: 4 } } } }))
  assert.deepEqual(await note(KEY, { state: "acknowledged", revision: 5 }), { ...base, revision: 5, at })
  await clear()

  // Coverage: counts only from a complete scan, refused and deferred from the last step that knew them (null until a run completed),
  // and one generation whatever the counts do.
  const cover = async (coverage, counts = {}, runner = null) => {
    await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage, counts, runner, now: T0 })
    return state(w)
  }
  const complete = { scan: "complete", reviewed: 2, unreviewed: 3, refused: null, deferred: null, more_unreviewed: true }
  let kept = await cover(complete)
  const { generation } = kept
  assert.match(generation, /^[0-9a-f]{32}$/u)
  assert.deepEqual([kept.coverage, kept.runner_state, kept.scan_at], [{ scan: "complete", reviewed: 2, unreviewed: 3, refused: null, deferred: null, more_unreviewed: true }, null, at])
  kept = await cover(complete, { reviewed: null, refused: null, deferred: null }, "not a state")
  assert.deepEqual([kept.generation, kept.runner_state], [generation, null])
  kept = await cover(complete, { reviewed: 3, refused: 1, deferred: 2 }, "ran")
  assert.deepEqual([kept.coverage, kept.runner_state, kept.generation], [{ scan: "complete", reviewed: 5, unreviewed: 0, refused: 1, deferred: 2, more_unreviewed: false }, "ran", generation], "the counts changed, the generation did not")
  kept = await cover(complete, {}, null)
  assert.deepEqual([kept.coverage.refused, kept.coverage.deferred, kept.runner_state], [1, 2, "ran"], "the last known run counts and runner state stay")
  kept = await cover({ scan: "unreadable", reviewed: null, unreviewed: null, refused: null, deferred: null, more_unreviewed: null }, { reviewed: 1 })
  assert.deepEqual([kept.coverage, kept.generation], [{ scan: "unreadable", reviewed: null, unreviewed: null, refused: null, deferred: null, more_unreviewed: null }, generation])
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
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE], { at: new Date(T0 + 2 * HOUR).toISOString(), pending: 1, waiting: 1, held_requests: { identity_not_random: 1 }, waiting_since: at, scan: "complete" })

  // The protected batch record is lost before the store merges: nothing claims delivery, and its rows are staged again.
  await updateTriageOutbox(w.env, STORE, `${value.batch}.json`, () => ({ schema: "desk.factory.triage-batch/1", state: "delivered" }))
  assert.equal((await run(w, hub, T0 + 3 * HOUR)).result, "delivered_pr_open")
  assert.deepEqual([(await state(w)).pending.length, (await state(w)).emitted], [1, {}])
  assert.notEqual((await state(w)).pending[0], value.batch)
  assert.equal(batchValue(hub, (await headTriage(w, hub))[0][1]).rows.length, 2)
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
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: 1, unreviewed: 0, more_unreviewed: false }, counts: {}, runner: null, now: T0 })
  plan = await planTriage(w.env, { store: STORE, now: T0 + HOUR })
  assert.deepEqual([plan.work, plan.held], [false, { triage_runner_unknown: 1 }])
  assert.deepEqual(await run(w, hub, T0 + HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, 0)
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: 1, unreviewed: 0, more_unreviewed: false }, counts: {}, runner: "no_agent_cli", now: T0 })
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
  for (const key of KEYS) assert.deepEqual(kept.requests[key], { desk_root: w.deskRoot, person_prefix: "", since: kept.requests[key].since, revision: 1, at: kept.requests[key].at })
  assert.deepEqual([kept.coverage, kept.runner_state, kept.scan_at], [{ scan: "complete", reviewed: 3, unreviewed: 0, refused: 0, deferred: 0, more_unreviewed: false }, "ran", new Date(T0).toISOString()])
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

test("pending_batch_is_rebuilt_when_a_pointer_turns_private", async () => {
  const visibility = { [ISSUE_REPO]: "public" }
  const { w, written } = await reviewedWorld()
  const hub = github({ visibility })
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  const [[file, sha]] = await headTriage(w, hub)
  assert.deepEqual(batchValue(hub, sha).rows[0].evidence, [issueOf(KEY)])
  const batch = path.posix.basename(file, ".json")
  // The pull request is closed unmerged, and the pointer's repository turns private before the batch goes again.
  hub.pulls.at(-1).state = "closed"
  visibility[ISSUE_REPO] = "private"
  assert.equal((await run(w, hub, T0 + 2 * HOUR)).result, "delivered_pr_open")
  const head = await headTriage(w, hub)
  assert.equal(head.length, 1)
  assert.notEqual(head[0][0], file, "never the bytes that name the repository")
  const rebuilt = batchValue(hub, head[0][1])
  assert.ok(!hub.blobText(head[0][1]).includes(ISSUE_REPO), "the private repository's name does not reach the store")
  assert.deepEqual(rebuilt.rows.map((row) => [row.id, row.revision, row.evidence, row.basis.evidence_revisions]), [[written.id, 1, [], []]])
  const old = await record(w, batch)
  assert.deepEqual([old.state, old.reason, old.bytes], ["replaced", "visibility", undefined], "the staged bytes are not kept")
  assert.deepEqual([(await state(w)).pending, (await state(w)).requests[KEY].batch], [[rebuilt.batch], rebuilt.batch])

  // The store's own visibility cannot be learned while a batch waits: the batch is taken apart, nothing is sent, and the annotation waits a day.
  hub.pulls.at(-1).state = "closed"
  let asked = 0
  const odd = github({ visibility, intercept: (call) => (call.args.at(-1) === `repos/${STORE}` && (asked += 1) > 1 ? { code: 0, stdout: JSON.stringify({ full_name: STORE }), stderr: "" } : undefined) })
  assert.deepEqual(await run(w, odd, T0 + 3 * HOUR), { result: "nothing_pending" })
  assert.deepEqual(await headTriage(w, odd), [])
  const kept = await state(w)
  assert.deepEqual([kept.held.code, kept.pending, Object.keys(kept.requests), kept.requests[KEY].batch], ["triage_visibility_unknown", [], [KEY], undefined])
  assert.equal((await record(w, rebuilt.batch)).state, "replaced")
  assert.equal((await run(w, hub, T0 + 3 * HOUR + DAY)).result, "delivered_pr_open")
  assert.equal((await headTriage(w, hub)).length, 1)
})

test("one_coverage_generation_and_reattestation_keep_a_quiet_queue_current", async () => {
  const { recordTriageCoverage } = await load()
  const visibility = { [ISSUE_REPO]: "public" }
  const w = await world({ keys: KEYS.slice(0, 2) })
  const first = await review(w, KEYS[0])
  await step(w)
  // A machine whose runner has completed a run knows its refused and deferred counts; until then they are null and stay null.
  assert.deepEqual([(await state(w)).coverage.refused, (await state(w)).coverage.deferred], [null, null])
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: 1, unreviewed: 1, more_unreviewed: true }, counts: { reviewed: 0, refused: 0, deferred: 0 }, runner: "ran", now: T0 })
  const { generation } = await state(w)
  const hub = github({ visibility })
  const publish = async (now) => {
    assert.equal((await run(w, hub, now)).result, "delivered_pr_open")
    const added = (await headTriage(w, hub)).filter(([name]) => !new Map(mainTriage(hub)).has(name))
    assert.equal(hub.settleOpenPr().merged, true)
    assert.deepEqual(await run(w, hub, now + HOUR), { result: "nothing_pending" })
    return added.map(([, sha]) => batchValue(hub, sha))
  }
  const [one] = await publish(T0 + HOUR)
  assert.deepEqual(one.coverage, { generation, scan: "complete", reviewed: 1, unreviewed: 1, refused: 0, deferred: 0, more_unreviewed: true })
  assert.equal((await readStatus(w.env)).triage_publication[STORE].coverage_known, true)

  // The next day a second card is reviewed: the counts change, the generation does not, so a store reads the newer batch as this source's coverage.
  const second = await review(w, KEYS[1], { now: T0 + DAY })
  await step(w, T0 + DAY)
  const [two] = await publish(T0 + DAY + HOUR)
  assert.deepEqual([two.coverage, two.rows.map((row) => row.id)], [{ generation, scan: "complete", reviewed: 2, unreviewed: 0, refused: 0, deferred: 0, more_unreviewed: false }, [second.id]])

  // Quiet. Under two days after a row reached the store, nothing is said again and the store is not asked.
  let calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 2 * DAY + HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
  // Two days after the first row reached the store it is due, and the second goes with it: both byte for byte, in one new file with
  // the coverage of now, so a quiet desk opens one pull request every two days.
  const [again, ...more] = await publish(T0 + 2 * DAY + 3 * HOUR)
  assert.deepEqual([more, again.batch === one.batch, again.rows, again.coverage], [[], false, [...one.rows, ...two.rows], two.coverage])
  const kept = await state(w)
  assert.deepEqual([kept.rows[first.id].attested_at, kept.rows[second.id].attested_at, kept.emitted], [at(T0 + 2 * DAY + 4 * HOUR), at(T0 + 2 * DAY + 4 * HOUR), { [first.id]: 1, [second.id]: 1 }])
  assert.deepEqual((await record(w, again.batch)).rows, [first, second].map((row, index) => ({ id: row.id, revision: 1, desk_root: w.deskRoot, key: KEYS[index], person_prefix: "", attest: true })))
  const told = (await readStatus(w.env)).triage_publication[STORE]
  assert.deepEqual([told.rows_oldest_at, told.rows_held], [at(T0 + 2 * DAY + 4 * HOUR), 0])

  // The triage step has not scanned for three days: this machine no longer says its reviews still stand, so nothing is sent and both age out at the store.
  calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 4 * DAY + 5 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
  // It scans again. Both rows are due and go, and wait in an open pull request.
  await step(w, T0 + 4 * DAY + 5 * HOUR)
  assert.equal((await run(w, hub, T0 + 4 * DAY + 6 * HOUR)).result, "delivered_pr_open")
  const fresh = async () => (await headTriage(w, hub)).filter(([name]) => !new Map(mainTriage(hub)).has(name)).map(([, sha]) => batchValue(hub, sha))
  const waiting = await fresh()
  assert.deepEqual(waiting.map((value) => value.rows), [again.rows])
  // While it waits the counts change: the batch is rebuilt with them under a new batch ID, so every file of one pull request says one coverage.
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: 2, unreviewed: 4, more_unreviewed: true }, counts: {}, runner: null, now: T0 + 4 * DAY + 6 * HOUR })
  assert.equal((await run(w, hub, T0 + 4 * DAY + 6.5 * HOUR)).result, "delivered_pr_open")
  assert.deepEqual((await fresh()).map((value) => [value.rows, value.coverage.unreviewed, value.coverage.generation, value.batch === waiting[0].batch]), [[again.rows, 4, generation, false]])
  assert.deepEqual([(await record(w, waiting[0].batch)).state, (await record(w, waiting[0].batch)).reason], ["replaced", "coverage"])
  // The pointer's repository turns private before that merges. Neither row is sent again at its revision: the waiting batch is taken
  // apart, and both rows say why.
  hub.pulls.at(-1).state = "closed"
  visibility[ISSUE_REPO] = "private"
  const pulls = hub.pullCount()
  assert.deepEqual(await run(w, hub, T0 + 4 * DAY + 8 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.pullCount(), pulls, "nothing is sent")
  const closed = await state(w)
  const since = { code: "triage_evidence_not_public", since: at(T0 + 4 * DAY + 8 * HOUR) }
  assert.deepEqual([closed.pending, closed.rows[second.id].held, closed.rows[first.id].held], [[], since, since])
  await run(w, hub, T0 + 4 * DAY + 9 * HOUR)
  const summary = (await readStatus(w.env)).triage_publication[STORE]
  assert.deepEqual([summary.held_requests, summary.waiting_since, summary.rows_held], [{ triage_evidence_not_public: 2 }, at(T0 + 4 * DAY + 8 * HOUR), 2])
})

test("pending_batch_is_not_sent_after_the_route_changes", async () => {
  const { w, written } = await reviewedWorld()
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  const [[file]] = await headTriage(w, hub)
  const batch = path.posix.basename(file, ".json")
  // The desk now reports elsewhere: the staged batch is taken apart, and the pull request loses it.
  await declareRoute(w, "example-org/another-store")
  await run(w, hub, T0 + 2 * HOUR)
  assert.deepEqual(triageFiles(hub.headFiles(STORE, await branchOf(w))), [])
  const kept = await state(w)
  assert.deepEqual([kept.pending, kept.requests[KEY].batch, kept.held_requests, (await record(w, batch)).state, (await record(w, batch)).reason], [[], undefined, { triage_route_elsewhere: 1 }, "replaced", "route"])
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE].held_requests, { triage_route_elsewhere: 1 })
  // Routed back: it is built and sent again, and delivered.
  await declareRoute(w, STORE)
  assert.equal((await run(w, hub, T0 + 3 * HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 4 * HOUR)
  assert.deepEqual((await state(w)).emitted, { [written.id]: 1 })
  // A delivered row of a desk that routes elsewhere is not sent again either.
  await declareRoute(w, "example-org/another-store")
  const calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 2 * DAY + 5 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
  assert.deepEqual((await state(w)).held_requests, { triage_route_elsewhere: 1 })
})

test("triage_error_never_stops_facts", async () => {
  const { recordTriageCoverage } = await load()
  // A pending batch whose protected record is damaged: the triage code fails online, after the facts were taken.
  const { w } = await reviewedWorld()
  const facts = await putFacts(w)
  await updateTriageOutbox(w.env, STORE, "00000000000000cc.json", () => ({ schema: "desk.factory.triage-batch/1", state: "pending", path: "triage/00000000000000cc.json", sha: "0".repeat(40), bytes: "not json", rows: [], refusals: 0 }))
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, pending: ["00000000000000cc"] }))
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.ok(hub.headFiles(STORE, await branchOf(w)).has(`facts/${facts}`), "the facts went")
  assert.deepEqual(await headTriage(w, hub), [])
  const kept = await state(w)
  assert.deepEqual([kept.held, Object.keys(kept.requests)], [{ code: "triage_error", until: at(T0 + HOUR + DAY), since: at(T0 + HOUR) }, [KEY]])
  assert.equal((await readStatus(w.env)).triage_publication[STORE].held, "triage_error")

  // A request whose desk folder is not a path: the triage code fails in the local plan, before anything else.
  const other = await world()
  const more = await putFacts(other, 2)
  await recordTriageCoverage(other.env, { deskRoot: other.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: 0, unreviewed: 0, more_unreviewed: false }, counts: {}, runner: "no_agent_cli", now: T0 })
  await updateTriageOutbox(other.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEY]: { desk_root: "not/absolute", person_prefix: "", revision: 1 } } }))
  const second = github()
  assert.equal((await run(other, second, T0 + HOUR)).result, "delivered_pr_open")
  assert.ok(second.headFiles(STORE, await branchOf(other)).has(`facts/${more}`))
  assert.equal((await state(other)).held.code, "triage_error")

  // The triage state can be neither read nor written (a folder where the file belongs): not even the hold can be recorded, and the facts still go.
  const { w: fourth } = await reviewedWorld()
  const last = await putFacts(fourth, 3)
  const file = await stateFile(fourth)
  await fs.rename(file, `${file}.aside`)
  await fs.mkdir(file)
  const plain = github()
  assert.equal((await run(fourth, plain, T0 + HOUR)).result, "delivered_pr_open")
  assert.ok(plain.headFiles(STORE, await branchOf(fourth)).has(`facts/${last}`))
  assert.deepEqual(await headTriage(fourth, plain), [])
  assert.deepEqual(await fs.readdir(file), [])

  // The flush's own stop inside the triage code is still the flush's: a repository answer that is no answer ends it, and is not a triage error.
  const { w: third } = await reviewedWorld()
  const broken = github({ intercept: (call) => (call.args.at(-1) === `repos/${ISSUE_REPO}` ? httpError(500, "Server Error") : undefined) })
  assert.equal((await run(third, broken, T0 + HOUR)).result, "unexpected")
  assert.equal((await state(third)).held, undefined)
})

test("the_step_keeps_identities_for_the_store_the_desk_routes_to", async () => {
  const EARLIER = "example-org/a-store"
  const stateOf = (w, store) => readTriageOutbox(w.env, store, "state.json")
  // This machine contributes to two stores; the one that sorts first is not the one the desk routes to.
  const w = await world()
  await setConsent(w.env, { store: EARLIER, contribute: true, account: ACCOUNT })
  assert.equal((await step(w)).result, "runner_unavailable")
  assert.deepEqual([(await stateOf(w, STORE))?.coverage?.scan, await stateOf(w, EARLIER)], ["complete", null], "the routed store, not the first one")
  // A desk that routes to a store this machine does not contribute to has no store to keep identities for.
  await declareRoute(w, "example-org/not-contributed")
  assert.equal((await step(w)).result, "no_consenting_store")
  // A desk whose route nothing says yet takes the first store this machine contributes to.
  const unrouted = await world({ route: null })
  await setConsent(unrouted.env, { store: EARLIER, contribute: true, account: ACCOUNT })
  assert.equal((await step(unrouted)).result, "runner_unavailable")
  assert.deepEqual([(await stateOf(unrouted, EARLIER))?.coverage?.scan, await stateOf(unrouted, STORE)], ["complete", null])
})

test("a_write_pushed_but_not_read_back_is_published_and_an_adopted_one_only_when_it_is_this_machines", async () => {
  const { beginTriageEmission, settleTriageEmission, planTriage } = await load()
  const w = await world({ keys: KEYS })
  const write = async (key, now) => {
    const read = await readTriageBasis({ deskRoot: w.deskRoot, personPrefix: "", key, now: new Date(now), evidence: { resolve: resolveIssue }, env: w.env })
    const safe = { route: "investigate", gate: null, authority_code: "investigation_only", summary_codes: ["source:andon", "route:investigate"], evidence: [issueOf(key)], related_keys: [], duplicate_keys: [], producer_version: read.basis.producer_version, rubric_version: read.basis.rubric_version, protected_result: hex(16) }
    return publishOwnedTriage({ env: w.env, deskRoot: w.deskRoot, personPrefix: "", key, store: STORE, expectedBasis: read.basis, review: safe, operation: "review", now: new Date(now), evidence: { resolve: resolveIssue } })
  }
  // Two writes of this machine reached the remote, but one answer was lost after the push and the other write threw: neither was settled.
  const ids = {}
  for (const [key, answer] of [[KEYS[0], "unacknowledged"], [KEYS[1], "write_failed"]]) {
    const mark = { store: STORE, key, operation: "review", at: T0 }
    await beginTriageEmission(w.env, { ...mark, deskRoot: w.deskRoot, personPrefix: "" })
    ids[key] = (await write(key, T0)).id
    await settleTriageEmission(w.env, { ...mark, written: { state: answer, resources: [] } })
  }
  // Another machine wrote the third card. This machine's own attempt, an hour later, found it there (`adopted`).
  await write(KEYS[2], T0)
  const mark = { store: STORE, key: KEYS[2], operation: "review", at: T0 + HOUR }
  await beginTriageEmission(w.env, { ...mark, deskRoot: w.deskRoot, personPrefix: "" })
  await settleTriageEmission(w.env, { ...mark, written: { state: "adopted", revision: 1, resources: [] } })
  await step(w, T0 + HOUR)

  // The remote's main holds, for the first two, an annotation with exactly the attempt time and state this machine meant to write:
  // they are its own, acknowledged late. The third annotation is another machine's write, and that machine publishes it.
  const plan = await planTriage(w.env, { store: STORE, now: T0 + 2 * HOUR })
  assert.deepEqual([plan.candidates.map((candidate) => candidate.key).sort(), plan.held], [[KEYS[0], KEYS[1]].sort(), { triage_unacknowledged: 1 }])
  assert.deepEqual(plan.state.requests[KEYS[0]], { desk_root: w.deskRoot, person_prefix: "", since: at(T0), revision: 1, at: at(T0 + 2 * HOUR) })
  assert.equal(plan.state.requests[KEYS[2]].intent, true)
  const hub = github()
  assert.equal((await run(w, hub, T0 + 3 * HOUR)).result, "delivered_pr_open")
  const [[, sha]] = await headTriage(w, hub)
  assert.deepEqual(batchValue(hub, sha).rows.map((row) => row.id).sort(), [ids[KEYS[0]], ids[KEYS[1]]].sort(), "the other machine's revision is not published from here")
  // Three days on the third intent is over: nothing of this machine's is there to publish.
  assert.equal((await planTriage(w.env, { store: STORE, now: T0 + HOUR + 3 * DAY + 1 })).state.requests[KEYS[2]], undefined)
})

test("third_refusal_stops_resending", async () => {
  const { w } = await reviewedWorld()
  const facts = await putFacts(w)
  const hub = github()
  let now = T0 + HOUR
  let batch
  for (const refusals of [1, 2, 3]) {
    assert.equal((await run(w, hub, now)).result, "delivered_pr_open")
    const head = await headTriage(w, hub)
    assert.equal(head.length, 1, `sent for the ${refusals}. time`)
    batch = path.posix.basename(head[0][0], ".json")
    hub.rejectOpenPr("factory-rejected: triage_batch_mismatch")
    await run(w, hub, now + HOUR)
    assert.equal((await record(w, batch)).refusals, refusals)
    assert.deepEqual([(await state(w)).held.code, (await state(w)).pending], ["triage_batch_mismatch", refusals < 3 ? [batch] : []])
    now += DAY + 2 * HOUR
  }
  // Refused three times: the record is closed with the store's code, its bytes are not kept, and the annotation is held at this revision.
  const closed = await record(w, batch)
  assert.deepEqual([closed.state, closed.refused_code, closed.bytes], ["refused", "triage_batch_mismatch", undefined])
  assert.deepEqual((await state(w)).requests[KEY].held, { code: "triage_batch_refused", revision: 1 })
  // After the day nothing is sent again; the facts still go, and the reason is said.
  await run(w, hub, now)
  assert.deepEqual(await headTriage(w, hub), [])
  assert.ok(hub.headFiles(STORE, await branchOf(w)).has(`facts/${facts}`))
  assert.deepEqual([(await state(w)).pending, (await readStatus(w.env)).triage_publication[STORE].held_requests], [[], { triage_batch_refused: 1 }])
})

test("only_a_recorded_batch_is_pushed_and_eight_files_ride_one_pull_request", async () => {
  const { stageTriageBatch, recordTriageCoverage } = await load()
  const { w } = await reviewedWorld()
  // The new batch's ID is taken by a record that holds other bytes: nothing was recorded for it, so nothing is pushed.
  await updateTriageOutbox(w.env, STORE, "00000000000000bb.json", () => ({ schema: "desk.factory.triage-batch/1", state: "pending", sha: "0".repeat(40) }))
  assert.deepEqual(await prepare(w, T0 + HOUR, { newBatch: () => "00000000000000bb" }), { items: [] })
  assert.deepEqual([(await state(w)).pending, (await record(w, "00000000000000bb")).sha], [[], "0".repeat(40)])
  const one = await prepare(w, T0 + HOUR)
  assert.deepEqual([one.items.length, (await state(w)).pending.length], [1, 1])
  // Nine batches wait: eight ride this pull request, the ninth the next. All stay pending until the default branch holds them.
  const kept = await state(w)
  const shared = { store: STORE, consent: { contribute: true }, visibility: new Map([[STORE.toLowerCase(), "public"]]), coverage: { generation: kept.generation, ...kept.coverage }, runner: { state: kept.runner_state, last_success_age: "never" } }
  for (let n = 0; n < 8; n += 1) assert.equal((await stageTriageBatch(w.env, { store: STORE, projection: triageBatchOf({ ...shared, rows: [] }), now: T0 + HOUR })).state, "staged")
  const capped = await prepare(w, T0 + 2 * HOUR)
  assert.deepEqual([capped.items.length, (await state(w)).pending.length], [8, 9])
  assert.deepEqual(capped.items.map((item) => item.batch), (await state(w)).pending.slice(0, 8), "as they are, oldest first")
  // A batch that must be built again and cannot be (consent was withdrawn in between) holds everything for a day.
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: 9, unreviewed: 0, more_unreviewed: false }, counts: {}, runner: null, now: T0 + 2 * HOUR })
  assert.deepEqual(await prepare(w, T0 + 3 * HOUR, { consent: { contribute: false } }), { items: [] })
  assert.equal((await state(w)).held.code, "triage_not_opted_in")
})

test("readiness_is_read_afresh_after_a_delivery_and_a_delivered_revision_is_never_built_again", async () => {
  const { planTriage } = await load()
  const w = await world({ keys: KEYS.slice(0, 2) })
  const first = await review(w, KEYS[0])
  await step(w)
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * HOUR)
  assert.deepEqual((await state(w)).emitted, { [first.id]: 1 })
  const asked = contentsCalls(hub)
  assert.ok(asked >= 2, "every flush that went online for triage read the switch")

  // The store switches triage off after that first delivery. The next annotation is not sent on the strength of the earlier answer.
  await review(w, KEYS[1], { now: T0 + 3 * HOUR })
  await step(w, T0 + 3 * HOUR)
  hub.setTriageJson(null)
  const pulls = hub.pullCount()
  assert.deepEqual(await run(w, hub, T0 + 4 * HOUR), { result: "nothing_pending" })
  assert.deepEqual([contentsCalls(hub), hub.pullCount(), (await state(w)).held.code, (await state(w)).pending], [asked + 1, pulls, "triage_store_not_ready", []])
  // Switched on again, a day later: read again, and sent.
  hub.setTriageJson(READY)
  assert.equal((await run(w, hub, T0 + 4 * HOUR + DAY)).result, "delivered_pr_open")
  assert.equal(contentsCalls(hub), asked + 2)
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 5 * HOUR + DAY)

  // A request for a revision the store already has (this machine's note of it came back) is not built again: no candidate, no batch, no call.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEYS[0]]: { desk_root: w.deskRoot, person_prefix: "", revision: 1 } } }))
  const plan = await planTriage(w.env, { store: STORE, now: T0 + 6 * HOUR + DAY })
  assert.deepEqual([plan.candidates, plan.work, plan.state.requests], [[], false, {}])
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, requests: { [KEYS[0]]: { desk_root: w.deskRoot, person_prefix: "", revision: 1 } } }))
  const calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 6 * HOUR + DAY), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
})

test("a_damaged_state_file_is_moved_aside_and_holds", async () => {
  const { planTriage } = await load()
  const { w } = await reviewedWorld()
  const file = await stateFile(w)
  const before = await state(w)
  const siblings = async () => (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("state.json.")).sort()
  // The file cannot be parsed. It is not read as empty and written over: it is moved aside whole, and everything is held for a day.
  await fs.writeFile(file, "{ not json")
  const hub = github()
  assert.deepEqual(await run(w, hub, T0 + HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, 0)
  assert.deepEqual(await siblings(), ["state.json.corrupt-json-1"])
  assert.equal(await fs.readFile(`${file}.corrupt-json-1`, "utf8"), "{ not json")
  let kept = await state(w)
  assert.deepEqual([kept.held, kept.damaged, kept.reset_at, kept.requests, kept.pending], [{ code: "triage_state_damaged", until: at(T0 + HOUR + DAY), since: at(T0 + HOUR) }, 1, at(T0 + HOUR), {}, []])
  assert.notEqual(kept.generation, before.generation, "a new source: what the old one said is not known")
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE], { at: at(T0 + HOUR), pending: 0, waiting: 0, held: "triage_state_damaged", held_since: at(T0 + HOUR), reset_at: at(T0 + HOUR) })
  // A file that parses but whose fields are not the shapes the code relies on is damaged the same way, each one of them.
  let n = 1
  for (const patch of [{ pending: "all" }, { pending: [7] }, { requests: { [KEY]: "soon" } }, { requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", intended: "x" } } }, { requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", intent: true } } }, { emitted: { x: "1" } }, { rows: { x: { row: {}, desk_root: "/d", key: "k", person_prefix: "", revision: 1, attested_at: "never" } } }, { held: { code: 1, until: at(T0) } }, { coverage: 1 }, { published: 1 }, { scan_desk: 1 }, { rows: { x: { row: {}, desk_root: "/d", revision: 1, attested_at: at(T0) } } }, { held_requests: 1 }, { generation: "short" }, { schema: "another/9" }]) {
    n += 1
    await fs.writeFile(file, JSON.stringify({ ...kept, ...patch }))
    const plan = await planTriage(w.env, { store: STORE, now: T0 + 2 * HOUR })
    assert.deepEqual([plan.work, plan.state.damaged, plan.state.held.code, (await siblings()).length], [false, n, "triage_state_damaged", n], JSON.stringify(patch))
    kept = await state(w)
  }
  // A whole state with every optional field is read as it is.
  const whole = { ...kept, requests: { [KEY]: { desk_root: w.deskRoot, person_prefix: "", intended: [] } }, pending: ["0123456789abcdef"], emitted: { x: 1 }, rows: { x: { row: {}, desk_root: "/d", key: "k", person_prefix: "", revision: 1, attested_at: at(T0) } }, coverage: { scan: "complete" }, published: { scan: "complete" }, held_requests: {} }
  await fs.writeFile(file, JSON.stringify(whole))
  assert.deepEqual(await readTriageOutbox(w.env, STORE, "state.json"), whole)
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 3 * HOUR })).state, whole)
  assert.equal((await siblings()).length, n)
})

test("the_rarer_paths_of_a_pending_batch_hold_or_wait_rather_than_send", async () => {
  const { saveTriageRefused, saveTriageSent, planTriage } = await load()
  const w = await world({ keys: KEYS })
  const first = await review(w, KEYS[0])
  await step(w)
  // A hold that is not about one row (consent was withdrawn before the first build) holds everything for a day.
  assert.deepEqual(await prepare(w, T0 + HOUR, { consent: { contribute: false } }), { items: [] })
  assert.equal((await state(w)).held.code, "triage_not_opted_in")
  await updateTriageOutbox(w.env, STORE, "state.json", ({ held: _held, ...current }) => current)

  // Two batches wait, each with its own request.
  assert.equal((await prepare(w, T0 + HOUR)).items.length, 1)
  await review(w, KEYS[1], { now: T0 + 2 * HOUR })
  await step(w, T0 + 2 * HOUR)
  const early = (await prepare(w, T0 + 3 * HOUR)).items
  assert.equal(early.length, 2)
  // The record of one of them is no longer a pending one: it is forgotten, its request is built again, and the other stays tied to its batch.
  await updateTriageOutbox(w.env, STORE, `${early[0].batch}.json`, (current) => ({ ...current, state: "replaced" }))
  const both = (await prepare(w, T0 + 3 * HOUR)).items
  assert.deepEqual([both.length, both[0].batch], [2, early[1].batch])
  const [b, a] = both.map((item) => item.batch)
  await review(w, KEYS[2], { now: T0 + 3 * HOUR })
  // A refusal with no pull request on record, or of a pull request that did not carry a batch, counts against neither.
  await saveTriageRefused(w.env, STORE, "triage_batch_mismatch", T0 + 3 * HOUR)
  await saveTriageSent(w.env, STORE, [both[0]], 7, T0 + 3 * HOUR)
  await saveTriageRefused(w.env, STORE, "triage_batch_mismatch", T0 + 3 * HOUR)
  assert.deepEqual([(await record(w, a)).refusals, (await record(w, b)).refusals, (await state(w)).pr], [0, 1, undefined])
  // The third refusal of one batch holds its request and leaves the other batch and its request as they are.
  for (const refusals of [2, 3]) {
    await saveTriageSent(w.env, STORE, [both[0]], 7 + refusals, T0 + 3 * HOUR)
    await saveTriageRefused(w.env, STORE, "triage_batch_mismatch", T0 + 3 * HOUR)
  }
  let kept = await state(w)
  assert.deepEqual([kept.pending, kept.requests[KEYS[0]].batch, kept.requests[KEYS[0]].held, kept.requests[KEYS[1]].held, kept.requests[KEYS[2]].batch], [[a], a, undefined, { code: "triage_batch_refused", revision: 1 }, undefined])
  await updateTriageOutbox(w.env, STORE, "state.json", ({ held: _held, ...current }) => current)

  // The first batch is on the default branch, but this state already delivered a newer revision of its row: the older row is not taken back.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, emitted: { [first.id]: 2 } }))
  const onMain = { blobs: new Map([[both[1].path, both[1].sha]]), unknown: false }
  await prepare(w, T0 + 4 * HOUR, { readMain: async () => onMain })
  kept = await state(w)
  assert.deepEqual([kept.pending.includes(a), kept.emitted, kept.rows, Object.keys(kept.requests).sort()], [false, { [first.id]: 2 }, {}, [KEYS[1], KEYS[2]].sort()])

  // A delivered row that names a job report is sent again only while that job is one this machine published to the store.
  const other = await world({ keys: KEYS.slice(0, 2) })
  const rows = []
  for (const [index, key] of KEYS.slice(0, 2).entries()) rows.push(await review(other, key, { now: T0 + index * HOUR }))
  await step(other, T0 + HOUR)
  const sent = (await prepare(other, T0 + 2 * HOUR)).items
  const main = { blobs: new Map([[sent[0].path, sent[0].sha]]), unknown: false }
  await prepare(other, T0 + 3 * HOUR, { readMain: async () => main })
  assert.deepEqual(Object.keys((await state(other)).rows).sort(), rows.map((row) => row.id).sort())
  const job = { kind: "job", ref: `https://github.com/${STORE}/blob/reports/jobs/${"a".repeat(32)}.md`, revision: 1 }
  await updateTriageOutbox(other.env, STORE, "state.json", (current) => ({ ...current, rows: Object.fromEntries(Object.entries(current.rows).map(([id, entry], index) => [id, { ...entry, attested_at: at(T0 + index * HOUR), row: id === rows[0].id ? { ...entry.row, evidence: [job] } : entry.row }])) }))
  await step(other, T0 + 2 * DAY)
  const plan = await planTriage(other.env, { store: STORE, now: T0 + 2 * DAY + 2 * HOUR })
  assert.deepEqual(plan.attest, [rows[0].id, rows[1].id], "oldest first")
  // A row sent in the last half day does not go again with the one that is due.
  const stagger = (time) => updateTriageOutbox(other.env, STORE, "state.json", (current) => ({ ...current, rows: { ...current.rows, [rows[1].id]: { ...current.rows[rows[1].id], attested_at: at(time) } } }))
  await stagger(T0 + 2 * DAY - 6 * HOUR)
  assert.deepEqual((await planTriage(other.env, { store: STORE, now: T0 + 2 * DAY + 2 * HOUR })).attest, [rows[0].id])
  await stagger(T0 + HOUR)
  let asked = 0
  const resent = await prepare(other, T0 + 2 * DAY + 2 * HOUR, { readMain: async () => main, publishedJobs: () => { asked += 1; return new Set() } })
  assert.equal(asked, 1)
  assert.deepEqual(resent.items.map((item) => JSON.parse(item.bytes).rows.map((row) => row.id)), [[rows[1].id]])
  assert.equal((await state(other)).rows[rows[0].id].held.code, "triage_evidence_not_public")
  // That re-attestation is refused three times: the row is not sent again at this revision.
  for (const pr of [1, 2, 3]) {
    await saveTriageSent(other.env, STORE, resent.items, pr, T0 + 2 * DAY + 2 * HOUR)
    await saveTriageRefused(other.env, STORE, "triage_batch_mismatch", T0 + 2 * DAY + 2 * HOUR)
  }
  assert.deepEqual([(await state(other)).pending, (await state(other)).rows[rows[1].id].held.code], [[], "triage_batch_refused"])
})

test("a_cached_visibility_answer_is_never_trusted_for_bytes_about_to_go", async () => {
  // The repository the cards point at is private. The first row is built without the pointer and waits in an open pull request.
  const visibility = { [ISSUE_REPO]: "private" }
  const w = await world({ keys: KEYS.slice(0, 2) })
  const first = await review(w, KEYS[0])
  await step(w)
  const hub = github({ visibility })
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  // The visibility cache, which the facts flush fills, holds an older answer that says public. A cached answer is never enough:
  // the second row is built only after the repository is asked again in this flush, and so without the pointer.
  const stale = (time) => outbox.writeVisibilityCache(w.env, { [ISSUE_REPO.toLowerCase()]: { visibility: "public", checked_at: at(time) } })
  await stale(T0 + HOUR)
  const second = await review(w, KEYS[1], { now: T0 + 2 * HOUR })
  await step(w, T0 + 2 * HOUR)
  const asked = () => apiCalls(hub, new RegExp(`^repos/${ISSUE_REPO}$`, "u")).length
  const before = asked()
  assert.equal((await run(w, hub, T0 + 3 * HOUR)).result, "delivered_pr_open")
  assert.equal(asked(), before + 1, "asked in this flush, although a batch waits and the cache has an answer")
  const head = await headTriage(w, hub)
  assert.deepEqual(head.flatMap(([, sha]) => batchValue(hub, sha).rows.map((row) => [row.id, row.evidence])).sort(), [[first.id, []], [second.id, []]].sort())
  assert.ok(head.every(([, sha]) => !hub.blobText(sha).includes(ISSUE_REPO)), "the private repository is not named")
})

test("a_row_sent_again_needs_a_fresh_public_answer_too", async () => {
  const visibility = { [ISSUE_REPO]: "public" }
  const w = await world({ keys: KEYS.slice(0, 2) })
  const first = await review(w, KEYS[0])
  await step(w)
  const hub = github({ visibility })
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * HOUR)
  assert.deepEqual((await state(w)).rows[first.id].row.evidence, [issueOf(KEYS[0])])
  // The repository turns private. A second row is built without the pointer and waits; then the cache is left saying public.
  visibility[ISSUE_REPO] = "private"
  await review(w, KEYS[1], { now: T0 + 2 * DAY })
  await step(w, T0 + 2 * DAY)
  assert.equal((await run(w, hub, T0 + 2 * DAY + HOUR)).result, "delivered_pr_open")
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, rows: { [first.id]: { ...current.rows[first.id], held: undefined } } }))
  await outbox.writeVisibilityCache(w.env, { [ISSUE_REPO.toLowerCase()]: { visibility: "public", checked_at: at(T0 + 2 * DAY + HOUR) } })
  // The first row is due while that batch waits: it names the repository, the repository is asked again, and the row is held, not sent.
  await run(w, hub, T0 + 2 * DAY + 3 * HOUR)
  assert.deepEqual((await state(w)).rows[first.id].held, { code: "triage_evidence_not_public", since: at(T0 + 2 * DAY + 3 * HOUR) })
  assert.ok((await headTriage(w, hub)).filter(([name]) => !new Map(mainTriage(hub)).has(name)).every(([, sha]) => !hub.blobText(sha).includes(ISSUE_REPO)))
})

test("a_review_the_desk_remote_no_longer_holds_is_not_sent_again", async () => {
  const { planTriage, recordTriageCoverage } = await load()
  const w = await world({ keys: KEYS })
  const ids = []
  for (const key of KEYS) ids.push((await review(w, key)).id)
  await step(w)
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * HOUR)
  assert.deepEqual(Object.keys((await state(w)).rows).sort(), [...ids].sort())
  // Another writer puts a newer, invalidating revision of the first card on the desk remote's main. This machine did not write it.
  const invalidate = async (key, now) => {
    const read = await readTriageBasis({ deskRoot: w.deskRoot, personPrefix: "", key, now: new Date(now), evidence: { resolve: resolveIssue }, env: w.env })
    const written = await publishOwnedTriage({ env: w.env, deskRoot: w.deskRoot, personPrefix: "", key, store: STORE, expectedBasis: read.basis, review: null, operation: "invalidate", reason: "basis_changed", now: new Date(now), evidence: { resolve: resolveIssue } })
    assert.equal(written.state, "acknowledged", JSON.stringify(written))
  }
  await invalidate(KEYS[0], T0 + DAY)
  assert.deepEqual([(await annotationOf(w, KEYS[0])).revision, (await annotationOf(w, KEYS[0])).attempt.state], [2, "stale"])
  // The annotation of the third row cannot be read now: it waits, and is neither sent nor forgotten.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, rows: { ...current.rows, [ids[2]]: { ...current.rows[ids[2]], key: "andon:o/none#9" } } }))
  // Two days on the rows are due. Only the one the remote still holds as that review goes again; the first is dropped for good.
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: 3, unreviewed: 0, more_unreviewed: false }, counts: {}, runner: null, now: T0 + 2 * DAY })
  const plan = await planTriage(w.env, { store: STORE, now: T0 + 2 * DAY + 3 * HOUR })
  assert.deepEqual([plan.attest, Object.keys(plan.state.rows).sort(), plan.held], [[ids[1]], [ids[1], ids[2]].sort(), { triage_unacknowledged: 1 }])
  assert.equal((await run(w, hub, T0 + 2 * DAY + 3 * HOUR)).result, "delivered_pr_open")
  const waiting = (await headTriage(w, hub)).filter(([name]) => !new Map(mainTriage(hub)).has(name)).map(([, sha]) => batchValue(hub, sha))
  assert.deepEqual(waiting.map((value) => value.rows.map((row) => [row.id, row.revision, row.state])), [[[ids[1], 1, "reviewed"]]])
  // While that batch waits, the second card is invalidated too: the batch is taken apart, not sent, and the row is dropped.
  await invalidate(KEYS[1], T0 + 2 * DAY + 4 * HOUR)
  const pulls = hub.pullCount()
  hub.pulls.at(-1).state = "closed"
  assert.deepEqual(await run(w, hub, T0 + 2 * DAY + 5 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.pullCount(), pulls)
  const kept = await state(w)
  assert.deepEqual([kept.pending, Object.keys(kept.rows), (await record(w, waiting[0].batch)).state, (await record(w, waiting[0].batch)).reason], [[], [ids[2]], "replaced", "superseded"])
  // A waiting batch that says it re-sends a row this state no longer has is taken apart the same way.
  await updateTriageOutbox(w.env, STORE, waiting[0].batch + ".json", (current) => ({ ...current, state: "pending", bytes: JSON.stringify(waiting[0]) }))
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, pending: [waiting[0].batch] }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: T0 + 2 * DAY + 6 * HOUR })).state.pending, [])
})

test("a_counts_only_batch_is_not_sent_after_the_route_changes", async () => {
  const { recordTriageCoverage } = await load()
  const { w } = await reviewedWorld()
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * HOUR)
  // The next scan is cut short, which a batch with no rows would say. But the desk now reports elsewhere: nothing goes to the old store.
  const truncated = { scan: "truncated", reviewed: null, unreviewed: null, more_unreviewed: null }
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: truncated, counts: {}, runner: null, now: T0 + 3 * HOUR })
  await declareRoute(w, "example-org/another-store")
  let calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 4 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
  // A scan that names no desk cannot be checked against a route, so it is not sent either.
  await declareRoute(w, STORE)
  await recordTriageCoverage(w.env, { store: STORE, coverage: truncated, counts: {}, runner: null, now: T0 + 4 * HOUR })
  calls = hub.calls.length
  assert.deepEqual(await run(w, hub, T0 + 5 * HOUR), { result: "nothing_pending" })
  assert.equal(hub.calls.length, calls)
  // Scanned again by the desk that routes here: the batch with no rows goes.
  await recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: truncated, counts: {}, runner: null, now: T0 + 5 * HOUR })
  assert.equal((await run(w, hub, T0 + 6 * HOUR)).result, "delivered_pr_open")
  const sent = (await headTriage(w, hub)).filter(([name]) => !new Map(mainTriage(hub)).has(name)).map(([, sha]) => batchValue(hub, sha))
  assert.deepEqual(sent.map((value) => [value.rows, value.coverage.scan]), [[[], "truncated"]])
  // While that batch waits in an open pull request, the desk reports elsewhere again: the batch is taken apart, not sent.
  const { planTriage } = await load()
  const waiting = async () => [(await state(w)).pending, (await record(w, sent[0].batch)).state, (await record(w, sent[0].batch)).reason]
  assert.deepEqual(await waiting(), [[sent[0].batch], "pending", undefined])
  await declareRoute(w, "example-org/another-store")
  hub.pulls.at(-1).state = "closed"
  const pulls = hub.pullCount()
  assert.deepEqual(await run(w, hub, T0 + 7 * HOUR), { result: "nothing_pending" })
  assert.deepEqual([hub.pullCount(), await waiting()], [pulls, [[], "replaced", "route"]])
  // A waiting batch with no rows whose state no longer names the scanned desk cannot be checked against a route either.
  await declareRoute(w, STORE)
  await updateTriageOutbox(w.env, STORE, sent[0].batch + ".json", ({ reason: _reason, ...current }) => ({ ...current, state: "pending", bytes: JSON.stringify(sent[0]) }))
  await updateTriageOutbox(w.env, STORE, "state.json", ({ scan_desk: _desk, ...current }) => ({ ...current, pending: [sent[0].batch] }))
  assert.deepEqual(await waiting(), [[sent[0].batch], "pending", undefined])
  assert.equal((await planTriage(w.env, { store: STORE, now: T0 + 8 * HOUR })).work, false)
  assert.deepEqual(await waiting(), [[], "replaced", "route"])
})

/** What `body` does: every `node:fs` promise call as `<name> <last two path parts>`, and every process started as its command. */
async function watched(body) {
  const files = []
  const processes = []
  const restore = []
  const wrap = (object, name, note) => {
    const original = object[name]
    object[name] = function (...args) {
      note(name, args)
      return original.apply(this, args)
    }
    restore.push(() => { object[name] = original })
  }
  for (const name of ["readFile", "writeFile", "lstat", "stat", "readdir", "open", "mkdir", "rename", "unlink", "rm"]) wrap(nodeFs.promises, name, (call, args) => files.push(`${call} ${String(args[0]).split(path.sep).slice(-3).join("/")}`))
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) wrap(childProcess, name, (_call, args) => processes.push(path.basename(String(args[0]))))
  syncBuiltinESMExports()
  try {
    await body()
  } finally {
    for (const undo of restore) undo()
    syncBuiltinESMExports()
  }
  const count = (pattern) => files.filter((call) => pattern.test(call)).length
  return { triage: files.filter((call) => / (?:[^/]+\/)?triage-outbox\//u.test(call)).map((call) => call.replace(/ .*triage-outbox\//u, " ")), locks: count(/^open .*\.lock$/u), writes: count(/^(rename|writeFile) /u), processes }
}

test("a_flush_with_nothing_to_publish_adds_no_process_no_lock_no_write_and_no_network_call", async () => {
  // A machine that never triaged: the triage plan costs every flush one look for the state file and one folder listing.
  const bare = await world()
  const none = github()
  await run(bare, none, T0)
  const calls = none.calls.length
  const without = await watched(async () => assert.deepEqual(await run(bare, none, T0 + HOUR), { result: "nothing_pending" }))
  assert.deepEqual(without.triage, ["lstat example-org__example-store/state.json", "readdir example-org__example-store"])
  assert.deepEqual([none.calls.length, without.processes.filter((command) => /^git/u.test(command))], [calls, []])

  // A machine that has published and has nothing due: one more read, the state file. No lock is taken, nothing is written (the
  // summary in the status is as it was), no Git process starts and the store is not called.
  const { w } = await reviewedWorld()
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * HOUR)
  await run(w, hub, T0 + 3 * HOUR)
  const said = (await readStatus(w.env)).triage_publication[STORE]
  const before = hub.calls.length
  const quiet = await watched(async () => assert.deepEqual(await run(w, hub, T0 + 4 * HOUR), { result: "nothing_pending" }))
  assert.deepEqual(quiet.triage.filter((call) => !/^lstat /u.test(call)), ["readFile example-org__example-store/state.json", "readdir example-org__example-store"])
  assert.deepEqual([hub.calls.length, quiet.processes.filter((command) => /^git/u.test(command))], [before, []])
  assert.ok(quiet.locks <= without.locks && quiet.writes <= without.writes && quiet.processes.length <= without.processes.length, JSON.stringify([quiet, without]))
  assert.deepEqual((await readStatus(w.env)).triage_publication[STORE], said, "not written again")
  assert.equal(said.at, at(T0 + 2 * HOUR))
})

/** Another writer puts a newer, invalidating revision of the card on the desk remote's main. This machine notes no request for it. */
async function invalidateElsewhere(w, key, now) {
  const read = await readTriageBasis({ deskRoot: w.deskRoot, personPrefix: "", key, now: new Date(now), evidence: { resolve: resolveIssue }, env: w.env })
  const written = await publishOwnedTriage({ env: w.env, deskRoot: w.deskRoot, personPrefix: "", key, store: STORE, expectedBasis: read.basis, review: null, operation: "invalidate", reason: "basis_changed", now: new Date(now), evidence: { resolve: resolveIssue } })
  assert.equal(written.state, "acknowledged", JSON.stringify(written))
}

/** Every card of `keys` reviewed and delivered at two hours past `T0`, with a scan whose counts a store reads as known. */
async function deliveredWorld(keys) {
  const { recordTriageCoverage } = await load()
  const w = await world({ keys })
  const ids = []
  for (const key of keys) ids.push((await review(w, key)).id)
  await step(w)
  const scan = (now) => recordTriageCoverage(w.env, { deskRoot: w.deskRoot, store: STORE, coverage: { scan: "complete", reviewed: keys.length, unreviewed: 0, more_unreviewed: false }, counts: { reviewed: 0, refused: 0, deferred: 0 }, runner: "ran", now })
  await scan(T0)
  const hub = github()
  assert.equal((await run(w, hub, T0 + HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * HOUR)
  assert.deepEqual(Object.keys((await state(w)).rows).sort(), [...ids].sort())
  return { w, ids, hub, scan }
}

/** How many times `body` starts `git fetch`. */
async function fetches(body) {
  const original = childProcess.spawnSync
  let count = 0
  childProcess.spawnSync = function (...args) {
    if (args[1].includes("fetch")) count += 1
    return original.apply(this, args)
  }
  syncBuiltinESMExports()
  try {
    await body()
  } finally {
    childProcess.spawnSync = original
    syncBuiltinESMExports()
  }
  return count
}

test("a_row_that_cannot_be_read_does_not_start_a_round_for_the_others", async () => {
  const { planTriage } = await load()
  const { w, ids, scan } = await deliveredWorld(KEYS.slice(0, 2))
  const now = T0 + 2 * DAY + 3 * HOUR
  await scan(now)
  // The first row went again thirteen hours ago. The second is two days old, and its annotation cannot be read.
  const key = (await state(w)).rows[ids[1]].key
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, rows: { [ids[0]]: { ...current.rows[ids[0]], attested_at: at(now - 13 * HOUR) }, [ids[1]]: { ...current.rows[ids[1]], key: "andon:o/none#9" } } }))
  // The unreadable row is due, but it does not stand: it waits, and the first row is not sent again on its account.
  const plan = await planTriage(w.env, { store: STORE, now })
  assert.deepEqual([plan.attest, plan.held, plan.work, Object.keys(plan.state.rows).sort()], [[], { triage_unacknowledged: 1 }, false, [...ids].sort()])
  // Readable again, the second row stands and is due: it starts the round, and the first goes with it.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, rows: { ...current.rows, [ids[1]]: { ...current.rows[ids[1]], key } } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now })).attest, [ids[1], ids[0]])
  // A row already waiting in a batch is never put in a second one: with the second row staged, the first starts a round alone.
  assert.equal((await prepare(w, now)).items.length, 1)
  const [batch] = (await state(w)).pending
  await updateTriageOutbox(w.env, STORE, `${batch}.json`, (current) => ({ ...current, rows: current.rows.filter((row) => row.id === ids[1]) }))
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, rows: { ...current.rows, [ids[0]]: { ...current.rows[ids[0]], attested_at: at(now - ATTEST) } } }))
  assert.deepEqual((await planTriage(w.env, { store: STORE, now: now + HOUR })).attest, [ids[0]])
})

test("a_due_row_is_checked_against_the_desk_remote_fetched_once_and_waits_when_the_fetch_fails", async () => {
  const { planTriage } = await load()
  const { w, ids, scan } = await deliveredWorld(KEYS)
  // Another machine invalidates the first card. This desk's copy of the remote's main is as it was before: it still says the review stands.
  const before = git(w.deskRoot, ["rev-parse", "refs/remotes/origin/main"])
  await invalidateElsewhere(w, KEYS[0], T0 + DAY)
  git(w.deskRoot, ["update-ref", "refs/remotes/origin/main", before])
  // Nothing is due yet: no fetch.
  let plan
  assert.equal(await fetches(async () => { plan = await planTriage(w.env, { store: STORE, now: T0 + DAY + HOUR }) }), 0)
  assert.deepEqual([plan.attest, plan.work], [[], false])
  // Two days on the rows are due, but the desk's remote cannot be reached: every row waits, and none is dropped.
  const now = T0 + 2 * DAY + 3 * HOUR
  await scan(now)
  const origin = git(w.deskRoot, ["remote", "get-url", "origin"])
  git(w.deskRoot, ["remote", "set-url", "origin", path.join(w.deskRoot, "no-such-remote")])
  assert.equal(await fetches(async () => { plan = await planTriage(w.env, { store: STORE, now }) }), 1)
  assert.deepEqual([plan.attest, plan.held, plan.work, Object.keys(plan.state.rows).sort()], [[], { triage_desk_not_fetched: 3 }, false, [...ids].sort()])
  // Reachable again: one fetch for the three rows of this desk, and the fresh copy says the first review no longer stands.
  git(w.deskRoot, ["remote", "set-url", "origin", origin])
  assert.equal(await fetches(async () => { plan = await planTriage(w.env, { store: STORE, now }) }), 1)
  assert.deepEqual([[...plan.attest].sort(), plan.held, Object.keys(plan.state.rows).sort()], [[ids[1], ids[2]].sort(), {}, [ids[1], ids[2]].sort()])
})

test("a_dropped_row_is_not_current_until_its_newer_revision_is_delivered_or_it_ages_out", async () => {
  const { w, ids, hub, scan } = await deliveredWorld(KEYS.slice(0, 2))
  const told = async (now) => {
    const entry = (await readStatus(w.env)).triage_publication[STORE]
    return [entry.rows_dropped, triagePublicationHealth(entry, now)]
  }
  assert.deepEqual(await told(T0 + 3 * HOUR), [undefined, "current"])
  // Another machine invalidates both cards. Two days on this machine finds its rows no longer stand, and drops them.
  for (const key of KEYS.slice(0, 2)) await invalidateElsewhere(w, key, T0 + DAY)
  await scan(T0 + 2 * DAY + 3 * HOUR)
  await run(w, hub, T0 + 2 * DAY + 3 * HOUR)
  const sent = { revision: 1, attested_at: at(T0 + 2 * HOUR) }
  assert.deepEqual([(await state(w)).rows, (await state(w)).dropped], [{}, { [ids[0]]: sent, [ids[1]]: sent }])
  // The scan's counts go on their own and are delivered. The store still reads both old rows, so this machine does not say `current`.
  assert.equal((await run(w, hub, T0 + 2 * DAY + 4 * HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * DAY + 5 * HOUR)
  assert.deepEqual(await told(T0 + 2 * DAY + 5 * HOUR), [2, "stale"])
  // This machine reviews the second card again and its newer revision is delivered: that row is no longer counted.
  const again = await review(w, KEYS[1], { now: T0 + 2 * DAY + 6 * HOUR })
  await step(w, T0 + 2 * DAY + 6 * HOUR)
  assert.equal((await run(w, hub, T0 + 2 * DAY + 7 * HOUR)).result, "delivered_pr_open")
  assert.equal(hub.settleOpenPr().merged, true)
  await run(w, hub, T0 + 2 * DAY + 8 * HOUR)
  const kept = await state(w)
  assert.deepEqual([again.id, kept.rows[ids[1]].revision > 1, kept.dropped], [ids[1], true, { [ids[0]]: sent }])
  assert.deepEqual(await told(T0 + 2 * DAY + 8 * HOUR), [1, "stale"])
  // Seventy-two hours after the first row was last sent the store reads it as stale whoever looks: it is no longer counted either.
  await run(w, hub, T0 + 2 * HOUR + 3 * DAY)
  assert.deepEqual(await told(T0 + 2 * HOUR + 3 * DAY), [1, "stale"])
  await run(w, hub, T0 + 2 * HOUR + 3 * DAY + 1)
  assert.deepEqual([(await state(w)).dropped, await told(T0 + 2 * HOUR + 3 * DAY + 1)], [{}, [undefined, "current"]])
})

test("a_waiting_record_without_each_rows_card_and_desk_is_not_waiting", async () => {
  const { planTriage } = await load()
  const { w } = await reviewedWorld()
  assert.equal((await prepare(w, T0 + HOUR)).items.length, 1)
  const [batch] = (await state(w)).pending
  const whole = await record(w, batch)
  assert.deepEqual([whole.state, Object.keys(whole.rows[0]).sort(), (await state(w)).requests[KEY].batch], ["pending", ["desk_root", "id", "key", "person_prefix", "revision"], batch])
  // A record that does not say which card and desk each row came from cannot be checked against a route or the desk's remote:
  // it is forgotten, and its request is free to be built again.
  for (const name of ["key", "desk_root", "person_prefix"]) {
    await updateTriageOutbox(w.env, STORE, `${batch}.json`, () => ({ ...whole, rows: whole.rows.map(({ [name]: _gone, ...row }) => row) }))
    await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, pending: [batch], requests: { ...current.requests, [KEY]: { ...current.requests[KEY], batch } } }))
    const plan = await planTriage(w.env, { store: STORE, now: T0 + 2 * HOUR })
    assert.deepEqual([plan.state.pending, plan.state.requests[KEY].batch, plan.candidates.map((candidate) => candidate.key)], [[], undefined, [KEY]], name)
    assert.deepEqual([(await record(w, batch)).state, (await record(w, batch)).reason], ["pending", undefined], `${name}: forgotten, not taken apart`)
  }
  // The whole record does count.
  await updateTriageOutbox(w.env, STORE, `${batch}.json`, () => whole)
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, pending: [batch], requests: { ...current.requests, [KEY]: { ...current.requests[KEY], batch } } }))
  const plan = await planTriage(w.env, { store: STORE, now: T0 + 2 * HOUR })
  assert.deepEqual([plan.state.pending, plan.candidates], [[batch], []])
})

test("a_delivered_row_stands_only_at_its_revision_and_only_as_a_review", async () => {
  const { planTriage } = await load()
  const { w, ids, scan } = await deliveredWorld(KEYS)
  const now = T0 + 2 * DAY + 3 * HOUR
  await scan(now)
  // The remote holds the first card's annotation at revision 2, invalidated, and the other two at revision 1, reviewed.
  await invalidateElsewhere(w, KEYS[0], T0 + DAY)
  assert.deepEqual((await Promise.all(KEYS.map((key) => annotationOf(w, key)))).map((annotation) => [annotation.revision, annotation.attempt.state]), [[2, "stale"], [1, "reviewed"], [1, "reviewed"]])
  // The first row's revision is the remote's, and only the state differs. The second row's state is the remote's, and only the revision differs.
  await updateTriageOutbox(w.env, STORE, "state.json", (current) => ({ ...current, rows: { ...current.rows, [ids[0]]: { ...current.rows[ids[0]], revision: 2 }, [ids[1]]: { ...current.rows[ids[1]], revision: 2 } } }))
  const plan = await planTriage(w.env, { store: STORE, now })
  assert.deepEqual([plan.attest, Object.keys(plan.state.rows), Object.keys(plan.state.dropped).sort()], [[ids[2]], [ids[2]], [ids[0], ids[1]].sort()])
})
