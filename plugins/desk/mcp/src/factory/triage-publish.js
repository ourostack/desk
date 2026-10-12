// The public triage projection: the only code that turns acknowledged local triage annotations into the bytes of one
// `triage/<batch>.json` file (`desk.factory.triage/1`, `triage-schema.js`). It builds a row from closed codes, random IDs and
// positively public pointers only; nothing here copies text, a canonical key, a path or a protected token.
//
// A row is emitted only when every one of these holds; otherwise the answer is `{ held: <code> }` and nothing is built:
//   - the store is a repository name, its consent record says `contribute: true`, and its visibility is known (`public`,
//     `private` or `internal`). A private store changes nothing else: protected content never enters a row for any store;
//   - `ack` is a readback of the Desk remote's `main` (`publishOwnedTriage`'s `{remote,ref,commit,registry_blob,annotation_blob}`),
//     the annotation's canonical bytes are exactly the acknowledged annotation blob, and the identity registry's canonical bytes
//     are exactly the acknowledged registry blob. A local commit, a failed push or an edited annotation has no such readback;
//   - the registry holds an entry for this card and this store, at the annotation's revision. A losing ID is not in the
//     acknowledged registry, so it can never be emitted;
//   - the public ID and the basis generation are random, not a digest of the card key or its content;
//   - the annotation is `reviewed`, `stale` or `withdrawn`.
//
// Evidence pointers are kept only when the caller lists the exact pointer (`kind`, `ref`, `revision`) in `publicEvidence` with
// `visibility: "public"`; any other pointer is left out, never guessed, and the row simply carries fewer pointers. The caller
// builds that list from fresh repository visibility and, for a job pointer, from the job IDs `toPublished` gave the facts this
// machine delivered (`publicEvidenceFor`); this file computes no job ID of its own.
//
// The finished bytes pass `validateTriageChange` as a trusted added file, or the answer is `{ held: "projection_invalid" }`.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { createHash, randomBytes } from "node:crypto"

import { gitBlobSha, ownDeskVersion } from "./outbox.js"
import { PATTERNS, isPlainObject } from "./schema.js"
import { validateTriageChange } from "./triage-schema.js"
import { validateTriageAnnotation, validateTriageIdentities } from "./triage-state.js"

const TRIAGE_SCHEMA = "desk.factory.triage/1"
const RUBRIC_VERSION = 1
const MAX_ROWS = 20
const HEX16 = /^[0-9a-f]{16}$/u
const SHA = /^[0-9a-f]{40}$/u
const KNOWN_VISIBILITY = new Set(["public", "private", "internal"])
const HOUR_MS = 60 * 60 * 1000
/** A publication older than this, or one made from an incomplete source, cannot support a current queue (spec 7.2). */
const TRIAGE_FRESH_MS = 72 * HOUR_MS
const RECENT_MS = 24 * HOUR_MS
const ROW_STATES = ["reviewed", "stale", "withdrawn"]
const JOB_REF = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/blob\/reports\/jobs\/([0-9a-f]{32})\.md$/u
const REPO_REF = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/(?:issues|pull)\//u

const canonical = (value) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
const samePointer = (a, b) => a.kind === b.kind && a.ref === b.ref && a.revision === b.revision

/** The coarse age of something `ageMs` old: `recent` (a day), `aging` (three days), `stale` (older), `unknown` (not a past time). */
export function coarseAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown"
  return ageMs <= RECENT_MS ? "recent" : ageMs <= TRIAGE_FRESH_MS ? "aging" : "stale"
}

/**
 * `publicEvidenceFor({ pointers, store, visibility, publishedJobs }) -> [{kind,ref,revision,visibility}]`: the pointers of
 * `pointers` that are positively public now. An issue or pull request pointer is public when `visibility` (repository, lower
 * case, to its fresh answer) says its repository is `public`. A job pointer is public only when it names a report of this
 * `store` and its job ID is one of `publishedJobs`: the IDs `toPublished` gave the facts this machine delivered there, plain
 * or keyed as that transform decided. Everything else is left out.
 */
export function publicEvidenceFor({ pointers, store, visibility, publishedJobs }) {
  const kept = []
  for (const pointer of pointers) {
    const job = pointer.kind === "job" ? JOB_REF.exec(pointer.ref) : null
    const repo = REPO_REF.exec(pointer.ref)?.[1]
    const open = pointer.kind === "job"
      ? job !== null && job[1].toLowerCase() === store.toLowerCase() && publishedJobs.has(job[2])
      : repo !== undefined && visibility.get(repo.toLowerCase()) === "public"
    if (open) kept.push({ kind: pointer.kind, ref: pointer.ref, revision: pointer.revision, visibility: "public" })
  }
  return kept
}

