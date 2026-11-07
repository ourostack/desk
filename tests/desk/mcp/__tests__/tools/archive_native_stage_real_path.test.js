// Controlled regression for the callTool and startServer seams only: real callTool + real task_archive + real wrapper retire + real frame writer.
// Only the native child process is fake. startServer is not the production entry (index.js runs front-door.js -> desk-session.js);
// runtime/front_door_trace_id.test.js covers that path.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { openArchiveHandleSession } from "../../../../../plugins/desk/mcp/src/tools/archive-native-session.js"
import { NATIVE_STAGES } from "../../../../../plugins/desk/mcp/src/tools/native-stage-context.js"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { callTool, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"

const GATE = { CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1", DESK_BLACKBOX_NATIVE_STAGE_TRACE: "1" }
const pair = { source: "C:\\owned\\PRIVATE_SOURCE", destination: "C:\\owned\\archive\\PRIVATE_SOURCE" }
const methods = ["CreateFileW", "GetFileInformationByHandleEx", "GetVolumeInformationByHandleW", "SetFileInformationByHandle", "CloseHandle"]
const volumeHex = "8877665544332211", fileIdHex = "08070605040302011020304050607080"
const sample = (role, extra = {}) => ({ role, access: role === "held" ? 65536 : 0, share: role === "held" ? 3 : 7, flags: 35651584, creation: 3,
  openSuccess: true, openError: null, volumeSuccess: true, volumeError: null, filesystem: "NTFS", idSuccess: true, idError: null, volumeHex, fileIdHex,
  attributeSuccess: true, attributeError: null, attributes: 16, reparseTag: 0, closeSuccess: ["admitted", "current"].includes(role) ? true : null, closeError: null, ...extra })
const layout = { pointerSize: 8, headerSize: 24, replaceOffset: 0, rootOffset: 8, lengthOffset: 16, nameOffset: 20, littleEndian: true }

function fakeChild(onMove, staged = true) {
  const child = new EventEmitter()
  child.pid = 42
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const samples = { baseline: sample("baseline"), admitted: null, held: null, current: null }
  const emit = item => child.stdout.emit("data", Buffer.from(typeof item === "string" ? item : JSON.stringify(item) + "\n"))
  const finish = moved => {
    for (const v of Object.values(samples)) if (v?.openSuccess) v.closeSuccess = true
    const opened = Object.values(samples).filter(v => v?.openSuccess).length
    const same = (a, b) => !!(a?.openSuccess && b?.openSuccess && a.fileIdHex === b.fileIdHex)
    emit({ state: "result", disposition: moved ? "moved" : "closed", phase: moved ? "rename" : "close", moved, failure: null, samples,
      comparisons: { admittedMatchesBaseline: same(samples.admitted, samples.baseline), heldMatchesBaseline: same(samples.held, samples.baseline),
        currentMatchesBaseline: same(samples.current, samples.baseline), currentMatchesHeld: same(samples.current, samples.held) },
      rename: { attempted: moved, success: moved ? true : null, error: null, byHandle: moved, replaceIfExists: false, rootDirectoryNull: true, bufferValidated: moved },
      handles: { opened, closeAttempts: opened, closed: opened, closeFailures: 0, disposals: Object.keys(samples).filter(r => samples[r]?.openSuccess).map(role => ({ role, success: true, error: null })) } })
    child.emit("exit", 0, null); child.emit("close", 0, null)
  }
  child.stdin.write = text => {
    queueMicrotask(() => {
      if (text.startsWith("{")) {
        if (staged) NATIVE_STAGES.forEach((name, i) => emit(`DESK_STAGE ${name} 42 ${10 * (i + 1)}\n`))
        emit({ state: "captured", pid: 42, powershell: "5.1.26100.33438", runtime: "4.0.30319.42000", edition: "Desktop", architecture: "AMD64",
          compiler: "reflection_emit_in_process", metadata: methods.map(method => ({ method, verified: true })), layout, baseline: samples.baseline })
      } else if (text === "admit\n") {
        samples.admitted = sample("admitted")
        emit({ state: "ready", pid: 42, admitted: samples.admitted, matchesBaseline: true })
      }
    })
    return false
  }
  child.stdin.end = text => {
    queueMicrotask(async () => {
      if (text === "move\n") { samples.held = sample("held"); await onMove(); samples.current = sample("current"); finish(true) } else finish(false)
    })
    return child.stdin
  }
  child.kill = () => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM") }
  return child
}

async function fixture() {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "s", title: "S", status: "done" }, schedulePush() {} })
  return { root, source: path.join(root, "t", "s"), destination: path.join(root, "t", "_archive", "s") }
}

