import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { createQueryRouter } from "../../src/readiness/query-router.js"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { indexedRecall, indexedSearch, indexedSimilar, indexedTimeline } from "../../src/tools/search.js"
import { indexedThread } from "../../src/tools/thread.js"
import { directLexicalSearch } from "../../src/readiness/direct-lexical.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { getSemanticCoverage } from "../../src/server-helpers.js"
import { mkTempDeskRoot, writeFile, makeEmbedFetch } from "../tools/_search_helpers.js"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { promises as fs } from "node:fs"
import { mkdirSync } from "node:fs"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { createHash } from "node:crypto"
import { configureRuntimeArtifacts } from "../../src/server-helpers.js"
import { desk_status } from "../../src/tools/status.js"
import { callTool } from "../../src/server.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, {
  hold = null,
  certain = true,
  pluginRoot,
  documentPath = "track/work/task.md",
  semanticCurrent = null,
  mutateDuringSemanticRead = false,
} = {}) {
  const tempRoot = await mkTempDeskRoot()
  const deskRoot = await fs.realpath(tempRoot)
  await writeFile(deskRoot, documentPath, "canonical quartz")
  const stateHome = path.join(deskRoot, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  let runs = 0
  const options = {
    root: deskRoot, stateHome, ephemeral: true,
    watcher: { fence: async () => ({ certain, ...(certain ? {} : { reason: "overflow" }) }) },
    handlers: { async beginConvergence({ eventCursor }) {
      runs++
      if (hold) await hold.promise
      const summary = await rebuildIndex(deskRoot, {
        eventCursor,
        tombstones: { pluginRoot },
        ...(semanticCurrent === null ? { skipEmbed: true } : { embed: { fetch: makeEmbedFetch() } }),
      })
      if (semanticCurrent === null) return { summary }
      const db = new Database(path.join(deskRoot, ".state", "desk-index.sqlite"))
      try {
        sqliteVec.load(db)
        return {
          summary,
          semantic: {
            ...getSemanticCoverage(db),
            provenance_current: semanticCurrent,
            query_embedding: semanticCurrent
              ? { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } }
              : {
                  available: false,
                  diagnostic: {
                    model: ACTIVE_EMBEDDING_SPEC.model,
                    reason: "semantic_unavailable",
                    message: "semantic convergence is not current for the active generation",
                  },
                },
          },
        }
      } finally {
        db.close()
      }
    } },
    ...(semanticCurrent === null ? {} : {
      semanticContract: { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC },
    }),
  }
  const controller = await connectOrStartController(options)
  t.after(async () => { hold?.resolve(); await controller.close() })
  const used = []
  const router = createQueryRouter({
    controller,
    indexedBackend: async (request) => {
      used.push("indexed")
      return indexedSearch({ deskRoot, db: request.db, input: request, opts: { lexicalOnly: true } })
    },
    directBackend: async (request) => {
      used.push("direct")
      return directLexicalSearch(request)
    },
    semanticBackend: async (request) => {
      used.push("semantic")
      const result = request.kind === "similar"
        ? await indexedSimilar({ deskRoot, db: request.db, input: request, opts: request.opts })
        : await indexedRecall({ deskRoot, db: request.db, input: request, opts: request.opts })
      if (mutateDuringSemanticRead) {
        await writeFile(deskRoot, documentPath, "canonical rollout replacement")
        await controller.recordChange({ path: documentPath })
      }
      return result
    },
    semanticDeadlineMs: 5,
  })
  return { deskRoot, controller, router, used, options, runs: () => runs }
}

test("current certain generation uses the indexed backend", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
  assert.equal(result.results[0].snippet, "canonical quartz")
  assert.deepEqual(f.used, ["indexed"])
})

test("pending reconciliation returns canonical files without awaiting the indexer", async (t) => {
  const hold = deferred()
  const f = await fixture(t, { hold })
  const work = f.controller.beginConvergence()
  try {
    const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
    assert.equal(result.results[0].snippet, "canonical quartz")
    assert.deepEqual(f.used, ["direct"])
  } finally { hold.resolve(); await work }
})

test("watcher uncertainty never reaches an indexed backend", async (t) => {
  const f = await fixture(t, { certain: false })
  await f.controller.beginConvergence()
  await writeFile(f.deskRoot, "track/work/task.md", "fresh replacement")
  const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "replacement" })
  assert.equal(result.results[0].snippet, "fresh replacement")
  assert.deepEqual(f.used, ["direct"])
})

test("short barrier completion uses the index once generation coverage is proven", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const barrier = f.controller.barrier
  let completed = false
  f.controller.barrier = async (request) => {
    if (!completed) {
      completed = true
      await f.controller.beginConvergence()
    }
    return barrier(request)
  }
  const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
  assert.equal(result.results.length, 1)
  assert.deepEqual(f.used, ["indexed"])
})

test("caller cancellation propagates while a barrier is pending and never calls a backend", async () => {
  const entered = deferred()
  const hold = deferred()
  const abort = new AbortController()
  const router = createQueryRouter({
    controller: {
      fenceEvents: async () => ({ certain: true, cursor: { journal_id: "journal", sequence: 0 } }),
      barrier: async () => { entered.resolve(); return hold.promise },
    },
    indexedBackend: () => assert.fail("cancelled indexed request"),
    directBackend: () => assert.fail("cancelled direct request"),
  })
  const result = router.lexical({ signal: abort.signal })
  await entered.promise
  abort.abort(new Error("caller cancelled"))
  await assert.rejects(result, /caller cancelled/)
  hold.resolve({ current: false })
})

test("lexical request defaults to an empty request object", async () => {
  const router = createQueryRouter({
    directBackend: async () => ({ results: [{ snippet: "default lexical" }] }),
  })
  const result = await router.lexical()
  assert.equal(result.results[0].snippet, "default lexical")
  assert.equal(result.readiness_diagnostic.reason, "controller_unavailable")
})