// A public ID or generation that is a digest of the card key, the store or the card's content is a fingerprint, not a random
// token: someone holding the key could confirm it. The digests a careless producer would reach for are refused.
function digestsOf(values) {
  const out = new Set()
  for (const value of values) {
    for (const algorithm of ["sha256", "sha1", "md5"]) out.add(createHash(algorithm).update(value).digest("hex").slice(0, 32))
  }
  return out
}

function rowFor({ annotation, identity, ack, publicEvidence, card }, { store, now, producerVersion }) {
  const hold = (code) => ({ held: code })
  if (!isPlainObject(ack) || ack.remote !== "origin" || ack.ref !== "refs/heads/main" || ![ack.commit, ack.registry_blob, ack.annotation_blob].every((sha) => typeof sha === "string" && SHA.test(sha))) return hold("unacknowledged")
  if (!isPlainObject(annotation) || gitBlobSha(canonical(annotation)) !== ack.annotation_blob) return hold("unacknowledged")
  if (!validateTriageAnnotation(canonical(annotation)).ok) return hold("annotation_invalid")
  if (!isPlainObject(identity) || gitBlobSha(canonical(identity)) !== ack.registry_blob || !validateTriageIdentities(canonical(identity)).ok) return hold("identity_unacknowledged")
  const sameStore = identity.entries.filter((entry) => entry.store === store.toLowerCase())
  const entry = sameStore.find((candidate) => candidate.key === annotation.key)
  if (entry === undefined) return hold("identity_unacknowledged")
  if (entry.revision !== annotation.revision) return hold("identity_revision_mismatch")
  const { key, basis, review, attempt } = annotation
  const digests = digestsOf([key, `${key}\n${entry.store}`, `${entry.store}\n${key}`, String(basis.canonical_revision)])
  if (digests.has(entry.id)) return hold("identity_not_random")
  if (digests.has(basis.generation) || basis.generation === basis.protected_basis) return hold("basis_not_opaque")
  if (!ROW_STATES.includes(attempt.state)) return hold("annotation_state")
  const open = Array.isArray(publicEvidence) ? publicEvidence.filter((item) => isPlainObject(item) && item.visibility === "public") : []
  const kept = (pointers) => pointers.filter((pointer) => open.some((item) => samePointer(item, pointer)))
  const ids = (keys) => keys.map((other) => sameStore.find((candidate) => candidate.key === other)?.id).filter((id) => id !== undefined)
  // The card's lifecycle is published only from the exact card bytes the acknowledged annotation was made on.
  const known = review !== null && isPlainObject(card) && card.revision === basis.canonical_revision
  return {
    row: {
      id: entry.id,
      revision: entry.revision,
      state: attempt.state,
      source: key.slice(0, key.indexOf(":")),
      lifecycle: known ? card.state : null,
      ownership: known && card.claimed === true ? "claimed" : "not_published",
      route: review === null ? null : review.route,
      gate: review === null ? null : review.gate,
      evidence: review === null ? [] : kept(review.evidence),
      basis: { generation: basis.generation, evidence_revisions: kept(basis.public_evidence_revisions) },
      related_ids: review === null ? [] : ids(review.related_keys),
      duplicate_ids: review === null ? [] : ids(review.duplicate_keys),
      // How long ago the acknowledged attempt was, as a class; no time is published.
      age: coarseAge(now - Date.parse(attempt.at)),
      producer_version: review === null ? producerVersion : review.producer_version,
      rubric_version: review === null ? RUBRIC_VERSION : review.rubric_version,
    },
  }
}

/**
 * `triageBatchFor({ rows, store, consent, visibility, coverage, runner, now, batch, producerVersion })
 *   -> { path, bytes, sha, rows: [{id,revision}], skipped: [{index,code}] } | { held: code, skipped? }`.
 *
 * One immutable batch of at most twenty rows. `rows` is `[{ annotation, identity, ack, publicEvidence, card }]` (see
 * `triageFor`); a row that is held is left out and named in `skipped` by its index. A batch whose every row is held is
 * `{ held: <the first row's code>, skipped }`; a hold that is not about one row (the store, consent, visibility, coverage,
 * the runner, this Desk's version or the finished bytes) is `{ held: code }` alone. An empty `rows` builds a batch that
 * carries coverage only. `batch` is the sixteen-hex batch ID (random unless given), `producerVersion` this Desk's version
 * (its own unless given).
 */
