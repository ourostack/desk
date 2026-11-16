// Finds Copilot runtimes started without Desk's plugin: the app starts runtimes with no plugins at all, and Agency skips a plugin with no cached copy whose GitHub lookup is rate limited (403), as happened to desk@release when many sessions resumed together after a reboot (boot's stale-Desk refresh had removed Desk's cached copy; it no longer does). A session served by one has no Desk tools or hooks, so nothing Desk-side can warn it from inside;
// `drains.js runtimes status` is the outside check, and its lines say how to recover.
import { execFileSync } from "node:child_process"

const RUNTIME = /^\S*\/copilot-runtime(?:\s|$)/u
const SERVER = /\s--server(?:\s|$)/u
const PLUGIN_DIR = /--plugin-dir\s+\S*\/desk(?:\s|$)/u

/** The `pid command` lines of `ps` that are Copilot server runtimes without a Desk plugin directory. */
export function findPluginlessRuntimes(psText) {
  const found = []
  for (const line of psText.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (!match) continue
    const [, pid, command] = match
    if (RUNTIME.test(command) && SERVER.test(command) && !PLUGIN_DIR.test(command)) found.push(Number(pid))
  }
  return found
}

/** Windows has no `ps`; the check reports nothing there rather than failing. */
export function listProcesses(platform = process.platform) {
  if (platform === "win32") return ""
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true })
}

/** One line per finding for `status`; a healthy host gets one line saying so. */
export function pluginlessRuntimeLines(pids) {
  if (pids.length === 0) return ["runtimes: every Copilot server runtime has Desk's plugin"]
  return [
    `runtimes: ${pids.length} Copilot server runtime(s) run without Desk's plugin (pid ${pids.join(", ")}); sessions they serve have no desk-* tools, hooks or boot text`,
    "runtimes: recover by resuming each affected session through Agency once the GitHub API quota has reset (check `gh api rate_limit`; the runtime it then starts carries --plugin-dir for Desk), or start a new session; never wait for the tools to appear or restart the Copilot app",
  ]
}
