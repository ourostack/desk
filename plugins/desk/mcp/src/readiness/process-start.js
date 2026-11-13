// When a process started, as the operating system reports it: together with its PID this names one process, so a PID that a later process reuses is never mistaken for the process that recorded it.
//
// Desk records its own start time next to a PID it owns (a workspace claim, a sync lock). Another session compares it with the start time of whatever process now has that PID: a different start time means the recorded owner has ended.
//
// The value is an opaque string, compared only for equality and read the same way on every read:
// - Linux: `linux:<boot id>:<start ticks>`, from /proc/<pid>/stat field 22 (clock ticks after boot) and the kernel's boot id, which is stable where /proc/stat's boot time can shift by a second;
// - macOS: `darwin:<ISO time>`, from `ps -o lstart= -p <pid>` run with an argument array, in UTC and the C locale so the text never depends on the caller's time zone or language;
// - Windows: `win32:<ISO time>`, from Get-CimInstance Win32_Process's CreationDate.
// Anything else, or a process that cannot be read, gives null: the caller then falls back to the PID alone.
//
// Dependency-free, so the session can run it before and without the runtime pack.

import { execFile, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { win32 as winPath } from "node:path"

// A slow Windows read returns null, so the caller falls back to the PID alone instead of waiting.
const WINDOWS_PROCESS_START_CAP_MS = 5_000
const EXEC_TIMEOUT_MS = { darwin: 5_000, win32: WINDOWS_PROCESS_START_CAP_MS }

/** Run `file args` and resolve with its stdout, or null when it fails, times out or cannot run. */
export function runForText(file, args, { timeout, env }) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout, env, maxBuffer: 16_384, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

/** The synchronous twin of `runForText`, for callers that cannot await (the status lock). */
export function runForTextSync(file, args, { timeout, env }) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout, env, maxBuffer: 16_384, windowsHide: true })
  return result.status === 0 ? result.stdout : null
}

const UNKNOWN_BOOT = "unknown-boot"

// The command name (field 2) is in parentheses and may hold spaces or parentheses itself, so fields are counted after the last ")": field 3 is the first.
function linuxStartFrom(stat, boot) {
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  if (!/^\d+$/u.test(ticks ?? "")) return null
  return `linux:${boot}:${ticks}`
}

async function linuxStart(pid, { read = readFile } = {}) {
  let stat
  try {
    stat = await read(`/proc/${pid}/stat`, "utf8")
  } catch {
    return null
  }
  let boot = UNKNOWN_BOOT
  try {
    boot = (await read("/proc/sys/kernel/random/boot_id", "utf8")).trim() || boot
  } catch {
    // A kernel without a boot id: the ticks alone still tell processes of this boot apart.
  }
  return linuxStartFrom(stat, boot)
}

function linuxStartSync(pid, { read = readFileSync } = {}) {
  let stat
  try {
    stat = read(`/proc/${pid}/stat`, "utf8")
  } catch {
    return null
  }
  let boot = UNKNOWN_BOOT
  try {
    boot = read("/proc/sys/kernel/random/boot_id", "utf8").trim() || boot
  } catch {
    // A kernel without a boot id: the ticks alone still tell processes of this boot apart.
  }
  return linuxStartFrom(stat, boot)
}

function darwinStartFrom(text) {
  const when = Date.parse(`${(text ?? "").trim()} UTC`)
  return Number.isFinite(when) ? `darwin:${new Date(when).toISOString()}` : null
}

async function darwinStart(pid, { run = runForText } = {}) {
  return darwinStartFrom(await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: EXEC_TIMEOUT_MS.darwin, env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" } }))
}

function darwinStartSync(pid, { run = runForTextSync } = {}) {
  return darwinStartFrom(run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: EXEC_TIMEOUT_MS.darwin, env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" } }))
}

/** The operating system's own Windows PowerShell, from SystemRoot (any letter case, then windir, then C:\Windows), never from PATH: a child with a trimmed environment has no System32 on its PATH. */
export function windowsPowerShellPath(env = process.env) {
  const value = (name) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name && typeof env[candidate] === "string" && env[candidate].trim() !== "")
    return key === undefined ? undefined : env[key].trim()
  }
  const root = [value("systemroot"), value("windir")].find((candidate) => candidate !== undefined && winPath.isAbsolute(candidate)) ?? "C:\\Windows"
  return winPath.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

function win32StartFrom(text) {
  const when = Date.parse((text ?? "").trim())
  return Number.isFinite(when) ? `win32:${new Date(when).toISOString()}` : null
}

function win32Script(pid) {
  return `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o") }`
}

async function win32Start(pid, { run = runForText, env = process.env } = {}) {
  return win32StartFrom(await run(windowsPowerShellPath(env), ["-NoProfile", "-NonInteractive", "-Command", win32Script(pid)], { timeout: EXEC_TIMEOUT_MS.win32, env }))
}

function win32StartSync(pid, { run = runForTextSync, env = process.env } = {}) {
  return win32StartFrom(run(windowsPowerShellPath(env), ["-NoProfile", "-NonInteractive", "-Command", win32Script(pid)], { timeout: EXEC_TIMEOUT_MS.win32, env }))
}

async function unsupportedStart() {
  return null
}

export const processStartReaders = { linux: linuxStart, darwin: darwinStart, win32: win32Start }
const processStartReadersSync = { linux: linuxStartSync, darwin: darwinStartSync, win32: win32StartSync }

/** The start time of process `pid`, or null when it cannot be read (no such process, an unsupported platform or a failed read). */
export async function readProcessStart(pid, { platform = process.platform, ...deps } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const reader = Object.hasOwn(processStartReaders, platform) ? processStartReaders[platform] : unsupportedStart
  return reader(pid, deps)
}

/** `readProcessStart` for synchronous callers: the same value, read with blocking calls. */
export function readProcessStartSync(pid, { platform = process.platform, ...deps } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  return Object.hasOwn(processStartReadersSync, platform) ? processStartReadersSync[platform](pid, deps) : null
}

let selfStart = null

/** This process's own start time, read once. */
export function readOwnProcessStart({ pid = process.pid, read = readProcessStart } = {}) {
  selfStart ??= Promise.resolve().then(() => read(pid)).catch(() => null)
  return selfStart
}

/** Forget the cached value (tests only). */
export function resetOwnProcessStart() {
  selfStart = null
}
