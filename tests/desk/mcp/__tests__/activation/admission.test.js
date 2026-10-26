// Write authority as session admission checks it (src/runtime/desk-session.js): verify, then validate against the policy.
import { test } from "node:test"
import { strict as assert } from "node:assert"

import { validateAdmissionAuthority, verifyAdmissionAuthority } from "../../../../../plugins/desk/mcp/src/activation/admit.js"
import { normalizeReadinessPolicy } from "../../../../../plugins/desk/mcp/src/activation/readiness-policy.js"

async function admit({ person = null, policy, authorityProvider, verifyAuthority = verifyAdmissionAuthority }) {
  const authority = await verifyAuthority({ person, policy, authorityProvider })
  return { authority, person: validateAdmissionAuthority({ authority, person, policy }) }
}

test("configured authority providers must be resolved before admission", async () => {
  await assert.rejects(
    admit({ person: "ari", policy: normalizeReadinessPolicy({ write_authority: "person", authority_provider: "crew-registry" }) }),
    (error) => {
      assert.equal(error.code, "authority_invalid")
      assert.equal(error.observed.authority_provider, "crew-registry")
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
  test(`admission refuses ${scenario.name}`, async () => {
    await assert.rejects(admit({
      person: scenario.person ?? null,
      policy: normalizeReadinessPolicy({ write_authority: scenario.authority?.mode ?? "workspace", authority_provider: "registry" }),
      authorityProvider: async () => scenario.authority,
    }), (error) => error.code === "authority_invalid" && error.status === "terminal")
  })
}

test("admission preserves a provider-derived person without raw input", async () => {
  const admission = await admit({
    policy: normalizeReadinessPolicy({ write_authority: "person", authority_provider: "registry" }),
    authorityProvider: async () => ({ mode: "person", person: "ari" }),
  })
  assert.deepEqual(admission, { authority: { mode: "person", person: "ari" }, person: "ari" })
})

for (const source of ["provider", "verifier"]) {
  for (const [policy, authority] of [
    ["person", { mode: "workspace" }],
    ["workspace", { mode: "person", person: "ari" }],
  ]) {
    test(`${source} cannot override normalized ${policy} write authority`, async () => {
      await assert.rejects(admit({
        policy: normalizeReadinessPolicy({ write_authority: policy, authority_provider: "registry" }),
        ...(source === "provider"
          ? { authorityProvider: async () => authority }
          : { verifyAuthority: async () => authority }),
      }), (error) => {
        assert.equal(error.code, "authority_invalid")
        assert.equal(error.status, "terminal")
        assert.equal(error.expected.write_authority, policy)
        assert.equal(error.observed.authority.mode, authority.mode)
        return true
      })
    })
  }
}

for (const authority of [{ mode: "workspace" }, { mode: "person", person: "ari" }]) {
  test(`matching provider ${authority.mode} policy is admitted`, async () => {
    const result = await admit({
      policy: normalizeReadinessPolicy({ write_authority: authority.mode, authority_provider: "registry" }),
      authorityProvider: async () => authority,
    })
    assert.deepEqual(result.authority, authority)
  })
}
