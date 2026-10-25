// Desk search, inside the MCP server process. The exact-word index lives in memory and is rebuilt (only what changed)
// when the desk changes; section vectors live in `.state/desk-vectors.sqlite` and are filled in the background, a small
// batch at a time. Every search answers at once: meaning-based recall adds exact-word matches for whatever is not
// embedded yet, and says so in one sentence.
import { watch as watchNative, realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import * as path from "node:path"
import { openDb, closeDb } from "../db/init.js"
import { rebuildIndex } from "../indexer/index.js"
import { createDiscoverCache, useForNextDiscover } from "../indexer/discover.js"
import { resolveEnsureIndexOptions } from "../server-helpers.js"
import { indexedSearch, indexedTimeline, makeSnippet, passesScope } from "../tools/search.js"
import { indexedThread } from "../tools/thread.js"
import { loadEmbedder, MODEL } from "./embedder.js"
import { openVectorStore } from "./vectors.js"
import { removeOldIndex } from "./old-index.js"
import { Worker } from "node:worker_threads"

const TIDY_SOURCE = `
  const { workerData } = require("node:worker_threads")
  Promise.all([import(workerData.ignore), import(workerData.guard)]).then(([ignore, guard]) => {
    ignore.ensureStateIgnored(workerData.root)
    guard.ensureCardGuard(workerData.root)
  })
`

// Resolves when the worker is done; a worker that fails leaves things as they were, as both steps do on their own.
function tidyRepository(root) {
  return new Promise((resolve) => {
    const worker = new Worker(TIDY_SOURCE, {
      eval: true,
      workerData: {
        root,
        ignore: new URL("../util/state-ignore.js", import.meta.url).href,
        guard: new URL("../desk/card-commit-guard.js", import.meta.url).href,
      },
    })
    worker.once("error", resolve)
    worker.once("exit", resolve)
  })
}

// Reciprocal rank fusion (Cormack et al., 2009) with its usual constant.
const FUSION_K = 60

/** Merges ranked result lists by path: each list adds 1 / (FUSION_K + rank) to a document's score. */
function fuseRankings(lists, limit) {
  const fused = new Map()
  for (const list of lists) {
    list.forEach((result, rank) => {
      const entry = fused.get(result.path)
      const add = 1 / (FUSION_K + rank + 1)
      if (entry === undefined) fused.set(result.path, { ...result, score: add })
      else fused.set(result.path, { ...entry, score: entry.score + add, match: "meaning_and_exact_words" })
    })
  }
  return [...fused.values()].map((result) => ({ ...result, score: Number(result.score.toFixed(6)) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
}

const IGNORED = new Set([".git", ".state", "node_modules"])
const DEFAULT_LIMIT = 10
// A model download that failed is tried again at the next desk change after this long.
const MODEL_RETRY_MS = 60_000

export const SEARCH_WORDING = Object.freeze({
  ready: "Search is ready.",
  preparing: (pending, total) => `Search is preparing ${pending} of ${total} sections for meaning-based search; exact-word search is ready.`,
  gettingReady: "Meaning-based search is getting ready; exact-word search is ready.",
  modelFailed: (reason) => `Meaning-based search could not load its model (${reason}); exact-word search is ready, and Desk tries again shortly.`,
  recallPreparing: (pending, total) => `${pending} of ${total} desk sections are still being prepared for meaning-based search, so exact-word matches are included.`,
  recallGettingReady: "Meaning-based search is getting ready, so these results match exact words.",
  similarNotReady: "This document is not prepared for meaning-based search yet; try again shortly.",
  oldIndexRemoved: (bytes) => `Desk removed its old search index (${bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`}), which this version no longer uses.`,
})

export function createSearchEngine(options) {
  const { deskRoot, stateDir, semantic, loadModel, watch, batchSize, pauseMs, now, cleanup } = {
    stateDir: path.join(options.deskRoot, ".state"),
    semantic: "background",
    loadModel: loadEmbedder,
    watch: watchNative,
    batchSize: 64,
    pauseMs: 25,
    now: Date.now,
    cleanup: removeOldIndex,
    ...options,
  }
  // The index lives in memory, so opening it does not keep `.state/` out of Git or install the card guard. Both run git
  // several times, which takes hundreds of milliseconds on Windows, so a worker does them off the server's event loop.
  const tidying = tidyRepository(deskRoot)
  const db = openDb(deskRoot, { dbPath: ":memory:" })
  const store = semantic === "unsupported" ? null : openVectorStore(stateDir, MODEL.id)
  let oldIndex = { removed: false, bytes: 0 }
  // removeOldIndex never rejects: every failure leaves the files for the next start.
  const cleaning = Promise.resolve(cleanup(stateDir)).then((result) => { oldIndex = result })
  let built = false
  let dirty = true
  let refreshing = null
  let embedding = null
  let model = null
  let modelError = null
  let modelFailedAt = 0
  let modelLoading = null
  let closed = false
  // Without a watcher every search reads the desk again first.
  let watcherFailed = false
  const watcher = startWatcher()
  // After the first full read, a refresh rereads only the Markdown files the watcher or a Desk write named. A change it
  // cannot place (a folder created, moved or removed, a .gitignore, an event without a name) reads the whole desk again.
  const discoverCache = createDiscoverCache()
  let fullScan = true
  let changedFiles = new Set()
  let otherPaths = new Set()

  function startWatcher() {
    try {
      // On Windows a root spelled with an 8.3 short name makes a recursive watch abort the process, so the long name is watched.
      /* istanbul ignore next -- the platform split */
      const root = process.platform === "win32" ? realpathSync.native(deskRoot) : deskRoot
      const handle = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        noteChange(filename == null ? null : String(filename).replaceAll("\\", "/"))
      })
      handle.on?.("error", () => { watcherFailed = true })
      return handle
    } catch {
      watcherFailed = true
      return null
    }
  }
  function noteChange(rel) {
    if (rel === null) {
      fullScan = true
    } else if (IGNORED.has(rel.split("/")[0])) {
      return
    } else if (rel.endsWith(".md")) {
      changedFiles.add(rel)
    } else {
      otherPaths.add(rel)
    }
    dirty = true
  }

  // Whether a changed path that is not a Markdown file may have moved Markdown files: a folder, a folder that is gone
  // (a name without a dot) or a .gitignore.
  async function movesFiles(paths) {
    for (const rel of paths) {
      if (rel.split("/").at(-1) === ".gitignore") return true
      const found = await stat(path.join(deskRoot, rel)).catch(() => null)
      if (found === null ? !rel.split("/").at(-1).includes(".") : found.isDirectory()) return true
    }
    return false
  }

  function refresh() {
    refreshing ??= (async () => {
      dirty = false
      const files = changedFiles
      const others = otherPaths
      const full = fullScan || watcherFailed || !built
      changedFiles = new Set()
      otherPaths = new Set()
      fullScan = false
      try {
        const { tombstones } = resolveEnsureIndexOptions({ snapshots: false, vectorPacks: false }, { deskRoot })
        useForNextDiscover(deskRoot, discoverCache, full || await movesFiles(others) ? null : files)
        const run = rebuildIndex(deskRoot, { db, skipEmbed: true, vectorCleanup: false, tombstones })
        useForNextDiscover(null)
        await run
        built = true
      } catch (error) {
        dirty = true
        fullScan = true
        throw error
      } finally {
        refreshing = null
      }
      embedInBackground()
    })()
    return refreshing
  }

  async function current() {
    if (!built || dirty || watcherFailed) await refresh()
  }

  function ensureModel() {
    if (store === null || model !== null || modelLoading !== null) return modelLoading
    if (modelError !== null && now() - modelFailedAt < MODEL_RETRY_MS) return null
    modelLoading = loadModel({ stateDir }).then((loaded) => {
      model = loaded
      modelError = null
    }, (error) => {
      modelError = error.message
      modelFailedAt = now()
    }).finally(() => { modelLoading = null })
    return modelLoading
  }

  // Distinct section texts that have no vector yet.
  function pendingTexts() {
    const pending = new Map()
    for (const row of db.prepare("SELECT text_hash, text FROM chunks").iterate()) {
      if (!store.vectors.has(row.text_hash)) pending.set(row.text_hash, row.text)
    }
    return pending
  }

  function sectionCounts() {
    const hashes = db.prepare("SELECT DISTINCT text_hash FROM chunks").pluck().all()
    const ready = store === null ? 0 : hashes.filter((hash) => store.vectors.has(hash)).length
    return { total: hashes.length, ready, pending: hashes.length - ready }
  }

  function embedInBackground() {
    embedding ??= (async () => {
      await null
      try {
        await ensureModel()
        if (model === null || closed) return
        // A short pause between batches keeps the machine responsive while a whole desk is embedded the first time.
        // Texts that changed during a pass are found by the next pass.
        for (let pending = [...pendingTexts()]; pending.length > 0 && !closed; pending = [...pendingTexts()]) {
          for (let start = 0; start < pending.length && !closed; start += batchSize) {
            store.save(pending.slice(start, start + batchSize).map(([hash, text]) => [hash, model.embed(text)]))
            await new Promise((resolve) => setTimeout(resolve, pauseMs))
          }
        }
      } catch {
        // A vector that could not be saved is embedded again at the next desk change.
      } finally {
        embedding = null
      }
    })()
    return embedding
  }

  async function lexical(request) {
    await current()
    if (request.kind === "thread") return indexedThread({ deskRoot, db, input: request })
    const backend = request.kind === "timeline" ? indexedTimeline : indexedSearch
    const result = await backend({ deskRoot, db, input: request, opts: { ...request.opts, now: request.now, lexicalOnly: true } })
    // These tools search exact words only; the fields about meaning-based search do not apply to them.
    const { semantic_unavailable, semantic_note, semantic_diagnostic, ...rest } = result
    return rest
  }

  function sections() {
    return db.prepare(`SELECT c.text_hash, c.text, c.doc_id, d.path AS doc_path, d.kind, d.track, d.task_slug,
      d.status, d.updated_at, d.is_archived FROM chunks c JOIN docs d ON d.id = c.doc_id`).all()
  }

  // The best-scoring section per document, best documents first.
  function rankByMeaning(vector, rows, scope, limit, skipDoc = null) {
    const best = new Map()
    for (const row of rows) {
      const section = store.vectors.get(row.text_hash)
      if (section === undefined || row.doc_id === skipDoc || !passesScope(row, scope, "all")) continue
      let score = 0
      for (let i = 0; i < vector.length; i++) score += vector[i] * section[i]
      if (!(best.get(row.doc_id)?.score >= score)) {
        best.set(row.doc_id, {
          path: row.doc_path, kind: row.kind, track: row.track, task_slug: row.task_slug, status: row.status,
          updated_at: row.updated_at, snippet: makeSnippet(row.text, []), score: Number(score.toFixed(4)), match: "meaning",
        })
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
  }

  async function exactWords(text, scope, limit) {
    const { results } = await indexedSearch({ deskRoot, db, input: { query: text, scope: scope ?? "all", limit }, opts: { lexicalOnly: true } })
    return results.map(({ score_breakdown, ...result }) => ({ ...result, match: "exact_words" }))
  }

  async function recall(request) {
    const topic = String(request.topic ?? "").trim()
    if (!topic) return { topic, results: [], note: "empty topic" }
    const limit = Number.isInteger(request.limit) && request.limit > 0 ? Math.min(request.limit, 50) : DEFAULT_LIMIT
    await current()
    embedInBackground()
    if (model === null) {
      return { topic, results: await exactWords(topic, request.scope, limit), search_mode: "exact_words", note: SEARCH_WORDING.recallGettingReady }
    }
    // Both rankings, fused by reciprocal rank: a document strong on meaning and on exact words rises above one strong on
    // either alone, and exact words also cover sections that have no vector yet.
    const pool = Math.max(limit * 5, 50)
    const results = fuseRankings([rankByMeaning(model.embed(topic), sections(), request.scope, pool), await exactWords(topic, request.scope, pool)], limit)
    const { pending, total } = sectionCounts()
    if (pending === 0) return { topic, results, search_mode: "meaning" }
    return { topic, results, search_mode: "meaning_and_exact_words", note: SEARCH_WORDING.recallPreparing(pending, total) }
  }

  async function similar(request) {
    const seed = String(request.path ?? "").trim()
    if (!seed) return { error: "invalid_input", note: "`path` is required" }
    const limit = Number.isInteger(request.limit) && request.limit > 0 ? Math.min(request.limit, 50) : DEFAULT_LIMIT
    await current()
    embedInBackground()
    const doc = db.prepare("SELECT id FROM docs WHERE path = ?").get(seed)
    if (doc === undefined) return { error: "not_found", note: `path not in index: ${seed}` }
    const rows = sections()
    const own = rows.filter((row) => row.doc_id === doc.id).map((row) => store?.vectors.get(row.text_hash))
    if (model === null || own.length === 0 || own.some((vector) => vector === undefined)) {
      return { seed, results: [], note: SEARCH_WORDING.similarNotReady }
    }
    const centroid = new Float32Array(own[0].length)
    for (const vector of own) for (let i = 0; i < centroid.length; i++) centroid[i] += vector[i] / own.length
    return { seed, results: rankByMeaning(centroid, rows, request.scope, limit, doc.id) }
  }

  function searchStatus() {
    const counts = built ? sectionCounts() : { total: 0, ready: 0, pending: 0 }
    const removed = oldIndex.removed ? { old_index_removed: SEARCH_WORDING.oldIndexRemoved(oldIndex.bytes) } : {}
    if (store === null) return { state: "exact_words_only", message: "Meaning-based search is off for this desk; exact-word search is ready.", ...removed }
    const state = modelError !== null && model === null ? "model_unavailable"
      : model === null || !built ? "getting_ready"
        : counts.pending > 0 ? "preparing" : "ready"
    const message = state === "model_unavailable" ? SEARCH_WORDING.modelFailed(modelError)
      : state === "getting_ready" ? SEARCH_WORDING.gettingReady
        : state === "preparing" ? SEARCH_WORDING.preparing(counts.pending, counts.total) : SEARCH_WORDING.ready
    return { state, message, sections_total: counts.total, sections_ready: counts.ready, model: MODEL.id, ...removed }
  }

  function markChanged() {
    fullScan = true
    dirty = true
  }

  return {
    // What the session's admission expects of its search service.
    accepted: true,
    identity: Object.freeze({ semantic_contract: Object.freeze({ mode: semantic }) }),
    embeddingOverride: null,
    status: async () => ({ state: "READY", convergence: { status: "ready" }, search: searchStatus() }),
    beginConvergence: () => { refresh().catch(() => {}); return Promise.resolve({ started: true }) },
    barrier: async ({ capability } = {}) => ({ capability, current: true, certain: true }),
    recordChange: async ({ path: rel }) => { noteChange(typeof rel === "string" ? rel.replaceAll("\\", "/") : null); return { recorded: true } },
    markUncertain: async () => { markChanged() },
    onExit: () => () => {},
    // What the search tools call.
    lexical,
    async semantic(request) {
      return request.kind === "similar" ? similar(request) : recall(request)
    },
    async reindex() {
      markChanged()
      await refresh()
      return { status: "ok", action: "reindexed", search: searchStatus() }
    },
    searchStatus,
    // Resolves once the current refresh and background embedding are done (tests).
    async settled() {
      await Promise.all([cleaning, tidying])
      while (refreshing || embedding || modelLoading) await Promise.allSettled([refreshing, embedding, modelLoading])
    },
    async close() {
      closed = true
      watcher?.close()
      await this.settled()
      closeDb(db)
      store?.close()
    },
  }
}
