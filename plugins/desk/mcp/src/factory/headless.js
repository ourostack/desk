// The factory's bounded headless runner: it starts the agent CLI in print mode
// to label the waste in finished jobs' evaluator briefs, with no human in the
// loop. Its rules, in order of importance:
//
//   - It never spends money by itself. The run starts only when the agent CLI
//     reports a subscription sign-in (`probeSignIn`). A per-token credential
//     in the environment, a per-token sign-in, no sign-in or an unreadable
//     answer each give a stable state and start nothing, and the child's
//     environment never carries a per-token variable.
//   - A headless session never starts another headless run: with
//     `DESK_FACTORY_HEADLESS` set in the caller's own environment nothing
//     starts, not even the probe.
//   - Only the exact child handle this module spawned is ever signalled. It
//     never looks a process up by name.
//   - Nothing records argv, stdout or stderr. What leaves this module is a
//     stable state code, the cost number (`null` when the output carries none,
//     never zero) and a stable detail code.
//
// The run is independent of the work it labels: a fresh process, a fixed
// prompt naming only the brief paths, a scratch working folder that is not a
// desk, and tools limited to read, search and write.

import { spawn as nodeSpawn } from "node:child_process"
import { accessSync, constants as fsConstants, statSync } from "node:fs"
import * as path from "node:path"

import { isHeadlessFactorySession } from "./headless-flag.js"

export const HEADLESS_BUDGET_USD = 1
export const MAX_HEADLESS_JOBS_PER_DAY = 6
export const HEADLESS_TIMEOUT_MS = 900000

const PROBE_TIMEOUT_MS = 15000
const PROBE_MAX_BYTES = 64 * 1024
const RUN_MAX_BYTES = 1024 * 1024
const AGENT_NAME = "desk:observer"

// The child (and the sign-in probe) get only what the CLI needs to find itself,
// its subscription sign-in and its network (proxy and certificate settings).
// Everything else, every provider switch and credential included, is left out.
export const CHILD_ENV_ALLOW = Object.freeze({
  names: Object.freeze([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "TERM",
    "CLAUDE_CONFIG_DIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    // A proxied or TLS-inspecting network: without these the CLI cannot reach its service and every run fails.
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_SYSTEM_CA",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]),
  prefixes: Object.freeze(["LC_", "XDG_"]),
})

// `ANTHROPIC_*` names that are neither a key, a token nor a base URL. None is worth keeping today.
export const HARMLESS_ANTHROPIC_ENV = Object.freeze([])

const isSet = (value) => typeof value === "string" && value !== "" && value !== "0" && value !== "false"

/**
 * `billingVariableBlocks(env) -> boolean`: true when the environment holds a
 * provider switch or a credential that would make the CLI bill per token:
 * any `CLAUDE_CODE_USE_*`, any `ANTHROPIC_*` (outside the harmless list),
 * `CLAUDE_CODE_OAUTH_TOKEN` or `AWS_BEARER_TOKEN_BEDROCK`.
 */
export function billingVariableBlocks(env) {
  return Object.entries(env).some(([name, value]) => {
    if (!isSet(value)) {
      return false
    }
    if (name.startsWith("CLAUDE_CODE_USE_") || name === "CLAUDE_CODE_OAUTH_TOKEN" || name === "AWS_BEARER_TOKEN_BEDROCK") {
      return true
    }
    return name.startsWith("ANTHROPIC_") && !HARMLESS_ANTHROPIC_ENV.includes(name)
  })
}

const isHeadlessSession = isHeadlessFactorySession

function childEnvironment(env) {
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      continue
    }
    if (CHILD_ENV_ALLOW.names.includes(name) || CHILD_ENV_ALLOW.prefixes.some((prefix) => name.startsWith(prefix))) {
      out[name] = value
    }
  }
  out.DESK_FACTORY_HEADLESS = "1"
  return out
}

