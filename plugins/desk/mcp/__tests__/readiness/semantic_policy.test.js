import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { main } from "../../index.js"
import { normalizeReadinessPolicy } from "../../src/activation/readiness-policy.js"
import { controllerIdentity } from "../../src/readiness/identity.js"
import { connectOrStartController as connectController } from "../../src/readiness/controller-client.js"
import { connectOrStartController, beginBackgroundConvergence } from "../../src/server.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-semantic-policy-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test("semantic mode and complete specification participate in controller compatibility", (t) => {
  const root = fixture(t)
  const id = (mode, spec = { model: "a", dimension: 768 }) => controllerIdentity({
    root, protocolVersion: 1, lexicalContract: { schema: 1 },
    semanticContract: { mode, embedding_spec: spec },
  }).id
  assert.notEqual(id("unsupported"), id("background"))
  assert.notEqual(id("required"), id("background"))
  assert.notEqual(id("background"), id("background", { model: "b", dimension: 768 }))
  assert.notEqual(id("background"), id("background", { model: "a", dimension: 384 }))
  assert.equal(id("background"), id("background", { dimension: 768, model: "a" }))
})

test("required semantic startup waits for convergence and checks the barrier before serving", async (t) => {
  const root = fixture(t)
  const entered = deferred()
  const release = deferred()
  const events = []
  const startup = main({
    argv: ["--root", root], env: {}, readinessPolicy: { semantic: "required" },
    runtimeImporter: async () => ({
      connectOrStartController: async () => ({
        accepted: true,
        async beginConvergence() {
          events.push("converge")
          entered.resolve()
          await release.promise
          events.push("converged")
        },
        async barrier(params) {
          assert.deepEqual(params, { capability: "semantic", wait: true })
          events.push("barrier")
          return { capability: "semantic", current: true, state: "READY" }
        },
      }),
      beginBackgroundConvergence,
      async startServer() { events.push("start") },
    }),
  })
  try {
    await entered.promise
    assert.deepEqual(events, ["converge"])
  } finally {
    release.resolve()
    await startup
  }
  assert.deepEqual(events, ["converge", "converged", "barrier", "start"])
})

for (const failure of ["incomplete", "convergence-failed", "barrier-failed", "missing-barrier"]) {
  test(`required semantic startup fails closed: ${failure}`, async (t) => {
    const root = fixture(t)
    let starts = 0
    const controller = {
      accepted: true,
      async beginConvergence() {
        if (failure === "convergence-failed") throw new Error("embedding operation failed")
      },
      ...(failure === "missing-barrier" ? {} : {
        async barrier() {
          if (failure === "barrier-failed") throw new Error("barrier unavailable")
          return { capability: "semantic", current: false, state: "LEXICAL_READY" }
        },
      }),
    }
    await assert.rejects(main({
      argv: ["--root", root], env: {}, readinessPolicy: { semantic: "required" },
      runtimeImporter: async () => ({
        connectOrStartController: async () => controller,
        beginBackgroundConvergence,
        async startServer() { starts += 1 },
      }),
    }), (error) => error.code === "semantic_unavailable" && error.status === "terminal")
    assert.equal(starts, 0)
  })
}

for (const semantic of ["background", "unsupported"]) {
  test(`${semantic} startup serves at CONTROL_READY without waiting for convergence`, async (t) => {
    const root = fixture(t)
    const release = deferred()
    const events = []
    try {
      await main({
        argv: ["--root", root], env: {}, readinessPolicy: { semantic },
        runtimeImporter: async () => ({
          connectOrStartController: async () => ({
            accepted: true,
            async beginConvergence() { events.push("converge"); await release.promise },
            barrier() { assert.fail("ordinary boot must not wait on a semantic barrier") },
          }),
          beginBackgroundConvergence,
          async startServer({ statusContext }) {
            assert.equal(statusContext.admission.state, "CONTROL_READY")
            events.push("start")
          },
        }),
      })
      assert.deepEqual(events, ["start", "converge"])
    } finally {
      release.resolve()
    }
  })
}

test("unsupported production convergence indexes lexical content without endpoint calls", async (t) => {
  const root = fixture(t)
  writeFileSync(path.join(root, "task.md"), "# Lexical only\n\nFind this unsupported semantic document.\n")
  let endpointCalls = 0
  t.mock.method(globalThis, "fetch", async () => {
    endpointCalls += 1
    return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
  })

  const controller = await connectOrStartController({
    deskRoot: root, policy: normalizeReadinessPolicy({ semantic: "unsupported" }),
    stateHome: path.join(root, "state"), ephemeral: true,
  })
  try {
    const result = await controller.beginConvergence()
    assert.ok(result.semantic.chunks_total > 0)
    assert.equal(result.semantic.vectors_indexed, 0)
    assert.equal(endpointCalls, 0)
    assert.equal((await controller.barrier({ capability: "lexical" })).current, true)
    assert.equal((await controller.barrier({ capability: "semantic" })).current, false)
    assert.equal(controller.identity.semantic_contract.mode, "unsupported")
  } finally {
    await controller.close()
  }
})

