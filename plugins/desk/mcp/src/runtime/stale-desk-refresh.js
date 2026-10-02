// Refreshing a stale Desk on the host that cached it, so the next session runs the newer version. Boot's stale-Desk check
// (`./stale-desk.js`) finds that the running Desk is behind `main`; this module picks the host's own refresh command,
// runs it once, in the background of the boot (after the boot text is written), with a hard timeout, and reports one line.
// A failed or unavailable command falls back to the manual step in the finding's line and is logged to Desk's repair log,
// never to the agent. At most one attempt per hour per machine, whatever its outcome.
//
// Per host (verified against `agency plugin cache remove --help`, `copilot plugin update --help` and `claude plugin update --help`):
// - Agency: `agency plugin cache remove -f <spec>`, where the spec is derived from Agency's own cache index, never hard-coded.
// - Copilot run directly: `copilot plugin update desk`.
// - Claude Code: `claude plugin update desk@<marketplace>`, with the marketplace read from where this Desk is installed.

import { spawn as nodeSpawn } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { appendRepairLog, resolveDeskStateDir } from "./last-start.js"
import { behindText } from "./stale-desk.js"
import { assertNotRealStateUnderTest, looksLikeNodeTestRunner } from "./test-state-guard.js"

export const REFRESH_TIMEOUT_MS = 8000
export const REFRESH_TTL_MS = 60 * 60 * 1000
export const REFRESH_STAMP_FILE = "desk-refresh.json"
export const REFRESH_SWITCH = "DESK_BOOT_AUTO_REFRESH"

// Only plain spec and plugin names ever reach a command line.
const SAFE_ARG = /^[A-Za-z0-9._@:/+-]+$/u

function text(value) {
  return typeof value === "string" && value.trim() !== ""
}

function agencyPluginsDir({ pluginRoot, homeDir }) {
  // A session copy lives at <agency data>/plugins/sessions/agency-plugin-*/desk, so the cache is its sibling.
  const parts = path.resolve(pluginRoot).split(path.sep)
  const at = parts.lastIndexOf("sessions")
  if (at > 0 && parts[at - 1] === "plugins" && /^agency-/u.test(parts[at + 1] ?? "")) return parts.slice(0, at).join(path.sep)
  return path.join(homeDir, ".local", "agency", "plugins")
}

/** True when this session was launched through Agency: it sets `AGENCY_ENGINE` and `AGENCY_SESSION_ID`, and runs plugins from a session copy under `plugins/sessions/agency-plugin-*`. */
export function isAgencySession({ env, pluginRoot }) {
  if (text(env.AGENCY_ENGINE) || text(env.AGENCY_SESSION_ID)) return true
  return /[\\/]plugins[\\/]sessions[\\/]agency-plugin-[^\\/]+[\\/]/u.test(`${path.resolve(pluginRoot)}${path.sep}`)
}

/**
 * The Agency cache spec this Desk was loaded from, from Agency's own cache index: the entry for this engine, for a plugin
 * folder named `desk`, whose cached copy has the running version. One match is the answer; none or several is null.
 */
export function deriveAgencySpec({ env, pluginRoot, running, homeDir, readFile = (file) => readFileSync(file, "utf8") }) {
  try {
    const engine = text(env.AGENCY_ENGINE) ? env.AGENCY_ENGINE.trim() : "copilot"
    const cacheDir = path.join(agencyPluginsDir({ pluginRoot, homeDir }), "cache")
    const entries = JSON.parse(readFile(path.join(cacheDir, "cache_index.json"))).entries ?? {}
    const own = new RegExp(`^${engine.replace(/[^A-Za-z0-9_-]/gu, "")}:github:[^:]+:(?:[^@:]*/)?desk(?:@[^:]*)?$`, "u")
    const matches = Object.entries(entries).filter(([spec, entry]) => {
      if (!own.test(spec) || !SAFE_ARG.test(spec) || !text(entry?.dir_name)) return false
      try {
        return JSON.parse(readFile(path.join(cacheDir, "entries", entry.dir_name, "plugin.json"))).version === running
      } catch {
        return false
      }
    })
    return matches.length === 1 ? matches[0][0] : null
  } catch {
    return null
  }
}

/** The marketplace a Claude Code install of Desk came from: `<home>/plugins/cache/<marketplace>/<plugin>/<version>`. */
export function claudeMarketplace({ pluginRoot, name = "desk" }) {
  const parts = path.resolve(pluginRoot).split(path.sep)
  const at = parts.lastIndexOf("cache")
  if (at < 1 || parts[at - 1] !== "plugins" || parts[at + 2] !== name || parts.length !== at + 4) return null
  return SAFE_ARG.test(parts[at + 1]) ? parts[at + 1] : null
}

