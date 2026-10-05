// The reasons `factory reconcile` gives for a mismatch between a desk's real task activity and the factory's jobs.
// One list, in pipeline order (a task takes the first reason that explains it; see `reconcile.js`). Every reason is
// reachable by a test (`reconcile.test.js` checks the whole list was reached).

export const RECONCILE_REASONS = Object.freeze([
  "not_bound",
  "not_opted_in",
  "route_changed",
  "held",
  "log_missing",
  "stale_binding",
  "focus_disagrees",
  "not_delivered",
  "quarantined",
  "pr_open",
  "card_missing",
  "invalid_status",
  "status_unobserved",
  "store_only",
])
