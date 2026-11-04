import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { prewarm } from "./_prewarmed_recovery.js"

function fixture(t, samples) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-prewarm-readiness-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const marker = path.join(root, "completed.marker")
  const evidence = path.join(root, "completed.json")
  const output = new EventEmitter()
  let time = 0, calls = 0
  const ready = {
    state: "ready", root: { path: root, valid: true }, write_scope: { mode: "workspace" },
    status_detail: "complete", status_detail_from: "2026-01-01T00:00:00Z",
  }
  const transport = {
    output,
    input: {
      write(line) {
        const request = JSON.parse(line)
        let result = {}
        if (request.method === "tools/call") {
          const sample = samples[Math.min(calls++, samples.length - 1)]
          time += sample.elapsed
          const status = { ...ready, root: { ...ready.root, valid: sample.valid ?? true }, ...sample.status }
          result = { content: [{ type: "text", text: JSON.stringify(status) }], isError: sample.error ?? false }
        }
        output.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
      },
    },
  }
  const run = () => prewarm(transport, { root, marker, evidence, now: () => time, pause: async (ms) => { time += ms } })
  return { run, marker, evidence, output, calls: () => calls }
}

test("prewarm records a slow pending round trip, then requires a genuinely ready fast observation", async (t) => {
  const f = fixture(t, [
    { elapsed: 250, status: { state: "admitting", detail_pending: true } },
    { elapsed: 5 },
  ])
  await f.run()
  const observed = JSON.parse(readFileSync(f.evidence, "utf8"))
  assert.equal(observed.state, "ready")
  assert.equal(observed.elapsedMs, 5)
  assert.deepEqual(observed.observations.map((sample) => sample.elapsedMs), [250, 5])
  assert.equal(observed.observations[0].ready, false)
  assert.equal(observed.observations[0].qualified, false)
  assert.ok(existsSync(f.marker))
  assert.equal(f.calls(), 2)
  assert.equal(f.output.listenerCount("data"), 0)
})

test("prewarm does not mark a slow completed response as the qualified cache observation", async (t) => {
  const f = fixture(t, [{ elapsed: 250 }, { elapsed: 5 }])
  await f.run()
  const observed = JSON.parse(readFileSync(f.evidence, "utf8"))
  assert.equal(observed.elapsedMs, 5)
  assert.deepEqual(observed.observations.map((sample) => sample.elapsedMs), [250, 5])
  assert.equal(observed.observations[0].ready, true)
  assert.equal(observed.observations[0].qualified, false)
  assert.equal(observed.observations[1].qualified, true)
  assert.equal(f.calls(), 2)
})

test("prewarm refuses all-slow ready responses at the original 15 second deadline", async (t) => {
  const f = fixture(t, [{ elapsed: 250 }])
  await assert.rejects(f.run(), (error) => {
    assert.match(error.message, /never completed same-context status before resolver injection/u)
    assert.ok(Array.isArray(error.observations), "failed prewarming must retain every observed round trip")
    assert.equal(error.observations.length, 56)
    assert.ok(error.observations.every((sample) => sample.elapsedMs === 250 && !sample.qualified))
    return true
  })
  assert.equal(f.calls(), 56)
  assert.equal(existsSync(f.marker), false)
  assert.equal(f.output.listenerCount("data"), 0)
})

test("prewarm refuses a ready response that arrives after the original deadline", async (t) => {
  const f = fixture(t, [{ elapsed: 15001 }])
  await assert.rejects(f.run(), /never completed same-context status before resolver injection/u)
  assert.equal(existsSync(f.marker), false)
})

test("prewarm never accepts incomplete, wrong-root or errored responses", async (t) => {
  for (const sample of [
    { elapsed: 5, status: { state: "admitting" } },
    { elapsed: 5, status: { detail_pending: true } },
    { elapsed: 5, status: { root: { path: "other", valid: true } } },
    { elapsed: 5, valid: false },
    { elapsed: 5, status: { write_scope: { mode: "read_only" } } },
    { elapsed: 5, status: { status_detail: "Destination verification is pending" } },
    { elapsed: 5, error: true },
  ]) {
    const f = fixture(t, [sample])
    await assert.rejects(f.run(), /never completed same-context status before resolver injection/u)
    assert.equal(existsSync(f.marker), false)
  }
})

test("prewarm retains the strict less-than-200 boundary rather than rounding a 200 ms sample down", async (t) => {
  const f = fixture(t, [{ elapsed: 200 }, { elapsed: 199 }])
  await f.run()
  const observed = JSON.parse(readFileSync(f.evidence, "utf8"))
  assert.equal(observed.elapsedMs, 199)
  assert.deepEqual(observed.observations.map((sample) => sample.elapsedMs), [200, 199])
})

test("prewarm does not accept a completed observation at the readiness deadline", async (t) => {
  const f = fixture(t, [{ elapsed: 15000 }])
  await assert.rejects(f.run(), /never completed same-context status before resolver injection/u)
  assert.equal(existsSync(f.marker), false)
})
