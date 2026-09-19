import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { main } from "../../index.js"
import { closeDb, getMeta, openDb } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { connectOrStartController as connectController } from "../../src/readiness/controller-client.js"
import { beginBackgroundConvergence, connectOrStartController, ensureIndex } from "../../src/server.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(t, withDoc = true) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-query-admission-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (withDoc) writeFileSync(path.join(root, "task.md"), "# Query health\n\nActive document vector.\n")
  return root
}

function readState(root) {
  const db = openDb(root)
  try {
    return {
      provenance: getMeta(db, "active_vector_provenance"),
      vectors: db.prepare("SELECT * FROM chunk_vecs").all(),
    }
  } finally { closeDb(db) }
}

function runtime(root) {
  const controllers = []
  let convergence
  const starts = []
  return {
    controllers, starts,
    converged: () => convergence,
    async close() {
      await convergence
      for (const controller of controllers.reverse()) await controller.close()
    },
    start: (semantic) => main({
      argv: ["--root", root], env: {}, readinessPolicy: { semantic },
      runtimeImporter: async () => ({
        async connectOrStartController(options) {
          const controller = await connectOrStartController({
            ...options, stateHome: path.join(root, "controller-state"), ephemeral: true,
          })
          controllers.push(controller)
          return controller
        },
        beginBackgroundConvergence(admission) {
          convergence = beginBackgroundConvergence(admission)
          return convergence
        },
        async startServer({ statusContext }) { starts.push(statusContext) },
      }),
    }),
  }
}

for (const available of [false, true]) {
  for (const withDoc of [true, false]) {
    test(`required warm ${withDoc ? "complete" : "empty"} index ${available ? "admits" : "refuses"} with query endpoint availability ${available}`, async (t) => {
      const root = fixture(t, withDoc)
      await ensureIndex(root, {
        snapshots: false, vectorPacks: false,
        embed: { fetch: async () => new Response(JSON.stringify({ embedding: Array(768).fill(0.1) })) },
      })
      const before = readState(root)
      assert.notEqual(before.provenance, null)
      const envBefore = { ...process.env }
      const requests = []
      t.mock.method(globalThis, "fetch", async (_url, request) => {
        requests.push(JSON.parse(request.body))
        if (!available) throw new Error("query endpoint unavailable")
        return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
      })
      const ordinary = runtime(root)
      try {
        if (available) await ordinary.start("required")
        else await assert.rejects(ordinary.start("required"), (error) =>
          error.code === "semantic_unavailable" && error.status === "terminal")
        assert.equal(ordinary.starts.length, available ? 1 : 0)
        assert.ok(requests.length > 0, "warm startup must probe, not infer query availability")
        assert.ok(requests.every(({ model, prompt }) =>
          model === ACTIVE_EMBEDDING_SPEC.model && prompt === "desk semantic health probe"))
        const controller = ordinary.controllers[0]
        assert.equal((await controller.barrier({ capability: "semantic" })).current, available)
        assert.equal((await controller.barrier({ capability: "lexical" })).current, true)
        assert.equal((await controller.status()).state, available ? "READY" : "LEXICAL_READY")
        assert.deepEqual(readState(root), before, "query outage must not invalidate proven document vectors")
        assert.deepEqual({ ...process.env }, envBefore)
      } finally { await ordinary.close() }
    })
  }
}

