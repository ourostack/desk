// The triage outbox: how an acknowledged local triage annotation becomes one immutable `triage/<batch>.json` file in a factory
// store, through the flush's own intake pull request and nothing else.
//
// Protected state, per store, under `triage-outbox/<store-slug>/` in the factory state folder (outside `outbox/`, so an older
// Desk never reads it as facts):
//
//   state.json     { schema, requests, pending, emitted, coverage?, run_counts?, runner_state?, held?, pr?, delivered_at? }
//   <batch>.json   { schema, store, batch, path, sha, bytes?, state, staged_at, rows: [{ id, revision }], ... }
//
// `requests` holds, by canonical card key, the annotations THIS machine wrote: `{ desk_root, person_prefix, intent?, revision?,
// at?, batch?, held? }`. The triage step marks its intent before it calls `publishOwnedTriage` (`beginTriageEmission`) and
// settles it after (`settleTriageEmission`): an acknowledged write is kept with its revision, an adopted one only when an
// earlier intent of this machine was left open (its own write, found again after a crash), an unacknowledged one keeps its
// intent, and every other result leaves nothing new. One machine publishes each revision, so two machines never publish the
// same revision with different rows. `emitted` is the highest revision delivered for each public ID; a revision at or below it
// is never staged again. `pending` lists the staged batches not yet seen on the store's default branch.
//
// A request is only a note of what to look at. What is published is read again, every time, from the desk's remote-tracking
// `origin/main` (`readAcknowledged`): the registry and the annotation as that commit holds them, with their blob IDs. A local
// commit or a push that failed never moved that ref, so it never reaches a row.
//
// The flush drives the rest (`planTriage`, `prepareTriage`, `saveTriageSent`, `saveTriageRefused`):
//
//   - `planTriage` is local. It reads the requests against Git, the desk's route and the canonical card, and says whether the
//     flush has triage work. A request whose desk does not route to this store, or whose annotation is not acknowledged, waits
//     without sending the flush online.
//   - `prepareTriage` is online. It needs the account's own push permission on the store (a fork cannot carry triage: the
//     store accepts it only from a maintainer), the store's `triage.json` read now and exactly `{"triage":1}`
//     (`readTriageReadiness`), a full listing of the default branch's `triage/` folder, and fresh visibility for the store and
//     for every repository an evidence pointer names. A pending batch whose exact bytes are on the default branch is delivered;
//     one whose path holds other bytes is replaced by the same rows under a fresh random batch ID, never sent as a change; a
//     listing that cannot say holds everything. New rows are built by `triageBatchFor` and staged (`stageTriageBatch`), at most
//     twenty rows a batch.
//   - Any hold is kept for a day (`held: { code, until }`), so a store that is not ready is asked once a day, never at every
//     flush. A hold drops the pending batches from the intake pull request; they stay pending and no annotation is forgotten.
//   - A refusal that names triage (`namesTriage`) never quarantines facts and never marks a batch delivered: the batch waits a
//     day and goes again, byte for byte.
//
// Coverage and the runner's state come from the triage step (`recordTriageCoverage`). A coverage generation is random and stays
// the same while the scan and its counts do. When the scan's state changes after something was published, a batch with no rows
// says so, because a store must not keep reading an incomplete source as complete.
//
// `status.triage_publication[store]` is the summary the local status reads: counts, a hold code and times, nothing else.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import * as path from "node:path"

import { MAX_CARD_FILES, isClaimLive, readCards } from "../desk/improvement-cards.js"
import { gitBlobSha, listMarkers, readTriageOutbox, updateStatus, updateTriageOutbox } from "./outbox.js"
import { isPlainObject } from "./schema.js"
import { markerRoute } from "./session-route.js"
import { resolveStore } from "./store-route.js"
import { readCanonicalCard } from "./triage-basis.js"
import { coarseAge, publicEvidenceFor, triageBatchFor } from "./triage-publish.js"
import { TRIAGE_PATH, TRIAGE_RUNNER_STATES, validateTriageChange } from "./triage-schema.js"
import { triagePaths, validateTriageAnnotation, validateTriageIdentities } from "./triage-state.js"

