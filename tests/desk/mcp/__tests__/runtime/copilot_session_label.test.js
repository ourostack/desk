import "../_isolated_env.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync, promises as fs } from "node:fs"
import path from "node:path"
import { makeSessionLabelProposal } from "../../../../../plugins/desk/mcp/src/runtime/session-label.js"
import { attachCopilotSessionLabels } from "../../../../../plugins/desk/extensions/session-label/consumer.mjs"
const task = { track: "engineering", slug: "workflow-review" }
const other = { track: "engineering", slug: "browser-boundary" }
const expectedSessionId = "owned-main-session"
const artifactVersion = JSON.parse(readFileSync(new URL("../../../../../plugins/desk/plugin.json", import.meta.url), "utf8")).version
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function runtime({ manual = false } = {}) {
  let handler
  let name = manual ? "Operator chosen name" : null
  const writes = []
  const session = {
    sessionId: expectedSessionId,
    on: (listener) => { handler = listener; return () => { handler = undefined } },
    rpc: {
      metadata: { snapshot: async () => ({ sessionId: expectedSessionId, workingDirectory: "/owned" }) },
      mcp: { listConfigured: async () => ({ servers: [
        { name: "desk", source: "plugin", sourcePlugin: "desk", sourcePluginVersion: artifactVersion },
      ] }) },
      name: {
        get: async () => ({ name }),
        set: async () => { throw Error("manual setter must never be used") },
        setAuto: async ({ summary }) => {
          writes.push(summary)
          if (!manual) name = summary
          return { applied: !manual }
        },
      },
    },
  }
  return { session, writes, emit: (event) => handler?.(event), name: () => name }
}

function start(id = "call-a", { tool = "task_focus", args = task, ...extra } = {}) {
  return {
    id: `${id}-start`, parentId: null, timestamp: "2026-10-20T23:00:00.000Z",
    type: "tool.execution_start",
    data: { toolCallId: id, toolName: `desk-${tool}`, mcpServerName: "desk", mcpConfigSource: "plugin",
      mcpTransport: "stdio", mcpToolName: tool, arguments: args },
    ...extra,
  }
}

function complete(id = "call-a", { label = "Workflow promotion review", identity = task, tool = "task_focus", ...extra } = {}) {
  const result = {
    status: tool === "task_focus" ? "focused" : tool === "task_create" ? "created" : "updated",
    ...(tool === "task_create" ? { focused: true } : {}),
    session_label: makeSessionLabelProposal({ task: identity, displayLabel: label }),
  }
  return {
    id: `${id}-end`, parentId: `${id}-start`, timestamp: "2026-10-20T23:00:01.000Z",
    type: "tool.execution_complete",
    data: { toolCallId: id, success: true, result: { content: JSON.stringify(result) } },
    ...extra,
  }
}

async function attach(fake = runtime(), options = {}) {
  assert.equal(typeof attachCopilotSessionLabels, "function", "missing native tool-result consumer")
  const consumer = await attachCopilotSessionLabels({ session: fake.session, expectedSessionId, ...options })
  return { ...fake, consumer }
}

async function admit(fixture, begin) {
  fixture.emit(begin)
  await fixture.consumer.beforeMcpToolCall({
    sessionId: expectedSessionId, toolCallId: begin.data.toolCallId,
    serverName: begin.data.mcpConfigServerName ?? begin.data.mcpServerName,
    toolName: begin.data.mcpToolName, arguments: begin.data.arguments,
    ...(begin.agentId !== undefined ? { agentId: begin.agentId } : {}),
    ...(begin.data.agentId !== undefined ? { agentId: begin.data.agentId } : {}),
    ...(begin.data.parentToolCallId !== undefined ? { parentAgentId: begin.data.parentToolCallId } : {}),
  }, { sessionId: expectedSessionId })
}

async function observe(fixture, begin = start(), end = complete()) {
  await admit(fixture, begin)
  fixture.emit(end)
  await fixture.consumer.waitForIdle()
}

