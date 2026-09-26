// Shared helpers for tests that start Desk over stdio the way a host does and time the MCP handshake.
//
// Every spawned process gets a temporary HOME, desk root, cache and runtime cache and an environment built from scratch, so no test writes into the real ~/.cache or ~/.local/state and no host or coverage setting leaks into the child.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

export const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
export const pluginRoot = path.resolve(mcpRoot, "..")
export const bootstrapPath = path.join(mcpRoot, "bootstrap.cjs")
export const indexPath = path.join(mcpRoot, "index.js")

/** A temporary HOME, desk root and cache directories for one spawned process. */
export async function makeIsolatedHome(prefix = "desk-handshake-") {
  const root = await mkTempRoot(prefix)
  const home = path.join(root, "home")
  const desk = path.join(root, "desk")
  const cache = path.join(root, "cache")
  const runtimeCache = path.join(root, "runtime-cache")
  for (const dir of [home, desk, cache, runtimeCache]) mkdirSync(dir, { recursive: true })
  return { root, home, desk, cache, runtimeCache }
}

/**
 * An environment built from scratch: nothing from the test process leaks in except TMPDIR.
 * On Windows the system variables a process needs to start are kept, and the per-user folders point into the fixture.
 */
export function isolatedEnv({ home, desk, cache, runtimeCache }, overrides = {}) {
  const windows = process.platform === "win32"
    ? {
        SystemRoot: process.env.SystemRoot,
        windir: process.env.windir,
        ComSpec: process.env.ComSpec,
        PATHEXT: process.env.PATHEXT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        PATH: [path.dirname(process.execPath), process.env.SystemRoot && path.join(process.env.SystemRoot, "System32")].filter(Boolean).join(";"),
      }
    : {}
  const env = {
    HOME: home,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    DESK_RUNTIME_CACHE_DIR: runtimeCache,
    DESK_NODE_SYSTEM_PREFIX: path.join(home, "no-system-node"),
    NODE_OPTIONS: "",
    PATH: "/usr/bin:/bin",
    ...(desk === undefined ? {} : { DESK: desk }),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...windows,
    ...overrides,
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  return env
}

function send(child, id, method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
}

/**
 * Start `command args` over stdio, then send initialize, tools/list and a desk_status call.
 * Resolves with the three responses, the handshake time (spawn to tools/list reply) and stderr.
 */
export function runHandshake({ command, args = [], env, cwd, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    const responses = new Map()
    let stdout = ""
    let stderr = ""
    let handshakeMs = null
    let settled = false
    // Close stdin first, the way a host ends a session: Desk and any Node it re-executed exit on their own and release the fixture folder (Windows refuses to remove a folder a running process uses). SIGTERM only if they have not exited within 5 s.
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const done = () => (error ? reject(error) : resolve(value))
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }
      const killTimer = setTimeout(() => child.kill("SIGTERM"), 5000)
      child.once("exit", () => {
        clearTimeout(killTimer)
        done()
      })
      child.stdin.end()
    }
    const timer = setTimeout(() => {
      finish(new Error(`no complete handshake within ${timeoutMs} ms; stdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.on("error", (error) => finish(error))
    child.on("exit", (code, signal) => {
      if (!responses.has(3)) {
        finish(new Error(`process exited (code=${code}, signal=${signal}) before the handshake finished; stdout:\n${stdout}\nstderr:\n${stderr}`))
      }
    })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8") })
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
      const lines = stdout.split("\n")
      for (const line of lines.slice(0, -1)) {
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === undefined || responses.has(message.id)) continue
        responses.set(message.id, message)
        if (message.id === 1) {
          // Paced like a real host: notifications/initialized and tools/list are separate writes with a gap between them.
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
          setTimeout(() => send(child, 2, "tools/list"), 30)
        } else if (message.id === 2) {
          handshakeMs = Date.now() - started
          send(child, 3, "tools/call", { name: "desk_status", arguments: {} })
        } else if (message.id === 3) {
          finish(null, {
            initialize: responses.get(1),
            tools: responses.get(2),
            status: responses.get(3),
            handshakeMs,
            stderr,
          })
        }
      }
    })
    send(child, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "desk-handshake-test", version: "1.0.0" },
    })
  })
}

/** Parse the JSON payload of a tools/call response. */
export function toolPayload(response) {
  return JSON.parse(response.result.content[0].text)
}

/**
 * Installed Node binaries by major version: the newest of each major under nvm, plus this process's own Node.
 * Reads the real nvm folder only to find binaries; nothing is written there.
 */
export function installedNodesByMajor() {
  const byMajor = new Map()
  const consider = (version, executable) => {
    const parts = version.replace(/^v/u, "").split(".").map(Number)
    const current = byMajor.get(parts[0])
    if (!current || compareParts(parts, current.parts) > 0) {
      byMajor.set(parts[0], { version: `v${parts.join(".")}`, parts, executable })
    }
  }
  // The account home from the password database, not $HOME: tests run under a temporary HOME.
  const nvmDir = process.env.NVM_DIR || path.join(os.userInfo().homedir, ".nvm")
  const versionsRoot = path.join(nvmDir, "versions", "node")
  if (existsSync(versionsRoot)) {
    for (const entry of readdirSync(versionsRoot)) {
      const executable = path.join(versionsRoot, entry, "bin", "node")
      if (/^v\d+\.\d+\.\d+$/u.test(entry) && existsSync(executable)) consider(entry, executable)
    }
  }
  consider(process.version, process.execPath)
  return byMajor
}

function compareParts(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}
