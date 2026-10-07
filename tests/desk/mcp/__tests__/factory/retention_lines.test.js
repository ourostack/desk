// The local status lines for pruning and for a store check that keeps failing.
import { test } from "node:test"
import assert from "node:assert/strict"

import { CHECK_UNAVAILABLE_ALARM, captureCheckFindings, captureCheckLines, retentionFinding, retentionLine } from "../../../../../plugins/desk/mcp/src/factory/retention.js"

test("the retention line says what was pruned, that pruning failed, or that nothing has run", () => {
  for (const status of [undefined, null, {}, { retention: "x" }, { retention: [] }]) assert.equal(retentionLine(status), "retention: no sweep has pruned yet")
  assert.equal(retentionLine({ retention: { ran_at: "2026-10-06T00:00:00.000Z", tombstones_pruned: 2 } }), "retention: ran 2026-10-06T00:00:00.000Z, 2 tombstones pruned")
  assert.equal(retentionLine({ retention: { ran_at: "2026-10-06T00:00:00.000Z", tombstones_pruned: 2 }, orphans: { copies_pruned: 3, copies_prune_failed: 1 } }), "retention: ran 2026-10-06T00:00:00.000Z, 2 tombstones pruned, 3 delivered copies pruned in the last orphan pass, 1 copy prunes FAILED")
  assert.equal(retentionLine({ retention: { ran_at: 5, tombstones_pruned: -1 }, orphans: "x" }), "retention: ran unknown, unknown tombstones pruned")
  assert.equal(retentionLine({ retention: { ran_at: "t", failed: "prune_failed" } }), "retention: pruning failed (prune_failed) at t")
  assert.equal(retentionLine({ retention: { failed: "Not a code!" } }), "retention: pruning failed (unknown) at unknown")
  assert.equal(retentionLine({ retention: { failed: 7 } }), "retention: pruning failed (unknown) at unknown")
})

test("a store whose own check failed the alarm number of times in a row gets a line, and no other store does", () => {
  assert.equal(CHECK_UNAVAILABLE_ALARM, 3)
  assert.deepEqual(captureCheckLines(undefined), [])
  assert.deepEqual(captureCheckLines({ capture: "x" }), [])
  assert.deepEqual(captureCheckLines({ capture: { "a/b": 5, "c/d": { check_unavailable: 2 }, "e/f": { check_unavailable: "3" }, "g/h": {} } }), [])
  const lines = captureCheckLines({ capture: { "a/b": { check_unavailable: 3 } } })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /3 times in a row \(a\/b\)/u)
})

test("a stopped pruning part is a finding: the sweep's tombstone pruning failed, or the last orphan pass counted a copy prune that threw", () => {
  for (const status of [undefined, null, {}, { retention: "x" }, { retention: { ran_at: "t", tombstones_pruned: 0 } }, { orphans: "x" }, { orphans: { copies_prune_failed: 0 } }, { orphans: { copies_prune_failed: "2" } }]) assert.equal(retentionFinding(status), null)
  assert.equal(retentionFinding({ retention: { ran_at: "t", failed: "prune_failed" } }), "prune_failed")
  assert.equal(retentionFinding({ retention: { failed: "Not a code!" } }), "prune_failed", "a fixed code, never the recorded text")
  assert.equal(retentionFinding({ retention: { ran_at: "t", tombstones_pruned: 1 }, orphans: { copies_prune_failed: 2 } }), "copies_prune_failed")
})

test("a store whose own check failed the alarm number of times in a row is a finding, by store and count", () => {
  assert.deepEqual(captureCheckFindings(undefined), [])
  assert.deepEqual(captureCheckFindings({ capture: { "a/b": { check_unavailable: 2 }, "c/d": { check_unavailable: 4 }, "e/f": 9 } }), [{ store: "c/d", times: 4 }])
})