test("a correlated main task result applies only its authored safe proposal and verifies native readback", async () => {
  const f = await attach()
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.deepEqual(f.writes, ["Workflow promotion review"])
  assert.equal(f.name(), "Workflow promotion review")
  assert.equal(f.consumer.getState().state, "applied")
  await observe(f, start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }),
    complete("call-b", { identity: other, label: "Browser boundary qualification" }))
  assert.deepEqual(f.writes, ["Workflow promotion review", "Browser boundary qualification"])
})

for (const tool of ["task_create", "task_update"]) {
  test(`${tool} consumes a successful focused proposal, not a card lifecycle phase`, async () => {
    const f = await attach()
    await observe(f, start("call-a", { tool, args: { ...task, focus: true, display_label: "Workflow promotion review" } }),
      complete("call-a", { tool }))
    assert.deepEqual(f.writes, ["Workflow promotion review"])
  })
}

for (const marker of ["envelope", "legacy-parent", "legacy-agent", "completion-child"]) {
  test(`native ${marker} provenance excludes a child from naming the parent`, async () => {
    const f = await attach()
    const begin = start("call-a", { args: { ...task, display_label: "Workflow promotion review" } })
    const end = complete()
    if (marker === "envelope") begin.agentId = "child"
    if (marker === "legacy-parent") begin.data.parentToolCallId = "parent"
    if (marker === "legacy-agent") begin.data.agentId = "child"
    if (marker === "completion-child") end.agentId = "child"
    await observe(f, begin, end)
    assert.deepEqual(f.writes, [])
  })
}

for (const mutation of ["foreign-server", "unmatched-result", "failed-result", "wrong-task", "different-authored-text", "missing-authored-label", "unsafe-output", "native-phase-claim", "parked-create"]) {
  test(`reject ${mutation} without a native name write`, async () => {
    const f = await attach()
    const begin = start("call-a", { args: { ...task, display_label: "Workflow promotion review" } })
    const end = complete()
    if (mutation === "foreign-server") begin.data.mcpServerName = "unrelated"
    if (mutation === "unmatched-result") end.data.toolCallId = "unknown"
    if (mutation === "failed-result") end.data.success = false
    if (mutation === "wrong-task") end.data.result.content = complete("call-a", { identity: other }).data.result.content
    if (mutation === "different-authored-text") end.data.result.content = complete("call-a", { label: "Unrequested label" }).data.result.content
    if (mutation === "missing-authored-label") delete begin.data.arguments.display_label
    if (mutation === "unsafe-output" || mutation === "native-phase-claim") {
      const result = JSON.parse(end.data.result.content)
      if (mutation === "unsafe-output") result.session_label.proposal.text = "Review /private/path"
      else result.session_label.proposal.phase = "delivered"
      end.data.result.content = JSON.stringify(result)
    }
    if (mutation === "parked-create") {
      begin.data.mcpToolName = "task_create"
      const result = JSON.parse(end.data.result.content)
      result.status = "created"
      result.focused = false
      end.data.result.content = JSON.stringify(result)
    }
    await observe(f, begin, end)
    assert.deepEqual(f.writes, [])
  })
}

test("a newer main task start makes an old completion stale; a duplicate completion cannot reapply", async () => {
  const f = await attach()
  await admit(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  await admit(f, start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }))
  f.emit(complete())
  f.emit(complete("call-b", { identity: other, label: "Browser boundary qualification" }))
  f.emit(complete("call-b", { identity: other, label: "Browser boundary qualification" }))
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, ["Browser boundary qualification"])
})

test("standalone clear invalidates a pending proposal without calling any native setter", async () => {
  const f = await attach()
  await admit(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  await admit(f, start("clear", { args: { clear: true } }))
  f.emit(complete())
  f.emit({ ...complete("clear"), data: { toolCallId: "clear", success: true, result: { content: '{"status":"cleared"}' } } })
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, [])
})

test("an explicit operator name is preserved by the native conditional automatic API", async () => {
  const f = await attach(runtime({ manual: true }))
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.equal(f.name(), "Operator chosen name")
  assert.deepEqual(f.consumer.getState(), { state: "preserved", code: "native_owner_refused" })
})

for (const missing of ["setAuto", "get", "snapshot"]) {
  test(`missing native ${missing} is explicitly unavailable, not a naming success`, async () => {
    const fake = runtime()
    if (missing === "snapshot") delete fake.session.rpc.metadata.snapshot
    else delete fake.session.rpc.name[missing]
    const f = await attach(fake)
    await observe(f)
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "unsupported_runtime" })
  })
}

