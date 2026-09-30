#!/usr/bin/env node
// Re-scores the saved transcripts under --out-dir with the current outcome
// checks. No model calls. Prints one line per run and rewrites nothing.
//
//   node evals/boot-acceptance/rescore.mjs --out-dir <dir>

import { readFileSync, existsSync, readdirSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"

import { buildContext, parseStreamJson } from "./run.mjs"
import { SCENARIOS } from "./scenarios.mjs"

const i = process.argv.indexOf("--out-dir")
if (i < 0 || !process.argv[i + 1]) throw new Error("--out-dir is required")
const outDir = process.argv[i + 1]

for (const scenario of SCENARIOS) {
  const scenarioDir = path.join(outDir, scenario.id)
  if (!existsSync(scenarioDir)) continue
  for (const run of readdirSync(scenarioDir).sort()) {
    const file = path.join(scenarioDir, run, "transcript.jsonl")
    if (!existsSync(file)) continue
    const ctx = buildContext(parseStreamJson(readFileSync(file, "utf8")))
    const denied = path.join(scenarioDir, run, "gh-denied.jsonl")
    ctx.ghDenials = existsSync(denied) ? readFileSync(denied, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
    const result = scenario.check(ctx)
    console.log(`${scenario.id}/${run}: ${result.outcome}`)
    for (const note of result.notes) console.log(`    ${note}`)
  }
}
