import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { mkTempRoot } from "../_temp_roots.js"
import { openImprovement, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { validateTriageBytes, validateTriageResultBytes } from "../../../../../plugins/desk/mcp/src/factory/triage-schema.js"
import { readTriageBasis } from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"
import { writeProtectedTriageFile } from "../../../../../plugins/desk/mcp/src/factory/triage-write.js"
import {
  compareIdentities, protectedBasisRecord, readAcknowledgedAnnotations, readProtectedBasis, refreshTriage, resolveAcknowledgedTriage,
  selectTriageCards, toSafeTriageReview, triagePaths, validateSafeTriageReview, validateTriageAnnotation, validateTriageIdentities,
} from "../../../../../plugins/desk/mcp/src/factory/triage-state.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v12-triage-local.json", import.meta.url)))
const KEY = fixture.key
const T0 = Date.parse("2026-10-11T12:00:00.000Z")
const HOUR = 3600 * 1000
const bytes = (value) => `${JSON.stringify(value)}\n`
const hex = (n) => randomBytes(n).toString("hex")
const resolveIssue = async (pointer) => ({ revision: 3, public: { kind: "issue", ref: `https://github.com/example-org/example-repo/issues/${pointer.split("#")[1]}`, revision: 3 } })

function stateEnv(base) {
  return { ...process.env, XDG_STATE_HOME: path.join(base, "state") }
}

function annotationFor({ key = KEY, revision = 1, basis, review = fixture.safe_review, state = "reviewed", reason = "review_accepted", token = hex(16) }) {
  return {
    schema: "desk.factory.triage-local/1", key, revision,
    basis: { generation: hex(16), canonical_revision: basis.canonical_revision, public_evidence_revisions: basis.public_evidence_revisions, protected_basis: token },
    review, attempt: { state, at: new Date(T0).toISOString(), reason },
  }
}

test("twenty_refusals_do_not_hide_new_card", () => {
  const cards = []
  const attempts = {}
  // Twenty old cards, each attempted and refused on its current basis, the oldest card attempted most recently.
  for (let index = 0; index < 20; index += 1) {
    const key = `andon:example-org/repo#${100 + index}`
    cards.push({ key, opened_at: new Date(T0 - (100 - index) * HOUR).toISOString(), fingerprint: `f${index}` })
    attempts[key] = { at: new Date(T0 - (index + 1) * 60000).toISOString(), state: "refused", fingerprint: `f${index}`, review_fingerprint: null }
  }
  const newcomer = { key: "andon:example-org/repo#999", opened_at: new Date(T0).toISOString(), fingerprint: "new" }
  cards.push(newcomer)
  const first = selectTriageCards({ cards, attempts, now: T0 })
  assert.equal(first.selected[0].key, newcomer.key, "the never-attempted card goes first")
  assert.equal(first.selected.length, 20)
  assert.equal(first.deferred.length, 1)
  // Retries order by last attempt time, not by the card's original age: the card attempted longest ago is first.
  assert.deepEqual(first.selected.slice(1, 4).map((card) => card.key), ["andon:example-org/repo#119", "andon:example-org/repo#118", "andon:example-org/repo#117"])
  assert.equal(first.deferred[0].key, "andon:example-org/repo#100", "the most recently refused card waits")
  assert.deepEqual(first.coverage, { reviewed: 0, unreviewed: 21, refused: 20, deferred: 1, more_unreviewed: true })
  assert.deepEqual(Object.keys(first.selected[0]).sort(), ["fingerprint", "key", "opened_at"], "no ordering bookkeeping leaks out")

  // Next run: the newcomer was refused too; now every card rotates by last attempt, the newcomer last.
  attempts[newcomer.key] = { at: new Date(T0 + 1000).toISOString(), state: "refused", fingerprint: "new", review_fingerprint: null }
  const second = selectTriageCards({ cards, attempts: new Map(Object.entries(attempts)), now: T0 + 2000 })
  assert.equal(second.selected[0].key, "andon:example-org/repo#119")
  assert.equal(second.deferred[0].key, newcomer.key)

  // A future attempt time counts as now; equal times order by key.
  const tie = selectTriageCards({
    cards: [{ key: "andon:b/b#2", opened_at: "x", fingerprint: "b" }, { key: "andon:a/a#1", opened_at: "x", fingerprint: "a" }],
    attempts: {
      "andon:b/b#2": { at: new Date(T0 + 99 * HOUR).toISOString(), state: "deferred", fingerprint: "b", review_fingerprint: null },
      "andon:a/a#1": { at: new Date(T0).toISOString(), state: "deferred", fingerprint: "a", review_fingerprint: null },
    },
    now: T0,
  })
  assert.deepEqual(tie.selected.map((card) => card.key), ["andon:a/a#1", "andon:b/b#2"])
  assert.equal(tie.coverage.refused, 0, "deferred is not refused")
})

