// Puts every root session a host kept on disk into exactly one capture bucket, and says which store's record may count it. Pure: no
// file is read here. The caller passes in the session lists (capture-count.js), the valid markers, the derivation receipts, the
// facts copies, the quarantined names, the consent decisions, the session-route adapter and the orphan pass result.
// Only counts leave this file. Names, ids, desk roots and folders are read to decide a bucket and are never returned.

export const BUCKETS = Object.freeze(["derived", "held", "frozen", "pending", "not_seen", "not_in_a_desk"])
/** The owner of a session that belongs to no store. It appears in every store's record. */
export const OWNER_NONE = "-"
/** The owner of a session whose store cannot be told. It appears in no record, because failing closed costs a slightly high share and failing open could leak. */
export const OWNER_WITHHELD = "?"
/** Why a not-current orphan is frozen when the orphan pass left no usable result. */
export const ORPHAN_PASS_UNAVAILABLE = "orphan_pass_unavailable"

const HOSTS = ["claude-code", "copilot-cli", "codex-cli"]
// The orphan pass counts these without a session on disk, so they are never part of `on_disk`.
const NOT_ON_DISK = new Set(["no_facts", "no_transcript"])
const own = (object, key) => object != null && Object.hasOwn(object, key)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isText = (value) => typeof value === "string" && value.length > 0

const zeroBuckets = (withNotInADesk) => Object.fromEntries(BUCKETS.filter((bucket) => withNotInADesk || bucket !== "not_in_a_desk").map((bucket) => [bucket, 0]))

/** Why a not-current orphan is frozen when the orphan pass has a usable result: it only counts pending orphans machine-wide, so it cannot be split by owner. */
export const ORPHAN_UNSPLIT = "orphan_unsplit"

/** Whether the orphan pass's result is usable (an object without a `failed` key). Only its `frozen` reasons are read, never its machine-wide `pending`. */
const orphanUsable = (orphans) => orphans !== null && typeof orphans === "object" && !("failed" in orphans)

/**
 * `classifySessions({ hosts, markers, receipts, copies, quarantined, consent, places, orphans, bindingVersion, folderOf })`
 *  -> `{ [host]: { state, unverified } | { state, on_disk, derived, held, frozen, pending, not_seen, not_in_a_desk, unverified, frozen_by_reason, by_owner } }`.
 *
 * - `hosts`: `{ [host]: { state, sessions: [{ name, id, folder }] } }` from capture-count.js. Only a `counted` host gets counts. An optional `undetermined`
 *   integer (Codex sessions whose first line could not be read) makes the host unverified when above 0, and is passed through when present.
 *   A marker or receipt with no matching listed session is ignored.
 * - `markers`: valid markers by facts name, each `{ desk_root, route, store, unproven }`: `route` is the positive route (`{ kind: "store", store }` or another kind),
 *   `store` the store the route resolves to now (or `null`; used only when `route.kind` is `derived`), `desk_root` is `null` (explicitly) for a session in no desk, `unproven` true for a Codex default route nothing proves.
 * - `receipts`: `status.derivations`. `copies`: `[{ name, store }]`, every facts copy in any outbox, retracted copies and delivered record.
 * - `quarantined`: the names of quarantined copies. `consent`: `{ [store]: { contribute } }`. `places(name, store)`: the session's place for its owning store
 *   (`here`, `away`, `stale`, `stalled`, `unknown`); `store` is `null` when no store is known.
 * - `orphans`: `status.orphans` or `null`. Its machine-wide `pending` count is never used: every not-current orphan is `frozen` (reason `orphan_unsplit`, or `orphan_pass_unavailable` when the pass has no usable result), so no owner's bucket depends on another owner's orphans. `folderOf(deskRoot)`: the folder name the Claude Code host gives a desk root.
 */