const isExecutableFile = (candidate) => {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

const isDirectory = (candidate) => {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/** `hostSupported(host) -> boolean`: only Claude Code's print mode is supported. */
export function hostSupported(host) {
  return host === "claude-code"
}

/**
 * `HEADLESS_ARGV({ briefPaths, evaluationDir, logDirs }) -> string[]`: the
 * pinned argument vector, one `--add-dir` for the evaluation folder and one per
 * distinct log folder. The prompt names only the brief paths.
 */
export function HEADLESS_ARGV({ briefPaths, evaluationDir, logDirs }) {
  const prompt = `Label the waste in these evaluator briefs with desk:factory-evaluator: ${briefPaths.join(" ")}.`
  const dirs = [evaluationDir, ...new Set(logDirs)]
  return [
    "-p",
    prompt,
    "--agent",
    AGENT_NAME,
    "--output-format",
    "json",
    "--max-budget-usd",
    String(HEADLESS_BUDGET_USD),
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "Write",
    ...dirs.flatMap((dir) => ["--add-dir", dir]),
  ]
}

/**
 * `findAgentCli({ env, exists }) -> string | null`: `DESK_AGENT_CLI`, else
 * `claude` on PATH, else `local/claude` in the Claude config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`), else `~/.local/bin/claude`.
 */
export function findAgentCli({ env, exists = isExecutableFile }) {
  const explicit = env.DESK_AGENT_CLI
  if (typeof explicit === "string" && explicit !== "" && exists(explicit)) {
    return explicit
  }
  const dirs = typeof env.PATH === "string" ? env.PATH.split(path.delimiter).filter((dir) => dir !== "") : []
  const candidates = dirs.map((dir) => path.join(dir, "claude"))
  if (typeof env.HOME === "string" && env.HOME !== "") {
    const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME, ".claude")
    candidates.push(path.join(configDir, "local", "claude"), path.join(env.HOME, ".local", "bin", "claude"))
  }
  return candidates.find((candidate) => exists(candidate)) ?? null
}

const EXIT_GRACE_MS = 2000
const noop = () => {}

// Runs one child to its end and answers with a small tagged record. The only
// signal sent goes to the handle returned by `spawn`. The timer and every
// listener are armed before any caller callback runs, and a callback that
// throws can neither leave the child unbounded nor escape. The outcome is
// decided when the child exits, after a short bounded wait for the rest of its
// output; the pipes are released on every path. Output beyond `maxBytes` is
// discarded, never buffered, and reported as `truncated`.
function runChild({ spawn, cmd, args, opts, timeoutMs, maxBytes, graceMs = EXIT_GRACE_MS, onChild, onChildExit }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, opts)
    } catch (error) {
      resolve({ kind: "error", code: error?.code })
      return
    }
    const pid = typeof child.pid === "number" ? child.pid : null
    let reported = false
    let settled = false
    let exitCode = null
    let graceTimer
    const chunks = []
    let size = 0
    let truncated = false
    const settle = (result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      child.stdout.destroy?.()
      child.stderr.destroy?.()
      if (reported) {
        try {
          onChildExit?.(pid)
        } catch {
          // A failing callback cannot change the outcome.
        }
      }
      resolve(result)
    }
    const closed = (code) => settle({ kind: "closed", code, truncated, stdout: truncated ? "" : Buffer.concat(chunks).toString("utf8") })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      settle({ kind: "timeout" })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      if (truncated) {
        return
      }
      size += chunk.length
      if (size > maxBytes) {
        truncated = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    // Drained and dropped: stderr text is never kept.
    child.stderr.on("data", noop)
    child.stdout.on("error", noop)
    child.stderr.on("error", noop)
    child.on("error", (error) => settle({ kind: "error", code: error?.code }))
    child.on("exit", (code) => {
      exitCode = code
      graceTimer = setTimeout(() => closed(exitCode), graceMs)
    })
    child.on("close", (code) => closed(code))
    if (pid !== null) {
      try {
        onChild?.(pid)
        reported = true
      } catch {
        child.kill("SIGKILL")
        settle({ kind: "callback_failed" })
      }
    }
  })
}