test("a foreign joined session cannot register a naming consumer", async () => {
  const fake = runtime()
  fake.session.sessionId = "foreign"
  const f = await attach(fake)
  await observe(f)
  assert.deepEqual(f.writes, [])
  assert.equal(f.consumer.getState().code, "owner_unknown")
})

test("changed native identity is rechecked before applying a label", async () => {
  const f = await attach()
  f.session.rpc.metadata.snapshot = async () => ({ sessionId: "foreign" })
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.deepEqual(f.writes, [])
  assert.equal(f.consumer.getState().code, "owner_unknown")
})

test("native readback mismatch never reports an applied label", async () => {
  const f = await attach()
  f.session.rpc.name.get = async () => ({ name: "Different native result" })
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_readback_mismatch" })
})

test("runtime errors produce a bounded diagnostic without echoing errors or authored text", async () => {
  const f = await attach()
  f.session.rpc.name.setAuto = async () => { throw Error("private details must not be logged") }
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_apply_uncertain" })
})

test("a pending metadata check cannot apply after disposal", async () => {
  const f = await attach()
  const gate = deferred()
  f.session.rpc.metadata.snapshot = () => gate.promise
  await admit(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete())
  await tick()
  const stopping = f.consumer.dispose()
  gate.resolve({ sessionId: expectedSessionId })
  await stopping
  assert.deepEqual(f.writes, [])
})

test("a native API timeout is uncertain, does not retry, and cannot become a late success", async () => {
  const f = await attach(runtime(), { timeoutMs: 10 })
  const gate = deferred()
  f.session.rpc.name.setAuto = () => gate.promise
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_apply_uncertain" })
  gate.resolve({ applied: true })
  await tick()
  assert.equal(f.consumer.getState().code, "native_apply_uncertain")
})

test("a timed-out older write fences a newer task instead of letting the unknown write overtake it", async () => {
  const f = await attach(runtime(), { timeoutMs: 10 })
  const gate = deferred()
  const calls = []
  f.session.rpc.name.setAuto = ({ summary }) => {
    calls.push(summary)
    return gate.promise
  }
  await admit(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete())
  await tick()
  await admit(f, start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }))
  f.emit(complete("call-b", { identity: other, label: "Browser boundary qualification" }))
  await f.consumer.waitForIdle()
  assert.deepEqual(calls, ["Workflow promotion review"])
  assert.equal(f.consumer.getState().code, "native_apply_uncertain")
  gate.resolve({ applied: true })
})

test("native structured MCP output is consumed without extracting pasted JSON from unrelated prose", async () => {
  const f = await attach()
  const end = complete()
  end.data.result.structuredContent = JSON.parse(end.data.result.content)
  end.data.result.content = "Native structured result"
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }), end)
  assert.deepEqual(f.writes, ["Workflow promotion review"])
})

test("malformed native result text is ignored rather than throwing into tool execution", async () => {
  const f = await attach()
  const end = complete()
  end.data.result.content = "A tool said { not valid JSON"
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }), end)
  assert.deepEqual(f.writes, [])
})

test("foreign metadata at attachment is unavailable and disposal remains harmless", async () => {
  const fake = runtime()
  fake.session.rpc.metadata.snapshot = async () => ({ sessionId: "foreign" })
  const f = await attach(fake)
  assert.equal(f.consumer.getState().code, "owner_unknown")
  await f.consumer.dispose()
  assert.deepEqual(f.writes, [])
})

test("a runtime without the advertised metadata RPC is negotiated as unavailable", async () => {
  const fake = runtime()
  fake.session.rpc.metadata.snapshot = async () => { throw Object.assign(Error("method missing"), { code: -32601 }) }
  const f = await attach(fake)
  assert.equal(f.consumer.getState().code, "unsupported_runtime")
})