test("eligible_fresh_cards_order_unreviewed_before_stale_then_attempt_and_age", () => {
  const cards = [
    { key: "andon:o/r#1", opened_at: new Date(T0 - 5 * HOUR).toISOString(), fingerprint: "stale-now" },
    { key: "andon:o/r#2", opened_at: new Date(T0 - 1 * HOUR).toISOString(), fingerprint: "u2" },
    { key: "andon:o/r#3", opened_at: new Date(T0 - 9 * HOUR).toISOString(), fingerprint: "u3" },
    { key: "andon:o/r#4", opened_at: new Date(T0 - 9 * HOUR).toISOString(), fingerprint: "u4" },
    { key: "andon:o/r#5", opened_at: new Date(T0).toISOString(), fingerprint: "fresh" },
    { key: "andon:o/r#6", opened_at: new Date(T0).toISOString(), fingerprint: "changed" },
  ]
  const attempts = {
    "andon:o/r#1": { at: new Date(T0 - 3 * HOUR).toISOString(), state: "reviewed", fingerprint: "old", review_fingerprint: "old" },
    "andon:o/r#5": { at: new Date(T0 - 3 * HOUR).toISOString(), state: "reviewed", fingerprint: "fresh", review_fingerprint: "fresh" },
    // Refused on an older basis; its basis changed since, so it is fresh work again, not a retry.
    "andon:o/r#6": { at: new Date(T0 - 2 * HOUR).toISOString(), state: "refused", fingerprint: "before", review_fingerprint: null },
  }
  const result = selectTriageCards({ cards, attempts, now: T0, limit: 3 })
  assert.deepEqual(result.selected.map((card) => card.key), ["andon:o/r#3", "andon:o/r#4", "andon:o/r#2"], "never attempted, oldest card first, then key")
  assert.deepEqual(result.deferred.map((card) => card.key), ["andon:o/r#6", "andon:o/r#1"], "older attempt next; a stale reviewed card after every unreviewed one")
  assert.deepEqual(result.coverage, { reviewed: 1, unreviewed: 5, refused: 0, deferred: 2, more_unreviewed: true })
  assert.deepEqual(selectTriageCards({ cards: [], now: T0 }).coverage, { reviewed: 0, unreviewed: 0, refused: 0, deferred: 0, more_unreviewed: false })
  // An unreadable card time sorts first rather than last; equal cards order by key whichever way they arrive.
  const odd = [{ key: "andon:o/r#8", opened_at: "not a time", fingerprint: "x" }, { key: "andon:o/r#7", opened_at: new Date(T0).toISOString(), fingerprint: "y" }]
  assert.deepEqual(selectTriageCards({ cards: odd, now: T0 }).selected.map((card) => card.key), ["andon:o/r#8", "andon:o/r#7"])
  const same = (keys) => keys.map((key) => ({ key, opened_at: new Date(T0).toISOString(), fingerprint: key }))
  assert.deepEqual(selectTriageCards({ cards: same(["andon:o/r#b", "andon:o/r#a", "andon:o/r#c"]), now: T0 }).selected.map((card) => card.key), ["andon:o/r#a", "andon:o/r#b", "andon:o/r#c"])
  assert.deepEqual(selectTriageCards({ cards: same(["andon:o/r#a", "andon:o/r#c", "andon:o/r#b"]), now: T0 }).selected.map((card) => card.key), ["andon:o/r#a", "andon:o/r#b", "andon:o/r#c"])
})

