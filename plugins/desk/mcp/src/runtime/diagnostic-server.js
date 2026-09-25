import { diagnosticFormat, previewRuntimeSnapshot } from "./preview-snapshot.js"
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from "../tool-names.js"

// Tools that answer in diagnostic mode; every other tool is listed but gated.
const diagnosticToolNames = ["desk_status", "desk_doctor"]

// The full tool set from the start, in the same order and shape as the healthy server, so a host that caches the first tools/list never loses a tool once Desk recovers.
const diagnosticTools = TOOL_NAMES.map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: name === "desk_doctor"
    ? {
        type: "object",
        properties: { format: { type: "string", enum: ["full", "preview"] } },
        additionalProperties: false,
      }
    : { type: "object", properties: {}, additionalProperties: true },
}))

export function startDiagnosticServer({
  diagnostic,
  input = process.stdin,
  output = process.stdout,
  serverVersion = "0.0.0",
} = {}) {
  return new Promise((resolve, reject) => {
    let buffered = ""
    const onData = (chunk) => {
      buffered += chunk.toString("utf8")
      let newline
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line.length > 0) {
          handleLine({ diagnostic, line, output, serverVersion })
        }
      }
    }
    const onEnd = () => {
      const line = buffered.trim()
      if (line.length > 0) {
        handleLine({ diagnostic, line, output, serverVersion })
      }
      cleanup()
      resolve()
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
}

function handleLine({ diagnostic, line, output, serverVersion }) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    writeResponse(output, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error",
      },
    })
    return
  }
  if (request.id === undefined) {
    return
  }
  const response = dispatchRequest({ diagnostic, request, serverVersion })
  writeResponse(output, {
    jsonrpc: "2.0",
    id: request.id,
    ...response,
  })
}

function dispatchRequest({ diagnostic, request, serverVersion }) {
  if (request.method === "initialize") {
    return {
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "desk-mcp-diagnostic",
          version: serverVersion,
        },
      },
    }
  }
  if (request.method === "ping") {
    return { result: {} }
  }
  if (request.method === "tools/list") {
    return {
      result: {
        tools: diagnosticTools,
      },
    }
  }
  if (request.method === "tools/call") {
    return {
      result: toolResult({
        diagnostic,
        toolName: request.params?.name,
        input: request.params?.arguments,
      }),
    }
  }
  return {
    error: {
      code: -32601,
      message: `Method not found: ${request.method}`,
    },
  }
}

function toolResult({ diagnostic, toolName, input }) {
  if (toolName === "desk_doctor") {
    let format
    try {
      format = diagnosticFormat(input)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      }
    }
    if (format === "preview") {
      return {
        content: [{ type: "text", text: JSON.stringify(previewRuntimeSnapshot("diagnostic")) }],
      }
    }
  }
  if (diagnosticToolNames.includes(toolName)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(diagnostic, null, 2),
        },
      ],
    }
  }
  const rejected = {
    ...diagnostic,
    status: "degraded",
    code: diagnostic.code ?? diagnostic.reason,
    fix: diagnostic.fix
      ?? diagnostic.remediation?.[0]?.message
      ?? "Call desk_doctor for the startup failure and its remediation.",
    tool: toolName ?? null,
    summary: `${toolName ?? "This tool"} is unavailable while Desk is in diagnostic mode.`,
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(rejected, null, 2),
      },
    ],
    isError: true,
  }
}

function writeResponse(output, response) {
  output.write(`${JSON.stringify(response)}\n`)
}
