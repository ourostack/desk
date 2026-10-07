// The sync word both the session-start boot script and the compact `desk_status` report, so the two cannot
// disagree about a failed sync (boot acceptance round A: boot said `degraded` for a failed sync while `desk_status`
// said `ready` and "in sync", because it only read local ahead/behind counts that a failed pull never changes).
// This module shares only that word and the `ready`/`degraded` join; everything else in either answer (prerequisites,
// task cards, push accounts, the search index) stays with its own caller. `setup_required` and `admitting` are also
// decided by their callers.
//
// `degraded` lines are plain sentences, one per problem. The word is `degraded` when any line exists and `ready`
// when none does.

/**
 * The degraded line for the outcome of a desk sync (`{ state, reason, cause }` as `syncWorkspace` returns it, or
 * the `last_pull` record `desk_status` reads back), or null when the sync did not fail.
 */
export function syncDegradation(sync) {
  if (sync?.state !== "unresolved") return null
  const detail = [sync.reason, sync.cause].filter((value) => typeof value === "string" && value !== "")
  return `sync: unresolved${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`
}

/** `degraded` when any line says so, otherwise `ready`. */
export function healthWord(degraded) {
  return degraded.length > 0 ? "degraded" : "ready"
}

const LAST_PULL_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Whether a recorded failed pull still counts. It stops counting once something proves the remote reachable again
 * (a push, or Desk's own fetch, that finished after the failure; both are recorded by Desk, never read from Git's `FETCH_HEAD`, which a failed fetch rewrites too) and in any case after 24 hours, because `desk_status` does not
 * re-run the pull: the record is a note from the last boot, not a live probe. `lastPull.at` is when it failed;
 * `lastPushAt` and `fetchedAt` are ISO text or epoch milliseconds, either may be null.
 */
export function pullStillFailing({ lastPull, lastPushAt = null, fetchedAt = null, now = Date.now() }) {
  if (lastPull?.state !== "unresolved") return false
  const failedAt = Date.parse(lastPull.at)
  if (Number.isNaN(failedAt) || now - failedAt > LAST_PULL_TTL_MS) return false
  const after = (when) => {
    const at = typeof when === "number" ? when : Date.parse(when)
    return !Number.isNaN(at) && at >= failedAt
  }
  return !(after(lastPushAt) || after(fetchedAt))
}