test("valid_private_result_never_enters_git_review", () => {
  const result = fixture.private_candidate.result
  const brief = {
    batch: "0123456789abcdef", producer_version: "1.4.0", rubric_version: 1,
    cards: [
      { key: KEY, basis: "candidate-basis-token-1", evidence_ids: ["evidence:0", "evidence:1"], ruling_ids: [], authority_codes: ["investigation_only", "human_gate"] },
      { key: fixture.related_key, basis: "other", evidence_ids: [], ruling_ids: [], authority_codes: ["investigation_only", "human_gate"] },
    ],
  }
  const checked = validateTriageResultBytes(bytes({ schema: "desk.factory.triage-result/1", batch: brief.batch, rubric_version: 1, producer_version: "1.4.0", results: [result] }), { brief })
  assert.equal(checked.ok, true, "the private candidate is fully valid protected data")
  const basis = { key: KEY, producer_version: "1.4.0-alpha.6", rubric_version: 1 }
  const token = hex(16)
  const safe = toSafeTriageReview({ result: checked.valid[0], basis, authorizedEvidence: fixture.private_candidate.authorized_evidence, protectedToken: token })
  assert.equal(safe.state, "safe")
  assert.deepEqual(safe.review, {
    route: "human_decision", gate: "irreversible", authority_code: "human_gate",
    summary_codes: ["source:andon", "route:human_decision", "gate:irreversible", "detail_not_authorized_for_git"],
    evidence: [{ kind: "issue", ref: "https://github.com/example-org/example-repo/issues/101", revision: 3 }],
    related_keys: [fixture.related_key], duplicate_keys: [], producer_version: "1.4.0-alpha.6", rubric_version: 1, protected_result: token,
  })
  const annotation = annotationFor({ basis: { canonical_revision: "a".repeat(40), public_evidence_revisions: [] }, review: safe.review })
  const blob = bytes(annotation)
  for (const sentinel of fixture.private_candidate.sentinels) assert.equal(blob.includes(sentinel), false, sentinel)
  assert.equal(blob.includes("private-repo"), false, "an evidence pointer without Git authorization is withheld")
  assert.equal(validateTriageAnnotation(blob).ok, true)
  // The safe review is not a public row either.
  assert.equal(validateTriageBytes(blob).ok, false)

  // Refusals carry no review, so nothing partial can be written.
  for (const [input, code] of [
    [{ result: { ...result, key: fixture.related_key }, basis, protectedToken: token }, "key_mismatch"],
    [{ result: null, basis, protectedToken: token }, "type"],
    [{ result, basis: null, protectedToken: token }, "type"],
  ]) assert.deepEqual(toSafeTriageReview(input), { state: "refused", review: null, errors: [{ code, path: "" }] })
  const badToken = toSafeTriageReview({ result, basis, protectedToken: "private digest" })
  assert.equal(badToken.state, "refused")
  assert.equal(badToken.review, null)
  // Odd shapes in an unvalidated row are refused, never coerced into prose.
  const odd = toSafeTriageReview({ result: { key: KEY, route: "agent_ready", authority: null, evidence: "x", related: null, duplicates: null }, basis, protectedToken: token })
  assert.equal(odd.state, "refused")
  // An investigation keeps its authorized pointer and no gate.
  const investigate = toSafeTriageReview({
    result: { ...result, route: "investigate", authority: { code: "investigation_only", ruling_ids: [] }, evidence: ["evidence:0", "evidence:0"], related: [], duplicates: [{ key: fixture.related_key }], decision: null, gate_reason: null },
    basis, authorizedEvidence: [...fixture.private_candidate.authorized_evidence, { id: "evidence:9", kind: "issue", ref: "not a url", revision: 1, git_safe: true }], protectedToken: token,
  })
  assert.equal(investigate.state, "safe")
  assert.deepEqual(investigate.review.summary_codes, ["source:andon", "route:investigate"])
  assert.equal(investigate.review.evidence.length, 1)
  assert.deepEqual(investigate.review.duplicate_keys, [fixture.related_key])
  const withheld = toSafeTriageReview({ result: { ...result, evidence: ["evidence:9"] }, basis, authorizedEvidence: [{ id: "evidence:9", kind: "issue", ref: "not a url", revision: 1, git_safe: true }], protectedToken: token })
  assert.ok(withheld.review.summary_codes.includes("detail_not_authorized_for_git"))
})

