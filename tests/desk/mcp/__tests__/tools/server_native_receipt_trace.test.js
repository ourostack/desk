import { test } from "node:test"
import assert from "node:assert/strict"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"

const controls = { CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1" }
const prefix = "DESK_NATIVE_RECEIPT_V1 "
const snapshot = () => ({
  scope: "archive_native_preadmission_session",
  helperSha256: "a".repeat(64), programSha256: "b".repeat(64), executedProgramSha256: null,
  capturedValidated: false, admissionValidated: false, operationFailure: true,
  cleanupFailure: false, cleanupConfirmed: false, uncertain: true, settled: true,
  bounds: { readinessMs: 5000, ackAndCloseMs: 5000, closeGraceMs: 2000, retirementMs: 2000, stdoutBytes: 16384, stderrBytes: 16384, events: 128 },
  events: [
    { type: "native_spawn", sequence: 4, monotonicNs: "1000000" },
    { type: "capture_requested", sequence: 7, monotonicNs: "2500000" },
  ],
  protocolIssues: ["closed_before_requested_stage"], droppedEvents: 0, stdoutBytes: 0, stderrBytes: 0,
  handles: { confirmedDisposed: false },
  archiveMove: { released: false, closed: true, forced: false, movement: "not_released", retirement: "confirmed" },
  exit: { code: 0, signal: null }, close: { code: 0, signal: null },
})
const project = receipt => {
  assert.equal(typeof server.projectNativeReceipt, "function", "missing real receipt projector")
  return server.projectNativeReceipt({ handleReceipt: receipt })
}

test("projects only observational fields, preserving sequence and absent handle counts", () => {
  const receipt = snapshot()
  Object.assign(receipt, { childPid: 12345, samples: { secret: "PRIVATE_PATH" }, token: "PRIVATE_TOKEN" })
  const out = project(receipt)
  assert.equal(out.status, "available")
  assert.equal(out.tool, "task_archive")
  assert.equal(out.observationalOnly, true)
  assert.deepEqual(out.events, [
    { type: "native_spawn", sequence: 4, elapsedMs: 0, timeStatus: "present", sequenceStatus: "present" },
    { type: "capture_requested", sequence: 7, elapsedMs: 1.5, timeStatus: "present", sequenceStatus: "present" },
  ])
  assert.equal(out.handles.opened, null)
  assert.equal(out.fieldStatus["handles.opened"], "absent")
  assert.equal(out.executedProgramSha256, null)
  assert.equal(out.fieldStatus.executedProgramSha256, "unknown")
  assert.equal(out.exit.observed, true)
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_|childPid|samples|token/u)
})

test("rejects Proxy and revoked Proxy before error, context, receipt and nested reflection", () => {
  assert.equal(typeof server.nativeReceiptRequestId, "function")
  assert.equal(typeof server.projectNativeReceipt, "function")
  let traps = 0
  const hostile = () => new Proxy({}, {
    get() { traps++; throw Error("get") },
    getOwnPropertyDescriptor() { traps++; throw Error("descriptor") },
    getPrototypeOf() { traps++; throw Error("prototype") },
    ownKeys() { traps++; throw Error("keys") },
  })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const value of [hostile(), revoked.proxy]) {
    assert.equal(server.projectNativeReceipt(value).status, "unavailable")
    assert.equal(server.nativeReceiptRequestId(value), null)
    assert.equal(project(value).status, "unavailable")
    for (const key of ["bounds", "handles", "archiveMove", "exit", "close", "events", "protocolIssues"]) {
      const receipt = snapshot()
      receipt[key] = value
      assert.equal(project(receipt).status, "unavailable", key)
    }
    const receipt = snapshot()
    receipt.events[0] = value
    assert.equal(project(receipt).status, "unavailable")
  }
  assert.equal(traps, 0)
})

test("new diagnostics never invoke getters, toJSON, iterators, cause or coercion", () => {
  let hooks = 0
  const receipt = snapshot()
  for (const key of ["toJSON", "cause", "unused"]) Object.defineProperty(receipt, key, { get() { hooks++; throw Error("get") } })
  receipt[Symbol.iterator] = () => { hooks++; throw Error("iterator") }
  receipt.helperSha256 = { toString() { hooks++; return "a".repeat(64) } }
  assert.equal(project(receipt).helperSha256, null)
  Object.defineProperty(receipt.events[0], "sequence", { get() { hooks++; return 1 } })
  assert.equal(project(receipt).status, "unavailable")
  const error = {}
  Object.defineProperty(error, "handleReceipt", { get() { hooks++; return snapshot() } })
  assert.equal(server.projectNativeReceipt(error).status, "unavailable")
  assert.equal(hooks, 0)
})

