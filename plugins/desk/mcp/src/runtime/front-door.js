// The front door: a dependency-free MCP server on stdio that Desk starts before anything that can fail or take time.
//
// It answers initialize, ping and tools/list at once, always with the full tool set, so the handshake never waits for the runtime pack, the desk root, authority or the readiness controller, and a host that caches the first tools/list never loses a tool once Desk recovers. Every tools/call goes to the `callTool` it is given, which gates tools by admission state.
//
// It imports only the tool names, so it runs before the runtime pack (and its native modules) is restored.

import { TOOL_DESCRIPTIONS, TOOL_NAMES } from "../tool-names.js"

export const DOCTOR_REPAIRS = Object.freeze(["switch_state_branch", "prune_readiness_state"])

// One tool list for every mode, in the canonical order. desk_doctor keeps its stricter schema.
export const FRONT_DOOR_TOOLS = Object.freeze(TOOL_NAMES.map((name) => Object.freeze({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: name === "desk_doctor"
    ? {
        type: "object",
        properties: {
          format: { type: "string", enum: ["full", "preview"] },
          repair: { type: "string", enum: [...DOCTOR_REPAIRS] },
        },
        additionalProperties: false,
      }
    : { type: "object", properties: {}, additionalProperties: true },
})))

/**
 * Serve MCP on `input`/`output`. `callTool({ name, input, signal })` returns an MCP tool result (or a promise of one).
 * `onHandshake` fires once, after `notifications/initialized` or the first tools/list reply, whichever comes first.
 * Returns `{ closed, notifyToolsChanged }`: `closed` resolves when input ends and every call in flight has answered.
 */
export function startFrontDoor({
  callTool,
  input,
  output,
  serverName = "desk-mcp",
  serverVersion = "0.0.0",
  onHandshake = () => {},
}) {
  const inFlight = new Map()
  const pending = new Set()
  let buffered = ""
  let handshook = false
  let initialized = false

  const signalHandshake = () => {
    if (handshook) return
    handshook = true
    onHandshake()
  }

  const write = (message) => {
    if (output.destroyed || output.writableEnded) return
    output.write(`${JSON.stringify(message)}\n`)
  }

  const answerCall = (id, result) => write({ jsonrpc: "2.0", id, result })
  const failCall = (id, name, error) => answerCall(id, {
    content: [{ type: "text", text: JSON.stringify({ status: "error", tool: name ?? null, message: error instanceof Error ? error.message : String(error) }) }],
    isError: true,
  })

  const handleCall = (request) => {
    const { id } = request
    const name = request.params?.name
    const abort = new AbortController()
    let result
    try {
      result = callTool({ name, input: request.params?.arguments ?? {}, signal: abort.signal })
    } catch (error) {
      failCall(id, name, error)
      return
    }
    if (typeof result?.then !== "function") {
      answerCall(id, result)
      return
    }
    inFlight.set(id, abort)
    const settled = result
      .then((value) => answerCall(id, value), (error) => failCall(id, name, error))
      .finally(() => {
        inFlight.delete(id)
        pending.delete(settled)
      })
    pending.add(settled)
  }

  const handleLine = (line) => {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      return
    }
    if (request.method === "notifications/initialized") {
      initialized = true
      signalHandshake()
      return
    }
    if (request.method === "notifications/cancelled") {
      inFlight.get(request.params?.requestId)?.abort(new Error(request.params?.reason ?? "cancelled by the client"))
      return
    }
    if (request.id === undefined) return
    if (request.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: serverName, version: serverVersion },
        },
      })
      return
    }
    if (request.method === "ping") {
      write({ jsonrpc: "2.0", id: request.id, result: {} })
      return
    }
    if (request.method === "tools/list") {
      write({ jsonrpc: "2.0", id: request.id, result: { tools: FRONT_DOOR_TOOLS } })
      signalHandshake()
      return
    }
    if (request.method === "tools/call") {
      handleCall(request)
      return
    }
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } })
  }

  const closed = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffered += chunk.toString("utf8")
      let newline
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line.length > 0) handleLine(line)
      }
    }
    const onEnd = () => {
      const line = buffered.trim()
      buffered = ""
      if (line.length > 0) handleLine(line)
      cleanup()
      Promise.allSettled([...pending]).then(() => resolve())
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      input.off("data", onData)
      input.off("end", onEnd)
      input.off("error", onError)
    }
    input.on("data", onData)
    input.on("end", onEnd)
    input.on("error", onError)
    input.resume?.()
  })

  return {
    closed,
    /** Tell a host that honours it to list tools again. The list itself never changes; this only prompts hosts that cached a failure. */
    notifyToolsChanged() {
      if (initialized) write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    },
  }
}