test("controller restart refuses a previously committed but unproven generation", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  await f.controller.close()
  await writeFile(f.deskRoot, "track/work/task.md", "afterrestart quartz")
  const restarted = await connectOrStartController(f.options)
  t.after(() => restarted.close())
  const router = createQueryRouter({
    controller: restarted,
    indexedBackend: () => assert.fail("stale generation was trusted after restart"),
    directBackend: directLexicalSearch,
  })
  assert.equal((await router.lexical({ deskRoot: f.deskRoot, query: "quartz" })).results[0].snippet, "afterrestart quartz")
})

test("semantic request starts or reuses convergence and executes one proven semantic snapshot", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const result = await f.router.semantic({
    deskRoot: f.deskRoot,
    kind: "recall",
    topic: "quartz",
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.results[0].path, "track/work/task.md")
  assert.deepEqual(f.used, ["semantic"])
})

test("semantic request never executes against an unproven generation", async (t) => {
  const f = await fixture(t, { semanticCurrent: false })
  const result = await f.router.semantic({
    deskRoot: f.deskRoot,
    kind: "recall",
    topic: "quartz",
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.code, "required_capability_unavailable")
  assert.deepEqual(f.used, [])
})

test("semantic result is discarded when readiness changes during evaluation", async (t) => {
  const f = await fixture(t, { semanticCurrent: true, mutateDuringSemanticRead: true })
  const result = await f.router.semantic({
    deskRoot: f.deskRoot,
    kind: "similar",
    path: "track/work/task.md",
  })
  assert.equal(result.diagnostic.reason, "readiness_changed_during_read")
})

test("semantic request without a controller returns the alpha semantic scope refusal", async () => {
  const router = createQueryRouter({
    semanticBackend: () => assert.fail("semantic backend requires controller proof"),
  })
  const result = await router.semantic({ kind: "recall", topic: "quartz" })
  assert.equal(result.status, "error")
  assert.equal(result.code, "required_capability_unavailable")
  assert.equal(result.capability, "semantic")
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.match(result.diagnostic.message, /not current/u)
})

test("semantic request defaults to an invalid semantic request", async () => {
  const router = createQueryRouter({
    semanticBackend: () => assert.fail("invalid semantic request cannot call backend"),
  })
  const result = await router.semantic()
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.reason, "invalid_request")
})

test("semantic request with no positive deadline uses the waited barrier result", async () => {
  let convergence = 0
  const router = createQueryRouter({
    semanticDeadlineMs: 0,
    controller: {
      barrier: async (request) => request?.wait
        ? { current: false, reason: "semantic_unavailable", message: "semantic remained unavailable" }
        : { current: false },
      beginConvergence: async () => { convergence++; return { accepted: true } },
    },
    semanticBackend: () => assert.fail("unavailable semantic proof cannot call backend"),
  })
  const result = await router.semantic({ kind: "similar", path: "track/work/task.md" })
  assert.equal(convergence, 1)
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "semantic remained unavailable")
})

test("semantic barrier exceptions become semantic capability diagnostics", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      barrier: async () => { throw Object.assign(new Error("query embedding probe failed"), { code: "query_embedding_failed" }) },
      beginConvergence: () => assert.fail("barrier exceptions are not convergence requests"),
    },
    semanticBackend: () => assert.fail("unavailable semantic proof cannot call backend"),
  })
  const result = await router.semantic({ deskRoot: root, kind: "recall", topic: "quartz" })
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.reason, "query_embedding_failed")
  assert.equal(result.diagnostic.message, "query embedding probe failed")
})

test("semantic barrier exceptions without codes use the semantic unavailable diagnostic", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      barrier: async () => { throw new Error("semantic probe threw without code") },
      beginConvergence: () => assert.fail("barrier exceptions are not convergence requests"),
    },
    semanticBackend: () => assert.fail("unavailable semantic proof cannot call backend"),
  })
  const result = await router.semantic({ deskRoot: root, kind: "recall", topic: "quartz" })
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "semantic probe threw without code")
})

test("semantic barrier string failures use semantic-unavailable string diagnostics", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      barrier: async () => { throw "semantic string failure" },
      beginConvergence: () => assert.fail("barrier exceptions are not convergence requests"),
    },
    semanticBackend: () => assert.fail("unavailable semantic proof cannot call backend"),
  })
  const result = await router.semantic({ deskRoot: root, kind: "recall", topic: "quartz" })
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "semantic string failure")
})

test("semantic proof without a durable snapshot returns an embedding identity diagnostic", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      barrier: async () => ({ current: true }),
      fenceEvents: async () => ({ certain: true, cursor: { journal_id: "j", sequence: 1 } }),
      status: async () => ({
        freshness: { certain: true, cursor: { journal_id: "j", sequence: 1 } },
        convergence: { semantic: { query_embedding: { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } } } },
      }),
    },
    semanticBackend: () => assert.fail("unproven semantic snapshot cannot call backend"),
  })
  const result = await router.semantic({ deskRoot: root, kind: "similar", path: "track/work/task.md" })
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "The active embedding specification does not match the proven generation.")
})

test("semantic proof rejects snapshots with missing vectors", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  await f.controller.beginConvergence()
  const db = new Database(path.join(f.deskRoot, ".state", "desk-index.sqlite"))
  try {
    sqliteVec.load(db)
    db.prepare("DELETE FROM chunk_vecs").run()
  } finally { db.close() }
  const result = await f.router.semantic({
    deskRoot: f.deskRoot,
    kind: "recall",
    topic: "quartz",
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.message, "Semantic vectors are incomplete for the proven generation.")
})

test("semantic proof rejects unavailable query embedding diagnostics", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const originalStatus = f.controller.status
  f.controller.status = async () => {
    const status = await originalStatus()
    return {
      ...status,
      convergence: {
        ...status.convergence,
        semantic: {
          ...status.convergence.semantic,
          query_embedding: { available: false, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } },
        },
      },
    }
  }
  const result = await f.router.semantic({
    deskRoot: f.deskRoot,
    kind: "similar",
    path: "track/work/task.md",
  })
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.message, "Query embedding is not available for the active semantic generation.")
})

