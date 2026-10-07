// Gathers what the sweep knows and records capture coverage per host in `status.json`, under `coverage`.
//
// `coverageNow(env, { now, bindingVersion, orphans, markers, caps })` counts each host's root sessions on disk (capture-count.js), puts every one into
// a bucket (capture-classify.js) and returns `{ ok: true, coverage, cache }`, or `{ ok: false, code }`. It never throws. `code` is one of `COVERAGE_FAILED`:
// the stage that failed, never a message, a path or a name. `coverage` is `{ method: 1, ran_at, hosts }` and is local only: it carries store names inside
// `by_owner` and nothing else that names anything (no path, session id, desk, host folder or account). `cache` is the Codex answer cache, kept in
// `status.coverage_cache` and nowhere else, because its keys are rollout file names.
//
// `recordCoverage(env, options)` is what the sweep calls: it writes the result with `writeStatus` and returns `"written"`, `"kept"` or `"failed"`. A failure
// writes `coverage_failed: <code>` and leaves the previous `coverage` and `coverage_cache` where they were; a success clears `coverage_failed`.
// `"kept"` is a success that does not replace `coverage`: a pass taken while the quarantine folder is in flux measures a transient state (copies sitting
// in quarantine count as `held`, not `derived`), so the previous `coverage` stays and a record is never built from it. It is in flux when a quarantine
// folder changed within `QUARANTINE_SETTLE_MS` (a folder dated in the future counts as settled), or when the sessions of a host whose facts copy is in
// quarantine are more than `HELD_MAJORITY` of its sessions on disk. Only sessions held in quarantine count: a session held for another reason (a marker
// naming no store, a store without consent, an unproven Codex route) is a steady state and is recorded as `held`. The keep has a time limit,
// `KEEP_LIMIT_MS`: `status.coverage_kept` is `{ code: "quarantine_in_flux", since, at }` while passes are kept; once the first kept pass is `KEEP_LIMIT_MS` old the
// pass is recorded anyway and `coverage_kept` becomes `{ code: "quarantine_not_settling", since, at }`, which the status and the doctor show, so a quarantine that
// does not settle is published as `held` and not hidden. A pass with nothing in flux clears `coverage_kept`.
//
// Store names are compared exactly in the classifier, so this file turns every store name into lower case first, in consent, copies, receipts and markers:
// GitHub names are not case sensitive, and `session-route.js` (`sessionPlace`) and the flush (`sameRepo`) already compare them that way. Folders in the
// state root keep the case they were made with, so two stores that differ only in case count as one owner here. Their consent merges to `contribute: true`
// only when every spelling says so (the safe direction: otherwise the session is held, not counted as ready).
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { readdirSync, statSync } from "node:fs"
import * as path from "node:path"
import { claudeFolderOf, listRootSessions } from "./capture-count.js"
import { assertPartition, classifySessions } from "./capture-classify.js"
import { allOutboxNames, factoryStateRoot, listMarkers, readConsent, readDelivered, readStatus, writeStatus } from "./outbox.js"
import { ENUMS, PATTERNS, isPlainObject } from "./schema.js"
import { derivedStoreOf, deskRootOf, markerRoute, proofIndex, provenBy, sessionPlace, sessionRoute } from "./session-route.js"

/** The stage a failed coverage pass stopped at; the only thing a failure records. */
export const COVERAGE_FAILED = Object.freeze(["state_unreadable", "count_failed", "classify_failed"])

/** A quarantine folder that changed this recently is still moving: the coverage pass is not recorded. */
export const QUARANTINE_SETTLE_MS = 5 * 60 * 1000
/** With quarantine non-empty, a host whose `held` is more than this share of its sessions on disk is read as a transient quarantine, not a measurement. */
export const HELD_MAJORITY = 0.5
/** The longest a coverage pass is kept back for a quarantine in flux; after it the pass is recorded anyway and says so. */
export const KEEP_LIMIT_MS = 60 * 60 * 1000

const FACTS_NAME = new RegExp(`^(?:${ENUMS.host.join("|")})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`, "u")
const lower = (store) => (typeof store === "string" ? store.toLowerCase() : store)
const isStore = (value) => typeof value === "string" && PATTERNS.prRepo.test(value) && !/(?:^|\/)\.\.?$/u.test(value)
const isFolder = (folder) => {
  try {
    return statSync(folder).isDirectory()
  } catch {
    return false
  }
}
const markerName = (marker) => `${marker.host}-${marker.session_id}.json`

