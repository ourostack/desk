import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { createStatusDiagnostics, finishStatusFixture } from "./_status_diagnostics.js"
import { mkTempRoot } from "../_temp_roots.js"

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
  assert.equal(diagnostics.snapshot().dropped.unattributedStages, 1)
  assert.equal(diagnostics.snapshot().dropped.stages, 1)
})

test("a request beyond the cap counts its unrecorded stages and executes each operation once", async () => {
  const diagnostics = createStatusDiagnostics({ enabled: true })
  for (let id = 1; id <= 129; id++) diagnostics.start(id)
  let calls = 0
  assert.equal(await diagnostics.run(129, () => diagnostics.stage("root_inspection", () => ++calls)), 1)
  const output = diagnostics.snapshot()
  assert.equal(calls, 1)
  assert.equal(output.requests.length, 128)
  assert.equal(output.stages.length, 0)
  assert.equal(output.dropped.unrecordedRequestStages, 1)
  assert.equal(output.dropped.stages, 1)
})

test("disabled missing scopes do not count dropped stages or repeat operations", () => {
  const diagnostics = createStatusDiagnostics()
  let calls = 0
  assert.equal(diagnostics.stage("unrelated", () => ++calls), 1)
  assert.equal(diagnostics.run(129, () => diagnostics.stage("root_inspection", () => ++calls)), 2)
  assert.equal(diagnostics.snapshot().dropped.stages, 0)
})

test("unfinished requests remain explicit rather than inventing response measurements", () => {
  const diagnostics = createStatusDiagnostics({ enabled: true })
  diagnostics.start(7)
  const record = diagnostics.snapshot().requests[0]
  assert.equal(record.endMs, null)
  assert.equal(record.metrics, null)
})

test("a diagnostics write failure does not replace a prior shutdown or assertion failure", async () => {
  const root = await mkTempRoot("status-publication-errors-")
  let assertion
  try { assert.fail("original shutdown assertion") } catch (error) { assertion = error }
  let writeFailure
  await assert.rejects(finishStatusFixture({
    close: async () => { throw assertion },
    publish: () => {
      try { appendFileSync(path.join(root, "missing", "receipt.jsonl"), "{}\n") }
      catch (error) { writeFailure = error; throw error }
    },
  }), (error) => error instanceof AggregateError && error.errors[0] === assertion &&
    error.errors[1] === writeFailure && /original shutdown assertion/.test(error.message) && /ENOENT/.test(error.message))
})

test("a diagnostics reporting failure alone remains a failed fixture", async () => {
  const failure = new Error("diagnostic reporter refused output")
  await assert.rejects(finishStatusFixture({ close: async () => {}, publish: () => { throw failure } }), (error) => error === failure)
})

test("the workflow copies the exact staged receipt after a failed fixture shutdown", async () => {
  const root = await mkTempRoot("status-publication-copy-")
  const staged = path.join(root, "status-request-diagnostics.jsonl")
  const destination = path.join(root, "runner-temp", "desk-coverage-shard", "status-request-diagnostics.jsonl")
  mkdirSync(path.dirname(destination), { recursive: true })
  const failure = new Error("shutdown failed before publication")
  const receipt = '{"requestId":4,"endMs":null}\n'
  await assert.rejects(finishStatusFixture({
    close: async () => { throw failure },
    publish: () => appendFileSync(staged, receipt),
  }), (error) => error === failure)
  const workflow = readFileSync(new URL("../../../../../.github/workflows/desk-mcp-tests.yml", import.meta.url), "utf8")
  const block = workflow.split("      - name: Retain status request diagnostics\n")[1]?.split("\n      - name:")[0]
  assert.ok(block, "workflow must retain the receipt after the covered runner step")
  const script = block.split("        run: |\n")[1].split("\n").map(line => line.replace(/^          /, "")).join("\n")
  const copied = spawnSync("bash", ["-c", script], {
    encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: path.join(root, "runner-temp") },
  })
  assert.equal(copied.status, 0, copied.stderr)
  assert.equal(readFileSync(destination, "utf8"), receipt)
  const refused = spawnSync("bash", ["-c", script], {
    encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: path.join(root, "absent-runner-temp") },
  })
  assert.notEqual(refused.status, 0, "copy failure must not be silent success")
})