test("safe_review_annotation_and_registry_are_closed_shapes", () => {
  assert.deepEqual(validateSafeTriageReview(fixture.safe_review), { ok: true, errors: [] })
  for (const { name, patch, code } of fixture.invalid_reviews) {
    const checked = validateSafeTriageReview({ ...fixture.safe_review, ...patch })
    assert.equal(checked.ok, false, name)
    assert.ok(checked.errors.some((error) => error.code === code), `${name}: ${JSON.stringify(checked.errors)}`)
  }
  assert.equal(validateSafeTriageReview({ ...fixture.safe_review, related_keys: [fixture.related_key, fixture.related_key] }).ok, false)
  assert.equal(validateSafeTriageReview(null).ok, false)

  const good = annotationFor({ basis: { canonical_revision: "b".repeat(40), public_evidence_revisions: [] } })
  assert.equal(validateTriageAnnotation(bytes(good)).ok, true)
  assert.deepEqual(validateTriageAnnotation(bytes(good)).value, good)
  for (const [name, value, code] of [
    ["reviewed without review", { ...good, review: null }, "inconsistent"],
    ["withdrawn with review", { ...good, attempt: { ...good.attempt, state: "withdrawn", reason: "card_removed" } }, "inconsistent"],
    ["withdrawn with a card revision", { ...good, review: null, attempt: { ...good.attempt, state: "withdrawn", reason: "card_removed" } }, "inconsistent"],
    ["prose reason", { ...good, attempt: { ...good.attempt, reason: "the model crashed with /Users/x" } }, "enum"],
    ["bad revision", { ...good, basis: { ...good.basis, canonical_revision: "HEAD" } }, "pattern"],
    ["damaged review", { ...good, review: { ...good.review, route: "ship_it" } }, "enum"],
    ["extra field", { ...good, problem: "private" }, "unknown_key"],
  ]) {
    const checked = validateTriageAnnotation(bytes(value))
    assert.equal(checked.ok, false, name)
    assert.equal(checked.value, undefined)
    assert.ok(checked.errors.some((error) => error.code === code), `${name}: ${JSON.stringify(checked.errors)}`)
  }
  assert.equal(validateTriageAnnotation(JSON.stringify(good, null, 2)).ok, false, "noncanonical bytes")
  const withdrawn = { ...good, review: null, basis: { ...good.basis, canonical_revision: null }, attempt: { ...good.attempt, state: "withdrawn", reason: "card_removed" } }
  assert.equal(validateTriageAnnotation(bytes(withdrawn)).ok, true)

  const entries = [
    { key: "andon:a/a#1", store: "example-org/b", id: hex(16), revision: 2, public_basis: null },
    { key: "andon:a/a#1", store: "example-org/c", id: hex(16), revision: 1, public_basis: hex(16) },
    { key: "andon:b/b#1", store: "example-org/a", id: hex(16), revision: 1, public_basis: null },
  ]
  const registry = { schema: "desk.factory.triage-identities/1", entries }
  assert.equal(validateTriageIdentities(bytes(registry)).ok, true)
  assert.deepEqual([...entries].reverse().sort(compareIdentities), entries)
  assert.equal(compareIdentities(entries[0], entries[0]), 0)
  assert.equal(compareIdentities(entries[0], entries[2]), -1)
  assert.equal(compareIdentities(entries[2], entries[0]), 1)
  assert.equal(compareIdentities(entries[0], entries[1]), -1)
  assert.equal(compareIdentities(entries[1], entries[0]), 1)
  for (const [name, value, code] of [
    ["unsorted", { ...registry, entries: [entries[1], entries[0], entries[2]] }, "order"],
    ["same card and store twice", { ...registry, entries: [entries[0], { ...entries[0], id: hex(16) }] }, "order"],
    ["one ID for two cards", { ...registry, entries: [entries[0], { ...entries[2], id: entries[0].id }] }, "duplicate"],
    ["uppercase store", { ...registry, entries: [{ ...entries[0], store: "Example-Org/b" }] }, "pattern"],
    ["prose public basis", { ...registry, entries: [{ ...entries[0], public_basis: "a review" }] }, "pattern"],
    ["unsafe revision", { ...registry, entries: [{ ...entries[0], revision: Number.MAX_SAFE_INTEGER + 2 }] }, "range"],
  ]) {
    const checked = validateTriageIdentities(bytes(value))
    assert.equal(checked.ok, false, name)
    assert.ok(checked.errors.some((error) => error.code === code), `${name}: ${JSON.stringify(checked.errors)}`)
  }
})

