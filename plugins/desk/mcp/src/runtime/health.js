// The one place that turns facts into Desk's health word, so the session-start boot script and the compact
// `desk_status` can never disagree (boot acceptance round A: boot said `degraded` for a failed sync while
// `desk_status` said `ready` and "in sync", because desk_status only read local ahead/behind counts that a
// failed pull never changes).
//
// `degraded` lines are plain sentences, one per problem. The word is `degraded` when any line exists and `ready`
// when none does; `setup_required` and `admitting` are the other two words, decided by their own callers.

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
