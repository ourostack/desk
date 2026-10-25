import { test } from "node:test"
import assert from "node:assert/strict"
import { desk_reindex } from "../../../../../plugins/desk/mcp/src/tools/reindex.js"
import { createSearchEngine } from "../../../../../plugins/desk/mcp/src/search/engine.js"
import { mkTempDeskRoot, writeFile } from "./_search_helpers.js"

test("before the search engine starts, reindex says search is starting", async () => {
  const root = await mkTempDeskRoot()
  const result = await desk_reindex({ deskRoot: root, input: { force: true } })
  assert.equal(result.code, "search_starting")
})

test("reindex re-reads the desk into the session's search engine", async (t) => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/work/task.md", "before")
  const engine = createSearchEngine({ deskRoot: root, semantic: "unsupported", watch: () => ({ close() {} }) })
  t.after(() => engine.close())
  assert.equal((await engine.lexical({ query: "before" })).results.length, 1)
  await writeFile(root, "track/work/task.md", "after")
  const result = await desk_reindex({ deskRoot: root, readiness: engine, input: { force: true } })
  assert.equal(result.status, "ok")
  assert.equal(result.action, "reindexed")
  assert.equal((await engine.lexical({ query: "after" })).results.length, 1)
})