test("lexical search records a semantic deadline while preserving direct fallback", async () => {
  let semanticWaits = 0
  const router = createQueryRouter({
    semanticDeadlineMs: 1,
    controller: {
      identity: { semantic_contract: { mode: "background" } },
      barrier: async (request) => {
        if (request.capability === "lexical") return { current: true }
        if (request.wait) {
          semanticWaits++
          return new Promise((resolve) => setTimeout(() => resolve({ current: false }), 50))
        }
        return { current: false }
      },
      beginConvergence: async () => ({ accepted: true }),
      fenceEvents: async () => ({ certain: false, reason: "overflow" }),
      status: async () => ({ freshness: { certain: false, reason: "overflow" }, convergence: {} }),
    },
    indexedBackend: () => assert.fail("unproven lexical proof cannot call indexed backend"),
    directBackend: async () => ({ results: [{ snippet: "fallback quartz" }] }),
  })
  const result = await router.lexical({ kind: "lexical", query: "quartz" })
  assert.equal(semanticWaits, 1)
  assert.equal(result.results[0].snippet, "fallback quartz")
  assert.equal(result.readiness_diagnostic.reason, "overflow")
})

test("lexical service proof records semantic barrier probe failures as unavailable", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      identity: { semantic_contract: { mode: "background" } },
      barrier: async (request) => {
        if (request.capability === "lexical") return { current: true }
        throw Object.assign(new Error("semantic probe failed"), { code: "semantic_probe_failed" })
      },
      fenceEvents: async () => ({ certain: false, reason: "overflow" }),
      status: async () => ({ freshness: { certain: false, reason: "overflow" }, convergence: {} }),
    },
    indexedBackend: () => assert.fail("unproven lexical proof cannot call indexed backend"),
    directBackend: async () => ({ results: [{ snippet: "fallback" }] }),
  })
  const result = await router.lexical({ deskRoot: root, kind: "lexical", query: "quartz" })
  assert.equal(result.results[0].snippet, "fallback")
  assert.equal(result.readiness_diagnostic.reason, "overflow")
})

test("lexical service proof records string semantic probe failures as unavailable", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      identity: { semantic_contract: { mode: "background" } },
      barrier: async (request) => {
        if (request.capability === "lexical") return { current: true }
        throw "semantic string probe"
      },
      fenceEvents: async () => ({ certain: false, reason: "overflow" }),
      status: async () => ({ freshness: { certain: false, reason: "overflow" }, convergence: {} }),
    },
    indexedBackend: () => assert.fail("unproven lexical proof cannot call indexed backend"),
    directBackend: async () => ({ results: [{ snippet: "fallback" }] }),
  })
  const result = await router.lexical({ deskRoot: root, kind: "lexical", query: "quartz" })
  assert.equal(result.results[0].snippet, "fallback")
  assert.equal(result.readiness_diagnostic.reason, "overflow")
})

test("lexical semantic preflight propagates non-deadline barrier failures to direct fallback", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      identity: { semantic_contract: { mode: "background" } },
      generationPolicyIdentity: {},
      barrier: async (request) => {
        if (request.capability === "lexical") return { current: true }
        throw Object.assign(new Error("semantic preflight rejected"), { code: "semantic_preflight_rejected" })
      },
      fenceEvents: async () => ({ certain: false, reason: "overflow" }),
      status: async () => ({ freshness: { certain: false, reason: "overflow" }, convergence: {} }),
      beginConvergence: () => assert.fail("non-deadline semantic preflight failure is not retried"),
    },
    indexedBackend: () => assert.fail("failed semantic preflight cannot call indexed backend"),
    directBackend: async () => ({ results: [{ snippet: "direct fallback" }] }),
  })
  const result = await router.lexical({ deskRoot: root, kind: "lexical", query: "quartz" })
  assert.equal(result.results[0].snippet, "direct fallback")
  assert.equal(result.readiness_diagnostic.reason, "overflow")
})

test("lexical readiness errors without a code become readiness-unavailable diagnostics", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      barrier: async () => { throw new Error("barrier offline") },
    },
    directBackend: async () => ({ results: [{ snippet: "fallback" }] }),
  })
  const result = await router.lexical({ deskRoot: root, query: "quartz" })
  assert.equal(result.results[0].snippet, "fallback")
  assert.equal(result.readiness_diagnostic.reason, "readiness_unavailable")
  assert.equal(result.readiness_diagnostic.message, "barrier offline")
})

test("lexical readiness string errors become readiness-unavailable diagnostics", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      barrier: async () => { throw "lexical string barrier" },
    },
    directBackend: async () => ({ results: [{ snippet: "fallback" }] }),
  })
  const result = await router.lexical({ deskRoot: root, query: "quartz" })
  assert.equal(result.readiness_diagnostic.reason, "readiness_unavailable")
  assert.equal(result.readiness_diagnostic.message, "lexical string barrier")
})

test("lexical recheck errors without codes become readiness-unavailable diagnostics", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const originalStatus = f.controller.status
  let calls = 0
  f.controller.status = async () => {
    calls++
    if (calls > 1) throw new Error("post-read proof unavailable")
    return originalStatus()
  }
  const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
  assert.equal(result.results[0].snippet, "canonical quartz")
  assert.equal(result.readiness_diagnostic.reason, "readiness_unavailable")
  assert.equal(result.readiness_diagnostic.message, "post-read proof unavailable")
  assert.deepEqual(f.used, ["indexed", "direct"])
})

test("lexical recheck string failures become readiness-unavailable diagnostics", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const originalStatus = f.controller.status
  let calls = 0
  f.controller.status = async () => {
    calls++
    if (calls > 1) throw "post-read string failure"
    return originalStatus()
  }
  const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
  assert.equal(result.readiness_diagnostic.reason, "readiness_unavailable")
  assert.equal(result.readiness_diagnostic.message, "post-read string failure")
})

test("lexical readiness preserves artifact tombstone failures before fallback", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      barrier: async () => { throw Object.assign(new Error("invalid tombstone ledger"), { code: "artifact_tombstone_ledger_invalid" }) },
    },
    directBackend: () => assert.fail("artifact policy failures must not fall back"),
  })
  await assert.rejects(
    () => router.lexical({ deskRoot: root, query: "quartz" }),
    { code: "artifact_tombstone_ledger_invalid" },
  )
})