test("native resume discards prior observations and requires a newly correlated task result", async () => {
  const f = await attach()
  await admit(f, start("old", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit({ type: "session.resume", data: {} })
  f.emit(complete("old"))
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, [])
  assert.equal(f.consumer.getState().code, "awaiting_task_observation")
  await observe(f, start("new", { args: { ...task, display_label: "Workflow promotion review" } }), complete("new"))
  assert.deepEqual(f.writes, ["Workflow promotion review"])
})

test("native shutdown releases the observer before another task result can write", async () => {
  const f = await attach()
  await admit(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit({ type: "session.shutdown", data: {} })
  f.emit(complete())
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, [])
})

for (const stage of ["apply", "readback"]) {
  test(`a newer task during old ${stage} acknowledgement suppresses a stale applied claim`, async () => {
    const states = []
    const f = await attach(runtime(), { onState: (state) => states.push(state) })
    const gate = deferred()
    if (stage === "apply") f.session.rpc.name.setAuto = () => gate.promise
    else f.session.rpc.name.get = () => gate.promise
    await admit(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    f.emit(complete())
    await tick()
    f.emit(start("clear", { args: { clear: true } }))
    gate.resolve(stage === "apply" ? { applied: true } : { name: "Workflow promotion review" })
    await f.consumer.waitForIdle()
    assert.equal(states.some((state) => state.state === "applied"), false)
  })
}

test("a superseded failing metadata check cannot overwrite the next observation's state", async () => {
  const states = []
  const f = await attach(runtime(), { onState: (state) => states.push(state) })
  let reject
  f.session.rpc.metadata.snapshot = () => new Promise((_, fail) => { reject = fail })
  await admit(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete())
  await tick()
  f.emit(start("clear", { args: { clear: true } }))
  reject(Error("superseded failure"))
  await f.consumer.waitForIdle()
  assert.deepEqual(states, [])
})

test("an unacknowledged transport failure fences subsequent native mutations, not just diagnostics", async () => {
  const f = await attach()
  const applyNative = f.session.rpc.name.setAuto
  let requests = 0
  let finishUnknownWrite
  f.session.rpc.name.setAuto = async (input) => {
    requests++
    if (requests === 1) {
      finishUnknownWrite = () => applyNative(input)
      throw Object.assign(Error("connection lost after request submission"), { code: "ECONNRESET" })
    }
    return applyNative(input)
  }
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  const stateAfterFailure = f.consumer.getState()
  await observe(f, start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }),
    complete("call-b", { identity: other, label: "Browser boundary qualification" }))
  const nameBeforeUnknownWriteSettles = f.name()
  await finishUnknownWrite()
  assert.deepEqual(f.writes, ["Workflow promotion review"])
  assert.equal(requests, 1)
  assert.equal(nameBeforeUnknownWriteSettles, null)
  assert.equal(f.name(), "Workflow promotion review")
  assert.equal(stateAfterFailure.code, "native_apply_uncertain")
})

test("a definite missing-method rejection has no delayed native effect and is not misreported as applied", async () => {
  const f = await attach()
  f.session.rpc.name.setAuto = async () => { throw Object.assign(Error("method unavailable"), { code: -32601 }) }
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "unsupported_runtime" })
  assert.equal(f.name(), null)
})

test("failed readback after an acknowledged write is unavailable, not a claim that the write never happened", async () => {
  const f = await attach()
  f.session.rpc.name.get = async () => { throw Object.assign(Error("readback disconnected"), { code: "ECONNRESET" }) }
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.equal(f.name(), "Workflow promotion review")
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_readback_failed" })
})

const readStages = ["snapshot", "recheck", "readback"]
const readCauses = ["timeout", "invalid_params", "internal_error", "rpc_error", "failed"]
const diagnosticCodes = new Set([
  "awaiting_task_observation", "owner_unknown", "unsupported_runtime", "provider_binding_unavailable",
  "native_ordering_unavailable", "missing_current_safe_proposal", "native_apply_uncertain",
  "native_owner_refused", "native_readback_verified", "native_readback_mismatch",
  ...readStages.flatMap((stage) => readCauses.map((cause) => `native_${stage}_${cause}`)),
])
const privateValue = "FAKE-PRIVATE-VALUE /Users/someone/private/path"
const privateError = (code) => Object.assign(Error(privateValue), { code, data: { prompt: privateValue }, stack: privateValue })
const settle = async () => { for (let i = 0; i < 5; i++) await tick() }
const never = () => new Promise(() => {})
const rejectionCases = [
  [-32602, "invalid_params"], [-32603, "internal_error"], [-32000, "rpc_error"],
  ["ECONNRESET", "failed"], [7, "failed"], [undefined, "failed"],
]

