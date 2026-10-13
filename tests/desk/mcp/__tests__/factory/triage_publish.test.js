// The public triage projection: an acknowledged local annotation becomes the bytes of one `triage/<batch>.json`, and nothing
// that is not acknowledged, consented and positively public ever does. Every input here is synthetic; the public cases are the
// paired `v12-triage.json` fixture the store's own tests read.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

import "../_isolated_env.mjs"
import { gitBlobSha } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { validateTriageBytes, validateTriageChange } from "../../../../../plugins/desk/mcp/src/factory/triage-schema.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/factory/triage-publish.js", import.meta.url)
async function load() {
  assert.ok(existsSync(moduleUrl), "the triage publication module must exist")
  return import(moduleUrl)
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json", import.meta.url), "utf8"))
const caseOf = (name) => fixture.cases.find((item) => item.name === name)
const STORE = "Example-Org/Example-Store"
const NOW = Date.parse("2026-10-12T12:00:00.000Z")
const HOUR = 3600 * 1000
const CARD_BLOB = "c".repeat(40)
const canonical = (value) => Buffer.from(`${JSON.stringify(value)}\n`)
const PUBLIC_ROW = fixture.public.rows[0]
const ROW_KEYS = ["id", "revision", "state", "source", "lifecycle", "ownership", "route", "gate", "evidence", "basis", "related_ids", "duplicate_ids", "age", "producer_version", "rubric_version"]

const reviewOf = (source, patch = {}) => ({
  route: "human_decision", gate: "intent", authority_code: "human_gate", summary_codes: [`source:${source}`, "route:human_decision", "gate:intent"],
  evidence: [], related_keys: [], duplicate_keys: [], producer_version: "1.4.0", rubric_version: 1, protected_result: "9".repeat(32), ...patch,
})

/**
 * One acknowledged card: its annotation, the registry and the readback that binds both, plus everything else `triageFor` takes.
 * `others` adds registry entries; `annotation`, `entry` and `review` patch the defaults.
 */
function acknowledged({ key = "evaluator:synthetic-finding", review = {}, annotation = {}, entry = {}, others = [] } = {}) {
  const source = key.slice(0, key.indexOf(":"))
  const value = {
    schema: "desk.factory.triage-local/1", key, revision: 1,
    basis: { generation: PUBLIC_ROW.basis.generation, canonical_revision: CARD_BLOB, public_evidence_revisions: [], protected_basis: "8".repeat(32) },
    review: review === null ? null : reviewOf(source, review),
    attempt: { state: "reviewed", at: new Date(NOW - HOUR).toISOString(), reason: "review_accepted" },
    ...annotation,
  }
  const entries = [{ key, store: STORE.toLowerCase(), id: PUBLIC_ROW.id, revision: value.revision, public_basis: null, ...entry }, ...others]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.store < b.store ? -1 : 1))
  const identity = { schema: "desk.factory.triage-identities/1", entries }
  return {
    annotation: value,
    identity,
    ack: { remote: "origin", ref: "refs/heads/main", commit: "a".repeat(40), registry_blob: gitBlobSha(canonical(identity)), annotation_blob: gitBlobSha(canonical(value)) },
    store: STORE,
    consent: { contribute: true, account: "someone" },
    visibility: new Map([[STORE.toLowerCase(), "public"]]),
    publicEvidence: [],
    coverage: fixture.public.coverage,
    runner: fixture.public.runner,
    card: { state: "open", claimed: false, revision: CARD_BLOB },
    batch: fixture.public.batch,
    producerVersion: fixture.public.producer_version,
  }
}

const rowOf = (out) => JSON.parse(out.bytes.toString("utf8")).rows[0]