test("lexical recheck preserves artifact tombstone failures after indexed evaluation", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const originalStatus = f.controller.status
  let calls = 0
  f.controller.status = async () => {
    calls++
    if (calls > 1) {
      throw Object.assign(new Error("invalid tombstone ledger"), { code: "artifact_tombstone_ledger_invalid" })
    }
    return originalStatus()
  }
  await assert.rejects(
    () => f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" }),
    { code: "artifact_tombstone_ledger_invalid" },
  )
  assert.deepEqual(f.used, ["indexed"])
})

test("semantic deadline failures are returned as semantic deadline diagnostics", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    semanticDeadlineMs: 1,
    controller: {
      barrier: async (request) => request?.wait
        ? new Promise((resolve) => setTimeout(() => resolve({ current: false }), 50))
        : { current: false },
      beginConvergence: async () => ({ accepted: true }),
    },
    semanticBackend: () => assert.fail("deadline cannot call semantic backend"),
  })
  const result = await router.semantic({ deskRoot: root, kind: "recall", topic: "quartz" })
  assert.equal(result.diagnostic.reason, "semantic_deadline")
  assert.match(result.diagnostic.message, /did not become current/u)
})

test("semantic indexed evaluation preserves artifact tombstone failures", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const router = createQueryRouter({
    controller: f.controller,
    semanticBackend: async () => { throw Object.assign(new Error("invalid tombstone ledger"), { code: "artifact_tombstone_ledger_invalid" }) },
  })
  await assert.rejects(
    () => router.semantic({ deskRoot: f.deskRoot, kind: "recall", topic: "quartz", opts: { embed: { fetch: makeEmbedFetch() } } }),
    { code: "artifact_tombstone_ledger_invalid" },
  )
})

test("semantic backend unavailability is converted to the typed capability diagnostic", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const router = createQueryRouter({
    controller: f.controller,
    semanticDeadlineMs: 5,
    semanticBackend: async () => ({ error: "semantic_unavailable", note: "backend vector read unavailable" }),
  })
  const result = await router.semantic({
    deskRoot: f.deskRoot,
    kind: "recall",
    topic: "quartz",
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.status, "error")
  assert.equal(result.code, "required_capability_unavailable")
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "backend vector read unavailable")
})

test("semantic backend unavailability without a note uses the standard semantic diagnostic", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const router = createQueryRouter({
    controller: f.controller,
    semanticDeadlineMs: 5,
    semanticBackend: async () => ({ error: "semantic_unavailable" }),
  })
  const result = await router.semantic({
    deskRoot: f.deskRoot,
    kind: "recall",
    topic: "quartz",
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "Semantic serving is unavailable for this request.")
})

test("semantic backend exceptions are converted without leaking partial results", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const router = createQueryRouter({
    controller: f.controller,
    semanticDeadlineMs: 5,
    semanticBackend: async () => { throw new Error("backend exploded") },
  })
  const result = await router.semantic({
    deskRoot: f.deskRoot,
    kind: "similar",
    path: "track/work/task.md",
  })
  assert.equal(result.status, "error")
  assert.equal(result.code, "required_capability_unavailable")
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "backend exploded")
})

test("semantic backend exceptions without codes use semantic-unavailable diagnostics", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const router = createQueryRouter({
    controller: f.controller,
    semanticDeadlineMs: 5,
    semanticBackend: async () => { throw new Error("plain semantic failure") },
  })
  const result = await router.semantic({
    deskRoot: f.deskRoot,
    kind: "recall",
    topic: "quartz",
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.status, "error")
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "plain semantic failure")
})

test("semantic backend string failures use semantic-unavailable string diagnostics", async (t) => {
  const f = await fixture(t, { semanticCurrent: true })
  const router = createQueryRouter({
    controller: f.controller,
    semanticDeadlineMs: 5,
    semanticBackend: async () => { throw "semantic string backend failure" },
  })
  const result = await router.semantic({
    deskRoot: f.deskRoot,
    kind: "recall",
    topic: "quartz",
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.diagnostic.reason, "semantic_unavailable")
  assert.equal(result.diagnostic.message, "semantic string backend failure")
})

for (const invalidKind of [undefined, null, "", "timeline", "thread"]) {
  test(`semantic request rejects unsupported kind ${JSON.stringify(invalidKind)}`, async (t) => {
    const f = await fixture(t, { semanticCurrent: true })
    const result = await f.router.semantic({
      deskRoot: f.deskRoot,
      kind: invalidKind,
      topic: "quartz",
      path: "track/work/task.md",
      opts: { embed: { fetch: makeEmbedFetch() } },
    })
    assert.equal(result.status, "error")
    assert.equal(result.code, "required_capability_unavailable")
    assert.equal(result.capability, "semantic")
    assert.equal(result.diagnostic.reason, "invalid_request")
    assert.match(result.diagnostic.message, /"recall" or "similar"/u)
    assert.deepEqual(f.used, [])
  })
}

test("hybrid search falls back to proven lexical ranking while semantic convergence is unavailable", async (t) => {
  const f = await fixture(t, { semanticCurrent: false })
  const result = await f.router.lexical({ deskRoot: f.deskRoot, kind: "lexical", query: "quartz" })
  assert.equal(result.search_mode, "lexical")
  assert.equal(result.semantic_unavailable, true)
})

test("snapshot reports indexed serving after a proven lexical read without an owner token", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const originalStatus = f.controller.status
  f.controller.status = async () => {
    const status = await originalStatus()
    return { ...status, owner: undefined }
  }
  await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
  const snapshot = await f.router.snapshot({ deskRoot: f.deskRoot })
  assert.equal(snapshot.lexical.serving_path, "indexed")
  assert.equal(snapshot.lexical.certain, true)
})

test("snapshot reports direct serving when the current generation is not certain", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      status: async () => ({ state: "CONTROL_READY", freshness: { certain: false }, convergence: {} }),
    },
    directBackend: async () => ({ results: [] }),
  })
  const snapshot = await router.snapshot({ deskRoot: root })
  assert.equal(snapshot.lexical.serving_path, "direct")
  assert.equal(snapshot.lexical.certain, false)
})

