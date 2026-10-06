// Which flush results looked at the account: a standing account fault is cleared only by a flush that got far enough to see it.

import { test } from "node:test"
import assert from "node:assert/strict"

import { ACCOUNT_FAULTS, ACCOUNT_SEEN, carriedAccountFault } from "../../../../../plugins/desk/mcp/src/factory/flush-health.js"
import { FLUSH_CODES } from "../../../../../plugins/desk/mcp/src/factory/flush.js"

const EARLY = ["nothing_pending", "not_opted_in", "gh_too_old", "rate_limited", "offline", "locked", "deadline", "unexpected"]

test("every flush result is a fault, a look that used the account, or an early end", () => {
  assert.deepEqual([...ACCOUNT_FAULTS, ...ACCOUNT_SEEN, ...EARLY].sort(), [...FLUSH_CODES].sort())
})

test("a fault is recorded, a look that used the account clears it, and an early end carries the previous one", () => {
  for (const fault of ACCOUNT_FAULTS) assert.equal(carriedAccountFault(fault, { result: "delivered_pr_open" }), fault)
  for (const seen of ACCOUNT_SEEN) assert.equal(carriedAccountFault(seen, { result: "nothing_pending", account_fault: "auth_failed" }), null)
  for (const early of EARLY) {
    assert.equal(carriedAccountFault(early, { result: "nothing_pending", account_fault: "auth_failed" }), "auth_failed", early)
    // An entry written before account_fault existed counts its own fault result.
    assert.equal(carriedAccountFault(early, { result: "account_cannot_deliver" }), "account_cannot_deliver", early)
    assert.equal(carriedAccountFault(early, { result: "delivered_pr_open" }), null, early)
    assert.equal(carriedAccountFault(early, undefined), null, early)
    assert.equal(carriedAccountFault(early, { result: "offline", account_fault: "made_up" }), null, early)
  }
})