/** The session's place for `store` (`sessionPlace`), read from the markers, receipts and retracting records as the flush reads them. `store` null (none known) is `unknown`. */
export function placesFor({ markers, receipts, retracting }) {
  const byName = new Map(markers.map((marker) => [markerName(marker), marker]))
  const siblings = () => markers
  return (name, store) => {
    if (store === null) return "unknown"
    const session = name.slice(-41, -5)
    const names = ENUMS.host.map((host) => `${host}-${session}.json`)
    const marker = names.map((each) => byName.get(each)).find((found) => found !== undefined) ?? null
    const records = Object.entries(retracting.get(store) ?? {}).filter(([key, record]) => key.slice(-41, -5) === session && isPlainObject(record)).map(([, record]) => record)
    return sessionPlace(store, sessionRoute(marker, { siblings, deskRoot: deskRootOf(receipts, names) }), derivedStoreOf(receipts, names), records)
  }
}

// What the classifier is given for each valid marker, by facts name. `desk_root` is an explicit null for a session in no desk.
function markerInputs(markers, receipts) {
  const index = proofIndex(markers)
  return Object.fromEntries(markers.map((marker) => {
    const name = markerName(marker)
    const route = sessionRoute(marker, { siblings: () => markers, deskRoot: deskRootOf(receipts, [name]) })
    // A marker with no desk has no route to read.
    const current = marker.desk_root === null ? { store: null, source: "none" } : markerRoute(marker)
    // The default store is trusted only for a derived route whose desk folder still exists; a desk that is gone cannot say where its sessions belong.
    const store = route.kind === "store" ? route.store : route.kind === "derived" && marker.desk_root !== null && isFolder(marker.desk_root) && isStore(current.store) ? current.store : null
    const unproven = marker.host === "codex-cli" && current.source === "default" && !provenBy(marker, index)
    return [name, { desk_root: marker.desk_root ?? null, route: route.kind === "store" ? { kind: "store", store: lower(route.store) } : { kind: route.kind }, store: lower(store), unproven }]
  }))
}

// The receipts with their store names in lower case. Receipts of other shapes pass through untouched.
function normalReceipts(derivations) {
  return Object.fromEntries(Object.entries(derivations).map(([name, receipt]) => [name, isPlainObject(receipt) ? { ...receipt, route: lower(receipt.route), store: lower(receipt.store) } : receipt]))
}

// Consent by lower-case store: `contribute` only when every spelling of the name says true.
function normalConsent(stores) {
  const merged = new Map()
  for (const [store, entry] of Object.entries(stores)) {
    const yes = isPlainObject(entry) && entry.contribute === true
    merged.set(lower(store), (merged.get(lower(store)) ?? true) && yes)
  }
  return Object.fromEntries([...merged].map(([store, contribute]) => [store, { contribute }]))
}

// Everything the classifier needs from the state folders, read once.
async function gather(env, { markers, orphans }) {
  const status = await readStatus(env)
  const receipts = normalReceipts(isPlainObject(status.derivations) ? status.derivations : {})
  const valid = markers ?? await listMarkers(env)
  const consentStores = (await readConsent(env)).stores
  const { copies, quarantined } = await allOutboxNames(env)
  const delivered = []
  const retracting = new Map()
  const stores = new Set([...Object.keys(consentStores), ...copies.map(({ store }) => store), ...quarantined.map(({ store }) => store)].filter(isStore))
  for (const store of stores) {
    const record = await readDelivered(env, store)
    for (const name of Object.keys(record.blobs).filter((key) => FACTS_NAME.test(key))) delivered.push({ store, name })
    retracting.set(lower(store), { ...retracting.get(lower(store)), ...record.retracting, ...record.retracted })
  }
  return {
    cache: isPlainObject(status.coverage_cache) ? status.coverage_cache : {},
    orphans: orphans === undefined ? (status.orphans ?? null) : orphans,
    markers: valid,
    receipts,
    // Delivered names first, kept copies next, the live outbox last, so the store that holds the live copy names the copy.
    copies: [...delivered, ...copies].map(({ store, name }) => ({ name, store: lower(store) })),
    quarantined: quarantined.map(({ name }) => name),
    consent: normalConsent(consentStores),
    retracting,
  }
}

