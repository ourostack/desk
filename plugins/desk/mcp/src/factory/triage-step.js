// The triage step: the loop worker's bounded way to review improvement cards with an agent, and the `factory triage` command.
//
// Every run does the mechanical part first and always: `refreshTriage` rechecks every acknowledged annotation against the
// canonical card, the effective claim at now, the rulings and the evidence, and each change it finds is written through
// `publishOwnedTriage` (a stale review keeps its last valid review as context; a card gone on a complete read is withdrawn; an
// incomplete read writes nothing). No agent, no quota. The six-hour agent gap never suppresses it.
//
// Then, only when everything below holds, the step takes the worker generation's one agent slot:
//
//   - the shared launch ledger's witness leaves a triage launch now (an unused current six-hour window, six hours since the last
//     triage launch, fewer than 30 launches today); the reservation itself is the authority, this is only an early look;
//   - the host can run the owned-catalog runner (Darwin only, `ownedCatalogHostSupport`) and a qualification record is installed at
//     `<factory state>/triage/qualification/qualification.json` and restores (`loadTriageQualification`). Until one is
//     installed, after the runner's native qualification on this machine, triage never launches; every other host degrades to
//     `runner_unavailable`, an ok step;
//   - some open card needs a review on its current basis (`selectTriageCards`, at most 20, unreviewed before stale before retries);
//   - the prepared input passes the catalog's own limits (`prepareTriageCatalog`), written once through `writeTriagePreparedInput`;
//   - right before the reservation, and again right before the spawn, the full 15-minute run still ends by `deadline` (which the
//     caller sets three minutes before its budget ends, so the later steps keep their reserve).
//
// The runner returns at most a protected UNACCEPTED candidate. Acceptance is this step's alone: it validates the candidate again
// against the original brief, then re-reads each card's live basis (card bytes, claim at now, rulings, evidence) and accepts a row
// only when that basis is exactly the one it prepared. Each accepted row's full text is kept in owner-protected factory state; only
// `toSafeTriageReview`'s closed codes go to Git, through `publishOwnedTriage`. Missing, refused and changed rows are named and
// counted; their cards keep whatever annotation they had (a stale one keeps its last valid review). A `ran` runner result, a
// submission or the model's text is never itself an accepted review.
//
// When triage took the slot from an evaluation the worker would have run, the step mints the generation's one evaluation
// continuation (`createEvaluationContinuation`) and keeps it in `status.loop.evaluation_continuation`; the worker kicks the loop
// once after it unlocks, and the next worker consumes the token. A triage that fails mints nothing and kicks nothing.
//
// `status.triage` (local only) says what the step last did: the result, the runner's state and reason, the coverage counts, how many
// cards wait, the last acknowledged review (its safe codes only) and when it was. Codes and counts only.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { randomBytes } from "node:crypto"
import { promises as fs, constants as fsConstants } from "node:fs"
import * as path from "node:path"

import { checkPersonPrefix } from "./binding.js"
import { evaluateDue, LOOP_LOCK_NAME, newestRequestAt, triageQuotaFor, kickLoop } from "./evaluate-kick.js"
import { HEADLESS_TIMEOUT_MS } from "./headless.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import {
  createEvaluationContinuation, evaluationContinuationBasis, evaluationQuotaOpen, finishAgentLaunch, reserveAgentLaunch,
} from "./headless-ledger.js"
import { recordStep } from "./loop-status.js"
import { ensureOwnerOnlyDirectory } from "./os-protect.js"
import { factoryStateRoot, readConsent, readStatus, updateStatus } from "./outbox.js"
import { releaseLock, takeLock } from "./process-lock.js"
import { prepareTriageCatalog, writeTriagePreparedFile } from "./triage-catalog.js"
import { readTriageBasis, resolveSelfDescribing, safeDeskPath } from "./triage-basis.js"
import { validateTriageResultBytes } from "./triage-schema.js"
import { readAcknowledgedAnnotations, refreshTriage, selectTriageCards, toSafeTriageReview } from "./triage-state.js"
import { publishOwnedTriage, writeProtectedTriageFile } from "./triage-write.js"
import { readCards as readCardsDefault, MAX_CARD_FILES } from "../desk/improvement-cards.js"

