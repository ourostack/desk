import { test } from "node:test"
import assert from "node:assert/strict"
import { createStatusDiagnostics } from "./_status_diagnostics.js"

test("late runtime stages retain the initiating request while another request finishes", async () => {
  const diagnostics = createStatusDiagnostics({ enabled: true })
  let release
  const held = new Promise((resolve) => { release = resolve })
  diagnostics.start(11)
  const pending = diagnostics.run(11, () => diagnostics.stage("runtime_detail", async () => {
    await held
    return diagnostics.stage("root_inspection", () => "root")
  }))
  diagnostics.finish(11)
  diagnostics.start(12)
  await diagnostics.run(12, () => diagnostics.stage("session_dispatch", () => "response"))
  diagnostics.finish(12)
  release()
  assert.equal(await pending, "root")
  const output = diagnostics.snapshot()
  assert.deepEqual(output.requests.map((entry) => entry.requestId), [11, 12])
  assert.equal(output.stages.find((entry) => entry.stage === "root_inspection").requestId, 11)
  assert.equal(output.stages.find((entry) => entry.stage === "session_dispatch").requestId, 12)
  assert.ok(output.stages.find((entry) => entry.stage === "runtime_detail").endMs >= output.requests[0].endMs)
  assert.ok(output.requests[0].metrics.processCpuUs.user >= 0)
  assert.match(output.limitations, /not request-only/)
})

test("disabled diagnostics call no measurement API and preserve the operation result", async () => {
  const forbidden = () => { throw new Error("measurement must stay disabled") }
  const diagnostics = createStatusDiagnostics({ enabled: false, metrics: {
    now: forbidden, cpuUsage: forbidden, threadCpuUsage: forbidden, eventLoopUtilization: forbidden,
  } })
  diagnostics.start(1)
  const result = { unchanged: true }
  assert.equal(await diagnostics.run(1, () => diagnostics.stage("root_inspection", () => result)), result)
  diagnostics.finish(1)
  assert.deepEqual(diagnostics.snapshot().requests, [])
  assert.deepEqual(diagnostics.snapshot().stages, [])
})

test("unsupported main-thread metrics remain explicitly unavailable", async () => {
  let now = 0
  const diagnostics = createStatusDiagnostics({ enabled: true, metrics: {
    now: () => ++now, cpuUsage: () => ({ user: now, system: 0 }),
  } })
  diagnostics.start(3)
  await diagnostics.run(3, () => diagnostics.stage("root_inspection", () => true))
  diagnostics.finish(3)
  assert.equal(diagnostics.snapshot().requests.length, 1)
  assert.equal(diagnostics.snapshot().stages.length, 1)
  for (const entry of [...diagnostics.snapshot().requests, ...diagnostics.snapshot().stages]) {
    assert.equal(entry.metrics.mainThreadCpuUs, null)
    assert.equal(entry.metrics.mainThreadEventLoop, null)
    assert.ok(entry.startMs <= entry.endMs)
  }
})

test("stage failures retain the original error and a completed correlated record", async () => {
  const diagnostics = createStatusDiagnostics({ enabled: true })
  const failure = new Error("inspection failed")
  diagnostics.start(9)
  await assert.rejects(async () => diagnostics.run(9, () => diagnostics.stage("root_inspection", () => { throw failure })), (error) => error === failure)
  diagnostics.finish(9)
  const entry = diagnostics.snapshot().stages[0]
  assert.equal(entry.requestId, 9)
  assert.equal(entry.outcome, "error")
  assert.ok(entry.endMs >= entry.startMs)
})

test("request and stage buffers stay bounded and disclose dropped measurements", async () => {
  const diagnostics = createStatusDiagnostics({ enabled: true })
  for (let requestId = 1; requestId <= 129; requestId++) {
    diagnostics.start(requestId)
    await diagnostics.run(requestId, () => diagnostics.stage("session_dispatch", () => true))
    diagnostics.finish(requestId)
  }
  for (let index = 0; index < 2049; index++) {
    await diagnostics.run(1, () => diagnostics.stage("root_inspection", () => true))
  }
  const output = diagnostics.snapshot()
  assert.equal(output.requests.length, 128)
  assert.equal(output.stages.length, 2048)
  assert.ok(output.dropped.requests > 0)
  assert.ok(output.dropped.stages > 0)
})

test("a stage outside a measured request cannot be attributed to the previous request", async () => {
  const diagnostics = createStatusDiagnostics({ enabled: true })
  diagnostics.start(5)
  await diagnostics.run(5, () => diagnostics.stage("session_dispatch", () => true))
  diagnostics.finish(5)
  assert.equal(await diagnostics.stage("unrelated_background", () => "unrelated"), "unrelated")
  assert.equal(diagnostics.snapshot().stages.length, 1)
})
