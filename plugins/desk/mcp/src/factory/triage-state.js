// Local triage annotation state: the closed safe review that may enter Git, the annotation and identity registry shapes,
// fair card selection, the mechanical basis refresh and the parent-local resolver for a public annotation ID.
//
// Protected-to-Git boundary. A validated candidate result (`validateTriageResultBytes`) is protected prose. `toSafeTriageReview`
// never copies its text: it keeps only closed codes, parent-authorized public pointers, canonical keys the brief already proved,
// versions and an opaque token for the protected result. Unknown authorization or visibility drops the pointer and adds the fixed
// `detail_not_authorized_for_git` code. Nothing here relies on a blacklist of private words.
//
// Files (under the owning person prefix): `_meta/improvement-triage/<card file basename>.json` holds one
// `desk.factory.triage-local/1` annotation, and `_meta/improvement-triage/identities.json` the
// `desk.factory.triage-identities/1` registry of acknowledged random public IDs per card and store. Neither has a lifecycle, a
// claim or an execution queue; both are written only by `publishOwnedTriage` (triage-write.js) through an acknowledged commit.

import { promises as fs, readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import {
  PATTERNS, addError, arrayField, customField, enumField, nullableEnumField, objectField, patternField, rangeIntField,
  validateCanonicalBytes, validateObject,
} from "./schema.js"
import { readCards as readCardsDefault } from "../desk/improvement-cards.js"
import { factoryStateRoot } from "./outbox.js"
import { TRIAGE_SOURCES } from "./triage-schema.js"
import { canonicalCardPath, checkTriageBasis } from "./triage-basis.js"

const ANNOTATION_SCHEMA = "desk.factory.triage-local/1"
const IDENTITIES_SCHEMA = "desk.factory.triage-identities/1"
const PROTECTED_BASIS_SCHEMA = "desk.factory.triage-protected-basis/1"
const ROUTES = ["agent_ready", "investigate", "human_decision"]
const GATES = ["intent", "scope", "approval", "voice", "spend", "account", "irreversible"]
const AUTHORITY = ["existing_scope", "approved_plan", "investigation_only", "human_gate"]
const STATES = ["not_reviewed", "reviewed", "stale", "refused", "deferred", "withdrawn", "source_unknown"]
const REASONS = [
  "review_accepted", "basis_changed", "claim_changed", "authority_changed", "evidence_changed", "version_changed", "card_removed",
  "source_incomplete", "review_refused", "deferred_by_limit", "protected_basis_unavailable",
]
const NOT_AUTHORIZED = "detail_not_authorized_for_git"
const SUMMARY_CODES = new Set([
  ...TRIAGE_SOURCES.map((source) => `source:${source}`), ...ROUTES.map((route) => `route:${route}`), ...GATES.map((gate) => `gate:${gate}`), NOT_AUTHORIZED,
])
const HEX32 = /^[0-9a-f]{32}$/u
const BLOB = /^[0-9a-f]{40}$/u
const MAX_ENTRIES = 20000
// A canonical card key as the card reader accepts it: a known source, then an id with no space, control or quote.
const KEY = new RegExp(`^(${TRIAGE_SOURCES.join("|")}):[A-Za-z0-9._/#:-]{1,160}$`, "u")
const STORE = /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/u
const REPO = "[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}"
// The same public pointer spellings the public row validator accepts (triage-schema.js), checked again here so a Git review never
// holds a pointer the public projection would refuse.
const POINTERS = {
  issue: new RegExp(`^https://github\\.com/${REPO}/issues/[1-9][0-9]{0,9}$`, "u"),
  pr: new RegExp(`^https://github\\.com/${REPO}/pull/[1-9][0-9]{0,9}$`, "u"),
  job: new RegExp(`^https://github\\.com/${REPO}/blob/reports/jobs/[0-9a-f]{32}\\.md$`, "u"),
}

const positive = () => rangeIntField(1, Number.MAX_SAFE_INTEGER)
const pointerField = () => customField((value, at, errors) => {
  const ok = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === "kind,ref,revision" &&
    Object.hasOwn(POINTERS, value.kind) && typeof value.ref === "string" && POINTERS[value.kind].test(value.ref) &&
    Number.isSafeInteger(value.revision) && value.revision >= 1
  if (!ok) addError(errors, "pointer", at)
  return ok
})
const keyList = () => arrayField(patternField(KEY), 16)
const reviewSpec = {
  route: enumField(ROUTES),
  gate: nullableEnumField(GATES),
  authority_code: enumField(AUTHORITY),
  summary_codes: arrayField(customField((value, at, errors) => {
    if (!SUMMARY_CODES.has(value)) { addError(errors, "summary_code", at); return false }
    return true
  }), 8),
  evidence: arrayField(pointerField(), 16),
  related_keys: keyList(),
  duplicate_keys: keyList(),
  producer_version: patternField(PATTERNS.semver),
  rubric_version: positive(),
  protected_result: patternField(HEX32),
}

function reviewConsistency(review, errors) {
  const human = review.route === "human_decision"
  if (human !== (review.gate !== null) || human !== (review.authority_code === "human_gate") ||
      (review.route === "agent_ready" && !["existing_scope", "approved_plan"].includes(review.authority_code))) addError(errors, "inconsistent", "")
  const codes = review.summary_codes
  const sources = codes.filter((code) => code.startsWith("source:"))
  if (new Set(codes).size !== codes.length || sources.length !== 1 || !codes.includes(`route:${review.route}`) ||
      codes.filter((code) => code.startsWith("route:")).length !== 1 ||
      codes.filter((code) => code.startsWith("gate:")).join() !== (review.gate === null ? "" : `gate:${review.gate}`)) addError(errors, "summary_codes", "summary_codes")
  if (new Set(review.related_keys).size !== review.related_keys.length || new Set(review.duplicate_keys).size !== review.duplicate_keys.length) addError(errors, "duplicate", "")
}

/** `validateSafeTriageReview(review) -> {ok,errors}`: the exact closed safe Git review shape; anything else is refused before staging. */
export function validateSafeTriageReview(review) {
  const errors = []
  validateObject(review, "", reviewSpec, errors)
  if (errors.length === 0) reviewConsistency(review, errors)
  return { ok: errors.length === 0, errors }
}

/**
 * `toSafeTriageReview({result,basis,authorizedEvidence,protectedToken,briefKeys}) -> {state:"safe"|"refused",review,errors?}`.
 * `result` is one already validated candidate row; `basis` the card's `readTriageBasis().basis`; `authorizedEvidence` the
 * parent's `[{id,kind,ref,revision,git_safe}]` where only `git_safe === true` entries with a public pointer shape may be kept;
 * `protectedToken` the random token under which the parent stored the full protected result; `briefKeys` the canonical keys of
 * the brief the result answered. No result text is copied.
 *
 * This boundary proves authority itself rather than trusting the candidate check: the result's authority code must be one the
 * basis allows (`basis.authority.codes`, which is only an investigation or a human gate unless the basis was ready with a
 * ruling) and every ruling it cites must be one of the basis's rulings; otherwise `authority_unproved`. Every related or
 * duplicate key must be a key of the brief; otherwise `related_unproved`, so key-shaped prose never reaches Git.
 */
export function toSafeTriageReview({ result, basis, authorizedEvidence = [], protectedToken, briefKeys = [] }) {
  const refuse = (code) => ({ state: "refused", review: null, errors: [{ code, path: "" }] })
  if (result === null || typeof result !== "object" || basis === null || typeof basis !== "object") return refuse("type")
  if (result.key !== basis.key) return refuse("key_mismatch")
  const codes = Array.isArray(basis.authority?.codes) ? basis.authority.codes : []
  const rulings = new Set((Array.isArray(basis.rulings) ? basis.rulings : []).map((ruling) => ruling?.id))
  const cited = result.authority?.ruling_ids
  if (!codes.includes(result.authority?.code) || !Array.isArray(cited) || !cited.every((id) => rulings.has(id))) return refuse("authority_unproved")
  const related = [...new Set(Array.isArray(result.related) ? result.related : [])]
  const duplicates = [...new Set((Array.isArray(result.duplicates) ? result.duplicates : []).map((duplicate) => duplicate?.key))]
  const brief = new Set(Array.isArray(briefKeys) ? briefKeys : [])
  if (![...related, ...duplicates].every((key) => brief.has(key))) return refuse("related_unproved")
  const allowed = new Map(authorizedEvidence.filter((item) => item?.git_safe === true).map((item) => [item.id, item]))
  const evidence = []
  let withheld = false
  for (const id of [...new Set(Array.isArray(result.evidence) ? result.evidence : [])]) {
    const item = allowed.get(id)
    const pointer = item === undefined ? null : { kind: item.kind, ref: item.ref, revision: item.revision }
    if (pointer === null || !pointerField().check(pointer, "", [])) withheld = true
    else evidence.push(pointer)
  }
  const route = result.route
  const gate = route === "human_decision" ? result.gate_reason : null
  const review = {
    route,
    gate,
    authority_code: result.authority.code,
    summary_codes: [`source:${basis.key.slice(0, basis.key.indexOf(":"))}`, `route:${route}`, ...(gate === null ? [] : [`gate:${gate}`]), ...(withheld ? [NOT_AUTHORIZED] : [])],
    evidence: evidence.slice(0, 16),
    related_keys: related,
    duplicate_keys: duplicates,
    producer_version: basis.producer_version,
    rubric_version: basis.rubric_version,
    protected_result: protectedToken,
  }
  const checked = validateSafeTriageReview(review)
  return checked.ok ? { state: "safe", review } : { state: "refused", review: null, errors: checked.errors }
}

const annotationSpec = {
  schema: enumField([ANNOTATION_SCHEMA]),
  key: patternField(KEY),
  revision: positive(),
  basis: objectField({
    generation: patternField(HEX32),
    canonical_revision: customField((value, at, errors) => {
      if (value !== null && !(typeof value === "string" && BLOB.test(value))) { addError(errors, "pattern", at); return false }
      return true
    }),
    public_evidence_revisions: arrayField(pointerField(), 16),
    protected_basis: patternField(HEX32),
  }),
  review: customField((value, at, errors) => {
    if (value === null) return true
    const own = validateSafeTriageReview(value)
    for (const error of own.errors) addError(errors, error.code, at)
    return own.ok
  }),
  attempt: objectField({ state: enumField(STATES), at: patternField(PATTERNS.timestamp), reason: enumField(REASONS) }),
}

/** `validateTriageAnnotation(bytes) -> {ok,errors,value?}`: canonical bytes of one closed local annotation. */
export function validateTriageAnnotation(bytes) {
  let value
  const result = validateCanonicalBytes(bytes, (parsed) => {
    const errors = []
    validateObject(parsed, "", annotationSpec, errors)
    if (errors.length === 0) {
      // A review needs its card; a stale or refused annotation keeps its last valid review as context.
      if (parsed.attempt.state === "reviewed" && (parsed.review === null || parsed.basis.canonical_revision === null)) addError(errors, "inconsistent", "attempt")
      if (parsed.attempt.state === "withdrawn" && (parsed.review !== null || parsed.basis.canonical_revision !== null)) addError(errors, "inconsistent", "attempt")
    }
    if (errors.length === 0) value = parsed
    return { ok: errors.length === 0, errors }
  })
  return value === undefined ? result : { ...result, value }
}

const identitiesSpec = {
  schema: enumField([IDENTITIES_SCHEMA]),
  entries: arrayField(objectField({
    key: patternField(KEY),
    store: patternField(STORE),
    id: patternField(HEX32),
    revision: positive(),
    public_basis: customField((value, at, errors) => {
      if (value !== null && !(typeof value === "string" && HEX32.test(value))) { addError(errors, "pattern", at); return false }
      return true
    }),
  }), MAX_ENTRIES),
}

/** The registry order: canonical key, then the case-normalized store. */
export const compareIdentities = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.store < b.store ? -1 : a.store > b.store ? 1 : 0)

