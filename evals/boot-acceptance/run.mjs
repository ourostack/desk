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
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import * as process from "node:process"

import { cleanupRunDir, materializeFixture, breakOriginForFailure, addMissingCloneTask, materializeGreenhouseClone, createIsolatedHome, claudeCredentialsLink, buildPluginDir, sourcePaths, freshTempDir, REAL_HOME } from "./lib.mjs"
import { SCENARIOS, CRITIQUE_PROMPT, findScenario } from "./scenarios.mjs"
import { discountCancelledStart, gateReport, readCopilotSessionEvents, reduceCopilotEvents } from "./gates.mjs"
import { buildChildEnv, countTokenLeaks, findRealGh, installGhShim, redactSecrets, writeGitConfig } from "./safety.mjs"
import { COPILOT_DEFAULT_MODEL, COPILOT_TOKEN_VAR, GH_TOKEN_WARNING, META_TOOLS, authFailureProblem, compactCopilotTranscript, copilotFlags, copilotResumeArgs, findCopilotBinary, installCopilotPlugins, installedBootScript, notApplicableFor, parseCopilotTranscript, resolveCopilotAuth, shareCopilotPackageCache, writeCopilotProfile } from "./copilot.mjs"

export const HOSTS = ["claude", "copilot"]

const HERE = path.dirname(new URL(import.meta.url).pathname)
const WORKTREE_ROOT = path.resolve(HERE, "..", "..")

const USAGE = `Usage: node evals/boot-acceptance/run.mjs --out-dir <dir> [options]

  --out-dir <dir>       where every output goes (required; outside the repository)
  --scenario <id>|all   default all (${SCENARIOS.map((s) => s.id).join(", ")})
  --runs <n>            runs per scenario, default 2
  --host claude|copilot which agent CLI runs the scenarios, default claude (copilot: see README "Copilot host")
  --model <name>        default haiku on claude, ${COPILOT_DEFAULT_MODEL} on copilot
  --budget <usd>        per-run --max-budget-usd, default 1 (claude only; copilot has no dollar cap)
  --timeout-min <n>     kill one claude call (and its process group) after n minutes, default 15
  --worktree <checkout> load desk, superpowers and plain-language from that checkout's plugins/
  --plugin-dir <dir>    load exactly this folder of plugins (overrides --worktree)
  --copilot-bind project|env  how the Desk MCP server finds the fixture desk on copilot: "project" (default) leaves it to the session folder, which only Desk's boot script and hook read, as for a user who just opens the desk; "env" sets DESK, the workaround (see README)
  --copilot-use-gh-token  copilot only: when COPILOT_GITHUB_TOKEN is unset, use the gh keychain token of Copilot's signed-in account. That is a full OAuth token (repo, workflow); a process listing in the run can read it. Default: refuse
  --shared-cache <dir>  Desk runtime-dependency pack reuse, default <out-dir>/.shared-runtime-cache
  --keep-fixtures       keep each run's temp fixture desk and HOME
  --outside-desk        open the session in a plain folder that is no desk (no binding), to check that no Desk boot pointer appears there; the scenario's own checks do not apply
  --force               rerun a run that already has a summary.json
  --dry-run             print the plan and the child environment's variable names, run nothing
  --help                this text
`