test("snapshot reports direct serving for an indexed generation that is no longer certain", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const originalStatus = f.controller.status
  f.controller.status = async () => {
    const status = await originalStatus()
    return { ...status, freshness: { ...status.freshness, certain: false } }
  }
  const snapshot = await f.router.snapshot({ deskRoot: f.deskRoot })
  assert.equal(snapshot.state, "LEXICAL_READY")
  assert.equal(snapshot.lexical.serving_path, "direct")
  assert.equal(snapshot.lexical.certain, false)
})

test("snapshot reports blocked serving for an uncertain generation without direct fallback", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const originalStatus = f.controller.status
  f.controller.status = async () => {
    const status = await originalStatus()
    return { ...status, freshness: { ...status.freshness, certain: false } }
  }
  const router = createQueryRouter({ controller: f.controller })
  const snapshot = await router.snapshot({ deskRoot: f.deskRoot })
  assert.equal(snapshot.state, "LEXICAL_READY")
  assert.equal(snapshot.lexical.serving_path, "blocked")
  assert.equal(snapshot.lexical.certain, false)
})

test("snapshot readiness failures without codes return unavailable diagnostics", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      status: async () => { throw new Error("snapshot proof failed") },
    },
    directBackend: async () => ({ results: [] }),
  })
  const snapshot = await router.snapshot({ deskRoot: root })
  assert.equal(snapshot.state, "unavailable")
  assert.equal(snapshot.lexical.serving_path, "direct")
  assert.equal(snapshot.diagnostic.reason, "readiness_unavailable")
  assert.equal(snapshot.diagnostic.message, "snapshot proof failed")
  assert.equal(snapshot.semantic.diagnostic.reason, "readiness_unavailable")
})

test("snapshot readiness string failures return blocked unavailable diagnostics", async () => {
  const root = await mkTempDeskRoot()
  const router = createQueryRouter({
    controller: {
      status: async () => { throw "snapshot string failure" },
    },
  })
  const snapshot = await router.snapshot({ deskRoot: root })
  assert.equal(snapshot.lexical.serving_path, "blocked")
  assert.equal(snapshot.diagnostic.reason, "readiness_unavailable")
  assert.equal(snapshot.diagnostic.message, "snapshot string failure")
  assert.equal(snapshot.semantic.diagnostic.message, "snapshot string failure")
})

test("a covered old cursor cannot authorize an index read after a canonical mutation", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const original = f.controller.barrier
  f.controller.barrier = async (request) => {
    const result = await original(request)
    await writeFile(f.deskRoot, "track/work/task.md", "quartz newcursor")
    await f.controller.recordChange({ path: path.join("track", "work", "task.md") })
    return result
  }
  const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
  assert.equal(result.results[0].snippet, "quartz newcursor")
  assert.deepEqual(f.used, ["direct"])
})

test("snapshot observes status without fencing, discovering or starting convergence", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const before = f.runs()
  f.controller.fenceEvents = () => assert.fail("snapshot cannot fence")
  const snapshot = await f.router.snapshot({ deskRoot: f.deskRoot })
  assert.equal(snapshot.lexical.generation, 1)
  assert.equal(snapshot.lexical.event_cursor.sequence, 0)
  assert.equal(snapshot.lexical.serving_path, "direct")
  assert.equal(f.runs(), before)
})

test("pending startup dispatches direct search before any event-fence work", async () => {
  let fences = 0
  const router = createQueryRouter({
    controller: {
      barrier: async () => ({ current: false, state: "LEXICAL_CONVERGING" }),
      fenceEvents: async () => { fences++; return { certain: false } },
      status: async () => ({ freshness: { certain: false } }),
    },
    directBackend: async () => ({ results: [{ snippet: "canonical now" }] }),
    indexedBackend: () => assert.fail("pending cannot read index"),
  })
  assert.equal((await router.lexical({})).results[0].snippet, "canonical now")
  assert.equal(fences, 0, "a known-pending request must not wait for a journal open/flush")
})

test("cancellation before queued controller dispatch starts no readiness operation", async () => {
  let operations = 0
  const abort = new AbortController()
  const router = createQueryRouter({
    controller: {
      barrier: async () => { operations++; return { current: false } },
      fenceEvents: async () => { operations++; return { certain: false } },
    },
    directBackend: () => assert.fail("cancelled direct"),
  })
  const result = router.lexical({ signal: abort.signal })
  abort.abort(new Error("cancel queued dispatch"))
  await assert.rejects(result, /cancel queued dispatch/)
  assert.equal(operations, 0)
})

test("snapshot without a controller and generation is not_checked, not an observation failure", async () => {
  const snapshot = await createQueryRouter({ directBackend: directLexicalSearch }).snapshot()
  assert.equal(snapshot.state, "not_checked")
  assert.equal(snapshot.diagnostic, undefined)
  assert.equal(snapshot.lexical.pending_changes, null)
})

test("snapshot without a direct backend reports blocked serving when readiness is unavailable", async () => {
  const router = createQueryRouter({
    controller: {
      status: async () => { throw Object.assign(new Error("status offline"), { code: "status_failed" }) },
    },
  })
  const snapshot = await router.snapshot()
  assert.equal(snapshot.state, "unavailable")
  assert.equal(snapshot.lexical.serving_path, "blocked")
  assert.equal(snapshot.semantic.diagnostic.reason, "status_failed")
})

test("reindex without a controller and pending controller convergence fail closed", async () => {
  const withoutController = createQueryRouter()
  assert.equal((await withoutController.reindex()).diagnostic.reason, "controller_unavailable")
  const pending = createQueryRouter({
    controller: {
      beginConvergence: async () => ({ reused: false }),
      barrier: async () => ({ current: false }),
    },
  })
  const result = await pending.reindex()
  assert.equal(result.status, "error")
  assert.equal(result.code, "required_capability_unavailable")
  assert.equal(result.diagnostic.reason, "reconciliation_pending")
})

