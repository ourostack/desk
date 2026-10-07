import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import * as path from "node:path"

// Capture the host environment once. In particular PATH, executable search paths and loader variables are not input.
const HOST_ENV = { ...process.env }
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

function inspectionEnvironment() {
  const env = { ...HOST_ENV }
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|LD_|DYLD_)/u.test(key)) delete env[key]
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
}

// A hook answers its host within seconds, so by default each inspection call gets 2 s. Callers off the hook path, such as the detached workspace repair, pass a longer limit.
export const INSPECTION_TIMEOUT_MS = 2000

// No inspection Git may outlive the process that started it. Three layers, each covering what the one before cannot:
//   1. The timeout above kills the child, but only while this process is alive.
//   2. Each child leads its own process group, and `reapLive` kills every live group when this process exits or receives SIGTERM, SIGINT or SIGHUP. Detaching means a Ctrl-C aimed at the host's group no longer reaches Git on its own; the handler covers that.
//   3. A kernel alarm armed inside the child itself. `perl -e 'alarm ...; exec git ...'` replaces itself with Git, and a pending alarm survives exec, so the kernel delivers SIGALRM to Git at the deadline whether or not any parent is alive. This is the only layer that covers a SIGKILLed parent or a host that kills just the hook PID: a Git blocked in open() on a FIFO, a stalled network filesystem or a locked include would otherwise stay blocked forever.
// The alarm adds no process (perl becomes Git) and runs one second after the parent's own timeout so it never races it. Windows has neither process groups nor perl, so there the first two layers are reduced to killing the child itself.
const MAX_OUTPUT = 1024 * 1024
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

/** The command line for one inspection read: Git behind the alarm wrapper when there is one, else Git itself. The wrapper is perl, which reads PERL* variables as code and library paths, so they are not input either; the caller's environment is copied, never changed. Git's progress meter uses setitimer(ITIMER_REAL), which would replace the alarm, but the guard's read-only commands never show progress. */
export function inspectionCommand({ watchdog, git, args, timeoutMs, env }) {
  if (!watchdog) return { file: git, argv: args, env }
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^PERL/u.test(key)))
  return { file: watchdog, argv: ["-e", WATCHDOG_SCRIPT, String(watchdogSeconds(timeoutMs)), git, ...args], env: clean }
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

// Set once the wrapper itself fails to run (perl missing at its path, not executable, or exec failed before Git started). From then on every read in this process runs bare Git, so a broken perl never looks like a Git failure.
let watchdogBroken = false

export function watchdogIsBroken() {
  return watchdogBroken
}

export function resetWatchdogForTests() {
  watchdogBroken = false
}

// perl prints "exec failed" and exits 127 when it cannot exec Git; a spawn error (ENOENT, EACCES) means perl itself would not start. Neither says anything about the repository.
function wrapperFailed({ error, stderr, timedOut, aborted }) {
  if (!error || timedOut || aborted) return false
  if (error.code === 127) return stderr.startsWith("exec failed:")
  return failedToSpawn(error)
}

function failedToSpawn(error) {
  return typeof error.code === "string" && error.syscall !== undefined
}

// Spawned directly because execFile drops the `detached` option, so its child would share the host's process group and the group kills below would reach nothing.
function runInspection({ file, argv, env, cwd, signal, timeoutMs }) {
  return new Promise((resolve) => {
    let timedOut = false
    let aborted = false
    let error
    let stdout = ""
    let stderr = ""
    const child = spawn(file, argv, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...inspectionSpawnOptions() })
    track(child)
    // Timeout and abort kill the whole group, as the exit and signal paths do, so a Git helper such as fsmonitor cannot outlive them.
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(child) }, Math.max(1, Math.ceil(timeoutMs)))
    const onAbort = () => { aborted = true; killProcessGroup(child) }
    signal?.addEventListener("abort", onAbort, { once: true })
    const collect = (chunk, which) => {
      if (which === "out") stdout += chunk; else stderr += chunk
      if (stdout.length + stderr.length > MAX_OUTPUT) {
        error ??= Object.assign(new Error("Git inspection output exceeded its limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
        killProcessGroup(child)
      }
    }
    child.stdout.setEncoding("utf8").on("data", (chunk) => collect(chunk, "out"))
    child.stderr.setEncoding("utf8").on("data", (chunk) => collect(chunk, "err"))
    // A failed spawn (ENOENT, EACCES) emits "error" and then "close".
    child.once("error", (spawnError) => { error ??= spawnError })
    child.once("close", (code, killedBy) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (!error && killedBy) error = Object.assign(new Error(`Command failed: killed by ${killedBy}`), { code: null, killed: true, signal: killedBy })
      else if (!error && code !== 0) error = Object.assign(new Error(`Command failed with exit code ${code}`), { code })
      resolve({ error, stdout, stderr, timedOut, aborted })
    })
  })
}

export async function readInspectionGit(cwd, args, { signal, timeoutMs = INSPECTION_TIMEOUT_MS, watchdog = watchdogBroken ? undefined : resolveWatchdog() } = {}) {
  trustedGit ??= resolveInspectionGit()
  const env = inspectionEnvironment()
  if (signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })
  const command = inspectionCommand({ watchdog, git: trustedGit, args, timeoutMs, env })
  let result = await runInspection({ ...command, cwd, signal, timeoutMs })
  if (command.file !== trustedGit && wrapperFailed(result)) {
    result = await runInspection({ file: trustedGit, argv: args, env, cwd, signal, timeoutMs })
    // A spawn that fails for bare Git too (a missing cwd, say) says nothing about perl.
    watchdogBroken = !(result.error && failedToSpawn(result.error))
  }
  const { error, stdout, stderr, timedOut, aborted } = result
  // A killed child is reported only as a SIGKILLed "Command failed"; name the cause so a retained resource explains itself.
  if (timedOut && error) throw Object.assign(new Error(`Git inspection timed out after ${timeoutMs} ms: git ${args.join(" ")}`), { code: "ETIMEDOUT", cause: error })
  if (aborted && error) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: error })
  if (error && (error.killed || typeof error.code !== "number")) throw error
  return { ok: !error, stdout: stdout.trim(), stderr: stderr.trim(), code: error?.code }
}