const STATE = "state.json"
const STATE_SCHEMA = "desk.factory.triage-outbox/1"
const BATCH_SCHEMA = "desk.factory.triage-batch/1"
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ROWS = 20
/** At most this many triage files ride one intake pull request; the rest wait for the next flush. */
const MAX_TRIAGE_FILES = 8
const READINESS_FLAG = 1
const NOT_READY = "triage_store_not_ready"
const READINESS_UNKNOWN = "triage_readiness_unknown"
const SHA = /^[0-9a-f]{40}$/u
const REPO_OF_REF = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\//u
const GIT_TIMEOUT_MS = 10_000
const MAIN = "refs/remotes/origin/main"

const iso = (ms) => new Date(ms).toISOString()
const hex = (bytes) => randomBytes(bytes).toString("hex")
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
// The state file is written only here; anything else (none yet, or a schema this Desk does not know) reads as empty.
const stateOf = (value) => (value?.schema === STATE_SCHEMA ? value : { schema: STATE_SCHEMA, requests: {}, pending: [], emitted: {} })
const heldNow = (state, now) => (state.held !== undefined && now < Date.parse(state.held.until) ? state.held.code : null)
const update = (env, store, change) => updateTriageOutbox(env, store, STATE, (current) => change(stateOf(current)))

// ---------------------------------------------------------------------------
// What the triage step records.

/**
 * `beginTriageEmission(env, { store, key, deskRoot, personPrefix }) -> { prior }`: marks this machine's intent to write the
 * card's annotation, before `publishOwnedTriage` runs. `prior` is true when an earlier intent for the card was never settled.
 */
export async function beginTriageEmission(env, { store, key, deskRoot, personPrefix }) {
  let prior = false
  await update(env, store, (state) => {
    prior = state.requests[key]?.intent === true
    return { ...state, requests: { ...state.requests, [key]: { ...state.requests[key], desk_root: deskRoot, person_prefix: personPrefix, intent: true } } }
  })
  return { prior }
}

/**
 * `settleTriageEmission(env, { store, key, written, prior, now })`: what `publishOwnedTriage` answered (`written`) for the
 * intent `beginTriageEmission` marked. See the header for which results leave a request.
 */
export async function settleTriageEmission(env, { store, key, written, prior, now }) {
  const own = written.state === "acknowledged" || (written.state === "adopted" && prior === true)
  await update(env, store, (state) => {
    const { [key]: request = {}, ...others } = state.requests
    const { intent: _intent, ...settled } = request
    // A new revision is a new thing to publish: the batch and the hold of the earlier one do not carry over.
    const { batch: _batch, held: _held, ...fresh } = settled
    const next = own ? { ...fresh, revision: written.revision, at: iso(now) } : written.state === "unacknowledged" ? request : settled
    return { ...state, requests: next.intent === true || Number.isSafeInteger(next.revision) ? { ...others, [key]: next } : others }
  })
}

/**
 * `recordTriageCoverage(env, { store, coverage, counts, runner })`: the triage step's latest scan. `coverage` is
 * `refreshTriage`'s (`{ scan, reviewed, unreviewed, more_unreviewed }`, counts null when the scan was not complete), read before
 * any run; `counts` the step's own `{ reviewed, refused, deferred }` for a run, null where it had none; `runner` the runner's
 * state code or null. The stored coverage is the public shape. Refused and deferred counts come from the last step that knew
 * them. Every count of an incomplete scan is null. The generation is new only when the scan or a count changed.
 */