/** At most this many cards go into one run. */
export const TRIAGE_BATCH_LIMIT = 20
/** A run's own time: the existing headless child timeout. */
export const TRIAGE_RUN_MS = HEADLESS_TIMEOUT_MS
/** Where this machine's qualified runner record is installed, under the factory state folder. */
export const QUALIFICATION_SEGMENTS = Object.freeze(["triage", "qualification", "qualification.json"])
// The `factory triage` command's own budget: a run plus the three-minute reserve the loop keeps for its later steps.
const COMMAND_DEADLINE_MS = 17 * 60 * 1000
const NAMING = { label: "desk_factory", subject: "factory state" }
const ATTEMPTS_SCHEMA = "desk.factory.triage-attempts/1"
const PROTECTED_RESULT_SCHEMA = "desk.factory.triage-protected-result/1"
// The catalog's record caps (`triage-catalog.js`): 320 records with the brief's own, 16 KiB each. A ruling longer than one record
// is split into parts, each its own record and reference; the bound leaves room for the record's JSON frame.
const MAX_RECORDS = 319
const PART_BYTES = 15 * 1024
const MAX_RULING_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 20 * 16 * 1024 + 4096
// Ledger refusals that are the quota working as designed: an ok step, nothing launched.
const QUOTA_STATES = new Set(["quota_exhausted", "window_used", "triage_cooldown", "window_protected"])

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const hex = (bytes) => randomBytes(bytes).toString("hex")
const swallow = async (fn, fallback = undefined) => {
  try {
    return await fn()
  } catch {
    return fallback
  }
}
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * `writeTriagePreparedInput({inputDir,brief,records,recordRefs}) -> {path,sha256}`: writes the exact protected
 * `inputDir/triage-prepared.json` (`desk.factory.triage-prepared/1`) through the catalog's shared writer, the only file the runner reads.
 */
export async function writeTriagePreparedInput({ inputDir, brief, records, recordRefs }) {
  return writeTriagePreparedFile({ inputDir, brief, records, recordRefs })
}

// ---------------------------------------------------------------------------
// Protected state.

async function protectedDir(env, segments) {
  const root = await factoryStateRoot(env)
  let cursor = root
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    await ensureOwnerOnlyDirectory(cursor, process.platform, NAMING)
  }
  return cursor
}

async function readAttempts(env) {
  const file = path.join(await factoryStateRoot(env), "triage", "attempts.json")
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"))
    return value?.schema === ATTEMPTS_SCHEMA && isObject(value.attempts) ? value.attempts : {}
  } catch {
    // Missing or damaged: every card is simply not yet attempted, so it comes first; nothing is lost but a place in the queue.
    return {}
  }
}

const writeAttempts = (env, attempts) => writeProtectedTriageFile(env, ["attempts.json"], `${JSON.stringify({ schema: ATTEMPTS_SCHEMA, attempts })}\n`)

// ---------------------------------------------------------------------------
// The runner seams. The runner and its custody are imported only when a run may start, so a host that cannot run one never loads them.

async function defaultHostSupport() {
  const { ownedCatalogHostSupport } = await import("./triage-custody.js")
  return ownedCatalogHostSupport()
}

/** `{state:"loaded",qualification}`, `{state:"missing"}` (none installed) or `{state:"invalid",reason}` (installed, does not restore). */
async function defaultLoadQualification(env, functions) {
  const root = await factoryStateRoot(env)
  const recordFile = path.join(root, ...QUALIFICATION_SEGMENTS)
  try {
    await fs.lstat(recordFile)
  } catch {
    return { state: "missing" }
  }
  const record = await functions.loadTriageQualification({ recordFile, env })
  return record?.state === "qualified" ? { state: "loaded", qualification: record } : { state: "invalid", reason: typeof record?.reason === "string" ? record.reason : "diagnostic_inadequate" }
}

async function defaultLoadRecord(options) {
  const { loadTriageQualification } = await import("./triage-runner.js")
  return loadTriageQualification(options)
}

async function defaultRunTriageChild(options) {
  const { runTriageChild } = await import("./triage-runner.js")
  return runTriageChild(options)
}

const DEFAULT_IMPLS = {
  readCards: readCardsDefault, readTriageBasis, refreshTriage, publishOwnedTriage, readAcknowledgedAnnotations,
  reserveAgentLaunch, finishAgentLaunch, createEvaluationContinuation, newestRequestAt,
  readStatus, toSafeTriageReview,
  hostSupport: defaultHostSupport, loadQualification: defaultLoadQualification, loadTriageQualification: defaultLoadRecord, runTriageChild: defaultRunTriageChild,
  evidence: { resolve: resolveSelfDescribing },
}

// ---------------------------------------------------------------------------
// Preparation.

// The bytes of a ruling the basis named, read as the basis read it: a desk-relative path of safe segments, no link on the way.
async function readRulingText(deskRoot, id) {
  const relative = safeDeskPath(id)
  if (relative === null) return null
  let cursor = deskRoot
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment)
    const stat = await swallow(() => fs.lstat(cursor), null)
    if (stat === null || stat.isSymbolicLink()) return null
  }
  const bytes = await swallow(() => fs.readFile(cursor, { flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW }), null)
  if (bytes === null || bytes.length > MAX_RULING_BYTES) return null
  return swallow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes), null)
}

