// desk MCP server registration.
//
// Registers every tool in tool-names.js as stdio MCP handlers. Units 3 + 5 + 6 wire every
// tool to a real implementation:
//   - Unit 3: task_create, task_update, task_archive, track_create,
//             track_update, friction_add, lesson_add
//   - Crew teammate notes: note_leave, note_ack
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
import { types } from "node:util"
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
import { note_ack, note_leave } from "./tools/note.js"
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
export { createSearchEngine } from "./search/engine.js"
import { searchRouter } from "./search/files-router.js"
import { headlessRefusal } from "./factory/headless-flag.js"
import { toolExceptionOutcome } from "./runtime/front-door.js"


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
  note_leave,
  note_ack,
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

const TRACE_PREFIX = "DESK_NATIVE_RECEIPT_V1 "
const TRACE_FRAME_BYTES = 65536
const TRACE_MISSING = Symbol("missing")
const TRACE_EVENTS = new Set(["native_spawn", "capture_requested", "native_captured", "admission_requested", "native_ready",
  "callback_started", "callback_completed", "GO_attempted", "native_result", "close_requested", "native_exit", "native_close", "session_settled"])
const TRACE_ISSUES = new Set(["events_oversized", "invalid_or_unexpected_protocol", "stdin_error", "spawn_error", "stdout_error",
  "stderr_error", "stdout_oversized", "stderr_oversized", "stderr_nonempty", "malformed_json", "unterminated_output", "closed_before_requested_stage"])
const TRACE_SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGIOT", "SIGBUS", "SIGFPE",
  "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP",
  "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPOLL",
  "SIGPWR", "SIGSYS", "SIGBREAK", "SIGINFO", "SIGEMT", "SIGLOST", "SIGUNUSED"])

function traceObject(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || types.isProxy(value)) throw new Error("unavailable")
  return value
}

function traceData(value, key) {
  traceObject(value)
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return TRACE_MISSING
  if (!Object.hasOwn(descriptor, "value")) throw new Error("unavailable")
  return descriptor.value
}

export function nativeReceiptTraceEnabled(env) {
  try {
    return traceData(env, "CI") === "true" && traceData(env, "GITHUB_ACTIONS") === "true" &&
      traceData(env, "DESK_BLACKBOX_NATIVE_RECEIPT_TRACE") === "1"
  } catch { return false }
}

export function nativeReceiptRequestId(extra) {
  try {
    const id = traceData(extra, "requestId")
    return Number.isSafeInteger(id) && id >= 0 ? id : null
  } catch { return null }
}