async function fileDesk(base, cards) {
  const deskRoot = path.join(base, "desk")
  await fs.mkdir(deskRoot)
  await fs.writeFile(path.join(deskRoot, "AGENTS.md"), "Existing scope covers factory defects.\n")
  const files = {}
  for (const key of cards) {
    const opened = await openImprovement({ deskRoot, personPrefix: "", key, source: "andon", evidence: [`issue:${key.slice(6)}`], plugin: "desk", signal: null, now: T0 })
    files[key] = opened.file
  }
  return { deskRoot, files }
}

// A reviewed annotation as an acknowledged write leaves it: the annotation file plus its protected basis in factory state.
async function reviewed(env, deskRoot, key, options = {}) {
  const read = await readTriageBasis({ deskRoot, personPrefix: "", key, now: T0, evidence: { resolve: resolveIssue } })
  const token = hex(16)
  if (options.protectedBasis !== false) await writeProtectedTriageFile(env, ["basis", `${token}.json`], bytes(protectedBasisRecord(token, read.basis)))
  const value = annotationFor({ key, basis: read.basis, token, ...options.annotation })
  const paths = triagePaths(deskRoot, "", key)
  await fs.mkdir(path.join(deskRoot, paths.dir), { recursive: true })
  await fs.writeFile(path.join(deskRoot, paths.annotation), bytes(value))
  return { value, token, basis: read.basis }
}

