#!/usr/bin/env node
// Re-scores the saved transcripts under --out-dir with the current outcome
// checks. No model calls. Prints one line per run and rewrites nothing.
// A run directory holds the scenario turn's transcript.jsonl and, when the
// critique turn ran, critique-transcript.jsonl (see run.mjs); the scenario
// checks judge the first only, the safety checks read both.
//
//   node evals/boot-acceptance/rescore.mjs --out-dir <dir> [--host claude|copilot]
//
// `--host` names the CLI that wrote the transcripts (default claude); a Copilot
// transcript is read through the same normalizer the run used.

import { existsSync, readdirSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"
import { fileURLToPath } from "node:url"

import { CRITIQUE_UNAVAILABLE, HOSTS, loadRunContext, scoreRun } from "./run.mjs"
import { SCENARIOS } from "./scenarios.mjs"

/** `[{ id, outcome, notes }]` for every saved run under `outDir`, in scenario then run order. */
export function rescoreAll(outDir, host = "claude") {
  const rows = []
  for (const scenario of SCENARIOS) {
    const scenarioDir = path.join(outDir, scenario.id)
    if (!existsSync(scenarioDir)) continue
    for (const run of readdirSync(scenarioDir).sort()) {
      if (!existsSync(path.join(scenarioDir, run, "transcript.jsonl"))) continue
      const ctx = loadRunContext(path.join(scenarioDir, run), host)
      const result = scoreRun(scenario, ctx, host)
      // A critique turn that hit a limit or an error is reported as unavailable, never as a critique.
      rows.push({ id: `${scenario.id}/${run}`, outcome: result.outcome, notes: ctx.critiqueIsError === true ? [CRITIQUE_UNAVAILABLE, ...result.notes] : result.notes })
    }
  }
  return rows
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--out-dir")
  if (i < 0 || !process.argv[i + 1]) throw new Error("--out-dir is required")
  const h = process.argv.indexOf("--host")
  const host = h < 0 ? "claude" : process.argv[h + 1]
  if (!HOSTS.includes(host)) throw new Error(`--host must be one of ${HOSTS.join(", ")}, got ${JSON.stringify(host)}`)
  for (const row of rescoreAll(process.argv[i + 1], host)) {
    console.log(`${row.id}: ${row.outcome}`)
    for (const note of row.notes) console.log(`    ${note}`)
  }
}
