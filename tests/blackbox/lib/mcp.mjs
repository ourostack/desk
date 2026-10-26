// A minimal MCP client over stdio, the way a host speaks to a server: newline-delimited JSON-RPC on the child's stdin and stdout.
// It depends on nothing but Node, so the tester never loads Desk's own modules or packages.

import { spawn } from "node:child_process"
import { RssSampler } from "./proc.mjs"

export class McpSession {
  constructor({ command, args, cwd, env, name }) {
    this.name = name
    this.started = performance.now()
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ""
    this.notifications = []
    this.exited = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })))
    this.exitInfo = null
    this.exited.then((info) => {
      this.exitInfo = info
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error(`${name} exited (code ${info.code}, signal ${info.signal}) before answering; stderr tail: ${this.stderr.slice(-600)}`))
      }
      this.pending.clear()
    })
    this.child.on("error", (error) => { this.stderr += `spawn error: ${error.message}\n` })
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-20000) })
    let buffer = ""
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let index
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id !== undefined && this.pending.has(message.id) && (message.result !== undefined || message.error !== undefined)) {
          const { resolve, timer } = this.pending.get(message.id)
          clearTimeout(timer)
          this.pending.delete(message.id)
          resolve(message)
        } else if (message.method !== undefined && message.id !== undefined) {
          // A request from the server (roots/list, ping): answer the way a host with no roots does.
          const result = message.method === "roots/list" ? { roots: [] } : {}
          this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)
        } else if (message.method !== undefined) {
          this.notifications.push(message)
        }
      }
    })
    this.rss = new RssSampler(this.child.pid)
  }

  request(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (this.exitInfo) {
        reject(new Error(`${this.name} already exited (code ${this.exitInfo.code}); stderr tail: ${this.stderr.slice(-600)}`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name} did not answer ${method} within ${timeoutMs} ms; stderr tail: ${this.stderr.slice(-600)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  /** initialize + initialized + tools/list, timed from spawn. */
  async handshake(clientName) {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: clientName, version: "blackbox" },
    })
    this.initializeMs = performance.now() - this.started
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
    this.notify("notifications/initialized")
    const list = await this.request("tools/list")
    this.toolsListMs = performance.now() - this.started
    if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`)
    this.serverInfo = init.result.serverInfo
    this.instructions = init.result.instructions ?? ""
    this.tools = list.result.tools
    return { init: init.result, tools: list.result.tools }
  }

  /** tools/call. Resolves to { isError, text, json, ms }; json is the parsed text when it is JSON. */
  async call(name, args = {}, timeoutMs = 60000) {
    const started = performance.now()
    const response = await this.request("tools/call", { name, arguments: args }, timeoutMs)
    const ms = performance.now() - started
    if (response.error) return { isError: true, protocolError: response.error, text: response.error.message ?? "", json: null, ms }
    const content = response.result.content ?? []
    const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    let json = response.result.structuredContent ?? null
    if (json === null) {
      try { json = JSON.parse(text) } catch { json = null }
    }
    return { isError: response.result.isError === true, text, json, ms, raw: response.result }
  }

  /** Close stdin the way a host ends a session, then wait; SIGTERM, then SIGKILL, only if it does not exit. */
  async close(graceMs = 8000) {
    this.rss.stop()
    if (this.exitInfo) return this.exitInfo
    try { this.child.stdin.end() } catch { /* already closed */ }
    const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms))
    let info = await Promise.race([this.exited, timeout(graceMs)])
    if (info === null) {
      this.child.kill("SIGTERM")
      info = await Promise.race([this.exited, timeout(3000)])
      if (info === null) {
        this.child.kill("SIGKILL")
        info = await this.exited
      }
      info = { ...info, forced: true }
    }
    return info
  }
}
