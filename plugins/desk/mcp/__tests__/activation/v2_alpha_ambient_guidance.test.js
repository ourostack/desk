import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { materializeCodexActivation } from "../../src/activation/adapters/codex.js"

test("selected alpha guidance preserves legacy preferences and leaves the compatibility mapping to its redirect skill", () => {
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
  const existingInstructions = [
    "# Synthetic standing preferences",
    "Use Work Suite for engineering. Invoke work-planner before work-doer.",
    "Historical evidence: [old result](archive/work-suite-result.md).",
    "Preserve my writing preferences.",
    "",
  ].join("\n")
  const input = {
    manifest,
    mode: "global-personal",
    existingConfig: "",
    existingInstructions,
    pluginRoot: "plugins/desk",
    deskRoot: "~/desk",
    runtimeCacheDir: "~/.cache/ouroboros-skills/desk",
  }
  const result = materializeCodexActivation(input)
  assert.ok(result.generatedInstructions.startsWith(existingInstructions))
  assert.equal(input.existingInstructions, existingInstructions)
  const selectedInstructions = result.generatedInstructions.slice(existingInstructions.length)
  assert.match(selectedInstructions, /desk:using-superpowers-with-desk/u)
  assert.doesNotMatch(selectedInstructions, /Use Work Suite skills/u)
  // The legacy Work Suite mapping belongs to the retired-name redirect skill, which the host's skill listing
  // surfaces; the owned block does not restate it.
  assert.doesNotMatch(selectedInstructions, /legacy.*Work Suite|Work Suite.*legacy/iu)
  const redirect = readFileSync(new URL("../../../skills/superpowers-integration/SKILL.md", import.meta.url), "utf8")
  assert.match(redirect.split("---", 3)[1], /Work Suite capability mapping for unchanged standing instructions/u)
})