// Splits `text` into parts whose record JSON stays under the record cap. Never drops text: a part is cut by line, or inside a line
// that is too long, by code point.
function splitText(text) {
  const parts = []
  let current = ""
  const fits = (value) => Buffer.byteLength(JSON.stringify(value)) <= PART_BYTES
  for (const char of text) {
    if (!fits(current + char)) {
      parts.push(current)
      current = ""
    }
    current += char
  }
  // Only an empty text leaves nothing here; a record may not be empty, so it says so.
  parts.push(current === "" ? "(empty)" : current)
  return parts
}

// What the model reads about a card: the canonical fields only (the library builds every title from fixed tables), no path.
function cardText(card, basis) {
  return JSON.stringify({
    key: card.key, source: card.source, title: card.title, state: card.state, evidence: card.evidence, opened_at: card.opened_at,
    last_opened_at: card.last_opened_at, recurrences: card.recurrences, reopened: card.reopened, countermeasure: card.countermeasure,
    kaizen_url: card.kaizen_url, shipped_version: card.shipped_version, checks_run: card.checks_run, last_check_result: card.last_check_result,
    close_reason: card.close_reason, claim: basis.claim, authority: basis.authority.codes,
  })
}

/**
 * The run's brief, records and reference map from the selected cards and their current bases, as `writeTriagePreparedInput` takes
 * them. Cards that would overrun the catalog's record count are left for a later run (`deferred`). Each card's brief basis is a fresh
 * random token; `cards` keeps, for the parent alone, the token, the basis and the maps from brief references back to the basis's
 * evidence IDs and ruling paths.
 */
async function prepareBatch({ deskRoot, selected, producerVersion, rubricVersion }) {
  const batch = hex(8)
  const briefCards = []
  const cards = []
  const deferred = []
  const evidenceRecords = []
  const rulingRecords = []
  const evidenceRefs = new Map()
  const rulingRefs = new Map()
  let recordCount = 0
  for (const entry of selected) {
    const ownEvidence = []
    const newEvidence = []
    for (const item of entry.read.briefEvidence) {
      const identity = `${item.pointer}@${item.revision}`
      let ref = evidenceRefs.get(identity)
      if (ref === undefined) {
        ref = `e${evidenceRefs.size + newEvidence.length + 1}`
        newEvidence.push({ identity, ref, record: { kind: "evidence", revision: item.revision, text: JSON.stringify({ pointer: item.pointer, revision: item.revision }) } })
      }
      ownEvidence.push({ ref, id: item.id })
    }
    const ownRulings = []
    const newRulings = []
    let unreadable = false
    for (const ruling of entry.read.basis.rulings) {
      let refs = rulingRefs.get(ruling.id)
      if (refs === undefined) {
        const text = await readRulingText(deskRoot, ruling.id)
        if (text === null) {
          unreadable = true
          break
        }
        const base = `g${rulingRefs.size + newRulings.length + 1}`
        const parts = splitText(text)
        refs = parts.map((_, index) => (parts.length === 1 ? base : `${base}p${index + 1}`))
        newRulings.push({ id: ruling.id, refs, records: parts.map((part) => ({ kind: "ruling", revision: 1, text: part })) })
      }
      for (const ref of refs) ownRulings.push({ ref, id: ruling.id })
    }
    const added = 1 + newEvidence.length + newRulings.reduce((sum, item) => sum + item.records.length, 0)
    if (unreadable || recordCount + added > MAX_RECORDS) {
      deferred.push(entry.key)
      continue
    }
    recordCount += added
    for (const item of newEvidence) {
      evidenceRefs.set(item.identity, item.ref)
      evidenceRecords.push({ ref: item.ref, ...item.record })
    }
    for (const item of newRulings) {
      rulingRefs.set(item.id, item.refs)
      item.records.forEach((record, index) => rulingRecords.push({ ref: item.refs[index], ...record }))
    }
    const token = hex(16)
    briefCards.push({
      key: entry.key, basis: token, evidence_ids: [...new Set(ownEvidence.map((item) => item.ref))], ruling_ids: [...new Set(ownRulings.map((item) => item.ref))],
      authority_codes: entry.read.basis.authority.codes,
    })
    cards.push({
      key: entry.key, token, card: entry.read.card, basis: entry.read.basis, text: cardText(entry.read.card, entry.read.basis),
      evidence: new Map(ownEvidence.map((item) => [item.ref, item.id])), rulings: new Map(ownRulings.map((item) => [item.ref, item.id])),
    })
  }
  const records = cards.map((card, index) => ({ id: `r${String(index + 1).padStart(6, "0")}`, kind: "card", revision: 1, text: card.text }))
  const recordRefs = []
  for (const item of [...evidenceRecords, ...rulingRecords]) {
    const id = `r${String(records.length + 1).padStart(6, "0")}`
    records.push({ id, kind: item.kind, revision: item.revision, text: item.text })
    recordRefs.push({ ref: item.ref, id })
  }
  const brief = { batch, producer_version: producerVersion, rubric_version: rubricVersion, cards: briefCards }
  return { brief, records, recordRefs, cards, deferred }
}