test("unacknowledged_and_private_outputs_never_emit", async () => {
  const { triageFor } = await load()
  const good = acknowledged()
  const emitted = triageFor(good)
  assert.deepEqual(Object.keys(emitted), ["path", "bytes", "sha"], JSON.stringify(emitted))
  assert.equal(emitted.path, `triage/${fixture.public.batch}.json`)
  assert.equal(emitted.sha, gitBlobSha(emitted.bytes))
  const held = (patch, code, why) => assert.deepEqual(triageFor({ ...good, ...patch }), { held: code }, why)

  // A local commit: the annotation differs from the blob the remote's main was read back with.
  const edited = { ...good.annotation, attempt: { ...good.annotation.attempt, at: new Date(NOW).toISOString() } }
  held({ annotation: edited }, "unacknowledged", "an annotation edited after the readback")
  // A failed push: there is no readback, or one that is not the remote's main.
  held({ ack: undefined }, "unacknowledged", "no readback")
  held({ ack: { ...good.ack, ref: "refs/heads/desk-triage/0123" } }, "unacknowledged", "a readback of another ref")
  held({ ack: { ...good.ack, remote: "backup" } }, "unacknowledged", "a readback of another remote")
  held({ ack: { ...good.ack, commit: "local" } }, "unacknowledged", "a commit that is not an object ID")
  held({ ack: { ...good.ack, annotation_blob: undefined } }, "unacknowledged", "no annotation blob")
  held({ annotation: null }, "unacknowledged", "no annotation")
  // A losing ID: the registry offered is not the acknowledged one, or holds no entry for this card and store.
  const losing = { ...good.identity, entries: good.identity.entries.map((entry) => ({ ...entry, id: "1".repeat(32) })) }
  held({ identity: losing }, "identity_unacknowledged", "a registry that is not the acknowledged blob")
  held({ identity: null }, "identity_unacknowledged", "no registry")
  const elsewhere = acknowledged({ entry: { store: "example-org/another-store" } })
  assert.deepEqual(triageFor(elsewhere), { held: "identity_unacknowledged" }, "an ID acknowledged for another store")
  const behind = acknowledged({ annotation: { revision: 2 }, entry: { revision: 1 } })
  assert.deepEqual(triageFor(behind), { held: "identity_revision_mismatch" }, "an annotation revision this store's entry does not have")
  const unsorted = acknowledged({ others: [{ key: "evaluator:a-first", store: STORE.toLowerCase(), id: PUBLIC_ROW.id, revision: 1, public_basis: null }] })
  assert.deepEqual(triageFor(unsorted), { held: "identity_unacknowledged" }, "a registry that gives one ID to two cards")

  // Unknown store, consent or visibility.
  for (const store of [undefined, "", "not a store", fixture.privacy_sentinels[1]]) held({ store }, "store_unknown", `store ${store}`)
  held({ consent: undefined }, "consent_unknown")
  held({ consent: { account: "someone" } }, "consent_unknown", "a consent record with no decision")
  held({ consent: { contribute: false } }, "not_opted_in")
  held({ visibility: undefined }, "visibility_unknown")
  held({ visibility: { [STORE.toLowerCase()]: "public" } }, "visibility_unknown", "a plain object is not a fresh answer")
  held({ visibility: new Map() }, "visibility_unknown")
  held({ visibility: new Map([[STORE.toLowerCase(), "unknown"]]) }, "visibility_unknown")
  held({ coverage: undefined }, "coverage_unknown")
  held({ runner: undefined }, "runner_unknown")
  held({ producerVersion: null }, "producer_unknown")
  held({ batch: "not-a-batch" }, "projection_invalid")
  held({ batch: 7 }, "projection_invalid")
  held({ coverage: { ...fixture.public.coverage, scan: "guessed" } }, "projection_invalid", "a coverage the public schema refuses")
  // A private store changes nothing about what a row may hold: it is the same closed row.
  for (const visibility of ["private", "internal"]) {
    assert.deepEqual(rowOf(triageFor({ ...good, visibility: new Map([[STORE.toLowerCase(), visibility]]) })), rowOf(emitted))
  }

  // A secret, a path, a name, a title or prose anywhere in the annotation: the annotation is refused whole, never trimmed.
  const [privateKey, privatePath, privateName, secret, prose] = fixture.privacy_sentinels
  const refusedAnnotations = [
    acknowledged({ annotation: { decision: prose } }),
    acknowledged({ review: { decision: prose } }),
    acknowledged({ review: { summary_codes: ["source:evaluator", "route:human_decision", "gate:intent", prose] } }),
    acknowledged({ review: { evidence: [{ kind: "issue", ref: privatePath, revision: 1 }] } }),
    acknowledged({ review: { evidence: [{ kind: "issue", ref: `https://github.com/${secret}/repo/issues/1`, revision: 1 }] } }),
    acknowledged({ review: { related_keys: ["Private title of a card"] } }),
    acknowledged({ review: { protected_result: `sha256:${privateName}` } }),
    acknowledged({ annotation: { key: "A private card title" } }),
  ]
  for (const input of refusedAnnotations) assert.deepEqual(triageFor(input), { held: "annotation_invalid" }, JSON.stringify(input.annotation))
  for (const state of ["not_reviewed", "refused", "deferred", "source_unknown"]) {
    const input = acknowledged({ annotation: { attempt: { state, at: new Date(NOW - HOUR).toISOString(), reason: "review_refused" } } })
    assert.deepEqual(triageFor(input), { held: "annotation_state" }, state)
  }

  // A reversible fingerprint: an ID or a generation that is a digest of the card key, the store or the card.
  const digest = (algorithm, value) => createHash(algorithm).update(value).digest("hex").slice(0, 32)
  const key = good.annotation.key
  for (const id of [digest("sha256", key), digest("sha1", key), digest("md5", key), digest("sha256", `${key}\n${STORE.toLowerCase()}`), digest("sha256", `${STORE.toLowerCase()}\n${key}`), digest("sha256", CARD_BLOB)]) {
    assert.deepEqual(triageFor(acknowledged({ entry: { id } })), { held: "identity_not_random" }, id)
  }
  const fingerprinted = (generation) => acknowledged({ annotation: { basis: { generation, canonical_revision: CARD_BLOB, public_evidence_revisions: [], protected_basis: "8".repeat(32) } } })
  assert.deepEqual(triageFor(fingerprinted(digest("sha256", key))), { held: "basis_not_opaque" })
  assert.deepEqual(triageFor(fingerprinted("8".repeat(32))), { held: "basis_not_opaque" }, "the protected basis token is never the public generation")

  // The card's canonical key, a private one here, is in the annotation and never in the bytes; nor is any other sentinel.
  const privateCard = acknowledged({ key: privateKey, others: [{ key: "friction_candidate:related-card", store: STORE.toLowerCase(), id: "2".repeat(32), revision: 4, public_basis: null }], review: { related_keys: ["friction_candidate:related-card", "friction_candidate:unregistered"], duplicate_keys: ["friction_candidate:related-card"] } })
  const out = triageFor(privateCard)
  const text = out.bytes.toString("utf8")
  for (const sentinel of [...fixture.privacy_sentinels, "friction_candidate:related-card", "8".repeat(32), "9".repeat(32), CARD_BLOB, "someone", "a".repeat(40)]) assert.ok(!text.includes(sentinel), `${sentinel} reached the public bytes`)
  // A related card is named by its own acknowledged public ID for this store; one with none is left out.
  assert.deepEqual(rowOf(out).related_ids, ["2".repeat(32)])
  assert.deepEqual(rowOf(out).duplicate_ids, ["2".repeat(32)])
  assert.equal(rowOf(out).source, "friction_candidate")
  assert.deepEqual(Object.keys(rowOf(out)), ROW_KEYS, "the exact closed row")
})