async function policyFixture(t) {
  const pluginRoot = await mkTempDeskRoot()
  configureRuntimeArtifacts({ pluginRoot })
  t.after(() => configureRuntimeArtifacts())
  const f = await fixture(t, { pluginRoot, documentPath: "task.md" })
  await f.controller.beginConvergence()
  const request = { deskRoot: f.deskRoot, query: "quartz" }
  assert.equal((await f.router.lexical(request)).results[0].snippet, "canonical quartz")
  assert.deepEqual(f.used, ["indexed"])
  const status = () => desk_status({
    deskRoot: f.deskRoot, queryRouter: f.router, statusContext: { admission: { controller: f.controller } },
  })
  assert.equal((await status()).lexical.serving_path, "indexed")
  const ledgerPath = "artifacts/tombstones/tombstones.jsonl"
  const redact = () => writeFile(pluginRoot, ledgerPath, JSON.stringify({
    schema_version: 1, document_path: "task.md",
    document_hash: `sha256:${createHash("sha256").update("canonical quartz").digest("hex")}`,
    reason: "redacted", redacted_at: "2026-09-19T00:00:00Z",
    effective_from: "2026-09-19T00:00:00Z", artifact_rotation_id: "F1", actor: "fixture",
  }) + "\n")
  return { ...f, pluginRoot, ledgerPath, request, status, redact }
}

test("F1 external tombstone policy change invalidates indexed serving and observational status", async (t) => {
  const f = await policyFixture(t)
  await f.redact()
  assert.equal((await f.controller.barrier({ capability: "lexical" })).current, true)
  assert.equal((await f.status()).lexical.serving_path, "direct", "policy lives outside the watched Desk root")
  const result = await f.router.lexical(f.request)
  assert.deepEqual(result.results, [], "the now-redacted indexed content must never be returned")
  assert.equal(result.readiness_diagnostic.reason, "generation_identity_mismatch")
  assert.deepEqual(f.used, ["indexed", "direct"])
  assert.equal(f.runs(), 1, "observation and fallback cannot mutate the index")
})

test("F1 invalid current tombstone policy blocks queries and status instead of returning cached content", async (t) => {
  const f = await policyFixture(t)
  await writeFile(f.pluginRoot, f.ledgerPath, "{broken")
  const status = await f.status()
  assert.equal(status.lexical.serving_path, "blocked")
  assert.equal(status.lexical.certain, false)
  await assert.rejects(f.router.lexical(f.request), { code: "artifact_tombstone_ledger_invalid" })
  assert.deepEqual(f.used, ["indexed"])
  const response = await callTool({
    deskRoot: f.deskRoot, name: "desk_search", input: { query: "quartz" },
    statusContext: { admission: { controller: f.controller } },
  })
  assert.equal(response.isError, true)
  assert.doesNotMatch(response.content[0].text, /canonical quartz/)
})

test("F1 indexed proof checks every recorded generation identity, not only cursors", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const db = new Database(path.join(f.deskRoot, ".state", "desk-index.sqlite"))
  t.after(() => db.close())
  const original = db.prepare("SELECT * FROM lexical_generations WHERE id = 1").get()
  for (const [column, value] of [
    ["schema_version", 2], ["chunker_id", "other-chunker"], ["normalization_id", "other-normalization"],
    ["embedding_spec", JSON.stringify({ id: "other-spec" })],
    ["policy_identity", "other-policy"], ["tombstone_identity", "sha256:obsolete"],
  ]) {
    await t.test(column, async () => {
      db.prepare(`UPDATE lexical_generations SET ${column} = ? WHERE id = 1`).run(value)
      try {
        f.used.length = 0
        const result = await f.router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
        assert.equal(result.results[0].snippet, "canonical quartz")
        assert.deepEqual(f.used, ["direct"])
        assert.equal(result.readiness_diagnostic.reason, "generation_identity_mismatch")
      } finally {
        db.prepare(`UPDATE lexical_generations SET ${column} = ? WHERE id = 1`).run(original[column])
      }
    })
  }
})

test("F1 a policy change while indexed evaluation awaits suppresses the old indexed response", async (t) => {
  const f = await policyFixture(t)
  const router = createQueryRouter({
    controller: f.controller, directBackend: directLexicalSearch,
    indexedBackend: async (request) => {
      const result = await indexedSearch({
        deskRoot: f.deskRoot, db: request.db, input: f.request, opts: { lexicalOnly: true },
      })
      await f.redact()
      return result
    },
  })
  assert.deepEqual((await router.lexical(f.request)).results, [])
  assert.equal((await router.snapshot({ deskRoot: f.deskRoot })).lexical.serving_path, "direct")
})

for (const kind of ["lexical", "timeline", "thread"]) {
  test(`read consistency discards ${kind} indexed results after a mutation during evaluation`, async (t) => {
    const f = await fixture(t)
    await f.controller.beginConvergence()
    const entered = deferred()
    const release = deferred()
    t.after(() => release.resolve())
    let indexedResult
    const backend = kind === "thread" ? indexedThread : kind === "timeline" ? indexedTimeline : indexedSearch
    const router = createQueryRouter({
      controller: f.controller,
      directBackend: directLexicalSearch,
      indexedBackend: async (request) => {
        indexedResult = await backend({
          deskRoot: f.deskRoot, db: request.db, input: request, opts: { lexicalOnly: true },
        })
        entered.resolve()
        await release.promise
        return indexedResult
      },
    })
    const pending = router.lexical({
      deskRoot: f.deskRoot, kind, query: "quartz", start_path: path.join("track", "work", "task.md"),
    })
    await entered.promise
    try {
      await writeFile(f.deskRoot, "track/work/task.md", "replacement quartz")
      await f.controller.recordChange({ path: path.join("track", "work", "task.md") })
      await f.controller.barrier({ capability: "lexical", wait: true })
    } finally { release.resolve() }
    const result = await pending
    assert.notStrictEqual(result, indexedResult, "the response evaluated against the old snapshot must be discarded")
    if (kind === "thread") {
      assert.equal(result.code, "required_capability_unavailable")
      assert.equal(result.diagnostic.reason, "readiness_changed_during_read")
      assert.equal(result.chain, undefined)
    } else {
      assert.equal(result.results[0].snippet, "replacement quartz")
      assert.equal(result.readiness_diagnostic.reason, "readiness_changed_during_read")
    }
    assert.equal((await router.snapshot({ deskRoot: f.deskRoot })).lexical.serving_path, "direct")
  })
}

