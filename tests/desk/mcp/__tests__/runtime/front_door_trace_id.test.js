// The production path for the #581 native receipt trace: JSON-RPC front door -> desk session -> runtime callTool.
// Only the native child is fake (it needs Windows). The front door, the session and server.js callTool are the real ones, so a request id
// that is dropped between them leaves a tool with nothing to attach its trace frame to.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"
import { startFrontDoor } from "../../../../../plugins/desk/mcp/src/runtime/front-door.js"
import { createDeskSession } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { callTool, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import { openArchiveHandleSession } from "../../../../../plugins/desk/mcp/src/tools/archive-native-session.js"
import { NATIVE_STAGES } from "../../../../../plugins/desk/mcp/src/tools/native-stage-context.js"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { makeGitDesk } from "./_admission_fixtures.js"

const GATE = { CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1", DESK_BLACKBOX_NATIVE_STAGE_TRACE: "1" }
const FRAME = "DESK_NATIVE_RECEIPT_V1 "
const tick = () => new Promise((resolve) => setImmediate(resolve))

const pair = { source: "C:\\owned\\PRIVATE_SOURCE", destination: "C:\\owned\\archive\\PRIVATE_SOURCE" }
const methods = ["CreateFileW", "GetFileInformationByHandleEx", "GetVolumeInformationByHandleW", "SetFileInformationByHandle", "CloseHandle"]
const sample = (role, extra = {}) => ({ role, access: role === "held" ? 65536 : 0, share: role === "held" ? 3 : 7, flags: 35651584, creation: 3,
  openSuccess: true, openError: null, volumeSuccess: true, volumeError: null, filesystem: "NTFS", idSuccess: true, idError: null,
  volumeHex: "8877665544332211", fileIdHex: "08070605040302011020304050607080", attributeSuccess: true, attributeError: null, attributes: 16,
  reparseTag: 0, closeSuccess: ["admitted", "current"].includes(role) ? true : null, closeError: null, ...extra })
const layout = { pointerSize: 8, headerSize: 24, replaceOffset: 0, rootOffset: 8, lengthOffset: 16, nameOffset: 20, littleEndian: true }

// A native child that completes the staged capture; `fail` makes the capture itself never arrive.
function fakeChild(onMove, { fail = false, staged = true } = {}) {
  const child = new EventEmitter()
  child.pid = 42
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const samples = { baseline: sample("baseline"), admitted: null, held: null, current: null }
  const emit = (item) => child.stdout.emit("data", Buffer.from(typeof item === "string" ? item : `${JSON.stringify(item)}\n`))
  const finish = (moved) => {
    for (const value of Object.values(samples)) if (value?.openSuccess) value.closeSuccess = true
    const opened = Object.values(samples).filter((value) => value?.openSuccess).length
    const same = (a, b) => !!(a?.openSuccess && b?.openSuccess && a.fileIdHex === b.fileIdHex)
    emit({ state: "result", disposition: moved ? "moved" : "closed", phase: moved ? "rename" : "close", moved, failure: null, samples,
      comparisons: { admittedMatchesBaseline: same(samples.admitted, samples.baseline), heldMatchesBaseline: same(samples.held, samples.baseline),
        currentMatchesBaseline: same(samples.current, samples.baseline), currentMatchesHeld: same(samples.current, samples.held) },
      rename: { attempted: moved, success: moved ? true : null, error: null, byHandle: moved, replaceIfExists: false, rootDirectoryNull: true, bufferValidated: moved },
      handles: { opened, closeAttempts: opened, closed: opened, closeFailures: 0, disposals: Object.keys(samples).filter((role) => samples[role]?.openSuccess).map((role) => ({ role, success: true, error: null })) } })
    child.emit("exit", 0, null); child.emit("close", 0, null)
  }
  child.stdin.write = (text) => {
    queueMicrotask(() => {
      if (text.startsWith("{")) {
        if (fail) return
        if (staged) NATIVE_STAGES.forEach((name, index) => emit(`DESK_STAGE ${name} 42 ${10 * (index + 1)}\n`))
        emit({ state: "captured", pid: 42, powershell: "5.1.26100.33438", runtime: "4.0.30319.42000", edition: "Desktop", architecture: "AMD64",
          compiler: "reflection_emit_in_process", metadata: methods.map((method) => ({ method, verified: true })), layout, baseline: samples.baseline })
      } else if (text === "admit\n") {
        samples.admitted = sample("admitted")
        emit({ state: "ready", pid: 42, admitted: samples.admitted, matchesBaseline: true })
      }
    })
    return false
  }
  child.stdin.end = (text) => {
    queueMicrotask(async () => {
      if (text === "move\n") { samples.held = sample("held"); await onMove(); samples.current = sample("current"); finish(true) } else finish(false)
    })
    return child.stdin
  }
  child.kill = () => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM") }
  return child
}

// Real front door -> real session -> real runtime callTool over a real git desk. `slugs` names the done tasks to archive.
async function productionDoor(t, { env, fail = false, slugs = ["s"] }) {
  const fixture = await makeGitDesk("front-door-trace-")
  const root = fixture.desk
  for (const slug of slugs) await task_create({ deskRoot: root, input: { track: "t", slug, title: slug, status: "done" }, schedulePush() {} })
  const original = TOOL_IMPLS.task_archive
  TOOL_IMPLS.task_archive = (args) => task_archive({ ...args, schedulePush() {}, openArchiveMove: () => {
    const source = path.join(root, "t", args.input.slug), destination = path.join(root, "t", "_archive", args.input.slug)
    return openArchiveHandleSession(pair, {
      platform: "win32", arch: "x64", env: { SystemRoot: "C:\\Windows", ...env }, realpath: async (value) => value,
      spawn() { const child = fakeChild(() => fs.rename(source, destination), { fail, staged: env.DESK_BLACKBOX_NATIVE_STAGE_TRACE === "1" }); queueMicrotask(() => child.emit("spawn")); return child },
      setTimeout: (callback, ms) => setTimeout(callback, ms / 5), clearTimeout })
  } })
  const frames = []
  const write = process.stderr.write.bind(process.stderr)
  t.mock.method(process.stderr, "write", (chunk, ...rest) => { const text = String(chunk); if (text.startsWith(FRAME)) frames.push(JSON.parse(text.slice(FRAME.length))); return write("", ...rest) })
  const saved = {}
  for (const key of Object.keys(GATE)) saved[key] = process.env[key]
  Object.assign(process.env, env)
  const session = createDeskSession({
    args: { person: null }, deskStateDir: fixture.stateDir, readinessStateHome: fixture.readinessHome,
    resolveInputs: async () => ({ root: { root, source: "explicit-root" }, activation: { activationStatus: null, stateBranch: "main",
      readinessPolicy: { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" } } }),
    loadRuntime: async () => ({ runtimeServer: { callTool, createSearchEngine: () => ({ warm() {}, noteChange() {}, searchStatus: () => ({ state: "idle" }), async close() {} }) }, runtimeStatus: { state: "ready" } }),
    stderr: { write() {} },
  })
  const input = new PassThrough(), output = new PassThrough()
  const lines = []
  output.on("data", (chunk) => { for (const line of chunk.toString("utf8").split("\n")) if (line) lines.push(JSON.parse(line)) })
  const door = startFrontDoor({ input, output, callTool: (call) => session.callTool(call) })
  t.after(async () => {
    TOOL_IMPLS.task_archive = original
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    input.end(); await door.closed; await session.dispose()
  })
  await session.start()
  for (let tries = 0; session.admission.snapshot().state !== "ready"; tries += 1) {
    assert.ok(tries < 1000, "session never became ready")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  const answer = async (id) => {
    for (let tries = 0; !lines.some((line) => line.id === id); tries += 1) { assert.ok(tries < 1500, `no answer for ${id}`); await new Promise((resolve) => setTimeout(resolve, 10)) }
    return lines.find((line) => line.id === id)
  }
  return { send, answer, frames, root }
}

// The fake native child performed the move; publishing that move to git is the git fixture's business and may legitimately report archive_pending on Windows.
async function archivedByNative(root, reply) {
  const body = JSON.parse(reply.result.content[0].text)
  assert.ok(["archived", "archive_pending"].includes(body.status), JSON.stringify(body))
  await fs.access(path.join(root, "t", "_archive", "s"))
}

const archiveCall = (id, slug = "s") => ({ id, method: "tools/call", params: { name: "task_archive", arguments: { track: "t", slug } } })

test("through the real front door and session, a gated task_archive emits one stage frame carrying its JSON-RPC id", async (t) => {
  const { send, answer, frames, root } = await productionDoor(t, { env: GATE })
  send(archiveCall(41))
  const reply = await answer(41)
  await archivedByNative(root, reply)
  assert.deepEqual(frames.map((frame) => frame.requestId), [41])
  assert.equal(frames[0].receipt.nativeStages.length, 5)
})

test("interleaved gated calls each get exactly their own request id", async (t) => {
  const { send, answer, frames } = await productionDoor(t, { env: GATE, slugs: ["a", "b"] })
  send(archiveCall(5, "a")); send(archiveCall(9, "b"))
  await Promise.all([answer(5), answer(9)])
  assert.deepEqual(frames.map((frame) => frame.requestId).sort(), [5, 9])
})

test("a gated capture that never arrives keeps the original error and emits an error frame with the request id", async (t) => {
  const { send, answer, frames } = await productionDoor(t, { env: GATE, fail: true })
  send(archiveCall(77))
  const reply = await answer(77)
  assert.match(JSON.stringify(reply.result), /native handle capture readiness timeout/u)
  assert.deepEqual(frames.map((frame) => frame.requestId), [77])
})

test("with the gate off the call reaches the tool as before and no frame is written", async (t) => {
  const { send, answer, frames, root } = await productionDoor(t, { env: { CI: "", GITHUB_ACTIONS: "", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "", DESK_BLACKBOX_NATIVE_STAGE_TRACE: "" } })
  send(archiveCall(3))
  await archivedByNative(root, await answer(3))
  assert.equal(frames.length, 0)
})

test("front door forwards a safe-integer id only when every receipt-trace control is on, and never reads a getter", async () => {
  const seen = []
  const run = async (env, id) => {
    const input = new PassThrough(), output = new PassThrough()
    output.resume()
    const door = startFrontDoor({ input, output, env, callTool: (call) => { seen.push(call); return { content: [] } } })
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "desk_status" } })}\n`)
    input.end(); await door.closed
  }
  await run(GATE, 6)
  await run({ ...GATE, CI: "false" }, 7)
  await run({}, 8)
  await run(GATE, "str")
  await run(GATE, -1)
  await run(GATE, 2 ** 53)
  const trap = { get CI() { throw new Error("getter ran") }, GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1" }
  await run(trap, 10)
  assert.deepEqual(Object.keys(seen[0]).sort(), ["input", "name", "requestId", "signal"])
  assert.equal(seen[0].requestId, 6)
  for (const call of seen.slice(1)) assert.deepEqual(Object.keys(call).sort(), ["input", "name", "signal"])
})