// ---------------------------------------------------------------------------
// Acceptance.

// The candidate row with the brief's references replaced by what the basis names: ruling paths and the basis's evidence IDs.
function translate(row, card) {
  return {
    ...row,
    authority: { ...row.authority, ruling_ids: [...new Set(row.authority.ruling_ids.map((ref) => card.rulings.get(ref)))] },
    evidence: [...new Set(row.evidence.map((ref) => card.evidence.get(ref)))],
  }
}

async function readCandidate(resultFile) {
  const handle = await fs.open(resultFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) return null
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Accepts the rows of a protected candidate one card at a time (see the header). Answers
 * `{reviewed:[{key,result}], refused:[{key,reason}], deferred:[key], writeFailed}`.
 */
async function acceptCandidate(env, ctx, { prepared, resultFile, runToken, store }) {
  const out = { reviewed: [], refused: [], deferred: [], writeFailed: false }
  const bytes = await swallow(() => readCandidate(resultFile), null)
  const checked = bytes === null ? { valid: [], refused: [] } : validateTriageResultBytes(bytes, { brief: prepared.brief })
  const valid = new Map(checked.valid.map((row) => [row.key, row]))
  const briefKeys = prepared.brief.cards.map((card) => card.key)
  for (const card of prepared.cards) {
    const row = valid.get(card.key)
    if (row === undefined) {
      out.refused.push({ key: card.key, reason: bytes === null ? "no_candidate" : checked.refused.some((item) => item.result?.key === card.key) ? "row_refused" : "row_missing" })
      continue
    }
    if (ctx.clock() >= ctx.deadlineMs) {
      out.deferred.push(card.key)
      continue
    }
    const fresh = await swallow(() => ctx.impls.readTriageBasis({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: card.key, now: ctx.nowAt(), evidence: ctx.impls.evidence, env }), null)
    if (fresh === null || fresh.state !== "ready" || fresh.basis.fingerprint !== card.basis.fingerprint) {
      out.refused.push({ key: card.key, reason: "basis_changed" })
      continue
    }
    const protectedToken = hex(16)
    const translated = translate(row, card)
    const authorizedEvidence = fresh.briefEvidence.map((item) => ({ id: item.id, kind: item.public?.kind, ref: item.public?.ref, revision: item.public?.revision, git_safe: item.public !== null && item.public !== undefined }))
    const safe = ctx.impls.toSafeTriageReview({ result: translated, basis: fresh.basis, authorizedEvidence, protectedToken, briefKeys })
    if (safe.state !== "safe") {
      out.refused.push({ key: card.key, reason: "review_unsafe" })
      continue
    }
    // The full row stays in owner-protected state under the review's opaque token; Git gets only the safe codes.
    await writeProtectedTriageFile(env, ["results", runToken, `${protectedToken}.json`], `${JSON.stringify({ schema: PROTECTED_RESULT_SCHEMA, key: card.key, result: row })}\n`)
    const written = await swallow(() => ctx.impls.publishOwnedTriage({
      env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: card.key, store, expectedBasis: fresh.basis, review: safe.review,
      operation: "review", now: ctx.nowAt(), evidence: ctx.impls.evidence,
    }), { state: "write_failed" })
    if (written.state === "acknowledged" || written.state === "adopted") {
      out.reviewed.push({ key: card.key, revision: written.revision, review: safe.review, fingerprint: card.basis.fingerprint })
    } else {
      if (written.state !== "stale_basis") out.writeFailed = true
      out.refused.push({ key: card.key, reason: written.state === "stale_basis" ? "basis_changed" : "not_acknowledged" })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The mechanical refresh.

async function mechanicalRefresh(env, ctx, store) {
  const refresh = await ctx.impls.refreshTriage({ env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: ctx.now, readCards: ctx.impls.readCards, evidence: ctx.impls.evidence })
  const tally = { changes: refresh.changes.length, written: 0, held: 0, foreign: 0, deferred: 0, alarm: null }
  for (const change of refresh.changes) {
    if (change.operation === null) {
      // A review another machine wrote, whose protected basis this one does not hold, cannot be rechecked here. That is how a shared desk
      // looks from its second machine, not a fault: the card is simply not known to be current, so a run on this machine reviews it again.
      if (change.reason === "protected_basis_unavailable") tally.foreign += 1
      else tally.held += 1
      continue
    }
    // Writing stops at the deadline: what is left is said, not dropped, and the next pass finds it again.
    if (ctx.clock() >= ctx.deadlineMs) {
      tally.deferred += 1
      continue
    }
    const read = await swallow(() => ctx.impls.readTriageBasis({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: change.key, now: ctx.now, evidence: ctx.impls.evidence, env }), null)
    const wanted = change.operation === "withdraw" ? "card_missing" : null
    if (read === null || read.basis === null || (wanted !== null && read.state !== wanted) || (wanted === null && read.basis.canonical_revision === null)) {
      tally.held += 1
      continue
    }
    const written = await swallow(() => ctx.impls.publishOwnedTriage({
      env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: change.key, store, expectedBasis: read.basis, review: null,
      operation: change.operation, now: ctx.now, evidence: ctx.impls.evidence, ...(change.operation === "invalidate" ? { reason: change.reason } : {}),
    }), { state: "write_failed" })
    if (written.alarm !== undefined) tally.alarm = written.alarm
    if (written.state === "acknowledged" || written.state === "adopted") tally.written += 1
    else tally.held += 1
  }
  return { refresh, tally }
}

// ---------------------------------------------------------------------------
// The step.

// The first store this machine contributes to, in a stable order: the store the annotation identities are kept for.
async function triageStore(env) {
  const consent = await readConsent(env)
  return Object.entries(consent.stores).filter(([, record]) => record?.contribute === true).map(([store]) => store).sort()[0] ?? null
}

async function selectCards(env, ctx, { attempts, freshKeys }) {
  const listing = await ctx.impls.readCards({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, limit: MAX_CARD_FILES })
  const candidates = []
  const reads = new Map()
  let held = 0
  for (const card of listing.cards.filter((item) => !item.state.startsWith("closed_"))) {
    const read = await swallow(() => ctx.impls.readTriageBasis({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: card.key, now: ctx.now, evidence: ctx.impls.evidence, env }), null)
    // Only a card whose basis reads `ready` is reviewed: unknown authority or evidence is held, never guessed into a brief.
    if (read === null || read.state !== "ready" || typeof read.basis.producer_version !== "string") {
      held += 1
      continue
    }
    reads.set(card.key, read)
    candidates.push({ key: card.key, opened_at: card.opened_at, fingerprint: read.basis.fingerprint })
  }
  const history = {}
  for (const candidate of candidates) {
    const attempt = attempts[candidate.key]
    // A review the mechanical pass found current is reviewed on this basis, whichever host wrote it.
    const reviewFingerprint = freshKeys.has(candidate.key) ? candidate.fingerprint : attempt?.review_fingerprint ?? null
    if (attempt !== undefined || reviewFingerprint !== null) history[candidate.key] = { ...(attempt ?? { at: null, state: "reviewed", fingerprint: null }), review_fingerprint: reviewFingerprint }
  }
  const selection = selectTriageCards({ cards: candidates, attempts: history, now: ctx.now, limit: TRIAGE_BATCH_LIMIT })
  return { selection, reads, held, history }
}

async function writeStatus(env, record) {
  await updateStatus(env, (current) => {
    const before = isObject(current.triage) ? current.triage : {}
    return { ...current, triage: { ...record, last_success_at: record.last_success_at ?? before.last_success_at ?? null, last_review: record.last_review ?? before.last_review ?? null, eligible: record.eligible === undefined ? (before.eligible ?? null) : record.eligible } }
  })
}

/**
 * `runTriageStep(env, { deskRoot, personPrefix, pluginVersion, now, deadline, generation, onChild, onChildExit, impls })
 *   -> { ok, result, launched, reviewed, refused, deferred, unreviewed, continuation? }`.
 *
 * `deadline` is when the step must be done (the loop gives its budget less the later steps' reserve). `generation` is the worker
 * generation's code; the continuation is minted for it. `launched` is true once a launch was reserved in the shared ledger: the
 * generation's agent slot is then spent, run or not. Counts are whole numbers or null (not known). `continuation`, when present, is
 * `{ state, token }` from `createEvaluationContinuation`; only `issued` is new. `impls` are seams for tests (see `DEFAULT_IMPLS`).
 * Results: `headless_session`; `no_consenting_store`; `refresh_failed`, `refresh_incomplete`, `status_unavailable`; the quiet results `not_due`, a ledger
 * quota code, `nothing_to_review`, `runner_unavailable`; the problems `runner_blocked`, `preparation_held`, `no_time_for_a_run`,
 * `ledger_blocked`; after a launch, `ran`, `write_incomplete` or the runner's own failure state. The step records itself.
 */
export async function runTriageStep(env, { deskRoot, personPrefix = "", pluginVersion, now = new Date(), deadline, generation = null, onChild, onChildExit, impls = {} } = {}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("deskRoot: must be an absolute path")
  checkPersonPrefix(personPrefix, "runTriageStep")
  const nowDate = new Date(now)
  const deadlineMs = new Date(deadline ?? Number.NaN).getTime()
  if (Number.isNaN(nowDate.getTime()) || Number.isNaN(deadlineMs)) throw new TypeError("now and deadline: must be valid times")
  const none = { reviewed: null, refused: null, deferred: null, unreviewed: null }
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session", launched: false, ...none }
  const functions = { ...DEFAULT_IMPLS, ...impls }
  const clock = functions.clock ?? Date.now
  const clockStart = clock()
  const ctx = {
    deskRoot, personPrefix, now: nowDate, deadlineMs, impls: functions, clock,
    nowAt: () => new Date(nowDate.getTime() + Math.max(0, clock() - clockStart)),
  }
  const record = { at: nowDate.toISOString(), result: null, launched: false, runner: { state: null, reason: null, qualification: "not_checked" }, coverage: null, held: null, refresh: null, ledger: null }
  const finish = async (ok, result, extra = {}) => {
    const answer = { ok, result, launched: record.launched, ...none, ...extra }
    await swallow(() => writeStatus(env, { ...record, result, ok, counts: { reviewed: answer.reviewed, refused: answer.refused, deferred: answer.deferred, unreviewed: answer.unreviewed } }))
    await swallow(() => recordStep(env, "triage", { ok, result, now: nowDate }))
    return answer
  }

  const store = await swallow(() => triageStore(env), null)
  if (store === null) return finish(true, "no_consenting_store")

  // 1. The mechanical refresh, always.
  const mechanical = await swallow(() => mechanicalRefresh(env, ctx, store), null)
  if (mechanical === null) return finish(false, "refresh_failed")
  record.refresh = mechanical.tally
  record.coverage = mechanical.refresh.coverage
  const refreshOk = mechanical.refresh.state === "complete" && mechanical.tally.held === 0 && mechanical.tally.deferred === 0
  const quiet = async (result, extra = {}) => finish(refreshOk, refreshOk ? result : "refresh_incomplete", { unreviewed: count(mechanical.refresh.coverage.unreviewed), ...extra })
  const freshKeys = new Set()
  {
    const { annotations } = await swallow(() => functions.readAcknowledgedAnnotations({ deskRoot, personPrefix }), { annotations: [] })
    const changed = new Set(mechanical.refresh.changes.map((change) => change.key))
    for (const annotation of annotations) if (annotation.attempt.state === "reviewed" && !changed.has(annotation.key)) freshKeys.add(annotation.key)
  }

  // 2. Is an agent run due by the ledger's witness? Only the reservation decides, but nothing is prepared while the answer is no.
  const status = await swallow(() => functions.readStatus(env), null)
  if (status === null) return finish(false, "status_unavailable", { unreviewed: count(mechanical.refresh.coverage.unreviewed) })
  const quota = triageQuotaFor(status, nowDate.getTime())
  if (quota !== "ok" && quota !== "unwitnessed") {
    record.ledger = quota
    // A spent window or the six-hour gap is the quota working; a damaged or future-dated witness is a problem to see.
    return QUOTA_STATES.has(quota) ? quiet("not_due") : finish(false, "ledger_blocked", { unreviewed: count(mechanical.refresh.coverage.unreviewed) })
  }

  // 3. Can this host run the runner at all?
  const host = await swallow(() => functions.hostSupport(), { provenance: false })
  if (host?.provenance !== true) {
    record.runner = { state: "unsupported_host", reason: null, qualification: "not_checked" }
    return quiet("runner_unavailable")
  }

  // 4. What needs a review?
  const attempts = await readAttempts(env)
  const chosen = await swallow(() => selectCards(env, ctx, { attempts, freshKeys }), null)
  if (chosen === null) return finish(false, "refresh_failed")
  record.held = chosen.held
  record.eligible = chosen.selection.selected.length + chosen.selection.deferred.length
  const unreviewedNow = chosen.selection.coverage.unreviewed + chosen.held
  if (chosen.selection.selected.length === 0) return quiet("nothing_to_review", { unreviewed: unreviewedNow, deferred: 0, reviewed: 0, refused: 0 })

  // 5. A qualified runner, loaded only now that there is work for it.
  const loaded = await swallow(() => functions.loadQualification(env, functions), { state: "invalid", reason: "diagnostic_inadequate" })
  if (loaded.state !== "loaded") {
    record.runner = { state: "scope_unqualified", reason: loaded.state === "missing" ? null : loaded.reason ?? "diagnostic_inadequate", qualification: loaded.state === "missing" ? "missing" : "invalid" }
    // No record installed is a host not yet enabled (quiet); one that is installed and does not restore is a problem to see.
    if (loaded.state === "missing") return quiet("runner_unavailable", { unreviewed: unreviewedNow })
    return finish(false, "runner_blocked", { unreviewed: unreviewedNow })
  }
  record.runner = { state: null, reason: null, qualification: "loaded" }

  // 6. Prepare the run's protected input.
  const selected = chosen.selection.selected.map((card) => ({ key: card.key, read: chosen.reads.get(card.key) }))
  const first = selected[0].read.basis
  let prepared
  let runDir
  let inputDir
  try {
    prepared = await prepareBatch({ deskRoot, selected, producerVersion: first.producer_version, rubricVersion: first.rubric_version })
    if (prepared.cards.length === 0) throw new Error("nothing_prepared")
    prepareTriageCatalog({ brief: prepared.brief, records: prepared.records, recordRefs: prepared.recordRefs, generation: hex(32) })
    const runToken = hex(16)
    runDir = await fs.realpath(await protectedDir(env, ["triage", "runs", runToken]))
    inputDir = path.join(runDir, "input")
    await ensureOwnerOnlyDirectory(inputDir, process.platform, NAMING)
    await writeTriagePreparedInput({ inputDir, brief: prepared.brief, records: prepared.records, recordRefs: prepared.recordRefs })
    prepared.runToken = runToken
  } catch {
    return finish(false, "preparation_held", { unreviewed: unreviewedNow })
  }
  const deferredKeys = [...chosen.selection.deferred.map((card) => card.key), ...prepared.deferred]

  // 7. Right before the reservation: the whole run must still end by the deadline.
  if (deadlineMs - clock() < TRIAGE_RUN_MS) {
    record.runner = { ...record.runner, state: "no_time_for_a_run" }
    return finish(false, "no_time_for_a_run", { unreviewed: unreviewedNow, deferred: deferredKeys.length + prepared.cards.length })
  }
  const newWorkAt = await swallow(() => functions.newestRequestAt(env), null)
  const evaluationWaiting = evaluateDue(status, nowDate, { newWorkAt }) && evaluationQuotaOpen(status, nowDate)
  const reservation = await swallow(() => functions.reserveAgentLaunch(env, { kind: "triage", generation, now: ctx.nowAt(), legacyEvaluator: status.evaluator }), { state: "write_failed" })
  if (reservation.state !== "reserved") {
    record.ledger = reservation.state
    if (QUOTA_STATES.has(reservation.state)) return quiet(reservation.state, { unreviewed: unreviewedNow })
    return finish(false, "ledger_blocked", { unreviewed: unreviewedNow })
  }
  record.launched = true
  record.ledger = "reserved"

  // 8. The continuation for the evaluation this slot deferred, minted before the spawn so a crash cannot lose it twice.
  let continuation
  if (evaluationWaiting) {
    continuation = await swallow(() => functions.createEvaluationContinuation(env, { generation: generation ?? `triage-${hex(8)}`, expectedEvaluation: evaluationContinuationBasis(status), now: ctx.nowAt() }), undefined)
    if (continuation?.state === "issued") await swallow(() => updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, evaluation_continuation: continuation.token } })))
    if (continuation !== undefined && !["issued", "exists"].includes(continuation.state)) continuation = undefined
  }
  const extra = continuation === undefined ? {} : { continuation }

  // 9. Right before the spawn, once more.
  const resultFile = path.join(runDir, "candidate.json")
  let run
  if (deadlineMs - clock() < TRIAGE_RUN_MS) run = { state: "no_time_for_a_run" }
  else {
    run = await swallow(() => functions.runTriageChild({
      env, inputDir, resultFile, workDir: runDir, qualification: loaded.qualification, deadline: clock() + TRIAGE_RUN_MS, onChild, onChildExit,
    }), { state: "failed", reason: "diagnostic_inadequate" })
  }
  const outcomeState = run.state === "ran" ? "ran" : ["timeout", "budget_exceeded", "failed"].includes(run.state) ? "failed" : "not_started"
  await swallow(() => functions.finishAgentLaunch(env, { token: reservation.token, state: outcomeState, now: ctx.nowAt() }))
  record.runner = { state: run.state, reason: typeof run.reason === "string" ? run.reason : null, qualification: "loaded" }

  // 10. Acceptance, card by card, against the live basis.
  const accepted = run.state === "ran"
    ? await acceptCandidate(env, ctx, { prepared, resultFile: run.resultFile ?? resultFile, runToken: prepared.runToken, store })
    : { reviewed: [], refused: prepared.cards.map((card) => ({ key: card.key, reason: "run_failed" })), deferred: [], writeFailed: false }

  // 11. What every selected card's attempt was, so the next run rotates past cards that keep failing.
  const at = ctx.nowAt().toISOString()
  const nextAttempts = {}
  const known = new Set([...chosen.reads.keys()])
  for (const [key, value] of Object.entries(attempts)) if (known.has(key)) nextAttempts[key] = value
  for (const item of accepted.reviewed) nextAttempts[item.key] = { at, state: "reviewed", fingerprint: item.fingerprint, review_fingerprint: item.fingerprint }
  for (const item of accepted.refused) {
    const card = prepared.cards.find((candidate) => candidate.key === item.key)
    nextAttempts[item.key] = { at, state: "refused", fingerprint: card.basis.fingerprint, review_fingerprint: chosen.history[item.key]?.review_fingerprint ?? null }
  }
  for (const key of accepted.deferred) {
    const card = prepared.cards.find((candidate) => candidate.key === key)
    nextAttempts[key] = { at, state: "deferred", fingerprint: card.basis.fingerprint, review_fingerprint: chosen.history[key]?.review_fingerprint ?? null }
  }
  await swallow(() => writeAttempts(env, nextAttempts))

  const reviewed = accepted.reviewed.length
  const counts = {
    reviewed, refused: accepted.refused.length, deferred: accepted.deferred.length + deferredKeys.length,
    unreviewed: Math.max(0, unreviewedNow - reviewed),
  }
  record.eligible = Math.max(0, record.eligible - reviewed)
  if (reviewed > 0) {
    const last = accepted.reviewed.at(-1)
    record.last_success_at = at
    const { protected_result: _token, related_keys: _related, duplicate_keys: _duplicates, evidence: _evidence, ...codes } = last.review
    record.last_review = { key: last.key, revision: last.revision, at, ...codes }
  }
  if (run.state !== "ran") return finish(false, run.state, { ...counts, ...extra })
  const ok = !accepted.writeFailed && refreshOk
  return finish(ok, accepted.writeFailed ? "write_incomplete" : refreshOk ? "ran" : "refresh_incomplete", { ...counts, ...extra })
}

