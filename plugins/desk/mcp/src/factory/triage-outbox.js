// The triage outbox: how an acknowledged local triage annotation becomes one immutable `triage/<batch>.json` file in a factory
// store, through the flush's own intake pull request and nothing else.
//
// Protected state, per store, under `triage-outbox/<store-slug>/` in the factory state folder (outside `outbox/`, so an older
// Desk never reads it as facts):
//
//   state.json     { schema, generation, requests, pending, emitted, rows, coverage?, scan_at?, run_counts?, runner_state?,
//                    held?, held_requests?, pr?, published?, staged_at?, delivered_at?, delivered_known?, damaged?, reset_at? }
//   <batch>.json   { schema, store, batch, path, sha, bytes?, state, staged_at, rows: [{ id, revision, desk_root, key, person_prefix, attest? }],
//                    refusals, pr?, sent_at?, ... }
//
// `generation` is this source's coverage generation: random, made once and kept for the life of the state file, whatever the
// counts do. A store reads the newest batch of one generation as that source's coverage, so it must not change with a count.
//
// `requests` holds, by canonical card key, the annotations THIS machine wrote: `{ desk_root, person_prefix, since, intent?,
// intended?, revision?, at?, batch?, held? }`. The triage step marks its intent before it calls `publishOwnedTriage`
// (`beginTriageEmission`: `intended` lists the attempt time and state of each write still open) and settles it after
// (`settleTriageEmission`): an acknowledged write is kept with its revision; an adopted, unacknowledged or failed one keeps its
// intent; every other answer wrote nothing, so that intent is taken back. An open intent is decided at the next plan against the
// desk remote's `main`: an annotation there whose attempt time and state are the ones this machine meant to write is this
// machine's write, acknowledged late, and is kept with its revision. An intent that is still not there three days later is
// dropped. So only the machine whose own write made a revision publishes it. `emitted` is the highest revision delivered for
// each public ID; a revision at or below it is never built again.
//
// `rows` holds, by public ID, each `reviewed` row the store's default branch has from this machine, with its exact row object:
// `{ desk_root, key, person_prefix, revision, row, attested_at, held? }`. A row's bytes are fixed for its revision. They are sent
// again, unchanged, about every 48 hours (a re-attestation, with the coverage of that day), because a store reads a row and its
// source as stale 72 hours after the newest batch that carries them. When one row is due, every row not sent in the last half day
// goes with it. Nothing is re-attested unless the step scanned the cards within 72 hours, and a row is sent again only while the
// desk remote's `main` still holds its revision as `reviewed`; otherwise it is dropped from `rows`.
// `pending` lists the staged batches not yet seen on the store's default branch.
//
// A request is only a note of what to look at. What is published is read again, every time, from the desk's remote-tracking
// `origin/main` (`readAcknowledged`): the registry and the annotation as that commit holds them, with their blob IDs. A local
// commit or a push that failed never moved that ref, so it never reaches a row.
//
// The flush drives the rest (`planTriage`, `prepareTriage`, `saveTriageSent`, `saveTriageRefused`):
//
//   - `planTriage` is local. It decides open intents, reads the requests against Git, the desk's route and the canonical card,
//     and says whether the flush has triage work. A request or a row whose desk does not route to this store waits without
//     sending the flush online, and a pending batch that holds one is taken apart (its record is marked replaced and its
//     requests are free again), so a batch staged before the route changed is never sent to the old store.
//   - `prepareTriage` is online. It needs the account's own push permission on the store (a fork cannot carry triage: the
//     store accepts it only from a maintainer), the store's `triage.json` at the commit the flush builds on, a regular file that
//     is exactly `{"triage":1}` (`readTriageReadiness`), a full listing of the default branch's `triage/` folder, and fresh
//     visibility for the store and for every repository a pointer names, in the bytes of a pending batch as much as in a new
//     row. A pending batch whose exact bytes are on the default branch is delivered. One that names a repository that is not
//     positively public now, or whose store's visibility is unknown, is taken apart and its rows are built again from the
//     acknowledged annotations. One whose path holds other bytes, or whose coverage or runner is not the current one, goes
//     again with the same rows under a fresh random batch ID, never as a change, so every triage file of one pull request says
//     the same coverage. New rows are built by `triageBatchFor` and staged (`stageTriageBatch`), at most twenty rows a batch.
//   - Any hold is kept for a day (`held: { code, until, since }`), so a store that is not ready is asked once a day, never at
//     every flush. A hold drops the pending batches from the intake pull request; they stay pending and no annotation is forgotten.
//   - A refusal that names triage (`namesTriage`) never quarantines facts and never marks a batch delivered: the batch waits a
//     day and goes again. The third refusal of one batch's rows ends it: its record is marked refused, its requests and rows
//     are held as `triage_batch_refused` until their annotation changes, and nothing is sent again.
//   - A state file that cannot be parsed, or whose fields are not the shapes above, is moved aside by the reader (never
//     overwritten in place). The next plan sees the moved file, starts a new state with a new generation and holds everything
//     for a day as `triage_state_damaged`.
//
// Coverage and the runner's state come from the triage step (`recordTriageCoverage`). When the scan's state changes after
// something was published, a batch with no rows says so, because a store must not keep reading an incomplete source as complete.
//
// `status.triage_publication[store]` is the summary the local status reads: counts, hold codes and times, nothing else.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import * as path from "node:path"

import { MAX_CARD_FILES, isClaimLive, readCards } from "../desk/improvement-cards.js"
import { countTriageOutboxDamaged, gitBlobSha, listMarkers, readTriageOutbox, updateStatus, updateTriageOutbox } from "./outbox.js"
import { isPlainObject } from "./schema.js"
import { markerRoute } from "./session-route.js"
import { resolveStore } from "./store-route.js"
import { readCanonicalCard } from "./triage-basis.js"
import { coarseAge, publicEvidenceFor, triageBatchFor, triageBatchOf } from "./triage-publish.js"
import { TRIAGE_PATH, TRIAGE_RUNNER_STATES, validateTriageChange } from "./triage-schema.js"
import { triagePaths, validateTriageAnnotation, validateTriageIdentities } from "./triage-state.js"

