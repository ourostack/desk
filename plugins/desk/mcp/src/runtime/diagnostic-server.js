import { diagnosticFormat, previewRuntimeSnapshot } from "./preview-snapshot.js"
import { FRONT_DOOR_TOOLS, startFrontDoor } from "./front-door.js"

// Tools that answer in diagnostic mode; every other tool is listed but gated.
const diagnosticToolNames = ["desk_status", "desk_doctor"]

// Kept for callers that read the diagnostic tool list: it is the front door's list, the same in every mode.
export const diagnosticTools = FRONT_DOOR_TOOLS

// Diagnostic mode serves a fixed diagnostic: the paths that end here run before the handshake and cannot admit Desk in this process (no compatible Node, a failed re-exec, a startup exception, an overlay that owns onboarding).
export function startDiagnosticServer({
  diagnostic,
  input = process.stdin,
  output = process.stdout,
  serverVersion = "0.0.0",
} = {}) {
  return startFrontDoor({
    input,
    output,
    serverName: "desk-mcp-diagnostic",
    serverVersion,
    callTool: ({ name, input: toolInput }) => diagnosticToolResult({ diagnostic, toolName: name, input: toolInput }),
  }).closed
}

/** The tool result a fixed diagnostic gives: desk_status and desk_doctor answer with it, every other tool is refused with its code and fix. */
export function diagnosticToolResult({ diagnostic, toolName, input }) {
  if (toolName === "desk_doctor") {
    let format
    try {
      format = diagnosticFormat(input)
    } catch (error) {
      // Only the validator's own input error is an input error; anything else is a real failure for the front door to report.
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
