import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { buildCopilotBundle, validateCopilotPackagingContract } from "../../../../../plugins/desk/mcp/src/activation/copilot-bundle.js"

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"))
}

test("authored V2 closure (boundary): the real producer builds and validates exactly desk, superpowers, plain-language", () => {
  const activation = readJson("../../../../../plugins/desk/activation/desk.activation.json")
  const freshBundle = buildCopilotBundle({ activation })
  const selectedNames = freshBundle.dependency_closure.map((entry) => entry.id)
  const expected = ["desk", "plain-language", "superpowers"]
  assert.deepEqual([...selectedNames].sort(), expected)
  assert.equal(selectedNames.includes("ponytail-upstream"), false)
  assert.equal(selectedNames.includes("work-suite"), false)

  const deskPlugin = readJson("../../../../../plugins/desk/plugin.json")
  const superpowersPlugin = readJson("../../../../../plugins/superpowers/plugin.json")
  const plainLanguagePlugin = readJson("../../../../../plugins/plain-language/plugin.json")
  assert.deepEqual(
    validateCopilotPackagingContract({
      activation, deskPlugin, bundle: freshBundle, superpowersPlugin, plainLanguagePlugin,
    }),
    [],
    "packaging validation must accept the freshly produced three-root closure the real producer builds from the authored manifest",
  )
})

test("ordinary Agency declaration (boundary): desk/agency.json declares only the two generic V2 dependencies", () => {
  const agency = JSON.parse(readFileSync(new URL("../../../../../plugins/desk/agency.json", import.meta.url), "utf8"))
  assert.equal(agency.name, "desk")
  assert.deepEqual(agency.dependencies, [
    "github:ourostack/desk:plugins/superpowers@main",
    "github:ourostack/desk:plugins/plain-language@main",
  ])
})

test("authored V2 closure (boundary): active worker source drops Ponytail invocation while historical mentions remain", () => {
  const workerSource = readFileSync(new URL("../../../../../plugins/desk/agents/worker.agent.md", import.meta.url), "utf8")
  assert.doesNotMatch(workerSource, /apply `ponytail`/iu)
  assert.doesNotMatch(workerSource, /ponytail-upstream.*declared dep/iu)

  const changelog = readFileSync(new URL("../../../../../plugins/desk/CHANGELOG.md", import.meta.url), "utf8")
  assert.match(changelog, /ponytail/iu, "historical CHANGELOG mentions must not be indiscriminately rejected")
})
