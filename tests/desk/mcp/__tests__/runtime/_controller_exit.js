// A Desk session leaves its readiness controller child to end on its own: the child is unref'd, shared by every session on a root, and closes after its parent's IPC channel drops. So a session that has exited does not mean its controller has. The controller holds the derived index (desk-index.sqlite and its WAL and SHM files) open, and Windows refuses to delete a file a process still holds. A test that removes a fixture must therefore wait for the controller's process to be gone, never retry the delete.
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The PIDs of the readiness controller children whose owner.json lies under any of `roots`. A missing or half-written record names no one. */
export function controllerPids(roots, { depth = 8, read = readFileSync, list = readdirSync } = {}) {
  const found = new Set()
  const walk = (directory, remaining) => {
    let entries
    try {
      entries = list(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return
      throw error
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (remaining > 0 && entry.name !== "node_modules") walk(file, remaining - 1)
      } else if (entry.name === "owner.json") {
        try {
          const { owner } = JSON.parse(read(file, "utf8"))
          if (owner?.kind === "controller_child" && Number.isInteger(owner.pid)) found.add(owner.pid)
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
        }
      }
    }
  }
  for (const root of roots) walk(root, depth)
  return [...found]
}

/** Whether a process with this PID exists. Signal 0 sends nothing: ESRCH means gone, EPERM means it exists but belongs to someone else. */
export function processAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    if (error.code === "EPERM") return true
    throw error
  }
}

/** Resolve once every PID is gone, or reject naming the ones still alive after `timeoutMs`. */
export async function waitForProcessesGone(pids, { timeoutMs = 30000, intervalMs = 25, alive = processAlive, wait = pause, now = Date.now } = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    const running = pids.filter((pid) => alive(pid))
    if (running.length === 0) return
    if (now() >= deadline) throw new Error(`readiness controller process ${running.join(", ")} is still running ${timeoutMs} ms after its session ended; it holds the derived index open`)
    await wait(intervalMs)
  }
}

/** Throws unless every PID is gone: the check a test makes immediately before it deletes a fixture. */
export function assertProcessesGone(pids, alive = processAlive) {
  const running = pids.filter((pid) => alive(pid))
  if (running.length > 0) throw new Error(`readiness controller process ${running.join(", ")} is still running; deleting its derived index now fails on Windows`)
}
