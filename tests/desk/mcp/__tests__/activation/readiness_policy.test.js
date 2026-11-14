import { test } from "node:test"
import { strict as assert } from "node:assert"

import { normalizeReadinessPolicy } from "../../../../../plugins/desk/mcp/src/activation/readiness-policy.js"

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

test("readiness policy diagnostics lead with the fix, for default and supplied contexts", () => {
  const diagnostics = (fn) => {
    try {
      fn()
    } catch (error) {
      return { error, diagnostics: error.diagnostics }
    }
    assert.fail("expected a refusal")
  }

  const plain = diagnostics(() => normalizeReadinessPolicy("nope"))
  assert.equal(plain.error.phase, "VERIFYING")
  assert.equal(plain.diagnostics[0].path, "desk_runtime")
  assert.match(plain.diagnostics[0].message, /^Set desk_runtime to an object/u)

  const supplied = diagnostics(() => normalizeReadinessPolicy(7, { path: "cfg.runtime", phase: "BOOT", automaticActions: ["retry"] }))
  assert.equal(supplied.error.phase, "BOOT")
  assert.equal(supplied.diagnostics[0].path, "cfg.runtime")

  const provider = diagnostics(() => normalizeReadinessPolicy({ authority_provider: "" }))
  assert.equal(provider.diagnostics[0].path, "desk_runtime.authority_provider")
  assert.match(provider.diagnostics[0].message, /^Set authority_provider to null or to non-empty text/u)

  const named = diagnostics(() => normalizeReadinessPolicy({ authority_provider: 5, root: "x" }, { path: "cfg.runtime" }))
  assert.equal(named.diagnostics[0].path, "cfg.runtime.root")
  assert.match(named.diagnostics[0].message, /^Set the readiness policy root to one of: workspace\./u)
  assert.equal(named.diagnostics[1].path, "cfg.runtime.authority_provider")
})