/** `validateTriageIdentities(bytes) -> {ok,errors,value?}`: sorted, unique per card and store, one card and store per ID. */
export function validateTriageIdentities(bytes) {
  let value
  const result = validateCanonicalBytes(bytes, (parsed) => {
    const errors = []
    validateObject(parsed, "", identitiesSpec, errors)
    if (errors.length === 0) {
      const entries = parsed.entries
      if (entries.some((entry, index) => index > 0 && compareIdentities(entries[index - 1], entry) >= 0)) addError(errors, "order", "entries")
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length) addError(errors, "duplicate", "entries")
    }
    if (errors.length === 0) value = parsed
    return { ok: errors.length === 0, errors }
  })
  return value === undefined ? result : { ...result, value }
}

// Any valid key locates the person prefix's folders; this one is only a probe of the location.
const PROBE_KEY = "evaluator:gave_up"

/** Desk-relative triage paths for one card: the registry and the card's annotation; null for an invalid location or key. */
export function triagePaths(deskRoot, personPrefix, key = PROBE_KEY) {
  const card = canonicalCardPath(deskRoot, personPrefix, key)
  if (card === null) return null
  const dir = `${path.posix.dirname(path.posix.dirname(card))}/improvement-triage`
  return { card, dir, registry: `${dir}/identities.json`, annotation: `${dir}/${path.posix.basename(card, ".md")}.json` }
}

