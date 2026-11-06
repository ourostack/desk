// Opt-in #581 stage diagnostic: synthetic transport only; not Windows proof and not a cause proof.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { openArchiveHandleSession, buildStageProgram } from "../../../../../plugins/desk/mcp/src/tools/archive-native-session.js"
import { NATIVE_STAGES, nativeStageTraceEnabled, recordNativeStageSummary } from "../../../../../plugins/desk/mcp/src/tools/native-stage-context.js"
import { callTool, projectNativeReceipt, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import * as mcp from "../../../../../tests/blackbox/lib/mcp.mjs"

const pair = { source: "C:\\owned\\PRIVATE_SOURCE", destination: "C:\\owned\\archive\\PRIVATE_SOURCE" }
const GATE = { CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1", DESK_BLACKBOX_NATIVE_STAGE_TRACE: "1" }
const DEFAULT_SHA = "dda35c5729626c8499a568e9945ce3c4f8b2d0e80a43b2c9e04e521d746bc160"
const methods = ["CreateFileW", "GetFileInformationByHandleEx", "GetVolumeInformationByHandleW", "SetFileInformationByHandle", "CloseHandle"]
const baseline = { role: "baseline", access: 0, share: 7, flags: 35651584, creation: 3, openSuccess: true, openError: null, volumeSuccess: true,
  volumeError: null, filesystem: "NTFS", idSuccess: true, idError: null, volumeHex: "8877665544332211", fileIdHex: "08070605040302011020304050607080",
  attributeSuccess: true, attributeError: null, attributes: 16, reparseTag: 0, closeSuccess: null, closeError: null }
const captured = { state: "captured", pid: 42, powershell: "5.1.26100.33438", runtime: "4.0.30319.42000", edition: "Desktop", architecture: "AMD64",
  compiler: "reflection_emit_in_process", metadata: methods.map(method => ({ method, verified: true })),
  layout: { pointerSize: 8, headerSize: 24, replaceOffset: 0, rootOffset: 8, lengthOffset: 16, nameOffset: 20, littleEndian: true }, baseline }
const RESULT = { state: "result", disposition: "closed", phase: "close", moved: false, failure: null, samples: { baseline: { ...baseline, closeSuccess: true }, admitted: null, held: null, current: null },
  comparisons: { admittedMatchesBaseline: false, heldMatchesBaseline: false, currentMatchesBaseline: false, currentMatchesHeld: false },
  rename: { attempted: false, success: null, error: null, byHandle: false, replaceIfExists: false, rootDirectoryNull: true, bufferValidated: false },
  handles: { opened: 1, closeAttempts: 1, closed: 1, closeFailures: 0, disposals: [{ role: "baseline", success: true, error: null }] } }

// Never produces `captured`; the wrapper's own capture bound ends the open.
function silentChild(lines, env) {
  const child = new EventEmitter()
  child.pid = 42
  child.stdin = Object.assign(new EventEmitter(), { write: () => { queueMicrotask(() => lines.forEach(l => child.stdout.emit("data", Buffer.from((typeof l === "string" ? l : JSON.stringify(l)) + "\n")))); return false },
    end() { queueMicrotask(() => { child.stdout.emit("data", Buffer.from(JSON.stringify(RESULT) + "\n")); child.emit("exit", 0, null); child.emit("close", 0, null) }) } })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM") }
  let argv
  return { child, argv: () => argv, dependencies: { platform: "win32", arch: "x64", env: { SystemRoot: "C:\\Windows", ...env }, realpath: async v => v,
    spawn(exe, args) { argv = args; queueMicrotask(() => child.emit("spawn")); return child },
    setTimeout: (cb, ms) => setTimeout(cb, ms / 1000), clearTimeout } }
}
const stage = (name, us, pid = 42) => `DESK_STAGE ${name} ${pid} ${us}`
const open = async (lines, env = GATE) => {
  const f = silentChild(lines, env)
  const error = await openArchiveHandleSession(pair, f.dependencies).then(() => null, e => e)
  return { f, error }
}

test("gate needs all four exact controls and never runs getters", () => {
  assert.equal(nativeStageTraceEnabled(GATE), true)
  for (const key of Object.keys(GATE)) assert.equal(nativeStageTraceEnabled({ ...GATE, [key]: "0" }), false)
  assert.equal(nativeStageTraceEnabled({ ...GATE, get CI() { throw new Error("getter") } }), false)
})

test("variant is the default program plus markers only, with five unique anchors", () => {
  const variant = buildStageProgram()
  assert.deepEqual([...variant.matchAll(/Stage '([a-z_]+)'/g)].map(m => m[1]), NATIVE_STAGES)
  assert.equal(variant.includes('"'), false)
  assert.throws(() => buildStageProgram("$x = 1"), /stage anchor unavailable/)
})

test("default path rejects stage lines and keeps the pinned program hash", async () => {
  const { f, error } = await open([stage("start", 5)], { SystemRoot: "C:\\Windows" })
  assert.equal(error.handleReceipt.programSha256, DEFAULT_SHA)
  assert.equal(createHash("sha256").update(f.argv()[4]).digest("hex"), DEFAULT_SHA)
  assert.equal("programVariant" in error.handleReceipt, false)
  assert.equal("nativeStages" in error.handleReceipt, false)
})

test("opt-in records executed variant bytes and ordered stages; timeout stays censored", async () => {
  const baseline = await open([], { SystemRoot: "C:\\Windows" })
  const { f, error } = await open([stage("start", 100), stage("compiled", 900), stage("verified", 950)])
  const executed = f.argv()[4], original = baseline.f.argv()[4]
  assert.equal(executed.split("\n").filter(l => !/^\s*Stage '|^\$script:stageT0|^function Stage/.test(l)).join("\n"), original)
  const receipt = error.handleReceipt
  assert.match(error.message, /capture readiness timeout/)
  assert.equal(receipt.programVariant, "stage_diag")
  assert.equal(receipt.programSha256, DEFAULT_SHA)
  assert.equal(receipt.executedProgramSha256, createHash("sha256").update(f.argv()[4]).digest("hex"))
  assert.notEqual(receipt.executedProgramSha256, DEFAULT_SHA)
  assert.deepEqual(receipt.nativeStages.map(s => s.stage), ["start", "compiled", "verified"])
  assert.deepEqual(receipt.nativeStages.map(s => s.nativeUs), [100, 900, 950])
  assert.equal(JSON.stringify(receipt).includes("PRIVATE_SOURCE"), false)
})

test("no markers before the bound is a censored interval, not an attribution", async () => {
  const { error } = await open([])
  assert.deepEqual(error.handleReceipt.nativeStages, [])
})

for (const [name, lines] of [
  ["duplicate", [stage("start", 1), stage("start", 2)]],
  ["out of order", [stage("compiled", 1)]],
  ["unknown", [stage("bogus", 1)]],
  ["wrong pid", [stage("start", 1, 7)]],
  ["decreasing", [stage("start", 9), stage("compiled", 3)]],
  ["huge", [stage("start", 900000001)]],
  ["extra field", ["DESK_STAGE start 42 1 extra"]],
  ["negative", ["DESK_STAGE start 42 -1"]],
  ["json shaped", ['{"state":"stage","stage":"start","pid":42,"us":1}']],
]) test(`opt-in parser refuses ${name} without advancing the ordered list`, async () => {
  const { error } = await open(lines)
  assert.ok(error.handleReceipt.protocolIssues.length >= 1)
  assert.ok(error.handleReceipt.nativeStages.length <= 1)
})

const probeRequest = (id) => callTool({ deskRoot: "/nonexistent", name: "task_archive", input: { id }, env: { ...process.env, ...GATE }, traceRequestId: id,
  traceWrite: line => probeFrames.push(line) })
const probeFrames = []
const withProbe = async (impl, run) => {
  const original = TOOL_IMPLS.task_archive
  TOOL_IMPLS.task_archive = impl
  try { return await run() } finally { TOOL_IMPLS.task_archive = original }
}
const summaryWith = us => ({ scope: "archive_native_preadmission_session", events: [], protocolIssues: [], handles: {}, archiveMove: {}, programVariant: "stage_diag",
  nativeStages: NATIVE_STAGES.map((name, i) => ({ stage: name, nativeUs: us + i, wrapperUs: 1000 + us + i })) })
const frameFor = id => probeFrames.map(l => JSON.parse(l.slice("DESK_NATIVE_RECEIPT_V1 ".length))).filter(f => f.requestId === id)

test("interleaved requests each emit exactly their own success summary under their own id", async () => {
  probeFrames.length = 0
  await withProbe(async ({ input }) => {
    await new Promise(r => setTimeout(r, input.id === 1 ? 30 : 1))
    recordNativeStageSummary(summaryWith(input.id * 100))
    await new Promise(r => setTimeout(r, input.id === 1 ? 1 : 30))
    return { ok: input.id }
  }, () => Promise.all([probeRequest(1), probeRequest(2)]))
  for (const id of [1, 2]) {
    const frames = frameFor(id)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].receipt.nativeStages[0].nativeUs, id * 100)
    assert.equal(frames[0].receipt.programVariant, "stage_diag")
  }
})

test("zero or ambiguous summaries emit no success frame and the default result is unchanged", async () => {
  for (const count of [0, 2]) {
    probeFrames.length = 0
    const result = await withProbe(async () => { for (let i = 0; i < count; i++) recordNativeStageSummary(summaryWith(i)); return { ok: true } },
      () => probeRequest(5))
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true })
    assert.equal(frameFor(5).length, 0)
  }
})

