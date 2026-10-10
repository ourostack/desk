import assert from "node:assert/strict"

// A slow runtime may only deliver explicitly cached detail. A test of a state
// transition must require a computation started after that transition, never
// merely accept whichever cached payload happens to accompany current admission.
export function statusObservedSince(payload, { root, since }) {
  if (payload.root?.path !== root || payload.readiness?.detail === undefined) return false
  if (payload.status_detail === undefined) {
    assert.equal(payload.status_detail_from, undefined)
    return true
  }
  assert.match(payload.status_detail, /^cached: /u)
  const at = Date.parse(payload.status_detail_from)
  return Number.isFinite(at) && at >= since
}