for (const semantic of ["background", "required"]) {
  test(`${semantic} production convergence contacts the endpoint and proves complete coverage`, async (t) => {
    const root = fixture(t)
    writeFileSync(path.join(root, "task.md"), "# Semantic content\n\nEmbed this task for semantic readiness.\n")
    let endpointCalls = 0
    t.mock.method(globalThis, "fetch", async (_url, request) => {
      endpointCalls += 1
      assert.equal(JSON.parse(request.body).model, "nomic-embed-text")
      return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
    })
    const controller = await connectOrStartController({
      deskRoot: root, policy: normalizeReadinessPolicy({ semantic }),
      stateHome: path.join(root, "state"), ephemeral: true,
    })
    try {
      await controller.beginConvergence()
      assert.ok(endpointCalls > 0)
      assert.equal((await controller.barrier({ capability: "semantic" })).current, true)
      assert.equal(controller.identity.semantic_contract.mode, semantic)
      assert.deepEqual(controller.identity.semantic_contract.embedding_spec, ACTIVE_EMBEDDING_SPEC)
      assert.equal((await controller.status()).state, "READY")
    } finally {
      await controller.close()
    }
  })
}

for (const coverage of [
  undefined,
  { chunks_total: 1, vectors_indexed: 0, missing_vectors: 1 },
  { chunks_total: 1, vectors_indexed: 0, missing_vectors: 0 },
  { chunks_total: -1, vectors_indexed: -1, missing_vectors: 0 },
  { chunks_total: 1, vectors_indexed: 1, missing_vectors: 0 },
  { chunks_total: 0, vectors_indexed: 0, missing_vectors: 0 },
]) {
  test(`semantic barrier requires proven complete coverage: ${JSON.stringify(coverage)}`, async (t) => {
    const root = fixture(t)
    const controller = await connectController({
      root, stateHome: path.join(root, "state"), ephemeral: true,
      semanticContract: { mode: "required", embedding_spec: ACTIVE_EMBEDDING_SPEC },
      handlers: { beginConvergence: async () => ({ semantic: coverage && {
        ...coverage,
        provenance_current: true,
        query_embedding: { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } },
      } }) },
    })
    try {
      assert.equal((await controller.barrier({ capability: "semantic" })).current, false)
      await controller.beginConvergence()
      const complete = coverage?.chunks_total >= 0
        && coverage?.chunks_total === coverage?.vectors_indexed && coverage?.missing_vectors === 0
      assert.equal((await controller.barrier({ capability: "semantic" })).current, complete)
      assert.equal((await controller.barrier({ capability: "lexical" })).current, true)
      assert.equal((await controller.status()).state, complete ? "READY" : "LEXICAL_READY")
    } finally {
      await controller.close()
    }
  })
}

for (const change of ["modify", "add"]) {
  test(`later required admissions wait for refreshed document coverage: ${change}`, async (t) => {
    const root = fixture(t)
    writeFileSync(path.join(root, "task.md"), "# Original\n\nOriginal task content.\n")
    const entered = deferred()
    const release = deferred()
    const barrierEntered = deferred()
    const controllers = []
    let endpointCalls = 0
    let starts = 0
    t.mock.method(globalThis, "fetch", async (_url, request) => {
      endpointCalls += 1
      if (JSON.parse(request.body).prompt.includes("Refreshed")) {
        entered.resolve("refresh")
        await release.promise
      }
      return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
    })
    const start = () => main({
      argv: ["--root", root], env: {}, readinessPolicy: { semantic: "required" },
      runtimeImporter: async () => ({
        async connectOrStartController(options) {
          const controller = await connectOrStartController({
            ...options, stateHome: path.join(root, "state"), ephemeral: true,
          })
          controllers.push(controller)
          const barrier = controller.barrier
          controller.barrier = (params) => {
            if (controllers.length === 3) barrierEntered.resolve()
            return barrier(params)
          }
          return controller
        },
        async startServer() { starts += 1 },
      }),
    })
    let refresh
    let concurrent
    try {
      await start()
      const initialCalls = endpointCalls
      assert.ok(initialCalls > 0)
      const changedDir = change === "modify" ? root : path.join(root, "added")
      mkdirSync(changedDir, { recursive: true })
      writeFileSync(path.join(changedDir, "task.md"), "# Refreshed\n\nRefreshed task content.\n")
      refresh = start()
      assert.equal(await Promise.race([entered.promise, refresh.then(() => "stale")]), "refresh")
      concurrent = start()
      await barrierEntered.promise
      assert.equal(new Set(controllers.map((controller) => controller.id)).size, 1)
      assert.equal(starts, 1)
      assert.equal((await controllers[0].barrier({ capability: "semantic" })).current, false)
      assert.equal(endpointCalls, initialCalls + 1)
      release.resolve()
      await Promise.all([refresh, concurrent])
      assert.equal(starts, 3)
      assert.equal(endpointCalls, initialCalls + 2, "one document embedding and one post-convergence query probe")
      assert.equal((await controllers[0].barrier({ capability: "semantic" })).current, true)
    } finally {
      release.resolve()
      await Promise.allSettled([refresh, concurrent])
      for (const controller of controllers.reverse()) await controller.close()
    }
  })
}
