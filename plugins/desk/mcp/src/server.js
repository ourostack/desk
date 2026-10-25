// desk MCP server registration.
//
// Registers every tool in tool-names.js as stdio MCP handlers. Units 3 + 5 + 6 wire every
// tool to a real implementation:
//   - Unit 3: task_create, task_update, task_archive, track_create,
//             track_update, friction_add, lesson_add
//   - M4-2 (cheap moves): task_move, track_rename
//   - M4-6 Part 2: desk_save (commits hand-written files the same way every
//     other write tool commits its own)
//   - Unit 5: desk_search, desk_recall, desk_similar, desk_timeline
//   - Unit 6: desk_thread (refs_graph provenance walk)
//   - Index mgmt: desk_reindex (re-reads the desk into this session's search engine)
//   - Health/status: desk_status and desk_doctor (session-start-safe, non-mutating)
//
// There is no qualitative feedback tool here. Preview feedback a participant
// chooses to offer is written as Markdown in their own desk
// (`_meta/preview-feedback.md`); the private store under src/feedback/ stays a
// protected-storage primitive for records that already exist, with no route
// from this server and none to be added without its own approval.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { TOOL_NAMES, TOOL_DESCRIPTIONS } from "./tool-names.js"
import { TOOL_INPUT_SCHEMAS } from "./tool-schemas.js"
import { deskVersion } from "./package-metadata.js"
import {
  task_create,
  task_update,
  task_archive,
} from "./tools/task.js"
import { taskFocus } from "./tools/task-focus.js"
import { taskSignoff } from "./tools/task-signoff.js"
import { track_create, track_update } from "./tools/track.js"
import { task_move, track_rename } from "./tools/move.js"
import { friction_add } from "./tools/friction.js"
import { improvement_open, improvement_next, improvement_update } from "./tools/improvement.js"
import { lesson_add } from "./tools/lesson.js"
import { desk_save } from "./tools/desk-save.js"
import {
  desk_search,
  desk_recall,
  desk_similar,
  desk_timeline,
} from "./tools/search.js"
import { desk_thread } from "./tools/thread.js"
import { deskSkill } from "./runtime/skills.js"
import { desk_reindex } from "./tools/reindex.js"
import { desk_status } from "./tools/status.js"
export { waitForStatusInspection } from "./tools/status.js"
import { doctorRuntime } from "./tools/doctor.js"
import { configureRuntimeArtifacts } from "./server-helpers.js"
import { CanonicalWriteRecordingError } from "./readiness/journal.js"
import { admitControlPlane } from "./activation/admit.js"
import { createSearchEngine } from "./search/engine.js"
import { searchRouter } from "./search/files-router.js"
import { headlessRefusal } from "./factory/headless-flag.js"

export { TOOL_NAMES, TOOL_DESCRIPTIONS }
export { admitControlPlane, configureRuntimeArtifacts }

// Each session runs Desk search in its own process (src/search/engine.js). Session admission still calls it its
// "controller": the engine answers the few calls admission makes of one.
export async function connectOrStartController({ deskRoot, policy, createEngine = createSearchEngine }) {
  return createEngine({ deskRoot, semantic: policy?.semantic })
}

export async function beginBackgroundConvergence(admission) {
  if (typeof admission?.controller?.beginConvergence === "function") {
    return admission.controller.beginConvergence()
  }
  return null
}

// Map tool name → implementation. Every tool now has a real body.
// Exported so tests can register a probe impl to assert dispatch threading.
export const TOOL_IMPLS = {
  task_create,
  task_update,
  task_archive,
  task_move,
  task_focus: taskFocus,
  task_signoff: taskSignoff,
  track_create,
  track_update,
  track_rename,
  friction_add,
  lesson_add,
  desk_save,
  desk_search,
  desk_recall,
  desk_similar,
  desk_timeline,
  desk_thread,
  desk_reindex,
  desk_status,
  desk_doctor: doctorRuntime,
  desk_skill: ({ input }) => deskSkill(input),
  improvement_open,
  improvement_next,
  improvement_update,
}


/**
 * Dispatch a single MCP call. Pulled out from startServer so tests can
 * exercise the dispatch table directly (no stdio transport needed).
 */
export async function callTool({ deskRoot, name, input, person = null, statusContext = {}, signal, env = process.env }) {
  if (!TOOL_NAMES.includes(name)) {
    return {
      content: [{ type: "text", text: `unknown tool: ${name}` }],
      isError: true,
    }
  }
  const refused = headlessRefusal(name, env)
  if (refused) return { content: [{ type: "text", text: JSON.stringify(refused) }], isError: true }
  const impl = TOOL_IMPLS[name]
  if (!impl) {
    // Every tool wired; this branch only fires if a name exists in
    // TOOL_NAMES but is missing from TOOL_IMPLS — i.e. a wiring bug.
    // Return a structured payload that points at the cause.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            tool: name,
            note: `tool registered in TOOL_NAMES but missing from TOOL_IMPLS (wiring bug). desk root = ${deskRoot}`,
          }),
        },
      ],
    }
  }
  try {
    const readiness = statusContext.admission ? statusContext.admission.controller ?? null : undefined
    const result = await impl({
      deskRoot, input: input ?? {}, person, statusContext, readiness,
      queryRouter: searchRouter(readiness), signal,
    })
    // desk_skill answers with the skill's own text: its result is already an MCP answer.
    if (name === "desk_skill" && Array.isArray(result?.content)) return result
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    }
  } catch (err) {
    if (err instanceof CanonicalWriteRecordingError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ...err.toJSON(), tool: name }) }],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            tool: name,
            message: err?.message ?? String(err),
          }),
        },
      ],
      isError: true,
    }
  }
}

export function createMcpServer() {
  return new Server(
    {
      name: "desk-mcp",
      version: deskVersion() ?? "0.0.0",
    },
    {
      capabilities: { tools: {} },
    },
  )
}

export function createMcpTransport() {
  return new StdioServerTransport()
}

export async function startServer({
  deskRoot,
  person = null,
  statusContext = {},
  server,
  transport,
  createServer = createMcpServer,
  createTransport = createMcpTransport,
}) {
  const activeServer = server ?? createServer()
  const activeTransport = transport ?? createTransport()
  activeServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: TOOL_INPUT_SCHEMAS[name],
    })),
  }))

  activeServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name
    const input = request.params?.arguments ?? {}
    return callTool({ deskRoot, name, input, person, statusContext, signal: extra?.signal })
  })

  await activeServer.connect(activeTransport)
}