const STATE = "state.json"
const STATE_SCHEMA = "desk.factory.triage-outbox/1"
const BATCH_SCHEMA = "desk.factory.triage-batch/1"
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** A store reads a row, and a source's coverage, as stale this long after the newest batch that carries them. */
const FRESH_MS = 72 * HOUR_MS
/** A delivered row, or the coverage alone, is sent again when nothing carried it for this long. */
const ATTEST_MS = 48 * HOUR_MS
/** An intent whose write is still not on the desk remote's main after this long was never written. */
const INTENT_MS = 3 * DAY_MS
const MAX_ROWS = 20
/** At most this many triage files ride one intake pull request; the rest wait for the next flush. */
const MAX_TRIAGE_FILES = 8
/** A batch whose rows the store refused this many times is not sent again. */
const MAX_REFUSALS = 3
const MAX_INTENDED = 8
const READINESS_FLAG = 1
const NOT_READY = "triage_store_not_ready"
const READINESS_UNKNOWN = "triage_readiness_unknown"
const BATCH_REFUSED = "triage_batch_refused"
const NOT_PUBLIC = "triage_evidence_not_public"
const SHA = /^[0-9a-f]{40}$/u
const HEX16 = /^[0-9a-f]{16}$/u
const HEX32 = /^[0-9a-f]{32}$/u
const REPO_OF_REF = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\//u
const KNOWN_VISIBILITY = new Set(["public", "private", "internal"])
const GIT_TIMEOUT_MS = 10_000
const MAIN = "refs/remotes/origin/main"
/** The attempt state each `publishOwnedTriage` operation writes. */
const WRITTEN_STATE = { review: "reviewed", invalidate: "stale", withdraw: "withdrawn" }
/** Answers after which the write may still be on the remote: decided at the next plan, against the remote. */
const UNDECIDED = new Set(["adopted", "unacknowledged", "write_failed"])

const iso = (ms) => new Date(ms).toISOString()
const hex = (bytes) => randomBytes(bytes).toString("hex")
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const isTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const optional = (value, check) => value === undefined || check(value)

// The shapes the code below relies on. A file that fails this is moved aside by the reader, never read as if it were whole.
const validState = (value) =>
  value.schema === STATE_SCHEMA && typeof value.generation === "string" && HEX32.test(value.generation) &&
  isPlainObject(value.requests) && Object.values(value.requests).every((request) => isPlainObject(request) && typeof request.desk_root === "string" && typeof request.person_prefix === "string" && optional(request.intended, Array.isArray) && (request.intent !== true || request.intended !== undefined)) &&
  Array.isArray(value.pending) && value.pending.every((batch) => typeof batch === "string" && HEX16.test(batch)) &&
  isPlainObject(value.emitted) && Object.values(value.emitted).every(Number.isSafeInteger) &&
  isPlainObject(value.rows) && Object.values(value.rows).every((entry) => isPlainObject(entry) && isPlainObject(entry.row) && typeof entry.desk_root === "string" && typeof entry.key === "string" && typeof entry.person_prefix === "string" && Number.isSafeInteger(entry.revision) && isTime(entry.attested_at)) &&
  optional(value.held, (held) => isPlainObject(held) && typeof held.code === "string" && isTime(held.until)) &&
  optional(value.coverage, isPlainObject) && optional(value.published, isPlainObject) && optional(value.held_requests, isPlainObject) && optional(value.scan_desk, (root) => typeof root === "string")
const VALID_STATE = { isValid: (value) => value === null || (isPlainObject(value) && validState(value)) }
const stateOf = (value) => value ?? { schema: STATE_SCHEMA, generation: hex(16), requests: {}, pending: [], emitted: {}, rows: {} }
const readState = async (env, store) => stateOf(await readTriageOutbox(env, store, STATE, VALID_STATE))
const update = (env, store, change) => updateTriageOutbox(env, store, STATE, (current) => change(stateOf(current)), VALID_STATE)
const heldNow = (state, now) => (state.held !== undefined && now < Date.parse(state.held.until) ? state.held.code : null)
// A hold for a day. `since` is when this code first held without a break, for the alarm on a hold that never clears.
const heldAs = (state, code, now) => ({ code, until: iso(now + DAY_MS), since: state.held?.code === code && isTime(state.held.since) ? state.held.since : iso(now) })
const isPendingRecord = (record) => isPlainObject(record) && record.state === "pending" && typeof record.bytes === "string" && typeof record.path === "string" && typeof record.sha === "string" &&
  Array.isArray(record.rows) && record.rows.every((row) => isPlainObject(row) && typeof row.id === "string" && Number.isSafeInteger(row.revision) && typeof row.desk_root === "string" && typeof row.key === "string" && typeof row.person_prefix === "string")
const untied = (requests, batch) => Object.fromEntries(Object.entries(requests).map(([key, { batch: tied, ...request }]) => [key, tied === undefined || tied === batch ? request : { ...request, batch: tied }]))

// ---------------------------------------------------------------------------
// What the triage step records.

/**
 * `beginTriageEmission(env, { store, key, deskRoot, personPrefix, operation, at }) -> { prior }`: marks this machine's intent to
 * write the card's annotation, before `publishOwnedTriage` runs. `operation` and `at` (a millisecond time) are that call's
 * `operation` and `now`: the attempt state and time the annotation will carry. `prior` is true when an earlier intent for the
 * card was never settled.
 */
export async function beginTriageEmission(env, { store, key, deskRoot, personPrefix, operation, at }) {
  let prior = false
  await update(env, store, (state) => {
    const before = state.requests[key]
    prior = before?.intent === true
    const intended = [...(before?.intended ?? []), { at: iso(at), state: WRITTEN_STATE[operation] }].slice(-MAX_INTENDED)
    return { ...state, requests: { ...state.requests, [key]: { ...before, desk_root: deskRoot, person_prefix: personPrefix, since: before?.since ?? iso(at), intent: true, intended } } }
  })
  return { prior }
}

/**
 * `settleTriageEmission(env, { store, key, written, operation, at })`: what `publishOwnedTriage` answered (`written`) for the
 * intent `beginTriageEmission` marked with the same `operation` and `at`. See the header for which answers leave a request.
 */