async function drive(env, id) {
  const f = await fixture(), frames = []
  const original = TOOL_IMPLS.task_archive
  TOOL_IMPLS.task_archive = args => task_archive({ ...args, schedulePush() {}, openArchiveMove: () => openArchiveHandleSession(pair, {
    platform: "win32", arch: "x64", env: { SystemRoot: "C:\\Windows", ...env }, realpath: async v => v,
    spawn() { const c = fakeChild(() => fs.rename(f.source, f.destination), env.DESK_BLACKBOX_NATIVE_STAGE_TRACE === "1"); queueMicrotask(() => c.emit("spawn")); return c },
    setTimeout: (cb, ms) => setTimeout(cb, ms / 5), clearTimeout }) })
  try {
    const result = await callTool({ deskRoot: f.root, name: "task_archive", input: { track: "t", slug: "s" }, env: { ...process.env, ...env },
      traceRequestId: id, traceWrite: l => frames.push(l) })
    return { f, result, frames }
  } finally { TOOL_IMPLS.task_archive = original }
}

test("real task_archive success under the gate: a passing archive emits exactly one stage frame for its request id", async () => {
  const { f, result, frames } = await drive(GATE, 7)
  assert.equal(JSON.parse(result.content[0].text).status, "archived")
  assert.equal(await exists(f.destination), true)
  const parsed = frames.map(l => JSON.parse(l.slice("DESK_NATIVE_RECEIPT_V1 ".length)))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].requestId, 7)
  assert.equal(parsed[0].receipt.nativeStages.length, 5)
})

test("real task_archive success without the stage gate: no frame and the same result", async () => {
  const { result, frames } = await drive({}, 8)
  assert.equal(JSON.parse(result.content[0].text).status, "archived")
  assert.equal(frames.length, 0)
})

test("actual MCP request handler over an in-memory transport: success frame reaches stderr with the JSON-RPC request id", async t => {
  const { InMemoryTransport } = await import("../../../../../plugins/desk/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js")
  const { Client } = await import("../../../../../plugins/desk/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")
  const { startServer, createMcpServer } = await import("../../../../../plugins/desk/mcp/src/server.js")
  const f = await fixture(), saved = {}
  for (const [k, v] of Object.entries(GATE)) { saved[k] = process.env[k]; process.env[k] = v }
  const written = []
  const write = process.stderr.write.bind(process.stderr)
  t.mock.method(process.stderr, "write", (chunk, ...rest) => { written.push(String(chunk)); return write("", ...rest) })
  const original = TOOL_IMPLS.task_archive
  TOOL_IMPLS.task_archive = args => task_archive({ ...args, schedulePush() {}, openArchiveMove: () => openArchiveHandleSession(pair, {
    platform: "win32", arch: "x64", env: { SystemRoot: "C:\\Windows", ...GATE }, realpath: async v => v,
    spawn() { const c = fakeChild(() => fs.rename(f.source, f.destination)); queueMicrotask(() => c.emit("spawn")); return c },
    setTimeout: (cb, ms) => setTimeout(cb, ms / 5), clearTimeout }) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await startServer({ deskRoot: f.root, server: createMcpServer(), transport: a })
    const client = new Client({ name: "t", version: "0" })
    await client.connect(b)
    const res = await client.callTool({ name: "task_archive", arguments: { track: "t", slug: "s" } })
    assert.equal(JSON.parse(res.content[0].text).status, "archived")
    const frames = written.filter(l => l.startsWith("DESK_NATIVE_RECEIPT_V1 "))
    assert.equal(frames.length, 1)
    assert.equal(Number.isSafeInteger(JSON.parse(frames[0].slice(23)).requestId), true)
    await client.close()
  } finally {
    TOOL_IMPLS.task_archive = original
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