test("an archive error keeps its message and emits its own receipt; no success frame joins it", async () => {
  probeFrames.length = 0
  const failure = Object.assign(new Error("task_archive: native handle capture readiness timeout"), { handleReceipt: summaryWith(7) })
  const result = await withProbe(async () => { recordNativeStageSummary(summaryWith(9)); throw failure }, () => probeRequest(9))
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0].text).message, failure.message)
  const frames = frameFor(9)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].receipt.nativeStages[0].nativeUs, 7)
})

test("gate off: the probe summary is never framed", async () => {
  const off = []
  await withProbe(async () => { recordNativeStageSummary(summaryWith(1)); return {} },
    () => callTool({ deskRoot: "/nonexistent", name: "task_archive", input: {}, env: { ...process.env, CI: "", GITHUB_ACTIONS: "" }, traceRequestId: 3, traceWrite: l => off.push(l) }))
  assert.deepEqual(off, [])
})

test("opt-in open requires all five ordered markers before captured", async () => {
  const all = NATIVE_STAGES.map((name, i) => stage(name, 10 * (i + 1)))
  for (const prefix of [[], all.slice(0, 1), all.slice(0, 4)]) {
    const { error } = await open([...prefix, captured])
    assert.match(error.message, /./)
    assert.equal(error.handleReceipt.capturedValidated, false)
    assert.ok(error.handleReceipt.protocolIssues.includes("invalid_or_unexpected_protocol"))
  }
  const f = silentChild([...all, captured], GATE)
  const session = await openArchiveHandleSession(pair, f.dependencies)
  assert.equal(session.receipt.capturedValidated, true)
  assert.equal(session.receipt.nativeStages.length, 5)
  await session.close()
  const late = silentChild([...all, captured, stage("start", 99)], GATE)
  const s2 = await openArchiveHandleSession(pair, late.dependencies).then(v => v, e => e)
  const receipt = s2.receipt ?? s2.handleReceipt
  assert.ok(receipt.protocolIssues.includes("invalid_or_unexpected_protocol"))
  assert.equal(receipt.nativeStages.length, 5)
})

