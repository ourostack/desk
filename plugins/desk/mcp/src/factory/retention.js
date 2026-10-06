// The local lines `factory.js status` shows for the parts that keep local state small and for a store check that keeps failing, so a stopped part
// signals where a reader looks. Pure: it reads the status record it is given and returns text of counts, fixed codes and timestamps only.

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

/** `captureCheckLines(status) -> string[]`: one line per store whose own capture check has been unavailable `CHECK_UNAVAILABLE_ALARM` times or more in a row. */
export function captureCheckLines(status) {
  const lines = []
  for (const [store, entry] of Object.entries(isObject(status?.capture) ? status.capture : {})) {
    const times = isObject(entry) ? count(entry.check_unavailable) : null
    if (times !== null && times >= CHECK_UNAVAILABLE_ALARM) lines.push(`capture: the store's own check could not read the record ${times} times in a row (${store}); the record is not blamed and goes again, but it is not landing`)
  }
  return lines
}
