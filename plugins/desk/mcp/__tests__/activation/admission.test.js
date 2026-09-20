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

test("configured authority providers must be resolved before admission", async () => {
  await assert.rejects(
    admitControlPlane({
      deskRoot: "/desk",
      person: "ari",
      policy: normalizeReadinessPolicy({
        write_authority: "person",
        authority_provider: "crew-registry",
      }),
      verifyRuntime: async () => ({ state: "ready" }),
      connectController: async () => ({ accepted: true, id: "controller-1" }),
    }),
    (error) => {
      assert.equal(error.code, "authority_invalid")
      assert.equal(error.observed.authority_provider, "crew-registry")
      return true
    },
  )
})

test("admission requires a real controller connector", async () => {
  await assert.rejects(
    admitControlPlane({
      deskRoot: "/desk",
      policy: normalizeReadinessPolicy(),
      verifyRuntime: async () => ({ state: "ready" }),
    }),
    (error) => {
      assert.equal(error.code, "controller_start_failed")
      assert.equal(error.observed.connector, "missing")
      return true
    },
  )
})

for (const scenario of [
  { name: "workspace with raw person", authority: { mode: "workspace" }, person: "ari" },
  { name: "provider disagrees with raw person", authority: { mode: "person", person: "bob" }, person: "ari" },
  { name: "provider missing person", authority: { mode: "person" } },
  { name: "provider invalid person", authority: { mode: "person", person: "../other" } },
  { name: "provider missing authority", authority: undefined },
]) {
  test(`admission refuses ${scenario.name} before controller ownership`, async () => {
    let connected = false
    await assert.rejects(admitControlPlane({
      deskRoot: "/desk",
      person: scenario.person,
      policy: normalizeReadinessPolicy({ write_authority: scenario.authority?.mode ?? "workspace" }),
      authorityProvider: async () => scenario.authority,
      connectController: async () => { connected = true; return { accepted: true } },
    }), (error) => error.code === "authority_invalid" && error.status === "terminal")
    assert.equal(connected, false)
  })
}

test("admission preserves a provider-derived person without raw input", async () => {
  const admission = await admitControlPlane({
    deskRoot: "/desk",
    policy: normalizeReadinessPolicy({ write_authority: "person", authority_provider: "registry" }),
    authorityProvider: async () => ({ mode: "person", person: "ari" }),
    connectController: async () => ({ accepted: true }),
  })
  assert.deepEqual(admission.authority, { mode: "person", person: "ari" })
})

for (const source of ["provider", "verifier"]) {
  for (const [policy, authority] of [
    ["person", { mode: "workspace" }],
    ["workspace", { mode: "person", person: "ari" }],
  ]) {
    test(`${source} cannot override normalized ${policy} write authority before connecting`, async () => {
      let connected = false
      await assert.rejects(admitControlPlane({
        deskRoot: "/desk",
        policy: normalizeReadinessPolicy({ write_authority: policy, authority_provider: "registry" }),
        ...(source === "provider"
          ? { authorityProvider: async () => authority }
          : { verifyAuthority: async () => authority }),
        connectController: async () => { connected = true; return { accepted: true } },
      }), (error) => {
        assert.equal(error.code, "authority_invalid")
        assert.equal(error.status, "terminal")
        assert.equal(error.expected.write_authority, policy)
        assert.equal(error.observed.authority.mode, authority.mode)
        return true
      })
      assert.equal(connected, false)
    })
  }
}

for (const authority of [{ mode: "workspace" }, { mode: "person", person: "ari" }]) {
  test(`matching provider ${authority.mode} policy is admitted`, async () => {
    const result = await admitControlPlane({
      deskRoot: "/desk",
      policy: normalizeReadinessPolicy({ write_authority: authority.mode, authority_provider: "registry" }),
      authorityProvider: async () => authority,
      connectController: async () => ({ accepted: true }),
    })
    assert.equal(result.state, "CONTROL_READY")
    assert.deepEqual(result.authority, authority)
  })
}
