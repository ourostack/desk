// Main's ruleset (.github/rulesets/main-requires-ci.json, a copy of the live ruleset) requires three checks. A required check that never reports blocks a
// pull request forever, so each one must come from a workflow that runs on every pull request, and the "CI gate" job must wait
// for every other job in its workflow. The heavy tier (the Windows suite and the rest) runs on main, not on pull requests, so it is not required there.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { load } = require("js-yaml")
const repo = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const workflow = (name) => load(readFileSync(path.join(repo, ".github/workflows", name), "utf8"))
const ruleset = JSON.parse(readFileSync(path.join(repo, ".github/rulesets/main-requires-ci.json"), "utf8"))
const required = ruleset.rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks

test("every required check is a plain job name in a workflow that runs on every pull request", () => {
  const names = new Map()
  const requiredNames = new Set(required.map((check) => check.context))
  for (const file of ["desk-mcp-tests.yml", "validate-skills.yml"]) {
    const { on, jobs } = workflow(file)
    assert.ok("pull_request" in on, `${file} runs on pull requests`)
    // Any of these can leave a pull request without the check, which would then block it for good.
    for (const limit of ["paths", "paths-ignore", "branches", "branches-ignore", "types"]) {
      assert.equal(on.pull_request?.[limit] ?? null, null, `${file} has no ${limit} limit on pull requests`)
    }
    for (const job of Object.values(jobs)) {
      // Other jobs may skip (the CI gate decides whether a skip was allowed); a required one never may.
      if (requiredNames.has(job.name)) assert.equal(job.if === undefined || job.if === "${{ always() }}", true, `${job.name} is not skipped by a condition`)
      names.set(job.name, file)
    }
  }
  // A required check must be able to fail the pull request, and no other job anywhere may report under the same name.
  for (const file of readdirSync(path.join(repo, ".github/workflows")).filter((name) => name.endsWith(".yml"))) {
    for (const [id, job] of Object.entries(workflow(file).jobs)) {
      if (requiredNames.has(job.name)) {
        assert.equal(names.get(job.name), file, `${file} job ${id} must not reuse the required check name ${job.name}`)
        assert.equal(job["continue-on-error"], undefined, `${job.name} must not continue on error`)
      }
    }
  }
  assert.deepEqual(required.map((check) => check.context).sort(), ["CI gate", "Claude Code plugin load", "Validate skills"])
  for (const { context, integration_id: source } of required) {
    assert.ok(names.has(context), `${context} is a job name`)
    assert.equal(source, 15368, `${context} must come from GitHub Actions`)
  }
})

test("the CI gate job waits for every other job in its workflow, except the main-health report that waits for it", () => {
  const { jobs } = workflow("desk-mcp-tests.yml")
  const gate = jobs["ci-gate"]
  assert.equal(gate.name, "CI gate")
  const after = Object.keys(jobs).filter((id) => [jobs[id].needs ?? []].flat().includes("ci-gate"))
  assert.deepEqual(after, ["report-main-health"])
  assert.deepEqual([...gate.needs].sort(), Object.keys(jobs).filter((id) => id !== "ci-gate" && !after.includes(id)).sort())
  assert.match(gate.if, /always\(\)/u, "it runs after a failed or skipped job, which would otherwise count as passing")
  assert.deepEqual(gate.permissions, {})
})

// Runs the gate's own shell step against a made-up `needs` result, the way its Linux runner would. Windows has no reliable bash on PATH
// (it may be the WSL launcher), and the gate never runs there, so these two tests skip on Windows.
const hasJq = process.platform !== "win32" && spawnSync("jq", ["--version"]).status === 0
const jobIds = ["blackbox", "browser", "crew-member-binding", "desk-mcp-coverage-shards", "offline-eval-tests", "release-dry-run", "desk-mcp-tests", "desk-runtime-packs", "desk-native-windows", "unused-code"]
function gateVerdict({ heavy, code, evals, quick = "success", results = {} }) {
  const needs = { "quick-checks": { result: quick, outputs: quick === "success" ? { code: String(code), evals: String(evals) } : {} } }
  for (const id of jobIds) needs[id] = { result: results[id] ?? "success", outputs: {} }
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-ci-gate-"))
  try {
    const script = path.join(dir, "gate.sh")
    writeFileSync(script, workflow("desk-mcp-tests.yml").jobs["ci-gate"].steps[0].run)
    return spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, RESULTS: JSON.stringify(needs), HEAVY: String(heavy) } }).status
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const skipped = (...ids) => Object.fromEntries(ids.map((id) => [id, "skipped"]))
const heavyJobs = ["release-dry-run", "desk-runtime-packs", "desk-native-windows"]