test("invalid first time never becomes a later origin; invalid later values preserve events", () => {
  const receipt = snapshot()
  receipt.events[0].monotonicNs = "9".repeat(100000)
  receipt.events[1].sequence = 2
  let out = project(receipt)
  assert.equal(out.originComplete, false)
  assert.equal(out.events[0].elapsedMs, null)
  assert.equal(out.events[1].elapsedMs, null)
  assert.equal(out.events[1].sequence, null)
  assert.equal(out.events[1].sequenceStatus, "invalid")
  receipt.events = [
    { type: "native_spawn", sequence: 1, monotonicNs: "100" },
    { type: "capture_requested", sequence: 2, monotonicNs: "99" },
    { type: "native_exit", sequence: 3, monotonicNs: "900000000101" },
  ]
  out = project(receipt)
  assert.equal(out.originComplete, true)
  assert.deepEqual(out.events.map(event => event.elapsedMs), [0, null, null])
  assert.equal(out.incomplete, true)
})

test("bounds arrays, hashes, issue codes, counts and signal enums without raw fallback", () => {
  const receipt = snapshot()
  receipt.events = Array.from({ length: 130 }, (_, i) => ({ type: "native_spawn", sequence: i + 1, monotonicNs: `${i}` }))
  receipt.protocolIssues = ["PRIVATE_TOKEN", ...Array(18).fill("stdin_error")]
  receipt.helperSha256 = "a".repeat(100000)
  receipt.stdoutBytes = -1
  receipt.stderrBytes = null
  receipt.close.signal = "PRIVATE_SIGNAL"
  const out = project(receipt)
  assert.equal(out.events.length, 128)
  assert.equal(out.truncated, true)
  assert.equal(out.helperSha256, null)
  assert.equal(out.stdoutBytes, null)
  assert.equal(out.fieldStatus.stdoutBytes, "invalid")
  assert.equal(out.fieldStatus.stderrBytes, "unknown")
  assert.equal(out.close.signal, null)
  assert.ok(out.protocolIssues.length <= 16)
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_/u)
})

test("three exact output controls and safe SDK numeric ID are required", () => {
  assert.equal(typeof server.nativeReceiptTraceEnabled, "function")
  assert.equal(server.nativeReceiptTraceEnabled(controls), true)
  for (const key of Object.keys(controls)) {
    assert.equal(server.nativeReceiptTraceEnabled({ ...controls, [key]: "false" }), false)
    assert.equal(server.nativeReceiptTraceEnabled({ ...controls, [key]: undefined }), false)
  }
  for (const id of ["1", Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, -1, null]) {
    assert.equal(server.nativeReceiptRequestId({ requestId: id }), null)
  }
  assert.equal(server.nativeReceiptRequestId({ requestId: 7 }), 7)
  let gets = 0
  assert.equal(server.nativeReceiptRequestId({ get requestId() { gets++; return 1 } }), null)
  assert.equal(gets, 0)
})

test("valid relative boundary, absent times, holes and noninteger counters stay distinct", () => {
  const receipt = snapshot()
  receipt.events = [
    { type: "native_spawn", sequence: 10, monotonicNs: "999999999999999999999" },
    { type: "capture_requested", sequence: 20, monotonicNs: "1000000000899999999999" },
  ]
  let out = project(receipt)
  assert.deepEqual(out.events.map(event => event.elapsedMs), [0, 900000])
  receipt.events[1].monotonicNs = undefined
  receipt.events[1].sequence = 2.5
  receipt.handles.opened = Number.MAX_SAFE_INTEGER + 1
  out = project(receipt)
  assert.equal(out.events[1].timeStatus, "unavailable")
  assert.equal(out.events[1].sequence, null)
  assert.equal(out.fieldStatus["handles.opened"], "invalid")
  receipt.events = Array(1)
  assert.equal(project(receipt).status, "unavailable")
})

