import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { main } from "../../index.js"
import { ActivationFailure } from "../../src/activation/failures.js"
import { closeDb, openDb } from "../../src/db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { connectOrStartController as connectController } from "../../src/readiness/controller-client.js"
import { beginBackgroundConvergence, callTool, connectOrStartController } from "../../src/server.js"

const CUSTOM_MODEL = "other-768-dimensional-model"

function fixture(t, models) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-model-admission-"))
  const stateHome = path.join(root, "controller-state")
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(root, { recursive: true, force: true })
  })
  for (const name of ["DESK_EMBED_MODEL", "OLLAMA_EMBED_MODEL"]) {
    const previous = process.env[name]
    if (models[name] === undefined) delete process.env[name]
    else process.env[name] = models[name]
    cleanups.push(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
  }
  writeFileSync(path.join(root, "task.md"), "# Semantic safety\n\nDocument embedding contract.\n")
  const requests = []
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    requests.push(JSON.parse(request.body))
    return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
  })
  return { root, stateHome, requests, cleanups }
}

function runtime(fixture) {
  const controllers = []
  let convergence
  const starts = []
  fixture.cleanups.push(async () => {
    await convergence
    for (const controller of controllers.reverse()) await controller.close()
  })
  return {
    controllers,
    starts,
    converged: () => convergence,
    start: (semantic) => main({
      argv: ["--root", fixture.root],
      env: {},
      readinessPolicy: { semantic },
      runtimeImporter: async () => ({
        async connectOrStartController(options) {
          const controller = await connectOrStartController({
            ...options, stateHome: fixture.stateHome, ephemeral: true,
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

for (const semantic of ["background", "required"]) {
  for (const variable of ["DESK_EMBED_MODEL", "OLLAMA_EMBED_MODEL"]) {
    for (const existing of [false, true]) {
      test(`${semantic} refuses ${variable} mismatch before ${existing ? "controller reuse" : "controller creation"}`, async (t) => {
        const context = fixture(t, { [variable]: CUSTOM_MODEL })
        let convergenceCalls = 0
        if (existing) {
          // Reproduce the previously accepted controller identity without using the runtime guard.
          const controller = await connectController({
            root: context.root, stateHome: context.stateHome, ephemeral: true,
            lexicalContract: {
              schema: 1, chunker: "markdown-v1", normalization: "unicode-v1",
              policy: { lexical: "required" },
            },
            semanticContract: {
              mode: semantic, embedding_spec: { ...ACTIVE_EMBEDDING_SPEC, model: CUSTOM_MODEL },
            },
            handlers: {
              beginConvergence() {
                convergenceCalls += 1
                return { semantic: { chunks_total: 1, vectors_indexed: 1, missing_vectors: 0 } }
              },
            },
          })
          context.cleanups.push(() => controller.close())
        }
        const connections = t.mock.method(Socket.prototype, "connect")
        const ordinary = runtime(context)
        await assert.rejects(ordinary.start(semantic), (error) => {
          assert.ok(error instanceof ActivationFailure)
          assert.equal(error.status, "terminal")
          assert.equal(error.phase, "VERIFYING")
          assert.equal(error.code, "embedding_model_mismatch")
          assert.equal(error.retryable, false)
          assert.equal(error.expected.model, ACTIVE_EMBEDDING_SPEC.model)
          assert.equal(error.expected.embedding_spec_id, ACTIVE_EMBEDDING_SPEC.id)
          assert.equal(error.observed.model, CUSTOM_MODEL)
          assert.equal(error.observed.semantic, semantic)
          assert.match(error.message, /DESK_EMBED_MODEL.*OLLAMA_EMBED_MODEL/u)
          assert.deepEqual(error.automatic_actions, [])
          return true
        })
        assert.equal(ordinary.starts.length, 0)
        assert.equal(ordinary.controllers.length, 0)
        assert.equal(connections.mock.callCount(), 0, "refusal must precede controller lookup/handshake")
        assert.equal(convergenceCalls, 0)
        assert.equal(context.requests.length, 0)
        assert.equal(existsSync(path.join(context.root, ".state")), false)
        if (!existing) assert.equal(existsSync(context.stateHome), false)
      })
    }
  }
}

const acceptedModels = [
  { label: "unset default", models: {} },
  { label: "matching DESK model", models: { DESK_EMBED_MODEL: "nomic-embed-text" } },
  { label: "matching Ollama model", models: { OLLAMA_EMBED_MODEL: "nomic-embed-text" } },
  { label: "trimmed matching model", models: { DESK_EMBED_MODEL: " nomic-embed-text " } },
  { label: "blank defaults", models: { DESK_EMBED_MODEL: " ", OLLAMA_EMBED_MODEL: "" } },
  {
    label: "effective DESK model takes precedence",
    models: { DESK_EMBED_MODEL: "nomic-embed-text", OLLAMA_EMBED_MODEL: CUSTOM_MODEL },
  },
]

for (const semantic of ["background", "required"]) {
  for (const { label, models } of acceptedModels) {
    test(`${semantic} ${label} uses the active model for ordinary index embedding and preserves lexical fallback without fence proof`, async (t) => {
      const context = fixture(t, models)
      const ordinary = runtime(context)
      await ordinary.start(semantic)
      await ordinary.converged()
      assert.equal(ordinary.starts.length, 1)
      const controller = ordinary.controllers[0]
      assert.deepEqual(controller.identity.semantic_contract.embedding_spec, ACTIVE_EMBEDDING_SPEC)
      assert.equal((await controller.barrier({ capability: "semantic" })).current, true)
      const documentRequests = context.requests.splice(0)
      assert.ok(documentRequests.length > 0)
      assert.ok(documentRequests.some(({ prompt }) => prompt.includes("Document embedding contract.")))
      assert.ok(documentRequests.every(({ model }) => model === ACTIVE_EMBEDDING_SPEC.model))

      const response = await callTool({
        deskRoot: context.root, name: "desk_search",
        input: { query: "semantic safety" }, statusContext: ordinary.starts[0],
      })
      assert.notEqual(response.isError, true)
      const result = JSON.parse(response.content[0].text)
      assert.equal(result.search_mode, "lexical")
      assert.equal(result.semantic_unavailable, true)
      assert.ok(result.results.some(({ path: docPath }) => docPath === "task.md"))
      assert.match(result.readiness_diagnostic?.reason ?? "", /unsupported_flush/u)
      assert.deepEqual(context.requests, [])
      const db = openDb(context.root)
      try {
        const specs = db.prepare(
          "SELECT DISTINCT c.embedding_spec_id, s.model FROM chunks c JOIN embedding_specs s ON s.id = c.embedding_spec_id JOIN chunk_vecs v ON v.chunk_id = c.id",
        ).all()
        assert.deepEqual(specs, [
          { embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id, model: ACTIVE_EMBEDDING_SPEC.model },
        ])
      } finally {
        closeDb(db)
      }
    })
  }
}

for (const variable of ["DESK_EMBED_MODEL", "OLLAMA_EMBED_MODEL"]) {
  test(`unsupported ignores ${variable} mismatch without embedding during convergence`, async (t) => {
    const context = fixture(t, { [variable]: CUSTOM_MODEL })
    const ordinary = runtime(context)
    await ordinary.start("unsupported")
    await ordinary.converged()
    assert.equal(ordinary.starts.length, 1)
    assert.equal(process.env[variable], CUSTOM_MODEL, "configuration must not be rewritten")
    const controller = ordinary.controllers[0]
    assert.equal(controller.identity.semantic_contract.embedding_spec, null)
    assert.equal((await controller.barrier({ capability: "lexical" })).current, true)
    assert.equal((await controller.barrier({ capability: "semantic" })).current, false)
    assert.equal(context.requests.length, 0)
  })
}

for (const variable of ["DESK_EMBED_MODEL", "OLLAMA_EMBED_MODEL"]) {
  for (const [name, input] of [
    ["desk_search", { query: "semantic safety" }],
    ["desk_recall", { topic: "semantic safety" }],
    ["desk_similar", { path: "task.md" }],
    ["desk_timeline", { query: "semantic safety" }],
    ["desk_thread", { start_path: "task.md" }],
    ["desk_reindex", { force: true }],
  ]) {
    test(`unsupported ${name} preserves truthful capability behavior before index or query embedding`, async (t) => {
      const context = fixture(t, { [variable]: CUSTOM_MODEL })
      const ordinary = runtime(context)
      await ordinary.start("unsupported")
      await ordinary.converged()
      const response = await callTool({
        deskRoot: context.root, name, input, statusContext: ordinary.starts[0],
      })
      assert.notEqual(response.isError, true)
      const payload = JSON.parse(response.content[0].text)
      if (name === "desk_search" || name === "desk_timeline") {
        assert.equal(payload.search_mode, "lexical")
        assert.equal(payload.semantic_unavailable, true)
      } else if (name === "desk_reindex") {
        assert.equal(payload.status, "ok")
        assert.equal(payload.action, "controller_convergence")
      } else {
        assert.equal(payload.status, "error")
        assert.equal(payload.code, "required_capability_unavailable")
      }
      assert.equal(context.requests.length, 0)
      assert.equal(process.env[variable], CUSTOM_MODEL)
    })
  }
}