export async function settleTriageEmission(env, { store, key, written, operation, at }) {
  await update(env, store, (state) => {
    const { [key]: request = {}, ...others } = state.requests
    const { intent: _intent, intended = [], ...settled } = request
    let next
    if (written.state === "acknowledged") {
      // A new revision is a new thing to publish: the batch and the hold of the earlier one do not carry over.
      const { batch: _batch, held: _held, ...fresh } = settled
      next = { ...fresh, revision: written.revision, at: iso(at) }
    } else if (UNDECIDED.has(written.state)) next = request
    else {
      // Nothing was written: this intent is taken back, an earlier one that is still open stays.
      const open = intended.filter((item) => item.at !== iso(at) || item.state !== WRITTEN_STATE[operation])
      next = open.length > 0 ? { ...settled, intent: true, intended: open } : settled
    }
    return { ...state, requests: next.intent === true || Number.isSafeInteger(next.revision) ? { ...others, [key]: next } : others }
  })
}

/**
 * `recordTriageCoverage(env, { store, coverage, counts, runner, now, deskRoot })`: the triage step's latest scan of the desk at
 * `deskRoot`, at `now` (a millisecond time). The desk is kept so a batch that carries only the coverage is checked against its route. `coverage` is `refreshTriage`'s (`{ scan, reviewed, unreviewed, more_unreviewed }`, counts null when the scan was not
 * complete), read before any run; `counts` the step's own `{ reviewed, refused, deferred }` for a run, null where it had none;
 * `runner` the runner's state code or null. The stored coverage is the public shape without its generation. Refused and deferred
 * counts come from the last step that knew them and stay null until a run has completed. Every count of an incomplete scan is null.
 */