test("default-off avoids receipt reflection while preserving original message getter semantics", async () => {
  const original = server.TOOL_IMPLS.task_archive
  let receiptGets = 0, messageGets = 0
  const error = {
    get message() { messageGets++; return "original getter" },
    get handleReceipt() { receiptGets++; return snapshot() },
  }
  server.TOOL_IMPLS.task_archive = async () => { throw error }
  try {
    const result = await server.callTool({ name: "task_archive", env: {} })
    assert.equal(JSON.parse(result.content[0].text).message, "original getter")
    assert.equal(messageGets, 1)
    assert.equal(receiptGets, 0)
    const lines = []
    await server.callTool({ name: "task_archive", env: controls, traceRequestId: 1, traceWrite: line => lines.push(line) })
    assert.equal(messageGets, 2)
    assert.equal(receiptGets, 0)
    assert.equal(JSON.parse(lines[0].slice(prefix.length)).receipt.status, "unavailable")
  } finally { server.TOOL_IMPLS.task_archive = original }
})

test("successful tool result never emits a successful native receipt", async () => {
  const original = server.TOOL_IMPLS.task_archive
  server.TOOL_IMPLS.task_archive = async () => ({ status: "ok", handleReceipt: snapshot() })
  const lines = []
  try {
    const result = await server.callTool({ name: "task_archive", env: controls, traceRequestId: 1, traceWrite: line => lines.push(line) })
    assert.equal(result.isError, undefined)
    assert.equal(lines.length, 0)
  } finally { server.TOOL_IMPLS.task_archive = original }
})

test("default-off and opted-in dispatch retain exact MCP error; sink failure is contained", async () => {
  const original = server.TOOL_IMPLS.task_archive
  const error = new Error("original failure")
  error.handleReceipt = snapshot()
  const lines = []
  server.TOOL_IMPLS.task_archive = async () => { throw error }
  const expected = { content: [{ type: "text", text: '{"status":"error","tool":"task_archive","message":"original failure"}' }], isError: true }
  try {
    assert.deepEqual(await server.callTool({ name: "task_archive", env: {}, traceRequestId: 4, traceWrite: line => lines.push(line) }), expected)
    assert.equal(lines.length, 0)
    assert.deepEqual(await server.callTool({ name: "task_archive", env: controls, traceRequestId: 4, traceWrite: line => lines.push(line) }), expected)
    assert.equal(lines.length, 1)
    assert.ok(lines[0].startsWith(prefix))
    const frame = JSON.parse(lines[0].slice(prefix.length))
    assert.equal(frame.requestId, 4)
    assert.equal(frame.receipt.status, "available")
    assert.deepEqual(await server.callTool({ name: "task_archive", env: controls, traceRequestId: 4, traceWrite() { throw Error("PRIVATE_SINK") } }), expected)
    assert.deepEqual(await server.callTool({ name: "task_archive", env: controls, traceRequestId: null, traceWrite: line => lines.push(line) }), expected)
    assert.equal(lines.length, 1)
  } finally { server.TOOL_IMPLS.task_archive = original }
})