function assertSafeStates(states) {
  assert.ok(states.length > 0)
  for (const state of states) {
    assert.deepEqual(Object.keys(state).sort(), ["code", "state"])
    assert.ok(diagnosticCodes.has(state.code), `unexpected diagnostic ${state.code}`)
  }
  const text = JSON.stringify(states)
  for (const value of ["FAKE-PRIVATE-VALUE", "/Users/", "Workflow promotion review", expectedSessionId]) {
    assert.equal(text.includes(value), false)
  }
}

async function correlate(f, id = "call-a", identity = task, label = "Workflow promotion review") {
  await admit(f, start(id, { args: { ...identity, display_label: label } }))
  f.emit(complete(id, { identity, label }))
  await settle()
}

test("an initial metadata snapshot timeout names its stage only once the real default budget expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const states = []
  const fake = runtime()
  fake.session.rpc.metadata.snapshot = never
  let consumer
  const attaching = attachCopilotSessionLabels({ session: fake.session, expectedSessionId, onState: (state) => states.push(state) })
    .then((value) => { consumer = value })
  t.mock.timers.tick(1999)
  await settle()
  assert.equal(consumer, undefined)
  assert.deepEqual(states, [])
  t.mock.timers.tick(1)
  await attaching
  assert.deepEqual(consumer.getState(), { state: "unavailable", code: "native_snapshot_timeout" })
  assertSafeStates(states)
  assert.deepEqual(fake.writes, [])
})

for (const [code, cause] of rejectionCases) {
  test(`an initial metadata snapshot rejection with ${code ?? "no"} code is native_snapshot_${cause} without its payload`, async () => {
    const states = []
    const fake = runtime()
    fake.session.rpc.metadata.snapshot = async () => { throw privateError(code) }
    const f = await attach(fake, { onState: (state) => states.push(state) })
    assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: `native_snapshot_${cause}` })
    await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    assert.deepEqual(f.writes, [])
    assertSafeStates(states)
  })
}

test("a pre-write identity recheck timeout names the recheck stage and issues no write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const states = []
  const f = await attach(runtime(), { onState: (state) => states.push(state) })
  f.session.rpc.metadata.snapshot = never
  await correlate(f)
  t.mock.timers.tick(1999)
  await settle()
  assert.deepEqual(states, [])
  t.mock.timers.tick(1)
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_recheck_timeout" })
  assertSafeStates(states)
})

for (const [code, cause] of rejectionCases) {
  test(`a pre-write identity recheck rejection with ${code ?? "no"} code is native_recheck_${cause} and issues no write`, async () => {
    const states = []
    const f = await attach(runtime(), { onState: (state) => states.push(state) })
    f.session.rpc.metadata.snapshot = async () => { throw privateError(code) }
    await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: `native_recheck_${cause}` })
    assertSafeStates(states)
  })
}

test("a readback timeout after an acknowledged write names the readback stage, not a failed write or an applied label", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const states = []
  const f = await attach(runtime(), { onState: (state) => states.push(state) })
  f.session.rpc.name.get = never
  await correlate(f)
  t.mock.timers.tick(1999)
  await settle()
  assert.deepEqual(states, [])
  t.mock.timers.tick(1)
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, ["Workflow promotion review"])
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_readback_timeout" })
  assertSafeStates(states)
})

for (const [code, cause] of rejectionCases) {
  test(`a readback rejection with ${code ?? "no"} code is native_readback_${cause}, never applied`, async () => {
    const states = []
    const f = await attach(runtime(), { onState: (state) => states.push(state) })
    f.session.rpc.name.get = async () => { throw privateError(code) }
    await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    assert.deepEqual(f.writes, ["Workflow promotion review"])
    assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: `native_readback_${cause}` })
    assertSafeStates(states)
  })
}

test("a readback missing-method rejection remains unsupported_runtime", async () => {
  const f = await attach()
  f.session.rpc.name.get = async () => { throw privateError(-32601) }
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "unsupported_runtime" })
})