for (const available of [false, true]) {
  test(`background serves before held query probe resolves ${available}`, async (t) => {
    const root = fixture(t)
    await ensureIndex(root, {
      snapshots: false, vectorPacks: false,
      embed: { fetch: async () => new Response(JSON.stringify({ embedding: Array(768).fill(0.1) })) },
    })
    const entered = deferred()
    const release = deferred()
    const ordinary = runtime(root)
    t.mock.method(globalThis, "fetch", async (_url, request) => {
      assert.equal(ordinary.starts.length, 1, "MCP starts before background query probing")
      assert.equal(JSON.parse(request.body).model, ACTIVE_EMBEDDING_SPEC.model)
      entered.resolve("probe")
      await release.promise
      if (!available) throw new Error("unavailable")
      return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
    })
    try {
      await ordinary.start("background")
      assert.equal(ordinary.starts[0].admission.state, "CONTROL_READY")
      assert.equal(await Promise.race([
        entered.promise, ordinary.converged().then(() => "no probe"),
      ]), "probe")
      assert.equal((await ordinary.controllers[0].barrier({ capability: "semantic" })).current, false)
      release.resolve()
      const result = await ordinary.converged()
      assert.equal(result.semantic.query_embedding.available, available)
      assert.equal((await ordinary.controllers[0].status()).state, available ? "READY" : "LEXICAL_READY")
    } finally {
      release.resolve()
      await ordinary.close()
    }
  })
}

test("unsupported admission leaves legacy vectors and provenance untouched with no query or document probe", async (t) => {
  const root = fixture(t)
  await rebuildIndex(root, {
    embed: { model: "legacy-custom-model", fetch: async () =>
      new Response(JSON.stringify({ embedding: Array(768).fill(0.9) })) },
  })
  const before = readState(root)
  assert.equal(before.provenance, null)
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("must not probe") })
  const ordinary = runtime(root)
  try {
    await ordinary.start("unsupported")
    await ordinary.converged()
    assert.equal(ordinary.starts.length, 1)
    assert.equal(calls, 0)
    assert.deepEqual(readState(root), before)
    assert.equal((await ordinary.controllers[0].barrier({ capability: "semantic" })).current, false)
    assert.equal((await ordinary.controllers[0].barrier({ capability: "lexical" })).current, true)
  } finally { await ordinary.close() }
})

test("required admission cannot reuse a legacy coverage-only controller", async (t) => {
  const root = fixture(t)
  let legacyCalls = 0
  const legacy = await connectController({
    root, stateHome: path.join(root, "controller-state"), ephemeral: true,
    lexicalContract: {
      schema: 1, chunker: "markdown-v1", normalization: "unicode-v1",
      policy: { lexical: "required" },
    },
    semanticContract: { mode: "required", embedding_spec: ACTIVE_EMBEDDING_SPEC },
    handlers: {
      beginConvergence() {
        legacyCalls += 1
        return { semantic: { chunks_total: 1, vectors_indexed: 1, missing_vectors: 0 } }
      },
      barrier: () => ({ capability: "semantic", current: true, state: "READY" }),
    },
  })
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline") })
  const ordinary = runtime(root)
  try {
    await assert.rejects(ordinary.start("required"), (error) => error.code === "controller_semantic_mismatch")
    assert.equal(legacyCalls, 0)
    assert.equal(ordinary.controllers.length, 0, "a legacy semantic contract cannot create a second lexical owner")
    assert.equal(ordinary.starts.length, 0)
  } finally {
    await ordinary.close()
    await legacy.close()
  }
})

for (const evidence of ["missing-provenance", "missing-probe", "unavailable-probe", "wrong-model", "complete"]) {
  test(`required semantic barrier checks provenance and active query probe: ${evidence}`, async (t) => {
    const root = fixture(t)
    const coverage = {
      chunks_total: 1, vectors_indexed: 1, missing_vectors: 0,
      provenance_current: evidence !== "missing-provenance",
      query_embedding: evidence === "missing-probe" ? undefined : {
        available: evidence !== "unavailable-probe",
        diagnostic: { model: evidence === "wrong-model" ? "other-model" : ACTIVE_EMBEDDING_SPEC.model },
      },
    }
    const controller = await connectController({
      root, stateHome: path.join(root, "controller-state"), ephemeral: true,
      semanticContract: { mode: "required", embedding_spec: ACTIVE_EMBEDDING_SPEC },
      handlers: { beginConvergence: async () => ({ semantic: coverage }) },
    })
    try {
      await controller.beginConvergence()
      assert.equal((await controller.barrier({ capability: "semantic" })).current, evidence === "complete")
    } finally { await controller.close() }
  })
}