test("SDK handler supplies safe request context but does not inspect unrelated metadata", async () => {
  const original = server.TOOL_IMPLS.task_archive
  const previous = Object.fromEntries(Object.keys(controls).map(key => [key, process.env[key]]))
  const handlers = []
  const lines = []
  const oldWrite = process.stderr.write
  server.TOOL_IMPLS.task_archive = async () => { throw Object.assign(new Error("original"), { handleReceipt: snapshot() }) }
  Object.assign(process.env, controls)
  process.stderr.write = line => { lines.push(line); return true }
  let gets = 0
  try {
    await server.startServer({ server: { setRequestHandler(_schema, handler) { handlers.push(handler) }, async connect() {} }, transport: {} })
    const context = { requestId: 17, get authInfo() { gets++; throw Error("private") }, get requestInfo() { gets++; throw Error("private") } }
    const result = await handlers[1]({ params: { name: "task_archive" } }, context)
    assert.equal(result.isError, true)
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0].slice(prefix.length)).requestId, 17)
    assert.equal(gets, 0)
  } finally {
    process.stderr.write = oldWrite
    server.TOOL_IMPLS.task_archive = original
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("environment descriptor rejection disables diagnostics without evaluating control getters", () => {
  let getterCalls = 0
  for (const key of ["CI", "GITHUB_ACTIONS", "DESK_BLACKBOX_NATIVE_RECEIPT_TRACE"]) {
    const env = { ...controls }
    Object.defineProperty(env, key, { get() { getterCalls++; throw Error("must not evaluate environment getter") } })
    assert.equal(server.nativeReceiptTraceEnabled(env), false, key)
  }
  assert.equal(getterCalls, 0)
})

test("absent, unknown and present-empty receipt arrays preserve incomplete observational evidence", () => {
  for (const status of ["absent", "unknown", "present"]) {
    const receipt = snapshot()
    if (status === "absent") {
      delete receipt.events
      delete receipt.protocolIssues
    } else {
      receipt.events = status === "unknown" ? null : []
      receipt.protocolIssues = status === "unknown" ? null : []
    }
    delete receipt.droppedEvents
    receipt.stdoutBytes = null
    const out = project(receipt)
    assert.equal(out.status, "available")
    assert.deepEqual(out.events, [])
    assert.deepEqual(out.protocolIssues, [])
    assert.equal(out.fieldStatus.events, status)
    assert.equal(out.fieldStatus.protocolIssues, status)
    assert.equal(out.incomplete, true)
    assert.equal(out.originComplete, false)
    assert.equal(out.droppedEvents, null)
    assert.equal(out.fieldStatus.droppedEvents, "absent")
    assert.equal(out.stdoutBytes, null)
    assert.equal(out.fieldStatus.stdoutBytes, "unknown")
    assert.equal(out.handles.opened, null)
    assert.equal(out.capturedValidated, false)
    assert.equal(out.executedProgramSha256, null)
  }
})

test("scope mismatches are unavailable without coercing structural input", () => {
  let coercions = 0
  for (const scope of [undefined, null, 1, "wrong", "x".repeat(35), { toString() { coercions++; return "archive_native_preadmission_session" } }]) {
    const receipt = snapshot()
    receipt.scope = scope
    assert.deepEqual(project(receipt), {
      schemaVersion: 1, observationalOnly: true, tool: "task_archive",
      status: "unavailable", code: "receipt_unavailable", incomplete: true,
    })
  }
  assert.equal(coercions, 0)
})

test("array-shaped nonarrays are rejected before their length getters can run", () => {
  let getterCalls = 0
  for (const key of ["events", "protocolIssues"]) {
    const receipt = snapshot()
    receipt[key] = { get length() { getterCalls++; throw Error("must not inspect array lookalike length") } }
    assert.equal(project(receipt).status, "unavailable", key)
  }
  assert.equal(getterCalls, 0)
})

test("null nested observations remain unknown rather than confirmed disposal or zero counts", () => {
  const receipt = snapshot()
  for (const key of ["bounds", "handles", "archiveMove", "exit", "close"]) receipt[key] = null
  const out = project(receipt)
  for (const key of ["bounds", "handles", "archiveMove", "exit", "close"]) assert.equal(out.fieldStatus[key], "unknown")
  assert.equal(out.incomplete, true)
  assert.equal(out.handles.opened, null)
  assert.equal(out.handles.closeAttempts, null)
  assert.equal(out.handles.closed, null)
  assert.equal(out.handles.confirmedDisposed, null)
  assert.equal(out.archiveMove.closed, null)
  assert.equal(out.archiveMove.retirement, null)
  assert.deepEqual(out.exit, { observed: false, code: null, signal: null })
  assert.deepEqual(out.close, { observed: false, code: null, signal: null })
  assert.equal(out.cleanupConfirmed, false)
})

test("default stderr completion cannot replace the primary error or wait on backpressure", async () => {
  const original = server.TOOL_IMPLS.task_archive
  const originalWrite = process.stderr.write
  const lines = []
  let completion
  server.TOOL_IMPLS.task_archive = async () => { throw Object.assign(new Error("primary archive failure"), { handleReceipt: snapshot() }) }
  process.stderr.write = (line, callback) => { lines.push(line); completion = callback; return false }
  try {
    const result = await server.callTool({ name: "task_archive", env: controls, traceRequestId: 37 })
    assert.deepEqual(result, {
      content: [{ type: "text", text: '{"status":"error","tool":"task_archive","message":"primary archive failure"}' }],
      isError: true,
    })
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0].slice(prefix.length)).requestId, 37)
    assert.equal(typeof completion, "function")
    assert.doesNotThrow(() => completion(new Error("synthetic sink completion failure")))
    assert.equal(lines.length, 1)
  } finally {
    process.stderr.write = originalWrite
    server.TOOL_IMPLS.task_archive = original
  }
})

test("outbound byte boundary accepts complete ASCII frames at the cap and refuses cap plus one", () => {
  assert.equal(typeof server.writeBoundedDiagnosticFrame, "function")
  const overhead = Buffer.byteLength(`${prefix}""\n`)
  const atCap = `${prefix}${JSON.stringify("x".repeat(65536 - overhead))}\n`
  const overCap = `${prefix}${JSON.stringify("x".repeat(65537 - overhead))}\n`
  assert.equal(Buffer.byteLength(atCap), 65536)
  assert.equal(Buffer.byteLength(overCap), 65537)
  const written = []
  assert.equal(server.writeBoundedDiagnosticFrame(atCap, frame => written.push(frame)), true)
  assert.equal(server.writeBoundedDiagnosticFrame(overCap, frame => written.push(frame)), false)
  assert.deepEqual(written, [atCap])
  assert.equal(JSON.parse(written[0].slice(prefix.length)).length, 65536 - overhead)
})

