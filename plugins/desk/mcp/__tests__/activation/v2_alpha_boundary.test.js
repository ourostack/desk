import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { materializeCodexActivation } from "../../src/activation/adapters/codex.js"
import { buildCopilotBundle, validateCopilotPackagingContract } from "../../src/activation/copilot-bundle.js"

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"))
}

function inputFor(existingConfig = "", mode = "global-personal") {
  const manifest = JSON.parse(readFileSync(new URL("../../../activation/desk.activation.json", import.meta.url), "utf8"))
  manifest.dependencies = manifest.dependencies.filter((dependency) => !["superpowers", "work-suite"].includes(dependency.id))
  manifest.dependencies.push({
    id: "superpowers",
    kind: "plugin",
    version_range: "6.3.0",
    provenance: { source: "plugins/superpowers/.codex-plugin/plugin.json", package: "ourostack/superpowers" },
    lock: { version: "6.3.0", integrity: "sha256-superpowers-fixture" },
  })
  const worker = manifest.provides.activation_targets.find((target) => target.id === "desk:worker")
  worker.depends_on = [...worker.depends_on.filter((id) => !["superpowers", "work-suite"].includes(id)), "superpowers"]
  return {
    manifest,
    mode,
    existingConfig,
    existingInstructions: "# Operator-owned\nLeave this unchanged.\n",
    pluginRoot: "plugins/desk",
    deskRoot: "~/desk",
    runtimeCacheDir: "~/.cache/ouroboros-skills/desk",
  }
}

const activeWorkSuiteConfigs = [
  '[plugins."work-suite@ourostack"]\nenabled = true\n',
  "[plugins.'work-suite@separate-marketplace']\nenabled = true\n",
  'plugins."work-suite@ourostack".enabled = true\n',
  'plugins = { "work-suite@ourostack" = { enabled = true } }\n',
]

for (const [index, config] of activeWorkSuiteConfigs.entries()) {
  test(`alpha refuses active ambient Work Suite rather than editing operator config: form ${index + 1}`, () => {
    const input = inputFor(config)
    const original = structuredClone(input)
    assert.throws(() => materializeCodexActivation(input), /Work Suite|work-suite/u)
    assert.deepEqual(input, original)
  })
}

for (const [label, config] of [
  ["disabled provider", '[plugins."work-suite@ourostack"]\nenabled = false\n'],
  ["comment", '# plugins."work-suite@ourostack".enabled = true\n'],
  ["unrelated provider", '[plugins."work-suite-tools@ourostack"]\nenabled = true\n'],
]) {
  test(`alpha preserves non-conflicting operator config: ${label}`, () => {
    const result = materializeCodexActivation(inputFor(config))
    assert.ok(result.generatedConfig.startsWith(config))
    assert.ok(result.generatedInstructions.startsWith("# Operator-owned\nLeave this unchanged.\n"))
  })
}

test("unselected legacy dependency cannot enter the selected alpha activation", () => {
  const input = inputFor()
  input.manifest.dependencies.push({
    id: "work-suite",
    kind: "plugin",
    version_range: "4.0.0-alpha.1",
    provenance: { source: "plugins/work-suite/.codex-plugin/plugin.json", package: "ourostack/work-suite" },
    lock: { version: "4.0.0-alpha.1", integrity: "sha256-work-suite-fixture" },
  })
  const result = materializeCodexActivation(input)
  assert.doesNotMatch(result.generatedConfig, /\[plugins\."work-suite@/u)
  assert.match(result.generatedConfig, /\[plugins\."superpowers@/u)
})

test("a selected worker cannot declare both implementation owners", () => {
  const input = inputFor()
  input.manifest.provides.activation_targets.find((target) => target.id === "desk:worker").depends_on.push("work-suite")
  input.manifest.dependencies.push({
    id: "work-suite",
    kind: "plugin",
    version_range: "4.0.0-alpha.1",
    provenance: { source: "plugins/work-suite/.codex-plugin/plugin.json", package: "ourostack/work-suite" },
    lock: { version: "4.0.0-alpha.1", integrity: "sha256-work-suite-fixture" },
  })
  assert.throws(() => materializeCodexActivation(input), /(?:both|multiple|exclusive|overlap|only one|exactly one)/iu)
})

test("manual-only keeps the existing no-worker boundary without rewriting ambient choices", () => {
  const config = activeWorkSuiteConfigs[0]
  const result = materializeCodexActivation(inputFor(config, "manual-only"))
  assert.equal(result.generatedInstructions, "")
  assert.equal(result.generatedActivationConfig, "")
  assert.ok(result.generatedConfig.startsWith(config))
})

test("authored V2 closure (boundary): the real producer builds and validates exactly desk, superpowers, plain-language", () => {
  const activation = readJson("../../../activation/desk.activation.json")
  const freshBundle = buildCopilotBundle({ activation })
  const selectedNames = freshBundle.dependency_closure.map((entry) => entry.id)
  const expected = ["desk", "plain-language", "superpowers"]
  assert.deepEqual([...selectedNames].sort(), expected)
  assert.equal(selectedNames.includes("ponytail-upstream"), false)
  assert.equal(selectedNames.includes("work-suite"), false)

  const deskPlugin = readJson("../../../plugin.json")
  const superpowersPlugin = readJson("../../../../superpowers/plugin.json")
  const plainLanguagePlugin = readJson("../../../../plain-language/plugin.json")
  assert.deepEqual(
    validateCopilotPackagingContract({
      activation, deskPlugin, bundle: freshBundle, superpowersPlugin, plainLanguagePlugin,
    }),
    [],
    "packaging validation must accept the freshly produced three-root closure the real producer builds from the authored manifest",
  )
})

test("ordinary Agency declaration (boundary): desk/agency.json declares only the two generic V2 dependencies", () => {
  const agency = JSON.parse(readFileSync(new URL("../../../agency.json", import.meta.url), "utf8"))
  assert.equal(agency.name, "desk")
  assert.deepEqual(agency.dependencies, [
    "github:ourostack/desk:plugins/superpowers@main",
    "github:ourostack/desk:plugins/plain-language@main",
  ])
})