// ---------------------------------------------------------------------------
// Protected basis records (outside Git).

/** Where the protected basis for `token` lives in factory state: `<factory>/triage/basis/<token>.json`. */
async function protectedBasisFile(env, token, { create = false, deskRoot = null } = {}) {
  if (typeof token !== "string" || !HEX32.test(token)) return null
  const root = await factoryStateRoot(env, { create, deskRoot })
  return root === null ? null : path.join(root, "triage", "basis", `${token}.json`)
}

/** The stored protected basis for `token`, or null when this host does not have it (another host's review) or it is damaged. */
export async function readProtectedBasis(env, token) {
  const file = await protectedBasisFile(env, token)
  if (file === null) return null
  try {
    const record = JSON.parse(await fs.readFile(file, "utf8"))
    return record?.schema === PROTECTED_BASIS_SCHEMA && record.token === token ? record.basis : null
  } catch {
    return null
  }
}

/** Builds the record `readProtectedBasis` accepts; the writer (triage-write.js) persists it before its commit. */
export const protectedBasisRecord = (token, basis) => ({ schema: PROTECTED_BASIS_SCHEMA, token, basis })

// ---------------------------------------------------------------------------
// Selection.

const timeOf = (value, now) => {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : Math.min(ms, now)
}
const byKey = (a, b) => Number(a.key > b.key) - Number(a.key < b.key)

