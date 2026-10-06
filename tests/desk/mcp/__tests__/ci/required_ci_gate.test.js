// Main's ruleset (.github/rulesets/main-requires-ci.json) requires three checks. A required check that never reports blocks a
// pull request forever, so each one must come from a workflow that runs on every pull request, and the "CI gate" job must wait
// for every other job in its workflow.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readdirSync, readFileSync } from "node:fs"
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
  for (const file of ["desk-mcp-tests.yml", "validate-skills.yml"]) {
    const { on, jobs } = workflow(file)
    assert.ok("pull_request" in on, `${file} runs on pull requests`)
    // Any of these can leave a pull request without the check, which would then block it for good.
    for (const limit of ["paths", "paths-ignore", "branches", "branches-ignore", "types"]) {
      assert.equal(on.pull_request?.[limit] ?? null, null, `${file} has no ${limit} limit on pull requests`)
    }
    for (const job of Object.values(jobs)) {
      assert.equal(job.if === undefined || /always\(\)|!cancelled\(\)/u.test(job.if), true, `${job.name} is not skipped by a condition`)
      names.set(job.name, file)
    }
  }
  // A required check must be able to fail the pull request, and no other job anywhere may report under the same name.
  const requiredNames = new Set(required.map((check) => check.context))
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

test("the CI gate job waits for every other job in its workflow and fails unless each succeeded", () => {
  const { jobs } = workflow("desk-mcp-tests.yml")
  const gate = jobs["ci-gate"]
  assert.equal(gate.name, "CI gate")
  assert.deepEqual([...gate.needs].sort(), Object.keys(jobs).filter((id) => id !== "ci-gate").sort())
  assert.match(gate.if, /always\(\)/u, "it runs after a failed or skipped job, which would otherwise count as passing")
  assert.deepEqual(gate.permissions, {})
  assert.match(gate.steps[0].run, /all\(\.\[\]; \.result == "success"\)/u)
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
  const holders = jobs.push.steps.filter((step) => JSON.stringify(step).includes("DESK_RELEASE_DEPLOY_KEY"))
  assert.deepEqual(holders.map((step) => step.name), ["Write the deploy key"])
  const push = jobs.push.steps.find((step) => step.name === "Verify and push the release")
  assert.match(push.run, /trap 'rm -f "\$key"' EXIT/u)
  assert.equal(push.env.DEPLOY_KEY, undefined)
})
