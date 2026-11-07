import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import * as mcp from "../../../../../tests/blackbox/lib/mcp.mjs"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"

const root = new URL("../../../../../", import.meta.url)
const read = file => fs.readFileSync(new URL(file, root), "utf8")
const prefix = "DESK_NATIVE_RECEIPT_V1 "
const ctx = { host: "copilot", repeat: 1 }
const receipt = () => server.projectNativeReceipt({ handleReceipt: {
  scope: "archive_native_preadmission_session",
  events: [{ type: "capture_requested", sequence: 3, monotonicNs: "1000" }],
  protocolIssues: [], handles: {}, archiveMove: {},
} })
const wire = (id = 1, data = receipt()) => Buffer.from(`${prefix}${JSON.stringify({ requestId: id, receipt: data })}\n`)
const artifactJson = (summary, enabled) => typeof mcp.nativeReceiptArtifactJson === "function"
  ? mcp.nativeReceiptArtifactJson(summary, enabled)
  : `${JSON.stringify(summary, null, 2)}\n`
const maximumSource = {
  head: "a".repeat(64), dirty: false,
  hashes: Object.fromEntries([
    "plugins/desk/mcp/src/server.js", "tests/blackbox/lib/mcp.mjs", "tests/blackbox/run.mjs",
    "plugins/desk/mcp/src/tools/archive-native-session.js", "plugins/desk/mcp/src/tools/native-stage-context.js", "tests/blackbox/lib/world.mjs",
    ".github/workflows/desk-native-receipt-diagnostic-581.yml", ".github/workflows/desk-mcp-tests.yml",
  ].map(file => [file, "b".repeat(64)])),
}
function collector() {
  assert.equal(typeof mcp.NativeReceiptCollector, "function", "missing real bounded collector")
  return new mcp.NativeReceiptCollector()
}

test("dispatch binding retains failed case identity across response completion and a later check", () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.archive")
  const session = trace.session(ctx)
  session.dispatch(1)
  session.complete(1)
  trace.finishCase(ctx, "tools.archive", false)
  trace.enterCase(ctx, "tools.later")
  session.write(wire())
  trace.finishCase(ctx, "tools.later", true)
  const out = trace.snapshot()
  assert.equal(out.records.length, 1)
  assert.deepEqual(out.records[0].correlation, { host: "copilot", repeat: 1, caseId: "tools.archive", role: "desk", instance: 1, requestId: 1 })
  assert.equal(out.counters.channelEndUnobserved, 1)
  session.end()
  assert.equal(trace.snapshot().counters.channelEndUnobserved, 0)
})

test("real MCP request method binds its allocated ID before writing, without launching a child", async () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.archive")
  const binding = trace.session(ctx)
  let sent
  const client = {
    nextId: 1, pending: new Map(), exitInfo: null, nativeReceiptTrace: binding,
    child: { stdin: { write(line) { sent = JSON.parse(line); binding.write(wire(sent.id)) } } },
  }
  const response = mcp.McpSession.prototype.request.call(client, "tools/call", { name: "task_archive" })
  const pending = client.pending.get(1)
  clearTimeout(pending.timer)
  pending.resolve({ result: { isError: true } })
  assert.deepEqual(await response, { result: { isError: true } })
  trace.finishCase(ctx, "tools.archive", false)
  assert.equal(sent.id, 1)
  assert.equal(trace.snapshot().records[0].correlation.requestId, 1)
})

test("fragmented prefix/UTF8, oversized and invalid frames recover without retaining stderr", () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.archive")
  const session = trace.session(ctx)
  session.dispatch(1)
  const bytes = wire()
  session.write(Buffer.from("PRIVATE_PATH\nordinary stderr\n"))
  for (const byte of bytes) session.write(Buffer.from([byte]))
  session.write(Buffer.from(`${prefix}${"x".repeat(70000)}\n${prefix}{invalid}\n`))
  session.dispatch(2)
  session.write(wire(2))
  trace.finishCase(ctx, "tools.archive", false)
  const out = trace.snapshot()
  assert.equal(out.records.length, 2)
  assert.equal(out.counters.oversized, 1)
  assert.equal(out.counters.invalid, 1)
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_PATH|ordinary stderr|invalid\}/u)
})

