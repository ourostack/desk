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

test("the runtime packs are built for every shipped target", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  assert.deepEqual(jobs["desk-runtime-packs"].strategy.matrix.include.map(item => item.target).sort(), [
    "linux-x64-node-127",
    "linux-x64-node-137",
    "linux-x64-node-147",
    "win32-x64-node-137",
    "win32-x64-node-147",
  ])
})

// macOS runners are few (5 at once, shared account-wide), so every macOS check shares one job and one runner.
test("every macOS check runs in one job on a supported standard Apple-silicon image, including both Darwin runtime packs", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  const mac = jobs["macos-checks"]
  assert.ok(["macos-latest", "macos-15", "macos-26"].includes(mac.runs-on ?? mac["runs-on"]))
  assert.equal(mac.needs, undefined, "it waits for nothing, so the pull request's macOS time starts at once")
  const packs = mac.steps.filter(step => step.uses === "./.github/actions/build-runtime-pack").map(step => step.with)
  assert.deepEqual(packs.map(pack => pack.target), ["darwin-arm64-node-127", "darwin-arm64-node-137"])
  assert.deepEqual(packs.map(pack => [pack.node, pack.node_abi, pack.arch, pack.platform]), [["22.23.2", "127", "arm64", "darwin"], ["24.18.0", "137", "arm64", "darwin"]])
  assert.ok(mac.steps.some(step => /factory\/os_protect\.test\.js/u.test(step.run ?? "")), "native ACL checks")
  assert.ok(mac.steps.some(step => step.env?.DESK_BROWSER_REAL === "1"), "the real browser check")
  assert.ok(mac.steps.some(step => /runtime\/crew_member_end_to_end\.test\.js/u.test(step.run ?? "")), "the Crew member-binding tests")
  for (const id of ["desk-runtime-packs", "browser", "crew-member-binding", "blackbox"]) {
    const job = jobs[id]
    const runners = [job["runs-on"], ...(job.strategy?.matrix?.os ?? []), ...(job.strategy?.matrix?.include ?? []).flatMap(item => [item.os, item.runner])].filter(Boolean)
    assert.ok(!runners.some(runner => String(runner).startsWith("macos")), `${id} takes no macOS runner of its own`)
  }
})

// Every leg runs on every event: a pull request runs everything main runs (AGENTS.md, "CI tiers"), so a matrix names its legs outright.
function legs(job) {
  const matrix = job.strategy.matrix
  assert.equal(matrix.exclude, undefined, "no leg is dropped for a pull request")
  return Array.isArray(matrix.include) ? matrix.include.map((item) => item.os) : matrix.os
}

test("the real browser check runs on Linux and Windows here, and on macOS in the macOS checks job", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  assert.deepEqual([...jobs.browser.strategy.matrix.os].sort(), ["ubuntu-latest", "windows-latest"])
  assert.ok(jobs["ci-gate"].needs.includes("browser"))
})

test("the Crew member-binding tests run on Linux and Windows here (macOS in the macOS checks job), Windows with CRLF checkouts, and gate main", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  const job = jobs["crew-member-binding"]
  assert.deepEqual(legs(job, "push").sort(), ["ubuntu-latest", "windows-latest"])
  assert.ok(job.steps.some((step) => step.if === "runner.os == 'Windows'" && step.run === "git config --global core.autocrlf true"))
  const run = job.steps.find((step) => step.name === "Run the member-binding tests").run
  assert.match(run, /runtime\/crew_member_end_to_end\.test\.js/u)
  assert.match(run, /ci\/windows_hide\.test\.js/u)
  assert.ok(jobs["ci-gate"].needs.includes("crew-member-binding"))
})

for (const name of ["desk-mcp-tests.yml", "validate-skills.yml", "desk-windows-suite.yml", "hosted-tests.yml"]) {
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

// One tier (AGENTS.md, "CI tiers"): a pull request runs every leg and job main runs.
test("a pull request runs every leg, so the release can trust its checks", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  for (const [id, all] of [
    ["browser", ["ubuntu-latest", "windows-latest"]],
    ["crew-member-binding", ["ubuntu-latest", "windows-latest"]],
    ["blackbox", ["ubuntu-latest", "windows-latest"]],
  ]) {
    assert.equal(jobs[id].needs, "quick-checks", id)
    assert.deepEqual([...legs(jobs[id])].sort(), all, `${id} runs every leg on a pull request and on main`)
  }
  assert.deepEqual(jobs["release-dry-run"].strategy.matrix.stage, ["auto", "rc", "stable"])
  assert.equal(jobs["release-dry-run"].strategy.matrix.exclude, undefined, "a pull request runs every release stage")
})

test("no job is skipped for a pull request except by what the change can affect, and every job but the packs and the macOS checks waits for Quick checks", () => {
  const jobs = read("desk-mcp-tests.yml").jobs
  assert.equal(jobs["desk-native-windows"].if, "needs.quick-checks.outputs.code == 'true'")
  assert.ok(jobs["ci-gate"].needs.includes("macos-checks"))
  // The macOS job decides its own scope (it waits for no job), and every test step in it carries that condition.
  const scopeStep = jobs["macos-checks"].steps.find((step) => step.id === "scope")
  assert.equal(scopeStep.env.BASE, "${{ github.event_name == 'pull_request' && 'HEAD^1' || '' }}")
  assert.match(scopeStep.run, /changed-scope\.mjs --outside "\$BASE" docs\/ SETUP\.md LICENSE/u)
  for (const step of jobs["macos-checks"].steps.filter((s) => /os_protect|DESK_BROWSER|crew_member|npm ci/u.test(JSON.stringify(s)) && !s.uses)) {
    assert.match(step.if, /steps\.scope\.outputs\.code == 'true'/u, step.name)
  }
  // The runtime packs wait for nothing, so a failing check elsewhere never stops pack production (production_runtime_pack.test.js).
  assert.equal(jobs["desk-runtime-packs"].if, undefined)
  assert.equal(jobs["desk-runtime-packs"].needs, undefined)
  for (const id of ["browser", "crew-member-binding", "blackbox", "desk-mcp-coverage-shards", "unused-code", "release-dry-run"]) {
    assert.equal(jobs[id].if, "needs.quick-checks.outputs.code == 'true'", id)
  }
  assert.equal(jobs["offline-eval-tests"].if, "needs.quick-checks.outputs.evals == 'true'")
  // Only a pull request narrows: main and dispatches have no base, so everything runs there.
  const scope = jobs["quick-checks"].steps.find((step) => step.id === "scope")
  assert.equal(scope.env.BASE, "${{ github.event_name == 'pull_request' && 'HEAD^1' || '' }}")
})

test("the Windows suite runs on every pull request and every push to main, and a red main report follows a push", () => {
  const workflow = read("desk-windows-suite.yml")
  assert.ok("pull_request" in workflow.on)
  assert.deepEqual(workflow.on.push.branches, ["main"])
  assert.ok("workflow_dispatch" in workflow.on)
  const report = workflow.jobs["report-main-health"]
  assert.equal(report.if, "${{ always() && github.event_name == 'push' && github.ref == 'refs/heads/main' }}")
  assert.deepEqual(report.permissions, { contents: "read", issues: "write" })
  assert.match(read("desk-mcp-tests.yml").jobs["report-main-health"].steps.at(-1).run, /report-main-health\.sh "CI gate"/u)
})
