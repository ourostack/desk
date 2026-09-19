import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { materializeCodexActivation } from "../../src/activation/adapters/codex.js"
import { main, resolveStartupReadinessPolicy } from "../../index.js"
import { resolveWriteTarget } from "../../src/util/paths.js"

const manifest = JSON.parse(readFileSync(new URL("../../../activation/desk.activation.json", import.meta.url)))

function input(mode, desk_runtime, overrides = {}) {
  return {
    manifest: { ...manifest, desk_runtime },
    mode,
    existingConfig: "",
    existingInstructions: "",
    pluginRoot: "plugins/desk",
    deskRoot: ".desk",
    runtimeCacheDir: ".cache/desk",
    sourceIdentity: `sha256:${"a".repeat(64)}`,
    ...overrides,
  }
}

for (const mode of ["global-personal", "project-local"]) {
  test(`Codex ${mode} carries normalized readiness policy through startup readback`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "desk-codex-policy-"))
    try {
      const result = materializeCodexActivation(input(mode, {
        root: "workspace", write_authority: "workspace", lexical: "required", semantic: "unsupported",
      }, { deskRoot: root }))
      const configPath = path.join(root, "activation.json")
      writeFileSync(configPath, result.generatedActivationConfig)
      const expected = {
        root: "workspace", write_authority: "workspace", lexical: "required",
        semantic: "unsupported", authority_provider: null,
      }
      assert.deepEqual(JSON.parse(result.generatedActivationConfig).desk_runtime, expected)
      assert.deepEqual(resolveStartupReadinessPolicy({
        args: { activationConfig: configPath }, env: {},
      }), expected)
      const argv = JSON.parse(result.generatedConfig.match(/^args = (.+)$/mu)[1]).slice(1)
      argv[argv.indexOf("--activation-config") + 1] = configPath
      let started
      await main({
        argv, env: {}, runtimeInspector: null,
        runtimeImporter: async () => ({
          connectOrStartController: async () => ({ accepted: true }),
          startServer: async (options) => { started = options },
        }),
      })
      assert.deepEqual(started.statusContext.admission.authority, { mode: "workspace" })
      assert.equal(started.person ?? null, null)
      assert.equal(
        await resolveWriteTarget({ deskRoot: root, person: started.person, segments: ["task.md"] }),
        path.join(root, "task.md"),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("Codex person policy reaches admission and enforces the generated person argument", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-codex-person-"))
  try {
    const result = materializeCodexActivation(input("project-local", {
      root: "workspace", write_authority: "person", lexical: "required", semantic: "background",
    }, { deskRoot: root, person: "ari" }))
    const argv = JSON.parse(result.generatedConfig.match(/^args = (.+)$/mu)[1]).slice(1)
    assert.deepEqual(argv.slice(-2), ["--person", "ari"])
    const configPath = path.join(root, "activation.json")
    writeFileSync(configPath, result.generatedActivationConfig)
    argv[argv.indexOf("--activation-config") + 1] = configPath
    let started
    await main({
      argv, env: {}, runtimeInspector: null,
      runtimeImporter: async () => ({
        connectOrStartController: async () => ({ accepted: true }),
        startServer: async (options) => { started = options },
      }),
    })
    assert.deepEqual(started.statusContext.admission.authority, { mode: "person", person: "ari" })
    assert.equal(started.person, "ari")
    assert.equal(
      await resolveWriteTarget({ deskRoot: root, person: started.person, segments: ["task.md"] }),
      path.join(root, "desks", "ari", "task.md"),
    )
    await assert.rejects(
      resolveWriteTarget({ deskRoot: root, person: started.person, segments: ["..", "other", "task.md"] }),
      /invalid/u,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const mode of ["global-personal", "project-local", "manual-only"]) {
  for (const policy of [undefined, {}, { write_authority: "workspace" }]) {
    test(`Codex ${mode} rejects person with effective workspace policy: ${JSON.stringify(policy)}`, () => {
      const activationInput = input(mode, policy, { person: "ari" })
      const before = JSON.stringify(activationInput)
      assert.throws(() => materializeCodexActivation(activationInput), (error) => (
        error.code === "authority_invalid" && error.status === "terminal" && error.retryable === false
        && error.expected.write_authority === "person"
        && error.observed.write_authority === "workspace"
      ))
      assert.equal(JSON.stringify(activationInput), before)
    })
  }
}

for (const person of [undefined, null, "", " ", "../other", "/tmp/other", 42]) {
  test(`Codex rejects unenforceable person policy (${JSON.stringify(person)})`, () => {
    assert.throws(() => materializeCodexActivation(input("project-local", {
      write_authority: "person",
    }, { person })), (error) => (
      error.code === "authority_invalid" && error.status === "terminal" && error.retryable === false
    ))
  })
}

test("Codex refuses a declared authority provider unavailable to its standalone startup", () => {
  assert.throws(() => materializeCodexActivation(input("global-personal", {
    root: "workspace", write_authority: "person", lexical: "required",
    semantic: "required", authority_provider: "crew-identity",
  }, { person: "ari", authorityProviders: { "crew-identity": () => ({ mode: "person", person: "ari" }) } })),
  (error) => error.code === "authority_invalid"
    && error.status === "terminal"
    && error.expected.authority_provider === "crew-identity")
})

test("Codex rejects malformed manifest readiness policy instead of generating defaults", () => {
  assert.throws(() => materializeCodexActivation(input("project-local", {
    semantic: "best-effort",
  })), (error) => error.code === "activation_policy_invalid")
})
