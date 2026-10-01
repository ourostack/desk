import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import * as path from "node:path"

// Capture the host environment, never the proposed command's environment. In
// particular PATH, executable search paths and loader variables are not input.
const HOST_ENV = { ...process.env }
const LOCATION_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE"]
let trustedGit

// Windows environment names are case-insensitive, but HOST_ENV is a plain copy, so its lookups are not. Claude Code runs hooks through Git Bash, which passes PROGRAMFILES in capitals.
function windowsEnvValue(env, name) {
  if (typeof env[name] === "string") return env[name]
  const lower = name.toLowerCase()
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower)
  return key === undefined ? undefined : env[key]
}

export function resolveInspectionGit({ platform = process.platform, env = HOST_ENV, accessible = (file) => {
  try { accessSync(file, constants.X_OK); return true } catch { return false }
} } = {}) {
  const candidates = platform === "win32"
    ? [...new Set(["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"].map((name) => windowsEnvValue(env, name)).filter(Boolean))].map((root) => path.win32.join(root, "Git", "cmd", "git.exe"))
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]
  const executable = candidates.find(accessible)
  if (!executable) throw new Error("trusted Git is unavailable; install Git in a standard system location")
  return executable
}

export function inspectionEnvironment(modeled) {
  const env = { ...HOST_ENV }
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|LD_|DYLD_)/u.test(key)) delete env[key]
  }
  for (const key of LOCATION_KEYS) {
    if (typeof modeled[key] === "string") {
      if (modeled[key].includes("\0")) throw new Error(`unresolved Git location: ${key}`)
      env[key] = modeled[key]
    }
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
}

// A hook answers its host within seconds, so by default each inspection call gets 2 s. The protected-checkout guard passes what is left of its whole-command budget; callers off the hook path, such as the detached workspace repair, pass a longer limit.
export const INSPECTION_TIMEOUT_MS = 2000

// No inspection Git may outlive the process that started it. Three layers, each covering what the one before cannot:
//   1. The timeout above kills the child, but only while this process is alive.
//   2. Each child leads its own process group, and `reapLive` kills every live group when this process exits or receives SIGTERM, SIGINT or SIGHUP. Detaching means a Ctrl-C aimed at the host's group no longer reaches Git on its own; the handler covers that.
//   3. A kernel alarm armed inside the child itself. `perl -e 'alarm ...; exec git ...'` replaces itself with Git, and a pending alarm survives exec, so the kernel delivers SIGALRM to Git at the deadline whether or not any parent is alive. This is the only layer that covers a SIGKILLed parent or a host that kills just the hook PID: a Git blocked in open() on a FIFO, a stalled network filesystem or a locked include would otherwise stay blocked forever.
// The alarm adds no process (perl becomes Git) and runs one second after the parent's own timeout so it never races it. Windows has neither process groups nor perl, so there the first two layers are reduced to killing the child itself.
const WATCHDOG_SCRIPT = 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or do { print STDERR "exec failed: $!\n"; exit 127 }'
const WATCHDOG_CANDIDATES = ["/usr/bin/perl", "/usr/local/bin/perl", "/opt/homebrew/bin/perl"]
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"]

export function isExecutable(file) {
  try { accessSync(file, constants.X_OK); return true } catch { return false }
}

export function resolveWatchdog({ platform = process.platform, accessible = isExecutable } = {}) {
  return platform === "win32" ? undefined : WATCHDOG_CANDIDATES.find(accessible)
}

export function watchdogSeconds(timeoutMs) {
  return Math.ceil(timeoutMs / 1000) + 1
}

const liveChildren = new Set()
const signalHandlers = new Map()

/** Where the child runs: its own process group everywhere but Windows, which has none. */
export function inspectionSpawnOptions(platform = process.platform) {
  return { detached: platform !== "win32" }
}

/** The command line for one inspection read: Git behind the alarm wrapper when there is one, else Git itself. The wrapper is perl, which reads these variables as code and library paths, so they are not input either. */
export function inspectionCommand({ watchdog, git, args, timeoutMs, env }) {
  if (!watchdog) return { file: git, argv: args }
  for (const key of Object.keys(env)) if (/^PERL/u.test(key)) delete env[key]
  return { file: watchdog, argv: ["-e", WATCHDOG_SCRIPT, String(watchdogSeconds(timeoutMs)), git, ...args] }
}

export function killProcessGroup(child, { kill = process.kill, platform = process.platform } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (platform === "win32") child.kill("SIGKILL")
    else kill(-child.pid, "SIGKILL")
  } catch {
    try { child.kill("SIGKILL") } catch { /* already gone */ }
  }
}

export function liveInspectionChildren() {
  return liveChildren.size
}

function reapLive() {
  for (const child of liveChildren) killProcessGroup(child)
  liveChildren.clear()
}

/** Kill every live inspection Git, then let the signal take its normal course. Our listener only cleans up: when no other listener handles the signal, deliver it again so the default action still ends the process. */
export function reapOnSignal(sig, { listenerCount = (name) => process.listenerCount(name), kill = process.kill } = {}) {
  reapLive()
  removeReaper()
  if (listenerCount(sig) === 0) kill(process.pid, sig)
}

function installReaper() {
  if (signalHandlers.size > 0) return
  process.on("exit", reapLive)
  for (const sig of SIGNALS) {
    const handler = () => reapOnSignal(sig)
    signalHandlers.set(sig, handler)
    process.on(sig, handler)
  }
}

function removeReaper() {
  process.removeListener("exit", reapLive)
  for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler)
  signalHandlers.clear()
}

function track(child) {
  liveChildren.add(child)
  installReaper()
  child.once("close", () => {
    liveChildren.delete(child)
    if (liveChildren.size === 0) removeReaper()
  })
}

export function readInspectionGit(cwd, args, modeled, { signal, timeoutMs = INSPECTION_TIMEOUT_MS } = {}) {
  trustedGit ??= resolveInspectionGit()
  const env = inspectionEnvironment(modeled)
  const { file, argv } = inspectionCommand({ watchdog: resolveWatchdog(), git: trustedGit, args, timeoutMs, env })
  return new Promise((resolve, reject) => {
    let outcome
    // Abort can call the callback before the process and pipes are closed.
    // Settle only after close; this exact child never runs repository hooks.
    const child = execFile(file, argv, { cwd, env, signal, killSignal: "SIGKILL", encoding: "utf8", timeout: Math.max(1, Math.ceil(timeoutMs)), maxBuffer: 1024 * 1024, windowsHide: true, ...inspectionSpawnOptions() }, (error, stdout, stderr) => {
      outcome = { error, stdout, stderr }
    })
    track(child)
    child.once("close", () => {
      const { error, stdout, stderr } = outcome
      // execFile reports its own timeout only as a SIGKILLed "Command failed"; name the cause so a retained resource explains itself.
      if (error?.killed && error.code === null && !signal?.aborted) {
        reject(Object.assign(new Error(`Git inspection timed out after ${timeoutMs} ms: git ${args.join(" ")}`), { code: "ETIMEDOUT", cause: error }))
        return
      }
      if (error && (error.killed || typeof error.code !== "number")) { reject(error); return }
      resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim(), code: error?.code })
    })
  })
}
