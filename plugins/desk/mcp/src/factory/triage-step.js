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
//   - the runner's runtime loads (`loadRunner`) and the host can run the owned-catalog runner (Darwin only, `ownedCatalogHostSupport`);
//   - some open card needs a review on its current basis (`selectTriageCards`, at most 20, unreviewed before stale before retries);
//   - no billing variable is set, a qualification record is installed at `<factory state>/triage/qualification/qualification.json`
//     and restores (`restoreQualification`), and the pinned engine (`locateEngine`) reports a subscription sign-in (`probeSignIn`);
//   - the prepared input passes the catalog's own limits (`prepareTriageCatalog`), written once through `writeTriagePreparedInput`;
//   - before the sign-in probe, right before the reservation, and again right before the spawn, the full 15-minute run still ends by
//     `deadline` (which the caller sets three minutes before its budget ends, so the later steps keep their reserve).
//
// Every refusal that can be seen without a launch is decided before the reservation, spends no launch and leaves the generation's agent
// slot to the evaluator: a runtime that does not load, an unsupported host, a billing variable, no record, a stale record, no
// subscription sign-in and no time for a whole run are all quiet (`runner_unavailable` or `no_time_for_a_run`, an ok step, with the
// reason in `status.triage.runner`). The restored record is `qualified`, `missing`, `stale` (a whole record that does not restore for
// this install, engine or environment, with the restore's reason) or `damaged` (the file is not the record the qualifier wrote). Only
// `damaged` is a failure (`runner_blocked`); a Desk update, an engine update or a session with another environment makes a record stale,
// never a fault. A stale record whose engine pin is behind the installed engine (`engine_unpinned`) raises the measure step's
// `loop_alarm:triage_engine_unpinned` card. For a missing record, or a stale one whose reason qualifying again can fix (the
// runner's `TRIAGE_STALE_REASONS`), the step asks the qualifier (`autoQualify`) first, with the loop-worker lock it holds
// as proof: the qualifier makes its own refusals and reservations; when it launched it took the generation's agent slot
// (`runner_qualified`, or `qualification_failed`, which counts as a failed run), and a skip is quiet, except `auto_suspended` (the
// qualifier stopped after repeated host-side failures), which counts as a failed run so that it reaches `step_stale:triage`.
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
// once after it unlocks, and the next worker consumes the token. The token is minted after the reservation and before the spawn, so a
// run that then fails still returns it and the evaluation it deferred still starts. With no evaluation waiting nothing is minted.
//
// The agent run's health is kept apart from the refresh's, in `status.triage.run` (`last_at`, `last_result`, `last_ok_at`,
// `failures_in_a_row`). A launch succeeds only when a review was accepted: a runner that failed, a launch lost to the deadline and a
// run whose every row was refused or deferred (`nothing_accepted`) are failures. A pass that launches nothing (`not_due`, a quota code,
// an unavailable runner) neither clears that streak nor counts as a success while the last launch failed: the step record's
// `last_ok_at` and `failures_in_a_row` are carried (`recordStep` with `carry`), so launches that keep failing reach the stale alarm
// however many quiet passes run between them. `nothing_to_review` clears the streak: no card is left for a run to fail on.
//
// A launch that reserved is always finished in the ledger, and nothing after the reservation makes the step throw: a card whose
// acceptance throws is refused alone (`card_error`), and anything else is `step_error` with the launch counted as failed.
//
// Run folders (`triage/runs/<run>`) are bounded: a folder prepared and then not launched is removed at once, and of the launched runs
// that had no review accepted only the newest `KEPT_UNACCEPTED_RUNS` are kept. A run with an accepted review keeps its folder, because
// its protected rows (`triage/results/<run>/`) name records by the brief's own references.
//
// `status.triage` (local only) says what the step last did: the result, the runner's state and reason, the coverage counts, how many
// cards wait, the card scan (`refresh.scan`: `truncated` past `MAX_CARD_FILES` card files, a visible partial state, not a failure), the
// run's health, the last acknowledged review (its safe codes only) and when it was. Codes and counts only.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { randomBytes } from "node:crypto"
import { promises as fs, constants as fsConstants } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