test("mechanical_refresh_invalidates_withdraws_or_holds_without_an_agent", async () => {
  const base = await mkTempRoot("triage-refresh-")
  const env = stateEnv(base)
  const keys = ["andon:o/fresh#1", "andon:o/claimed#2", "andon:o/removed#3", "andon:o/corrupt#4", "andon:o/elsewhere#5", "andon:o/stale#6", "andon:o/gone#7", "andon:o/new#8"]
  const { deskRoot, files } = await fileDesk(base, keys)
  const claimText = (text) => text.replace('state: "open"', 'state: "claimed"').replace("claim: null", `claim: ${JSON.stringify({ claim_id: randomUUID(), claimed_at: new Date(T0).toISOString(), expires_at: new Date(T0 + HOUR).toISOString(), machine: "abcdef0123456789", session: null })}`)
  await fs.writeFile(files["andon:o/claimed#2"], claimText(await fs.readFile(files["andon:o/claimed#2"], "utf8")))
  const fresh = await reviewed(env, deskRoot, "andon:o/fresh#1")
  const claimed = await reviewed(env, deskRoot, "andon:o/claimed#2")
  await reviewed(env, deskRoot, "andon:o/removed#3")
  await reviewed(env, deskRoot, "andon:o/corrupt#4")
  await reviewed(env, deskRoot, "andon:o/elsewhere#5", { protectedBasis: false })
  await reviewed(env, deskRoot, "andon:o/stale#6", { annotation: { state: "stale", reason: "basis_changed" } })
  await reviewed(env, deskRoot, "andon:o/gone#7", { annotation: { state: "withdrawn", reason: "card_removed", review: null, basis: { canonical_revision: null, public_evidence_revisions: [] } } })
  await fs.unlink(files["andon:o/removed#3"])
  await fs.unlink(files["andon:o/gone#7"])
  await fs.writeFile(files["andon:o/corrupt#4"], "not a card\n")
  // A damaged annotation file and an annotation filed under the wrong name are counted, not trusted.
  const dir = path.join(deskRoot, triagePaths(deskRoot, "").dir)
  await fs.writeFile(path.join(dir, "andon--000000000000.json"), "{}\n")
  await fs.writeFile(path.join(dir, "notes.txt"), "ignored\n")
  await fs.writeFile(path.join(dir, "andon--111111111111.json"), bytes(fresh.value))
  await fs.mkdir(path.join(dir, "andon--222222222222.json"))
  assert.equal(readAcknowledgedAnnotations({ deskRoot, personPrefix: "" }).damaged, 3)
  assert.equal(readAcknowledgedAnnotations({ deskRoot, personPrefix: "" }).source, "files")
  assert.deepEqual(await readProtectedBasis(env, fresh.token), fresh.basis)

  const result = await refreshTriage({ env, deskRoot, personPrefix: "", now: T0 + 2 * HOUR })
  assert.equal(result.state, "complete")
  const byKey = Object.fromEntries(result.changes.map((change) => [change.key, change]))
  assert.deepEqual(byKey["andon:o/claimed#2"], { key: "andon:o/claimed#2", operation: "invalidate", reason: "claim_changed" })
  assert.deepEqual(byKey["andon:o/removed#3"], { key: "andon:o/removed#3", operation: "withdraw", reason: "card_removed" })
  assert.deepEqual(byKey["andon:o/corrupt#4"], { key: "andon:o/corrupt#4", operation: null, state: "source_unknown", reason: "source_incomplete" })
  assert.deepEqual(byKey["andon:o/elsewhere#5"], { key: "andon:o/elsewhere#5", operation: null, state: "stale", reason: "protected_basis_unavailable" })
  assert.equal(result.changes.length, 4, "fresh, already stale and withdrawn annotations need no change")
  assert.deepEqual(result.coverage, { scan: "complete", reviewed: 1, unreviewed: 4, refused: null, deferred: null, more_unreviewed: true })
  assert.equal(claimed.basis.claim.state, "live")

  // Revoked authority with identical card bytes invalidates the fresh one too.
  await fs.writeFile(path.join(deskRoot, "AGENTS.md"), "Scope revoked.\n")
  const revoked = await refreshTriage({ env, deskRoot, personPrefix: "", now: T0 })
  assert.ok(revoked.changes.some((change) => change.key === "andon:o/fresh#1" && change.operation === "invalidate" && change.reason === "authority_changed"))

  // A truncated or unreadable read never asserts removal.
  const truncated = await refreshTriage({ env, deskRoot, personPrefix: "", now: T0, readCards: async (args) => ({ ...(await readCards(args)), truncated: true }) })
  assert.equal(truncated.state, "truncated")
  assert.ok(truncated.changes.every((change) => change.operation !== "withdraw"))
  assert.equal(truncated.coverage.more_unreviewed, null)
  const unreadable = await refreshTriage({ env, deskRoot, personPrefix: "", now: T0, readCards: async () => ({ cards: [], truncated: false, unreadable: true }) })
  assert.equal(unreadable.state, "unreadable")
  assert.equal(unreadable.coverage.unreviewed, null)
  assert.ok(unreadable.changes.every((change) => change.operation === null && change.state === "source_unknown"))
  // A card that vanishes between the listing and the basis check is unknown, not removed.
  const racing = await refreshTriage({
    env, deskRoot, personPrefix: "", now: T0,
    readCards: async (args) => {
      const listing = await readCards(args)
      return { ...listing, cards: [...listing.cards, { key: "andon:o/removed#3", state: "open" }] }
    },
  })
  assert.deepEqual(racing.changes.find((change) => change.key === "andon:o/removed#3"), { key: "andon:o/removed#3", operation: null, state: "source_unknown", reason: "source_incomplete" })
})

