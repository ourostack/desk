import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  beginBackgroundConvergence, callTool, connectOrStartController, ensureIndex, startControllerRuntime,
} from "../../../../../plugins/desk/mcp/src/server.js"
import { startInProcess, statusContextOf } from "./_in_process_desk.js"
import { connectOrStartController as connectController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function session(t, { semantic = "background", handler, statusDelayMs = 0 } = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "desk-live-status-"))
  const firstStatus = deferred()
  const probeEntered = deferred()
  const probeRelease = deferred()
  const state = { controller: null, convergence: null, initial: null, context: null, desk: null }
  let delayed = false
  let nextDelayMs = 0
  // One desk_status answer, whatever its detail is.
  const readOnce = async () => {
    const response = await state.desk.call("desk_status", { detail: true })
    assert.equal(response.isError, false, JSON.stringify(response.payload))
    return response.payload
  }
  // desk_status answers within a short budget (STATUS_BUDGET_MS in desk-session.js). On a loaded machine its runtime status computation can miss that budget, and the call then serves the last detail it has, marked `status_detail`. A test that asserts on `readiness.detail` reads until the detail is one this call computed, so it never judges a cached one.
  const read = async () => {
    const deadline = Date.now() + 15_000
    for (;;) {
      const payload = await readOnce()
      if (isCurrentDetail(payload)) return payload
      if (Date.now() > deadline) throw new Error(`desk_status never served a current detail; last: ${JSON.stringify(payload)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  t.after(async () => {
    probeRelease.resolve()
    await Promise.allSettled([state.convergence])
    await state.desk?.close()
    await state.controller?.close()
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(path.join(root, "task.md"), "# Live status\n\nSemantic coverage fixture.\n")
  await ensureIndex(root, {
    snapshots: false, vectorPacks: false,
    embed: { fetch: async () => new Response(JSON.stringify({ embedding: Array(768).fill(0.1) })) },
  })
  return {
    root, state, read, readOnce, probeEntered, probeRelease,
    // The next runtime status is read now and arrives `ms` later, as on a loaded machine.
    delayNextStatus(ms) { nextDelayMs = ms },
    async start() {
      state.desk = await startInProcess({
        argv: ["--root", root], env: {}, readinessPolicy: { semantic },
        runtimeImporter: async () => ({
          async callTool(request) {
            const result = await callTool(request)
            if (request.name === "desk_status") firstStatus.resolve()
            // A loaded machine delivers a runtime status late: the first one is read now and arrives statusDelayMs later.
            if (request.name === "desk_status" && statusDelayMs > 0 && !delayed) {
              delayed = true
              await new Promise((resolve) => setTimeout(resolve, statusDelayMs))
            }
            if (request.name === "desk_status" && nextDelayMs > 0) {
              const ms = nextDelayMs
              nextDelayMs = 0
              await new Promise((resolve) => setTimeout(resolve, ms))
            }
            return result
          },
          async connectOrStartController(options) {
            // Exercise the controller-free status response before allowing election to finish.
            await firstStatus.promise
            state.controller = handler
              ? await connectController({
                  root, stateHome: path.join(root, "controller-state"), ephemeral: true,
                  semanticContract: { mode: semantic },
                  handlers: { beginConvergence: handler },
                })
              : await connectOrStartController({
                  ...options, stateHome: path.join(root, "controller-state"), ephemeral: true, controllerLauncher: startControllerRuntime,
                })
            return state.controller
          },
          beginBackgroundConvergence(admission) {
            state.convergence = beginBackgroundConvergence(admission)
            return state.convergence
          },
        }),
      })
      // The runtime can report not_checked before a controller exists; wait for its actual state.
      state.initial = await state.desk.statusUntil((payload) => payload.readiness?.state !== undefined && payload.readiness.state !== "not_checked")
      state.context = statusContextOf(state.desk)
    },
  }
}

for (const available of [false, true]) {
  test(`live MCP background status advances from initial/pending to query availability ${available}`, async (t) => {
    const fixture = await session(t)
    let requests = 0
    t.mock.method(globalThis, "fetch", async () => {
      requests += 1
      fixture.probeEntered.resolve()
      await fixture.probeRelease.promise
      if (!available) throw new Error("query service offline " + "x".repeat(10_000))
      return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
    })
    await fixture.start()
    await fixture.probeEntered.promise
    const initial = fixture.state.initial
    // Admission starts background convergence before the first desk_status can read it.
    assert.ok(["CONTROL_READY", "LEXICAL_CONVERGING"].includes(initial.readiness?.detail.controller_state), initial.readiness?.detail.controller_state)
    assert.ok(["not_checked", "pending"].includes(initial.readiness.detail.convergence.status))
    assert.equal(initial.query_embedding.available, "not_checked")
    assert.equal(initial.startup_fallback.mode, "not_checked")
    assert.equal(fixture.state.context.startup, undefined)
    const pending = await fixture.read()
    assert.equal(pending.readiness.detail.controller_state, "LEXICAL_CONVERGING")
    assert.equal(pending.readiness.detail.convergence.status, "pending")
    assert.equal(pending.query_embedding.available, "not_checked")
    fixture.probeRelease.resolve()
    await fixture.state.convergence
    // Readiness advances independently of the diagnostic tool.
    assert.equal((await fixture.state.controller.barrier({ capability: "semantic" })).current, available)
    const requestCount = requests
    // The runtime status of this read arrives late (a loaded machine), so the first answer carries the earlier pending detail, marked cached.
    fixture.delayNextStatus(300)
    const late = await fixture.readOnce()
    assert.match(late.status_detail, /^cached: /u)
    assert.equal(late.readiness.detail.controller_state, "LEXICAL_CONVERGING")
    const settled = await fixture.read()
    assert.equal(requests, requestCount, "status must not probe or initiate convergence")
    assert.equal(settled.readiness.detail.controller_state, available ? "READY" : "LEXICAL_READY")
    assert.equal(settled.readiness.detail.convergence.status, "succeeded")
    assert.equal(settled.readiness.detail.convergence.semantic.provenance_current, true)
    assert.equal(settled.readiness.detail.convergence.semantic.missing_vectors, 0)
    assert.equal(settled.query_embedding.available, available)
    assert.equal(settled.query_embedding.diagnostic.model, "nomic-embed-text")
    assert.equal(settled.startup_fallback.mode, "not_checked")
    assert.equal(settled.startup_fallback.degraded, !available)
    assert.equal(settled.degraded_modes.includes("query_embedding_unavailable"), !available)
    if (!available) {
      assert.match(settled.query_embedding.diagnostic.message, /query service offline/u)
      assert.ok(settled.query_embedding.diagnostic.message.length <= 2048)
    }
    const owner = (await fixture.state.controller.status()).owner
    assert.equal(JSON.stringify(settled).includes(owner.token), false)
    assert.equal(fixture.state.context.startup, undefined)
  })
}

test("required startup exposes a populated READY status on the first real MCP call", async (t) => {
  const fixture = await session(t, { semantic: "required" })
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ embedding: Array(768).fill(0.1) })))
  await fixture.start()
  // desk_status answers at once; admission reaches ready only once required semantic coverage is proven, and then status is READY.
  // READY is only promised by a detail computed after readiness (see isCurrentDetail): a ready status can carry no detail, or a cached one, when the runtime status misses its short budget.
  const ready = await fixture.state.desk.statusUntil((payload) => payload.state === "ready" && isCurrentDetail(payload))
  assert.equal(ready.readiness?.detail.controller_state, "READY")
  assert.equal(ready.readiness.state, "ready")
  assert.equal(ready.readiness.detail.convergence.status, "succeeded")
  assert.equal(ready.query_embedding.available, true)
  assert.equal(ready.startup_fallback.mode, "not_checked")
  assert.equal(fixture.state.context.startup, undefined)
})

// desk_status stamps `state` with admission as of the answer, but its `readiness.detail` is a separate runtime computation that can be older: when a computation misses the call's budget, the call serves the last detail it has and says so with `status_detail` ("cached: ...") and `status_detail_from`. A ready status therefore promises READY only when its detail carries no such marker.
const isCurrentDetail = (payload) => payload.readiness?.detail !== undefined && payload.status_detail === undefined && payload.status_detail_from === undefined

test("a ready status served with a cached detail from before readiness says so; the unmarked detail is READY", async (t) => {
  // The runtime status is read now and arrives 200 ms later, past the call's budget, while the probe holds convergence for 600 ms.
  const fixture = await session(t, { semantic: "required", statusDelayMs: 200 })
  t.mock.method(globalThis, "fetch", async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
  })
  await fixture.start()
  const cached = await fixture.state.desk.statusUntil((payload) => payload.state === "ready" && payload.readiness?.detail !== undefined)
  if (cached.readiness.detail.controller_state !== "READY") {
    assert.match(cached.status_detail, /^cached: /u, "a detail older than readiness is marked cached")
    assert.equal(typeof cached.status_detail_from, "string")
  }
  const current = await fixture.state.desk.statusUntil((payload) => payload.state === "ready" && isCurrentDetail(payload))
  assert.equal(current.readiness.detail.controller_state, "READY")
})

test("failed background convergence is observable with a bounded diagnostic and clears on recovery", async (t) => {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  let calls = 0
  const fixture = await session(t, { handler: async () => {
    calls += 1
    if (calls === 1) {
      entered.resolve()
      await release.promise
      throw new Error("index failed: " + "x".repeat(10_000))
    }
    return { semantic: { chunks_total: 1, vectors_indexed: 0, missing_vectors: 1 } }
  } })
  await fixture.start()
  await entered.promise
  assert.equal((await fixture.read()).readiness?.detail.convergence.status, "pending")
  release.resolve()
  await assert.rejects(fixture.state.convergence, /index failed/u)
  const failed = await fixture.read()
  assert.equal(failed.readiness.detail.controller_state, "RECOVERING")
  assert.equal(failed.readiness.state, "degraded", "agents get one word, never the raw RECOVERING")
  assert.equal(failed.readiness.detail.convergence.status, "failed")
  assert.match(failed.readiness.detail.convergence.diagnostic.message, /index failed/u)
  assert.ok(failed.readiness.detail.convergence.diagnostic.message.length <= 2048)
  assert.ok(failed.degraded_modes.includes("convergence_failed"))
  assert.match(fixture.state.desk.stderr(), /background convergence failed/u)
  assert.equal(failed.startup_fallback.mode, "not_checked")
  await fixture.state.controller.beginConvergence()
  const recovered = await fixture.read()
  assert.equal(recovered.readiness.detail.controller_state, "LEXICAL_READY")
  assert.equal(recovered.readiness.state, "ready")
  assert.equal(recovered.readiness.detail.convergence.status, "succeeded")
  assert.equal(recovered.readiness.detail.convergence.diagnostic, null)
  assert.equal(recovered.degraded_modes.includes("convergence_failed"), false)
})

test("a disconnected controller is never reported as healthy stale readiness: desk_status re-elects one in place", async (t) => {
  const fixture = await session(t, { handler: async () => ({ indexed: true }) })
  await fixture.start()
  await fixture.state.convergence
  const lost = fixture.state.controller
  await lost.close()
  // desk_status answers at once and checks the controller in the background; the next call sees the re-elected one.
  await fixture.read()
  const status = await fixture.state.desk.statusUntil((payload) => payload.state === "ready" && payload.readiness?.state !== "unavailable")
  assert.equal(status.state, "ready")
  assert.notEqual(fixture.state.controller, lost, "a new controller was elected in the same session")
  assert.ok(status.admission.attempts >= 2)
  assert.match(fixture.state.desk.stderr(), /state: degraded:controller_unavailable/u)
})
