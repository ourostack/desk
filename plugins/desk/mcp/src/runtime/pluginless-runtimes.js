// Finds Copilot runtimes started without Desk's plugin. A session served by one has no Desk tools or hooks, so nothing Desk-side can warn it from inside;
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

export function listProcesses() {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
}

/** One line per finding for `status`; a healthy host gets one line saying so. */
export function pluginlessRuntimeLines(pids) {
  if (pids.length === 0) return ["runtimes: every Copilot server runtime has Desk's plugin"]
  return [
    `runtimes: ${pids.length} Copilot server runtime(s) run without Desk's plugin (pid ${pids.join(", ")}); sessions they serve have no desk-* tools, hooks or boot text`,
    "runtimes: recover by resuming each affected session through Agency (the runtime it starts carries --plugin-dir for Desk), or start a new session; never wait for the tools to appear or restart the Copilot app",
  ]
}
