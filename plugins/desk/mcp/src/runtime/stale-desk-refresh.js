// Refreshing a stale Desk on the host that cached it, so the next session runs the newer version. Boot's stale-Desk check
// (`./stale-desk.js`) finds that the running Desk is behind `main`; this module picks the host's own refresh command and
// starts it fully detached, after boot has written its output, so boot never waits for it.
//
// - One attempt an hour per machine. The attempt is claimed atomically (`wx` create of a claim file) and stamped before anything
//   is spawned, so agents that boot together start one refresh, not twenty. A claim older than 30 s is stale (the runner's own
//   limit is 8 s) and can be taken over.
// - A tiny detached runner (a `node -e` script) runs the host's command in its own process group, kills the whole group at the
//   8 s deadline, so no grandchild from a launcher shim survives, then records the outcome in the stamp and `repairs.log` and
//   releases the claim. The limit holds without the boot process, which has exited by then.
// - Boot reports what it started. A failure shows in the next boot, from the stamp, as the manual step; it is never shown as an error.
//
// Per host (verified against `agency plugin cache remove --help`, `copilot plugin update --help` and `claude plugin update --help`):
// - Agency: `agency plugin cache remove -f <spec>`, the spec read from Agency's own cache index.
// - Copilot run directly (Desk under Copilot's installed-plugins directory): `copilot plugin update desk`.
// - Claude Code: `claude plugin update desk@<marketplace>`, the marketplace read from where this Desk is installed.

