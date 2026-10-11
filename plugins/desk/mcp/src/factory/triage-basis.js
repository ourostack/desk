// The current canonical basis of one improvement card for triage: the card's exact bytes, its effective claim at `now`, the
// authority-relevant rulings and the card's evidence pointers. Read-only: it never writes, moves aside or repairs a card beyond
// what the canonical reader (`readCards`) itself does.
//
// The returned `basis` is PROTECTED parent data. Its `fingerprint` digests private bytes and its rulings name desk-relative
// paths, so it is kept in owner-protected factory state, never in Git or a public row. Only `canonical_revision` (a Git blob
// id) and the permitted public evidence revisions may enter the Git annotation (see `triage-state.js`).
//
// Authority: scope (`existing_scope`) needs a positively read ruling, and `approved_plan` a prepared plan or spec the parent
// resolved. Without a ruling, or with missing evidence, triage can propose only an investigation or a human gate. A ruling that
// exists but cannot be read is `authority_unknown`, never agent-ready. Source text is data, not instructions.

import { promises as fs, constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { cardFile, isClaimLive, readCards as readCardsDefault } from "../desk/improvement-cards.js"
import { gitBlobSha, ownDeskVersion } from "./outbox.js"

const RUBRIC_VERSION = 1
const MAX_RULING_BYTES = 256 * 1024
const MAX_CARD_BYTES = 16 * 1024
const MAX_PREPARED = 16
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u
const ALWAYS = ["investigation_only", "human_gate"]
const SELF_DESCRIBING = /^(job|fingerprint|reconcile):/u

/** A desk-relative POSIX path made only of safe segments, or null. Never `..`, never absolute, never a backslash. */
export function safeDeskPath(relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.length > 512) return null
  const segments = relative.split("/")
  return segments.every((segment) => SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..") ? relative : null
}

// Bytes of a regular, non-symlink file reached through non-symlink folders; `{missing}` when absent, `{unreadable}` otherwise.
async function readRegular(deskRoot, relative, maxBytes) {
  let cursor = deskRoot
  const segments = relative.split("/")
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment)
    let stat
    try {
      stat = await fs.lstat(cursor)
    } catch (error) {
      return error.code === "ENOENT" ? { missing: true } : { unreadable: true }
    }
    const last = index === segments.length - 1
    if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.size > maxBytes : !stat.isDirectory())) return { unreadable: true }
  }
  try {
    return { bytes: await fs.readFile(cursor, { flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW }) }
  } catch {
    return { unreadable: true }
  }
}

const prefixPath = (personPrefix, rest) => (personPrefix === "" ? rest : `${personPrefix}/${rest}`)

/** The rulings every card is read against, before any prepared plan or spec: the desk's AGENTS.md and the operator rules. */
export function defaultRulingPaths(personPrefix) {
  return ["AGENTS.md", prefixPath(personPrefix, "_meta/operator-rules.md")]
}

/**
 * `readRulings({deskRoot,personPrefix,card,preparedEvidence}) -> {state,refs:[{id,revision}],scope:{codes,plan_ids}}`.
 * `id` is the ruling's desk-relative path and `revision` its Git blob id. `preparedEvidence` is the parent's positively resolved
 * list of `{kind:"plan"|"spec"|"ruling", path}` desk-relative documents (at most sixteen); a job pointer is not one until the
 * parent resolves it. A missing default ruling is simply absent; a named prepared ruling that is missing, or any ruling that
 * cannot be read, makes the whole answer `authority_unknown`. `state` is `resolved` (at least one ruling), `unresolved` (none) or
 * `authority_unknown`.
 */