test("read consistency rechecks every indexed service proof component on a fresh snapshot", async (t) => {
  const changes = [
    ["generation", async (f) => {
      const { freshness } = await f.controller.status()
      await rebuildIndex(f.deskRoot, { skipEmbed: true, eventCursor: freshness.cursor })
    }],
    ["covered cursor", async (f, db) => {
      db.prepare("UPDATE meta SET value = ? WHERE key = 'covered_event_cursor'")
        .run(JSON.stringify({ journal_id: "different-journal", sequence: 0 }))
    }],
    ...[
      ["schema_version", 2], ["chunker_id", "other-chunker"], ["normalization_id", "other-normalization"],
      ["embedding_spec", "{}"], ["tombstone_identity", "sha256:changed"], ["policy_identity", "other-policy"],
    ].map(([column, value]) => [column, async (f, db) => {
      db.prepare(`UPDATE lexical_generations SET ${column} = ? WHERE id = 1`).run(value)
    }]),
    ["current policy", async (f) => { f.controller.generationPolicyIdentity = "changed-policy" }],
    ["fence certainty", async (f) => {
      const fence = f.controller.fenceEvents
      f.controller.fenceEvents = async (request) => ({ ...await fence(request), certain: false })
    }],
    ["barrier currency", async (f) => {
      const barrier = f.controller.barrier
      f.controller.barrier = async (request) => ({ ...await barrier(request), current: false })
    }],
    ["barrier certainty", async (f) => {
      const barrier = f.controller.barrier
      f.controller.barrier = async (request) => ({ ...await barrier(request), certain: false })
    }],
    ["observed certainty", async (f) => {
      const status = f.controller.status
      f.controller.status = async () => {
        const observed = await status()
        return { ...observed, freshness: { ...observed.freshness, certain: false } }
      }
    }],
    ["observed cursor", async (f) => {
      const status = f.controller.status
      f.controller.status = async () => {
        const observed = await status()
        return { ...observed, freshness: { ...observed.freshness, cursor: { journal_id: "new", sequence: 0 } } }
      }
    }],
    ["owner", async (f) => {
      const status = f.controller.status
      f.controller.status = async () => {
        const observed = await status()
        return { ...observed, owner: { ...observed.owner, token: "new-owner" } }
      }
    }],
    ["fence failure", async (f) => {
      f.controller.fenceEvents = async () => { throw Object.assign(new Error("fence unavailable"), { code: "fence_failed" }) }
    }],
  ]
  for (const [name, change] of changes) {
    await t.test(name, async (t) => {
      const f = await fixture(t)
      await f.controller.beginConvergence()
      const db = new Database(path.join(f.deskRoot, ".state", "desk-index.sqlite"))
      t.after(() => db.close())
      let indexedResult
      const router = createQueryRouter({
        controller: f.controller, directBackend: directLexicalSearch,
        indexedBackend: async (request) => {
          indexedResult = await indexedSearch({
            deskRoot: f.deskRoot, db: request.db, input: request, opts: { lexicalOnly: true },
          })
          await change(f, db)
          return indexedResult
        },
      })
      const result = await router.lexical({ deskRoot: f.deskRoot, query: "quartz" })
      assert.notStrictEqual(result, indexedResult, name)
      assert.equal(result.results[0].snippet, "canonical quartz")
      assert.ok(result.readiness_diagnostic, name)
      assert.equal((await router.snapshot({ deskRoot: f.deskRoot })).lexical.serving_path, "direct")
    })
  }
})

test("read consistency fails closed for a non-direct request if indexed proof changes", async (t) => {
  const f = await fixture(t)
  await f.controller.beginConvergence()
  const router = createQueryRouter({
    controller: f.controller,
    directBackend: () => assert.fail("this request has no direct equivalent"),
    indexedBackend: async () => {
      await f.controller.beginConvergence()
      return { stale: true }
    },
  })
  const result = await router.lexical({ deskRoot: f.deskRoot, kind: "graph" })
  assert.equal(result.code, "required_capability_unavailable")
  assert.equal(result.diagnostic.reason, "readiness_changed_during_read")
  assert.equal(result.stale, undefined)
})