test("a setter timeout at the real default budget stays uncertain and fences every later automatic write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const states = []
  const f = await attach(runtime(), { onState: (state) => states.push(state) })
  const gate = deferred()
  const calls = []
  f.session.rpc.name.setAuto = ({ summary }) => { calls.push(summary); return gate.promise }
  await correlate(f)
  t.mock.timers.tick(2000)
  await f.consumer.waitForIdle()
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_apply_uncertain" })
  await correlate(f, "call-b", other, "Browser boundary qualification")
  await f.consumer.waitForIdle()
  gate.resolve({ applied: true })
  await settle()
  assert.deepEqual(calls, ["Workflow promotion review"])
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_apply_uncertain" })
  assertSafeStates(states)
})

for (const code of [-32602, -32603, "ECONNRESET"]) {
  test(`a setter rejection with ${code} code stays uncertain rather than becoming a stage-classified read failure`, async () => {
    const states = []
    const f = await attach(runtime(), { onState: (state) => states.push(state) })
    let calls = 0
    f.session.rpc.name.setAuto = async () => { calls++; throw privateError(code) }
    await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    await observe(f, start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }),
      complete("call-b", { identity: other, label: "Browser boundary qualification" }))
    assert.equal(calls, 1)
    assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_apply_uncertain" })
    assertSafeStates(states)
  })
}

const hostileErrors = {
  "throwing code getter": () => Object.defineProperty(Error(privateValue), "code", { get() { throw Error(privateValue) } }),
  "trap-throwing proxy": () => new Proxy({}, new Proxy({}, { get: () => () => { throw Error(privateValue) } })),
  "null": () => null,
  "bare string": () => privateValue,
}
for (const [kind, make] of Object.entries(hostileErrors)) {
  test(`a ${kind} readback failure is classified safely without escaping the naming queue`, async () => {
    const states = []
    const f = await attach(runtime(), { onState: (state) => states.push(state) })
    f.session.rpc.name.get = async () => { throw make() }
    await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_readback_failed" })
    assertSafeStates(states)
  })

  test(`a ${kind} setter failure still stops naming and blocks a later write`, async () => {
    const states = []
    const f = await attach(runtime(), { onState: (state) => states.push(state) })
    let calls = 0
    f.session.rpc.name.setAuto = async () => { calls++; throw make() }
    await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    await observe(f, start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }),
      complete("call-b", { identity: other, label: "Browser boundary qualification" }))
    assert.equal(calls, 1)
    assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_apply_uncertain" })
    assertSafeStates(states)
  })
}

test("a throwing diagnostic observer cannot change attachment, task continuity or the classified state", async () => {
  const fake = runtime()
  fake.session.rpc.metadata.snapshot = async () => { throw privateError(-32603) }
  const f = await attach(fake, { onState: () => { throw Error(privateValue) } })
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_snapshot_internal_error" })
  const result = await f.consumer.beforeMcpToolCall({
    sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus", toolCallId: "next", arguments: task,
  }, { sessionId: expectedSessionId })
  assert.equal(result, undefined)
  assert.deepEqual(f.writes, [])
})

for (const source of ["user", undefined]) {
  test(`name-only Desk lookalike with ${source ?? "missing"} native event provenance cannot mutate a name`, async () => {
    const f = await attach()
    const begin = start("call-a", { args: { ...task, display_label: "Workflow promotion review" } })
    if (source === undefined) delete begin.data.mcpConfigSource
    else begin.data.mcpConfigSource = source
    await observe(f, begin)
    assert.equal(f.name(), null)
    assert.deepEqual(f.writes, [])
  })
}

for (const mutation of ["user-source", "foreign-plugin", "different-artifact", "missing-host-binding"]) {
  test(`host-derived ${mutation} provider is unavailable for naming despite a matching alias`, async () => {
    const fake = runtime()
    const server = { name: "desk", source: "plugin", sourcePlugin: "desk", sourcePluginVersion: artifactVersion }
    if (mutation === "user-source") { server.source = "user"; delete server.sourcePlugin }
    if (mutation === "foreign-plugin") server.sourcePlugin = "other"
    if (mutation === "different-artifact") server.sourcePluginVersion = "0.0.0-foreign"
    if (mutation === "missing-host-binding") delete fake.session.rpc.mcp.listConfigured
    else fake.session.rpc.mcp.listConfigured = async () => ({ servers: [server] })
    const f = await attach(fake)
    await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    assert.equal(f.name(), null)
    assert.deepEqual(f.writes, [])
    assert.equal(f.consumer.getState().code, "provider_binding_unavailable")
  })
}

