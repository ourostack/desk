// Turns the raw data `record.mjs` saved into the small, generic fixtures the relay replay tests read. Run it by hand.
//
//   node sanitize.mjs merge    --raw <raw-dir> --rules <rules.json> --out <fixture.json>
//   node sanitize.mjs dispatch --raw <raw-dir> --rules <rules.json> --out <fixture.json> [--hours 24]
//
// The rules file stays on the machine that records; it holds the real check names and the replacement each gets:
//   { "rename": [["real prefix", "generic prefix"]], "requiredChecks": ["generic name or pattern"], "requireMainWorkflowGreen": true, "skippedPasses": true }
// A check whose name matches none of the rules becomes `check-N`, keeping a `(${{ ... }})` template tail so a skipped matrix job still looks like one.
// Everything else is dropped: no repository, pull request, branch, commit or person survives, and every time is a number of seconds
// before the merge (merge replay) or after the window started (dispatch replay).
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const [mode, ...rest] = process.argv.slice(2)
const { values } = parseArgs({ args: rest, options: { raw: { type: "string" }, rules: { type: "string" }, out: { type: "string" }, hours: { type: "string", default: "24" } } })
const read = (name) => JSON.parse(readFileSync(path.join(values.raw, name), "utf8"))
const rules = JSON.parse(readFileSync(values.rules, "utf8"))
const seconds = (iso, base) => (iso ? Math.round((Date.parse(iso) - base) / 1000) : null)

const aliases = new Map()
function generic(name) {
  for (const [from, to] of rules.rename ?? []) if (name.startsWith(from)) return to + name.slice(from.length)
  if (!aliases.has(name)) aliases.set(name, `check-${aliases.size + 1}`)
  return aliases.get(name) + (name.includes("${{") ? " (${{ matrix.x }})" : "")
}

function mergeFixture() {
  const pulls = read("pulls.json")
  const mainRuns = read("main-runs.json")
  const out = pulls.map((pull, index) => {
    const base = Date.parse(pull.mergedAt)
    const checks = [...pull.all].sort((a, b) => a.id - b.id).map((run, order) => ({ id: order + 1, name: generic(run.name), status: run.status, conclusion: run.conclusion, started: seconds(run.started_at, base), completed: seconds(run.completed_at, base), source: run.id }))
    const ids = new Map(checks.map((check) => [check.source, check.id]))
    const latest = pull.latest.map((run) => ids.get(run.id)).filter(Boolean)
    const main = mainRuns
      .filter((run) => Date.parse(run.updated_at) <= base)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 6)
      .map((run, order) => ({ id: 6 - order, status: run.status, conclusion: run.conclusion, created: seconds(run.created_at, base), completed: seconds(run.updated_at, base) }))
    return { name: `pull-${String(index + 1).padStart(2, "0")}`, draft: pull.draft, labelled: pull.labels.length > 0, checks: checks.map(({ source, ...kept }) => kept), latest, main }
  })
  return { requiredChecks: rules.requiredChecks, requireMainWorkflowGreen: rules.requireMainWorkflowGreen ?? false, skippedPasses: rules.skippedPasses ?? false, pulls: out }
}

function dispatchFixture() {
  const runs = read("watch-runs.json").filter((run) => run.status === "completed")
  const hours = Number(values.hours)
  const times = runs.map((run) => Date.parse(run.created_at)).sort((a, b) => a - b)
  // The busiest window: the one that holds the most runs.
  let best = { start: times[0], count: 0 }
  for (const start of times) {
    const count = times.filter((time) => time >= start && time < start + hours * 3_600_000).length
    if (count > best.count) best = { start, count }
  }
  const inWindow = runs.filter((run) => Date.parse(run.created_at) >= best.start - hours * 3_600_000 && Date.parse(run.updated_at) < best.start + hours * 3_600_000)
  const heads = new Map()
  const sorted = [...inWindow].sort((a, b) => a.id - b.id)
  const out = sorted.map((run, order) => {
    if (!heads.has(run.head_sha)) heads.set(run.head_sha, `head-${heads.size + 1}`)
    return { id: order + 1, head: heads.get(run.head_sha), attempt: run.run_attempt ?? 1, status: run.status, conclusion: run.conclusion, created: seconds(run.created_at, best.start), completed: seconds(run.updated_at, best.start) }
  })
  return { windowSeconds: hours * 3600, settleSeconds: rules.settleSeconds ?? 60, runs: out }
}

writeFileSync(values.out, `${JSON.stringify(mode === "merge" ? mergeFixture() : dispatchFixture())}\n`)
