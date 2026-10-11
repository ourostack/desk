// A new push to a pull request cancels the runs still going for its older commits, and nothing that must finish is ever cancelled.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { load } = require("js-yaml")
const workflows = path.resolve(fileURLToPath(new URL("../../../../../.github/workflows", import.meta.url)))
const read = (name) => load(readFileSync(path.join(workflows, name), "utf8"))

test("native runtime lanes execute the real installed messaging configuration on every host", () => {
  const job = read("desk-mcp-tests.yml").jobs["desk-runtime-packs"]
  assert.deepEqual(job.strategy.matrix.include.map(item => item.platform).sort(), ["darwin", "linux", "win32"])
  assert.ok(job.steps.some(step => step.run?.includes("native_messaging_host_install.test.js")),
    "source-only builds do not prove the installer publishes configuration the real Go entry accepts")
})

for (const name of ["desk-mcp-tests.yml", "validate-skills.yml"]) {
  test(`${name} cancels superseded pull-request runs and lets main and dispatched runs finish`, () => {
    const { concurrency } = read(name)
    assert.ok(concurrency, "the workflow has a concurrency group")
    // Only a pull-request event cancels. A push to main and a manual dispatch each get a group of their own (the run id), so a later run never cancels one that must finish.
    assert.equal(concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}")
    assert.match(concurrency.group, /github\.event\.pull_request\.number \|\| github\.run_id/u)
    assert.match(concurrency.group, /github\.workflow/u)
  })
}

test("the release workflow is never cancelled by a later run", () => {
  const { concurrency } = read("desk-release.yml")
  assert.notEqual(concurrency?.["cancel-in-progress"], true)
  assert.doesNotMatch(String(concurrency?.["cancel-in-progress"] ?? ""), /true|pull_request/u)
})