/**
 * `selectTriageCards({cards,attempts,now,limit=20}) -> {selected,deferred,coverage}`.
 * `cards`: `[{key, opened_at, fingerprint}]`, the current basis fingerprint of each open card. `attempts`: by key,
 * `{at, state:"reviewed"|"refused"|"deferred", fingerprint, review_fingerprint}` where `fingerprint` is the basis the last attempt
 * saw and `review_fingerprint` the basis of the last VALID review (or null). A card whose valid review matches its current
 * basis is reviewed and not selected. Every card not yet attempted on its current basis comes first, unreviewed before stale,
 * then oldest attempt, then oldest card, then key; only then retries (attempted on this basis and refused or deferred), by
 * last attempt time and then key. So twenty cards that keep failing cannot hide a twenty-first card nobody has tried. An
 * attempt time in the future counts as `now`, so a skewed clock cannot park a card at the back for good.
 */
export function selectTriageCards({ cards, attempts = {}, now, limit = 20 }) {
  const at = new Date(now).getTime()
  const fresh = []
  const retries = []
  let reviewed = 0
  let refused = 0
  for (const card of cards) {
    const attempt = attempts instanceof Map ? attempts.get(card.key) : attempts[card.key]
    if (attempt?.review_fingerprint === card.fingerprint) {
      reviewed += 1
      continue
    }
    const entry = { ...card, last: attempt === undefined ? Number.NEGATIVE_INFINITY : timeOf(attempt.at, at), stale: Boolean(attempt?.review_fingerprint) }
    if (attempt !== undefined && attempt.fingerprint === card.fingerprint) {
      if (attempt.state === "refused") refused += 1
      retries.push(entry)
    } else {
      fresh.push(entry)
    }
  }
  fresh.sort((a, b) => Number(a.stale) - Number(b.stale) || a.last - b.last || timeOf(a.opened_at, at) - timeOf(b.opened_at, at) || byKey(a, b))
  retries.sort((a, b) => a.last - b.last || byKey(a, b))
  const ordered = [...fresh, ...retries].map(({ last: _last, stale: _stale, ...card }) => card)
  const selected = ordered.slice(0, limit)
  const deferred = ordered.slice(limit)
  const unreviewed = ordered.length
  return {
    selected,
    deferred,
    coverage: { reviewed, unreviewed, refused, deferred: deferred.length, more_unreviewed: deferred.length > 0 },
  }
}