test("protected_basis_is_absent_on_another_host", async () => {
  const base = await mkTempRoot("triage-protected-")
  assert.equal(await readProtectedBasis(stateEnv(base), hex(16)), null, "no factory state at all")
  assert.equal(await readProtectedBasis(stateEnv(base), "../escape"), null)
  const env = stateEnv(base)
  const token = hex(16)
  await writeProtectedTriageFile(env, ["basis", `${token}.json`], "{not json\n")
  assert.equal(await readProtectedBasis(env, token), null)
  const other = hex(16)
  await writeProtectedTriageFile(env, ["basis", `${other}.json`], bytes(protectedBasisRecord(token, { key: KEY })))
  assert.equal(await readProtectedBasis(env, other), null, "a record filed under another token is not trusted")
  assert.equal(await readProtectedBasis(env, hex(16)), null)
})

test("resolver_never_guesses_a_local_key", async () => {
  const base = await mkTempRoot("triage-resolve-")
  const { deskRoot } = await fileDesk(base, [KEY])
  const paths = triagePaths(deskRoot, "", KEY)
  await fs.mkdir(path.join(deskRoot, paths.dir), { recursive: true })
  const id = hex(16)
  const protectedResult = hex(16)
  const review = { ...fixture.safe_review, protected_result: protectedResult }
  await fs.writeFile(path.join(deskRoot, paths.registry), bytes({ schema: "desk.factory.triage-identities/1", entries: [{ key: KEY, store: "example-org/example-store", id, revision: 2, public_basis: null }] }))
  await fs.writeFile(path.join(deskRoot, paths.annotation), bytes(annotationFor({ revision: 2, basis: { canonical_revision: "c".repeat(40), public_evidence_revisions: [] }, review })))
  const resolve = (overrides) => resolveAcknowledgedTriage({ deskRoot, personPrefix: "", store: "Example-Org/Example-Store", id, revision: 2, ...overrides })
  assert.deepEqual(resolve({}), { state: "resolved", key: KEY, protected_result: protectedResult })
  assert.deepEqual(resolve({ store: "example-org/other-store" }), { state: "not_resolved" })
  assert.deepEqual(resolve({ id: hex(16) }), { state: "not_resolved" })
  assert.deepEqual(resolve({ revision: 1 }), { state: "stale", key: KEY })
  assert.deepEqual(resolve({ revision: 3 }), { state: "not_resolved" })
  for (const bad of [{ id: "ID" }, { store: 7 }, { revision: 1.5 }, { personPrefix: "../x" }]) assert.deepEqual(resolve(bad), { state: "not_resolved" })
  await fs.writeFile(path.join(deskRoot, paths.annotation), bytes(annotationFor({ revision: 2, basis: { canonical_revision: "c".repeat(40), public_evidence_revisions: [] }, review, state: "stale", reason: "basis_changed" })))
  assert.deepEqual(resolve({}), { state: "stale", key: KEY })
  await fs.rename(path.join(deskRoot, paths.annotation), path.join(deskRoot, `${paths.annotation}.away`))
  assert.deepEqual(resolve({}), { state: "stale", key: KEY }, "an identity whose annotation is gone is not resolved")
  await fs.rename(path.join(deskRoot, `${paths.annotation}.away`), path.join(deskRoot, paths.annotation))
  await fs.writeFile(path.join(deskRoot, paths.registry), "{damaged")
  assert.deepEqual(resolve({}), { state: "not_resolved" })
  await fs.unlink(path.join(deskRoot, paths.registry))
  assert.deepEqual(resolve({}), { state: "not_resolved" })
  assert.equal(readAcknowledgedAnnotations({ deskRoot: path.join(base, "nowhere"), personPrefix: "" }).annotations.length, 0)
})
