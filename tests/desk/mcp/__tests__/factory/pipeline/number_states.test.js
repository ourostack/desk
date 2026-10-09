import { test } from "node:test"
import assert from "node:assert/strict"

import { ENUMS } from "../../../../../../plugins/desk/mcp/src/factory/schema.js"
import {
  FEEDS,
  FORMULA_IDS,
  NOT_FED,
  NUMBER_STATES,
  fieldsFeeding,
  reasonsOf,
  stateOf,
  withState,
} from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"

test("every published unavailable field has a row and a row with no feed says why", () => {
  assert.deepEqual(Object.keys(FEEDS).sort(), [...ENUMS.publishedUnavailableField].sort())
  for (const [field, entry] of Object.entries(FEEDS)) {
    const feeds = entry.unavailable.length + entry.partial.length > 0
    if (feeds) assert.equal(Object.hasOwn(entry, "feedsNothing"), false, `${field} feeds numbers and also says it feeds nothing`)
    else assert.match(entry.feedsNothing, /\S/, `${field} feeds nothing and does not say why`)
  }
})

test("every formula id and every not-fed name is unique and appears in no row twice under the same effect", () => {
  assert.equal(new Set(FORMULA_IDS).size, FORMULA_IDS.length)
  for (const name of Object.keys(NOT_FED)) {
    assert.equal(FORMULA_IDS.includes(name), false, `${name} is both a formula id and not fed`)
    assert.match(NOT_FED[name], /\S/)
  }
  for (const [field, entry] of Object.entries(FEEDS)) {
    for (const effect of ["unavailable", "partial"]) {
      assert.equal(new Set(entry[effect]).size, entry[effect].length, `${field} lists a formula twice under ${effect}`)
      for (const id of entry[effect]) assert.ok(FORMULA_IDS.includes(id), `${field} names unknown formula ${id}`)
    }
    for (const id of entry.unavailable) assert.equal(entry.partial.includes(id), false, `${field} lists ${id} under both effects`)
  }
  assert.deepEqual([...NUMBER_STATES], ["measured", "partial", "unavailable"])
})

test("stateOf maps measured, inferred and declared classes to measured", () => {
  for (const cls of ["measured", "inferred", "declared"]) {
    const result = { class: cls, value: 3 }
    assert.equal(stateOf(result), "measured")
    assert.deepEqual(withState(result), { class: cls, value: 3, state: "measured", reasons: [] })
  }
  assert.equal(stateOf({ class: "measured", value: 1, censored: false }), "measured")
})

test("stateOf maps a partial result and a censored result to partial and puts censored in reasons", () => {
  const partial = { class: "measured", value: 2, partial: true, uncovered_sessions: 1, partial_reasons: ["worker_split", "host_records_partly", "worker_split"] }
  assert.equal(stateOf(partial), "partial")
  assert.deepEqual(reasonsOf(partial), ["host_records_partly", "worker_split"])
  const censored = { class: "measured", value: 5, censored: true }
  assert.equal(stateOf(censored), "partial")
  assert.deepEqual(reasonsOf(censored), ["censored"])
  assert.deepEqual(reasonsOf({ ...partial, censored: true }), ["censored", "host_records_partly", "worker_split"])
})

test("stateOf maps an unavailable result to unavailable and reasons lists a mixed result's reasons", () => {
  const single = { class: "unavailable", value: null, reason: "log_missing" }
  assert.equal(stateOf(single), "unavailable")
  assert.deepEqual(withState(single), { ...single, state: "unavailable", reasons: ["log_missing"] })
  const mixed = { class: "unavailable", value: null, reason: "mixed", reasons: ["log_truncated", "host_does_not_record"] }
  assert.deepEqual(reasonsOf(mixed), ["host_does_not_record", "log_truncated"])
  // An unavailable result never carries an empty reasons list: it falls back to its own reason.
  assert.deepEqual(reasonsOf({ class: "unavailable", value: null, reason: "mixed", reasons: [] }), ["mixed"])
})

test("fieldsFeeding returns the fields in the table for a formula and effect", () => {
  assert.deepEqual(fieldsFeeding("active_time_ms", "unavailable"), ["job_offsets"])
  assert.deepEqual(fieldsFeeding("active_time_ms", "partial"), ["turns", "tool_durations", "job_segments"])
  assert.deepEqual(fieldsFeeding("waits.api_retry_ms", "unavailable"), ["api_retries", "job_offsets"])
  assert.deepEqual(fieldsFeeding("rework_signals.api_retries", "unavailable"), ["api_retries"])
  assert.deepEqual(fieldsFeeding("longest_wait", "partial"), ["turns", "human_waits", "permission_waits", "api_retries", "compaction_waits"])
  assert.deepEqual(fieldsFeeding("waits.compaction_ms", "unavailable"), ["turns", "compaction_waits", "job_offsets"])
  assert.deepEqual(fieldsFeeding("tokens_total.reasoning", "unavailable"), ["tokens", "models", "reasoning_tokens"])
  assert.deepEqual(fieldsFeeding("tokens_total.total", "unavailable"), ["tokens", "models"])
  assert.deepEqual(fieldsFeeding("first_pass_yield", "partial"), [])
})
