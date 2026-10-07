// The local lines `factory.js status` shows for the parts that keep local state small and for a store check that keeps failing, so a stopped part
// signals where a reader looks, and the findings the doctor and the boot status raise for the same two (`local-status.js`), so it is also pushed.
// Pure: it reads the status record it is given and returns counts, fixed codes, store names and timestamps only.

/** After this many stale pull requests in a row because the store's own capture check could not read the commits, the status line says so. */
export const CHECK_UNAVAILABLE_ALARM = 3

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/** `retentionLine(status) -> string`: what the last sweep pruned (tombstones, delivered copies) or that pruning failed or never ran. */
export function retentionLine(status) {
  const retention = isObject(status?.retention) ? status.retention : null
  if (retention === null) return "retention: no sweep has pruned yet"
  const at = typeof retention.ran_at === "string" ? retention.ran_at : "unknown"
  if (retention.failed !== undefined) return `retention: pruning failed (${typeof retention.failed === "string" && /^[a-z_]{1,32}$/u.test(retention.failed) ? retention.failed : "unknown"}) at ${at}`
  const orphans = isObject(status?.orphans) ? status.orphans : {}
  const copies = count(orphans.copies_pruned)
  const failed = count(orphans.copies_prune_failed)
  return `retention: ran ${at}, ${count(retention.tombstones_pruned) ?? "unknown"} tombstones pruned${copies === null ? "" : `, ${copies} delivered copies pruned in the last orphan pass`}${failed === null ? "" : `, ${failed} copy prunes FAILED`}`
}

/**
 * `retentionFinding(status) -> "prune_failed" | "copies_prune_failed" | null`: a pruning part that stopped, which the doctor and the boot status
 * raise (`local-status.js`) so it is pushed, not only shown where a reader looks: the last sweep's tombstone pruning failed, or the last orphan
 * pass counted a delivered-copy prune that threw.
 */
export function retentionFinding(status) {
  if (isObject(status?.retention) && status.retention.failed !== undefined) return "prune_failed"
  const failed = count(isObject(status?.orphans) ? status.orphans.copies_prune_failed : undefined)
  return failed !== null && failed > 0 ? "copies_prune_failed" : null
}

/** `captureCheckFindings(status) -> { store, times }[]`: each store whose own capture check has been unavailable `CHECK_UNAVAILABLE_ALARM` times or more in a row. */
export function captureCheckFindings(status) {
  return Object.entries(isObject(status?.capture) ? status.capture : {})
    .map(([store, entry]) => ({ store, times: isObject(entry) ? count(entry.check_unavailable) : null }))
    .filter(({ times }) => times !== null && times >= CHECK_UNAVAILABLE_ALARM)
}

/** How long a capture record may stay dropped (`status.capture[store].dropped`) before it is a finding: it is due again at the next flush, so six hours without a send means it is not landing. */
export const DROPPED_ALARM_MS = 6 * 60 * 60 * 1000

/** `captureDroppedFindings(status, nowMs) -> { store, since }[]`: each store whose capture record has been dropped from a rebuilt intake branch, and not sent again, for `DROPPED_ALARM_MS` or more (`since` is when it was dropped). */
export function captureDroppedFindings(status, nowMs) {
  return Object.entries(isObject(status?.capture) ? status.capture : {})
    .filter(([, entry]) => isObject(entry) && entry.dropped === "capture_dropped" && typeof entry.dropped_at === "string" && nowMs - Date.parse(entry.dropped_at) >= DROPPED_ALARM_MS)
    .map(([store, entry]) => ({ store, since: entry.dropped_at }))
}

/** `coverageKeptFinding(status) -> { since } | null`: set when the coverage pass was kept back for a quarantine that did not settle for `KEEP_LIMIT_MS` and was recorded anyway (`status.coverage_kept.code` is `quarantine_not_settling`; `since` is when the keeping began). */
export function coverageKeptFinding(status) {
  const kept = status?.coverage_kept
  return isObject(kept) && kept.code === "quarantine_not_settling" && typeof kept.since === "string" ? { since: kept.since } : null
}

/** `captureCheckLines(status) -> string[]`: one line per store in `captureCheckFindings`. */
export function captureCheckLines(status) {
  return captureCheckFindings(status).map(({ store, times }) => `capture: the store's own check could not read the record ${times} times in a row (${store}); the record is not blamed and goes again, but it is not landing`)
}
