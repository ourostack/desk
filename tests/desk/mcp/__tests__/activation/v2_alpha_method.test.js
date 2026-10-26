import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { buildCopilotBundle, validateCopilotPackagingContract } from "../../../../../tools/desk-build/activation/copilot-bundle.js"

const repoRoot = new URL("../../../../../", import.meta.url)
const readJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, repoRoot), "utf8"))
const methodIds = new Set(["work-suite", "superpowers"])
const bundlePath = "plugins/desk/activation/copilot-root.flattened-bundle.json"

function activationFor(method) {
  const activation = readJson("plugins/desk/activation/desk.activation.json")
  const version = method === "superpowers" ? "6.3.0" : "4.0.0-alpha.1"
  activation.dependencies = activation.dependencies.filter((dependency) => !methodIds.has(dependency.id))
  activation.dependencies.push({
    id: method,
    kind: "plugin",
    version_range: version,
    provenance: { source: `plugins/${method}/.claude-plugin/plugin.json`, package: `ourostack/${method}` },
    lock: { version, integrity: `sha256-${method}-fixture` },
  })
  for (const target of activation.provides.activation_targets) {
    target.depends_on = [...target.depends_on.filter((id) => !methodIds.has(id)), method]
  }
  return activation
}

function packagingInput(method) {
  const activation = activationFor(method)
  const deskPlugin = readJson("plugins/desk/plugin.json")
  const dependencies = deskPlugin.activation.copilot.dependencies
  for (const id of methodIds) delete dependencies[id]
  dependencies[method] = {
    path: `../${method}`,
    version: activation.dependencies.at(-1).lock.version,
    resolution: "flattened",
    bundleMetadata: bundlePath,
  }
  const bundle = readJson(bundlePath)
  bundle.dependency_closure = bundle.dependency_closure.filter((entry) => !methodIds.has(entry.id))
  bundle.dependency_closure.push({
    id: method,
    version: activation.dependencies.at(-1).lock.version,
    plugin: `plugins/${method}/plugin.json`,
    skills: `plugins/${method}/skills/`,
  })
  return {
    activation,
    deskPlugin,
    bundle,
    workSuitePlugin: { name: "work-suite", version: "4.0.0-alpha.1" },
    superpowersPlugin: { name: "superpowers", version: "6.3.0" },
    plainLanguagePlugin: readJson("plugins/plain-language/plugin.json"),
  }
}

test("alpha Copilot bundle consumes Superpowers rather than Work Suite", () => {
  const activation = activationFor("superpowers")
  // An available legacy provider is not selected by desk:worker. This exposes
  // wrong selection as a value mismatch instead of an unrelated missing-lock error.
  activation.dependencies.push(activationFor("work-suite").dependencies.find((entry) => entry.id === "work-suite"))
  const bundle = buildCopilotBundle({ activation })
  const methods = bundle.dependency_closure.filter((entry) => methodIds.has(entry.id))
  assert.deepEqual(methods, [{
    id: "superpowers",
    version: "6.3.0",
    plugin: "plugins/superpowers/plugin.json",
    skills: "plugins/superpowers/skills/",
  }])
  assert.equal(JSON.stringify(bundle).includes("work-suite"), false)
})

test("legacy Copilot manifest-shape characterization selects Work Suite", () => {
  const bundle = buildCopilotBundle({ activation: activationFor("work-suite") })
  assert.deepEqual(bundle.dependency_closure.filter((entry) => methodIds.has(entry.id)).map((entry) => entry.id), ["work-suite"])
  assert.deepEqual(validateCopilotPackagingContract(packagingInput("work-suite")), [])
})

test("alpha Copilot packaging accepts the selected pinned provider", () => {
  assert.deepEqual(validateCopilotPackagingContract(packagingInput("superpowers")), [])
})

test("alpha Copilot packaging rejects a mismatched Superpowers version", () => {
  const input = packagingInput("superpowers")
  const baselineErrors = validateCopilotPackagingContract(input)
  input.superpowersPlugin.version = "6.2.0"
  const addedErrors = validateCopilotPackagingContract(input).filter((error) => !baselineErrors.includes(error))
  assert.deepEqual(addedErrors, [
    "Copilot root Superpowers version must match activation lock 6.3.0",
  ], "the single version mutation must add its own diagnostic, independent of unsupported-alpha preconditions")
})

test("alpha Copilot packaging rejects a second lifecycle owner in the closure", () => {
  const input = packagingInput("superpowers")
  const baselineErrors = validateCopilotPackagingContract(input)
  input.bundle.dependency_closure.push({ id: "work-suite", version: "4.0.0-alpha.1" })
  const addedErrors = validateCopilotPackagingContract(input).filter((error) => !baselineErrors.includes(error))
  assert.deepEqual(addedErrors, [
    "Copilot alpha bundle must not include Work Suite as a second lifecycle owner",
  ], "the single closure mutation must add its own diagnostic, independent of unsupported-alpha preconditions")
})

test("authored V2 closure (method): the real producer builds and validates exactly desk, superpowers, plain-language", () => {
  const activation = readJson("plugins/desk/activation/desk.activation.json")
  const freshBundle = buildCopilotBundle({ activation })
  const selectedNames = freshBundle.dependency_closure.map((entry) => entry.id)
  const expected = ["desk", "plain-language", "superpowers"]
  assert.deepEqual([...selectedNames].sort(), expected)
  assert.equal(selectedNames.includes("ponytail-upstream"), false)
  assert.equal(selectedNames.includes("work-suite"), false)

  const deskPlugin = readJson("plugins/desk/plugin.json")
  const superpowersPlugin = readJson("plugins/superpowers/plugin.json")
  const plainLanguagePlugin = readJson("plugins/plain-language/plugin.json")
  assert.deepEqual(
    validateCopilotPackagingContract({
      activation, deskPlugin, bundle: freshBundle, superpowersPlugin, plainLanguagePlugin,
    }),
    [],
    "packaging validation must accept the freshly produced three-root closure the real producer builds from the authored manifest",
  )
})

test("ordinary Agency declaration (method): desk/agency.json declares only the two generic V2 dependencies", () => {
  const agency = readJson("plugins/desk/agency.json")
  assert.equal(agency.name, "desk")
  assert.deepEqual(agency.dependencies, [
    "github:ourostack/desk:plugins/superpowers@main",
    "github:ourostack/desk:plugins/plain-language@main",
  ])
})
