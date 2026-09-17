import { test } from "node:test"
import { strict as assert } from "node:assert"

import { admitControlPlane } from "../../src/activation/admit.js"
import { normalizeReadinessPolicy } from "../../src/activation/readiness-policy.js"

test("warm admission reaches CONTROL_READY without workspace traversal", async () => {
  let discoveryCalls = 0
  const result = await admitControlPlane({
    deskRoot: "/desk",
    person: "ari",
    policy: normalizeReadinessPolicy({
      write_authority: "person",
    }),
    verifyRuntime: async () => ({ state: "ready" }),
    verifyAuthority: async () => ({ mode: "person", person: "ari" }),
    connectController: async () => ({ accepted: true, id: "controller-1" }),
    discoverWorkspace: () => {
      discoveryCalls += 1
      throw new Error("workspace traversal is forbidden during admission")
    },
  })

  assert.equal(result.state, "CONTROL_READY")
  assert.equal(result.root, "/desk")
  assert.deepEqual(result.authority, { mode: "person", person: "ari" })
  assert.equal(result.controller.id, "controller-1")
  assert.deepEqual(result.automatic_actions, [])
  assert.equal(discoveryCalls, 0)
})

test("controller refusal becomes a stable terminal activation failure", async () => {
  await assert.rejects(
    admitControlPlane({
      deskRoot: "/desk",
      policy: normalizeReadinessPolicy(),
      verifyRuntime: async () => ({ state: "ready" }),
      verifyAuthority: async () => ({ mode: "workspace" }),
      connectController: async () => ({
        accepted: false,
        reason: "owner unavailable",
      }),
    }),
    (error) => {
      assert.equal(error.code, "controller_start_failed")
      assert.equal(error.phase, "VERIFYING")
      assert.equal(error.retryable, false)
      assert.equal(error.observed.reason, "owner unavailable")
      return true
    },
  )
})
