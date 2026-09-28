import { test } from "node:test"
import { strict as assert } from "node:assert"

import { transitionReadiness } from "../../src/readiness/state.js"

test("CONTROL_READY can enter lexical convergence but not READY directly", () => {
  assert.equal(
    transitionReadiness("CONTROL_READY", "LEXICAL_CONVERGING"),
    "LEXICAL_CONVERGING",
  )
  assert.throws(
    () => transitionReadiness("CONTROL_READY", "READY"),
    /illegal readiness transition/u,
  )
})

test("every active readiness phase may enter recovery or terminal state", () => {
  for (const phase of [
    "CONTROL_READY",
    "LEXICAL_CONVERGING",
    "LEXICAL_READY",
    "SEMANTIC_CONVERGING",
    "READY",
  ]) {
    assert.equal(transitionReadiness(phase, "RECOVERING"), "RECOVERING")
    assert.equal(transitionReadiness(phase, "TERMINAL"), "TERMINAL")
  }
})