test("duplicate, unknown, evicted and unscoped requests are never guessed into the current case", () => {
  const trace = collector()
  const session = trace.session(ctx)
  session.dispatch(1)
  trace.enterCase(ctx, "tools.archive")
  session.write(wire(1))
  session.dispatch(2)
  session.write(wire(2))
  session.write(wire(2))
  session.complete(2)
  session.write(wire(999))
  for (let id = 3; id <= 140; id++) { session.dispatch(id); session.complete(id) }
  session.write(wire(2))
  trace.finishCase(ctx, "tools.archive", false)
  const out = trace.snapshot()
  assert.equal(out.records.length, 1)
  assert.equal(out.counters.duplicate, 1)
  assert.equal(out.counters.unmatched, 3)
  assert.ok(out.counters.evicted > 0)
})

test("completed-ring pressure cannot evict an outstanding request binding", () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.archive")
  const session = trace.session(ctx)
  session.dispatch(1)
  for (let id = 2; id < 150; id++) { session.dispatch(id); session.complete(id) }
  session.write(wire(1))
  trace.finishCase(ctx, "tools.archive", false)
  assert.equal(trace.snapshot().records.length, 1)
  assert.equal(trace.snapshot().counters.unmatched, 0)
})

test("safe reprojection removes nested extras and rejects untrusted types", () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.archive")
  const session = trace.session(ctx)
  session.dispatch(1)
  const data = receipt()
  data.secret = "PRIVATE_TOKEN"
  data.events[0].path = "PRIVATE_PATH"
  session.write(wire(1, data))
  session.dispatch(2)
  session.write(wire(2, { ...data, status: "PRIVATE_STATUS" }))
  trace.finishCase(ctx, "tools.archive", false)
  const out = trace.snapshot()
  assert.equal(out.records.length, 1)
  assert.equal(out.counters.invalid, 1)
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_/u)
})

test("passed cases are discarded, including frames arriving after case completion", () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.expected_error")
  const session = trace.session(ctx)
  session.dispatch(1)
  session.write(wire(1))
  session.dispatch(2)
  trace.finishCase(ctx, "tools.expected_error", true)
  session.write(wire(2))
  assert.equal(trace.snapshot().records.length, 0)
})

test("same RPC number stays separate across hosts, repeats and desk instances", () => {
  const trace = collector()
  const contexts = [ctx, { host: "claude", repeat: 1 }, { host: "copilot", repeat: 2 }]
  const sessions = []
  for (const context of contexts) {
    trace.enterCase(context, "tools.archive")
    const session = trace.session(context)
    sessions.push(session)
    session.dispatch(1)
    trace.finishCase(context, "tools.archive", false)
  }
  for (const session of sessions.reverse()) { session.write(wire(1)); session.end(); session.end() }
  const out = trace.snapshot()
  assert.equal(out.records.length, 3)
  assert.deepEqual(out.records.map(record => [record.correlation.host, record.correlation.repeat, record.correlation.instance]), [
    ["copilot", 1, 1], ["claude", 1, 2], ["copilot", 2, 3],
  ])
  assert.equal(out.counters.channelEndUnobserved, 0)
})

test("unavailable projections and incomplete channels retain fixed safe status only", () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.archive")
  const session = trace.session(ctx)
  session.dispatch(1)
  session.write(wire(1, { schemaVersion: 1, observationalOnly: true, tool: "task_archive", status: "unavailable", code: "receipt_unavailable", incomplete: true, cause: "PRIVATE" }))
  session.write(Buffer.from(`${prefix}{"requestId":`))
  session.end()
  trace.finishCase(ctx, "tools.archive", false)
  const out = trace.snapshot()
  assert.equal(out.records[0].receipt.code, "receipt_unavailable")
  assert.equal(out.counters.truncated, 1)
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|cause/u)
})