test("default path still accepts captured without any markers", async () => {
  const f = silentChild([captured], { SystemRoot: "C:\\Windows" })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  assert.equal(session.receipt.capturedValidated, true)
  await session.close()
})

const wire = (id, data) => Buffer.from(`DESK_NATIVE_RECEIPT_V1 ${JSON.stringify({ requestId: id, receipt: data })}\n`)
const stageReceipt = (stages, extra = {}) => projectNativeReceipt({ handleReceipt: {
  scope: "archive_native_preadmission_session", events: [], protocolIssues: [], handles: {}, archiveMove: {},
  programVariant: "stage_diag", nativeStages: stages, ...extra } })
const goodStages = NATIVE_STAGES.map((name, i) => ({ stage: name, nativeUs: 10 * (i + 1), wrapperUs: 100 * (i + 1) }))

test("projection carries stage fields only when present and refuses malformed ones without leaking", () => {
  const plain = projectNativeReceipt({ handleReceipt: { scope: "archive_native_preadmission_session", events: [], protocolIssues: [], handles: {}, archiveMove: {} } })
  assert.equal("nativeStages" in plain, false)
  assert.deepEqual(stageReceipt(goodStages).nativeStages, goodStages)
  for (const bad of [[{ ...goodStages[0], stage: "compiled" }], [goodStages[1], goodStages[0]],
    [{ ...goodStages[0], nativeUs: 900000001 }], [goodStages[0], { ...goodStages[1], nativeUs: 1 }]]) {
    const out = stageReceipt(bad)
    assert.equal(out.incomplete, true)
    assert.equal(out.fieldStatus.nativeStages, "invalid")
    assert.equal(JSON.stringify(out).includes("PRIVATE"), false)
  }
  const getter = { scope: "archive_native_preadmission_session", events: [], protocolIssues: [], handles: {}, archiveMove: {}, programVariant: "stage_diag",
    get nativeStages() { throw new Error("getter ran") } }
  assert.doesNotThrow(() => projectNativeReceipt({ handleReceipt: getter }))
})

