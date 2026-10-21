import "../_isolated_env.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import { makeSessionLabelProposal } from "../../../../../plugins/desk/mcp/src/runtime/session-label.js"
import { attachCopilotSessionLabels } from "../../../../../plugins/desk/extensions/session-label/consumer.mjs"
const task = { track: "engineering", slug: "workflow-review" }
const other = { track: "engineering", slug: "browser-boundary" }
const expectedSessionId = "owned-main-session"
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
    data: { toolCallId: id, toolName: `desk-${tool}`, mcpServerName: "desk", mcpToolName: tool, arguments: args },
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

async function observe(fixture, begin = start(), end = complete()) {
  fixture.emit(begin)
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
  f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }))
  f.emit(complete())
  f.emit(complete("call-b", { identity: other, label: "Browser boundary qualification" }))
  f.emit(complete("call-b", { identity: other, label: "Browser boundary qualification" }))
  await f.consumer.waitForIdle()
  assert.deepEqual(f.writes, ["Browser boundary qualification"])
})

test("standalone clear invalidates a pending proposal without calling any native setter", async () => {
  const f = await attach()
  f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(start("clear", { args: { clear: true } }))
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
  f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
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
  f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
  f.emit(complete())
  await tick()
  f.emit(start("call-b", { args: { ...other, display_label: "Browser boundary qualification" } }))
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
  f.emit(start("old", { args: { ...task, display_label: "Workflow promotion review" } }))
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
  f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
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
    f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
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
  f.emit(start("call-a", { args: { ...task, display_label: "Workflow promotion review" } }))
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
  assert.deepEqual(f.consumer.getState(), { state: "unavailable", code: "native_api_failed" })
})