test("invalid numeric IDs, receipt enums and nested shapes are discarded without arbitrary retention", () => {
  const trace = collector()
  trace.enterCase(ctx, "tools.archive")
  const session = trace.session(ctx)
  session.dispatch(1)
  session.write(wire("1"))
  for (const change of [
    data => { data.bounds = null },
    data => { data.events[0].sequence = 0 },
    data => { data.events[0].elapsedMs = 900001 },
    data => { data.events[0].elapsedMs = 1 },
    data => { data.events[0].type = "PRIVATE" },
    data => { data.protocolIssues = ["PRIVATE"] },
    data => { data.fieldStatus.stdoutBytes = "PRIVATE" },
    data => { data.executedProgramSha256 = "PRIVATE" },
    data => { data.close.signal = "PRIVATE" },
  ]) {
    const data = receipt()
    change(data)
    session.write(wire(1, data))
  }
  trace.finishCase(ctx, "tools.archive", false)
  assert.equal(trace.snapshot().records.length, 0)
  assert.equal(trace.snapshot().counters.invalid, 10)
})

test("event-heavy case and shared job budgets bound the actual persisted diagnostic representation", () => {
  const trace = collector()
  const data = receipt()
  data.events = Array.from({ length: 128 }, (_, i) => ({
    type: "capture_requested", sequence: i + 1, elapsedMs: i, timeStatus: "present", sequenceStatus: "present",
  }))
  const session = trace.session(ctx)
  let id = 0
  for (let n = 0; n < 100; n++) {
    const caseId = `tools.case_${n}`
    trace.enterCase(ctx, caseId)
    for (let frame = 0; frame < 10; frame++) {
      session.dispatch(++id)
      session.write(wire(id, data))
    }
    trace.finishCase(ctx, caseId, false)
  }
  const out = trace.snapshot()
  assert.ok(out.counters.truncated > 0)
  const persisted = artifactJson({ native_receipt_trace: out, native_receipt_source: maximumSource }, true)
  assert.ok(Buffer.byteLength(persisted) <= 1024 * 1024, `persisted job bytes ${Buffer.byteLength(persisted)}`)
  for (const entry of out.cases) {
    const records = out.records.filter(record => record.correlation.caseId === entry.caseId)
    const persistedCase = artifactJson({ records, cases: [entry] }, true)
    assert.ok(Buffer.byteLength(persistedCase) <= 64 * 1024, `persisted case bytes ${Buffer.byteLength(persistedCase)}`)
  }
  assert.ok(out.records.length < 1000)
})

test("artifact formatting is explicitly gated and preserves default JSON bytes and values", () => {
  assert.equal(typeof mcp.nativeReceiptArtifactJson, "function")
  const summary = { checks: [{ passed: 0, failed: 1, error: null }], ok: false, native_receipt_trace: { records: [], unknown: null } }
  assert.equal(mcp.nativeReceiptArtifactJson(summary), `${JSON.stringify(summary, null, 2)}\n`)
  assert.equal(mcp.nativeReceiptArtifactJson(summary, false), `${JSON.stringify(summary, null, 2)}\n`)
  assert.equal(mcp.nativeReceiptArtifactJson(summary, true), `${JSON.stringify(summary)}\n`)
  assert.deepEqual(JSON.parse(mcp.nativeReceiptArtifactJson(summary, true)), summary)
})

