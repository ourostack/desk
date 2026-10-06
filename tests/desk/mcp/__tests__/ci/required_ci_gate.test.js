// Main's ruleset (.github/rulesets/main-requires-ci.json) requires three checks. A required check that never reports blocks a
// pull request forever, so each one must come from a workflow that runs on every pull request, and the "CI gate" job must wait
// for every other job in its workflow.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
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
    assert.equal(on.pull_request?.paths ?? null, null, `${file} has no path filter on pull requests`)
    assert.equal(on.pull_request?.["paths-ignore"] ?? null, null, `${file} has no paths-ignore on pull requests`)
    for (const job of Object.values(jobs)) {
      assert.equal(job.if === undefined || /always\(\)|!cancelled\(\)/u.test(job.if), true, `${job.name} is not skipped by a condition`)
      names.set(job.name, file)
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

test("the ruleset lets only a deploy key bypass it, because GitHub refuses the workflow token as a bypass actor", () => {
  assert.deepEqual(ruleset.bypass_actors, [{ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }])
  assert.deepEqual(ruleset.conditions.ref_name.include, ["~DEFAULT_BRANCH"])
  assert.equal(ruleset.enforcement, "active")
})