test("allowed public pointers keep their exact encoding, and any other pointer is left out", async () => {
  const { triageFor, publicEvidenceFor } = await load()
  const issue = { kind: "issue", ref: "https://github.com/Example/Project/issues/1", revision: 1 }
  const pull = { kind: "pr", ref: "https://github.com/example/private-repo/pull/7", revision: 2 }
  const job = { kind: "job", ref: `https://github.com/${STORE}/blob/reports/jobs/${"4".repeat(32)}.md`, revision: 1 }
  const otherJob = { kind: "job", ref: `https://github.com/${STORE}/blob/reports/jobs/${"5".repeat(32)}.md`, revision: 1 }
  const foreignJob = { kind: "job", ref: `https://github.com/example/other-store/blob/reports/jobs/${"4".repeat(32)}.md`, revision: 1 }
  const oddJob = { kind: "job", ref: "https://github.com/example/project/issues/9", revision: 1 }
  const pointers = [issue, pull, job, otherJob, foreignJob, oddJob, { kind: "issue", ref: "not a url", revision: 1 }]
  const visibility = new Map([["example/project", "public"], ["example/private-repo", "private"]])
  // An issue or pull request is public only on a fresh public answer for its repository; a job only when it is a report of this
  // store whose ID the facts this machine delivered there carry.
  const open = publicEvidenceFor({ pointers, store: STORE, visibility, publishedJobs: new Set(["4".repeat(32)]) })
  assert.deepEqual(open, [{ ...issue, visibility: "public" }, { ...job, visibility: "public" }])
  assert.deepEqual(publicEvidenceFor({ pointers: [issue, job], store: STORE, visibility: new Map(), publishedJobs: new Set() }), [])

  const input = acknowledged({ review: { evidence: [issue, pull, job, otherJob] }, annotation: { basis: { generation: PUBLIC_ROW.basis.generation, canonical_revision: CARD_BLOB, public_evidence_revisions: [issue, pull], protected_basis: "8".repeat(32) } } })
  const row = rowOf(triageFor({ ...input, publicEvidence: open }))
  assert.deepEqual(row.evidence, [issue, job], "exactly the pointers as the annotation spells them")
  assert.deepEqual(row.basis.evidence_revisions, [issue])
  // A pointer listed with another revision, or not listed as public, is not the pointer.
  assert.deepEqual(rowOf(triageFor({ ...input, publicEvidence: [{ ...issue, revision: 2, visibility: "public" }, { ...pull, visibility: "private" }, null] })).evidence, [])
  assert.deepEqual(rowOf(triageFor({ ...input, publicEvidence: null })).evidence, [])
  assert.deepEqual(rowOf(triageFor({ ...input, publicEvidence: undefined })).evidence, [])
})