export async function readRulings({ deskRoot, personPrefix, card, preparedEvidence = [] }) {
  void card // The card does not select rulings by itself: only the parent's prepared evidence does.
  const unknown = { state: "authority_unknown", refs: [], scope: { codes: [...ALWAYS], plan_ids: [] } }
  if (!Array.isArray(preparedEvidence) || preparedEvidence.length > MAX_PREPARED) return unknown
  const wanted = defaultRulingPaths(personPrefix).map((id) => ({ id, kind: "default", required: false }))
  for (const item of preparedEvidence) {
    const id = safeDeskPath(item?.path)
    if (id === null || !["plan", "spec", "ruling"].includes(item.kind)) return unknown
    wanted.push({ id, kind: item.kind, required: true })
  }
  const refs = []
  const plans = []
  for (const ruling of wanted) {
    if (refs.some((ref) => ref.id === ruling.id)) continue
    const read = await readRegular(deskRoot, ruling.id, MAX_RULING_BYTES)
    if (read.unreadable || (read.missing && ruling.required)) return unknown
    if (read.missing) continue
    refs.push({ id: ruling.id, revision: gitBlobSha(read.bytes) })
    if (ruling.kind === "plan" || ruling.kind === "spec") plans.push(ruling.id)
  }
  if (refs.length === 0) return { state: "unresolved", refs, scope: { codes: [...ALWAYS], plan_ids: [] } }
  return { state: "resolved", refs, scope: { codes: ["existing_scope", ...(plans.length > 0 ? ["approved_plan"] : []), ...ALWAYS], plan_ids: plans } }
}

// The default evidence resolver knows only pointers that name themselves (a job, a fingerprint, a reconcile class): their
// revision is fixed at 1 and they are never public. An issue or pull request needs the parent's resolver, which alone can say
// whether it is public and at which revision; without one it is unknown.
async function resolveSelfDescribing(pointer) {
  return SELF_DESCRIBING.test(pointer) ? { revision: 1, public: null } : null
}

function fingerprintOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** The canonical card's desk-relative path, or null when the location or key is not a valid one. */
export function canonicalCardPath(deskRoot, personPrefix, key) {
  try {
    return path.relative(deskRoot, cardFile(deskRoot, personPrefix, key)).split(path.sep).join("/")
  } catch {
    return null
  }
}

function claimAt(card, now) {
  if (!card?.claim) return { state: "none", expires_at: null }
  return { state: isClaimLive(card, now) ? "live" : "expired", expires_at: card.claim.expires_at }
}

/**
 * `readTriageBasis({deskRoot,personPrefix,key,now,readCards,evidence,readRulings}) -> {state,card,basis,briefEvidence,authority}`.
 *
 * `evidence` is `{prepared?, resolve?}`: `prepared` the parent's resolved ruling documents (see `readRulings`) and
 * `resolve(pointer, card) -> {revision, public:{kind,ref,revision}|null} | null` its evidence resolver. `state` is `ready`,
 * `card_missing` (a complete read without the card), `source_unknown` (a truncated read, or bytes that changed while read),
 * `source_unreadable` (the folder or the card's own file cannot be read as a valid card), `authority_unknown` or
 * `evidence_unknown`. Only `ready` may carry agent-ready authority. `basis.fingerprint` changes with the card bytes, the
 * effective claim at `now` (so expiry alone changes it), every ruling revision, every evidence revision, and the rubric and
 * producer versions.
 */
