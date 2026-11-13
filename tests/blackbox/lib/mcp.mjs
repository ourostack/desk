// A minimal MCP client over stdio, the way a host speaks to a server: newline-delimited JSON-RPC on the child's stdin and stdout.
// It depends on nothing but Node, so the tester never loads Desk's own modules or packages.

import { spawn } from "node:child_process"
import { types } from "node:util"
import { RssSampler } from "./proc.mjs"

const TRACE_PREFIX = "DESK_NATIVE_RECEIPT_V1 "
const TRACE_FRAME_BYTES = 65536
const TRACE_CASE_BYTES = 65536
const TRACE_JOB_BYTES = 1048576
export const NATIVE_RECEIPT_SOURCE_FILES = Object.freeze([
  "plugins/desk/mcp/src/server.js", "tests/blackbox/lib/mcp.mjs", "tests/blackbox/run.mjs",
  "plugins/desk/mcp/src/tools/archive-native-session.js", "plugins/desk/mcp/src/tools/native-stage-context.js", "tests/blackbox/lib/world.mjs",
  ".github/workflows/desk-native-receipt-diagnostic-581.yml", ".github/workflows/desk-mcp-tests.yml",
])
const TRACE_EVENTS = new Set(["native_spawn", "capture_requested", "native_captured", "admission_requested", "native_ready",
  "callback_started", "callback_completed", "GO_attempted", "native_result", "close_requested", "native_exit", "native_close", "session_settled"])
const TRACE_ISSUES = new Set(["events_oversized", "invalid_or_unexpected_protocol", "stdin_error", "spawn_error", "stdout_error",
  "stderr_error", "stdout_oversized", "stderr_oversized", "stderr_nonempty", "malformed_json", "unterminated_output", "closed_before_requested_stage"])
const TRACE_SIGNALS = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGIOT", "SIGBUS", "SIGFPE",
  "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP",
  "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPOLL",
  "SIGPWR", "SIGSYS", "SIGBREAK", "SIGINFO", "SIGEMT", "SIGLOST", "SIGUNUSED"])
const TRACE_STATUS = new Set(["present", "absent", "unknown", "invalid", "truncated"])
const TRACE_COUNTERS = ["invalid", "oversized", "unmatched", "evicted", "duplicate", "truncated", "dropped", "channelEndUnobserved"]
const traceInteger = value => Number.isSafeInteger(value) && value >= 0
const traceBoolean = value => typeof value === "boolean"
const traceStageUs = value => Number.isSafeInteger(value) && value >= 0 && value <= 900000000
const traceEnum = choices => value => typeof value === "string" && value.length <= 64 && choices.has(value)
const traceHash = value => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/u.test(value)

// Only the explicitly enabled diagnostic uses compact output. Default bytes stay pretty.
export function nativeReceiptArtifactJson(summary, enabled = false) {
  return `${JSON.stringify(summary, null, enabled === true ? undefined : 2)}\n`
}

export function nativeReceiptBudgetFits(caseBytes, jobBytes) {
  return traceInteger(caseBytes) && traceInteger(jobBytes) && caseBytes <= TRACE_CASE_BYTES && jobBytes <= TRACE_JOB_BYTES
}

const traceJsonBytes = value => Buffer.byteLength(nativeReceiptArtifactJson(value, true))
const traceEmpty = counters => ({ schemaVersion: 1, observationalOnly: true, records: [], cases: [], counters })
const traceCase = entry => ({ host: entry.host, repeat: entry.repeat, caseId: entry.caseId, truncated: entry.truncated })

function traceEnvelopeBytes() {
  // Exact serialization of the schema's largest counter/source values, not padding.
  const counters = Object.fromEntries(TRACE_COUNTERS.map(key => [key, key === "channelEndUnobserved" ? 128 : 1000000000]))
  const source = { head: "a".repeat(64), dirty: false,
    hashes: Object.fromEntries(NATIVE_RECEIPT_SOURCE_FILES.map(file => [file, "a".repeat(64)])) }
  return traceJsonBytes({ native_receipt_trace: traceEmpty(counters), native_receipt_source: source })
}

