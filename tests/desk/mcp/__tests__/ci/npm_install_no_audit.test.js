// CI's installs skip npm's advisory audit. The audit only prints a report, gates nothing, and when the registry's audit
// endpoint stalls it holds every `npm ci` for about seven minutes (runs 39712439432 and 39712436219), past the
// hosted gateway job's ten-minute limit.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { load } = require("js-yaml")
const root = path.resolve(fileURLToPath(new URL("../../../../../", import.meta.url)))
const workflows = path.join(root, ".github/workflows")
// Options may come before the command, as in `npm --prefix dir ci`.
const installs = /\bnpm(?:\s+--?[\w-]+(?:[= ][^\s-]\S*)?)*\s+(?:ci|install|i|it|add|install-test)\b/u
// GitHub applies the most specific env that sets a variable, so a step or job can turn the audit back on.
const auditOff = (...levels) => String(levels.find(env => env && "npm_config_audit" in env)?.npm_config_audit) === "false"

test("every npm install in CI runs without the advisory audit", () => {
  const offenders = []
  let seen = 0
  for (const file of readdirSync(workflows).filter(name => /\.ya?ml$/u.test(name))) {
    const workflow = load(readFileSync(path.join(workflows, file), "utf8"))
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        for (const line of String(step.run ?? "").split("\n")) {
          if (!installs.test(line)) continue
          seen += 1
          if (line.includes("--no-audit") || auditOff(step.env, job.env, workflow.env)) continue
          offenders.push(`${file} ${jobName} step ${step.name ?? index}: ${line.trim()}`)
        }
      }
    }
  }
  assert.ok(seen > 0, "the guard must find the workflows' npm installs")
  assert.deepEqual(offenders, [])
})

test("the guard recognizes each install form and the most specific env", () => {
  for (const line of ["npm ci", "npm install --global x", "npm i x", "npm --prefix dir ci", "npm add x", "npm it"]) assert.ok(installs.test(line), line)
  for (const line of ["npm run test:coverage -- --shard 1/12", "npm test", "npx azurite-table"]) assert.ok(!installs.test(line), line)
  assert.equal(auditOff(undefined, { npm_config_audit: "true" }, { npm_config_audit: "false" }), false)
  assert.equal(auditOff({ npm_config_audit: false }, undefined, { npm_config_audit: "true" }), true)
  assert.equal(auditOff(undefined, undefined, undefined), false)
})

test("the hosted image's npm installs run without the advisory audit", () => {
  const lines = readFileSync(path.join(root, "hosted/Dockerfile"), "utf8").split("\n").filter(line => /^RUN\b/u.test(line) && installs.test(line))
  assert.ok(lines.length > 0, "the guard must find the image's npm installs")
  assert.deepEqual(lines.filter(line => !line.includes("--no-audit")), [])
})
