import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  beginBackgroundConvergence, callTool, connectOrStartController, ensureIndex,
} from "../../src/server.js"
import { startInProcess, statusContextOf } from "./_in_process_desk.js"
import { connectOrStartController as connectController } from "../../src/readiness/controller-client.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function session(t, { semantic = "background", handler } = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "desk-live-status-"))
  const probeEntered = deferred()
  const probeRelease = deferred()
  const state = { controller: null, convergence: null, initial: null, context: null, desk: null }
  const read = async () => {
    const response = await state.desk.call("desk_status")
    assert.equal(response.isError, false, JSON.stringify(response.payload))
    return response.payload
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
    root, state, read, probeEntered, probeRelease,
    async start() {
      state.desk = await startInProcess({
        argv: ["--root", root], env: {}, readinessPolicy: { semantic },
        runtimeImporter: async () => ({
          callTool,
          async connectOrStartController(options) {
            state.controller = handler
              ? await connectController({
                  root, stateHome: path.join(root, "controller-state"), ephemeral: true,
                  semanticContract: { mode: semantic },
                  handlers: { beginConvergence: handler },
                })
              : await connectOrStartController({
                  ...options, stateHome: path.join(root, "controller-state"), ephemeral: true,
                })
            return state.controller
          },
          beginBackgroundConvergence(admission) {
            state.convergence = beginBackgroundConvergence(admission)
            return state.convergence
          },
        }),
      })
      // The first status can still be admitting; capture controller detail only once it is available.
      state.initial = await state.desk.statusUntil((payload) => payload.readiness?.state !== undefined)
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
    assert.ok(["CONTROL_READY", "LEXICAL_CONVERGING"].includes(initial.readiness?.state), initial.readiness?.state)
    assert.ok(["not_checked", "pending"].includes(initial.readiness.convergence.status))
    assert.equal(initial.query_embedding.available, "not_checked")
    assert.equal(initial.startup_fallback.mode, "not_checked")
    assert.equal(fixture.state.context.startup, undefined)
    const pending = await fixture.read()
    assert.equal(pending.readiness.state, "LEXICAL_CONVERGING")
    assert.equal(pending.readiness.convergence.status, "pending")
    assert.equal(pending.query_embedding.available, "not_checked")
    fixture.probeRelease.resolve()
    await fixture.state.convergence
    // Readiness advances independently of the diagnostic tool.
    assert.equal((await fixture.state.controller.barrier({ capability: "semantic" })).current, available)
    const requestCount = requests
    const settled = await fixture.read()
    assert.equal(requests, requestCount, "status must not probe or initiate convergence")
    assert.equal(settled.readiness.state, available ? "READY" : "LEXICAL_READY")
    assert.equal(settled.readiness.convergence.status, "succeeded")
    assert.equal(settled.readiness.convergence.semantic.provenance_current, true)
    assert.equal(settled.readiness.convergence.semantic.missing_vectors, 0)
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
  const ready = await fixture.state.desk.statusUntil((payload) => payload.state === "ready")
  assert.equal(ready.readiness?.state, "READY")
  assert.equal(ready.readiness.convergence.status, "succeeded")
  assert.equal(ready.query_embedding.available, true)
  assert.equal(ready.startup_fallback.mode, "not_checked")
  assert.equal(fixture.state.context.startup, undefined)
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
  assert.equal((await fixture.read()).readiness?.convergence.status, "pending")
  release.resolve()
  await assert.rejects(fixture.state.convergence, /index failed/u)
  const failed = await fixture.read()
  assert.equal(failed.readiness.state, "RECOVERING")
  assert.equal(failed.readiness.convergence.status, "failed")
  assert.match(failed.readiness.convergence.diagnostic.message, /index failed/u)
  assert.ok(failed.readiness.convergence.diagnostic.message.length <= 2048)
  assert.ok(failed.degraded_modes.includes("convergence_failed"))
  assert.match(fixture.state.desk.stderr(), /background convergence failed/u)
  assert.equal(failed.startup_fallback.mode, "not_checked")
  await fixture.state.controller.beginConvergence()
  const recovered = await fixture.read()
  assert.equal(recovered.readiness.state, "LEXICAL_READY")
  assert.equal(recovered.readiness.convergence.status, "succeeded")
  assert.equal(recovered.readiness.convergence.diagnostic, null)
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