test("private_human_decision_without_public_issue", async () => {
  const { triageFor } = await load()
  assert.deepEqual(Object.keys(caseOf("private_human_decision_without_public_issue")), ["name"], "the case is the fixture's public file as it is")
  const out = triageFor(acknowledged())
  // The producer gives the paired fixture's public file byte for byte, and the immutable-change gate accepts it as a trusted addition.
  assert.equal(out.bytes.toString("utf8"), `${JSON.stringify(fixture.public)}\n`)
  assert.equal(validateTriageBytes(out.bytes).ok, true)
  assert.deepEqual(validateTriageChange({ path: out.path, status: "added", bytes: out.bytes, trustedMaintainer: true }), { ok: true, errors: [] })
  assert.equal(validateTriageChange({ path: out.path, status: "added", bytes: out.bytes, trustedMaintainer: false }).errors[0].code, "triage_untrusted_producer")
  const row = rowOf(out)
  assert.equal(row.route, "human_decision")
  assert.deepEqual(row.evidence, [], "no public issue")
  assert.deepEqual(Object.keys(row), ROW_KEYS, "no decision, recommendation or continuation field exists to fill")
})

test("verified_public_issue_context_no_decision_fields", async () => {
  const { triageFor } = await load()
  const paired = caseOf("verified_public_issue_context_no_decision_fields")
  const input = acknowledged({ review: { evidence: paired.row.evidence }, annotation: { basis: { generation: paired.row.basis.generation, canonical_revision: CARD_BLOB, public_evidence_revisions: paired.row.basis.evidence_revisions, protected_basis: "8".repeat(32) } } })
  // The fixture's own verified public evidence is the only enrichment; its label is the store's to show, never copied into the row.
  const out = triageFor({ ...input, publicEvidence: paired.publicEvidence })
  assert.equal(out.bytes.toString("utf8"), `${JSON.stringify({ ...fixture.public, rows: [{ ...PUBLIC_ROW, ...paired.row }] })}\n`)
  assert.ok(!out.bytes.toString("utf8").includes(paired.publicEvidence[0].label))
  assert.deepEqual(Object.keys(rowOf(out)), ROW_KEYS)
  assert.deepEqual(validateTriageChange({ path: out.path, status: "added", bytes: out.bytes, trustedMaintainer: true }), { ok: true, errors: [] })
})

test("a stale annotation keeps its review as context and a withdrawn one carries none", async () => {
  const { triageFor } = await load()
  const stale = acknowledged({ annotation: { revision: 2, attempt: { state: "stale", at: new Date(NOW - 30 * HOUR).toISOString(), reason: "basis_changed" } }, entry: { revision: 2 } })
  const staleRow = rowOf(triageFor({ ...stale, card: { state: "claimed", claimed: true, revision: CARD_BLOB } }))
  assert.deepEqual([staleRow.state, staleRow.revision, staleRow.route, staleRow.gate, staleRow.age, staleRow.lifecycle, staleRow.ownership], ["stale", 2, "human_decision", "intent", "stale", "claimed", "claimed"])
  // The card's lifecycle is said only from the exact bytes the annotation was made on.
  for (const card of [undefined, null, { state: "shipped", claimed: true, revision: "d".repeat(40) }]) {
    const row = rowOf(triageFor({ ...stale, card }))
    assert.deepEqual([row.lifecycle, row.ownership], [null, "not_published"])
  }
  const withdrawn = acknowledged({
    review: null,
    annotation: { revision: 3, basis: { generation: PUBLIC_ROW.basis.generation, canonical_revision: null, public_evidence_revisions: [], protected_basis: "8".repeat(32) }, attempt: { state: "withdrawn", at: new Date(NOW - 100 * HOUR).toISOString(), reason: "card_removed" } },
    entry: { revision: 3 },
  })
  const row = rowOf(triageFor(withdrawn))
  assert.deepEqual(row, { ...PUBLIC_ROW, ...caseOf("withdrawal").row, revision: 3, lifecycle: null, age: "recent" }, "a row says nothing measured against the clock")
  assert.equal(triageFor({ ...withdrawn, producerVersion: undefined }).held, undefined, "this Desk's own version is the default")
})