export function triageBatchFor({ rows, store, consent, visibility, coverage, runner, now = Date.now(), batch = randomBytes(8).toString("hex"), producerVersion = ownDeskVersion() }) {
  const hold = (code) => ({ held: code })
  if (typeof store !== "string" || !PATTERNS.prRepo.test(store)) return hold("store_unknown")
  if (!isPlainObject(consent) || typeof consent.contribute !== "boolean") return hold("consent_unknown")
  if (consent.contribute !== true) return hold("not_opted_in")
  if (!(visibility instanceof Map) || !KNOWN_VISIBILITY.has(visibility.get(store.toLowerCase()))) return hold("visibility_unknown")
  if (!isPlainObject(coverage)) return hold("coverage_unknown")
  if (!isPlainObject(runner)) return hold("runner_unknown")
  if (typeof producerVersion !== "string") return hold("producer_unknown")
  if (!Array.isArray(rows) || rows.length > MAX_ROWS || typeof batch !== "string" || !HEX16.test(batch)) return hold("projection_invalid")
  const nowMs = new Date(now).getTime()
  const built = []
  const held = []
  rows.forEach((input, index) => {
    const out = rowFor(isPlainObject(input) ? input : {}, { store, now: nowMs, producerVersion })
    if (out.held === undefined) built.push(out.row)
    else held.push({ index, code: out.held })
  })
  if (rows.length > 0 && built.length === 0) return { held: held[0].code, skipped: held }
  const bytes = canonical({ schema: TRIAGE_SCHEMA, batch, producer_version: producerVersion, rubric_version: RUBRIC_VERSION, coverage, runner, rows: built })
  const path = `triage/${batch}.json`
  if (!validateTriageChange({ path, status: "added", bytes, trustedMaintainer: true }).ok) return hold("projection_invalid")
  return { path, bytes, sha: gitBlobSha(bytes), rows: built.map((row) => ({ id: row.id, revision: row.revision })), skipped: held }
}

/**
 * `triageFor({ annotation, identity, ack, store, consent, visibility, publicEvidence, coverage, runner, card, now, batch, producerVersion })
 *   -> { path, bytes, sha } | { held: code }`: the batch file for one acknowledged annotation.
 *
 *   - `annotation`: the acknowledged `desk.factory.triage-local/1` annotation, as parsed from Desk `main`.
 *   - `identity`: the acknowledged `desk.factory.triage-identities/1` registry, as parsed from Desk `main`. The row's public ID
 *     is the registry's entry for the annotation's card and this store.
 *   - `ack`: `publishOwnedTriage`'s readback `{remote,ref,commit,registry_blob,annotation_blob}`.
 *   - `store`: `owner/repo`; `consent`: its consent record; `visibility`: a `Map` of repository (lower case) to its fresh
 *     visibility, which must know the store.
 *   - `publicEvidence`: `[{kind,ref,revision,visibility}]`, the positively public pointers (`publicEvidenceFor`).
 *   - `coverage`, `runner`: the batch's `coverage` and `runner` objects, as the public schema has them.
 *   - `card` (optional): `{state, claimed, revision}` of the canonical card as read now: its lifecycle state, whether it carries
 *     a live claim, and the blob ID of its bytes. It is used only when `revision` is exactly the annotation's
 *     `canonical_revision`; otherwise the row's lifecycle is null and its ownership `not_published`.
 *   - `now`, `batch`, `producerVersion`: the clock for the attempt's age, the batch ID and this Desk's version, for tests.
 *
 * Hold codes: `store_unknown`, `consent_unknown`, `not_opted_in`, `visibility_unknown`, `coverage_unknown`, `runner_unknown`,
 * `producer_unknown`, `unacknowledged`, `annotation_invalid`, `identity_unacknowledged`, `identity_revision_mismatch`, `identity_not_random`,
 * `basis_not_opaque`, `annotation_state`, `projection_invalid`.
 */
export function triageFor({ annotation, identity, ack, store, consent, visibility, publicEvidence, coverage, runner, card, now, batch, producerVersion }) {
  const out = triageBatchFor({ rows: [{ annotation, identity, ack, publicEvidence, card }], store, consent, visibility, coverage, runner, now, batch, producerVersion })
  return out.held === undefined ? { path: out.path, bytes: out.bytes, sha: out.sha } : { held: out.held }
}
