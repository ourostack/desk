import { test } from "node:test"
import assert from "node:assert/strict"
import { searchRouter } from "../../../../../plugins/desk/mcp/src/search/files-router.js"
import { mkTempDeskRoot, writeFile } from "../tools/_search_helpers.js"

const STARTING = "Desk search is still starting; try again in a few seconds."

test("before the session's search engine starts, searches read the files and the rest say search is starting", async () => {
  const deskRoot = await mkTempDeskRoot()
  await writeFile(deskRoot, "food/task-b/task.md", "# Kitchen\n\nA soup recipe.\n")
  const router = searchRouter(null)
  assert.equal(searchRouter({ status() {} }), router)
  const search = await router.lexical({ deskRoot, query: "soup", kind: "lexical" })
  assert.deepEqual(search.results.map((r) => r.path), ["food/task-b/task.md"])
  assert.equal(search.semantic_note, undefined)
  const recall = await router.semantic({ deskRoot, topic: "soup", kind: "recall" })
  assert.deepEqual({ ...recall, results: recall.results.map((r) => r.path) }, {
    topic: "soup", results: ["food/task-b/task.md"], search_mode: "exact_words",
    note: "Meaning-based search is getting ready, so these results match exact words.",
  })
  assert.deepEqual(await router.semantic({ deskRoot, path: "food/task-b/task.md", kind: "similar" }), { seed: "food/task-b/task.md", results: [], note: STARTING })
  assert.deepEqual(await router.semantic({ deskRoot, kind: "similar" }), { seed: null, results: [], note: STARTING })
  assert.deepEqual(await router.lexical({ deskRoot, start_path: "food/task-b/task.md", kind: "thread" }), { status: "error", code: "search_starting", message: STARTING })
  assert.deepEqual(await router.reindex({ deskRoot }), { status: "error", code: "search_starting", message: STARTING })
})

test("once admission has started the engine, tools use it", () => {
  const engine = { lexical() {} }
  assert.equal(searchRouter(engine), engine)
})
