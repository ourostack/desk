// Run a plugin's hooks the way each host does: read the host's hook manifest, pick the command for this platform, expand the
// plugin root, pipe the host-shaped payload on stdin and enforce the manifest's timeout.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { WINDOWS } from "./world.mjs"

let gitBash
// Claude Code on Windows runs hook commands in Git Bash; the System32 bash.exe is the WSL relay, so it is skipped.
function bashPath() {
  if (!WINDOWS) return "bash"
  if (gitBash !== undefined) return gitBash
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ]
  const where = spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true })
  if (where.status === 0) for (const line of where.stdout.split(/\r?\n/u).filter(Boolean)) candidates.push(path.join(path.dirname(path.dirname(line)), "bin", "bash.exe"))
  gitBash = candidates.find((file) => fs.existsSync(file)) ?? "bash"
  return gitBash
}

/** Hook entries of one event in a manifest, flattened to { command, shell, timeoutMs }. */
export function hookEntries({ host, pluginRoot, manifestPath, event }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  const groups = manifest.hooks?.[event] ?? []
  const entries = []
  if (host === "copilot") {
    for (const entry of groups) {
      if (entry.type !== "command") continue
      const raw = WINDOWS ? entry.powershell : entry.bash
      if (typeof raw !== "string") continue
      entries.push({ command: raw.split("${PLUGIN_ROOT}").join(pluginRoot), shell: WINDOWS ? "powershell" : "bash", timeoutMs: (entry.timeoutSec ?? 30) * 1000, matcher: entry.matcher })
    }
  } else {
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        if (entry.type !== "command") continue
        const windowsCommand = WINDOWS && typeof entry.commandWindows === "string"
        const raw = windowsCommand ? entry.commandWindows : entry.command
        entries.push({
          command: windowsCommand ? raw : raw.split("${CLAUDE_PLUGIN_ROOT}").join(pluginRoot.split(path.sep).join("/")),
          shell: windowsCommand ? "powershell" : "bash",
          timeoutMs: (entry.timeout ?? 60) * 1000,
          matcher: group.matcher,
        })
      }
    }
  }
  return entries
}

/** Run one hook command. Resolves to { code, stdout, stderr, ms, timedOut }. */
export function runHook({ command, shell, timeoutMs }, { env, cwd, payload }) {
  return new Promise((resolve) => {
    const started = performance.now()
    const [file, args] = shell === "powershell"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]]
      : [bashPath(), ["-c", command]]
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs + 2000)
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => { stderr += `spawn error: ${error.message}` })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: performance.now() - started, timedOut, overBudget: performance.now() - started > timeoutMs })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload))
  })
}

/** The context text a hook handed the host, in either host's output shape. */
export function hookContext(stdout) {
  const text = stdout.trim()
  if (text === "") return ""
  try {
    const parsed = JSON.parse(text)
    return parsed.hookSpecificOutput?.additionalContext ?? parsed.additionalContext ?? parsed.additional_context ?? ""
  } catch {
    return text
  }
}
