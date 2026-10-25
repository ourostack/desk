import { test } from "node:test"
import assert from "node:assert/strict"
import { ACTIVE_VECTOR_SPACE } from "../../../../../plugins/desk/mcp/src/indexer/text-vectors.js"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import fsBuiltin from "node:fs"
import fsPromises from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { EventEmitter } from "node:events"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { startInProcess, statusContextOf } from "../runtime/_in_process_desk.js"
import { closeDb, openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"
import { connectOrStartController as connectController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { beginBackgroundConvergence, callTool, connectOrStartController, startControllerRuntime } from "../../../../../plugins/desk/mcp/src/server.js"

const CUSTOM_MODEL = "other-768-dimensional-model"

function fixtureMarkerRelative(root, file, paths = path) {
  if (typeof file !== "string" || !paths.isAbsolute(file)) return null
  const relative = paths.relative(root, file)
  const comparison = relative.split(paths.sep).join("/")
  return /^\.state\/readiness-fences\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.fence$/u.test(comparison) ? relative : null
}

test("controlled marker filter preserves platform spelling and rejects other roots or malformed names", () => {
  const id = "12345678-1234-1234-1234-123456789abc"
  const relative = `.state/readiness-fences/${id}.fence`
  assert.equal(fixtureMarkerRelative("/fixture", `/fixture/${relative}`, path.posix), relative)
  const windowsRelative = `.state\\readiness-fences\\${id}.fence`
  assert.equal(fixtureMarkerRelative("C:\\fixture", `C:\\fixture\\${windowsRelative}`, path.win32), windowsRelative)
  for (const [paths, root, files] of [
    [path.posix, "/fixture", ["/fixture-other/" + relative, "/outside/" + relative,
      "/fixture/.state/readiness-fences/invalid.fence", "/fixture/" + relative + ".extra",
      "/fixture/" + windowsRelative, relative, null]],
    [path.win32, "C:\\fixture", ["C:\\fixture-other\\" + windowsRelative, "D:\\fixture\\" + windowsRelative,
      "C:\\fixture\\.state\\readiness-fences\\invalid.fence", "C:\\fixture\\" + windowsRelative + ".extra",
      windowsRelative, null]],
  ]) {
    for (const file of files) assert.equal(fixtureMarkerRelative(root, file, paths), null)
  }
})

function fixture(t, models, { uncertainFence = null } = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "desk-model-admission-"))
  const stateHome = path.join(root, "controller-state")
  const cleanups = []
  const handles = [], restores = [], markerWrites = []
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup()
    } finally {
      for (const handle of handles) handle.close()
      for (const restore of restores.reverse()) restore()
      syncBuiltinESMExports()
      rmSync(root, { recursive: true, force: true })
    }
  })
  // Model/admission semantics use controlled backend delivery, not native
  // macOS delivery timing. Keep the production watcher, marker bytes, scan,
  // journal, controller and query proof. Native behavior has its own tests.
  // startControllerRuntime constructs its watcher internally: reach only its
  // default builtin watch boundary, never a caller-selectable real issuer.
  const watchNative = fsBuiltin.watch, writeNative = fsPromises.writeFile
  let registration = null
  const watchMock = t.mock.method(fsBuiltin, "watch", function (target, options, callback) {
    if (target !== root) return Reflect.apply(watchNative, this, arguments)
    const handle = new EventEmitter()
    handle.closed = false
    handle.close = () => { handle.closed = true }
    handles.push(handle)
    registration = { handle, callback }
    return handle
  })
  restores.push(() => watchMock.mock.restore())
  const writeMock = t.mock.method(fsPromises, "writeFile", async function (file, ...args) {
    const result = await Reflect.apply(writeNative, this, [file, ...args])
    const markerRelative = fixtureMarkerRelative(root, file)
    if (markerRelative === null) return result
    assert.ok(registration && !registration.handle.closed, "exact fixture watcher must be registered before marker delivery")
    assert.equal(readFileSync(file, "utf8"), path.basename(file), "deliver only a completed actual marker write")
    markerWrites.push(file)
    if (markerWrites.length === uncertainFence) registration.handle.emit("error", new Error("controlled watcher failure"))
    registration.callback("rename", markerRelative)
    return result
  })
  restores.push(() => writeMock.mock.restore())
  syncBuiltinESMExports()
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
  return { root, stateHome, requests, cleanups, markerWrites }
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
    start: async (semantic) => {
      const desk = await startInProcess({
        argv: ["--root", fixture.root],
        env: {},
        readinessPolicy: { semantic },
        runtimeImporter: async () => ({
          async connectOrStartController(options) {
            const controller = await connectOrStartController({
              ...options, stateHome: fixture.stateHome, ephemeral: true, controllerLauncher: startControllerRuntime,
            })
            controllers.push(controller)
            return controller
          },
          beginBackgroundConvergence(admission) {
            convergence = beginBackgroundConvergence(admission)
            return convergence
          },
        }),
      }, { connect: false })
      fixture.cleanups.push(() => desk.close())
      const snapshot = await desk.settled()
      if (snapshot.state === "ready") starts.push(statusContextOf(desk))
      return snapshot
    },
  }
}