import { spawn as nodeSpawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { appendRepairLog, resolveDeskStateDir } from "./last-start.js"
import { behindText } from "./stale-desk.js"
import { assertNotRealStateUnderTest, looksLikeNodeTestRunner } from "./test-state-guard.js"
import { renameWithRetry } from "../util/rename-retry.js"

export const REFRESH_TIMEOUT_MS = 8000
export const REFRESH_TTL_MS = 60 * 60 * 1000
export const REFRESH_CLAIM_STALE_MS = 30 * 1000
export const REFRESH_STAMP_FILE = "desk-refresh.json"
export const REFRESH_CLAIM_FILE = "desk-refresh.claim"
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
 * The Agency cache spec this Desk was loaded from, from Agency's own cache index: the `ourostack/desk` plugin on `@main` for
 * this session's engine (`AGENCY_ENGINE`, else the agent host: Claude under Agency has its own `claude:` entries), whose cached
 * copy has the running version. Anything else is null.
 */
export function deriveAgencySpec({ env, agentHost, pluginRoot, running, homeDir, readFile = (file) => readFileSync(file, "utf8") }) {
  try {
    const engine = text(env.AGENCY_ENGINE) ? env.AGENCY_ENGINE.trim() : agentHost
    if (engine !== "copilot" && engine !== "claude") return null
    const spec = `${engine}:github:ourostack/desk:plugins/desk@main`
    const cacheDir = path.join(agencyPluginsDir({ pluginRoot, homeDir }), "cache")
    const entry = (JSON.parse(readFile(path.join(cacheDir, "cache_index.json"))).entries ?? {})[spec]
    if (!text(entry?.dir_name)) return null
    return JSON.parse(readFile(path.join(cacheDir, "entries", entry.dir_name, "plugin.json"))).version === running ? spec : null
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

/** True when `pluginRoot` is inside Copilot's installed-plugins directory (`$COPILOT_HOME`, else `~/.copilot`), not a `--plugin-dir` or a dev checkout. */
export function copilotInstalled({ env, pluginRoot, homeDir }) {
  const base = path.resolve(text(env.COPILOT_HOME) ? env.COPILOT_HOME : path.join(homeDir, ".copilot"), "installed-plugins")
  const relative = path.relative(base, path.resolve(pluginRoot))
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** `{ host, command, args, doing }` for the host's own refresh, or null when none can be derived and the manual step stands. */
export function refreshPlan({ env, pluginRoot, agentHost, running, homeDir, readFile }) {
  if (isAgencySession({ env, pluginRoot })) {
    const spec = deriveAgencySpec({ env, agentHost, pluginRoot, running, homeDir, readFile })
    return spec === null ? null : { host: "agency", command: "agency", args: ["plugin", "cache", "remove", "-f", spec], doing: "refreshing the Agency plugin cache" }
  }
  if (agentHost === "copilot") return copilotInstalled({ env, pluginRoot, homeDir }) ? { host: "copilot", command: "copilot", args: ["plugin", "update", "desk"], doing: "running copilot plugin update desk" } : null
  if (agentHost === "claude") {
    const marketplace = claudeMarketplace({ pluginRoot })
    return marketplace === null ? null : { host: "claude", command: "claude", args: ["plugin", "update", `desk@${marketplace}`], doing: `running claude plugin update desk@${marketplace}` }
  }
  return null
}

// The detached runner. It is a string, run with `node -e`, so it needs no file beside the plugin and nothing of Desk loaded.
// argv[1] is its JSON config. The command gets its own process group (POSIX), and the group is killed at the deadline and after
// the command exits, so no grandchild survives; then the stamp and the log line are written and the claim is released.
const RUNNER_SOURCE = `
const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path")
const cfg = JSON.parse(process.argv[1])
const posix = process.platform !== "win32"
let finished = false, child, timer
function killGroup() {
  try { if (posix) process.kill(-child.pid, "SIGKILL"); else child.kill() } catch (e) {}
}
function finish(ok, reason, code) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  const now = new Date().toISOString()
  try {
    const stamp = JSON.stringify({ schema_version: 1, attempted_at: cfg.attemptedAt, finished_at: now, host: cfg.host, running: cfg.running, latest: cfg.latest, ok, reason })
    fs.writeFileSync(cfg.stamp + ".run.tmp", stamp + "\\n", { mode: 0o600 })
    fs.renameSync(cfg.stamp + ".run.tmp", cfg.stamp)
  } catch (e) {}
  try {
    const line = ok ? "stale Desk refresh ran (" + cfg.host + ": " + cfg.shown + "); " + cfg.running + " -> " + cfg.latest : "stale Desk refresh failed (" + cfg.host + ": " + cfg.shown + "): " + reason + (code == null ? "" : " exit " + code)
    fs.appendFileSync(cfg.log, now + " " + cfg.root + " " + line + "\\n", { mode: 0o600 })
  } catch (e) {}
  try { fs.unlinkSync(cfg.claim) } catch (e) {}
  process.exit(0)
}
timer = setTimeout(() => { killGroup(); finish(false, "timeout", null) }, cfg.timeoutMs)
try {
  child = cp.spawn(cfg.command, cfg.args, { stdio: "ignore", detached: posix, windowsHide: true })
  child.once("error", (error) => finish(false, error.code === "ENOENT" ? "not_installed" : "spawn_failed", null))
  child.once("exit", (code) => { killGroup(); finish(code === 0, code === 0 ? "ok" : "nonzero_exit", code) })
} catch (e) { finish(false, "spawn_failed", null) }
`

function readStamp(file) {
  try {
    const stamp = JSON.parse(readFileSync(file, "utf8"))
    return Number.isFinite(Date.parse(stamp.attempted_at)) ? stamp : null
  } catch {
    return null
  }
}

function freshStamp(stamp, now) {
  const age = stamp === null ? Infinity : now() - Date.parse(stamp.attempted_at)
  return age >= 0 && age < REFRESH_TTL_MS
}

function writeFileAtomic(file, record) {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameWithRetry(temp, file)
}

/**
 * Decides, without changing anything, what a boot should say and do about a stale finding: `{ state: "ready", plan, dir }`, or
 * a state meaning the manual step stands: `disabled`, `skipped` (an attempt in the last hour), `failed` (that attempt failed),
 * `unavailable` (no command can be derived). Never throws. `allowInTest` lifts the node:test off switch.
 */
export function planStaleRefresh({ finding, env, pluginRoot, agentHost, homeDir, now = Date.now, stateDir, readFile, allowInTest = false }) {
  try {
    if (String(env[REFRESH_SWITCH] ?? "").trim() === "0") return { state: "disabled" }
    if (!allowInTest && looksLikeNodeTestRunner(env)) return { state: "disabled" }
    const dir = stateDir ?? resolveDeskStateDir({ env })
    const stamp = readStamp(path.join(dir, REFRESH_STAMP_FILE))
    if (freshStamp(stamp, now)) return { state: stamp.ok === false ? "failed" : "skipped" }
    const plan = refreshPlan({ env, pluginRoot, agentHost, running: finding.running, homeDir: homeDir ?? os.homedir(), readFile })
    return plan === null ? { state: "unavailable" } : { state: "ready", plan, dir }
  } catch {
    return { state: "unavailable" }
  }
}

/** The finding's line for a refresh that has started: what boot reports, in place of the manual step. */
export function startedLine(finding, plan) {
  return `Desk ${finding.running} is ${behindText(finding.behind)} main (${finding.latest}); ${plan.doing} in the background, so a new session will run ${finding.latest}.`
}

// Creates the claim, or reports that another boot holds a live one. A claim older than REFRESH_CLAIM_STALE_MS belongs to a runner
// that died and is taken over. If two boots take the same stale claim over, the one that loses the create throws here and
// the caller reports its start as failed, which only means it does not start a second refresh.
function claim(file, now) {
  try {
    closeSync(openSync(file, "wx", 0o600))
    return true
  } catch {
    // Held by someone: live or stale, below.
  }
  if (now() - statSync(file).mtimeMs < REFRESH_CLAIM_STALE_MS) return false
  unlinkSync(file)
  closeSync(openSync(file, "wx", 0o600))
  return true
}

/**
 * Starts a ready plan, detached, and returns at once: `{ state: "started" }`, `{ state: "claimed_elsewhere" }` when another boot
 * holds the attempt, or `{ state: "failed" }` when it could not start. Claims the attempt and stamps it before spawning, so
 * concurrent boots start one refresh. Never throws and never waits; the runner outlives this process. `spawn` is for tests.
 */
export function startStaleRefresh({ prepared, finding, env, root, now = Date.now, spawn = nodeSpawn, timeoutMs = REFRESH_TIMEOUT_MS }) {
  const { plan, dir } = prepared
  const stamp = path.join(dir, REFRESH_STAMP_FILE)
  const claimFile = path.join(dir, REFRESH_CLAIM_FILE)
  const attemptedAt = new Date(now()).toISOString()
  let held = false
  try {
    assertNotRealStateUnderTest(dir, { env })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!claim(claimFile, now)) return { state: "claimed_elsewhere" }
    held = true
    // Re-read after winning the claim: a boot that finished its attempt between our plan and our claim has stamped it already.
    if (freshStamp(readStamp(stamp), now)) {
      unlinkSync(claimFile)
      return { state: "claimed_elsewhere" }
    }
    writeFileAtomic(stamp, { schema_version: 1, attempted_at: attemptedAt, host: plan.host, running: finding.running, latest: finding.latest, ok: null })
    const config = { command: plan.command, args: plan.args, timeoutMs, stamp, claim: claimFile, log: path.join(dir, "repairs.log"), root: root ?? "-", host: plan.host, running: finding.running, latest: finding.latest, attemptedAt, shown: `${plan.command} ${plan.args.join(" ")}` }
    const child = spawn(process.execPath, ["-e", RUNNER_SOURCE, JSON.stringify(config)], { cwd: dir, detached: true, stdio: "ignore", env, windowsHide: true })
    child.unref()
    return { state: "started" }
  } catch (error) {
    // A start that failed releases its own claim; the stamp stays, so a broken host is not retried every boot.
    if (held) unlinkSync(claimFile)
    try {
      appendRepairLog({ stateDir: dir, line: `stale Desk refresh could not start (${plan.host}): ${error.message}`, root: root ?? "-", now: () => new Date(now()) })
    } catch {
      // The log is for later diagnosis only.
    }
    return { state: "failed" }
  }
}