import { checkPersonPrefix } from "./binding.js"
import { evaluateDue, LOOP_LOCK_NAME, newestRequestAt, triageQuotaFor, kickLoop } from "./evaluate-kick.js"
import { HEADLESS_TIMEOUT_MS, billingVariableBlocks, findAgentCli, probeSignIn } from "./headless.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import {
  createEvaluationContinuation, evaluationContinuationBasis, evaluationQuotaOpen, finishAgentLaunch, reserveAgentLaunch,
} from "./headless-ledger.js"
import { recordStep } from "./loop-status.js"
import { ensureOwnerOnlyDirectory } from "./os-protect.js"
import { factoryStateRoot, readConsent, readStatus, updateStatus } from "./outbox.js"
import { releaseLock, takeLock } from "./process-lock.js"
import { importTriageRunner } from "./triage-home.js"
import { prepareTriageCatalog, writeTriagePreparedFile } from "./triage-catalog.js"
import { beginTriageEmission, recordTriageCoverage, routedStore, settleTriageEmission } from "./triage-outbox.js"
import { readTriageBasis, resolveSelfDescribing, safeDeskPath } from "./triage-basis.js"
import { validateTriageResultBytes } from "./triage-schema.js"
import { readAcknowledgedAnnotations, refreshTriage, selectTriageCards, toSafeTriageReview } from "./triage-state.js"
import { publishOwnedTriage, writeProtectedTriageFile } from "./triage-write.js"
import { readCards as readCardsDefault, MAX_CARD_FILES } from "../desk/improvement-cards.js"

const { isLoopEnabled } = createRequire(import.meta.url)("./loop-switch.cjs")

/** At most this many cards go into one run. */
export const TRIAGE_BATCH_LIMIT = 20
/** A run's own time: the existing headless child timeout. */
export const TRIAGE_RUN_MS = HEADLESS_TIMEOUT_MS
/** Where this machine's qualified runner record is installed, under the factory state folder. */
export const QUALIFICATION_SEGMENTS = Object.freeze(["triage", "qualification", "qualification.json"])
/** How many launched run folders without an accepted review are kept (two days of launches at four a day). */
export const KEPT_UNACCEPTED_RUNS = 8
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
const whole = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

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
// The runner seams.
//
// `loadRunner(env)` is the one place the runner (`triage-runner.js`), its custody (`triage-custody.js`) and the qualifier
// (`triage-qualify.js`) are loaded: the dependency-free loader `importTriageRunner(env)` (`triage-home.js`), which answers
// `{state:"loaded",runner,custody,qualify}` or `{state:"unavailable",reason}`. A loader that throws or answers unavailable is a quiet
// `runner_unavailable` (`runtime_unloadable` unless it named its reason), never a failure: the installed plugin copy may hold no runtime
// the runner can load. Nothing is loaded until the ledger leaves a launch.

// The qualifier's code for a qualifier stopped after repeated host-side failures: an alarm, never a quiet skip.
const AUTO_SUSPENDED = "auto_suspended"
// The qualifier's code for a record it would not qualify again; its answer then carries its own restore, read with the marker.
const NOT_REQUALIFIABLE = "not_requalifiable"
// Each stale reason, and whether qualifying again can fix it: the runner's own `TRIAGE_STALE_REASONS`.
const staleReasons = (runtime) => (isObject(runtime.runner.TRIAGE_STALE_REASONS) ? runtime.runner.TRIAGE_STALE_REASONS : {})
// The engine the sign-in probe asks: the runner's own `locatePinnedEngine`, never a path from the record.
async function defaultLocateEngine(env, runtime) {
  const found = await runtime.runner.locatePinnedEngine({ env })
  return typeof found === "string" && path.isAbsolute(found) ? found : null
}
// Whether any Claude Code is installed: one the session can find, or a version in the home folder's install folder. A host with
// none has nothing for an engine pin to be behind, so its reason is `no_agent_cli`, never `engine_unpinned`.
async function defaultEngineInstalled(env) {
  if (findAgentCli({ env })) return true
  const versions = await swallow(() => fs.readdir(path.join(path.resolve(String(env.HOME)), ".local", "share", "claude", "versions")), [])
  return versions.length > 0
}
const ENGINE_UNPINNED = "engine_unpinned"
// A damaged record's reason is kept when it is a code (the restore may name new ones, such as a record copied from another machine).
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/u

/**
 * The installed record, restored by the runner's own `restoreTriageQualification`: `{state:"qualified",qualification}`,
 * `{state:"missing"}`, `{state:"stale",reason,requalify}` or `{state:"damaged",reason}`.
 */
async function defaultRestore(env, runtime) {
  return runtime.runner.restoreTriageQualification({ recordFile: path.join(await factoryStateRoot(env), ...QUALIFICATION_SEGMENTS), env })
}