test("actual byte admission accepts the case/job caps but rejects cap plus one and invalid counts", () => {
  assert.equal(typeof mcp.nativeReceiptBudgetFits, "function")
  assert.equal(mcp.nativeReceiptBudgetFits(65536, 1048576), true)
  assert.equal(mcp.nativeReceiptBudgetFits(65537, 1048576), false)
  assert.equal(mcp.nativeReceiptBudgetFits(65536, 1048577), false)
  assert.equal(mcp.nativeReceiptBudgetFits(0, 0), true)
  for (const value of [null, undefined, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(mcp.nativeReceiptBudgetFits(value, 0), false)
})

test("schema-valid event-heavy records exactly at persisted case cap are admitted, cap plus one is not", () => {
  const data = receipt()
  data.events = Array.from({ length: 128 }, (_, i) => ({
    type: "capture_requested", sequence: i + 1, elapsedMs: i, timeStatus: "present", sequenceStatus: "present",
  }))
  const paths = [["stdoutBytes"], ["stderrBytes"], ["droppedEvents"],
    ...["readinessMs", "ackAndCloseMs", "closeGraceMs", "retirementMs", "stdoutBytes", "stderrBytes", "events"].map(key => ["bounds", key]),
    ...["opened", "closeAttempts", "closed"].map(key => ["handles", key])]
  const set = (value, path, number) => {
    const owner = path.length === 1 ? value : value[path[0]]
    owner[path.at(-1)] = number
    value.fieldStatus[path.join(".")] = "present"
  }
  for (const path of paths) set(data, path, 0)
  const seed = () => {
    const trace = collector()
    trace.enterCase(ctx, "tools.cap")
    const session = trace.session(ctx)
    for (let id = 1; id <= 4; id++) {
      session.dispatch(id)
      session.write(wire(id, id === 4 ? { ...data, events: data.events.slice(0, 64) } : data))
    }
    return { trace, session, entry: trace.cases.get("copilot:1:tools.cap") }
  }
  const first = seed()
  assert.equal(first.entry.records.length, 4)
  const baseRecords = [...first.entry.records]
  const candidate = structuredClone(data)
  const metadata = { host: "copilot", repeat: 1, caseId: "tools.cap", truncated: false }
  const persistedBytes = value => Buffer.byteLength(`${JSON.stringify({
    records: [...baseRecords, { correlation: { ...baseRecords[0].correlation, requestId: 5 }, receipt: value }],
    cases: [metadata],
  })}\n`)
  for (let length = 128; length >= 1; length--) {
    candidate.events = data.events.slice(0, length)
    if (persistedBytes(candidate) <= 65536) break
  }
  let gap = 65536 - persistedBytes(candidate)
  assert.ok(gap >= 0 && gap <= paths.length * 15)
  for (const path of paths) {
    const digits = Math.min(gap, 15)
    set(candidate, path, digits ? 10 ** digits : 0)
    gap -= digits
  }
  assert.equal(persistedBytes(candidate), 65536)
  first.session.dispatch(5)
  first.session.write(wire(5, candidate))
  first.trace.finishCase(ctx, "tools.cap", false)
  assert.equal(first.trace.snapshot().records.length, 5)
  assert.equal(first.entry.bytes, 65536)
  const second = seed()
  const extra = structuredClone(candidate)
  const spare = paths.find(path => (path.length === 1 ? extra : extra[path[0]])[path.at(-1)] < 10 ** 15)
  const previous = (spare.length === 1 ? extra : extra[spare[0]])[spare.at(-1)]
  set(extra, spare, previous ? previous * 10 : 10)
  assert.equal(persistedBytes(extra), 65537)
  second.session.dispatch(5)
  second.session.write(wire(5, extra))
  second.trace.finishCase(ctx, "tools.cap", false)
  assert.equal(second.trace.snapshot().records.length, 4)
  assert.equal(second.trace.snapshot().counters.truncated, 1)
  assert.equal(second.trace.snapshot().cases[0].truncated, true)
})

test("byte ledger equals persisted case data and schema-max metadata, including cross-session pass discard", () => {
  const trace = collector()
  const other = { host: "claude", repeat: 2 }
  const contexts = [ctx, other]
  for (const context of contexts) {
    trace.enterCase(context, "tools.archive")
    const session = trace.session(context)
    session.dispatch(1)
    session.write(wire(1))
    session.end()
    trace.finishCase(context, "tools.archive", false)
  }
  const maxCounters = { invalid: 1000000000, oversized: 1000000000, unmatched: 1000000000, evicted: 1000000000,
    duplicate: 1000000000, truncated: 1000000000, dropped: 1000000000, channelEndUnobserved: 128 }
  const assertLedger = () => {
    const out = trace.snapshot()
    const budgeted = { native_receipt_trace: { ...out, counters: maxCounters }, native_receipt_source: maximumSource }
    assert.equal(trace.bytes, Buffer.byteLength(`${JSON.stringify(budgeted)}\n`))
    for (const metadata of out.cases) {
      const records = out.records.filter(record => record.correlation.host === metadata.host && record.correlation.repeat === metadata.repeat)
      const entry = trace.cases.get(`${metadata.host}:${metadata.repeat}:${metadata.caseId}`)
      assert.equal(entry.bytes, Buffer.byteLength(`${JSON.stringify({ records, cases: [metadata] })}\n`))
    }
  }
  assertLedger()
  trace.finishCase(ctx, "tools.archive", true)
  assertLedger()
  trace.finishCase(other, "tools.archive", true)
  assertLedger()
  assert.equal(trace.snapshot().records.length, 0)
  assert.equal(trace.snapshot().cases.length, 0)
})
test("desk launch overlay is default-off, narrow and does not mutate person environment", () => {
  assert.equal(typeof mcp.nativeReceiptLaunch, "function")
  const env = { HOME: "synthetic-home", PATH: "synthetic-path" }
  const launch = { env, command: "unused" }
  const parent = { CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1", PRIVATE_TOKEN: "private" }
  assert.equal(mcp.nativeReceiptLaunch(launch, {}), launch)
  const enabled = mcp.nativeReceiptLaunch(launch, parent)
  assert.deepEqual(enabled.env, { HOME: "synthetic-home", PATH: "synthetic-path", CI: "true", GITHUB_ACTIONS: "true", DESK_BLACKBOX_NATIVE_RECEIPT_TRACE: "1" })
  assert.deepEqual(env, { HOME: "synthetic-home", PATH: "synthetic-path" })
  for (const key of ["CI", "GITHUB_ACTIONS", "DESK_BLACKBOX_NATIVE_RECEIPT_TRACE"]) {
    assert.equal(mcp.nativeReceiptLaunch(launch, { ...parent, [key]: undefined }), launch)
  }
  let traps = 0
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw Error("descriptor") } })
  assert.equal(mcp.nativeReceiptLaunch(launch, hostile), launch)
  assert.equal(traps, 0)
})