for (const semantic of ["background", "required"]) {
  for (const variable of ["DESK_EMBED_MODEL", "OLLAMA_EMBED_MODEL"]) {
    for (const existing of [false, true]) {
      test(`${semantic} ${variable} override degrades semantic search only (${existing ? "an older custom-model controller" : "no controller yet"})`, async (t) => {
        const context = fixture(t, { [variable]: CUSTOM_MODEL })
        let convergenceCalls = 0
        if (existing) {
          // A controller an older Desk admitted with the custom model in its contract.
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
        const ordinary = runtime(context)
        const snapshot = await ordinary.start(semantic)
        await ordinary.converged()
        assert.equal(convergenceCalls, 0)
        assert.ok(context.requests.every(({ model }) => model === ACTIVE_EMBEDDING_SPEC.model), "the override is never used to embed")
        if (existing) {
          // This session's pinned contract cannot share the custom-model controller: lexical reads and writes stay, semantic waits.
          assert.equal(snapshot.state, "degraded:controller_semantic_mismatch")
          assert.equal(ordinary.controllers.length, 0)
          return
        }
        assert.equal(snapshot.state, semantic === "required" ? "degraded:embedding_override" : "ready")
        const controller = ordinary.controllers[0]
        assert.deepEqual(controller.identity.semantic_contract.embedding_spec, ACTIVE_EMBEDDING_SPEC, "the controller keeps the pinned contract")
        assert.equal(controller.embeddingOverride.code, "embedding_override")
        assert.equal(controller.embeddingOverride.model, CUSTOM_MODEL)
        assert.match(controller.embeddingOverride.fix, /DESK_EMBED_MODEL.*OLLAMA_EMBED_MODEL/u)
        if (semantic === "background") assert.ok(existsSync(path.join(context.root, ".state")), "convergence indexed with the pinned model")
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
    test(`${semantic} ${label} uses the active model for ordinary index and query embedding with controlled watcher evidence`, async (t) => {
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
      assert.equal(result.search_mode, "hybrid")
      assert.equal(result.semantic_unavailable, false)
      assert.equal(context.markerWrites.length, 2, "both before/after read fences retain actual marker writes")
      assert.ok(result.results.some(({ path: docPath }) => docPath === "task.md"))
      assert.ok(context.requests.length > 0)
      assert.ok(context.requests.every(({ model }) => model === ACTIVE_EMBEDDING_SPEC.model))
      const db = openDb(context.root)
      try {
        const specs = db.prepare(
          "SELECT DISTINCT c.embedding_spec_id, s.model FROM chunks c JOIN embedding_specs s ON s.id = c.embedding_spec_id JOIN text_vectors v ON v.text_hash = c.text_hash AND v.vector_space = ?",
        ).all(ACTIVE_VECTOR_SPACE)
        assert.deepEqual(specs, [
          { embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id, model: ACTIVE_EMBEDDING_SPEC.model },
        ])
      } finally {
        closeDb(db)
      }
    })
  }
}

for (const [uncertainFence, reason] of [[1, "watcher_failed"], [2, "readiness_changed_during_read"]]) {
  test(`controlled watcher error at query fence ${uncertainFence} refuses unproven hybrid output`, async (t) => {
    const context = fixture(t, {}, { uncertainFence })
    const ordinary = runtime(context)
    await ordinary.start("required")
    await ordinary.converged()
    const controller = ordinary.controllers[0]
    assert.equal((await controller.barrier({ capability: "semantic" })).current, true)
    context.requests.splice(0)
    const response = await callTool({
      deskRoot: context.root, name: "desk_search",
      input: { query: "semantic safety" }, statusContext: ordinary.starts[0],
    })
    assert.notEqual(response.isError, true)
    const result = JSON.parse(response.content[0].text)
    assert.equal(result.search_mode, "lexical")
    assert.equal(result.semantic_unavailable, true)
    assert.equal(result.readiness_diagnostic.reason, reason)
    assert.equal(context.markerWrites.length, uncertainFence)
    assert.ok(result.results.some(({ path: docPath }) => docPath === "task.md"))
    if (uncertainFence === 1) {
      assert.equal(context.requests.some(({ prompt }) => prompt === "semantic safety"), false)
    } else {
      assert.ok(context.requests.some(({ prompt }) => prompt === "semantic safety"),
        "indexed evaluation occurred but its unproven post-read result was refused")
    }
  })
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
      } else if (name === "desk_thread") {
        assert.equal(payload.start.path, "task.md")
        assert.ok(Array.isArray(payload.chain))
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