const DEFAULT_IMPLS = {
  readCards: readCardsDefault, readTriageBasis, refreshTriage, publishOwnedTriage, readAcknowledgedAnnotations,
  reserveAgentLaunch, finishAgentLaunch, createEvaluationContinuation, newestRequestAt,
  readStatus, toSafeTriageReview, writeProtectedTriageFile,
  loadRunner: importTriageRunner, hostSupport: (runtime) => runtime.custody.ownedCatalogHostSupport(), restoreQualification: defaultRestore,
  autoQualify: (env, options, runtime) => runtime.qualify.autoQualifyTriage(env, options), engineInstalled: defaultEngineInstalled, locateEngine: defaultLocateEngine, childEnvironment: (env, runtime) => runtime.runner.triageChildEnvironment(env),
  billingVariableBlocks, probeSignIn, runTriageChild: (options, runtime) => runtime.runner.runTriageChild(options),
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
  // A string's JSON is its two quotes and each code point's own escaped bytes, so the size is kept as a running sum.
  let size = 2
  for (const char of text) {
    const bytes = Buffer.byteLength(JSON.stringify(char)) - 2
    if (size + bytes > PART_BYTES) {
      parts.push(current)
      current = ""
      size = 2
    }
    current += char
    size += bytes
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
// Writing an annotation.

// Every annotation write goes through here, so the triage outbox (`triage-outbox.js`) knows which annotations this machine wrote: the
// intent is marked before the write and settled with its answer. Only those are published to the store, and only once acknowledged.
// The outbox is bookkeeping: a failure to note it never changes what the write answers.
async function writeAnnotation(env, ctx, input) {
  const mark = { store: input.store, key: input.key, operation: input.operation, at: input.now.getTime() }
  const noted = await swallow(() => beginTriageEmission(env, { ...mark, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix }), null)
  const written = await swallow(() => ctx.impls.publishOwnedTriage({ env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, evidence: ctx.impls.evidence, ...input }), { state: "write_failed" })
  if (noted !== null) await swallow(() => settleTriageEmission(env, { ...mark, written }))
  return written
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
  // One card's acceptance; answers nothing. Whatever it throws is that card's alone (see the loop below).
  const acceptOne = async (card) => {
    const row = valid.get(card.key)
    if (row === undefined) {
      out.refused.push({ key: card.key, reason: bytes === null ? "no_candidate" : checked.refused.some((item) => item.result?.key === card.key) ? "row_refused" : "row_missing" })
      return
    }
    if (ctx.clock() >= ctx.deadlineMs) {
      out.deferred.push(card.key)
      return
    }
    const fresh = await swallow(() => ctx.impls.readTriageBasis({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: card.key, now: ctx.nowAt(), evidence: ctx.impls.evidence, env }), null)
    if (fresh === null || fresh.state !== "ready" || fresh.basis.fingerprint !== card.basis.fingerprint) {
      out.refused.push({ key: card.key, reason: "basis_changed" })
      return
    }
    const protectedToken = hex(16)
    const translated = translate(row, card)
    const authorizedEvidence = fresh.briefEvidence.map((item) => ({ id: item.id, kind: item.public?.kind, ref: item.public?.ref, revision: item.public?.revision, git_safe: item.public !== null && item.public !== undefined }))
    const safe = ctx.impls.toSafeTriageReview({ result: translated, basis: fresh.basis, authorizedEvidence, protectedToken, briefKeys })
    if (safe.state !== "safe") {
      out.refused.push({ key: card.key, reason: "review_unsafe" })
      return
    }
    // The full row stays in owner-protected state under the review's opaque token; Git gets only the safe codes.
    await ctx.impls.writeProtectedTriageFile(env, ["results", runToken, `${protectedToken}.json`], `${JSON.stringify({ schema: PROTECTED_RESULT_SCHEMA, key: card.key, result: row })}\n`)
    const written = await writeAnnotation(env, ctx, { key: card.key, store, expectedBasis: fresh.basis, review: safe.review, operation: "review", now: ctx.nowAt() })
    if (written.state === "acknowledged" || written.state === "adopted") {
      out.reviewed.push({ key: card.key, revision: written.revision, review: safe.review, fingerprint: card.basis.fingerprint })
    } else {
      if (written.state !== "stale_basis") out.writeFailed = true
      out.refused.push({ key: card.key, reason: written.state === "stale_basis" ? "basis_changed" : "not_acknowledged" })
    }
  }
  for (const card of prepared.cards) {
    try {
      await acceptOne(card)
    } catch {
      // A card whose acceptance threw (the protected row could not be stored, say) is refused alone; the others are still accepted.
      out.writeFailed = true
      out.refused.push({ key: card.key, reason: "card_error" })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The mechanical refresh.

async function mechanicalRefresh(env, ctx, store) {
  // The refresh reads as many card files as the card library reads anywhere (`MAX_CARD_FILES`), not the listing's default of 200.
  const readCards = (options) => ctx.impls.readCards({ ...options, limit: MAX_CARD_FILES })
  const refresh = await ctx.impls.refreshTriage({ env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: ctx.now, readCards, evidence: ctx.impls.evidence })
  const tally = { scan: refresh.state, changes: refresh.changes.length, written: 0, held: 0, foreign: 0, unknown: 0, deferred: 0, alarm: null }
  for (const change of refresh.changes) {
    if (change.operation === null) {
      // A review another machine wrote, whose protected basis this one does not hold, cannot be rechecked here. That is how a shared desk
      // looks from its second machine, not a fault: the card is simply not known to be current, so a run on this machine reviews it again.
      // A card the truncated scan did not reach is unknown, not held: past the bound the refresh is partial by design.
      if (change.reason === "protected_basis_unavailable") tally.foreign += 1
      else if (refresh.state === "truncated") tally.unknown += 1
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
    const written = await writeAnnotation(env, ctx, {
      key: change.key, store, expectedBasis: read.basis, review: null, operation: change.operation, now: ctx.now, ...(change.operation === "invalidate" ? { reason: change.reason } : {}),
    })
    if (written.alarm !== undefined) tally.alarm = written.alarm
    if (written.state === "acknowledged" || written.state === "adopted") tally.written += 1
    else tally.held += 1
  }
  return { refresh, tally }
}

// ---------------------------------------------------------------------------
// The step.

// The store the annotation identities are kept for: the one the desk's facts route to, when this machine contributes to it, because a
// review is published only to the store its desk routes to. A desk whose route nothing says yet takes the first store this machine
// contributes to, in a stable order; a desk that routes to a store this machine does not contribute to has none.
async function triageStore(env, deskRoot) {
  const consent = await readConsent(env)
  const contributing = Object.entries(consent.stores).filter(([, record]) => record?.contribute === true).map(([store]) => store).sort()
  const routed = await swallow(() => routedStore(env, deskRoot), null)
  return (routed === null ? contributing[0] : contributing.find((store) => store.toLowerCase() === routed.toLowerCase())) ?? null
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

// Results that launch nothing and leave no card for a run to fail on: they clear the run's failure streak.
const SETTLED = new Set(["nothing_to_review"])
const RUN_NONE = Object.freeze({ last_at: null, last_result: null, last_ok_at: null, failures_in_a_row: 0 })

// Mints the generation's one evaluation continuation for the evaluation a launch deferred, and keeps a new one in the status. Answers
// `{ continuation }` when the ledger issued one or one exists, `{}` otherwise.
async function mintContinuation(env, functions, { generation, status, at }) {
  const continuation = await swallow(() => functions.createEvaluationContinuation(env, { generation: generation ?? `triage-${hex(8)}`, expectedEvaluation: evaluationContinuationBasis(status), now: at }), undefined)
  if (continuation?.state === "issued") await swallow(() => updateStatus(env, (current) => ({ ...current, loop: { ...current.loop, evaluation_continuation: continuation.token } })))
  return ["issued", "exists"].includes(continuation?.state) ? { continuation } : {}
}

// Removes launched run folders that had no review accepted, beyond the newest `KEPT_UNACCEPTED_RUNS` (see the header).
async function pruneRuns(env) {
  const root = path.join(await factoryStateRoot(env), "triage")
  const accepted = new Set(await swallow(() => fs.readdir(path.join(root, "results")), []))
  const idle = []
  for (const name of await fs.readdir(path.join(root, "runs"))) {
    if (/^[0-9a-f]{32}$/u.test(name) && !accepted.has(name)) idle.push({ name, at: (await fs.lstat(path.join(root, "runs", name))).mtimeMs })
  }
  idle.sort((a, b) => b.at - a.at)
  for (const { name } of idle.slice(KEPT_UNACCEPTED_RUNS)) await fs.rm(path.join(root, "runs", name), { recursive: true, force: true })
}

/**
 * `runTriageStep(env, { deskRoot, personPrefix, pluginVersion, now, deadline, generation, onChild, onChildExit, impls })
 *   -> { ok, result, launched, reviewed, refused, deferred, unreviewed, continuation? }`.
 *
 * `deadline` is when the step must be done (the loop gives its budget less the later steps' reserve). `generation` is the worker
 * generation's code; the continuation is minted for it. `lock` is the loop-worker lock the caller holds, passed to the qualifier as proof. `launched` is true once a launch was reserved in the shared ledger: the
 * generation's agent slot is then spent, run or not. Counts are whole numbers or null (not known). `continuation`, when present, is
 * `{ state, token }` from `createEvaluationContinuation`; only `issued` is new. `impls` are seams for tests (see `DEFAULT_IMPLS`).
 * Results: `headless_session`; `no_consenting_store`; `refresh_failed`, `refresh_incomplete`, `status_unavailable`; the quiet results `not_due`, a ledger
 * quota code, `nothing_to_review`, `runner_unavailable`, `no_time_for_a_run` (before the reservation), `brief_empty` (no selected card
 * could be put in a brief) and `runner_qualified` (the qualifier launched and qualified the runner); the problems `runner_blocked`,
 * `preparation_held`, `ledger_blocked` and `qualification_failed`; after a launch, `ran`,
 * `nothing_accepted`, `write_incomplete`, `step_error`, `no_time_for_a_run` or the runner's own failure state. The step records itself.
 */
export async function runTriageStep(env, { deskRoot, personPrefix = "", pluginVersion, now = new Date(), deadline, generation = null, lock = null, onChild, onChildExit, impls = {} } = {}) {
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
  const at = nowDate.toISOString()
  const scope = JSON.stringify([path.resolve(deskRoot), personPrefix])
  // `runOutcome` is the agent launch's own outcome for its health: `ok`, `failed`, or null (no launch, or one that counts neither way).
  const record = { at, result: null, launched: false, runOutcome: null, runner: { state: null, reason: null, qualification: "not_checked" }, coverage: null, held: null, refresh: null, ledger: null }
  let publicationSuccess
  const finish = async (ok, result, extra = {}) => {
    const answer = { ok, result, launched: record.launched, ...none, ...extra }
    const { runOutcome, ...stored } = record
    publicationSuccess = { lastSuccessAt: stored.last_success_at, lastSuccessStore: stored.last_success_store, lastReview: stored.last_review }
    let carry = false
    await swallow(() => updateStatus(env, (current) => {
      const scopes = isObject(current.triage_by_desk) ? current.triage_by_desk : {}
      const before = isObject(scopes[scope]) ? scopes[scope] : {}
      const prior = isObject(before.run) ? before.run : RUN_NONE
      const run = runOutcome === "ok" ? { last_at: at, last_result: result, last_ok_at: at, failures_in_a_row: 0 }
        : runOutcome === "failed" ? { last_at: at, last_result: result, last_ok_at: prior.last_ok_at, failures_in_a_row: whole(prior.failures_in_a_row) + 1 }
        : SETTLED.has(result) ? { ...prior, failures_in_a_row: 0 } : prior
      // A pass whose run counts neither way says nothing about a run that keeps failing: its success is not the run's.
      carry = ok && runOutcome === null && whole(run.failures_in_a_row) > 0
      const triage = {
          ...stored, result, ok, run, counts: { reviewed: answer.reviewed, refused: answer.refused, deferred: answer.deferred, unreviewed: answer.unreviewed },
          last_success_at: stored.last_success_at ?? before.last_success_at ?? null, last_review: stored.last_review ?? before.last_review ?? null,
          last_success_store: stored.last_success_store ?? before.last_success_store ?? null,
          eligible: stored.eligible === undefined ? (before.eligible ?? null) : stored.eligible,
      }
      publicationSuccess = { lastSuccessAt: triage.last_success_at, lastSuccessStore: triage.last_success_store, lastReview: triage.last_review }
      return { ...current, triage, triage_by_desk: { ...scopes, [scope]: triage } }
    }))
    await swallow(() => recordStep(env, "triage", { ok, result, now: nowDate, carry }))
    // What a published batch says about this scan and the runner (`triage-outbox.js`); only a step that read the cards has anything to say.
    if (record.coverage !== null) await swallow(() => recordTriageCoverage(env, { store, coverage: record.coverage, counts: answer, runner: record.runner.state, now: nowDate.getTime(), deskRoot, personPrefix, ...publicationSuccess }))
    return answer
  }

  const store = await swallow(() => triageStore(env, deskRoot), null)
  if (store === null) return finish(true, "no_consenting_store")
  record.store = store

  // 1. The mechanical refresh, always.
  const mechanical = await swallow(() => mechanicalRefresh(env, ctx, store), null)
  if (mechanical === null) return finish(false, "refresh_failed")
  record.refresh = mechanical.tally
  record.coverage = mechanical.refresh.coverage
  // A scan cut off at the card bound is partial, and said (`refresh.scan`); only a scan that could not be read is a failure.
  const refreshOk = mechanical.refresh.state !== "unreadable" && mechanical.tally.held === 0 && mechanical.tally.deferred === 0
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

  // 3. Can this host load and run the runner at all?
  const runtime = await swallow(() => functions.loadRunner(env), null)
  if (runtime?.state !== "loaded") {
    record.runner = { state: "runtime_unavailable", reason: runtime?.reason === "runtime_unavailable" ? "runtime_unavailable" : "runtime_unloadable", qualification: "not_checked" }
    return quiet("runner_unavailable")
  }
  const host = await swallow(() => functions.hostSupport(runtime), { provenance: false })
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
  // Every refusal from here to the reservation is seen without a launch: quiet, nothing reserved, the slot left to the evaluator.
  // `retryAt` is when the shared ledger said a refused qualification may be tried again; it is kept beside the reason.
  const unavailable = async (state, given, qualification, retryAt) => {
    // The engine pin is behind only when a Claude Code is installed; with none, the reason is its own and opens no engine-pin card.
    const reason = given === ENGINE_UNPINNED && !(await swallow(() => functions.engineInstalled(env), true)) ? "no_agent_cli" : given
    record.runner = { state, reason, qualification, ...(typeof retryAt === "string" && Number.isFinite(Date.parse(retryAt)) ? { retry_at: new Date(retryAt).toISOString() } : {}) }
    return quiet("runner_unavailable", { unreviewed: unreviewedNow })
  }
  const noTime = () => deadlineMs - clock() < TRIAGE_RUN_MS

  // 5. A run would bill per token: the person's decision, never a launch.
  if (functions.billingVariableBlocks(env)) return unavailable("disabled_would_bill", null, "not_checked")

  // 6. A qualified runner, restored only now that there is work for it. Missing or stale is quiet; only a damaged record is a failure.
  const evaluationWaiting = async () => evaluateDue(status, nowDate, { newWorkAt: await swallow(() => functions.newestRequestAt(env), null) }) && evaluationQuotaOpen(status, nowDate)
  const restore = () => swallow(() => functions.restoreQualification(env, runtime, functions), { state: "stale", reason: "qualification_failed" })
  let loaded = await restore()
  const reasons = staleReasons(runtime)
  if (loaded.state === "missing" || (loaded.state === "stale" && reasons[loaded.reason] === true)) {
    // The qualifier makes its own cheap refusals, reserves its own launches and runs at most once a UTC day.
    const wasWaiting = await evaluationWaiting()
    // The qualifier reads `now()` as milliseconds and `deadline` as whole milliseconds on the same clock.
    const options = { lock, deadline: deadlineMs, generation, legacyEvaluator: status.evaluator, now: () => ctx.nowAt().getTime() }
    const qualified = await swallow(() => functions.autoQualify(env, options, runtime), { state: "failed", reason: "diagnostic_inadequate", launched: true })
    {
      const reason = typeof qualified.reason === "string" ? qualified.reason : null
      // `refused` (a gate, the lock, the ledger, no pinned engine, the sign-in) launched nothing and is quiet like `skipped`. A
      // qualifier suspended after repeated host-side failures is a failure to see, skipped or not.
      const known = qualified.state === "refused" ? "skipped" : qualified.state
      const state = reason === AUTO_SUSPENDED ? "failed" : ["qualified", "skipped"].includes(known) ? known : "failed"
      // A qualifier that launched took this generation's agent slot, and owes a waiting evaluation its continuation like any launch.
      if (qualified.launched !== false) {
        record.launched = true
        record.runner = { state: "qualifying", reason, qualification: state }
        record.runOutcome = state === "qualified" ? "ok" : state === "failed" ? "failed" : null
        const extra = wasWaiting ? await mintContinuation(env, functions, { generation, status, at: ctx.nowAt() }) : {}
        return state === "failed" ? finish(false, "qualification_failed", { unreviewed: unreviewedNow, ...extra }) : quiet(state === "qualified" ? "runner_qualified" : "runner_unavailable", { unreviewed: unreviewedNow, ...extra })
      }
      if (state === "failed") {
        record.runOutcome = "failed"
        record.runner = { state: "qualifying", reason, qualification: "failed" }
        return finish(false, "qualification_failed", { unreviewed: unreviewedNow })
      }
      // Skipped because the record is qualified after all: restore it again and go on.
      // Not one the qualifier would make again: its own restore (read with its marker) is the verdict, damaged included.
      if (reason === NOT_REQUALIFIABLE && isObject(qualified.restore)) loaded = qualified.restore
      else if (state === "skipped" && reason !== "qualified") return unavailable("scope_unqualified", reason, loaded.state, qualified.retry_at)
      else loaded = await restore()
    }
  }
  if (loaded.state === "damaged") {
    record.runner = { state: "scope_unqualified", reason: REASON_CODE.test(loaded.reason ?? "") ? loaded.reason : "unreadable", qualification: "damaged" }
    return finish(false, "runner_blocked", { unreviewed: unreviewedNow })
  }
  if (loaded.state === "missing") return unavailable("scope_unqualified", null, "missing")
  if (loaded.state !== "qualified") return unavailable("scope_unqualified", Object.hasOwn(reasons, loaded.reason ?? "") ? loaded.reason : "qualification_failed", "stale")
  record.runner = { state: null, reason: null, qualification: "loaded" }

  // 7. Time for a whole run, asked before anything is started or prepared; then the engine's own sign-in.
  if (noTime()) return quiet("no_time_for_a_run", { unreviewed: unreviewedNow })
  const engine = await swallow(() => functions.locateEngine(env, runtime), null)
  if (engine === null) return unavailable("sign_in_unknown", null, "loaded")
  // The sign-in is asked in the environment the runner launches with.
  const childEnv = await swallow(() => functions.childEnvironment(env, runtime), null)
  if (childEnv === null) return unavailable("environment_unsafe", null, "loaded")
  const signIn = (await swallow(() => functions.probeSignIn({ cli: engine, env: childEnv, onChild, onChildExit }), null))?.state
  if (signIn !== "subscription") return unavailable(["no_credentials", "disabled_would_bill"].includes(signIn) ? signIn : "sign_in_unknown", null, "loaded")

  // 8. Prepare the run's protected input.
  const selected = chosen.selection.selected.map((card) => ({ key: card.key, read: chosen.reads.get(card.key) }))
  const first = selected[0].read.basis
  let prepared
  let runDir
  let inputDir
  try {
    prepared = await prepareBatch({ deskRoot, selected, producerVersion: first.producer_version, rubricVersion: first.rubric_version })
    // No selected card could be put in a brief (a ruling that cannot be read, or one too large): nothing to send, said and counted.
    if (prepared.cards.length === 0) return quiet("brief_empty", { unreviewed: unreviewedNow, deferred: chosen.selection.deferred.length + prepared.deferred.length })
    prepareTriageCatalog({ brief: prepared.brief, records: prepared.records, recordRefs: prepared.recordRefs, generation: hex(32) })
    await swallow(() => pruneRuns(env))
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
  // A run folder that is prepared and then not launched is removed, not left behind.
  const abandon = () => swallow(() => fs.rm(runDir, { recursive: true, force: true }))

  // 9. Right before the reservation: the whole run must still end by the deadline.
  if (noTime()) {
    await abandon()
    return quiet("no_time_for_a_run", { unreviewed: unreviewedNow, deferred: deferredKeys.length + prepared.cards.length })
  }
  const waiting = await evaluationWaiting()
  const reservation = await swallow(() => functions.reserveAgentLaunch(env, { kind: "triage", generation, now: ctx.nowAt(), legacyEvaluator: status.evaluator }), { state: "write_failed" })
  if (reservation.state !== "reserved") {
    record.ledger = reservation.state
    await abandon()
    if (QUOTA_STATES.has(reservation.state)) return quiet(reservation.state, { unreviewed: unreviewedNow })
    return finish(false, "ledger_blocked", { unreviewed: unreviewedNow })
  }
  record.launched = true
  record.runOutcome = "failed"
  record.ledger = "reserved"

  // From here the launch is spent. Nothing below makes the step throw, and the reservation is always finished.
  let extra = {}
  try {
    let run = { state: "failed", reason: "diagnostic_inadequate" }
    try {
      // 10. The continuation for the evaluation this slot deferred, minted before the spawn so a crash cannot lose it twice.
      if (waiting) extra = await mintContinuation(env, functions, { generation, status, at: ctx.nowAt() })
      // 11. Right before the spawn, once more.
      run = noTime() ? { state: "no_time_for_a_run" } : await swallow(() => functions.runTriageChild({
        env, inputDir, resultFile: path.join(runDir, "candidate.json"), workDir: runDir, qualification: loaded.qualification, deadline: clock() + TRIAGE_RUN_MS, onChild, onChildExit,
      }, runtime), { state: "failed", reason: "diagnostic_inadequate" })
    } finally {
      const outcomeState = run.state === "ran" ? "ran" : ["timeout", "budget_exceeded", "failed"].includes(run.state) ? "failed" : "not_started"
      await swallow(() => functions.finishAgentLaunch(env, { token: reservation.token, state: outcomeState, now: ctx.nowAt() }))
    }
    record.runner = { state: run.state, reason: typeof run.reason === "string" ? run.reason : null, qualification: "loaded" }

    // 12. Acceptance, card by card, against the live basis.
    const accepted = run.state === "ran"
      ? await acceptCandidate(env, ctx, { prepared, resultFile: run.resultFile ?? path.join(runDir, "candidate.json"), runToken: prepared.runToken, store })
      : { reviewed: [], refused: prepared.cards.map((card) => ({ key: card.key, reason: "run_failed" })), deferred: [], writeFailed: false }

    // 13. What every selected card's attempt was, so the next run rotates past cards that keep failing.
    const doneAt = ctx.nowAt().toISOString()
    const nextAttempts = {}
    const known = new Set([...chosen.reads.keys()])
    for (const [key, value] of Object.entries(attempts)) if (known.has(key)) nextAttempts[key] = value
    for (const item of accepted.reviewed) nextAttempts[item.key] = { at: doneAt, state: "reviewed", fingerprint: item.fingerprint, review_fingerprint: item.fingerprint }
    for (const item of accepted.refused) {
      const card = prepared.cards.find((candidate) => candidate.key === item.key)
      nextAttempts[item.key] = { at: doneAt, state: "refused", fingerprint: card.basis.fingerprint, review_fingerprint: chosen.history[item.key]?.review_fingerprint ?? null }
    }
    for (const key of accepted.deferred) {
      const card = prepared.cards.find((candidate) => candidate.key === key)
      nextAttempts[key] = { at: doneAt, state: "deferred", fingerprint: card.basis.fingerprint, review_fingerprint: chosen.history[key]?.review_fingerprint ?? null }
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
      record.runOutcome = "ok"
      record.last_success_at = doneAt
      record.last_success_store = store.toLowerCase()
      const { protected_result: _token, related_keys: _related, duplicate_keys: _duplicates, evidence: _evidence, ...codes } = last.review
      record.last_review = { key: last.key, revision: last.revision, at: doneAt, ...codes }
    }
    if (run.state !== "ran") return await finish(false, run.state, { ...counts, ...extra })
    if (accepted.writeFailed) return await finish(false, "write_incomplete", { ...counts, ...extra })
    // A launch that returned and had no review accepted spent the launch for nothing: a failure, whatever the reasons.
    if (reviewed === 0) return await finish(false, "nothing_accepted", { ...counts, ...extra })
    return await finish(refreshOk, refreshOk ? "ran" : "refresh_incomplete", { ...counts, ...extra })
  } catch {
    record.runOutcome = "failed"
    return finish(false, "step_error", { unreviewed: unreviewedNow, ...extra })
  }
}

const TRIAGE_USAGE = "Usage: factory.js triage --desk <absolute desk root> [--person-prefix desks/<alias>]"

/**
 * `runTriageCommand({ argv, env, pluginVersion, ...seams }) -> { result, ok, failed, reviewed, refused, deferred, unreviewed }`: one triage
 * step outside the loop, under the loop worker's own lock (a worker that is running answers `busy`). It accepts only `--desk <absolute>`
 * and `--person-prefix <owned prefix>`. With the loop switched off (`DESK_FACTORY_LOOP`) it answers `disabled` and runs nothing. After it unlocks it kicks the loop once when it minted a new evaluation continuation. Seams:
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
  // The loop's own switch stops this step too, as it stops every other.
  if (!isLoopEnabled(env)) return reply("disabled", true)
  const root = await factoryStateRoot(env, { create: false })
  if (root === null) return reply("no_factory_state", true)
  const lock = await takeLock(root, { name: LOOP_LOCK_NAME, record: { children: [] } })
  if (lock === null) return reply("busy", true)
  let step
  try {
    const started = clock()
    step = await runTriageStep(env, { deskRoot, personPrefix, pluginVersion, now: new Date(started), deadline: new Date(started + COMMAND_DEADLINE_MS), generation: `command-${hex(8)}`, lock, impls: { clock, ...impls } })
  } finally {
    await releaseLock(lock)
  }
  if (step.continuation?.state === "issued") await swallow(() => kick(env, { continuation: true, scope: { deskRoot, personPrefix } }))
  const { ok, result, reviewed, refused, deferred, unreviewed } = step
  return reply(result, ok, { reviewed, refused, deferred, unreviewed })
}
