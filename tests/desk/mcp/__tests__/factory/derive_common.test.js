import { test } from "node:test"
import { strict as assert } from "node:assert"

import { applyLimits, flagEmptyUsage, usageAbsent, usageOrNull } from "../../../../../plugins/desk/mcp/src/factory/derive-common.js"

test("usageOrNull returns null for absent, malformed and unsafe values and the number for a safe one", () => {
  assert.equal(usageOrNull(undefined), null)
  assert.equal(usageOrNull(null), null)
  assert.equal(usageOrNull("5"), null)
  assert.equal(usageOrNull(-1), null)
  assert.equal(usageOrNull(1.5), null)
  assert.equal(usageOrNull(Number.MAX_SAFE_INTEGER + 1), null)
  assert.equal(usageOrNull(0), 0)
  assert.equal(usageOrNull(42), 42)
})

test("usageAbsent separates absent from malformed", () => {
  assert.equal(usageAbsent(undefined), true)
  assert.equal(usageAbsent(null), true)
  assert.equal(usageAbsent(0), false)
  assert.equal(usageAbsent("x"), false)
  assert.equal(usageAbsent(-1), false)
})

test("flagEmptyUsage flags the three fields once when models are empty and nothing when they are not", () => {
  const unavailable = []
  flagEmptyUsage(unavailable, [])
  flagEmptyUsage(unavailable, [])
  assert.deepEqual(unavailable, [
    { field: "models", reason: "field_absent" },
    { field: "tokens", reason: "field_absent" },
    { field: "requests", reason: "field_absent" },
  ])
  const none = []
  flagEmptyUsage(none, [{ id: "m", requests: 1 }])
  assert.deepEqual(none, [])
})

test("flagEmptyUsage does not add a field that already carries a flag", () => {
  for (const field of ["models", "tokens", "requests"]) {
    const unavailable = [{ field, reason: "source_unreadable" }]
    flagEmptyUsage(unavailable, [])
    assert.deepEqual(unavailable.filter((entry) => entry.field === field), [{ field, reason: "source_unreadable" }])
    assert.equal(unavailable.length, 3)
  }
})

test("applyLimits flags prs capped when the cap drops PRs", () => {
  const unavailable = []
  const result = applyLimits({ agents: [], intervals: [], models: [], prs: [{ repo: "a/a", number: 1 }, { repo: "a/a", number: 2 }] }, unavailable, { agents: 5, intervals: 5, models: 5, prs: 1 })
  assert.equal(result.prs.length, 1)
  assert.deepEqual(unavailable, [{ field: "prs", reason: "capped" }])
})

test("applyLimits flags agents capped when the agent cap drops agents", () => {
  const unavailable = []
  const result = applyLimits({ agents: [{ n: 0, parent: null, model: "m" }, { n: 1, parent: 0, model: "m" }], intervals: [], models: [], prs: [] }, unavailable, { agents: 1, intervals: 5, models: 5, prs: 5 })
  assert.equal(result.agents.length, 1)
  assert.deepEqual(unavailable, [
    { field: "turns", reason: "capped" },
    { field: "tool_durations", reason: "capped" },
    { field: "agents", reason: "capped" },
  ])
})
