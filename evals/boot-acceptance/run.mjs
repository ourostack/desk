#!/usr/bin/env node
// The boot-acceptance harness runner. One command:
//
//   node evals/boot-acceptance/run.mjs --out-dir <dir> [--scenario <id>|all] [--runs 2] [--model haiku]
//
// Everything runs in the foreground, one `claude -p` call at a time, each
// waited on to completion. Nothing is left running in the background, and a
// (scenario, run) whose summary.json already exists under --out-dir is
// skipped, so a run interrupted by a restart resumes by rerunning the same
// command. All output goes under --out-dir; nothing is written to this repo.
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

import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import * as process from "node:process"

import { materializeFixture, breakOriginForFailure, addMissingCloneTask, materializeGreenhouseClone, createIsolatedHome, buildPluginDir, freshTempDir, REAL_HOME } from "./lib.mjs"
import { SCENARIOS, CRITIQUE_SUFFIX, findScenario } from "./scenarios.mjs"
import { buildChildEnv, findRealGh, installGhShim, writeGitConfig } from "./safety.mjs"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const WORKTREE_ROOT = path.resolve(HERE, "..", "..")

const USAGE = `Usage: node evals/boot-acceptance/run.mjs --out-dir <dir> [options]

  --out-dir <dir>       where every output goes (required; outside the repository)
  --scenario <id>|all   default all (${SCENARIOS.map((s) => s.id).join(", ")})
  --runs <n>            runs per scenario, default 2
  --model <name>        default haiku
  --budget <usd>        per-run --max-budget-usd, default 1
  --timeout-min <n>     kill one claude call (and its process group) after n minutes, default 15
  --worktree <checkout> load desk, superpowers and plain-language from that checkout's plugins/
  --plugin-dir <dir>    load exactly this folder of plugins (overrides --worktree)
  --shared-cache <dir>  Desk runtime-dependency pack reuse, default <out-dir>/.shared-runtime-cache
  --keep-fixtures       keep each run's temp fixture desk and HOME
  --force               rerun a run that already has a summary.json
  --dry-run             print the plan and the child environment's variable names, run nothing
  --help                this text
`

export function parseArgs(argv) {
  const args = { scenario: "all", runs: 2, model: "haiku", budget: "1", timeoutMin: 15, keepFixtures: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--scenario") args.scenario = argv[++i]
    else if (a === "--runs") args.runs = Number(argv[++i])
    else if (a === "--out-dir") args.outDir = argv[++i]
    else if (a === "--model") args.model = argv[++i]
    else if (a === "--budget") args.budget = argv[++i]
    else if (a === "--worktree") args.worktree = argv[++i]
    else if (a === "--plugin-dir") args.pluginDir = argv[++i]
    else if (a === "--timeout-min") args.timeoutMin = Number(argv[++i])
    else if (a === "--force") args.force = true
    else if (a === "--dry-run") args.dryRun = true
    else if (a === "--help" || a === "-h") args.help = true
    else if (a === "--keep-fixtures") args.keepFixtures = true
    else if (a === "--shared-cache") args.sharedCache = argv[++i]
    else throw new Error(`unknown arg: ${a}`)
  }
  if (args.help) return args
  if (!args.outDir) throw new Error("--out-dir is required")
  const repoRoot = realpathSync(path.resolve(HERE, "..", ".."))
  const rel = path.relative(repoRoot, realpathThroughExisting(args.outDir))
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error(`--out-dir must be outside the repository (${repoRoot}): transcripts do not belong in it`)
  return args
}

/** Realpath of the nearest existing ancestor plus the rest, so a symlink into the repository is caught before the directory exists. */
export function realpathThroughExisting(target) {
  let current = path.resolve(target)
  const rest = []
  while (!existsSync(current)) {
    rest.unshift(path.basename(current))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.join(realpathSync(current), ...rest)
}

export function parseStreamJson(text) {
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

export function buildContext(events) {
  const toolCalls = []
  const textParts = []
  const assistantTexts = []
  let finalResult = null
  for (const ev of events) {
    if ((ev.type === "assistant" || ev.type === "user") && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input })
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text)
          if (ev.type === "assistant") assistantTexts.push(block.text)
        }
      }
    }
    if (ev.type === "result") finalResult = ev
  }
  const allText = textParts.join("\n\n")
  return {
    toolCalls,
    assistantTexts,
    allText,
    finalResultText: finalResult?.result ?? "",
    ghDenials: [],
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

/** One foreground `claude` call. On timeout the whole process group is killed, so no child outlives the run. */
function runClaude({ args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (d) => { stdout += d })
    child.stderr.on("data", (d) => { stderr += d })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ }
    }, timeoutMs)
    child.on("error", (error) => { clearTimeout(timer); resolve({ status: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut }) })
    child.on("close", (status, signal) => {
      clearTimeout(timer)
      // A group member may have outlived the leader.
      try { process.kill(-child.pid, "SIGKILL") } catch { /* none left */ }
      resolve({ status, signal, stdout, stderr, timedOut })
    })
  })
}