// ---------------------------------------------------------------------------
// Reading acknowledged annotations.

const GIT_TIMEOUT_MS = 10_000
function gitRead(deskRoot, args) {
  const result = spawnSync("git", ["-C", deskRoot, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  return result.status === 0 ? result.stdout : null
}

/**
 * The acknowledged triage tree: from the remote-tracking `origin/main` the last fetch saw when the desk is a Git checkout with
 * one (an acknowledged write is on the remote even before the normal sync pulls it), else from the checked-out files.
 * Returns `{source:"remote"|"files", read(relative) -> Buffer|null, list(dir) -> string[]}`.
 */
function acknowledgedTree(deskRoot) {
  if (gitRead(deskRoot, ["rev-parse", "-q", "--verify", "refs/remotes/origin/main^{commit}"]) !== null) {
    return {
      source: "remote",
      read: (relative) => gitRead(deskRoot, ["cat-file", "blob", `refs/remotes/origin/main:${relative}`]),
      list: (dir) => {
        const out = gitRead(deskRoot, ["ls-tree", "-z", "--name-only", `refs/remotes/origin/main:${dir}`])
        return out === null ? [] : out.toString("utf8").split("\0").filter(Boolean)
      },
    }
  }
  return {
    source: "files",
    read: (relative) => {
      try {
        return Buffer.from(readFileSync(path.join(deskRoot, ...relative.split("/"))))
      } catch {
        return null
      }
    },
    list: (dir) => {
      try {
        return readdirSync(path.join(deskRoot, ...dir.split("/")))
      } catch {
        return []
      }
    },
  }
}

/**
 * `resolveAcknowledgedTriage({deskRoot,personPrefix,store,id,revision}) -> {state,key?,protected_result?}`.
 * Scans only the owned acknowledged registry. `resolved` needs this store's entry for `id` at exactly `revision`, and the card's
 * annotation reviewed at that same revision (stores share one annotation, so a later revision written for another store is a
 * different review); an older revision, an annotation at another revision or no longer reviewed is `stale`; anything else (absent
 * ID, another store, a newer revision than acknowledged, a damaged registry) is `not_resolved`. It never guesses another card.
 */
export function resolveAcknowledgedTriage({ deskRoot, personPrefix, store, id, revision }) {
  const none = { state: "not_resolved" }
  const paths = triagePaths(deskRoot, personPrefix)
  if (paths === null || typeof store !== "string" || typeof id !== "string" || !HEX32.test(id) || !Number.isSafeInteger(revision)) return none
  const tree = acknowledgedTree(deskRoot)
  const bytes = tree.read(paths.registry)
  const registry = bytes === null ? null : validateTriageIdentities(bytes).value
  const entry = registry?.entries.find((candidate) => candidate.id === id)
  if (entry === undefined || entry.store !== store.toLowerCase() || revision > entry.revision) return none
  const own = triagePaths(deskRoot, personPrefix, entry.key)
  const annotationBytes = tree.read(own.annotation)
  const annotation = annotationBytes === null ? undefined : validateTriageAnnotation(annotationBytes).value
  if (revision < entry.revision || annotation?.attempt.state !== "reviewed" || annotation.revision !== entry.revision) return { state: "stale", key: entry.key }
  return { state: "resolved", key: entry.key, protected_result: annotation.review.protected_result }
}

/**
 * `readAcknowledgedAnnotations({deskRoot,personPrefix}) -> {source,annotations,damaged}`: every valid annotation in the
 * acknowledged tree (see `acknowledgedTree`) and how many files there failed validation.
 */
export function readAcknowledgedAnnotations({ deskRoot, personPrefix }) {
  const paths = triagePaths(deskRoot, personPrefix)
  const tree = acknowledgedTree(deskRoot)
  const annotations = []
  let damaged = 0
  for (const name of tree.list(paths.dir).sort()) {
    if (name === "identities.json" || !name.endsWith(".json")) continue
    const value = validateTriageAnnotation(tree.read(`${paths.dir}/${name}`) ?? "").value
    const own = value === undefined ? null : triagePaths(deskRoot, personPrefix, value.key)
    if (own !== null && own.annotation === `${paths.dir}/${name}`) annotations.push(value)
    else damaged += 1
  }
  return { source: tree.source, annotations, damaged }
}

// ---------------------------------------------------------------------------
// The mechanical refresh.

/**
 * `refreshTriage({env,deskRoot,personPrefix,now,evidence}) -> {state,changes,coverage}`. Mechanical and read-only: no agent, no
 * write. For each acknowledged annotation it rechecks the stored protected basis against the desk now (`checkTriageBasis`: card
 * bytes, the effective claim at `now`, the rulings, and each evidence revision through the live resolver `evidence.resolve`) and
 * returns the change the loop must publish through `publishOwnedTriage`:
 *   - `{key, operation:"invalidate", reason}` for a reviewed annotation whose basis changed (stale, review kept as context); the
 *     reason is the check's own (`basis_changed`, `claim_changed`, `authority_changed`, `evidence_changed`, `version_changed`) and
 *     is passed to `publishOwnedTriage` as is;
 *   - `{key, operation:"withdraw", reason:"card_removed"}` only when a COMPLETE read lacks the card;
 *   - `{key, operation:null, state:"source_unknown", reason:"source_incomplete"}` when the read is truncated or unreadable, or the
 *     card's own file cannot be read: removal is never asserted from an incomplete source, and nothing is written;
 *   - `{key, operation:null, state:"source_unknown", reason:"evidence_unknown"}` when an evidence pointer cannot be resolved now
 *     (no live resolver for it): the review is not known to be current, and nothing is written;
 *   - `{key, operation:null, state:"stale", reason:"protected_basis_unavailable"}` when this host lacks the protected basis of a
 *     review (another host's): it is not assumed fresh here, and another host's review is not rewritten.
 * `state` is the scan (`complete`, `truncated` or `unreadable`). `coverage` counts reviewed and unreviewed open cards from the
 * annotations alone, and only from a complete scan: an unreadable or truncated scan has no count it can stand behind, so every
 * count is null (unknown, never zero). Refused and deferred counts belong to the loop's attempt record, so they are always null.
 */
export async function refreshTriage({ env, deskRoot, personPrefix, now, readCards = readCardsDefault, evidence = {} }) {
  const listing = await readCards({ deskRoot, personPrefix })
  const scan = listing.unreadable ? "unreadable" : listing.truncated ? "truncated" : "complete"
  const { annotations } = readAcknowledgedAnnotations({ deskRoot, personPrefix })
  const changes = []
  const fresh = new Set()
  for (const annotation of annotations) {
    const { key } = annotation
    if (annotation.attempt.state === "withdrawn") continue
    if (!listing.cards.some((card) => card.key === key)) {
      if (scan === "complete" && canonicalAbsent(deskRoot, personPrefix, key)) changes.push({ key, operation: "withdraw", reason: "card_removed" })
      else changes.push({ key, operation: null, state: "source_unknown", reason: "source_incomplete" })
      continue
    }
    if (annotation.attempt.state !== "reviewed") continue
    const stored = await readProtectedBasis(env, annotation.basis.protected_basis)
    const check = stored === null ? null : await checkTriageBasis({ deskRoot, personPrefix, basis: stored, now, readCards, evidence })
    if (check === null) changes.push({ key, operation: null, state: "stale", reason: "protected_basis_unavailable" })
    else if (check.state === "stale") changes.push({ key, operation: "invalidate", reason: check.reason })
    else if (check.state === "current") fresh.add(key)
    else if (check.state === "evidence_unknown") changes.push({ key, operation: null, state: "source_unknown", reason: "evidence_unknown" })
    else changes.push({ key, operation: null, state: "source_unknown", reason: "source_incomplete" })
  }
  const open = listing.cards.filter((card) => !card.state.startsWith("closed_"))
  const unreviewed = open.filter((card) => !fresh.has(card.key)).length
  const complete = scan === "complete"
  return {
    state: scan,
    changes,
    coverage: {
      scan,
      reviewed: complete ? open.length - unreviewed : null,
      unreviewed: complete ? unreviewed : null,
      refused: null,
      deferred: null,
      more_unreviewed: complete ? unreviewed > 0 : null,
    },
  }
}

function canonicalAbsent(deskRoot, personPrefix, key) {
  const relative = canonicalCardPath(deskRoot, personPrefix, key)
  try {
    readFileSync(path.join(deskRoot, ...relative.split("/")))
    return false
  } catch (error) {
    return error.code === "ENOENT"
  }
}
