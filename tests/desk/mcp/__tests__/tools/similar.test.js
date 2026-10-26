// similar.test.js — the public desk_similar wrapper; the engine's similarity is covered in ../search/engine.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { desk_similar } from "../../../../../plugins/desk/mcp/src/tools/search.js"

test("desk_similar routes similarity requests through the public query router", async () => {
  const queryRouter = {
    async semantic(request) {
      return { routed: true, request }
    },
  }

  const result = await desk_similar({
    deskRoot: "/tmp/desk",
    input: { path: "track/seed/task.md", limit: 4 },
    queryRouter,
  })

  assert.deepEqual(result, {
    routed: true,
    request: {
      deskRoot: "/tmp/desk",
      kind: "similar",
      limit: 4,
      opts: undefined,
      path: "track/seed/task.md",
      signal: undefined,
    },
  })
})

test("without a query router, desk_similar asks the session's search engine", async () => {
  const engine = { lexical: async () => ({}), semantic: async (request) => ({ engine: true, kind: request.kind }) }
  assert.deepEqual(await desk_similar({ deskRoot: "/tmp/desk", input: { path: "a.md" }, search: engine }), { engine: true, kind: "similar" })
})
