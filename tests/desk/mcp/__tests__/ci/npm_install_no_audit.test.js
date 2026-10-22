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
const installs = /\bnpm\s+(?:ci|install|i)\b/u
const auditOff = (env) => String(env?.npm_config_audit) === "false"

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
          if (line.includes("--no-audit") || auditOff(step.env) || auditOff(job.env) || auditOff(workflow.env)) continue
          offenders.push(`${file} ${jobName} step ${step.name ?? index}: ${line.trim()}`)
        }
      }
    }
  }
  assert.ok(seen > 0, "the guard must find the workflows' npm installs")
  assert.deepEqual(offenders, [])
})

test("the hosted image's npm installs run without the advisory audit", () => {
  const lines = readFileSync(path.join(root, "hosted/Dockerfile"), "utf8").split("\n").filter(line => /^RUN\b/u.test(line) && installs.test(line))
  assert.ok(lines.length > 0, "the guard must find the image's npm installs")
  assert.deepEqual(lines.filter(line => !line.includes("--no-audit")), [])
})