export function classifySessions({ hosts, markers, receipts, copies, quarantined, consent, places, orphans, bindingVersion, folderOf }) {
  const copyStore = new Map(copies.map(({ name, store }) => [name, store]))
  const quarantine = new Set(quarantined)
  const contributing = Object.values(consent ?? {}).filter((entry) => entry?.contribute === true).length
  const unowned = contributing <= 1 ? OWNER_NONE : OWNER_WITHHELD
  // Only a marker or receipt for a session a host lists counts; one with no listed session is ignored.
  const listed = new Set(Object.values(hosts).flatMap((host) => (host?.sessions ?? []).map(({ name }) => name)))
  const codexProven = [...listed].some((name) => name.startsWith("codex-cli-") && own(receipts, name))
  const markerOf = (name) => (own(markers, name) ? markers[name] : null)
  const receiptOf = (name) => (own(receipts, name) ? receipts[name] : null)

  // The store of one session, from the strongest sign down: the marker's positive route, the receipt's route, its store, the marker's resolved store, the copy's store.
  const storeOf = (name) => {
    const marker = markerOf(name)
    const receipt = receiptOf(name)
    const positive = marker?.route?.kind === "store" ? marker.route.store : undefined
    // The marker's resolved store is the default store, so it is trusted only for a derived route; an unknown route must never fall back to it.
    const resolved = marker?.route?.kind === "derived" ? marker.store : undefined
    return [positive, receipt?.route, receipt?.store, resolved, copyStore.get(name)].find(isText) ?? null
  }
  const deskRootOf = (name) => [markerOf(name)?.desk_root, receiptOf(name)?.desk_root].find(isText) ?? null

  // Every desk root any marker or receipt names, by the folder the Claude Code host gives it, with the stores those sessions point to and whether any gave none.
  const desks = new Map()
  for (const name of listed) {
    const root = deskRootOf(name)
    if (root === null) continue
    const folder = folderOf(root)
    const desk = desks.get(folder) ?? { stores: new Set(), untold: false }
    const store = storeOf(name)
    if (store === null) desk.untold = true
    else desk.stores.add(store)
    desks.set(folder, desk)
  }

  const ownerOf = (name) => {
    const store = storeOf(name)
    if (store !== null) return store
    return deskRootOf(name) === null ? unowned : OWNER_WITHHELD
  }

  const result = {}
  for (const host of HOSTS) {
    if (!own(hosts, host)) continue
    const { state, sessions } = hosts[host]
    const undetermined = hosts[host].undetermined
    const unverified = state !== "counted" || hosts[host].fallback === true || (isCount(undetermined) && undetermined > 0) || (host === "codex-cli" && !codexProven)
    if (state !== "counted") {
      result[host] = { state, unverified }
      continue
    }
    const withNotInADesk = host === "claude-code"
    const total = { ...zeroBuckets(withNotInADesk) }
    const byOwner = new Map()
    const reasons = new Map()
    // The orphan pass's `pending` count is machine-wide, so it is used for no owner's bucket: every not-current orphan is frozen.
    const usable = orphanUsable(orphans)
    const place = (bucket, owner) => {
      total[bucket] += 1
      if (!byOwner.has(owner)) byOwner.set(owner, zeroBuckets(withNotInADesk))
      byOwner.get(owner)[bucket] += 1
    }
    for (const { name, folder } of sessions) {
      const marker = markerOf(name)
      const owner = ownerOf(name)
      if (copyStore.has(name)) {
        if (quarantine.has(name)) {
          place("held", owner)
          continue
        }
        const version = receiptOf(name)?.binding_version
        if (marker === null && host === "claude-code" && !(version >= bindingVersion)) {
          const reason = usable ? ORPHAN_UNSPLIT : ORPHAN_PASS_UNAVAILABLE
          reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
          place("frozen", owner)
          continue
        }
        const where = places(name, storeOf(name))
        place(["unknown", "stale", "stalled"].includes(where) ? "frozen" : "derived", owner)
        continue
      }
      if (marker !== null) {
        const store = marker.store ?? null
        // Copilot CLI and Codex cannot tell a non-desk session apart from a miss, so their bucket stays null and a session a marker says has no desk counts as not_seen.
        if (marker.desk_root === null) place(withNotInADesk ? "not_in_a_desk" : "not_seen", owner)
        else if (store === null || consent?.[store]?.contribute !== true || marker.unproven === true) place("held", owner)
        else place("pending", owner)
        continue
      }
      if (!withNotInADesk) {
        place("not_seen", owner)
        continue
      }
      const desk = desks.get(folder)
      if (desk === undefined) place("not_in_a_desk", owner)
      else place("not_seen", desk.stores.size === 1 && !desk.untold ? [...desk.stores][0] : OWNER_WITHHELD)
    }
    // Only the orphan pass's own reasons for sessions that are on disk, added to the local reasons as they are (unknown reasons too).
    if (usable) {
      for (const [reason, count] of Object.entries(orphans.frozen ?? {})) {
        if (!NOT_ON_DISK.has(reason) && isCount(count) && host === "claude-code") reasons.set(reason, (reasons.get(reason) ?? 0) + count)
      }
    }
    result[host] = { state, on_disk: sessions.length, ...total, not_in_a_desk: withNotInADesk ? total.not_in_a_desk : null, unverified, ...(isCount(undetermined) ? { undetermined } : {}), ...(hosts[host].fallback === true ? { fallback: true } : {}), frozen_by_reason: Object.fromEntries(reasons), by_owner: Object.fromEntries(byOwner) }
  }
  return result
}

const sum = (buckets) => BUCKETS.reduce((all, bucket) => all + (buckets[bucket] ?? 0), 0)

/** Throws when a host's buckets do not add up to `on_disk`, or when its owners' buckets do not add up to the host's buckets. A host that was not counted must carry no counts. */
export function assertPartition(coverage) {
  if (coverage.state !== "counted") {
    const extra = Object.keys(coverage).filter((key) => key !== "state" && key !== "unverified")
    if (extra.length > 0) throw new Error("a host that was not counted carries counts")
    return
  }
  if (sum(coverage) !== coverage.on_disk) throw new Error("the buckets do not add up to on_disk")
  for (const bucket of BUCKETS) {
    const owners = Object.values(coverage.by_owner).reduce((all, buckets) => all + (buckets[bucket] ?? 0), 0)
    if (owners !== (coverage[bucket] ?? 0)) throw new Error(`the owners' ${bucket} do not add up to the host's`)
  }
}