const TRIAGE_USAGE = "Usage: factory.js triage --desk <absolute desk root> [--person-prefix desks/<alias>]"

/**
 * `runTriageCommand({ argv, env, pluginVersion, ...seams }) -> { result, ok, failed, reviewed, refused, deferred, unreviewed }`: one triage
 * step outside the loop, under the loop worker's own lock (a worker that is running answers `busy`). It accepts only `--desk <absolute>`
 * and `--person-prefix <owned prefix>`. After it unlocks it kicks the loop once when it minted a new evaluation continuation. Seams:
 * `impls` (as `runTriageStep`), `clock`, `kick`.
 */
export async function runTriageCommand({ argv, env, pluginVersion, impls = {}, clock = Date.now, kick = kickLoop } = {}) {
  const options = new Map()
  const list = Array.isArray(argv) ? argv : []
  for (let index = 0; index < list.length; index += 2) {
    const flag = list[index]
    const value = list[index + 1]
    if (!["--desk", "--person-prefix"].includes(flag) || typeof value !== "string" || options.has(flag)) throw new Error(TRIAGE_USAGE)
    options.set(flag, value)
  }
  const deskRoot = options.get("--desk")
  const personPrefix = options.get("--person-prefix") ?? ""
  if (deskRoot === undefined || !path.isAbsolute(deskRoot) || !/^(?:|desks\/[A-Za-z0-9][A-Za-z0-9._-]*)$/u.test(personPrefix)) throw new Error(TRIAGE_USAGE)
  const reply = (result, ok, extra = {}) => ({ result, ok, failed: ok ? 0 : 1, reviewed: null, refused: null, deferred: null, unreviewed: null, ...extra })
  if (isHeadlessFactorySession(env)) return reply("headless_session", false)
  const root = await factoryStateRoot(env, { create: false })
  if (root === null) return reply("no_factory_state", true)
  const lock = await takeLock(root, { name: LOOP_LOCK_NAME, record: { children: [] } })
  if (lock === null) return reply("busy", true)
  let step
  try {
    const started = clock()
    step = await runTriageStep(env, { deskRoot, personPrefix, pluginVersion, now: new Date(started), deadline: new Date(started + COMMAND_DEADLINE_MS), generation: `command-${hex(8)}`, impls: { clock, ...impls } })
  } finally {
    await releaseLock(lock)
  }
  if (step.continuation?.state === "issued") await swallow(() => kick(env, { continuation: true }))
  const { ok, result, reviewed, refused, deferred, unreviewed } = step
  return reply(result, ok, { reviewed, refused, deferred, unreviewed })
}

