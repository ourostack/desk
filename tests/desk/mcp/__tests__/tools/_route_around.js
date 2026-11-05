import assert from "node:assert/strict"

// A result that left its change uncommitted carries `route_around` (#561, #623): the read-back first, then the steps that
// finish the commit, and the read-backs for "committed here" and "published". Returns the failure without the route, so a
// test can still compare the rest of it exactly.
export function notCommitted(commit) {
  assert.ok(commit && typeof commit === "object", "a commit failure is an object")
  const { route_around: route, ...rest } = commit
  assertRoute(route)
  return rest
}

export function assertRoute(route) {
  assert.ok(route && typeof route === "object", "a result that is not committed carries route_around")
  assert.equal(typeof route.summary, "string")
  assert.ok(Array.isArray(route.steps) && route.steps.length >= 2, "route_around has steps")
  for (const step of route.steps) {
    assert.equal(typeof step.step, "string")
    for (const argv of [step.argv ?? []].flatMap((a) => (Array.isArray(a[0]) ? a : a.length ? [a] : []))) {
      for (const banned of ["stash", "--force", "-f", "--no-verify", "-a", "-A"]) assert.ok(!argv.includes(banned), `route_around never runs ${banned}`)
    }
  }
  assert.ok(!JSON.stringify(route).includes("DESK_TOOL_COMMIT"), "route_around never names or sets the card guard's override")
  assert.ok(Array.isArray(route.committed_locally_when?.argv), "route_around says how to read back the local commit")
}