function traceData(object, key) {
  if (object === null || typeof object !== "object" || types.isProxy(object)) throw new Error("invalid")
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (descriptor && !Object.hasOwn(descriptor, "value")) throw new Error("invalid")
  return descriptor?.value
}

export function nativeReceiptTraceRequested(env) {
  try {
    return traceData(env, "CI") === "true" && traceData(env, "GITHUB_ACTIONS") === "true" &&
      traceData(env, "DESK_BLACKBOX_NATIVE_RECEIPT_TRACE") === "1"
  } catch { return false }
}

export function nativeReceiptLaunch(launch, env) {
  if (!nativeReceiptTraceRequested(env)) return launch
  const stage = nativeStageTraceRequested(env) ? { DESK_BLACKBOX_NATIVE_STAGE_TRACE: "1" } : {}
  return { ...launch, env: { ...launch.env, CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1", ...stage } }
}

// Stage diagnostic is a second explicit control on top of the receipt trace; never implied by it.
export function nativeStageTraceRequested(env) {
  try { return nativeReceiptTraceRequested(env) && traceData(env, "DESK_BLACKBOX_NATIVE_STAGE_TRACE") === "1" } catch { return false }
}

// JSON decoding is not validation: copy only fixed schema fields into fresh records.
function traceReceipt(input) {
  const exact = (object, key, expected) => {
    if (traceData(object, key) !== expected) throw new Error("invalid")
    return expected
  }
  const take = (object, key, valid, nullable = true) => {
    const value = traceData(object, key)
    if (nullable && value === null || valid(value)) return value
    throw new Error("invalid")
  }
  const record = (object, fields) => {
    const out = {}
    for (const [key, valid] of Object.entries(fields)) out[key] = take(object, key, valid)
    return out
  }
  const array = (object, key, max) => {
    const value = traceData(object, key)
    // Reject Proxy before Array.isArray or length/index reflection.
    traceData(value, "length")
    if (!Array.isArray(value)) throw new Error("invalid")
    const length = traceData(value, "length")
    if (!traceInteger(length) || length > max) throw new Error("invalid")
    const out = []
    for (let i = 0; i < length; i++) out.push(traceData(value, `${i}`))
    return out
  }
  const out = { schemaVersion: exact(input, "schemaVersion", 1), observationalOnly: exact(input, "observationalOnly", true),
    tool: exact(input, "tool", "task_archive") }
  const status = traceData(input, "status")
  if (status === "unavailable") {
    return { ...out, status, code: exact(input, "code", "receipt_unavailable"), incomplete: exact(input, "incomplete", true) }
  }
  if (status !== "available") throw new Error("invalid")
  Object.assign(out, { status, scope: exact(input, "scope", "archive_native_preadmission_session"),
    incomplete: take(input, "incomplete", traceBoolean, false), truncated: take(input, "truncated", traceBoolean, false),
    originComplete: take(input, "originComplete", traceBoolean, false) })
  const fields = {}
  for (const key of ["helperSha256", "programSha256", "executedProgramSha256"]) fields[key] = traceHash
  for (const key of ["capturedValidated", "admissionValidated", "operationFailure", "cleanupFailure", "cleanupConfirmed", "uncertain", "settled"])
    fields[key] = traceBoolean
  for (const key of ["droppedEvents", "stdoutBytes", "stderrBytes"]) fields[key] = traceInteger
  Object.assign(out, record(input, fields))
  const bounds = Object.fromEntries(["readinessMs", "ackAndCloseMs", "closeGraceMs", "retirementMs", "stdoutBytes", "stderrBytes", "events"].map(key => [key, traceInteger]))
  const handles = { opened: traceInteger, closeAttempts: traceInteger, closed: traceInteger, confirmedDisposed: traceBoolean }
  const move = { released: traceBoolean, closed: traceBoolean, forced: traceBoolean,
    movement: traceEnum(new Set(["not_released", "confirmed", "refused", "unconfirmed"])),
    retirement: traceEnum(new Set(["unconfirmed", "forced", "confirmed"])) }
  for (const [key, shape] of [["bounds", bounds], ["handles", handles], ["archiveMove", move]]) out[key] = record(traceData(input, key), shape)
  for (const key of ["exit", "close"]) {
    const value = traceData(input, key)
    out[key] = { observed: take(value, "observed", traceBoolean, false),
      code: take(value, "code", code => Number.isSafeInteger(code) && code >= -2147483648 && code <= 2147483647),
      signal: take(value, "signal", signal => typeof signal === "string" && signal.length <= 16 && TRACE_SIGNALS.has(signal)) }
  }
  let sequence = 0, elapsed = 0
  out.events = array(input, "events", 128).map((event, index) => {
    const value = record(event, { type: traceEnum(TRACE_EVENTS), sequence: traceInteger,
      elapsedMs: time => typeof time === "number" && Number.isFinite(time) && time >= 0 && time <= 900000,
      timeStatus: traceEnum(new Set(["present", "unavailable"])), sequenceStatus: traceEnum(TRACE_STATUS) })
    if (index === 0 && out.originComplete && value.elapsedMs !== 0 ||
        value.sequence !== null && value.sequence <= sequence ||
        value.elapsedMs !== null && (value.elapsedMs < elapsed || !out.originComplete) ||
        (value.elapsedMs === null) !== (value.timeStatus === "unavailable") ||
        (value.sequence === null) === (value.sequenceStatus === "present")) throw new Error("invalid")
    if (value.sequence !== null) sequence = value.sequence
    if (value.elapsedMs !== null) elapsed = value.elapsedMs
    return value
  })
  if (out.originComplete && !out.events.length) throw new Error("invalid")
  out.protocolIssues = array(input, "protocolIssues", 16).map(code => {
    if (!traceEnum(TRACE_ISSUES)(code)) throw new Error("invalid")
    return code
  })
  out.fieldStatus = {}
  if (traceData(input, "programVariant") !== undefined) {
    out.programVariant = exact(input, "programVariant", "stage_diag")
    let previous = null
    out.nativeStages = array(input, "nativeStages", 5).map((entry, index) => {
      const value = record(entry, { stage: traceEnum(new Set(["start", "compiled", "verified", "request_read", "baseline_done"])),
        nativeUs: traceStageUs, wrapperUs: traceStageUs })
      if (value.stage !== ["start", "compiled", "verified", "request_read", "baseline_done"][index] || value.nativeUs === null ||
          value.wrapperUs === null || previous && (value.nativeUs < previous.nativeUs || value.wrapperUs < previous.wrapperUs)) throw new Error("invalid")
      previous = value
      return value
    })
  }
  const statuses = traceData(input, "fieldStatus")
  const keys = [...Object.keys(fields), "bounds", "handles", "archiveMove", "exit", "close", "events", "protocolIssues", "programVariant", "nativeStages",
    ...Object.keys(bounds).map(key => `bounds.${key}`), ...Object.keys(handles).map(key => `handles.${key}`),
    ...Object.keys(move).map(key => `archiveMove.${key}`), "exit.code", "exit.signal", "close.code", "close.signal"]
  for (let i = 0; i < 128; i++) keys.push(`events.${i}.type`, `events.${i}.sequence`)
  for (const key of keys) {
    const value = traceData(statuses, key)
    if (value === undefined) continue
    if (!traceEnum(TRACE_STATUS)(value)) throw new Error("invalid")
    out.fieldStatus[key] = value
  }
  return out
}

/** One collector owns all sessions/repetitions, including provisional failed-case data. */
export class NativeReceiptCollector {
  constructor({ retainPassed = false } = {}) {
    this.retainPassed = retainPassed === true
    this.counters = Object.fromEntries(TRACE_COUNTERS.map(key => [key, 0]))
    this.cases = new Map()
    this.current = new Map()
    this.instances = 0
    this.bytes = traceEnvelopeBytes()
    this.recordCount = 0
    this.caseCount = 0
  }

  count(key) { this.counters[key] = Math.min(1000000000, this.counters[key] + 1) }

  enterCase(ctx, id) {
    if (!["copilot", "claude"].includes(ctx.host) || !traceInteger(ctx.repeat) || ctx.repeat < 1 || ctx.repeat > 1000 ||
        typeof id !== "string" || id.length > 128 || !/^[a-z0-9_.]+$/u.test(id)) return
    const key = `${ctx.host}:${ctx.repeat}:${id}`
    this.current.set(`${ctx.host}:${ctx.repeat}`, key)
    if (!this.cases.has(key)) {
      const metadata = { host: ctx.host, repeat: ctx.repeat, caseId: id, truncated: false }
      const bytes = traceJsonBytes({ records: [], cases: [metadata] })
      const metadataBytes = traceJsonBytes(metadata) - 1
      const jobBytes = this.bytes + metadataBytes + (this.caseCount > 0 ? 1 : 0)
      if (this.cases.size >= 1024 || !nativeReceiptBudgetFits(bytes, jobBytes)) { this.count("dropped"); return }
      this.cases.set(key, { ...metadata, outcome: "pending", bytes, metadataBytes, recordBytes: 0, records: [] })
      this.bytes = jobBytes
      this.caseCount++
    }
  }

  finishCase(ctx, id, ok) {
    const group = `${ctx.host}:${ctx.repeat}`
    const key = `${group}:${id}`
    if (this.current.get(group) === key) this.current.delete(group)
    const entry = this.cases.get(key)
    if (!entry || entry.outcome === "passed") return
    entry.outcome = ok ? "passed" : "failed"
    if (ok && !this.retainPassed) {
      const count = entry.records.length
      const separators = Math.max(0, this.recordCount - 1) - Math.max(0, this.recordCount - count - 1)
      this.bytes -= entry.metadataBytes + (this.caseCount > 1 ? 1 : 0) + entry.recordBytes + separators
      this.caseCount--
      this.recordCount -= count
      entry.bytes = 0
      entry.recordBytes = 0
      entry.records = []
    }
  }

  session(ctx) {
    if (!["copilot", "claude"].includes(ctx.host) || !traceInteger(ctx.repeat) || ctx.repeat < 1 || ctx.repeat > 1000 || this.instances >= 128)
      throw new Error("invalid diagnostic session context")
    const host = ctx.host, repeat = ctx.repeat, instance = ++this.instances
    const pendingBindings = new Map(), completedBindings = new Map()
    const frame = Buffer.alloc(TRACE_FRAME_BYTES)
    let matched = 0, length = 0, discard = false, ended = false
    this.counters.channelEndUnobserved++
    const receive = () => {
      try {
        const parsed = JSON.parse(frame.toString("utf8", 0, length))
        const id = traceData(parsed, "requestId")
        if (!traceInteger(id)) throw new Error("invalid")
        const receipt = traceReceipt(traceData(parsed, "receipt"))
        const binding = pendingBindings.get(id) ?? completedBindings.get(id)
        if (!binding?.key) { this.count("unmatched"); return }
        if (binding.seen) { this.count("duplicate"); return }
        binding.seen = true
        const entry = this.cases.get(binding.key)
        if (!entry || entry.outcome === "passed" && !this.retainPassed) { this.count("dropped"); return }
        const record = { correlation: { host, repeat, caseId: entry.caseId, role: "desk", instance, requestId: id }, receipt }
        // A reprojected record is schema-bounded before encoding. Never build the
        // accumulating job to discover its size; charge each actual array element.
        const bytes = traceJsonBytes(record) - 1
        const caseBytes = entry.bytes + bytes + (entry.records.length > 0 ? 1 : 0)
        const jobBytes = this.bytes + bytes + (this.recordCount > 0 ? 1 : 0)
        if (!nativeReceiptBudgetFits(caseBytes, jobBytes)) {
          if (!entry.truncated) {
            entry.truncated = true
            // JSON true is one byte shorter than the reserved false.
            entry.bytes--
            entry.metadataBytes--
            this.bytes--
          }
          this.count("truncated")
          return
        }
        entry.records.push(record)
        entry.bytes = caseBytes
        entry.recordBytes += bytes
        this.bytes = jobBytes
        this.recordCount++
      } catch { this.count("invalid") }
    }
    return {
      dispatch: id => {
        if (!traceInteger(id)) { this.count("invalid"); return }
        if (pendingBindings.size >= 128) { pendingBindings.delete(pendingBindings.keys().next().value); this.count("evicted") }
        pendingBindings.set(id, { key: this.current.get(`${host}:${repeat}`) ?? null, seen: false })
      },
      complete: id => {
        const binding = pendingBindings.get(id)
        if (!binding) return
        pendingBindings.delete(id)
        if (completedBindings.size >= 128) { completedBindings.delete(completedBindings.keys().next().value); this.count("evicted") }
        completedBindings.set(id, binding)
      },
      write: chunk => {
        if (ended) { this.count("dropped"); return }
        if (types.isProxy(chunk) || !Buffer.isBuffer(chunk)) { this.count("invalid"); return }
        for (const byte of chunk) {
          if (byte === 10) {
            if (!discard && matched === TRACE_PREFIX.length) receive()
            frame.fill(0, 0, length)
            matched = 0; length = 0; discard = false
          } else if (!discard && matched < TRACE_PREFIX.length) {
            if (byte === TRACE_PREFIX.charCodeAt(matched)) matched++
            else discard = true
          } else if (!discard) {
            if (length + TRACE_PREFIX.length + 1 >= TRACE_FRAME_BYTES) {
              frame.fill(0, 0, length)
              discard = true; length = 0; this.count("oversized")
            } else frame[length++] = byte
          }
        }
      },
      end: () => {
        if (ended) return
        ended = true
        this.counters.channelEndUnobserved--
        if (!discard && (matched || length)) this.count("truncated")
        frame.fill(0)
        length = 0
      },
    }
  }

  snapshot() {
    const records = [], cases = []
    for (const entry of this.cases.values()) {
      if (entry.outcome !== "failed" && !(this.retainPassed && entry.outcome === "passed")) continue
      cases.push(traceCase(entry))
      records.push(...entry.records)
    }
    return { schemaVersion: 1, observationalOnly: true, records, cases, counters: { ...this.counters } }
  }
}

export class McpSession {
  constructor({ command, args, cwd, env, name, nativeReceiptTrace = null }) {
    this.nativeReceiptTrace = nativeReceiptTrace
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
    if (nativeReceiptTrace) {
      this.child.stderr.on("data", chunk => nativeReceiptTrace.write(chunk))
      this.child.stderr.once("end", () => nativeReceiptTrace.end())
    }
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
          this.nativeReceiptTrace?.complete(message.id)
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
        reject(new Error(`${this.name} already exited (code ${this.exitInfo.code}, signal ${this.exitInfo.signal}); stderr tail: ${this.stderr.slice(-600)}`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.nativeReceiptTrace?.complete(id)
        reject(new Error(`${this.name} did not answer ${method} within ${timeoutMs} ms; stderr tail: ${this.stderr.slice(-600)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.nativeReceiptTrace?.dispatch(id)
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
    const texts = content.filter((part) => part.type === "text").map((part) => part.text)
    const text = texts.join("\n")
    let json = response.result.structuredContent ?? null
    // Desk appends its session boot to the first reply that has none yet as a further text part, so the tool's own JSON is the first part.
    if (json === null) {
      try { json = JSON.parse(texts[0] ?? "") } catch { json = null }
    }
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
