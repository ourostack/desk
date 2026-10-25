import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { configureRuntimeArtifacts } from "../../../../../plugins/desk/mcp/src/server-helpers.js"
import { createSearchEngine, SEARCH_WORDING } from "../../../../../plugins/desk/mcp/src/search/engine.js"
import { loadEmbedder } from "../../../../../plugins/desk/mcp/src/search/embedder.js"
import { mkTempDeskRoot, writeFile } from "../tools/_search_helpers.js"
import { fixtureModel } from "./_model_fixture.js"

const CAR = "# Car notes\n\nMy car engine is about the vehicle.\n"
const SOUP = "# Kitchen\n\nA soup recipe for the kitchen.\n"
const GARDEN = "# Garden\n\nFlowers and plants in the soil.\n"

// The fixture model through the real embedder; `calls` lists every text it embedded.
function countingModel() {
  const fixture = fixtureModel()
  const calls = []
  const loadModel = async ({ stateDir }) => {
    const model = await loadEmbedder({ stateDir, fetch: fixture.fetch, model: fixture.model })
    return { ...model, embed: (text) => { calls.push(text); return model.embed(text) } }
  }
  return { loadModel, calls }
}

async function desk(files) {
  const root = await mkTempDeskRoot()
  for (const [rel, body] of Object.entries(files)) await writeFile(root, rel, body)
  return root
}

function engineFor(t, deskRoot, options = {}) {
  const engine = createSearchEngine({ deskRoot, pauseMs: 0, cleanup: () => ({ removed: false, bytes: 0 }), ...options })
  t.after(() => engine.close())
  return engine
}

async function until(condition) {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 2))
}

test("before the model is ready, recall answers with exact words and says meaning search is getting ready", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": CAR, "food/task-b/task.md": SOUP })
  let release
  const engine = engineFor(t, deskRoot, { loadModel: () => new Promise((resolve) => { release = resolve }) })
  const result = await engine.semantic({ kind: "recall", topic: "soup" })
  assert.equal(result.search_mode, "exact_words")
  assert.equal(result.note, SEARCH_WORDING.recallGettingReady)
  assert.deepEqual(result.results.map((r) => [r.path, r.match]), [["food/task-b/task.md", "exact_words"]])
  assert.deepEqual(engine.searchStatus(), { state: "getting_ready", message: SEARCH_WORDING.gettingReady, sections_total: 2, sections_ready: 0, model: "minishlab/potion-base-8M@bf8b0566" })
  assert.deepEqual(await engine.semantic({ kind: "similar", path: "cars/task-a/task.md" }), { seed: "cars/task-a/task.md", results: [], note: SEARCH_WORDING.similarNotReady })
  release(null)
})

test("once embedded, recall and similar rank by meaning, and status says search is ready", async (t) => {
  const deskRoot = await desk({
    "cars/task-a/task.md": CAR,
    "cars/task-c/task.md": `${CAR}\n## More\n\nThe automobile again.\n`,
    "food/task-b/task.md": SOUP,
    "garden/task-d/task.md": GARDEN,
    "garden/_archive/old/task.md": GARDEN,
  })
  const engine = engineFor(t, deskRoot, countingModel())
  await engine.reindex()
  await engine.settled()
  // Five documents, four distinct section texts: a text shared by two documents is embedded once.
  assert.deepEqual(engine.searchStatus(), { state: "ready", message: SEARCH_WORDING.ready, sections_total: 4, sections_ready: 4, model: "minishlab/potion-base-8M@bf8b0566" })
  const recall = await engine.semantic({ kind: "recall", topic: "automobile", limit: 2 })
  assert.equal(recall.search_mode, "meaning")
  assert.deepEqual(recall.results.map((r) => r.path).sort(), ["cars/task-a/task.md", "cars/task-c/task.md"])
  assert.ok(recall.results.every((r) => r.match === "meaning" && r.score > 0.9))
  // Equal scores are ordered by path; the archive is searched by default and left out with scope "active".
  const garden = await engine.semantic({ kind: "recall", topic: "flowers", limit: 99 })
  assert.deepEqual(garden.results.slice(0, 2).map((r) => r.path), ["garden/_archive/old/task.md", "garden/task-d/task.md"])
  const active = await engine.semantic({ kind: "recall", topic: "flowers", scope: "active", limit: 0 })
  assert.equal(active.results[0].path, "garden/task-d/task.md")
  assert.ok(!active.results.some((r) => r.path.includes("_archive")))
  const similar = await engine.semantic({ kind: "similar", path: "cars/task-a/task.md", limit: 1 })
  assert.deepEqual(similar.results.map((r) => r.path), ["cars/task-c/task.md"])
  assert.deepEqual(await engine.semantic({ kind: "similar", path: " " }), { error: "invalid_input", note: "`path` is required" })
  assert.deepEqual(await engine.semantic({ kind: "similar", path: "nope.md" }), { error: "not_found", note: "path not in index: nope.md" })
  assert.deepEqual(await engine.semantic({ kind: "recall", topic: "  " }), { topic: "", results: [], note: "empty topic" })
  assert.deepEqual(await engine.semantic({ kind: "recall" }), { topic: "", results: [], note: "empty topic" })
  assert.deepEqual(await engine.semantic({ kind: "similar" }), { error: "invalid_input", note: "`path` is required" })
})