test("replacing the admitted provider after attachment cannot redirect a name write", async () => {
  const f = await attach()
  f.session.rpc.mcp.listConfigured = async () => ({ servers: [{ name: "desk", source: "user" }] })
  await observe(f, start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  assert.equal(f.name(), null)
  assert.deepEqual(f.writes, [])
  assert.equal(f.consumer.getState().code, "provider_binding_unavailable")
})

test("an in-memory user-config lookalike cannot replace the host-owned Desk provider", async () => {
  const f = await attach()
  const begin = start("call-a", { args: { ...task, display_label: "Workflow promotion review" } })
  begin.data.mcpTransport = "memory"
  begin.data.mcpConfigSource = "user"
  await observe(f, begin)
  assert.equal(f.name(), null)
  assert.deepEqual(f.writes, [])
})

test("transport alone is not an ownership policy for an otherwise bound host-owned provider", async () => {
  const f = await attach()
  const begin = start("call-a", { args: { ...task, display_label: "Workflow promotion review" } })
  begin.data.mcpTransport = "memory"
  await observe(f, begin)
  assert.equal(f.name(), "Workflow promotion review")
})

test("awaited pre-MCP ordering drains the native mutation before the next focus effect", async () => {
  const f = await attach()
  const gate = deferred()
  const nativeWrite = f.session.rpc.name.setAuto
  let currentTask = task
  const effects = []
  f.session.rpc.name.setAuto = async (input) => {
    await gate.promise
    effects.push({ name: input.summary, focus: currentTask })
    return nativeWrite(input)
  }
  f.emit(start("old", { args: { ...task, display_label: "Workflow promotion review" } }))
  await f.consumer.beforeMcpToolCall?.({
    sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus",
    toolCallId: "old", arguments: { ...task, display_label: "Workflow promotion review" },
  }, { sessionId: expectedSessionId })
  f.emit(complete("old"))
  await tick()
  f.emit(start("clear", { args: { clear: true } }))
  const before = f.consumer.beforeMcpToolCall?.({
    sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus",
    toolCallId: "clear", arguments: { clear: true },
  }, { sessionId: expectedSessionId }) ?? Promise.resolve()
  const actualClear = before.then(() => { currentTask = null })
  await tick()
  const focusWhileWritePending = currentTask
  gate.resolve()
  await actualClear
  await f.consumer.waitForIdle()
  assert.equal(focusWhileWritePending, task)
  assert.deepEqual(effects, [{ name: "Workflow promotion review", focus: task }])
  assert.equal(currentTask, null)
  assert.equal(f.name(), "Workflow promotion review")
})

test("notification-only results without a supported pre-MCP receipt cannot mutate the native name", async () => {
  const f = await attach()
  f.emit(start("unadmitted", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete("unadmitted"))
  await f.consumer.waitForIdle()
  assert.equal(f.name(), null)
  assert.deepEqual(f.writes, [])
  assert.equal(f.consumer.getState().code, "native_ordering_unavailable")
})

for (const orderingBudgetMs of [5, Infinity]) {
  test(`a stalled name write with budget ${orderingBudgetMs} cannot ban the next task effect`, async () => {
    const f = await attach(runtime(), { timeoutMs: 2000, orderingBudgetMs })
    const gate = deferred()
    const nativeWrite = f.session.rpc.name.setAuto
    f.session.rpc.name.setAuto = async (input) => { await gate.promise; return nativeWrite(input) }
    await admit(f, start("old", { args: { ...task, display_label: "Workflow promotion review" } }))
    f.emit(complete("old"))
    await tick()
    let watchdog
    const workRoot = await fs.mkdtemp(path.join(process.env.DESK_TEST_RUN_DIR, "naming-work-continues-"))
    const workResult = path.join(workRoot, "result.txt")
    try {
      const output = await Promise.race([
        f.consumer.beforeMcpToolCall({
          sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus",
          toolCallId: "new", arguments: other,
        }, { sessionId: expectedSessionId }),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error("naming stranded task execution")), 2500) }),
      ])
      assert.equal(output, undefined, "no deny decision or MCP metadata rewrite")
      await fs.writeFile(workResult, "authorized work completed\n")
      assert.equal(await fs.readFile(workResult, "utf8"), "authorized work completed\n")
      assert.equal(f.consumer.getState().code, "native_apply_uncertain")
    } finally {
      clearTimeout(watchdog)
      gate.resolve()
      await f.consumer.waitForIdle()
    }
    // No claim of cancellation: an already-submitted write can settle late.
    // It must stay unavailable, not claim current naming or block work.
    assert.equal(f.name(), "Workflow promotion review")
    assert.equal(f.consumer.getState().code, "native_apply_uncertain")
    assert.equal(await fs.readFile(workResult, "utf8"), "authorized work completed\n")
  })
}