test("the CI gate lets a pull request skip only the heavy tier, the offline evals it cannot affect, and everything for a docs-only change", { skip: !hasJq && "needs bash and jq, as on the gate's Linux runner" }, () => {
  assert.equal(gateVerdict({ heavy: false, code: true, evals: false, results: skipped(...heavyJobs, "offline-eval-tests") }), 0)
  assert.equal(gateVerdict({ heavy: false, code: false, evals: false, results: skipped(...jobIds) }), 0, "docs only")
  assert.equal(gateVerdict({ heavy: true, code: false, evals: false, results: skipped(...jobIds.filter((id) => id !== "desk-runtime-packs")) }), 0, "a docs-only dispatch still builds the packs")
  assert.equal(gateVerdict({ heavy: true, code: false, evals: false, results: skipped(...jobIds) }), 1, "the packs never skip on main")
  assert.equal(gateVerdict({ heavy: true, code: true, evals: true }), 0, "main runs everything")
})

test("the CI gate fails for a job that had to run but was skipped, failed or was cancelled, and for a failed Quick checks", { skip: !hasJq && "needs bash and jq, as on the gate's Linux runner" }, () => {
  assert.equal(gateVerdict({ heavy: false, code: true, evals: false, results: skipped(...heavyJobs, "offline-eval-tests", "desk-mcp-coverage-shards") }), 1)
  assert.equal(gateVerdict({ heavy: false, code: true, evals: true, results: skipped(...heavyJobs, "offline-eval-tests") }), 1)
  assert.equal(gateVerdict({ heavy: true, code: true, evals: true, results: skipped("release-dry-run") }), 1, "main never skips the heavy tier")
  assert.equal(gateVerdict({ heavy: false, code: true, evals: false, results: { ...skipped(...heavyJobs, "offline-eval-tests"), browser: "failure" } }), 1)
  assert.equal(gateVerdict({ heavy: true, code: true, evals: true, results: { browser: "cancelled" } }), 1)
  assert.equal(gateVerdict({ heavy: false, code: true, evals: true, quick: "failure", results: skipped(...jobIds) }), 1)
})

test("only a deploy key may push past the ruleset, and a repository admin may bypass it only through a pull request", () => {
  // GitHub refuses the workflow token as a bypass actor, so the release push uses a deploy key. The admin role (id 5) can repair a
  // broken gate by merging a pull request, while nobody can push to main directly.
  assert.deepEqual(ruleset.bypass_actors, [
    { actor_id: null, actor_type: "DeployKey", bypass_mode: "always" },
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" },
  ])
  assert.deepEqual(ruleset.conditions.ref_name.include, ["~DEFAULT_BRANCH"])
  assert.equal(ruleset.enforcement, "active")
})

test("the release push job reads the deploy key from the release environment, in a step of its own", () => {
  const { jobs } = workflow("desk-release.yml")
  assert.equal(jobs.push.environment, "release")
  const holders = jobs.push.steps.filter((step) => JSON.stringify(step.env ?? {}).includes("DESK_RELEASE_DEPLOY_KEY"))
  assert.deepEqual(holders.map((step) => step.name), ["Write the deploy key"])
  const push = jobs.push.steps.find((step) => step.name === "Verify and push the release")
  assert.match(push.run, /trap 'rm -f "\$key"' EXIT/u)
  assert.equal(push.env.DEPLOY_KEY, undefined)
})