test("collector reparses stage fields strictly and retains passed cases only in stage mode", () => {
  const ctx = { host: "copilot", repeat: 1 }
  for (const [retain, expected] of [[false, 0], [true, 1]]) {
    const trace = new mcp.NativeReceiptCollector({ retainPassed: retain })
    trace.enterCase(ctx, "tools.task_archive_cancelled")
    const session = trace.session(ctx)
    session.dispatch(1)
    session.write(wire(1, stageReceipt(goodStages)))
    trace.finishCase(ctx, "tools.task_archive_cancelled", true)
    const out = trace.snapshot()
    assert.equal(out.records.length, expected)
    if (retain) assert.deepEqual(out.records[0].receipt.nativeStages, goodStages)
  }
  const trace = new mcp.NativeReceiptCollector({ retainPassed: true })
  trace.enterCase(ctx, "tools.x")
  const session = trace.session(ctx)
  session.dispatch(1)
  session.write(wire(1, { ...stageReceipt(goodStages), nativeStages: [{ ...goodStages[0], extra: 1 }, ...goodStages.slice(1)] }))
  trace.finishCase(ctx, "tools.x", false)
  assert.equal(trace.snapshot().records[0].receipt.nativeStages[0].extra, undefined)
})

test("the gate reads only own data properties of a plain object", () => {
  for (const env of [null, undefined, "CI", 7, new Proxy({ ...GATE }, {})]) assert.equal(nativeStageTraceEnabled(env), false)
  assert.equal(nativeStageTraceEnabled(Object.create(GATE)), false)
})

test("a stage line arriving beyond the wrapper bound is an invalid stage, not a recorded one", async () => {
  const real = process.hrtime.bigint
  let skewNs = 0n
  const f = silentChild([stage("start", 10)], GATE)
  const spawn = f.dependencies.spawn
  f.dependencies.spawn = (...args) => { skewNs = 1_000n * 1_000_000_000n; return spawn(...args) }
  process.hrtime.bigint = () => real() + skewNs
  let error
  try { error = await openArchiveHandleSession(pair, f.dependencies).then(() => null, e => e) }
  finally { process.hrtime.bigint = real }
  assert.ok(error)
  assert.ok(error.handleReceipt.protocolIssues.includes("invalid_or_unexpected_protocol"))
  assert.equal(error.handleReceipt.nativeStages.length, 0)
})

test("an unavailable stage program fails typed before any spawn, and only when the gate is on", async () => {
  let builds = 0, spawns = 0
  const throwing = () => { builds++; throw new Error("C:\\secret\\anchor") }
  const on = silentChild([], GATE)
  const onSpawn = on.dependencies.spawn
  on.dependencies.spawn = (...a) => { spawns++; return onSpawn(...a) }
  const error = await openArchiveHandleSession(pair, { ...on.dependencies, buildStageProgram: throwing }).then(() => null, e => e)
  assert.ok(error)
  assert.match(error.message, /diagnostic program unavailable/)
  assert.equal(error.code, "ARCHIVE_NATIVE_MOVE")
  assert.doesNotMatch(error.message, /secret|anchor/)
  assert.equal(builds, 1)
  assert.equal(spawns, 0)
  assert.equal(on.argv(), undefined)
  assert.equal(error.handleReceipt.childPid, null)
  assert.equal(error.handleReceipt.executedProgramSha256, null)
  assert.equal(error.handleReceipt.capturedValidated, false)
  assert.equal(error.handleReceipt.stdoutBytes, 0)

  const off = silentChild([], {})
  const offSpawn = off.dependencies.spawn
  off.dependencies.spawn = (...a) => { spawns++; return offSpawn(...a) }
  const offError = await openArchiveHandleSession(pair, { ...off.dependencies, buildStageProgram: throwing }).then(() => null, e => e)
  assert.equal(offError.code, "ARCHIVE_NATIVE_MOVE")
  assert.equal(offError.message, "task_archive: native handle capture readiness timeout")
  assert.equal(builds, 1)
  assert.equal(spawns, 1)
  assert.equal(createHash("sha256").update(off.argv()[4]).digest("hex"), DEFAULT_SHA)
  assert.equal("programVariant" in offError.handleReceipt, false)
})

test("stage control reaches only the measured launch and needs the receipt trace", () => {
  const env = { CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1", DESK_BLACKBOX_NATIVE_STAGE_TRACE: "1" }
  assert.equal(mcp.nativeReceiptLaunch({ env: {} }, env).env.DESK_BLACKBOX_NATIVE_STAGE_TRACE, "1")
  const { DESK_BLACKBOX_NATIVE_RECEIPT_TRACE, ...noReceipt } = env
  assert.equal(mcp.nativeStageTraceRequested(noReceipt), false)
  const launch = { env: {} }
  assert.equal(mcp.nativeReceiptLaunch(launch, noReceipt), launch)
})