test("a native pre-MCP receipt may arrive before the native start notification", async () => {
  const f = await attach()
  await f.consumer.beforeMcpToolCall({
    sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus",
    toolCallId: "call-a", arguments: { ...task, display_label: "Workflow promotion review" },
  }, { sessionId: expectedSessionId })
  f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete())
  await f.consumer.waitForIdle()
  assert.equal(f.name(), "Workflow promotion review")
})

for (const missing of ["tool-call-id", "own-session", "root-origin"]) {
  test(`a pre-MCP hook lacking ${missing} cannot authorize a native name mutation`, async () => {
    const f = await attach()
    const input = {
      sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus",
      toolCallId: "call-a", arguments: { ...task, display_label: "Workflow promotion review" },
    }
    if (missing === "tool-call-id") delete input.toolCallId
    if (missing === "own-session") input.sessionId = "foreign"
    if (missing === "root-origin") input.agentId = "child"
    f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
    await f.consumer.beforeMcpToolCall(input, { sessionId: expectedSessionId })
    f.emit(complete())
    await f.consumer.waitForIdle()
    assert.equal(f.name(), null)
    assert.deepEqual(f.writes, [])
  })
}

test("a newer awaited pre-MCP hook invalidates old results even before its start notification arrives", async () => {
  const f = await attach()
  await admit(f, start("old", { args: { ...task, display_label: "Workflow promotion review" } }))
  await f.consumer.beforeMcpToolCall({
    sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus",
    toolCallId: "clear", arguments: { clear: true },
  }, { sessionId: expectedSessionId })
  // The new request may now execute; its start notification can be delayed.
  f.emit(complete("old"))
  await f.consumer.waitForIdle()
  assert.equal(f.name(), null)
  assert.deepEqual(f.writes, [])
})

test("a queued old proposal cannot mutate the name after the next native start", async () => {
  const f = await attach()
  await admit(f, start("old", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete("old"))
  await admit(f, start("new", { args: { ...other, display_label: "Browser boundary qualification" } }))
  f.emit(complete("new", { identity: other, label: "Browser boundary qualification" }))
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, ["Browser boundary qualification"])
})

test("disposal while host ownership is being rechecked cannot mutate the name", async () => {
  const f = await attach()
  const gate = deferred()
  f.session.rpc.mcp.listConfigured = () => gate.promise
  await admit(f, start("old", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete("old"))
  await tick()
  const stopping = f.consumer.dispose()
  gate.resolve({ servers: [{ name: "desk", source: "plugin", sourcePlugin: "desk", sourcePluginVersion: artifactVersion }] })
  await stopping
  assert.equal(f.name(), null)
  assert.deepEqual(f.writes, [])
})

test("a failed host ownership read makes only naming unavailable and returns control to the caller", async () => {
  const fake = runtime()
  fake.session.rpc.mcp.listConfigured = async () => { throw Error("private provider details") }
  const f = await attach(fake)
  const result = await f.consumer.beforeMcpToolCall({
    sessionId: expectedSessionId, serverName: "desk", toolName: "task_focus",
    toolCallId: "next", arguments: task,
  }, { sessionId: expectedSessionId })
  assert.equal(result, undefined)
  assert.equal(f.consumer.getState().code, "provider_binding_unavailable")
  assert.equal(f.name(), null)
})
