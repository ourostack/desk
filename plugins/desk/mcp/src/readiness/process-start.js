// When a process started, as the operating system reports it: together with its PID this names one process, so a PID that a later process reuses is never mistaken for the process that recorded it.
//
// Desk records its own start time in a readiness controller's owner.json when it is elected. Another session compares it with the start time of whatever process now has that PID: a different start time means the recorded owner has ended (see owner-record.js).
//
// The value is an opaque string, compared only for equality and read the same way on every read:
// - Linux: `linux:<boot id>:<start ticks>`, from /proc/<pid>/stat field 22 (clock ticks after boot) and the kernel's boot id, which is stable where /proc/stat's boot time can shift by a second;
// - macOS: `darwin:<ISO time>`, from `ps -o lstart= -p <pid>` run with an argument array, in UTC and the C locale so the text never depends on the caller's time zone or language;
// - Windows: `win32:<ISO time>`, from Get-CimInstance Win32_Process's CreationDate.
// Anything else, or a process that cannot be read, gives null: the caller then falls back to the PID alone.
//
// Dependency-free, so the session can run it before and without the runtime pack.

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"

const EXEC_TIMEOUT_MS = { darwin: 5_000, win32: 15_000 }

/** Run `file args` and resolve with its stdout, or null when it fails, times out or cannot run. */
export function runForText(file, args, { timeout, env }) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout, env, maxBuffer: 16_384, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

async function linuxStart(pid, { read = readFile } = {}) {
  let stat
  try {
    stat = await read(`/proc/${pid}/stat`, "utf8")
  } catch {
    return null
  }
  // The command name (field 2) is in parentheses and may hold spaces or parentheses itself, so fields are counted after the last ")": field 3 is the first.
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  if (!/^\d+$/u.test(ticks ?? "")) return null
  let boot = "unknown-boot"
  try {
    boot = (await read("/proc/sys/kernel/random/boot_id", "utf8")).trim() || boot
  } catch {
    // A kernel without a boot id: the ticks alone still tell processes of this boot apart, and owner-record.js rejects owners from an earlier boot by time.
  }
  return `linux:${boot}:${ticks}`
}

async function darwinStart(pid, { run = runForText } = {}) {
  const text = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    timeout: EXEC_TIMEOUT_MS.darwin,
    env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
  })
  const when = Date.parse(`${(text ?? "").trim()} UTC`)
  return Number.isFinite(when) ? `darwin:${new Date(when).toISOString()}` : null
}

async function win32Start(pid, { run = runForText, env = process.env } = {}) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o") }`
  const text = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: EXEC_TIMEOUT_MS.win32,
    env,
  })
  const when = Date.parse((text ?? "").trim())
  return Number.isFinite(when) ? `win32:${new Date(when).toISOString()}` : null
}

async function unsupportedStart() {
  return null
}

export const processStartReaders = { linux: linuxStart, darwin: darwinStart, win32: win32Start }

/** The start time of process `pid`, or null when it cannot be read (no such process, an unsupported platform or a failed read). */
export async function readProcessStart(pid, { platform = process.platform, ...deps } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const reader = Object.hasOwn(processStartReaders, platform) ? processStartReaders[platform] : unsupportedStart
  return reader(pid, deps)
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
