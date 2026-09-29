#!/usr/bin/env node
// Reads every run summary.json under --out-dir and writes SUMMARY.md: the
// per-scenario outcome table, a mechanical keyword-theme tally over the
// critiques (a first pass only -- real clustering needs a human or a judge
// model reading the actual text, which is what the harness's own report
// does on top of this), and every critique verbatim so a reader can check
// the tally against the source.
//
//   node evals/boot-acceptance/summarize.mjs --out-dir <dir>

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir") args.outDir = argv[++i]
  }
  if (!args.outDir) throw new Error("--out-dir is required")
  return args
}

function loadSummaries(outDir) {
  const combined = path.join(outDir, "all-summaries.json")
  if (existsSync(combined)) return JSON.parse(readFileSync(combined, "utf8"))
  const summaries = []
  for (const scenarioDir of readdirSync(outDir, { withFileTypes: true })) {
    if (!scenarioDir.isDirectory()) continue
    const scenarioPath = path.join(outDir, scenarioDir.name)
    for (const runDir of readdirSync(scenarioPath, { withFileTypes: true })) {
      const summaryPath = path.join(scenarioPath, runDir.name, "summary.json")
      if (existsSync(summaryPath)) summaries.push(JSON.parse(readFileSync(summaryPath, "utf8")))
    }
  }
  return summaries
}

// A mechanical first pass only -- counts a theme as "raised" once per run
// when any of its keywords appear in that run's critique text.
const THEMES = [
  { id: "noisy-or-verbose", label: "Boot output is noisy/verbose", keywords: ["noisy", "noise", "verbose", "too much output", "wall of text", "overwhelming"] },
  { id: "slow", label: "Boot felt slow", keywords: ["slow", "took a while", "latency", "lag", "waited"] },
  { id: "tool-discovery", label: "Had to search/guess for the right tool", keywords: ["toolsearch", "had to search", "wasn't sure which tool", "guess", "which tool"] },
  { id: "unclear-next-step", label: "Next step / task state was unclear", keywords: ["unclear", "wasn't clear", "confus", "ambiguous", "didn't know what to do next"] },
  { id: "sync-or-git", label: "Sync / git friction", keywords: ["git pull", "sync failed", "origin", "rebase", "could not sync", "remote"] },
  { id: "mcp-friction", label: "Desk MCP tool friction", keywords: ["mcp", "desk_status", "tool call failed", "connection failed", "desk-browser"] },
  { id: "push-account", label: "Push-account / repo access confusion", keywords: ["push access", "wrong account", "can't push", "cannot push", "permission denied", "not a collaborator"] },
  { id: "fine", label: "Reported boot as genuinely fine / no complaints", keywords: ["genuinely fine", "nothing to complain", "no complaints", "worked well", "was fine", "no real issues"] },
]

function tally(summaries) {
  const counts = new Map(THEMES.map((t) => [t.id, { theme: t, runs: [] }]))
  for (const s of summaries) {
    const text = (s.critique ?? "").toLowerCase()
    for (const theme of THEMES) {
      if (theme.keywords.some((k) => text.includes(k))) {
        counts.get(theme.id).runs.push(`${s.scenario}/run-${s.run}`)
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.runs.length - a.runs.length)
}

function outcomeTable(summaries) {
  const rows = summaries
    .slice()
    .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.run - b.run)
    .map((s) => `| ${s.scenario} | ${s.run} | ${s.outcome} | ${s.tool_call_count} | ${s.wall_ms ?? "?"} | ${s.total_cost_usd ?? "?"} | ${(s.outcome_notes ?? []).join("; ")} |`)
  return [
    "| Scenario | Run | Outcome | Tool calls | Wall ms | Cost USD | Notes |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n")
}

function critiqueDump(summaries) {
  const byScenario = new Map()
  for (const s of summaries) {
    if (!byScenario.has(s.scenario)) byScenario.set(s.scenario, [])
    byScenario.get(s.scenario).push(s)
  }
  const sections = []
  for (const [scenario, runs] of byScenario) {
    sections.push(`### ${scenario}\n`)
    for (const s of runs.sort((a, b) => a.run - b.run)) {
      sections.push(`**run-${s.run}** (outcome: ${s.outcome})\n\n> ${(s.critique ?? "").split("\n").join("\n> ")}\n`)
    }
  }
  return sections.join("\n")
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const summaries = loadSummaries(args.outDir)
  const themes = tally(summaries)

  const lines = []
  lines.push("# Boot-acceptance summary\n")
  lines.push(`${summaries.length} runs.\n`)
  lines.push("## Outcome table\n")
  lines.push(outcomeTable(summaries))
  lines.push("\n## Mechanical critique-theme tally (keyword pass; read the verbatim critiques below for the real clustering)\n")
  lines.push("| Theme | Runs raising it | Which runs |")
  lines.push("|---|---|---|")
  for (const { theme, runs } of themes) {
    if (runs.length === 0) continue
    lines.push(`| ${theme.label} | ${runs.length}/${summaries.length} | ${runs.join(", ")} |`)
  }
  lines.push("\n## Verbatim critiques\n")
  lines.push(critiqueDump(summaries))

  const outPath = path.join(args.outDir, "SUMMARY.md")
  writeFileSync(outPath, lines.join("\n"))
  console.log(`Wrote ${outPath}`)
}

main()