function parseObject(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

const SIGN_IN_STATES = Object.freeze(["subscription", "no_credentials", "disabled_would_bill", "sign_in_unknown"])
const nonEmptyString = (value) => typeof value === "string" && value !== ""

/**
 * `probeSignIn({ cli, env, spawn, timeoutMs, onChild, onChildExit }) ->
 * Promise<{ state }>` with `state` one of `subscription`, `no_credentials`,
 * `disabled_would_bill`, `sign_in_unknown`. A billing variable in `env` gives
 * `disabled_would_bill` without starting anything. Otherwise it runs
 * `<cli> auth status` with the same allowlisted environment as the run, and
 * reads only `loggedIn`, `authMethod`, `apiProvider` and `subscriptionType`;
 * nothing else of its output is kept or returned.
 */
export async function probeSignIn({ cli, env, spawn = nodeSpawn, timeoutMs = PROBE_TIMEOUT_MS, onChild, onChildExit }) {
  if (billingVariableBlocks(env)) {
    return { state: "disabled_would_bill" }
  }
  const run = await runChild({
    spawn,
    cmd: cli,
    args: ["auth", "status"],
    opts: { env: childEnvironment(env), stdio: ["ignore", "pipe", "pipe"] },
    timeoutMs,
    maxBytes: PROBE_MAX_BYTES,
    onChild,
    onChildExit,
  })
  if (run.kind !== "closed") {
    return { state: "sign_in_unknown" }
  }
  const parsed = parseObject(run.stdout)
  if (parsed === null || typeof parsed.loggedIn !== "boolean") {
    return { state: "sign_in_unknown" }
  }
  if (!parsed.loggedIn) {
    return { state: "no_credentials" }
  }
  if (!nonEmptyString(parsed.authMethod) || !nonEmptyString(parsed.apiProvider)) {
    return { state: "sign_in_unknown" }
  }
  if (parsed.apiProvider !== "firstParty" || parsed.authMethod !== "claude.ai") {
    return { state: "disabled_would_bill" }
  }
  if (!nonEmptyString(parsed.subscriptionType)) {
    return { state: "sign_in_unknown" }
  }
  return { state: "subscription" }
}

const result = (state, cost_usd = null, detail = null) => ({ state, cost_usd, detail })

/**
 * `runHeadless({ env, job, briefPaths, evaluationDir, logDirs, workDir, spawn,
 * cli, signIn, exists, dirExists, timeoutMs, onChild, onChildExit }) ->
 * Promise<{ state, cost_usd, detail }>`. `job.host` is required; a missing or
 * unsupported host is `unsupported_host`. `state` is one of `ran`,
 * `no_agent_cli`, `no_credentials`, `timeout`, `budget_exceeded`, `failed`,
 * `unsupported_host`, `disabled_would_bill`, `sign_in_unknown`,
 * `headless_session`. `workDir` is the scratch working folder and must exist
 * (`failed` with detail `work_dir_missing` otherwise). `signIn` is an optional
 * already-computed `probeSignIn` result; the environment is checked first
 * whatever it says, and an unknown state counts as `sign_in_unknown`. Without
 * it the runner probes. `onChild(pid)` and `onChildExit(pid)` report each
 * child it starts (the probe's too), for the caller's lock file.
 */
export async function runHeadless({
  env,
  job,
  briefPaths,
  evaluationDir,
  logDirs,
  workDir,
  spawn = nodeSpawn,
  cli,
  signIn,
  exists = isExecutableFile,
  dirExists = isDirectory,
  timeoutMs = HEADLESS_TIMEOUT_MS,
  onChild,
  onChildExit,
}) {
  if (isHeadlessSession(env)) {
    return result("headless_session")
  }
  if (!hostSupported(job?.host)) {
    return result("unsupported_host")
  }
  if (billingVariableBlocks(env)) {
    return result("disabled_would_bill")
  }
  const agentCli = cli ?? findAgentCli({ env, exists })
  if (agentCli === null) {
    return result("no_agent_cli")
  }
  if (typeof workDir !== "string" || !dirExists(workDir)) {
    return result("failed", null, "work_dir_missing")
  }
  const signedIn = signIn ?? (await probeSignIn({ cli: agentCli, env, spawn, onChild, onChildExit }))
  const signInState = SIGN_IN_STATES.includes(signedIn?.state) ? signedIn.state : "sign_in_unknown"
  if (signInState !== "subscription") {
    return result(signInState)
  }
  const run = await runChild({
    spawn,
    cmd: agentCli,
    args: HEADLESS_ARGV({ briefPaths, evaluationDir, logDirs }),
    opts: { cwd: workDir, env: childEnvironment(env), stdio: ["ignore", "pipe", "pipe"] },
    timeoutMs,
    maxBytes: RUN_MAX_BYTES,
    onChild,
    onChildExit,
  })
  if (run.kind === "timeout") {
    return result("timeout")
  }
  if (run.kind === "callback_failed") {
    return result("failed", null, "callback_failed")
  }
  if (run.kind === "error") {
    return run.code === "ENOENT" ? result("no_agent_cli") : result("failed", null, "spawn_error")
  }
  if (run.truncated) {
    return result("failed", null, "output_too_large")
  }
  const output = parseObject(run.stdout)
  if (output === null) {
    return result("failed", null, "output_unparsable")
  }
  const cost = Number.isFinite(output.total_cost_usd) && output.total_cost_usd >= 0 ? output.total_cost_usd : null
  if (typeof output.subtype === "string" && output.subtype.includes("budget")) {
    return result("budget_exceeded", cost)
  }
  if (output.is_error === true) {
    return result("failed", cost, "agent_error")
  }
  if (run.code !== 0) {
    return result("failed", cost, "exit_nonzero")
  }
  if (output.is_error !== false || output.subtype !== "success") {
    return result("failed", cost, "output_unexpected")
  }
  return result("ran", cost)
}