export async function recordTriageCoverage(env, { store, coverage, counts, runner, now, deskRoot }) {
  await update(env, store, (state) => {
    const complete = coverage.scan === "complete"
    const added = count(counts.reviewed) ?? 0
    const run = { refused: count(counts.refused) ?? state.run_counts?.refused ?? null, deferred: count(counts.deferred) ?? state.run_counts?.deferred ?? null }
    const reviewed = complete ? count(coverage.reviewed) : null
    const unreviewed = complete ? count(coverage.unreviewed) : null
    return {
      ...state,
      coverage: {
        scan: coverage.scan,
        reviewed: reviewed === null ? null : reviewed + added,
        unreviewed: unreviewed === null ? null : Math.max(0, unreviewed - added),
        refused: complete ? run.refused : null,
        deferred: complete ? run.deferred : null,
        more_unreviewed: unreviewed === null ? null : unreviewed - added > 0,
      },
      scan_at: iso(now),
      scan_desk: deskRoot,
      run_counts: run,
      runner_state: TRIAGE_RUNNER_STATES.includes(runner) ? runner : state.runner_state ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// Reading what is acknowledged.

function gitOut(deskRoot, args) {
  const result = spawnSync("git", ["-C", deskRoot, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  return result.status === 0 ? result.stdout : null
}

/**
 * `readAcknowledged({ deskRoot, personPrefix, key }) -> { annotation, identity, ack } | null`: the card's annotation and the
 * identity registry as the desk's remote-tracking `origin/main` holds them, with the readback `triageFor` checks them against.
 * Null when the desk is not a Git checkout with that ref, either file is absent there, or either fails its own validator.
 */
export function readAcknowledged({ deskRoot, personPrefix, key }) {
  const paths = triagePaths(deskRoot, personPrefix, key)
  const commit = paths === null ? "" : (gitOut(deskRoot, ["rev-parse", "-q", "--verify", `${MAIN}^{commit}`]) ?? "").toString("utf8").trim()
  if (!SHA.test(commit)) return null
  const registryBytes = gitOut(deskRoot, ["cat-file", "blob", `${commit}:${paths.registry}`])
  const annotationBytes = gitOut(deskRoot, ["cat-file", "blob", `${commit}:${paths.annotation}`])
  const identity = registryBytes === null ? undefined : validateTriageIdentities(registryBytes).value
  const annotation = annotationBytes === null ? undefined : validateTriageAnnotation(annotationBytes).value
  if (identity === undefined || annotation === undefined) return null
  return { annotation, identity, ack: { remote: "origin", ref: "refs/heads/main", commit, registry_blob: gitBlobSha(registryBytes), annotation_blob: gitBlobSha(annotationBytes) } }
}

/**
 * `routedStore(env, deskRoot) -> store | null`: the store the desk's facts route to: its own declaration, else the newest
 * route a session hook recorded for it (`kaizen-file.js` reads the route the same way). Null when neither says.
 */
export async function routedStore(env, deskRoot, markers = () => listMarkers(env)) {
  const current = resolveStore({ deskRoot })
  if (current.source !== "default") return current.store
  const recorded = (await markers())
    .filter((marker) => marker.host !== "codex-cli" && marker.desk_root !== null && path.resolve(marker.desk_root) === path.resolve(deskRoot) && marker.routing !== undefined)
    .sort((left, right) => (left.updated_at < right.updated_at ? 1 : -1))
  return recorded.length === 0 ? null : markerRoute(recorded[0]).store
}

// ---------------------------------------------------------------------------
// The flush's local plan.

const summaryOf = (state, now) => {
  const code = heldNow(state, now)
  // The oldest thing still not on the store: a request, or a delivered row that is no longer sent.
  const waits = [...Object.values(state.requests).map((request) => request.since), ...Object.values(state.rows).map((entry) => entry.held?.since)].filter(isTime).sort()
  // The store reads each row by the newest batch that carried it: the oldest of those times is when the first row goes stale there.
  const attested = Object.values(state.rows).map((entry) => entry.attested_at).sort()
  return {
    at: iso(now),
    pending: state.pending.length,
    waiting: Object.values(state.requests).filter((request) => !state.pending.includes(request.batch)).length,
    ...(code === null ? {} : { held: code, held_since: state.held.since }),
    ...(Object.keys(state.held_requests ?? {}).length === 0 ? {} : { held_requests: state.held_requests }),
    ...(waits.length === 0 ? {} : { waiting_since: waits[0] }),
    ...(state.delivered_at === undefined ? {} : { delivered_at: state.delivered_at, coverage_known: state.delivered_known === true }),
    ...(state.coverage === undefined ? {} : { scan: state.coverage.scan }),
    ...(state.reset_at === undefined ? {} : { reset_at: state.reset_at }),
    ...(attested.length === 0 ? {} : { rows_oldest_at: attested[0], rows_held: Object.values(state.rows).filter((entry) => entry.held !== undefined).length }),
  }
}

async function writeSummary(env, store, state, now) {
  await updateStatus(env, (status) => ({ ...status, triage_publication: { ...(isPlainObject(status.triage_publication) ? status.triage_publication : {}), [store]: summaryOf(state, now) } }))
}

// An open intent against the annotation the desk remote's main holds for the card now (null when it holds none for this store).
function decideIntent(request, annotation, now) {
  if (request.intent !== true) return request
  const { intent: _intent, intended, ...rest } = request
  if (annotation !== null && intended.some((item) => item.at === annotation.attempt.at && item.state === annotation.attempt.state)) {
    const { batch: _batch, held: _held, ...fresh } = rest
    return { ...fresh, revision: annotation.revision, at: iso(now) }
  }
  return intended.every((item) => now - Date.parse(item.at) > INTENT_MS) ? rest : request
}

// A delivered row against the desk remote's `main`: still that review, a newer or different annotation, or not readable now.
function standing(entry) {
  const read = entry === undefined ? null : readAcknowledged({ deskRoot: entry.desk_root, personPrefix: entry.person_prefix, key: entry.key })
  if (read === null) return "unknown"
  return read.annotation.revision === entry.revision && read.annotation.attempt.state === "reviewed" ? "reviewed" : "superseded"
}

// The record of a pending batch is taken out of the state: its requests are free to be built again.
const forget = (env, store, batch) => update(env, store, (state) => ({ ...state, pending: state.pending.filter((id) => id !== batch), requests: untied(state.requests, batch) }))

// A pending batch that must not be sent as it is: its record is kept, marked replaced, and its requests are free again.
async function dissolve(env, store, record, reason) {
  const { bytes: _bytes, ...kept } = record
  await updateTriageOutbox(env, store, `${record.batch}.json`, () => ({ ...kept, state: "replaced", reason }))
  return forget(env, store, record.batch)
}

// Delivered rows that are not sent again at their revision, with why.
const holdRows = (env, store, ids, code, now) => update(env, store, (state) => ({
  ...state,
  rows: Object.fromEntries(Object.entries(state.rows).map(([id, entry]) => [id, ids.includes(id) && entry.held === undefined ? { ...entry, held: { code, since: iso(now) } } : entry])),
}))

/**
 * `planTriage(env, { store, now }) -> { work, state, candidates, held, attest, coverageDue }`, from local state and Git only.
 * `candidates` are the requests ready to build, `[{ key, id, deskRoot, personPrefix, annotation, identity, ack, card }]`; `attest`
 * the public IDs of the delivered rows to send again, oldest first; `coverageDue` whether a batch with no rows is due, because
 * nothing carried the coverage for two days or the scan's state changed, and the desk that was scanned routes here. `held` counts what waits, by code: `triage_route_elsewhere`, `triage_unacknowledged`,
 * `triage_coverage_unknown`, `triage_runner_unknown`, `triage_batch_refused`, `triage_evidence_not_public`, or the code
 * `triageBatchFor` refused this revision's row with. `work` is true when the flush has to go online for triage. A store with
 * no triage state costs one file read and one folder listing.
 */
export async function planTriage(env, { store, now }) {
  const kept = await readTriageOutbox(env, store, STATE, VALID_STATE)
  const damaged = await countTriageOutboxDamaged(env, store)
  const idle = (state) => ({ work: false, state, candidates: [], held: {}, attest: [], coverageDue: false })
  if (kept === null && damaged === 0) return idle(stateOf(null))
  let state = stateOf(kept)
  // A state file was moved aside since this state last looked: what it held is not known, so nothing is sent for a day.
  if (damaged > (state.damaged ?? 0)) state = await update(env, store, (latest) => ({ ...latest, damaged, reset_at: iso(now), held: heldAs(latest, "triage_state_damaged", now) }))
  if (heldNow(state, now) !== null) {
    await writeSummary(env, store, state, now)
    return idle(state)
  }
  const held = {}
  const hold = (code) => { held[code] = (held[code] ?? 0) + 1 }
  let markers
  const routes = new Map()
  const routesHere = async (deskRoot) => {
    if (!routes.has(deskRoot)) routes.set(deskRoot, (await routedStore(env, deskRoot, () => (markers ??= listMarkers(env))))?.toLowerCase() === store.toLowerCase())
    return routes.get(deskRoot)
  }

  // 1. Pending batches: one whose record is gone or settled is forgotten, one that holds a row of a desk that no longer routes here is taken apart.
  const staged = new Set()
  for (const batch of state.pending) {
    const record = await readTriageOutbox(env, store, `${batch}.json`)
    if (!isPendingRecord(record)) {
      state = await forget(env, store, batch)
      continue
    }
    let here = true
    for (const deskRoot of new Set(record.rows.map((row) => row.desk_root))) here &&= await routesHere(deskRoot)
    if (!here) state = await dissolve(env, store, record, "route")
    // A row sent again must still be the review the desk's remote holds; the rows are looked at again below.
    else if (record.rows.some((row) => row.attest === true && standing(state.rows[row.id]) !== "reviewed")) state = await dissolve(env, store, record, "superseded")
    else for (const row of record.rows) staged.add(row.id)
  }

  // 2. Requests not in a pending batch.
  const candidates = []
  const decided = new Map()
  const listings = new Map()
  const ready = state.coverage !== undefined && typeof state.runner_state === "string"
  for (const [key, before] of Object.entries(state.requests).filter(([, request]) => !state.pending.includes(request.batch))) {
    const { desk_root: deskRoot, person_prefix: personPrefix } = before
    if (state.coverage === undefined) hold("triage_coverage_unknown")
    else if (!ready) hold("triage_runner_unknown")
    else if (!(await routesHere(deskRoot))) hold("triage_route_elsewhere")
    else {
      const read = readAcknowledged({ deskRoot, personPrefix, key })
      const entry = read?.identity.entries.find((candidate) => candidate.key === key && candidate.store === store.toLowerCase())
      const seen = entry === undefined ? 0 : read.annotation.revision
      const request = decideIntent(before, entry === undefined ? null : read.annotation, now)
      if (request !== before) decided.set(key, request)
      const mine = Number.isSafeInteger(request.revision) ? request.revision : 0
      if (mine === 0 || seen !== mine || mine <= (state.emitted[entry.id] ?? 0)) {
        // Nothing of this request to send now. It waits while a write of this machine may still arrive, or while the remote's main, as
        // this machine last saw it, is behind the revision it saw acknowledged. Otherwise it is over: delivered, or a later revision
        // that another machine wrote and will publish.
        if (request.intent === true || seen < mine) hold("triage_unacknowledged")
        else decided.set(key, null)
      } else if (request.held?.revision === mine) hold(request.held.code)
      else {
        const listing = listings.get(`${deskRoot}\n${personPrefix}`) ?? (await readCards({ deskRoot, personPrefix, limit: MAX_CARD_FILES }))
        listings.set(`${deskRoot}\n${personPrefix}`, listing)
        const found = await readCanonicalCard({ deskRoot, personPrefix, key, readCards: async () => listing })
        candidates.push({ key, id: entry.id, deskRoot, personPrefix, ...read, card: found === null ? null : { state: found.card.state, claimed: isClaimLive(found.card, now), revision: found.revision } })
      }
    }
  }

  // 3. Delivered rows due to be sent again, oldest first. Only a machine that scanned its cards lately says they still stand.
  const scanned = ready && isTime(state.scan_at) && now - Date.parse(state.scan_at) <= FRESH_MS
  const live = []
  for (const [id, entry] of Object.entries(state.rows)) {
    if (entry.held !== undefined) hold(entry.held.code)
    else if (!(await routesHere(entry.desk_root))) hold("triage_route_elsewhere")
    else live.push(id)
  }
  const sinceSent = (id) => now - Date.parse(state.rows[id].attested_at)
  const attest = []
  const superseded = []
  // When one row is due, every row not sent in the last half day goes with it, so a quiet desk opens one pull request every two days.
  if (scanned && live.some((id) => !staged.has(id) && sinceSent(id) >= ATTEST_MS)) {
    for (const id of live) {
      const still = standing(state.rows[id])
      if (still === "superseded") superseded.push(id)
      else if (still === "unknown") hold("triage_unacknowledged")
      else if (!staged.has(id) && sinceSent(id) >= ATTEST_MS / 4) attest.push(id)
    }
  }
  attest.sort((left, right) => sinceSent(right) - sinceSent(left))
  // The coverage alone, in a batch with no rows: only for the desk whose scan it is, and only while that desk routes here.
  const scanHere = typeof state.scan_desk === "string" && (await routesHere(state.scan_desk))
  const quiet = scanned && live.length === 0 && candidates.length === 0 && state.pending.length === 0 && state.published !== undefined && isTime(state.staged_at) && now - Date.parse(state.staged_at) >= ATTEST_MS
  const coverageDue = scanHere && (quiet || scanChanged(state))

  if (decided.size > 0 || superseded.length > 0 || !same(state.held_requests ?? {}, held)) {
    state = await update(env, store, (latest) => ({
      ...latest,
      held_requests: held,
      // A row the desk's remote no longer holds as that review is not sent again; its newer revision goes as any annotation does.
      rows: Object.fromEntries(Object.entries(latest.rows).filter(([id]) => !superseded.includes(id))),
      requests: Object.fromEntries(Object.entries(latest.requests).filter(([key]) => decided.get(key) !== null).map(([key, request]) => [key, decided.get(key) ?? request])),
    }))
  }
  await writeSummary(env, store, state, now)
  return { work: state.pending.length > 0 || candidates.length > 0 || attest.length > 0 || coverageDue, state, candidates, held, attest, coverageDue }
}

// The scan's state differs from the one the last staged batch said: a store reading that batch reads the wrong source state.
const scanChanged = (state) => state.published !== undefined && state.coverage !== undefined && state.published.scan !== state.coverage.scan

// ---------------------------------------------------------------------------
// The store side.

/**
 * `readTriageReadiness(env, { store, client, ref, now }) -> { state: "ready" | "not_ready" | "unknown", blob?, cached? }`:
 * whether `store` holds, at `ref` (the commit of its default branch the flush builds on, or a branch name), a regular file
 * `triage.json` that is exactly `{"triage":1}`. `client` is the flush's bounded GitHub reader. `ready` is never cached: every
 * publishing flush reads the file again, and `blob` is the Git blob ID of what it read. A missing, malformed or different file,
 * or anything that is not a file, is `not_ready`, any other answer `unknown`; either is kept for a day (as the hold
 * `triage_store_not_ready` or `triage_readiness_unknown`) and answered from that record, with `cached: true` and no call, until
 * the day is over.
 */
export async function readTriageReadiness(env, { store, client, ref, now }) {
  const kept = heldNow(await readState(env, store), now)
  if (kept === NOT_READY || kept === READINESS_UNKNOWN) return { state: kept === NOT_READY ? "not_ready" : "unknown", cached: true }
  const answer = await client.api("GET", `repos/${store}/contents/triage.json?ref=${encodeURIComponent(ref)}`)
  let state = answer.status === 200 || answer.status === 404 ? "not_ready" : "unknown"
  let blob
  if (answer.status === 200 && isPlainObject(answer.json) && answer.json.type === "file" && answer.json.encoding === "base64" && typeof answer.json.content === "string") {
    const bytes = Buffer.from(answer.json.content, "base64")
    try {
      const config = JSON.parse(bytes.toString("utf8"))
      if (isPlainObject(config) && Object.keys(config).join() === "triage" && config.triage === READINESS_FLAG) {
        state = "ready"
        blob = gitBlobSha(bytes)
      }
    } catch {
      // Not JSON: not ready.
    }
  }
  if (state === "ready") return { state, blob }
  await holdTriage(env, store, state === "not_ready" ? NOT_READY : READINESS_UNKNOWN, now)
  return { state }
}

/** The blob ID at each `triage/<batch>.json` of a tree, read through `read(treeSha) -> Map(name -> { type, sha })`. */
export async function triageOnBranch(read, treeSha) {
  const blobs = new Map()
  const dir = (await read(treeSha)).get("triage")
  if (dir?.type !== "tree") return blobs
  for (const [name, entry] of await read(dir.sha)) {
    if (entry.type === "blob" && TRIAGE_PATH.test(`triage/${name}`)) blobs.set(`triage/${name}`, entry.sha)
  }
  return blobs
}

/**
 * `triageBatchDisposition({ path, bytes, remoteBytes, remoteSha }) -> "add" | "already_acknowledged" | "collision" | "unknown"`:
 * what to do with a staged batch given what the store's default branch holds at its path, as bytes (`remoteBytes`) or as the
 * blob ID a tree listing gave (`remoteSha`); `undefined` for both means the path is absent, `null` that the read could not say.
 * Only the exact bytes are `already_acknowledged`. Other bytes at the path are a `collision`: the batch is never sent as a
 * change to that file, and the same rows need a fresh random batch ID.
 */
export function triageBatchDisposition({ path: file, bytes, remoteBytes, remoteSha }) {
  if (typeof file !== "string" || !TRIAGE_PATH.test(file)) return "unknown"
  const remote = remoteSha !== undefined ? remoteSha : typeof remoteBytes === "string" || Buffer.isBuffer(remoteBytes) ? gitBlobSha(Buffer.from(remoteBytes)) : remoteBytes
  if (remote === undefined) return "add"
  if (typeof remote !== "string") return "unknown"
  return remote === gitBlobSha(Buffer.from(bytes)) ? "already_acknowledged" : "collision"
}

/**
 * Whether a refusal `code` names triage: a `triage_` code, or any code on the pull request that carried triage (`onTriagePr`),
 * unless it is a stale one (`stale`, which holds every `*_check_unavailable`: the store's own check failing, so the batch goes
 * again at the next flush). The store's validator may refuse a triage file with the plain schema codes facts use, so on that
 * pull request the facts are not blamed: they go again without triage, and a real facts error is refused on the next one.
 */
export const namesTriage = (code, { onTriagePr, stale }) => !stale.has(code) && (code.startsWith("triage_") || onTriagePr)

// ---------------------------------------------------------------------------
// Staging and delivery.

/**
 * `stageTriageBatch(env, { store, projection, keys, rows, refusals, now }) -> { state: "staged" | "exists" | "conflict" | "invalid", path?, sha? }`.
 * `projection` is a batch file's `{ path, bytes, sha }` (`triageBatchFor`'s, `triageBatchOf`'s or `triageFor`'s). It is checked
 * again as a trusted added file, then written once as the protected `<batch>.json`; a record that already holds other bytes is
 * never overwritten (`conflict`). The batch joins `pending`, its scan state becomes the one last published, and the requests of
 * `keys` (canonical card keys, optional) are tied to it. `rows` says more about each row of the file, in its order:
 * `[{ id, revision, desk_root, key, person_prefix, attest? }]`, the desk and card the row came from and whether it is a delivered row sent again.
 * `refusals` carries over how often the store refused these rows. `now` is a millisecond time.
 */
export async function stageTriageBatch(env, { store, projection, keys = [], rows = [], refusals = 0, now = Date.now() }) {
  const { path: file, bytes, sha } = projection
  if (!validateTriageChange({ path: file, status: "added", bytes, trustedMaintainer: true }).ok || gitBlobSha(Buffer.from(bytes)) !== sha) return { state: "invalid" }
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"))
  // Every row of the file needs its desk on the record: the route is checked against it before the batch is sent.
  if (rows.length !== value.rows.length) return { state: "invalid" }
  let existed = true
  const record = await updateTriageOutbox(env, store, `${value.batch}.json`, (current) => {
    existed = current !== null
    return current ?? {
      schema: BATCH_SCHEMA, store, batch: value.batch, path: file, sha, bytes: Buffer.from(bytes).toString("utf8"), state: "pending", staged_at: iso(now),
      rows, refusals,
    }
  })
  if (record.sha !== sha) return { state: "conflict" }
  await update(env, store, (state) => ({
    ...state,
    pending: state.pending.includes(value.batch) || record.state !== "pending" ? state.pending : [...state.pending, value.batch],
    published: { scan: value.coverage.scan },
    staged_at: iso(now),
    requests: Object.fromEntries(Object.entries(state.requests).map(([key, request]) => [key, keys.includes(key) ? { ...request, batch: value.batch } : request])),
  }))
  return { state: existed ? "exists" : "staged", path: file, sha }
}

/** Holds every triage emission to `store` for a day under `code`; pending batches and requests stay as they are. */
async function holdTriage(env, store, code, now) {
  const state = await update(env, store, (current) => ({ ...current, held: heldAs(current, code, now) }))
  await writeSummary(env, store, state, now)
}

/**
 * `recordTriageError(env, store, now)`: something in the triage code failed inside a flush. Triage is held for a day as
 * `triage_error`; the flush goes on without it.
 */
export const recordTriageError = (env, store, now) => holdTriage(env, store, "triage_error", now)

/**
 * A refusal named triage in the pull request that carried it: nothing is delivered, and the batches wait a day. Each batch that
 * pull request carried counts one more refusal; at the third it is not sent again (see the header).
 */
export async function saveTriageRefused(env, store, code, now) {
  const state = await readState(env, store)
  for (const batch of state.pending) {
    const record = await readTriageOutbox(env, store, `${batch}.json`)
    if (!isPendingRecord(record) || !Number.isSafeInteger(state.pr) || record.pr !== state.pr) continue
    const refusals = record.refusals + 1
    if (refusals < MAX_REFUSALS) {
      await updateTriageOutbox(env, store, `${batch}.json`, () => ({ ...record, refusals }))
      continue
    }
    const { bytes: _bytes, ...kept } = record
    await updateTriageOutbox(env, store, `${batch}.json`, () => ({ ...kept, refusals, state: "refused", refused_at: iso(now), refused_code: code }))
    await update(env, store, (latest) => ({
      ...latest,
      pending: latest.pending.filter((id) => id !== batch),
      requests: Object.fromEntries(Object.entries(latest.requests).map(([key, { batch: tied, ...request }]) => [key, tied === batch ? { ...request, held: { code: BATCH_REFUSED, revision: request.revision } } : tied === undefined ? request : { ...request, batch: tied }])),
    }))
    await holdRows(env, store, record.rows.filter((row) => row.attest === true).map((row) => row.id), BATCH_REFUSED, now)
  }
  await update(env, store, ({ pr: _pr, ...latest }) => latest)
  await holdTriage(env, store, code, now)
}

/** The batches of `items` were pushed in pull request `pr` (a number). They stay pending until the default branch holds them. */
export async function saveTriageSent(env, store, items, pr, now) {
  for (const item of items) await updateTriageOutbox(env, store, `${item.batch}.json`, (record) => ({ ...record, pr, sent_at: iso(now) }))
  await update(env, store, (state) => ({ ...state, pr }))
}

// A pending batch's exact bytes are on the default branch: its rows are delivered.
async function deliver(env, store, record, now) {
  const value = JSON.parse(record.bytes)
  const { bytes: _bytes, ...kept } = record
  await updateTriageOutbox(env, store, `${record.batch}.json`, () => ({ ...kept, state: "delivered", delivered_at: iso(now) }))
  const known = value.coverage.scan === "complete" && ["reviewed", "unreviewed", "refused", "deferred", "more_unreviewed"].every((name) => value.coverage[name] !== null)
  return update(env, store, (state) => {
    const rows = { ...state.rows }
    value.rows.forEach((row, index) => {
      if (row.revision < (state.emitted[row.id] ?? 0)) return
      // Only a reviewed row is sent again; a stale or withdrawn one needs no freshness. A newer revision ends an older row's hold.
      if (row.state === "reviewed") rows[row.id] = { ...(rows[row.id]?.revision === row.revision ? rows[row.id] : {}), desk_root: record.rows[index].desk_root, key: record.rows[index].key, person_prefix: record.rows[index].person_prefix, revision: row.revision, row, attested_at: iso(now) }
      else delete rows[row.id]
    })
    return {
      ...state,
      rows,
      pending: state.pending.filter((id) => id !== record.batch),
      emitted: { ...state.emitted, ...Object.fromEntries(value.rows.map((row) => [row.id, Math.max(row.revision, state.emitted[row.id] ?? 0)])) },
      requests: Object.fromEntries(Object.entries(state.requests).filter(([, request]) => request.batch !== record.batch)),
      delivered_at: iso(now),
      delivered_known: known,
    }
  })
}

const pointersOfRow = (row) => [...row.evidence, ...row.basis.evidence_revisions]
const pointersOfAnnotation = (annotation) => [...(annotation.review?.evidence ?? []), ...annotation.basis.public_evidence_revisions]

const publicRunner = (state, status, now) => {
  const last = status.triage?.last_success_at
  return { state: state.runner_state, last_success_age: typeof last === "string" ? coarseAge(now - Date.parse(last)) : "never" }
}

/**
 * `prepareTriage(env, { store, plan, client, ref, direct, consent, status, visibility, publishedJobs, readMain, now, newBatch })
 *   -> { items }`: the triage files this flush's intake pull request carries, `[{ path, bytes, sha, triage: true, batch }]`.
 *
 * `plan` is `planTriage`'s. `ref` is the commit of the store's default branch the flush builds on. `direct` is whether the
 * account has push permission on the store. `consent` is the store's consent record and `status` the factory status.
 * `visibility(repos) -> Map` asks each repository's visibility now, whatever the cache holds. `publishedJobs() -> Set` is the job
 * IDs of the facts this machine delivered to the store. `readMain() -> { blobs, unknown }` lists the default branch's `triage/`
 * folder (`triageOnBranch`), `unknown` when the listing was truncated. `newBatch() -> id` makes a batch ID (random; a seam for
 * tests). See the header for every hold; a held flush answers no items.
 */
export async function prepareTriage(env, { store, plan, client, ref, direct, consent, status, visibility, publishedJobs, readMain, now, newBatch = () => hex(8) }) {
  const none = { items: [] }
  if (!plan.work) return none
  const hold = async (code) => {
    await holdTriage(env, store, code, now)
    return none
  }
  if (direct !== true) return hold("triage_untrusted_account")
  if ((await readTriageReadiness(env, { store, client, ref, now })).state !== "ready") return none
  const main = await readMain()
  if (main.unknown) return hold("triage_main_unknown")

  // Fresh answers only: nothing here reads the visibility cache, and each repository is asked once a flush.
  const known = new Map()
  const jobs = publishedJobs()
  const ask = async (pointers) => {
    const repos = [store, ...pointers.map((pointer) => REPO_OF_REF.exec(pointer.ref)[1])].filter((repo) => !known.has(repo.toLowerCase()))
    if (repos.length === 0) return
    // Only the answers just asked for are taken: whatever else the map holds may be a cached answer, days old.
    const answers = await visibility(repos)
    for (const repo of repos) known.set(repo.toLowerCase(), answers.get(repo.toLowerCase()))
  }
  const allPublic = (pointers) => publicEvidenceFor({ pointers, store, visibility: known, publishedJobs: jobs }).length === pointers.length
  const storeKnown = () => KNOWN_VISIBILITY.has(known.get(store.toLowerCase()))

  // 1. What the default branch says about each pending batch.
  let state = plan.state
  const waiting = []
  for (const batch of state.pending) {
    const record = await readTriageOutbox(env, store, `${batch}.json`)
    const disposition = triageBatchDisposition({ path: record.path, bytes: Buffer.from(record.bytes, "utf8"), remoteSha: main.blobs.get(record.path) })
    if (disposition === "already_acknowledged") state = await deliver(env, store, record, now)
    else waiting.push({ record, value: JSON.parse(record.bytes), collision: disposition === "collision" })
  }

  // 2. A batch still waiting is sent only while everything its bytes name is positively public now.
  let current = plan
  if (waiting.length > 0) {
    await ask(waiting.flatMap(({ value }) => value.rows.flatMap(pointersOfRow)))
    let apart = false
    for (const item of waiting) {
      const closed = item.value.rows.filter((row) => !allPublic(pointersOfRow(row))).map((row) => row.id)
      if (storeKnown() && closed.length === 0) continue
      state = await dissolve(env, store, item.record, "visibility")
      // A delivered row that names something no longer public is not sent again at this revision.
      if (storeKnown()) state = await holdRows(env, store, item.record.rows.filter((row) => row.attest === true && closed.includes(row.id)).map((row) => row.id), NOT_PUBLIC, now)
      item.apart = true
      apart = true
    }
    // The rows of a batch taken apart are built again below, from the acknowledged annotations.
    if (apart && storeKnown()) current = await planTriage(env, { store, now })
  }
  const due = current.attest.map((id) => [id, current.state.rows[id]])
  if (current.candidates.length > 0 || due.length > 0 || current.coverageDue) await ask([...current.candidates.flatMap(({ annotation }) => pointersOfAnnotation(annotation)), ...due.flatMap(([, entry]) => pointersOfRow(entry.row))])
  if (known.size > 0 && !storeKnown()) return hold("triage_visibility_unknown")

  state = await readState(env, store)
  const coverage = { generation: state.generation, ...state.coverage }
  const runner = publicRunner(state, status, now)
  const items = []
  const stage = async (projection, options) => {
    const staged = await stageTriageBatch(env, { store, projection, now, ...options })
    // Only a batch this state recorded is pushed.
    if (staged.state === "staged" || staged.state === "exists") items.push({ path: projection.path, bytes: projection.bytes, sha: projection.sha, triage: true, batch: path.posix.basename(projection.path, ".json") })
  }

  // A hold that is not about one row (consent, say) holds everything for a day.
  let batchHold = null
  // Rows that were built before, in a new batch file with the coverage and runner of now.
  const again = async (rows, options) => {
    const out = triageBatchOf({ rows, store, consent, visibility: known, coverage, runner, batch: newBatch() })
    if (out.held !== undefined) batchHold = out.held
    else await stage(out, options)
  }

  // 3. The waiting batches: as they are, or with the same rows under a fresh batch ID when the path is taken or the coverage or runner they say is no longer the current one.
  for (const { record, value, collision, apart } of waiting) {
    if (apart === true) continue
    if (!collision && same(value.coverage, coverage) && same(value.runner, runner)) {
      items.push({ path: record.path, bytes: Buffer.from(record.bytes, "utf8"), sha: record.sha, triage: true, batch: record.batch })
      continue
    }
    const keys = Object.entries(state.requests).filter(([, request]) => request.batch === record.batch).map(([key]) => key)
    const { bytes: _bytes, ...kept } = record
    await updateTriageOutbox(env, store, `${record.batch}.json`, () => ({ ...kept, state: "replaced", reason: collision ? "collision" : "coverage" }))
    await update(env, store, (latest) => ({ ...latest, pending: latest.pending.filter((id) => id !== record.batch) }))
    await again(value.rows, { keys, rows: record.rows, refusals: record.refusals })
  }

  // 4. New rows.
  const build = async (chunk) => {
    const rows = chunk.map((candidate) => ({ ...candidate, publicEvidence: publicEvidenceFor({ pointers: pointersOfAnnotation(candidate.annotation), store, visibility: known, publishedJobs: jobs }) }))
    const out = triageBatchFor({ rows, store, consent, visibility: known, coverage, runner, batch: newBatch() })
    const skipped = out.skipped ?? []
    // A row this revision can never give is not built again until the annotation changes.
    if (skipped.length > 0) {
      await update(env, store, (latest) => ({
        ...latest,
        requests: Object.fromEntries(Object.entries(latest.requests).map(([key, request]) => {
          const found = skipped.find(({ index }) => chunk[index].key === key)
          return [key, found === undefined ? request : { ...request, held: { code: found.code, revision: chunk[found.index].annotation.revision } }]
        })),
      }))
    }
    if (out.held !== undefined) {
      if (out.skipped === undefined) batchHold = out.held
      return
    }
    const built = chunk.filter((_, index) => !skipped.some((item) => item.index === index))
    await stage(out, { keys: built.map((candidate) => candidate.key), rows: built.map((candidate) => ({ id: candidate.id, revision: candidate.annotation.revision, desk_root: candidate.deskRoot, key: candidate.key, person_prefix: candidate.personPrefix })) })
  }
  for (let start = 0; start < current.candidates.length && batchHold === null; start += MAX_ROWS) await build(current.candidates.slice(start, start + MAX_ROWS))

  // 5. Delivered rows sent again, byte for byte, while there is room in this pull request; then the coverage alone, when nothing else says it.
  const open = due.filter(([, entry]) => allPublic(pointersOfRow(entry.row)))
  if (open.length < due.length) await holdRows(env, store, due.filter((item) => !open.includes(item)).map(([id]) => id), NOT_PUBLIC, now)
  const resend = (chunk) => again(chunk.map(([, entry]) => entry.row), { rows: chunk.map(([id, entry]) => ({ id, revision: entry.revision, desk_root: entry.desk_root, key: entry.key, person_prefix: entry.person_prefix, attest: true })) })
  for (let start = 0; start < open.length && batchHold === null && items.length < MAX_TRIAGE_FILES; start += MAX_ROWS) await resend(open.slice(start, start + MAX_ROWS))
  if (batchHold === null && items.length === 0 && current.coverageDue) await resend([])
  if (batchHold !== null) return hold(`triage_${batchHold}`)

  const after = await update(env, store, ({ held: _held, ...latest }) => latest)
  await writeSummary(env, store, after, now)
  return { items: items.slice(0, MAX_TRIAGE_FILES) }
}