export async function recordTriageCoverage(env, { store, coverage, counts, runner }) {
  await update(env, store, (state) => {
    const complete = coverage.scan === "complete"
    const added = count(counts.reviewed) ?? 0
    const run = { refused: count(counts.refused) ?? state.run_counts?.refused ?? null, deferred: count(counts.deferred) ?? state.run_counts?.deferred ?? null }
    const reviewed = complete ? count(coverage.reviewed) : null
    const unreviewed = complete ? count(coverage.unreviewed) : null
    const now = {
      scan: coverage.scan,
      reviewed: reviewed === null ? null : reviewed + added,
      unreviewed: unreviewed === null ? null : Math.max(0, unreviewed - added),
      refused: complete ? run.refused : null,
      deferred: complete ? run.deferred : null,
      more_unreviewed: unreviewed === null ? null : unreviewed - added > 0,
    }
    const before = state.coverage
    const same = before !== undefined && Object.keys(now).every((name) => before[name] === now[name])
    return {
      ...state,
      coverage: { generation: same ? before.generation : hex(16), ...now },
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

// Whether the desk's facts route is this store: its own declaration, else the newest route a session hook recorded for it
// (`kaizen-file.js` reads the route the same way). No route, or a held one, is not here.
async function routesHere(env, store, deskRoot, markers) {
  const current = resolveStore({ deskRoot })
  let routed = current.store
  if (current.source === "default") {
    const recorded = (await markers())
      .filter((marker) => marker.host !== "codex-cli" && marker.desk_root !== null && path.resolve(marker.desk_root) === path.resolve(deskRoot) && marker.routing !== undefined)
      .sort((left, right) => (left.updated_at < right.updated_at ? 1 : -1))
    routed = recorded.length === 0 ? null : markerRoute(recorded[0]).store
  }
  return typeof routed === "string" && routed.toLowerCase() === store.toLowerCase()
}

// ---------------------------------------------------------------------------
// The flush's local plan.

const summaryOf = (state, now, heldRequests) => {
  const code = heldNow(state, now)
  return {
    at: iso(now),
    pending: state.pending.length,
    waiting: Object.values(state.requests).filter((request) => !state.pending.includes(request.batch)).length,
    ...(code === null ? {} : { held: code }),
    ...(Object.keys(heldRequests).length === 0 ? {} : { held_requests: heldRequests }),
    ...(state.delivered_at === undefined ? {} : { delivered_at: state.delivered_at }),
    ...(state.coverage === undefined ? {} : { scan: state.coverage.scan }),
  }
}

async function writeSummary(env, store, state, now, heldRequests = {}) {
  await updateStatus(env, (status) => ({ ...status, triage_publication: { ...(isPlainObject(status.triage_publication) ? status.triage_publication : {}), [store]: summaryOf(state, now, heldRequests) } }))
}

/**
 * `planTriage(env, { store, now }) -> { work, state, candidates, held }`, from local state and Git only. `candidates` are the
 * requests ready to build, `[{ key, annotation, identity, ack, card }]`; `held` counts the others by code:
 * `triage_route_elsewhere`, `triage_unacknowledged`, `triage_coverage_unknown`, `triage_runner_unknown`, or the code
 * `triageBatchFor` refused this revision's row with. `work` is true when the flush has to go online for triage. A store with no triage state costs one
 * file read and nothing else.
 */
export async function planTriage(env, { store, now }) {
  const state = stateOf(await readTriageOutbox(env, store, STATE))
  const candidates = []
  const held = {}
  const hold = (code) => { held[code] = (held[code] ?? 0) + 1 }
  const done = []
  if (heldNow(state, now) !== null) return { work: false, state, candidates, held }
  const unstaged = Object.entries(state.requests).filter(([, request]) => !state.pending.includes(request.batch))
  if (unstaged.length === 0) return { work: state.pending.length > 0 || scanChanged(state), state, candidates, held }
  let markers
  const listMarkersOnce = () => (markers ??= listMarkers(env))
  const listings = new Map()
  for (const [key, request] of unstaged) {
    const { desk_root: deskRoot, person_prefix: personPrefix } = request
    if (state.coverage === undefined) hold("triage_coverage_unknown")
    else if (state.runner_state === null) hold("triage_runner_unknown")
    else if (!(await routesHere(env, store, deskRoot, listMarkersOnce))) hold("triage_route_elsewhere")
    else {
      const read = readAcknowledged({ deskRoot, personPrefix, key })
      const entry = read?.identity.entries.find((candidate) => candidate.key === key && candidate.store === store.toLowerCase())
      const ahead = entry !== undefined && Number.isSafeInteger(request.revision) && read.annotation.revision > request.revision
      // Never settled as acknowledged, not on the remote's main as this machine last saw it, behind the revision this machine saw
      // acknowledged, or ahead of it while a write of this machine is still unsettled (its own, or another machine's): wait. Only a
      // revision this machine's write was acknowledged with is published, so no two machines publish one revision.
      if (entry === undefined || !Number.isSafeInteger(request.revision) || read.annotation.revision < request.revision || (ahead && request.intent === true)) hold("triage_unacknowledged")
      // Delivered already, or a later revision another machine wrote and will publish: nothing left for this request.
      else if (read.annotation.revision <= (state.emitted[entry.id] ?? 0) || ahead) done.push(key)
      else if (request.held?.revision === read.annotation.revision) hold(request.held.code)
      else {
        const listing = listings.get(`${deskRoot}\n${personPrefix}`) ?? (await readCards({ deskRoot, personPrefix, limit: MAX_CARD_FILES }))
        listings.set(`${deskRoot}\n${personPrefix}`, listing)
        const found = await readCanonicalCard({ deskRoot, personPrefix, key, readCards: async () => listing })
        candidates.push({ key, ...read, card: found === null ? null : { state: found.card.state, claimed: isClaimLive(found.card, now), revision: found.revision } })
      }
    }
  }
  let current = state
  if (done.length > 0) current = await update(env, store, (latest) => ({ ...latest, requests: Object.fromEntries(Object.entries(latest.requests).filter(([key]) => !done.includes(key))) }))
  await writeSummary(env, store, current, now, held)
  return { work: current.pending.length > 0 || candidates.length > 0 || scanChanged(current), state: current, candidates, held }
}

// The scan's state differs from the one the last staged batch said: a store reading that batch reads the wrong source state.
const scanChanged = (state) => state.published !== undefined && state.coverage !== undefined && state.published.scan !== state.coverage.scan

// ---------------------------------------------------------------------------
// The store side.

/**
 * `readTriageReadiness(env, { store, client, branch, now }) -> { state: "ready" | "not_ready" | "unknown", blob?, cached? }`:
 * whether `store`'s default branch (`branch`) holds a `triage.json` that is exactly `{"triage":1}`. `client` is the flush's
 * bounded GitHub reader. `ready` is never cached: every publishing flush reads the file again, and `blob` is the Git blob ID of
 * what it read. A missing, malformed or different file is `not_ready`, any other answer `unknown`; either is kept for a day
 * (as the hold `triage_store_not_ready` or `triage_readiness_unknown`) and answered from that record, with `cached: true` and
 * no call, until the day is over.
 */
export async function readTriageReadiness(env, { store, client, branch, now }) {
  const kept = heldNow(stateOf(await readTriageOutbox(env, store, STATE)), now)
  if (kept === NOT_READY || kept === READINESS_UNKNOWN) return { state: kept === NOT_READY ? "not_ready" : "unknown", cached: true }
  const answer = await client.api("GET", `repos/${store}/contents/triage.json?ref=${encodeURIComponent(branch)}`)
  let state = answer.status === 200 || answer.status === 404 ? "not_ready" : "unknown"
  let blob
  if (answer.status === 200 && isPlainObject(answer.json) && answer.json.encoding === "base64" && typeof answer.json.content === "string") {
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
 * `stageTriageBatch(env, { store, projection, keys, now }) -> { state: "staged" | "exists" | "conflict" | "invalid", path?, sha? }`.
 * `projection` is `triageBatchFor`'s `{ path, bytes, sha, rows }` (or `triageFor`'s, without `rows`). It is checked again as a
 * trusted added file, then written once as the protected `<batch>.json`; a record that already holds other bytes is never
 * overwritten (`conflict`). The batch joins `pending`, its coverage becomes the one last published, and the requests of `keys`
 * (canonical card keys, optional) are tied to it. `now` is a millisecond time.
 */
export async function stageTriageBatch(env, { store, projection, keys = [], now = Date.now() }) {
  const { path: file, bytes, sha } = projection
  if (!validateTriageChange({ path: file, status: "added", bytes, trustedMaintainer: true }).ok || gitBlobSha(Buffer.from(bytes)) !== sha) return { state: "invalid" }
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"))
  let existed = true
  const record = await updateTriageOutbox(env, store, `${value.batch}.json`, (current) => {
    existed = current !== null
    return current ?? { schema: BATCH_SCHEMA, store, batch: value.batch, path: file, sha, bytes: Buffer.from(bytes).toString("utf8"), state: "pending", staged_at: iso(now), rows: value.rows.map((row) => ({ id: row.id, revision: row.revision })) }
  })
  if (record.sha !== sha) return { state: "conflict" }
  await update(env, store, (state) => ({
    ...state,
    pending: state.pending.includes(value.batch) || record.state !== "pending" ? state.pending : [...state.pending, value.batch],
    published: { generation: value.coverage.generation, scan: value.coverage.scan },
    requests: Object.fromEntries(Object.entries(state.requests).map(([key, request]) => [key, keys.includes(key) ? { ...request, batch: value.batch } : request])),
  }))
  return { state: existed ? "exists" : "staged", path: file, sha }
}

/** Holds every triage emission to `store` for a day under `code`; pending batches and requests stay as they are. */
async function holdTriage(env, store, code, now) {
  const state = await update(env, store, (current) => ({ ...current, held: { code, until: iso(now + DAY_MS) } }))
  await writeSummary(env, store, state, now)
}

/** A refusal named triage in the pull request that carried it: nothing is delivered, and the batches wait a day. */
export async function saveTriageRefused(env, store, code, now) {
  await update(env, store, ({ pr: _pr, ...state }) => state)
  await holdTriage(env, store, code, now)
}

/** The batches of `items` were pushed in pull request `pr` (a number). They stay pending until the default branch holds them. */
export async function saveTriageSent(env, store, items, pr, now) {
  for (const item of items) await updateTriageOutbox(env, store, `${item.batch}.json`, (record) => ({ ...record, pr, sent_at: iso(now) }))
  await update(env, store, (state) => ({ ...state, pr }))
}

// The same rows under a fresh random batch ID, for a batch whose path holds other bytes on the default branch.
function rebatched(record) {
  const value = { ...JSON.parse(record.bytes), batch: hex(8) }
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
  return { path: `triage/${value.batch}.json`, bytes, sha: gitBlobSha(bytes) }
}

const publicRunner = (state, status, now) => {
  const last = status.triage?.last_success_at
  return { state: state.runner_state, last_success_age: typeof last === "string" ? coarseAge(now - Date.parse(last)) : "never" }
}

/**
 * `prepareTriage(env, { store, plan, client, branch, direct, consent, status, visibility, publishedJobs, readMain, now })
 *   -> { items }`: the triage files this flush's intake pull request carries, `[{ path, bytes, sha, triage: true, batch }]`.
 *
 * `plan` is `planTriage`'s. `direct` is whether the account has push permission on the store. `consent` is the store's consent
 * record and `status` the factory status. `visibility(repos) -> Map` asks each repository's visibility now, whatever the cache
 * holds. `publishedJobs() -> Set` is the job IDs of the facts this machine delivered to the store. `readMain() -> { blobs,
 * unknown }` lists the default branch's `triage/` folder (`triageOnBranch`), `unknown` when the listing was truncated. See the
 * header for every hold; a held flush answers no items.
 */
export async function prepareTriage(env, { store, plan, client, branch, direct, consent, status, visibility, publishedJobs, readMain, now }) {
  const none = { items: [] }
  if (!plan.work) return none
  const hold = async (code) => {
    await holdTriage(env, store, code, now)
    return none
  }
  if (direct !== true) return hold("triage_untrusted_account")
  if ((await readTriageReadiness(env, { store, client, branch, now })).state !== "ready") return none
  const main = await readMain()
  if (main.unknown) return hold("triage_main_unknown")

  // 1. What the default branch says about each pending batch.
  const items = []
  for (const batch of plan.state.pending) {
    const record = await readTriageOutbox(env, store, `${batch}.json`)
    if (record?.state !== "pending") {
      // The protected record is gone or was settled: its requests are free to be staged again.
      await update(env, store, (state) => ({ ...state, pending: state.pending.filter((id) => id !== batch) }))
      continue
    }
    const bytes = Buffer.from(record.bytes, "utf8")
    const disposition = triageBatchDisposition({ path: record.path, bytes, remoteSha: main.blobs.get(record.path) })
    if (disposition === "add") items.push({ path: record.path, bytes, sha: record.sha, triage: true, batch })
    else if (disposition === "already_acknowledged") {
      const { bytes: _bytes, ...kept } = record
      await updateTriageOutbox(env, store, `${batch}.json`, () => ({ ...kept, state: "delivered", delivered_at: iso(now) }))
      await update(env, store, (state) => ({
        ...state,
        pending: state.pending.filter((id) => id !== batch),
        emitted: { ...state.emitted, ...Object.fromEntries(record.rows.map((row) => [row.id, Math.max(row.revision, state.emitted[row.id] ?? 0)])) },
        requests: Object.fromEntries(Object.entries(state.requests).filter(([, request]) => request.batch !== batch)),
        delivered_at: iso(now),
      }))
    } else {
      const again = rebatched(record)
      const keys = Object.entries(plan.state.requests).filter(([, request]) => request.batch === batch).map(([key]) => key)
      await stageTriageBatch(env, { store, projection: again, keys, now })
      await updateTriageOutbox(env, store, `${batch}.json`, () => ({ ...record, state: "replaced", replaced_by: path.posix.basename(again.path, ".json") }))
      await update(env, store, (state) => ({ ...state, pending: state.pending.filter((id) => id !== batch) }))
      items.push({ ...again, triage: true, batch: path.posix.basename(again.path, ".json") })
    }
  }

  // 2. New rows, and a batch with no rows when only the scan's state changed.
  const state = stateOf(await readTriageOutbox(env, store, STATE))
  const pointersOf = ({ annotation }) => [...(annotation.review?.evidence ?? []), ...annotation.basis.public_evidence_revisions]
  const repos = plan.candidates.flatMap(pointersOf).map((pointer) => REPO_OF_REF.exec(pointer.ref)[1])
  const known = plan.candidates.length > 0 || scanChanged(state) ? await visibility([store, ...repos]) : new Map()
  const jobs = repos.length > 0 ? publishedJobs() : new Set()
  // A hold that is not about one row (unknown visibility of the store, say) holds everything for a day.
  let batchHold = null
  const build = async (chunk) => {
    const rows = chunk.map((candidate) => ({ ...candidate, publicEvidence: publicEvidenceFor({ pointers: pointersOf(candidate), store, visibility: known, publishedJobs: jobs }) }))
    const out = triageBatchFor({ rows, store, consent, visibility: known, coverage: state.coverage, runner: publicRunner(state, status, now), now })
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
    const keys = chunk.filter((_, index) => !skipped.some((item) => item.index === index)).map((candidate) => candidate.key)
    await stageTriageBatch(env, { store, projection: out, keys, now })
    items.push({ path: out.path, bytes: out.bytes, sha: out.sha, triage: true, batch: path.posix.basename(out.path, ".json") })
  }
  for (let start = 0; start < plan.candidates.length && batchHold === null; start += MAX_ROWS) await build(plan.candidates.slice(start, start + MAX_ROWS))
  if (batchHold === null && scanChanged(stateOf(await readTriageOutbox(env, store, STATE)))) await build([])
  if (batchHold !== null) return hold(`triage_${batchHold}`)

  const after = await update(env, store, ({ held: _held, ...latest }) => latest)
  await writeSummary(env, store, after, now, plan.held)
  return { items: items.slice(0, MAX_TRIAGE_FILES) }
}
