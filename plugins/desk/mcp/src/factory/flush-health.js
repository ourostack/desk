// Which flush results looked at the account, so a delivery fault is cleared only by a flush that got far enough to see it.
//
// A flush that ends before it reaches the account (`nothing_pending`, `offline`, `locked`, `deadline`, `rate_limited`,
// `unexpected`, `not_opted_in`, `gh_too_old`) says nothing about a standing account fault. `last_flush.<store>.account_fault`
// keeps the last fault such a flush could not see past, the way `held_elsewhere` and `route_unknown` are carried, and the
// loop's route step (`route-local.js`) reads it as still present (fail closed, ruling 2026-10-06).
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

/** The flush results that are a standing account fault. */
export const ACCOUNT_FAULTS = Object.freeze(["no_account", "auth_failed", "gh_missing", "account_cannot_deliver"])
/** The flush results that prove the account was used after the fault checks: they clear a carried fault. */
export const ACCOUNT_SEEN = Object.freeze(["delivered_pr_open", "intake_stale_retried", "store_missing", "fork_pending"])

/**
 * The account fault `last_flush.<store>.account_fault` holds after a flush that resolved `result`, given the store's previous
 * entry `before`: the fault itself, nothing after a flush that used the account (`reachedAccount`: the account signed in and
 * answered, whatever the result, `nothing_pending` after going online included), else the previous fault carried forward (an
 * entry from before this field counts its own fault result).
 */
export function carriedAccountFault(result, before, { reachedAccount = false } = {}) {
  if (ACCOUNT_FAULTS.includes(result)) return result
  if (reachedAccount || ACCOUNT_SEEN.includes(result)) return null
  const previous = before?.account_fault ?? before?.result
  return ACCOUNT_FAULTS.includes(previous) ? previous : null
}