export async function readTriageBasis({ deskRoot, personPrefix, key, now, readCards = readCardsDefault, evidence = {}, readRulings: rulingsReader = readRulings }) {
  const canonical = canonicalCardPath(deskRoot, personPrefix, key)
  if (canonical === null) return { state: "source_unreadable", card: null, basis: null, briefEvidence: [], authority: { state: "authority_unknown", codes: [...ALWAYS], ruling_ids: [] } }
  const before = await readRegular(deskRoot, canonical, MAX_CARD_BYTES)
  const listing = await readCards({ deskRoot, personPrefix })
  const after = await readRegular(deskRoot, canonical, MAX_CARD_BYTES)
  const card = listing.cards.find((candidate) => candidate.key === key) ?? null
  const stable = before.missing === after.missing && (before.bytes === undefined || (after.bytes !== undefined && before.bytes.equals(after.bytes)))
  let state = "ready"
  if (listing.unreadable || (card === null && before.unreadable)) state = "source_unreadable"
  else if (!stable || (card !== null && after.bytes === undefined)) state = "source_unknown"
  else if (card === null) state = before.missing ? (listing.truncated ? "source_unknown" : "card_missing") : "source_unreadable"

  const rulings = card === null ? { state: "unresolved", refs: [], scope: { codes: [...ALWAYS], plan_ids: [] } } : await rulingsReader({ deskRoot, personPrefix, card, preparedEvidence: evidence.prepared ?? [] })
  const resolve = evidence.resolve ?? resolveSelfDescribing
  const briefEvidence = []
  let evidenceKnown = true
  for (const [index, pointer] of (card?.evidence ?? []).entries()) {
    const found = await resolve(pointer, card)
    if (found === null || !Number.isSafeInteger(found?.revision) || found.revision < 1) {
      evidenceKnown = false
      continue
    }
    briefEvidence.push({ id: `evidence:${index}`, pointer, revision: found.revision, public: found.public ?? null })
  }
  if (state === "ready" && rulings.state === "authority_unknown") state = "authority_unknown"
  else if (state === "ready" && !evidenceKnown) state = "evidence_unknown"
  const codes = state === "ready" ? rulings.scope.codes : [...ALWAYS]
  const authority = { state: rulings.state, codes, ruling_ids: state === "ready" ? rulings.refs.map((ref) => ref.id) : [] }

  const body = {
    key,
    canonical_path: canonical,
    canonical_revision: after.bytes === undefined ? null : gitBlobSha(after.bytes),
    claim: claimAt(card, now),
    rulings: rulings.refs,
    evidence: briefEvidence.map(({ id, pointer, revision }) => ({ id, pointer, revision })),
    authority: { state: authority.state, codes, plan_ids: rulings.scope.plan_ids },
    rubric_version: RUBRIC_VERSION,
    producer_version: ownDeskVersion(),
  }
  const basis = {
    ...body,
    fingerprint: fingerprintOf(body),
    public_evidence_revisions: briefEvidence.map((item) => item.public).filter((item) => item !== null).slice(0, 16),
  }
  return { state, card, basis, briefEvidence, authority }
}

/**
 * `checkTriageBasis({deskRoot,personPrefix,basis,now}) -> {state,reason}`: the mechanical recheck of a stored protected basis
 * against the desk as it is now, without an agent. `state` is `current`, `stale` (reason `basis_changed`, `claim_changed` or
 * `authority_changed`), `card_missing` or `source_unknown`. It rereads the card bytes, the effective claim at `now` and every
 * ruling the basis named plus the default ruling paths (so a newly added ruling also counts as a change).
 */
export async function checkTriageBasis({ deskRoot, personPrefix, basis, now, readCards = readCardsDefault }) {
  const current = await readTriageBasis({
    deskRoot, personPrefix, key: basis.key, now, readCards,
    evidence: {
      prepared: basis.rulings.filter((ruling) => !defaultRulingPaths(personPrefix).includes(ruling.id))
        .map((ruling) => ({ kind: basis.authority.plan_ids.includes(ruling.id) ? "plan" : "ruling", path: ruling.id })),
      resolve: async (pointer) => basis.evidence.find((item) => item.pointer === pointer) ?? null,
    },
  })
  if (current.state === "card_missing") return { state: "card_missing", reason: "card_removed" }
  if (current.state === "source_unknown" || current.state === "source_unreadable") return { state: "source_unknown", reason: "source_incomplete" }
  if (current.basis.canonical_revision !== basis.canonical_revision) return { state: "stale", reason: "basis_changed" }
  if (current.basis.claim.state !== basis.claim.state) return { state: "stale", reason: "claim_changed" }
  // Ruling bytes, a removed or added ruling, or a version change: the recommendation's authority is no longer the one reviewed.
  if (current.basis.fingerprint !== basis.fingerprint) return { state: "stale", reason: "authority_changed" }
  return { state: "current", reason: null }
}