test("a batch holds at most twenty rows, names each row it left out and may carry coverage alone", async () => {
  const { triageBatchFor, triageBatchOf, coarseAge } = await load()
  const one = acknowledged()
  const shared = { store: one.store, consent: one.consent, visibility: one.visibility, coverage: one.coverage, runner: one.runner, producerVersion: "1.4.0" }
  const unacknowledged = { ...one, ack: { ...one.ack, commit: "local" } }
  const mixed = triageBatchFor({ ...shared, rows: [unacknowledged, one, null] })
  assert.match(mixed.path, /^triage\/[0-9a-f]{16}\.json$/u, "a random batch ID")
  assert.deepEqual(mixed.rows, [{ id: PUBLIC_ROW.id, revision: 1 }])
  assert.deepEqual(mixed.skipped, [{ index: 0, code: "unacknowledged" }, { index: 2, code: "unacknowledged" }])
  assert.equal(JSON.parse(mixed.bytes.toString("utf8")).rows.length, 1)
  assert.deepEqual(triageBatchFor({ ...shared, rows: [unacknowledged] }), { held: "unacknowledged", skipped: [{ index: 0, code: "unacknowledged" }] })
  // Two rows with one ID are not a batch the public schema accepts.
  assert.deepEqual(triageBatchFor({ ...shared, rows: [one, one] }), { held: "projection_invalid" })
  assert.deepEqual(triageBatchFor({ ...shared, rows: Array.from({ length: 21 }, () => one) }), { held: "projection_invalid" })
  assert.deepEqual(triageBatchFor({ ...shared, rows: "rows" }), { held: "projection_invalid" })
  // No rows: the paired never-reviewed case, coverage and runner only.
  const never = caseOf("empty_never_reviewed")
  const empty = triageBatchFor({ ...shared, rows: [], coverage: { ...fixture.public.coverage, ...never.coverage }, runner: never.runner, batch: fixture.public.batch })
  assert.equal(empty.bytes.toString("utf8"), `${JSON.stringify({ ...fixture.public, coverage: { ...fixture.public.coverage, ...never.coverage }, runner: never.runner, rows: [] })}\n`)
  assert.deepEqual([empty.rows, empty.skipped], [[], []])
  // A row's bytes are the same whenever they are built: a review made years ago is the same row today, and a store reads how old a
  // publication is from commit times. Only an attempt time that is no time is unknown.
  const old = acknowledged({ annotation: { attempt: { state: "reviewed", at: "2020-01-01T00:00:00.000Z", reason: "review_accepted" } } })
  const built = triageBatchFor({ ...shared, rows: [old], batch: fixture.public.batch })
  assert.equal(JSON.parse(built.bytes.toString("utf8")).rows[0].age, "recent")
  assert.deepEqual(triageBatchFor({ ...shared, rows: [old], batch: fixture.public.batch }).bytes, built.bytes, "a pure function of the annotation")
  const timeless = acknowledged({ annotation: { attempt: { state: "reviewed", at: "2026-13-45T00:00:00.000Z", reason: "review_accepted" } } })
  assert.equal(JSON.parse(triageBatchFor({ ...shared, rows: [timeless] }).bytes.toString("utf8")).rows[0].age, "unknown")
  // Rows that were built before go again exactly as they are, in a new file with the coverage of the day.
  const row = JSON.parse(built.bytes.toString("utf8")).rows[0]
  const coverage = { ...fixture.public.coverage, reviewed: 7 }
  const again = triageBatchOf({ ...shared, rows: [row], coverage, batch: "00000000000000aa" })
  assert.deepEqual(JSON.parse(again.bytes.toString("utf8")), { ...fixture.public, batch: "00000000000000aa", coverage, rows: [row] })
  assert.deepEqual([again.path, again.sha], ["triage/00000000000000aa.json", gitBlobSha(again.bytes)])
  assert.match(triageBatchOf({ ...shared, rows: [], producerVersion: undefined }).path, /^triage\/[0-9a-f]{16}\.json$/u, "a random batch ID and this Desk's own version")
  assert.deepEqual(triageBatchOf({ ...shared, rows: [row], consent: { contribute: false } }), { held: "not_opted_in" })
  assert.deepEqual(triageBatchOf({ ...shared, rows: [{ ...row, title: "PRIVATE" }] }), { held: "projection_invalid" }, "a row the public schema refuses")
  assert.deepEqual([coarseAge(0), coarseAge(24 * HOUR), coarseAge(24 * HOUR + 1), coarseAge(72 * HOUR), coarseAge(72 * HOUR + 1), coarseAge(-1), coarseAge(Number.NaN)], ["recent", "recent", "aging", "aging", "stale", "unknown", "unknown"])
})
