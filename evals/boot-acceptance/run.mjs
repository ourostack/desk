#!/usr/bin/env node
// The boot-acceptance harness runner. One command:
//
//   node evals/boot-acceptance/run.mjs --out-dir <dir> [--scenario <id>|all] [--runs 2] [--model haiku]
//
// For each (scenario, run) pair: builds a fresh synthetic fixture desk with
// its own local bare-repo origin, an isolated HOME (see lib.mjs), and a
// scratch plugin-dir holding Desk + its declared dependencies from this
// worktree; runs `claude -p` headless against it; parses the stream-json
// transcript; runs the scenario's transcript-only outcome check; and writes
// one summary.json + the raw transcript per run. Never touches the real
// operator desk, never pushes to GitHub, never opens a PR.
//
// See README.md for the isolation verification this relies on.

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"

import { materializeFixture, breakOriginForFailure, createIsolatedHome, buildPluginDir, freshTempDir, REAL_HOME } from "./lib.mjs"
import { SCENARIOS, CRITIQUE_SUFFIX, findScenario } from "./scenarios.mjs"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const WORKTREE_ROOT = path.resolve(HERE, "..", "..")

function parseArgs(argv) {
  const args = { scenario: "all", runs: 2, model: "haiku", budget: "1", keepFixtures: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--scenario") args.scenario = argv[++i]
    else if (a === "--runs") args.runs = Number(argv[++i])
    else if (a === "--out-dir") args.outDir = argv[++i]
    else if (a === "--model") args.model = argv[++i]
    else if (a === "--budget") args.budget = argv[++i]
    else if (a === "--worktree") args.worktree = argv[++i]
    else if (a === "--keep-fixtures") args.keepFixtures = true
    else if (a === "--shared-cache") args.sharedCache = argv[++i]
    else throw new Error(`unknown arg: ${a}`)
  }
  if (!args.outDir) throw new Error("--out-dir is required")
  return args
}

function parseStreamJson(text) {
  const events = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A non-JSON line (shouldn't happen with --output-format stream-json) is kept out of the event list but not fatal.
    }
  }
  return events
}

function buildContext(events) {
  const toolCalls = []
  const textParts = []
  let finalResult = null
  for (const ev of events) {
    if ((ev.type === "assistant" || ev.type === "user") && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input })
        if (block.type === "text" && typeof block.text === "string") textParts.push(block.text)
      }
    }
    if (ev.type === "result") finalResult = ev
  }
  const allText = textParts.join("\n\n")
  return {
    toolCalls,
    allText,
    finalResultText: finalResult?.result ?? "",
    isError: finalResult?.is_error ?? null,
    durationMs: finalResult?.duration_ms ?? null,
    durationApiMs: finalResult?.duration_api_ms ?? null,
    totalCostUsd: finalResult?.total_cost_usd ?? null,
    numTurns: finalResult?.num_turns ?? null,
    subtype: finalResult?.subtype ?? null,
  }
}

/** The critique is asked as the last part of the one combined prompt; the model's final answer is the best available extraction. */
function extractCritique(ctx) {
  if (ctx.finalResultText && ctx.finalResultText.trim()) return ctx.finalResultText.trim()
  return ctx.allText.trim()
}