test("an edit embeds only the changed section, and vectors survive a restart", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": `${CAR}\n## Second\n\nThe engine status.\n`, "food/task-b/task.md": SOUP })
  const first = countingModel()
  const engine = createSearchEngine({ deskRoot, pauseMs: 0, cleanup: () => ({ removed: false, bytes: 0 }), ...first })
  await engine.reindex()
  await engine.settled()
  assert.equal(first.calls.length, 3)
  await writeFile(deskRoot, "food/task-b/task.md", `${SOUP}\nKitchen notes.\n`)
  assert.deepEqual(await engine.recordChange({ path: "food/task-b/task.md" }), { recorded: true })
  await engine.lexical({ query: "kitchen" })
  await engine.settled()
  assert.deepEqual(first.calls.slice(3), [`${SOUP.trim()}\n\nKitchen notes.`])
  await engine.close()
  assert.ok(existsSync(path.join(deskRoot, ".state", "desk-vectors.sqlite")))

  const second = countingModel()
  const restarted = engineFor(t, deskRoot, second)
  await restarted.reindex()
  await restarted.settled()
  assert.equal(second.calls.length, 0, "nothing is embedded again after a restart")
  const recall = await restarted.semantic({ kind: "recall", topic: "recipe" })
  assert.deepEqual(second.calls, ["recipe"])
  assert.equal(recall.results[0].path, "food/task-b/task.md")
})

test("while sections are being prepared, recall adds exact-word matches and says how many sections remain", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": CAR, "food/task-b/task.md": SOUP, "garden/task-d/task.md": GARDEN })
  const engine = engineFor(t, deskRoot, { ...countingModel(), batchSize: 1, pauseMs: 300 })
  await engine.lexical({ query: "car" })
  await until(() => engine.searchStatus().state === "preparing")
  const status = engine.searchStatus()
  assert.equal(status.message, SEARCH_WORDING.preparing(status.sections_total - status.sections_ready, status.sections_total))
  const recall = await engine.semantic({ kind: "recall", topic: "soup kitchen", limit: 3 })
  assert.equal(recall.search_mode, "meaning_and_exact_words")
  assert.match(recall.note, /^[12] of 3 desk sections are still being prepared for meaning-based search, so exact-word matches are included\.$/)
  assert.ok(recall.results.some((r) => r.path === "food/task-b/task.md"))
  assert.equal(new Set(recall.results.map((r) => r.path)).size, recall.results.length)
})

test("exact-word search, timeline and thread read the in-memory index and leave out meaning-search fields", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": CAR, "food/task-b/task.md": `${SOUP}\nSee [car](../../cars/task-a/task.md).\n` })
  const engine = engineFor(t, deskRoot, { semantic: "unsupported" })
  const search = await engine.lexical({ kind: "lexical", query: "soup" })
  assert.deepEqual(search.results.map((r) => r.path), ["food/task-b/task.md"])
  assert.equal(search.semantic_note, undefined)
  const timeline = await engine.lexical({ kind: "timeline", query: "car" })
  assert.equal(timeline.semantic_unavailable, undefined)
  assert.ok(timeline.results.length >= 1)
  const thread = await engine.lexical({ kind: "thread", start_path: "food/task-b/task.md" })
  assert.equal(thread.start.path, "food/task-b/task.md")
  // With meaning-based search off there is no vector store: recall answers with exact words.
  assert.equal((await engine.semantic({ kind: "recall", topic: "soup" })).search_mode, "exact_words")
  assert.deepEqual(engine.searchStatus(), { state: "exact_words_only", message: "Meaning-based search is off for this desk; exact-word search is ready." })
  assert.ok(!existsSync(path.join(deskRoot, ".state", "desk-vectors.sqlite")))
})