/** Untrusted structural observations only; never used for archive admission or verdicts. */
export function projectNativeReceipt(error) {
  const unavailable = () => ({ schemaVersion: 1, observationalOnly: true, tool: "task_archive", status: "unavailable", code: "receipt_unavailable", incomplete: true })
  try {
    const receipt = traceData(error, "handleReceipt")
    const scope = traceData(receipt, "scope")
    if (typeof scope !== "string" || scope.length !== "archive_native_preadmission_session".length || scope !== "archive_native_preadmission_session") return unavailable()
    const out = { schemaVersion: 1, observationalOnly: true, tool: "task_archive", status: "available", scope: "archive_native_preadmission_session",
      incomplete: false, truncated: false, originComplete: false, fieldStatus: {} }
    const primitive = (object, key, label, valid) => {
      const value = traceData(object, key)
      const status = value === TRACE_MISSING ? "absent" : value === null ? "unknown" : valid(value) ? "present" : "invalid"
      out.fieldStatus[label] = status
      if (status !== "present") out.incomplete = true
      return status === "present" ? value : null
    }
    const integer = value => Number.isSafeInteger(value) && value >= 0
    const boolean = value => typeof value === "boolean"
    const member = (object, key) => {
      const value = traceData(object, key)
      if (value === TRACE_MISSING || value === null) {
        out.fieldStatus[key] = value === TRACE_MISSING ? "absent" : "unknown"
        out.incomplete = true
        return {}
      }
      return traceObject(value)
    }
    const array = (key, max) => {
      const value = traceData(receipt, key)
      if (value === TRACE_MISSING || value === null) {
        out.fieldStatus[key] = value === TRACE_MISSING ? "absent" : "unknown"
        out.incomplete = true
        return []
      }
      traceObject(value)
      if (!Array.isArray(value)) throw new Error("unavailable")
      const length = traceData(value, "length")
      out.fieldStatus[key] = length > max ? "truncated" : "present"
      if (length > max) { out.truncated = true; out.incomplete = true }
      const selected = []
      for (let i = 0; i < Math.min(length, max); i++) selected.push(traceData(value, `${i}`))
      return selected
    }
    for (const key of ["helperSha256", "programSha256", "executedProgramSha256"])
      out[key] = primitive(receipt, key, key, value => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/u.test(value))
    for (const key of ["capturedValidated", "admissionValidated", "operationFailure", "cleanupFailure", "cleanupConfirmed", "uncertain", "settled"])
      out[key] = primitive(receipt, key, key, boolean)
    for (const key of ["droppedEvents", "stdoutBytes", "stderrBytes"]) out[key] = primitive(receipt, key, key, integer)
    const bounds = member(receipt, "bounds")
    out.bounds = {}
    for (const key of ["readinessMs", "ackAndCloseMs", "closeGraceMs", "retirementMs", "stdoutBytes", "stderrBytes", "events"])
      out.bounds[key] = primitive(bounds, key, `bounds.${key}`, integer)
    const handles = member(receipt, "handles")
    out.handles = {}
    for (const key of ["opened", "closeAttempts", "closed"]) out.handles[key] = primitive(handles, key, `handles.${key}`, integer)
    out.handles.confirmedDisposed = primitive(handles, "confirmedDisposed", "handles.confirmedDisposed", boolean)
    const move = member(receipt, "archiveMove")
    out.archiveMove = {}
    for (const key of ["released", "closed", "forced"]) out.archiveMove[key] = primitive(move, key, `archiveMove.${key}`, boolean)
    for (const [key, choices] of [["movement", ["not_released", "confirmed", "refused", "unconfirmed"]], ["retirement", ["unconfirmed", "forced", "confirmed"]]])
      out.archiveMove[key] = primitive(move, key, `archiveMove.${key}`, value => typeof value === "string" && value.length <= 32 && choices.includes(value))
    for (const key of ["exit", "close"]) {
      const value = traceData(receipt, key)
      const observed = value !== TRACE_MISSING && value !== null
      out.fieldStatus[key] = value === TRACE_MISSING ? "absent" : value === null ? "unknown" : "present"
      if (!observed) out.incomplete = true
      out[key] = { observed, code: null, signal: null }
      if (observed) {
        out[key].code = primitive(value, "code", `${key}.code`, code => Number.isSafeInteger(code) && code >= -2147483648 && code <= 2147483647)
        out[key].signal = primitive(value, "signal", `${key}.signal`, signal => typeof signal === "string" && signal.length <= 16 && TRACE_SIGNALS.has(signal))
      }
    }
    let origin = null, previousTime = null, previousSequence = 0
    out.events = array("events", 128).map((event, index) => {
      traceObject(event)
      const type = primitive(event, "type", `events.${index}.type`, value => typeof value === "string" && value.length <= 32 && TRACE_EVENTS.has(value))
      const sequence = primitive(event, "sequence", `events.${index}.sequence`, value => integer(value) && value > previousSequence)
      if (sequence !== null) previousSequence = sequence
      const time = traceData(event, "monotonicNs")
      let qualified = null
      if (typeof time === "string" && time.length >= 1 && time.length <= 30 && /^[0-9]+$/u.test(time)) qualified = BigInt(time)
      if (index === 0 && qualified !== null) { origin = qualified; out.originComplete = true }
      let elapsedMs = null
      if (qualified !== null && origin !== null && qualified >= origin && (previousTime === null || qualified >= previousTime)) {
        const delta = qualified - origin
        if (delta <= 900000000000n) elapsedMs = Number(delta) / 1000000
      }
      if (qualified !== null && (previousTime === null || qualified >= previousTime)) previousTime = qualified
      if (elapsedMs === null) out.incomplete = true
      return { type, sequence, elapsedMs, timeStatus: elapsedMs === null ? "unavailable" : "present",
        sequenceStatus: out.fieldStatus[`events.${index}.sequence`] }
    })
    if (!out.events.length) out.incomplete = true
    out.protocolIssues = []
    for (const code of array("protocolIssues", 16)) {
      if (typeof code === "string" && code.length <= 40 && TRACE_ISSUES.has(code)) out.protocolIssues.push(code)
      else { out.incomplete = true; out.fieldStatus.protocolIssues = "invalid" }
    }
    return out
  } catch { return unavailable() }
}

export function writeBoundedDiagnosticFrame(serializedFrame, sink) {
  if (typeof serializedFrame !== "string" || typeof sink !== "function" || serializedFrame.length > TRACE_FRAME_BYTES) return false
  if (Buffer.byteLength(serializedFrame, "utf8") > TRACE_FRAME_BYTES) return false
  try {
    sink(serializedFrame)
    return true // Invocation is not confirmed channel delivery.
  } catch { return false }
}

function emitNativeReceipt(error, requestId, write) {
  if (!Number.isSafeInteger(requestId) || requestId < 0) return
  const line = `${TRACE_PREFIX}${JSON.stringify({ requestId, receipt: projectNativeReceipt(error) })}\n`
  writeBoundedDiagnosticFrame(line, write)
}


/**
 * Dispatch a single MCP call. Pulled out from startServer so tests can
 * exercise the dispatch table directly (no stdio transport needed).
 */
export async function callTool({ deskRoot, name, input, person = null, statusContext = {}, signal, env = process.env,
  traceRequestId = null, traceWrite = line => process.stderr.write(line, () => {}) }) {
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
    // The session's search engine (src/search/engine.js), once admission has started it: writes tell it what they changed, and searches use it.
    const search = statusContext.search ?? null
    let result = await impl({
      deskRoot, input: input ?? {}, person, statusContext, search,
      queryRouter: searchRouter(search), signal,
    })
    // desk_skill answers with the skill's own text: its result is already an MCP answer.
    if (name === "desk_skill" && Array.isArray(result?.content)) return result
    if (result?.status === "failed" || result?.status === "error" || result?.commit?.status === "failed") {
      const outcome = toolExceptionOutcome(name, { mutation: result.effects ?? result.commit?.effects })
      if (outcome.effects) result = { ...result, ...outcome }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    }
  } catch (err) {
    if (name === "task_archive" && nativeReceiptTraceEnabled(env)) emitNativeReceipt(err, traceRequestId, traceWrite)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            tool: name,
            message: err?.message ?? String(err),
            ...toolExceptionOutcome(name, err),
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
    const traceRequestId = nativeReceiptTraceEnabled(process.env) ? nativeReceiptRequestId(extra) : null
    return callTool({ deskRoot, name, input, person, statusContext, signal: extra?.signal, traceRequestId })
  })

  await activeServer.connect(activeTransport)
}
