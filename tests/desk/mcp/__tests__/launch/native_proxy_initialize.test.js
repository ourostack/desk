import test from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import path from "node:path"
import { mcpRoot } from "./_mcp_handshake.js"
const require = createRequire(import.meta.url)
const proxy = require(path.join(mcpRoot, "web-proxy.cjs"))

test("async native owner initialization must finish before MCP child spawn", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  let finish
  const initialized = new Promise(resolve => { finish = resolve })
  let spawns = 0
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    onInitialize: async launch => {
      await initialized
      launch.args.push("--cdp-endpoint", "private-ready")
    },
    spawn: (_file, args) => {
      spawns++
      assert.ok(args.includes("private-ready"))
      throw new Error("test child launch refused")
    },
    spawnPayload: () => ({ code: "test-refused" }),
  })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "owner" } } }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawns, 0, "native acquisition may not race MCP attachment")
  finish()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawns, 1)
  stdin.end()
  await running
})

test("native shutdown during initialization waits for exact pre-child cleanup", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  let finish
  const initialized = new Promise(resolve => { finish = resolve })
  let cleanups = 0
  let finished = false
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    onInitialize: () => initialized,
    cleanupBeforeReady: true,
    cleanup: async () => { cleanups++ },
    spawn: () => { throw new Error("closed initialization must never spawn") },
    spawnPayload: () => ({ code: "test-refused" }),
  }).then(() => { finished = true })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "owner" } } }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 10))
  stdin.end()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(finished, false)
  finish()
  await running
  assert.equal(cleanups, 1)
})

test("native close waits for the exact forwarded operation before clearing owned targets", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 90000
  let pending
  let received
  const inFlight = new Promise(resolve => { received = resolve })
  let cleared = 0
  let closedReply
  const replied = new Promise(resolve => { closedReply = resolve })
  child.stdin.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const message = JSON.parse(line)
      if (message.method === "initialize") child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }) + "\n")
      else if (message.method === "tools/call") { pending = message; received() }
    }
  })
  stdout.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) if (JSON.parse(line).id === 3) closedReply()
  })
  child.stdin.on("end", () => child.emit("exit", 0, null))
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    spawn: () => child, exit: () => {}, kill: () => {},
    spawnPayload: () => ({ code: "test-refused" }), exitPayload: () => ({ code: "fixture-exited" }),
    beforeCall: (params, api) => params.name !== "browser_close" ? Promise.resolve(null) :
      api.waitForPendingCalls(1000).then(() => {
        cleared++
        return { content: [{ type: "text", text: "closed" }] }
      }),
  })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n")
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } }) + "\n")
  await inFlight
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_close", arguments: {} } }) + "\n")
  await new Promise(setImmediate)
  assert.equal(cleared, 0)
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: pending.id, result: { content: [] } }) + "\n")
  await replied
  assert.equal(cleared, 1)
  stdin.end()
  await running
})

test("a native MCP child that exits before handshake still cleans its acquired backend", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 90000
  let cleanups = 0
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    cleanupBeforeReady: true,
    cleanup: async api => { assert.equal(api.childReady(), false); cleanups++ },
    spawn: () => { setImmediate(() => child.emit("exit", 1, null)); return child },
    exitPayload: () => ({ code: "fixture-exited" }), spawnPayload: () => ({ code: "test-refused" }),
  })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(cleanups, 1)
  stdin.end()
  await running
})

test("native transport replacement reinitializes only the MCP child before the next new call", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const messages = []
  const launches = []
  const userCalls = []
  let cleanupCount = 0
  stdout.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(JSON.parse(line))
  })
  const initial = { node: process.execPath, indexFile: "/fixture", args: ["original-endpoint"], env: {}, secrets: [] }
  const replacement = { ...initial, args: ["restored-endpoint"] }
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: initial }),
    closeMs: 100, holdMs: 1000, exit: () => {}, kill: () => {},
    cleanup: async () => { cleanupCount++ },
    spawnPayload: error => ({ code: error.code ?? "fixture-failed" }), exitPayload: () => ({ code: "fixture-ended" }),
    beforeCall: async (params, api) => {
      if (params.name === "browser_snapshot") await api.restartChild(replacement)
      return null
    },
    spawn: (_file, args) => {
      const child = new EventEmitter()
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 90000 + launches.length
      const generation = launches.length
      launches.push(args)
      child.stdin.on("data", chunk => {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const message = JSON.parse(line)
          if (!message.id) continue
          let result
          if (message.method === "initialize") result = { capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
          else if (message.method === "tools/list") result = { tools: [] }
          else {
            userCalls.push({ generation, name: message.params.name })
            result = { content: [{ type: "text", text: "owned result" }] }
          }
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
        }
      })
      child.stdin.on("end", () => setImmediate(() => child.emit("exit", 0, null)))
      child.kill = () => child.emit("exit", 0, null)
      return child
    },
  })
  async function ask(id, name) {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }) + "\n")
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = messages.find(message => message.id === id)
      if (response) return response
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error("fixture response timed out")
  }
  try {
    assert.equal((await ask(2, "browser_navigate")).result.isError, undefined)
    assert.equal((await ask(3, "browser_snapshot")).result.isError, undefined)
    assert.deepEqual(userCalls, [{ generation: 0, name: "browser_navigate" }, { generation: 1, name: "browser_snapshot" }])
    assert.equal(launches.length, 2)
    assert.ok(launches[1].includes("restored-endpoint"))
    assert.equal(cleanupCount, 0, "transport replacement must not release browser-side ownership")
  } finally {
    stdin.end()
    await running
  }
  assert.equal(cleanupCount, 1)
})
