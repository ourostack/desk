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

test("the runtime packs are built for every platform", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  assert.deepEqual(jobs["desk-runtime-packs"].strategy.matrix.include.map(item => item.platform).sort(), ["darwin", "linux", "win32"])
})

test("the real browser check runs on Linux, Windows and macOS", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  assert.deepEqual([...jobs.browser.strategy.matrix.os].sort(), ["macos-latest", "ubuntu-latest", "windows-latest"])
  assert.ok(jobs["ci-gate"].needs.includes("browser"))
})

test("the Crew member-binding tests run on Linux, macOS and Windows, Windows with CRLF checkouts, and gate main", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  const job = jobs["crew-member-binding"]
  assert.deepEqual(job.strategy.matrix.include.map((item) => item.os).sort(), ["macos-latest", "ubuntu-latest", "windows-latest"])
  assert.ok(job.steps.some((step) => step.if === "runner.os == 'Windows'" && step.run === "git config --global core.autocrlf true"))
  const run = job.steps.find((step) => step.name === "Run the member-binding tests").run
  assert.match(run, /runtime\/crew_member_end_to_end\.test\.js/u)
  assert.match(run, /ci\/windows_hide\.test\.js/u)
  assert.ok(jobs["ci-gate"].needs.includes("crew-member-binding"))
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
