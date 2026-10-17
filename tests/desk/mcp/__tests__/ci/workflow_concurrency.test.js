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

test("integration gates install the broker's committed dependencies before testing it", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  assert.deepEqual(jobs["desk-runtime-packs"].strategy.matrix.include.map(item => item.platform).sort(), ["darwin", "linux", "win32"])
  for (const name of ["desk-mcp-coverage-shards", "release-dry-run", "desk-runtime-packs"]) {
    assert.ok(jobs[name].steps.some(step => step["working-directory"] === "plugins/desk/mcp" &&
      step.run?.includes("npm ci --prefix ../browser-context-broker")), `${name} must install the broker lock, not rely on local node_modules`)
  }
})

test("every release and suite entry installs the locked maintained browser test input", () => {
  const install = "npm ci --ignore-scripts --prefix tests/desk/mcp/__tests__/launch/fixtures/maintained-playwright"
  for (const [workflow, names] of [
    ["desk-mcp-tests.yml", ["desk-mcp-coverage-shards", "release-dry-run", "desk-native-messaging"]],
    ["desk-windows-suite.yml", ["windows-suite"]],
    ["desk-release.yml", ["build"]],
  ]) {
    const { jobs } = read(workflow)
    for (const name of names) {
      const steps = jobs[name].steps
      const setup = steps.findIndex(step => step.run === install)
      const consumer = steps.findIndex(step => /(?:test:coverage|build-and-check-release|Run the suite|native_messaging_install)/u.test([step.name, step.run].join("\n")))
      assert.ok(setup >= 0 && setup < consumer, `${workflow}/${name} must install the locked public input before its test consumer`)
    }
  }
})

test("actual Windows private and native capsule acceptance use the standard-user boundary", () => {
  const { jobs } = read("desk-mcp-tests.yml")
  for (const name of ["private-browser-lifecycle", "desk-native-messaging"]) {
    const protectedSteps = jobs[name].steps.filter(step => /browser_private_package|native_messaging_install/u.test(step.run || ""))
    assert.equal(protectedSteps.length, 2, `${name} must keep both actual POSIX and Windows acceptance`)
    assert.equal(protectedSteps[0].if, "runner.os != 'Windows'")
    assert.equal(protectedSteps[1].if, "runner.os == 'Windows'")
    assert.match(protectedSteps[1].run, /run-as-standard-user\.ps1/u)
    assert.doesNotMatch(protectedSteps[1].run, /elevated|skip|--only/iu)
  }
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
