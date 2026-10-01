#!/usr/bin/env node
// Re-scores the saved transcripts under --out-dir with the current outcome
// checks. No model calls. Prints one line per run and rewrites nothing.
// A run directory holds the scenario turn's transcript.jsonl and, when the
// critique turn ran, critique-transcript.jsonl (see run.mjs); the scenario
// checks judge the first only, the safety checks read both.
//
//   node evals/boot-acceptance/rescore.mjs --out-dir <dir>

import { existsSync, readdirSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"
import { fileURLToPath } from "node:url"

import { loadRunContext } from "./run.mjs"
import { SCENARIOS } from "./scenarios.mjs"

/** `[{ id, outcome, notes }]` for every saved run under `outDir`, in scenario then run order. */
export function rescoreAll(outDir) {
  const rows = []
  for (const scenario of SCENARIOS) {
    const scenarioDir = path.join(outDir, scenario.id)
    if (!existsSync(scenarioDir)) continue
    for (const run of readdirSync(scenarioDir).sort()) {
      if (!existsSync(path.join(scenarioDir, run, "transcript.jsonl"))) continue
      const result = scenario.check(loadRunContext(path.join(scenarioDir, run)))
      rows.push({ id: `${scenario.id}/${run}`, outcome: result.outcome, notes: result.notes })
    }
  }
  return rows
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--out-dir")
  if (i < 0 || !process.argv[i + 1]) throw new Error("--out-dir is required")
  for (const row of rescoreAll(process.argv[i + 1])) {
    console.log(`${row.id}: ${row.outcome}`)
    for (const note of row.notes) console.log(`    ${note}`)
  }
}