function runOne({ scenario, runIndex, args, pluginDir, sharedCacheDir, outDir }) {
  const runId = `${scenario.id}/run-${runIndex}`
  const runTmp = freshTempDir(`boot-acceptance-${scenario.id}-`)
  const { deskRoot } = materializeFixture(path.join(runTmp, "fixture"))
  if (scenario.inject === "break-origin") breakOriginForFailure(deskRoot)

  const homeDir = path.join(runTmp, "home")
  createIsolatedHome({ homeDir, sharedCacheDir })

  const prompt = `${scenario.prompt}${CRITIQUE_SUFFIX}`
  const claudeArgs = [
    "-p", prompt,
    "--model", args.model,
    "--output-format", "stream-json",
    "--verbose",
    "--max-budget-usd", args.budget,
    "--no-session-persistence",
    "--permission-mode", "bypassPermissions",
    "--plugin-dir", pluginDir,
  ]

  // Inherit the parent shell's env (auth on this host is macOS-Keychain-based
  // and a from-scratch env broke it -- "Not logged in" even with the
  // Keychain symlink in place, confirmed empirically) and override only
  // HOME. $DESK and CLAUDE_PROJECT_DIR are unset in the parent already, so
  // nothing here forces a root: cwd below is what Claude Code sets
  // CLAUDE_PROJECT_DIR to, and Desk's own host-project-root check
  // (isDeskWorkspace) is what binds it to the fixture -- see README.md's
  // isolation-verification section. Deleting $DESK/$CLAUDE_PROJECT_DIR
  // defensively in case a future host environment sets them.
  const env = { ...process.env, HOME: homeDir }
  delete env.DESK
  delete env.CLAUDE_PROJECT_DIR
  delete env.CLAUDE_PLUGIN_DATA

  const startedAt = Date.now()
  const result = spawnSync("claude", claudeArgs, {
    cwd: deskRoot,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  })
  const wallMs = Date.now() - startedAt

  const runDir = path.join(outDir, scenario.id, `run-${runIndex}`)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, "transcript.jsonl"), result.stdout ?? "")
  if (result.stderr) writeFileSync(path.join(runDir, "stderr.log"), result.stderr)

  const events = parseStreamJson(result.stdout ?? "")
  const ctx = buildContext(events)
  const checkResult = scenario.check(ctx)
  const critique = extractCritique(ctx)

  const summary = {
    scenario: scenario.id,
    run: runIndex,
    prompt: scenario.prompt,
    injected: scenario.inject,
    spawn_exit_code: result.status,
    spawn_signal: result.signal,
    wall_ms: wallMs,
    duration_ms: ctx.durationMs,
    duration_api_ms: ctx.durationApiMs,
    total_cost_usd: ctx.totalCostUsd,
    num_turns: ctx.numTurns,
    subtype: ctx.subtype,
    is_error: ctx.isError,
    tool_call_count: ctx.toolCalls.length,
    tool_call_names: ctx.toolCalls.map((t) => t.name),
    outcome: checkResult.outcome,
    outcome_notes: checkResult.notes,
    critique,
  }
  writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2))

  if (!args.keepFixtures) rmSync(runTmp, { recursive: true, force: true })

  console.log(`[${runId}] outcome=${summary.outcome} tools=${summary.tool_call_count} wall_ms=${wallMs} cost=$${summary.total_cost_usd ?? "?"}`)
  return summary
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const worktreeRoot = args.worktree ? path.resolve(args.worktree) : WORKTREE_ROOT
  mkdirSync(args.outDir, { recursive: true })

  const pluginDirParent = freshTempDir("boot-acceptance-plugins-")
  const pluginDir = buildPluginDir({ worktreeRoot, targetDir: pluginDirParent })
  const sharedCacheDir = args.sharedCache ? path.resolve(args.sharedCache) : path.join(args.outDir, ".shared-runtime-cache")

  console.log(`worktree:     ${worktreeRoot}`)
  console.log(`plugin-dir:   ${pluginDir}`)
  console.log(`real HOME:    ${REAL_HOME} (only Library/Keychains is ever read from it)`)
  console.log(`shared cache: ${sharedCacheDir} (Desk runtime-dependency pack reuse only, no operator content)`)
  console.log(`out-dir:      ${args.outDir}`)
  console.log("")

  const scenarios = args.scenario === "all" ? SCENARIOS : [findScenario(args.scenario)]
  const allSummaries = []
  for (const scenario of scenarios) {
    for (let runIndex = 1; runIndex <= args.runs; runIndex++) {
      allSummaries.push(runOne({ scenario, runIndex, args, pluginDir, sharedCacheDir, outDir: args.outDir }))
    }
  }

  writeFileSync(path.join(args.outDir, "all-summaries.json"), JSON.stringify(allSummaries, null, 2))
  rmSync(pluginDirParent, { recursive: true, force: true })
  console.log(`\nWrote ${allSummaries.length} run summaries under ${args.outDir}`)
  console.log(`Next: node ${path.join(HERE, "summarize.mjs")} --out-dir ${args.outDir}`)
}

main()