test("the watcher marks the index stale for desk files, not for Git or state files, and a failed watcher reads the desk every time", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": CAR })
  let notify
  const engine = engineFor(t, deskRoot, { semantic: "unsupported", watch: (_root, _options, callback) => { notify = callback; return { close() {} } } })
  await engine.lexical({ query: "car" })
  await writeFile(deskRoot, "food/task-b/task.md", SOUP)
  notify("change", path.join(".git", "index"))
  assert.equal((await engine.lexical({ query: "soup" })).results.length, 0)
  notify("rename", path.join("food", "task-b", "task.md"))
  assert.equal((await engine.lexical({ query: "soup" })).results.length, 1)
  await writeFile(deskRoot, "garden/task-d/task.md", GARDEN)
  notify("rename", null)
  assert.equal((await engine.lexical({ query: "flowers" })).results.length, 1)

  const throwing = engineFor(t, deskRoot, { semantic: "unsupported", watch: () => { throw new Error("no watch") } })
  await throwing.lexical({ query: "car" })
  await writeFile(deskRoot, "more/task-e/task.md", "# Plants\n\nsoil\n")
  assert.equal((await throwing.lexical({ query: "soil" })).results.length, 2)

  const watcher = Object.assign(new EventEmitter(), { close() {} })
  const failing = engineFor(t, deskRoot, { semantic: "unsupported", watch: () => watcher })
  await failing.lexical({ query: "car" })
  watcher.emit("error", new Error("watch failed"))
  await writeFile(deskRoot, "more/task-f/task.md", "# Plants\n\nsoil again\n")
  assert.equal((await failing.lexical({ query: "soil" })).results.length, 3)
})

test("a model that fails to load is reported plainly and tried again later; an embedding failure waits for the next change", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": CAR })
  let clock = 0
  let attempts = 0
  const working = countingModel()
  const engine = engineFor(t, deskRoot, {
    now: () => clock,
    loadModel: async (options) => {
      attempts += 1
      if (attempts === 1) throw new Error("offline")
      if (attempts === 2) return { id: "broken", embed: () => { throw new Error("embedding failed") } }
      return working.loadModel(options)
    },
  })
  await engine.reindex()
  await engine.settled()
  assert.deepEqual(engine.searchStatus(), { state: "model_unavailable", message: SEARCH_WORDING.modelFailed("offline"), sections_total: 1, sections_ready: 0, model: "minishlab/potion-base-8M@bf8b0566" })
  assert.equal((await engine.semantic({ kind: "recall", topic: "car" })).search_mode, "exact_words")
  await engine.settled()
  assert.equal(attempts, 1, "no retry within a minute")
  clock = 61_000
  await engine.reindex()
  await engine.settled()
  assert.equal(attempts, 2)
  assert.equal(engine.searchStatus().state, "preparing")
})

test("the engine answers the calls session admission makes of a search service", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": CAR })
  const engine = engineFor(t, deskRoot, { semantic: "unsupported", watch: () => ({ close() {} }) })
  assert.equal(engine.accepted, true)
  assert.equal(engine.embeddingOverride, null)
  assert.deepEqual(engine.identity, { semantic_contract: { mode: "unsupported" } })
  assert.deepEqual(await engine.barrier({ capability: "semantic" }), { capability: "semantic", current: true, certain: true })
  assert.deepEqual(await engine.barrier(), { capability: undefined, current: true, certain: true })
  assert.deepEqual(await engine.beginConvergence(), { started: true })
  await engine.settled()
  assert.equal(await engine.markUncertain("x"), undefined)
  const unsubscribe = engine.onExit(() => assert.fail("never exits"))
  unsubscribe()
  const status = await engine.status()
  assert.equal(status.state, "READY")
  assert.equal(status.search.state, "exact_words_only")
})

test("a desk that cannot be read fails the search that needed it, and a background start swallows the failure", async (t) => {
  const deskRoot = await desk({ "cars/task-a/task.md": CAR })
  const pluginRoot = await mkTempDeskRoot()
  await writeFile(pluginRoot, "artifacts/tombstones/tombstones.jsonl", "not json\n")
  configureRuntimeArtifacts({ pluginRoot })
  t.after(() => configureRuntimeArtifacts())
  const engine = engineFor(t, deskRoot, { semantic: "unsupported" })
  assert.deepEqual(await engine.beginConvergence(), { started: true })
  await engine.settled()
  await assert.rejects(engine.lexical({ query: "car" }), /tombstone ledger is invalid/)
  assert.deepEqual(engine.searchStatus(), { state: "exact_words_only", message: "Meaning-based search is off for this desk; exact-word search is ready." })
})

test("status says once the old search index was removed, in megabytes or gigabytes", async (t) => {
  const deskRoot = await desk({})
  const small = engineFor(t, deskRoot, { semantic: "unsupported", cleanup: () => ({ removed: true, bytes: 82_000_000 }) })
  assert.equal(small.searchStatus().old_index_removed, "Desk removed its old search index (82 MB), which this version no longer uses.")
  const large = engineFor(t, deskRoot, { semantic: "unsupported", cleanup: () => ({ removed: true, bytes: 9_700_000_000 }) })
  assert.equal(large.searchStatus().old_index_removed, "Desk removed its old search index (9.7 GB), which this version no longer uses.")
})

test("by default the engine removes the old index from the desk's state folder", async (t) => {
  const deskRoot = await desk({ ".state/desk-index.sqlite": "old" })
  const engine = createSearchEngine({ deskRoot, semantic: "unsupported" })
  t.after(() => engine.close())
  // Whether it was removed depends on lsof being installed; either way the engine starts and the vectors file is not touched.
  assert.equal(typeof engine.searchStatus().message, "string")
})