test("outbound byte boundary measures complete UTF8 frames rather than code units", () => {
  assert.equal(typeof server.writeBoundedDiagnosticFrame, "function")
  const remaining = 65536 - Buffer.byteLength(`${prefix}""\n`)
  const value = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2)
  const atCap = `${prefix}${JSON.stringify(value)}\n`
  const overCap = `${prefix}${JSON.stringify(value + "x")}\n`
  assert.equal(Buffer.byteLength(atCap), 65536)
  assert.equal(Buffer.byteLength(overCap), 65537)
  assert.ok(atCap.length < 65536)
  assert.ok(overCap.length < 65536)
  const written = []
  assert.equal(server.writeBoundedDiagnosticFrame(atCap, frame => written.push(frame)), true)
  assert.equal(server.writeBoundedDiagnosticFrame(overCap, frame => written.push(frame)), false)
  assert.deepEqual(written, [atCap])
  assert.equal(JSON.parse(written[0].slice(prefix.length)), value)
})

test("outbound byte boundary rejects nonstrings and noncallable sinks without coercion", () => {
  assert.equal(typeof server.writeBoundedDiagnosticFrame, "function")
  let getterCalls = 0, coercions = 0, writes = 0
  const object = {
    get length() { getterCalls++; throw Error("must not read object length") },
    toString() { coercions++; return `${prefix}null\n` },
  }
  for (const frame of [undefined, null, false, 1, 1n, Symbol("frame"), object, Buffer.from("frame")])
    assert.equal(server.writeBoundedDiagnosticFrame(frame, () => { writes++ }), false)
  for (const sink of [undefined, null, "sink", {}])
    assert.equal(server.writeBoundedDiagnosticFrame(`${prefix}null\n`, sink), false)
  assert.equal(getterCalls, 0)
  assert.equal(coercions, 0)
  assert.equal(writes, 0)
})

test("outbound byte boundary contains sink exceptions and treats backpressure as invocation not delivery", () => {
  assert.equal(typeof server.writeBoundedDiagnosticFrame, "function")
  const frame = `${prefix}null\n`
  let refused = 0, pressured = 0
  assert.equal(server.writeBoundedDiagnosticFrame(frame, () => { refused++; throw Error("synthetic sink failure") }), false)
  assert.equal(server.writeBoundedDiagnosticFrame(frame, received => {
    assert.equal(received, frame)
    pressured++
    return false
  }), true)
  assert.equal(refused, 1)
  assert.equal(pressured, 1)
})

test("ordinary empty and maximum sparse receipt arrays retain descriptor caps and bounded iteration", () => {
  const receipt = snapshot()
  receipt.events = []
  receipt.protocolIssues = []
  const empty = project(receipt)
  assert.deepEqual(empty.events, [])
  assert.deepEqual(empty.protocolIssues, [])
  assert.equal(empty.truncated, false)
  assert.equal(empty.originComplete, false)
  let beyondCapReads = 0
  receipt.events = new Array(0xffffffff)
  receipt.protocolIssues = new Array(0xffffffff)
  for (let i = 0; i < 128; i++) receipt.events[i] = { type: "native_spawn", sequence: i + 1, monotonicNs: `${i * 1000000}` }
  for (let i = 0; i < 16; i++) receipt.protocolIssues[i] = "stdin_error"
  Object.defineProperty(receipt.events, "128", { get() { beyondCapReads++; throw Error("event outside cap") } })
  Object.defineProperty(receipt.protocolIssues, "16", { get() { beyondCapReads++; throw Error("code outside cap") } })
  const out = project(receipt)
  assert.equal(out.status, "available")
  assert.equal(out.events.length, 128)
  assert.equal(out.protocolIssues.length, 16)
  assert.equal(out.fieldStatus.events, "truncated")
  assert.equal(out.fieldStatus.protocolIssues, "truncated")
  assert.equal(out.truncated, true)
  assert.equal(out.incomplete, true)
  assert.equal(out.events[127].sequence, 128)
  assert.equal(out.events[127].elapsedMs, 127)
  assert.equal(out.capturedValidated, false)
  assert.equal(out.executedProgramSha256, null)
  assert.equal(beyondCapReads, 0)
})
