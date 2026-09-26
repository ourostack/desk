// A long-lived MCP session over stdio for tests that keep talking to one Desk process: fix a condition while it runs, then ask again.
//
// Callers pass an isolated environment (see isolatedEnv in _mcp_handshake.js), so the spawned process never writes into the real ~/.cache or ~/.local/state.

import { spawn } from "node:child_process"

/**
 * Spawn `command args`, complete the initialize handshake and the first tools/list, and return a session.
 * `handshakeMs` is the time from spawn to the tools/list reply.
 */
export async function openSession({ command, args = [], env, cwd, timeoutMs = 20000, paceMs = 30 }) {
  const started = Date.now()
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  const waiting = new Map()
  const notifications = []
  let nextId = 1
  let stdout = ""
  let stderr = ""
  let exited = null
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8") })
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8")
    let newline
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === undefined) {
        notifications.push(message)
        continue
      }
      const entry = waiting.get(message.id)
      if (entry) {
        waiting.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      }
    }
  })
  child.on("exit", (code, signal) => {
    exited = { code, signal }
    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`process exited (code=${code}, signal=${signal}) before answering request ${id}; stderr:\n${stderr}`))
    }
    waiting.clear()
  })

  function request(method, params = {}, { timeout = timeoutMs } = {}) {
    if (exited) return Promise.reject(new Error(`process already exited (code=${exited.code}); stderr:\n${stderr}`))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`no answer to ${method} within ${timeout} ms; stderr:\n${stderr}`))
      }, timeout)
      waiting.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  async function call(name, args = {}, options) {
    const response = await request("tools/call", { name, arguments: args }, options)
    if (response.error) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`)
    return { isError: response.result.isError === true, payload: JSON.parse(response.result.content[0].text) }
  }

  /** Call desk_status until `predicate(payload)` holds, or fail with the last payload after `deadlineMs`. */
  async function statusUntil(predicate, { deadlineMs = 20000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + deadlineMs
    let last
    for (;;) {
      last = (await call("desk_status")).payload
      if (predicate(last)) return last
      if (Date.now() > deadline) {
        throw new Error(`desk_status did not reach the expected state within ${deadlineMs} ms; last:\n${JSON.stringify(last, null, 2)}\nstderr:\n${stderr}`)
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  function close() {
    if (exited) return Promise.resolve(exited)
    return new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
      child.stdin.end()
      setTimeout(() => { if (!exited) child.kill("SIGTERM") }, 2000).unref()
    })
  }

  const initialize = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "desk-session-test", version: "1.0.0" },
  })
  // Paced like a real host: notifications/initialized and tools/list are separate writes with a gap between them.
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  await new Promise((resolve) => setTimeout(resolve, paceMs))
  const tools = await request("tools/list")
  const handshakeMs = Date.now() - started
  /** Send `method` and resolve with how long its answer took, in ms. */
  async function timed(method, params = {}, options) {
    const sent = Date.now()
    const response = await request(method, params, options)
    return { ms: Date.now() - sent, response }
  }

  return {
    child,
    initialize,
    timed,
    tools,
    handshakeMs,
    notifications,
    request,
    call,
    statusUntil,
    close,
    stderr: () => stderr,
  }
}
