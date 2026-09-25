// The front door: a dependency-free MCP server that answers the handshake at once and hands tool calls to the session.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { PassThrough } from "node:stream"
import { DOCTOR_REPAIRS, FRONT_DOOR_TOOLS, startFrontDoor } from "../../src/runtime/front-door.js"
import { TOOL_NAMES } from "../../src/tool-names.js"

function serve(options = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = []
  let buffered = ""
  output.on("data", (chunk) => {
    buffered += chunk.toString("utf8")
    let newline
    while ((newline = buffered.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
    }
  })
  const door = startFrontDoor({ input, output, ...options })
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  return { input, output, lines, door, send }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test("the tool list is the canonical one, and desk_doctor takes a format and a repair", () => {
  assert.deepEqual(FRONT_DOOR_TOOLS.map((tool) => tool.name), TOOL_NAMES)
  const doctor = FRONT_DOOR_TOOLS.find((tool) => tool.name === "desk_doctor")
  assert.deepEqual(doctor.inputSchema.properties.repair.enum, ["switch_state_branch", "prune_readiness_state"])
  assert.deepEqual(DOCTOR_REPAIRS, ["switch_state_branch", "prune_readiness_state"])
  assert.equal(doctor.inputSchema.additionalProperties, false)
})

test("initialize, ping, tools/list, unknown methods and parse errors answer at once; the handshake fires once", async () => {
  const handshakes = []
  const { lines, send, input, door } = serve({ serverVersion: "1.2.3", callTool: () => assert.fail("no call"), onHandshake: () => handshakes.push("h") })
  send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })
  send({ id: 2, method: "initialize", params: {} })
  send({ id: 3, method: "ping" })
  send({ id: 4, method: "tools/list" })
  send({ method: "notifications/initialized" })
  send({ method: "notifications/other" })
  send({ id: 5, method: "resources/list" })
  input.write("{not json\n\n")
  input.end()
  await door.closed
  assert.deepEqual(handshakes, ["h"])
  assert.equal(lines[0].result.protocolVersion, "2024-11-05")
  assert.deepEqual(lines[0].result.serverInfo, { name: "desk-mcp", version: "1.2.3" })
  assert.deepEqual(lines[0].result.capabilities, { tools: { listChanged: true } })
  assert.equal(lines[1].result.protocolVersion, "2025-06-18")
  assert.deepEqual(lines[2].result, {})
  assert.deepEqual(lines[3].result.tools.map((tool) => tool.name), TOOL_NAMES)
  assert.equal(lines[4].error.code, -32601)
  assert.equal(lines[5].error.code, -32700)
  assert.equal(lines.length, 6)
})

test("notifications/initialized alone fires the handshake, and tools/list_changed is sent only after it", async () => {
  const handshakes = []
  const { lines, send, input, door } = serve({ callTool: () => ({}), onHandshake: () => handshakes.push("h") })
  door.notifyToolsChanged()
  send({ method: "notifications/initialized" })
  door.notifyToolsChanged()
  input.end()
  await door.closed
  assert.deepEqual(handshakes, ["h"])
  assert.deepEqual(lines, [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }])
})

test("tool calls answer synchronously or later, errors become isError results, and input end waits for calls in flight", async () => {
  let release
  const calls = []
  const { lines, send, input, door } = serve({
    callTool: ({ name, input: toolInput, signal }) => {
      calls.push([name, toolInput, signal instanceof AbortSignal])
      if (name === "desk_status") return { content: [{ type: "text", text: "sync" }] }
      if (name === "desk_search") return new Promise((resolve) => { release = resolve })
      if (name === "desk_recall") return Promise.reject(new Error("async failure"))
      if (name === "desk_similar") return Promise.reject("not an error")
      throw new Error("sync failure")
    },
  })
  send({ id: 1, method: "tools/call", params: { name: "desk_status" } })
  send({ id: 2, method: "tools/call", params: { name: "desk_search", arguments: { query: "x" } } })
  send({ id: 3, method: "tools/call", params: { name: "desk_recall" } })
  send({ id: 4, method: "tools/call", params: { name: "desk_similar" } })
  send({ id: 5, method: "tools/call", params: {} })
  input.end()
  await tick()
  release({ content: [{ type: "text", text: "late" }] })
  await door.closed
  assert.deepEqual(calls[1], ["desk_search", { query: "x" }, true])
  assert.deepEqual(calls[0][1], {})
  const byId = new Map(lines.map((line) => [line.id, line]))
  assert.equal(byId.get(1).result.content[0].text, "sync")
  assert.equal(byId.get(2).result.content[0].text, "late")
  assert.deepEqual(JSON.parse(byId.get(3).result.content[0].text), { status: "error", tool: "desk_recall", message: "async failure" })
  assert.equal(JSON.parse(byId.get(4).result.content[0].text).message, "not an error")
  assert.deepEqual(JSON.parse(byId.get(5).result.content[0].text), { status: "error", tool: null, message: "sync failure" })
  assert.equal(byId.get(5).result.isError, true)
})

test("notifications/cancelled aborts the matching call in flight", async () => {
  const reasons = []
  const { lines, send, input, door } = serve({
    callTool: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        reasons.push(signal.reason.message)
        resolve({ content: [{ type: "text", text: "cancelled" }] })
      })
    }),
  })
  send({ id: 7, method: "tools/call", params: { name: "desk_search" } })
  send({ id: 8, method: "tools/call", params: { name: "desk_search" } })
  await tick()
  send({ method: "notifications/cancelled", params: { requestId: 7, reason: "user stopped" } })
  send({ method: "notifications/cancelled", params: { requestId: 8 } })
  send({ method: "notifications/cancelled", params: { requestId: 99 } })
  input.end()
  await door.closed
  assert.deepEqual(reasons, ["user stopped", "cancelled by the client"])
  assert.equal(lines.length, 2)
})

test("a closed output drops writes, and an input error rejects closed", async () => {
  const { send, output, door, input } = serve({ callTool: () => ({}) })
  output.destroy()
  send({ id: 1, method: "ping" })
  input.destroy(new Error("stdin broke"))
  await assert.rejects(door.closed, /stdin broke/u)
  const ended = serve({ callTool: () => ({}) })
  ended.output.end()
  ended.send({ id: 1, method: "ping" })
  ended.input.end()
  await ended.door.closed
})

test("a final line without a newline is still answered at input end", async () => {
  const { lines, input, door } = serve({ callTool: () => ({}) })
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }))
  await door.closed
  assert.deepEqual(lines, [{ jsonrpc: "2.0", id: 1, result: {} }])
})

test("the default handshake hook is optional", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const door = startFrontDoor({ input, output, callTool: () => ({}) })
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`)
  await door.closed
})