// No runtimeImporter, controller, tool or transport injection: exercise the shipped
// entrypoint, runtime source mirror, named pipe and stdio MCP from two OS processes.
test("production MCP lexical smoke", { timeout: 180_000 }, async (t) => {
  const root = await mkTempDeskRoot()
  const home = path.join(root, "home")
  const deskRoot = path.join(root, "desk")
  const runtimeCache = path.join(root, "runtime-cache")
  await fs.mkdir(home)
  await fs.mkdir(deskRoot)
  await writeFile(deskRoot, "track/work/task.md", "startupquartz")
  const config = path.join(root, "activation.json")
  await fs.writeFile(config, JSON.stringify({
    schema_version: 1, desk: { root: deskRoot }, runtimeCacheDir: runtimeCache,
    desk_runtime: { semantic: "background" },
  }))
  let held = deferred()
  let entered = deferred()
  const embedding = createServer(async (request, response) => {
    request.resume()
    entered.resolve()
    await held.promise
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ embedding: Array(768).fill(0.1) }))
  })
  await new Promise((resolve) => embedding.listen(0, "127.0.0.1", resolve))
  const env = {
    ...process.env, USERPROFILE: home, HOME: home, XDG_CACHE_HOME: path.join(home, ".cache"),
    DESK_EMBED_ENDPOINT: `http://127.0.0.1:${embedding.address().port}`,
    DESK_EMBED_MODEL: "nomic-embed-text", OLLAMA_EMBED_MODEL: "nomic-embed-text",
    DESK_EMBED_TIMEOUT_MS: "120000",
  }
  const sessions = []
  let observer
  t.after(async () => {
    held.resolve()
    await observer?.close()
    for (const session of sessions) await session.close()
    embedding.closeAllConnections()
    await new Promise((resolve) => embedding.close(resolve))
  })
  async function launch() {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../../index.js", import.meta.url)),
      "--root", deskRoot, "--activation-config", config,
    ], { env, stdio: ["pipe", "pipe", "pipe"] })
    const pending = new Map()
    let nextId = 0, stderr = ""
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000) })
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    })
    const exit = new Promise((resolve) => child.once("close", (code) => {
      for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited ${code}: ${stderr}`))
      pending.clear()
      resolve(code)
    }))
    child.on("error", (error) => {
      for (const waiter of pending.values()) waiter.reject(error)
    })
    let closed = false
    const session = {
      pid: child.pid,
      request(method, params) {
        return new Promise((resolve, reject) => {
          const id = ++nextId
          pending.set(id, { resolve, reject })
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
        })
      },
      async call(name, args = {}) {
        const result = await session.request("tools/call", { name, arguments: args })
        assert.notEqual(result.isError, true, result.content?.[0]?.text)
        return JSON.parse(result.content[0].text)
      },
      async close() {
        if (closed) return
        closed = true
        child.stdin.end()
        const timer = setTimeout(() => child.kill(), 10_000)
        try { await exit } finally { clearTimeout(timer) }
        assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" })
      },
    }
    sessions.push(session)
    await session.request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "lexical-alpha-production-smoke", version: "1.0.0" },
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
    return session
  }
  const first = await launch()
  await t.test("immediate startup query returns canonical fixture during convergence", async () => {
    const result = await first.call("desk_search", { query: "startupquartz" })
    assert.equal(result.results[0].snippet, "startupquartz")
    assert.equal(result.search_mode, "lexical")
  })
  await entered.promise
  const second = await launch()
  await t.test("second process searches while the controller owns embedding work", async () => {
    const result = await second.call("desk_search", { query: "startupquartz" })
    assert.equal(result.results[0].snippet, "startupquartz")
    const status = await second.call("desk_status")
    assert.equal(status.lexical.serving_path, "direct")
    assert.equal(status.lexical.current_automatic_action, "reconciling")
    assert.ok(status.runtime.source_mirror_path.startsWith(runtimeCache))
  })
  await t.test("canonical MCP mutation is visible to the other process immediately", async () => {
    const written = await first.call("task_create", {
      track: "track", slug: "canonical-mutation", title: "Mutation", body: "mutationquartz",
    })
    assert.equal(written.status, "created")
    const result = await second.call("desk_search", { query: "mutationquartz" })
    assert.ok(result.results.some((r) => r.path === path.join("track", "canonical-mutation", "task.md")))
  })
  await t.test("same-mtime external write is visible to the next query", async () => {
    const file = path.join(deskRoot, "track", "work", "task.md")
    const before = await fs.stat(file)
    await fs.writeFile(file, "externlquartz")
    await fs.utimes(file, before.atime, before.mtime)
    const result = await second.call("desk_search", { query: "externlquartz" })
    assert.equal(result.results[0].snippet, "externlquartz")
  })
  const stateHome = path.join(home, ".cache", "ouroboros-skills", "desk", "readiness")
  const [id] = await fs.readdir(stateHome)
  const record = JSON.parse(await fs.readFile(path.join(stateHome, id, "owner.json"), "utf8"))
  observer = await connectOrStartController({
    root: deskRoot, stateHome,
    lexicalContract: record.identity.lexical_contract,
    semanticContract: record.identity.semantic_contract,
  })
  await t.test("watcher uncertainty uses direct files and never stale indexed text", async () => {
    await observer.markUncertain("smoke_overflow")
    await writeFile(deskRoot, "track/work/task.md", "uncertainquartz")
    const result = await first.call("desk_search", { query: "uncertainquartz" })
    assert.equal(result.results[0].snippet, "uncertainquartz")
    assert.ok(result.readiness_diagnostic)
    assert.equal((await first.call("desk_status")).lexical.serving_path, "direct")
  })
  held.resolve()
  await second.call("desk_reindex", { force: true })
  await t.test("concurrent startup/search leaves actual vectors and zero orphans", async () => {
    const db = new Database(path.join(deskRoot, ".state", "desk-index.sqlite"), { readonly: true })
    try {
      sqliteVec.load(db)
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n > 0)
      assert.equal(db.prepare(`SELECT COUNT(*) AS orphan_count FROM chunk_vecs v
        LEFT JOIN chunks c ON c.id = v.chunk_id WHERE c.id IS NULL`).get().orphan_count, 0, JSON.stringify({
          orphanIds: db.prepare("SELECT v.chunk_id FROM chunk_vecs v LEFT JOIN chunks c ON c.id = v.chunk_id WHERE c.id IS NULL").all(),
          chunks: db.prepare("SELECT c.id, d.path FROM chunks c JOIN docs d ON d.id = c.doc_id").all(),
          generations: db.prepare("SELECT id, documents FROM lexical_generations").all(),
        }))
    } finally { db.close() }
  })
  await t.test("status reports its serving path without changing controller or generation state", async () => {
    const before = await observer.status()
    const one = await first.call("desk_status")
    const two = await first.call("desk_status")
    const after = await observer.status()
    assert.deepEqual(two.lexical, one.lexical)
    assert.deepEqual(after, before)
    assert.equal(one.lexical.serving_path, "direct")
    assert.equal(one.lexical.certain, false)
    assert.ok(one.lexical.generation > 0)
  })
  await observer.close()
  await second.close()
  await first.close()
  await writeFile(deskRoot, "track/work/task.md", "restartquartz")
  held = deferred()
  entered = deferred()
  const restarted = await launch()
  await t.test("restart does not trust the old generation for its first query", async () => {
    const result = await restarted.call("desk_search", { query: "restartquartz" })
    assert.equal(result.results[0].snippet, "restartquartz")
    assert.ok(result.readiness_diagnostic)
    assert.equal((await restarted.call("desk_status")).lexical.serving_path, "direct")
  })
  held.resolve()
  await restarted.call("desk_reindex")
})
