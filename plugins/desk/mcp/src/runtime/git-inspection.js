import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import * as path from "node:path"

// Capture the host environment, never the proposed command's environment. In
// particular PATH, executable search paths and loader variables are not input.
const HOST_ENV = { ...process.env }
const LOCATION_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE"]
let trustedGit

export function resolveInspectionGit({ platform = process.platform, env = HOST_ENV, accessible = (file) => {
  try { accessSync(file, constants.X_OK); return true } catch { return false }
} } = {}) {
  const candidates = platform === "win32"
    ? [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean).map((root) => path.win32.join(root, "Git", "cmd", "git.exe"))
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

export function readInspectionGit(cwd, args, modeled, { signal } = {}) {
  trustedGit ??= resolveInspectionGit()
  const env = inspectionEnvironment(modeled)
  return new Promise((resolve, reject) => {
    let outcome
    // Abort can call the callback before the process and pipes are closed.
    // Settle only after close; this exact child never runs repository hooks.
    const child = execFile(trustedGit, args, { cwd, env, signal, killSignal: "SIGKILL", encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      outcome = { error, stdout, stderr }
    })
    child.once("close", () => {
      const { error, stdout, stderr } = outcome
      if (error && (error.killed || typeof error.code !== "number")) { reject(error); return }
      resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim(), code: error?.code })
    })
  })
}
