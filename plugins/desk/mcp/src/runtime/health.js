// The sync word both the session-start boot script and the compact `desk_status` report, so the two cannot
// disagree about a failed sync (boot acceptance round A: boot said `degraded` for a failed sync while `desk_status`
// said `ready` and "in sync", because it only read local ahead/behind counts that a failed pull never changes).
// This module shares only that word and the `ready`/`degraded` join; everything else in either answer (prerequisites,
// task cards, push accounts, the search index) stays with its own caller. `setup_required` and `admitting` are also
// decided by their callers.
//
// `degraded` lines are plain sentences, one per problem. The word is `degraded` when any line exists and `ready`
// when none does.

/** No-work evidence does not establish incoming resolution. */
export function verifiedIncomingResolution(operation) {
  return operation?.state === "synced" && operation?.incoming?.state === "verified"
}

/**
 * The degraded line for the outcome of a desk sync (`{ state, reason, cause }` as `syncWorkspace` returns it, or
 * the `last_pull` record `desk_status` reads back), or null when the sync did not fail.
 */
export function syncDegradation(sync) {
  if (!verifiedIncomingResolution(sync?.operation) && sync?.operation?.priorFailure) return syncDegradation(sync.operation.priorFailure)
  // Local commits a push could not deliver are degraded even when the pull worked: work the operator thinks is shared is not.
  const stuck = sync?.unpushed?.count > 0 && (typeof sync.unpushed.reason === "string" || sync.unpushed.delivering === false)
  const push = stuck ? `push: ${sync.unpushed.count} local commit(s) not on the remote (${sync.unpushed.reason ?? "not delivered"})` : null
  if (sync?.state !== "unresolved") return push
  const detail = [sync.reason, sync.cause].filter((value) => typeof value === "string" && value !== "")
  return `sync: unresolved${detail.length > 0 ? ` (${detail.join(", ")})` : ""}${push === null ? "" : `; ${push}`}`
}

/** `degraded` when any line says so, otherwise `ready`. */
export function healthWord(degraded) {
  return degraded.length > 0 ? "degraded" : "ready"
}

/**
 * Incoming failure remains until its own operation settles. Age and unrelated outgoing or graph evidence cannot clear it.
 */
export function pullStillFailing({ lastPull }) {
  return lastPull?.state === "unresolved"
}
