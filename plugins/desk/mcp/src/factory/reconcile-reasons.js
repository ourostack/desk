// The reasons `factory reconcile` gives for a mismatch between a desk's real task activity and the factory's jobs.
// One list, in pipeline order (a task takes the first reason that explains it; see `reconcile.js`).

export const RECONCILE_REASONS = Object.freeze([
  "no_marker",
  "not_opted_in",
  "route_changed",
  "held",
  "log_missing",
  "stale_binding",
  "not_delivered",
  "quarantined",
  "pr_open",
  "card_missing",
  "invalid_status",
  "mechanical_only",
  "store_only",
])