export function parseArgs(argv) {
  const args = { scenario: "all", runs: 2, host: "claude", model: undefined, budget: "1", timeoutMin: 15, keepFixtures: false, copilotBind: "project", copilotUseGhToken: false, outsideDesk: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--scenario") args.scenario = argv[++i]
    else if (a === "--runs") args.runs = Number(argv[++i])
    else if (a === "--out-dir") args.outDir = argv[++i]
    else if (a === "--host") args.host = argv[++i]
    else if (a === "--model") args.model = argv[++i]
    else if (a === "--budget") args.budget = argv[++i]
    else if (a === "--worktree") args.worktree = argv[++i]
    else if (a === "--plugin-dir") args.pluginDir = argv[++i]
    else if (a === "--timeout-min") args.timeoutMin = Number(argv[++i])
    else if (a === "--force") args.force = true
    else if (a === "--dry-run") args.dryRun = true
    else if (a === "--help" || a === "-h") args.help = true
    else if (a === "--keep-fixtures") args.keepFixtures = true
    else if (a === "--copilot-bind") args.copilotBind = argv[++i]
    else if (a === "--copilot-use-gh-token") args.copilotUseGhToken = true
    else if (a === "--outside-desk") args.outsideDesk = true
    else if (a === "--shared-cache") args.sharedCache = argv[++i]
    else throw new Error(`unknown arg: ${a}`)
  }
  if (args.help) return args
  if (!HOSTS.includes(args.host)) throw new Error(`--host must be one of ${HOSTS.join(", ")}, got ${JSON.stringify(args.host)}`)
  if (!["env", "project"].includes(args.copilotBind)) throw new Error(`--copilot-bind must be env or project, got ${JSON.stringify(args.copilotBind)}`)
  args.model ??= args.host === "copilot" ? COPILOT_DEFAULT_MODEL : "haiku"
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

/** The transcript text of one turn as stream-json events, whichever host wrote it. */
export function parseTranscript(text, host = "claude") {
  return host === "copilot" ? parseCopilotTranscript(text) : parseStreamJson(text)
}

/** What a run records when its critique turn ended in an error (a usage limit, a crash) instead of answering. */
export const CRITIQUE_UNAVAILABLE = "critique: unavailable (error)"

export function buildContext(events) {
  const toolCalls = []
  const callsById = new Map()
  const textParts = []
  const assistantTexts = []
  let finalResult = null
  let sessionId = null
  for (const ev of events) {
    if (sessionId === null && typeof ev.session_id === "string") sessionId = ev.session_id
    if ((ev.type === "assistant" || ev.type === "user") && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block.type === "tool_use") {
          const call = { name: block.name, input: block.input }
          toolCalls.push(call)
          if (typeof block.id === "string") callsById.set(block.id, call)
        }
        // A tool's answer is kept on its call (`result`, `isError`), so a check can tell a refused move from an accepted one.
        if (block.type === "tool_result" && callsById.has(block.tool_use_id)) {
          const call = callsById.get(block.tool_use_id)
          call.result = Array.isArray(block.content) ? block.content.map((part) => part?.text ?? "").join("\n") : String(block.content ?? "")
          call.isError = block.is_error === true
        }
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
    sessionId,
    // Token-shaped strings (or markers where one was already redacted) anywhere in the events; run.mjs adds stderr and the critique turn.
    tokenLeaks: countTokenLeaks(JSON.stringify(events)),
    critiqueToolCalls: [],
    isError: finalResult?.is_error ?? null,
    durationMs: finalResult?.duration_ms ?? null,
    durationApiMs: finalResult?.duration_api_ms ?? null,
    totalCostUsd: finalResult?.total_cost_usd ?? null,
    premiumRequests: finalResult?.premium_requests ?? null,
    numTurns: finalResult?.num_turns ?? null,
    subtype: finalResult?.subtype ?? null,
  }
}

/**
 * Both turns of one run. Turn 1 is the scenario prompt; turn 2 is the critique, sent into the same session with `--resume <session id>` and the same isolated environment, so turn 1's final reply is the agent's real answer to the operator and the critique is a separate field. `claude` is the foreground runner (`runClaude`; a test passes a fake). Token-shaped strings are redacted from every output before anything is parsed or saved; the markers left behind are counted in `ctx.tokenLeaks`.
 * `host` picks how a turn's output is read and how the critique resumes the session; `secrets` are exact values (the Copilot credential) redacted from every output whatever shape they take, on top of the token-shape redaction.
 * Returns { ctx, critique, critiqueSkipped, turns: [{ stdout, stderr, timedOut, status, signal }] }.
 */
export async function runTurns({ claude, prompt, critiquePrompt, flags, cwd, env, timeoutMs, host = "claude", secrets = [] }) {
  const turn = async (args) => {
    const raw = await claude({ args, cwd, env, timeoutMs })
    return { ...raw, stdout: redactSecrets(raw.stdout ?? "", secrets), stderr: redactSecrets(raw.stderr ?? "", secrets) }
  }
  const resume = host === "copilot" ? copilotResumeArgs : (id) => ["--resume", id]
  const first = await turn(["-p", prompt, ...flags])
  const ctx = buildContext(parseTranscript(first.stdout, host))
  ctx.tokenLeaks += countTokenLeaks(first.stderr)
  const turns = [first]
  let critique = ""
  let critiqueSkipped = null
  if (first.timedOut) critiqueSkipped = "the scenario turn timed out"
  else if (ctx.sessionId === null) critiqueSkipped = "the scenario turn's transcript has no session id to resume"
  else {
    const second = await turn(["-p", critiquePrompt, ...resume(ctx.sessionId), ...flags])
    turns.push(second)
    const critiqueCtx = buildContext(parseTranscript(second.stdout, host))
    critique = (critiqueCtx.finalResultText.trim() || critiqueCtx.allText.trim())
    ctx.critiqueToolCalls = critiqueCtx.toolCalls
    ctx.critiqueCostUsd = critiqueCtx.totalCostUsd
    ctx.tokenLeaks += critiqueCtx.tokenLeaks + countTokenLeaks(second.stderr)
    // A limit or an error is no critique: its message is not saved as one.
    if (critiqueCtx.isError === true) [critique, critiqueSkipped] = ["", CRITIQUE_UNAVAILABLE]
    else if (critique === "") critiqueSkipped = "the critique turn returned no text"
  }
  return { ctx, critique, critiqueSkipped, turns }
}

/**
 * The scoring context of one saved run directory, with no model call: the scenario turn's transcript, the critique turn's tool calls and token markers from `critique-transcript.jsonl` when it exists, token markers in `stderr.log`, and the gh shim's denials. Used by rescore.mjs.
 */
export function loadRunContext(runDir, host = "claude") {
  const read = (name) => (existsSync(path.join(runDir, name)) ? readFileSync(path.join(runDir, name), "utf8") : null)
  const ctx = buildContext(parseTranscript(read("transcript.jsonl") ?? "", host))
  ctx.host = host
  const critiqueText = read("critique-transcript.jsonl")
  if (critiqueText !== null) {
    const critiqueCtx = buildContext(parseTranscript(critiqueText, host))
    ctx.critiqueToolCalls = critiqueCtx.toolCalls
    ctx.critiqueIsError = critiqueCtx.isError === true
    ctx.tokenLeaks += critiqueCtx.tokenLeaks
  }
  ctx.tokenLeaks += countTokenLeaks(read("stderr.log") ?? "")
  const denied = read("gh-denied.jsonl")
  ctx.ghDenials = denied === null ? [] : denied.split("\n").filter(Boolean).map((l) => JSON.parse(l))
  return ctx
}

/**
 * The scenario's verdict for a run on `host`, plus what that host cannot judge: each such check is listed in `notApplicable` and as an `N/A on <host>: ...`
 * note, never as a pass. On Claude Code the list is empty and the verdict is the scenario's own.
 */
export function scoreRun(scenario, ctx, host = "claude") {
  const result = scenario.check(ctx)
  const notApplicable = notApplicableFor(host)
  return { ...result, notes: [...result.notes, ...notApplicable.map((item) => `N/A on ${host}: ${item}`)], notApplicable }
}

/** One foreground call of the host's CLI. On timeout the whole process group is killed, so no child outlives the run. */
function runHost(binary) {
  return (call) => runBinary({ binary, ...call })
}

function runBinary({ binary, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
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

/** What the shim gives the real `gh`: the operator's own HOME and `gh` folder, and none of the run's redirected locations. */
export function realGhEnv(parentEnv = process.env) {
  const config = parentEnv.GH_CONFIG_DIR || path.join(parentEnv.XDG_CONFIG_HOME || path.join(REAL_HOME, ".config"), "gh")
  return { set: { HOME: REAL_HOME, GH_CONFIG_DIR: config }, unset: ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GH_SHIM_LOG"] }
}

/**
 * One run, and the removal of its temp folder whatever happens in it: a failed install, a refused credential or a crash in a check still removes the folder (unless `--keep-fixtures`). `cleanupRunDir` removes a symlink (the shared caches) and never what it points at.
 */
async function runOne(options) {
  const { scenario, runIndex, args, outDir } = options
  const runId = `${scenario.id}/run-${runIndex}`
  const summaryPath = path.join(outDir, scenario.id, `run-${runIndex}`, "summary.json")
  if (!args.force && existsSync(summaryPath)) {
    console.log(`[${runId}] already done, skipping (use --force to rerun)`)
    return JSON.parse(readFileSync(summaryPath, "utf8"))
  }
  const runTmp = freshTempDir(`boot-acceptance-${scenario.id}-`)
  try {
    return await runInTemp({ ...options, runTmp, runId })
  } finally {
    if (!args.keepFixtures) await cleanupRunDir(runTmp)
  }
}

async function runInTemp({ scenario, runIndex, args, worktreeRoot, sharedCacheDir, outDir, auth, runTmp, runId }) {
  const { deskRoot } = materializeFixture(path.join(runTmp, "fixture"))
  if (scenario.inject === "break-origin") breakOriginForFailure(deskRoot)
  if (scenario.inject === "missing-clone") addMissingCloneTask(deskRoot)

  const homeDir = path.join(runTmp, "home")
  // `--outside-desk`: the session opens in an ordinary folder under the run's temp dir, with no `_meta`/`_archive` and no saved binding anywhere.
  const sessionFolder = args.outsideDesk ? path.join(runTmp, "plain-project") : deskRoot
  if (args.outsideDesk) mkdirSync(sessionFolder, { recursive: true })
  // The login keychain, and Claude Code's credentials file in its profile folder when it exists (2.1.290 and later), are linked (never copied) into the run's HOME only for Claude Code without `CLAUDE_CODE_OAUTH_TOKEN` (its sign-in reads them); `gh` reaches the operator's login through the shim, never through this HOME.
  const keychain = args.host === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN
  createIsolatedHome({ homeDir, sharedCacheDir, host: args.host, keychain, ghAccounts: false, credentials: claudeCredentialsLink({ host: args.host }) })
  // The `watering-schedule-api` card records `~/code/greenhouse-irrigation`;
  // `~` is this run's temp HOME, so the clone lives under the temp dir.
  // `valve-firmware` (the `missing-clone` scenario's repo) is never created.
  materializeGreenhouseClone(homeDir)
  const pluginDir = args.pluginDir ? path.resolve(args.pluginDir) : buildPluginDir({ worktreeRoot, targetDir: path.join(runTmp, "plugins") })

  // An allowlisted environment, a read-only `gh` shim first on PATH and a
  // run-private git config (see safety.mjs). Nothing is inherited wholesale.
  const shimDir = path.join(runTmp, "shim")
  const ghLog = path.join(runTmp, "gh-denied.jsonl")
  const gitConfig = writeGitConfig(homeDir)
  const realGh = findRealGh(process.env.PATH, shimDir)
  let flags
  let env
  let bootScriptFile = path.join(pluginDir, "desk", "mcp", "scripts", "session-boot.js")
  const secrets = []
  if (args.host === "copilot") {
    const copilotHome = writeCopilotProfile({ homeDir, trustedFolders: [deskRoot, sessionFolder, path.join(homeDir, "code"), homeDir] })
    shareCopilotPackageCache({ homeDir, sharedDir: path.join(sharedCacheDir, "copilot-pkg") })
    env = buildChildEnv({ parentEnv: process.env, homeDir, shimDir, gitConfig, ghLog, host: "copilot", extraEnv: { COPILOT_HOME: copilotHome, COPILOT_AUTO_UPDATE: "false", ...(args.copilotBind === "env" ? { DESK: deskRoot } : {}) } })
    // Install Desk the way a Copilot user does, before the credential exists in the environment: installing needs none.
    const installed = installCopilotPlugins({ copilot: args.binary, pluginDir, env, cwd: sessionFolder })
    if (!installed.ok) throw new Error(`could not install Desk into the run's Copilot profile: ${installed.log.join(" | ")}`)
    bootScriptFile = path.join(installed.installedDesk, "mcp", "scripts", "session-boot.js")
    // The credential: one named variable on the child, never a file or an argument, redacted by value from every saved output.
    env[COPILOT_TOKEN_VAR] = auth.token
    secrets.push(auth.token)
    flags = copilotFlags({ model: args.model })
  } else {
    env = buildChildEnv({ parentEnv: process.env, homeDir, shimDir, gitConfig, ghLog })
    // Persistence is on (the default) so the critique turn can `--resume` the scenario turn's session; it writes only under this run's temp HOME.
    flags = [
      "--model", args.model,
      "--output-format", "stream-json",
      "--verbose",
      "--max-budget-usd", args.budget,
      "--permission-mode", "bypassPermissions",
      "--plugin-dir", pluginDir,
    ]
  }
  // Only the plugin under test's own boot script may receive a raw `gh auth token`.
  const bootScript = existsSync(bootScriptFile) ? realpathSync(bootScriptFile) : null
  if (realGh) installGhShim({ shimDir, realGh, logFile: ghLog, bootScript, realEnv: realGhEnv() })

  const startedAt = Date.now()
  const { ctx, critique, critiqueSkipped, turns } = await runTurns({ claude: runHost(args.binary), prompt: scenario.prompt, critiquePrompt: CRITIQUE_PROMPT, flags, cwd: sessionFolder, env, timeoutMs: args.timeoutMin * 60 * 1000, host: args.host, secrets })
  if (args.host === "copilot") {
    const refused = authFailureProblem({ turn: turns[0], auth })
    if (refused !== null) throw new Error(refused)
  }
  ctx.host = args.host
  ctx.deskRoot = deskRoot
  ctx.homeDir = homeDir
  ctx.runTmp = runTmp
  // With the harness's own plugin copy, the source checkout's path must never appear in a tool call. A `--plugin-dir` run names its own folder, which is then the plugin under test, so there is no source to hide.
  ctx.sourcePaths = args.pluginDir ? [] : sourcePaths(worktreeRoot)
  const wallMs = Date.now() - startedAt
  const [first] = turns

  const runDir = path.join(outDir, scenario.id, `run-${runIndex}`)
  mkdirSync(runDir, { recursive: true })
  // A Copilot log is saved without its token-by-token deltas and encrypted reasoning blobs (see `compactCopilotTranscript`); nothing the checks read is dropped.
  const keep = args.host === "copilot" ? compactCopilotTranscript : (text) => text
  writeFileSync(path.join(runDir, "transcript.jsonl"), keep(first.stdout))
  if (turns[1]) writeFileSync(path.join(runDir, "critique-transcript.jsonl"), keep(turns[1].stdout))
  // Which Desk gates fired. Copilot's stream carries no hook events, so the session's own log is read from the run's profile (it goes with the temp HOME) and a reduced, redacted copy is saved.
  let copilotEventsText = null
  if (args.host === "copilot") {
    const sessionLog = readCopilotSessionEvents(path.join(homeDir, ".copilot"))
    const reduced = sessionLog === null ? "" : reduceCopilotEvents(sessionLog, { secrets })
    if (reduced !== "") {
      copilotEventsText = reduced
      writeFileSync(path.join(runDir, "copilot-events.jsonl"), reduced)
    }
  }
  const gates = gateReport({ host: args.host, claudeEvents: turns.flatMap((t) => parseStreamJson(t.stdout)), copilotEventsText })
  const stderr = turns.map((t) => t.stderr).filter(Boolean).join("\n")
  if (stderr) writeFileSync(path.join(runDir, "stderr.log"), stderr)

  try {
    ctx.ghDenials = existsSync(ghLog) ? readFileSync(ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
  } catch {
    ctx.ghDenials = []
  }
  if (ctx.ghDenials.length) writeFileSync(path.join(runDir, "gh-denied.jsonl"), ctx.ghDenials.map((d) => JSON.stringify(d)).join("\n") + "\n")
  const checkResult = discountCancelledStart(scoreRun(scenario, ctx, args.host), gates)

  const counted = ctx.toolCalls.filter((t) => !META_TOOLS.has(t.name))
  const summary = {
    host: args.host,
    model: args.model,
    scenario: scenario.id,
    run: runIndex,
    prompt: scenario.prompt,
    injected: scenario.inject,
    outside_desk: args.outsideDesk,
    spawn_exit_code: first.status,
    spawn_signal: first.signal,
    timed_out: turns.some((t) => t.timedOut),
    gh_write_attempts_blocked: ctx.ghDenials.length,
    token_leaks: ctx.tokenLeaks,
    wall_ms: wallMs,
    duration_ms: ctx.durationMs,
    duration_api_ms: ctx.durationApiMs,
    total_cost_usd: ctx.totalCostUsd,
    premium_requests: ctx.premiumRequests ?? null,
    critique_cost_usd: ctx.critiqueCostUsd ?? null,
    num_turns: ctx.numTurns,
    subtype: ctx.subtype,
    is_error: ctx.isError,
    // Copilot's bookkeeping tools (shell-session readers and the like) are not counted: they are not what the agent did.
    tool_call_count: counted.length,
    tool_call_names: counted.map((t) => t.name),
    outcome: checkResult.outcome,
    discounted_failures: checkResult.discounted ?? 0,
    outcome_notes: checkResult.notes,
    not_applicable: checkResult.notApplicable,
    // Every check this host could run passed; the checks it could not run are the `not_applicable` list, counted here, never credited as passes.
    judged_pass: checkResult.outcome === "pass",
    not_applicable_count: checkResult.notApplicable.length,
    // Which of Desk's own gates fired (see gates.mjs): hook feedback and denials on Claude; the first-prompt pointer, denials and stop blocks on Copilot.
    gates,
    // The scenario turn's final reply and the critique turn's reply are separate fields.
    final_reply: ctx.finalResultText,
    critique,
    critique_skipped: critiqueSkipped,
  }
  writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2))

  console.log(`[${runId}] outcome=${summary.outcome} tools=${summary.tool_call_count} wall_ms=${wallMs} ${args.host === "copilot" ? `premium_requests=${summary.premium_requests ?? "?"}` : `cost=$${summary.total_cost_usd ?? "?"}`}`)
  return summary
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(USAGE); return }
  const worktreeRoot = args.worktree ? path.resolve(args.worktree) : WORKTREE_ROOT
  if (!args.dryRun) mkdirSync(args.outDir, { recursive: true })

  const sharedCacheDir = args.sharedCache ? path.resolve(args.sharedCache) : path.join(args.outDir, ".shared-runtime-cache")

  args.binary = args.host === "copilot" ? findCopilotBinary() : "claude"
  if (!args.binary) throw new Error("--host copilot: no Copilot CLI found (looked for DESK_HARNESS_COPILOT_BIN, ~/.copilot-cli/<version>/copilot and copilot on PATH)")

  console.log(`host:         ${args.host} (${args.binary}) on model ${args.model}`)
  console.log(`worktree:     ${worktreeRoot}`)
  console.log(`plugins:      ${args.pluginDir ? path.resolve(args.pluginDir) : `desk, superpowers, plain-language from ${worktreeRoot}/plugins`}`)
  console.log(`real HOME:    ${REAL_HOME} (only Library/Keychains${args.host === "copilot" ? " and the account's gh login name" : " and .claude/.credentials.json"} ${args.host === "copilot" ? "is" : "are"} ever read from it)`)
  console.log(`shared cache: ${sharedCacheDir} (Desk runtime-dependency pack reuse only, no operator content)`)
  console.log(`out-dir:      ${args.outDir}`)
  console.log("")

  const scenarios = args.scenario === "all" ? SCENARIOS : [findScenario(args.scenario)]
  if (args.dryRun) {
    const sample = buildChildEnv({ parentEnv: process.env, homeDir: "<temp HOME>", shimDir: "<temp shim dir>", gitConfig: "<temp .gitconfig>", ghLog: "<temp log>", host: args.host, extraEnv: args.host === "copilot" ? { COPILOT_HOME: "<temp HOME>/.copilot", COPILOT_AUTO_UPDATE: "false", ...(args.copilotBind === "env" ? { DESK: "<fixture desk>" } : {}), [COPILOT_TOKEN_VAR]: "<credential, resolved at run time, never printed>" } : {} })
    console.log(`dry run: would run ${scenarios.map((s) => s.id).join(", ")} x ${args.runs} run(s) on model ${args.model}`)
    console.log(`child environment variables: ${Object.keys(sample).sort().join(", ")}`)
    console.log("nothing was run")
    return
  }
  // The Copilot credential is resolved once, here, held in memory and handed to each run's child environment only (see copilot.mjs `resolveCopilotAuth`).
  let auth = null
  if (args.host === "copilot") {
    auth = resolveCopilotAuth({ allowGhToken: args.copilotUseGhToken })
    if (!auth.token) throw new Error(auth.problem)
    console.log(`auth:         ${COPILOT_TOKEN_VAR} from ${auth.source} (the value is never printed or written)`)
    if (auth.broad) console.warn(`\n${GH_TOKEN_WARNING}\n`)
  }
  const allSummaries = []
  for (const scenario of scenarios) {
    for (let runIndex = 1; runIndex <= args.runs; runIndex++) {
      allSummaries.push(await runOne({ scenario, runIndex, args, worktreeRoot, sharedCacheDir, outDir: args.outDir, auth }))
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
