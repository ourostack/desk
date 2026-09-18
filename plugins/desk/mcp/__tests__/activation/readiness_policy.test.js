import { test } from "node:test"
import { strict as assert } from "node:assert"

import { normalizeReadinessPolicy } from "../../src/activation/readiness-policy.js"

test("readiness policy accepts lexical-required background-semantic consumers", () => {
  const input = {
    root: "workspace",
    write_authority: "person",
    lexical: "required",
    semantic: "background",
  }
  const before = structuredClone(input)

  const policy = normalizeReadinessPolicy(input)

  assert.deepEqual(policy, {
    root: "workspace",
    write_authority: "person",
    lexical: "required",
    semantic: "background",
    authority_provider: null,
  })
  assert.equal(Object.isFrozen(policy), true)
  assert.deepEqual(input, before)
})

test("readiness policy defaults workspace authority and required lexical service", () => {
  assert.deepEqual(
    normalizeReadinessPolicy(),
    {
      root: "workspace",
      write_authority: "workspace",
      lexical: "required",
      semantic: "background",
      authority_provider: null,
    },
  )
})

test("readiness policy rejects weaker lexical service", () => {
  assert.throws(
    () => normalizeReadinessPolicy({ lexical: "best-effort" }),
    (error) => {
      assert.equal(error?.code, "activation_policy_invalid")
      assert.equal(error?.status, "terminal")
      assert.equal(error?.retryable, false)
      assert.match(error?.summary ?? "", /lexical/u)
      return true
    },
  )
})