test("malformed source contexts and nonbuffer/Proxy chunks cannot escape or grow collection", () => {
  const trace = collector()
  trace.enterCase(ctx, "../private")
  const session = trace.session(ctx)
  session.dispatch(1)
  let traps = 0
  session.write(new Proxy({}, { getPrototypeOf() { traps++; throw Error("prototype") } }))
  session.write("PRIVATE_RAW")
  session.write(wire(1))
  assert.throws(() => trace.session({ host: "PRIVATE", repeat: 1 }), /invalid diagnostic session context/u)
  assert.equal(trace.snapshot().records.length, 0)
  assert.equal(trace.snapshot().counters.invalid, 2)
  assert.equal(trace.snapshot().counters.unmatched, 1)
  assert.equal(traps, 0)
})

test("runner integrates real collector without importing/executing main in a model", () => {
  const source = read("tests/blackbox/run.mjs")
  assert.match(source, /nativeReceiptTrace\.enterCase\(ctx, id\)/u)
  assert.match(source, /nativeReceiptTrace\.finishCase\(ctx, id, ok\)/u)
  assert.match(source, /nativeReceiptLaunch\(launch, process\.env\)/u)
  assert.match(source, /summary\.native_receipt_trace/u)
  assert.match(source, /nativeReceiptArtifactJson\(summary, Boolean\(shared\.nativeReceiptTrace\)\)/u)
  const warmup = source.slice(source.indexOf("async function warmUp"), source.indexOf("// ---- main ----"))
  assert.doesNotMatch(warmup, /nativeReceipt|TRACE/u)
})

test("consumed diagnostic route stays retired and general PR gates remain dispatchable", () => {
  assert.equal(fs.existsSync(new URL(".github/workflows/desk-native-receipt-diagnostic-581.yml", root)), false,
    "the consumed diagnostic route must be absent")
  const scheduled = read(".github/workflows/superpowers-upstream.yml")
  const dispatched = /CI_WORKFLOWS: ([^\n]+)\n/u.exec(scheduled)[1].split(",").sort()
  const gating = fs.readdirSync(new URL(".github/workflows/", root))
    .filter(file => /\n {2}pull_request:/u.test(read(`.github/workflows/${file}`)))
    .sort()
  assert.deepEqual(dispatched, gating, "the refresh must dispatch every workflow that gates a pull request")
  for (const file of gating)
    assert.match(read(`.github/workflows/${file}`), /\n {2}workflow_dispatch:\n/u, `${file} must accept workflow_dispatch`)
})