/** See the header. */
export async function coverageNow(env, { now = Date.now, bindingVersion, orphans, markers, caps } = {}) {
  let stage = "state_unreadable"
  try {
    const state = await gather(env, { markers, orphans })
    stage = "count_failed"
    const counted = await listRootSessions(env, { now, caps, cache: state.cache })
    stage = "classify_failed"
    const hosts = classifySessions({
      hosts: counted.hosts,
      markers: markerInputs(state.markers, state.receipts),
      receipts: state.receipts,
      copies: state.copies,
      quarantined: state.quarantined,
      consent: state.consent,
      places: placesFor({ markers: state.markers, receipts: state.receipts, retracting: state.retracting }),
      orphans: state.orphans,
      bindingVersion,
      folderOf: claudeFolderOf,
    })
    for (const host of Object.values(hosts)) assertPartition(host)
    // Per host, the sessions whose facts copy is in quarantine: the only kind of `held` that is a transient state.
    const inQuarantine = new Set(state.copies.map(({ name }) => name).filter((name) => state.quarantined.includes(name)))
    const quarantined = Object.fromEntries(Object.entries(counted.hosts).map(([host, entry]) => [host, entry.sessions.filter(({ name }) => inQuarantine.has(name)).length]))
    return { ok: true, coverage: { method: 1, ran_at: new Date(now()).toISOString(), hosts }, cache: counted.cache, quarantined }
  } catch {
    return { ok: false, code: stage }
  }
}

// The quarantine folder and its store folders: when the newest of them changed (ms, or null). Times only; an unreadable folder has not changed.
function quarantineState(root) {
  const top = path.join(root, "quarantine")
  let changedAt = null
  const touch = (folder) => {
    try {
      const at = statSync(folder).mtimeMs
      if (changedAt === null || at > changedAt) changedAt = at
    } catch {
      // A missing folder has not changed.
    }
  }
  touch(top)
  let slugs = []
  try {
    slugs = readdirSync(top, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    // No quarantine folder.
  }
  for (const slug of slugs) {
    touch(path.join(top, slug))
  }
  return { changedAt }
}

/** Whether the coverage pass was taken in a transient quarantine state; see the header.  */
async function quarantineInFlux(env, result, nowMs) {
  // An unreadable state folder throws here and the caller reports the pass as failed, keeping the earlier coverage.
  const state = quarantineState(await factoryStateRoot(env, { create: false }))
  if (state.changedAt !== null && state.changedAt <= nowMs && nowMs - state.changedAt < QUARANTINE_SETTLE_MS) return true
  return Object.entries(result.coverage.hosts).some(([host, entry]) => entry.state === "counted" && entry.on_disk > 0 && result.quarantined[host] / entry.on_disk > HELD_MAJORITY)
}

/** See the header. */
export async function recordCoverage(env, options) {
  const result = await coverageNow(env, options)
  try {
    let kept
    if (result.ok) {
      const nowMs = (options?.now ?? Date.now)()
      if (await quarantineInFlux(env, result, nowMs)) {
        const before = (await readStatus(env)).coverage_kept
        const first = isPlainObject(before) && typeof before.since === "string" ? Date.parse(before.since) : Number.NaN
        const since = Number.isFinite(first) && first <= nowMs ? first : nowMs
        const holding = nowMs - since < KEEP_LIMIT_MS
        kept = { code: holding ? "quarantine_in_flux" : "quarantine_not_settling", since: new Date(since).toISOString(), at: new Date(nowMs).toISOString() }
        if (holding) {
          await writeStatus(env, { coverage_cache: result.cache, coverage_failed: undefined, coverage_kept: kept })
          return "kept"
        }
      }
    }
    await writeStatus(env, result.ok ? { coverage: result.coverage, coverage_cache: result.cache, coverage_failed: undefined, coverage_kept: kept } : { coverage_failed: result.code })
    return result.ok ? "written" : "failed"
  } catch {
    // The status file could not be written; the sweep goes on and the next one tries again.
    return "failed"
  }
}