async function runOne({ scenario, runIndex, args, worktreeRoot, sharedCacheDir, outDir }) {
  const runId = `${scenario.id}/run-${runIndex}`
  const summaryPath = path.join(outDir, scenario.id, `run-${runIndex}`, "summary.json")
  if (!args.force && existsSync(summaryPath)) {
    console.log(`[${runId}] already done, skipping (use --force to rerun)`)
    return JSON.parse(readFileSync(summaryPath, "utf8"))
  }
  const runTmp = freshTempDir(`boot-acceptance-${scenario.id}-`)
  const { deskRoot } = materializeFixture(path.join(runTmp, "fixture"))
  if (scenario.inject === "break-origin") breakOriginForFailure(deskRoot)
  if (scenario.inject === "missing-clone") addMissingCloneTask(deskRoot)

  const homeDir = path.join(runTmp, "home")
  createIsolatedHome({ homeDir, sharedCacheDir })
  // The `watering-schedule-api` card records `~/code/greenhouse-irrigation`;
  // `~` is this run's temp HOME, so the clone lives under the temp dir.
  // `valve-firmware` (the `missing-clone` scenario's repo) is never created.
  materializeGreenhouseClone(homeDir)
  const pluginDir = args.pluginDir ? path.resolve(args.pluginDir) : buildPluginDir({ worktreeRoot, targetDir: path.join(runTmp, "plugins") })

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

  // An allowlisted environment, a read-only `gh` shim first on PATH and a
  // run-private git config (see safety.mjs). Nothing is inherited wholesale.
  const shimDir = path.join(runTmp, "shim")
  const ghLog = path.join(runTmp, "gh-denied.jsonl")
  const realGh = findRealGh(process.env.PATH, shimDir)
  if (realGh) installGhShim({ shimDir, realGh, logFile: ghLog })
  const gitConfig = writeGitConfig(homeDir)
  const env = buildChildEnv({ parentEnv: process.env, homeDir, shimDir, gitConfig, ghLog })

  const startedAt = Date.now()
  const result = await runClaude({ args: claudeArgs, cwd: deskRoot, env, timeoutMs: args.timeoutMin * 60 * 1000 })
  const wallMs = Date.now() - startedAt

  const runDir = path.join(outDir, scenario.id, `run-${runIndex}`)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, "transcript.jsonl"), result.stdout ?? "")
  if (result.stderr) writeFileSync(path.join(runDir, "stderr.log"), result.stderr)

  const events = parseStreamJson(result.stdout ?? "")
  const ctx = buildContext(events)
  try {
    ctx.ghDenials = existsSync(ghLog) ? readFileSync(ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
  } catch {
    ctx.ghDenials = []
  }
  if (ctx.ghDenials.length) writeFileSync(path.join(runDir, "gh-denied.jsonl"), ctx.ghDenials.map((d) => JSON.stringify(d)).join("\n") + "\n")
  const checkResult = scenario.check(ctx)
  const critique = extractCritique(ctx)

  const summary = {
    scenario: scenario.id,
    run: runIndex,
    prompt: scenario.prompt,
    injected: scenario.inject,
    spawn_exit_code: result.status,
    spawn_signal: result.signal,
    timed_out: result.timedOut,
    gh_write_attempts_blocked: ctx.ghDenials.length,
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(USAGE); return }
  const worktreeRoot = args.worktree ? path.resolve(args.worktree) : WORKTREE_ROOT
  if (!args.dryRun) mkdirSync(args.outDir, { recursive: true })

  const sharedCacheDir = args.sharedCache ? path.resolve(args.sharedCache) : path.join(args.outDir, ".shared-runtime-cache")

  console.log(`worktree:     ${worktreeRoot}`)
  console.log(`plugins:      ${args.pluginDir ? path.resolve(args.pluginDir) : `desk, superpowers, plain-language from ${worktreeRoot}/plugins`}`)
  console.log(`real HOME:    ${REAL_HOME} (only Library/Keychains is ever read from it)`)
  console.log(`shared cache: ${sharedCacheDir} (Desk runtime-dependency pack reuse only, no operator content)`)
  console.log(`out-dir:      ${args.outDir}`)
  console.log("")

  const scenarios = args.scenario === "all" ? SCENARIOS : [findScenario(args.scenario)]
  if (args.dryRun) {
    const sample = buildChildEnv({ parentEnv: process.env, homeDir: "<temp HOME>", shimDir: "<temp shim dir>", gitConfig: "<temp .gitconfig>", ghLog: "<temp log>" })
    console.log(`dry run: would run ${scenarios.map((s) => s.id).join(", ")} x ${args.runs} run(s) on model ${args.model}`)
    console.log(`child environment variables: ${Object.keys(sample).sort().join(", ")}`)
    console.log("nothing was run")
    return
  }
  const allSummaries = []
  for (const scenario of scenarios) {
    for (let runIndex = 1; runIndex <= args.runs; runIndex++) {
      allSummaries.push(await runOne({ scenario, runIndex, args, worktreeRoot, sharedCacheDir, outDir: args.outDir }))
    }
  }

  writeFileSync(path.join(args.outDir, "all-summaries.json"), JSON.stringify(allSummaries, null, 2))
  console.log(`\nWrote ${allSummaries.length} run summaries under ${args.outDir}`)
  console.log(`Next: node ${path.join(HERE, "summarize.mjs")} --out-dir ${args.outDir}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(path.resolve(process.argv[1]))) {
  main().catch((error) => {
    console.error(error.message)
    globalThis.process.exitCode = 1
  })
}