/** `{ host, command, args, done }` for the host's own refresh, or null when none can be derived and the manual step stands. */
export function refreshPlan({ env = process.env, pluginRoot, agentHost, running, latest, homeDir = os.homedir(), readFile }) {
  if (isAgencySession({ env, pluginRoot })) {
    const spec = deriveAgencySpec({ env, pluginRoot, running, homeDir, readFile })
    return spec === null ? null : { host: "agency", command: "agency", args: ["plugin", "cache", "remove", "-f", spec], done: `refreshed the Agency plugin cache, so a new session will run ${latest}` }
  }
  if (agentHost === "copilot") return { host: "copilot", command: "copilot", args: ["plugin", "update", "desk"], done: `ran copilot plugin update desk, so a new session will run ${latest}` }
  if (agentHost === "claude") {
    const marketplace = claudeMarketplace({ pluginRoot })
    return marketplace === null ? null : { host: "claude", command: "claude", args: ["plugin", "update", `desk@${marketplace}`], done: `ran claude plugin update desk@${marketplace}, so a new session will run ${latest}` }
  }
  return null
}

/** Runs one command with no stdin and a hard timeout; resolves `{ ok, code, reason }` and never rejects. */
export function runCommand(command, args, { spawn = nodeSpawn, timeoutMs = REFRESH_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // The child is already gone.
      }
      finish({ ok: false, code: null, reason: "timeout" })
    }, timeoutMs)
    try {
      child = spawn(command, args, { stdio: "ignore", env, windowsHide: true })
      child.once("error", (error) => finish({ ok: false, code: null, reason: error.code === "ENOENT" ? "not_installed" : "spawn_failed" }))
      child.once("close", (code) => finish({ ok: code === 0, code, reason: code === 0 ? "ok" : "nonzero_exit" }))
    } catch {
      finish({ ok: false, code: null, reason: "spawn_failed" })
    }
  })
}

function readStamp(file) {
  try {
    const stamp = JSON.parse(readFileSync(file, "utf8"))
    return Number.isFinite(Date.parse(stamp.attempted_at)) ? stamp : null
  } catch {
    return null
  }
}

function writeStamp(stateDir, file, record, env) {
  try {
    assertNotRealStateUnderTest(stateDir, { env })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // Without a stamp the next boot may try again; that is the only cost.
  }
}

function logLine({ stateDir, line, root, now, env }) {
  try {
    appendRepairLog({ stateDir, line, root: root ?? "-", now: () => new Date(now()) })
  } catch {
    // The log is for later diagnosis only; a boot never depends on it.
  }
}

/**
 * Decides, without running anything, whether a refresh would be attempted now: `{ state: "ready", plan, ... }`, or a
 * state that means the manual step stands (`disabled`, `skipped` for an attempt in the last hour, `unavailable` when the
 * host's command cannot be derived). Never throws.
 */
export function planStaleRefresh({ finding, env, pluginRoot, agentHost, homeDir, now = Date.now, runner = runCommand, stateDir, readFile }) {
  try {
    if (String(env[REFRESH_SWITCH] ?? "").trim() === "0") return { state: "disabled" }
    if (runner === runCommand && looksLikeNodeTestRunner(env)) return { state: "disabled" }
    const dir = stateDir ?? resolveDeskStateDir({ env })
    const file = path.join(dir, REFRESH_STAMP_FILE)
    const stamp = readStamp(file)
    const age = stamp === null ? Infinity : now() - Date.parse(stamp.attempted_at)
    if (age >= 0 && age < REFRESH_TTL_MS) return { state: "skipped" }
    const plan = refreshPlan({ env, pluginRoot, agentHost, running: finding.running, latest: finding.latest, homeDir: homeDir ?? os.homedir(), readFile })
    return plan === null ? { state: "unavailable" } : { state: "ready", plan, dir, file }
  } catch {
    return { state: "unavailable" }
  }
}

/**
 * Runs a ready plan (at most one attempt an hour, stamped whatever its outcome) and returns `{ state, plan, line }`:
 * `refreshed` with the one-line outcome, or `failed` with the finding's own line (the manual step). Never throws.
 * `runner` is the command runner (`runCommand`, or a test's stub).
 */
export async function runStaleRefresh({ prepared, finding, env, root, now = Date.now, runner, timeoutMs = REFRESH_TIMEOUT_MS }) {
  const { plan, dir, file } = prepared
  try {
    const result = await runner(plan.command, plan.args, { timeoutMs, env })
    writeStamp(dir, file, { schema_version: 1, attempted_at: new Date(now()).toISOString(), host: plan.host, running: finding.running, latest: finding.latest, ok: result.ok === true }, env)
    if (result.ok !== true) {
      logLine({ stateDir: dir, root, now, env, line: `stale Desk refresh failed (${plan.host}: ${plan.command} ${plan.args.join(" ")}): ${result.reason}${result.code === null ? "" : ` exit ${result.code}`}` })
      return { state: "failed", plan, line: finding.line }
    }
    logLine({ stateDir: dir, root, now, env, line: `stale Desk refresh ran (${plan.host}: ${plan.command} ${plan.args.join(" ")}); ${finding.running} -> ${finding.latest}` })
    return { state: "refreshed", plan, line: `Desk ${finding.running} is ${behindText(finding.behind)} main (${finding.latest}); ${plan.done}.` }
  } catch {
    return { state: "failed", plan, line: finding.line }
  }
}
