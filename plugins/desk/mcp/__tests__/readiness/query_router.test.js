import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { createQueryRouter } from "../../src/readiness/query-router.js"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { indexedSearch } from "../../src/tools/search.js"
import { directLexicalSearch } from "../../src/readiness/direct-lexical.js"
import { mkTempDeskRoot, writeFile } from "../tools/_search_helpers.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, { hold = null, certain = true } = {}) {
  const deskRoot = await mkTempDeskRoot()
  await writeFile(deskRoot, "track/work/task.md", "canonical quartz")
  let runs = 0
  const options = {
    root: deskRoot, stateHome: path.join(deskRoot, ".state", "controller"), ephemeral: true,
    watcher: { fence: async () => ({ certain, ...(certain ? {} : { reason: "overflow" }) }) },
    handlers: { async beginConvergence({ eventCursor }) {
      runs++
      if (hold) await hold.promise
      return { summary: await rebuildIndex(deskRoot, { skipEmbed: true, eventCursor }) }
    } },
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
  f.controller.barrier = async (request) => {
    await f.controller.beginConvergence()
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

test("semantic requests return the exact alpha-scope error without convergence work", async () => {
  const router = createQueryRouter({
    controller: { beginConvergence: () => assert.fail("semantic scheduling is out of scope") },
    indexedBackend: () => assert.fail("semantic index"),
    directBackend: () => assert.fail("fake semantic fallback"),
  })
  assert.deepEqual(await router.semantic({ topic: "quartz" }), {
    status: "error", code: "required_capability_unavailable", capability: "semantic",
    diagnostic: { reason: "alpha_scope", message: "Semantic convergence is not qualified in this alpha." },
  })
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
