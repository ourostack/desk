// recall.test.js — the public desk_recall wrapper; the engine's recall is covered in ../search/engine.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { desk_recall } from "../../../../../plugins/desk/mcp/src/tools/search.js"

test("desk_recall routes semantic recall requests through the public query router", async () => {
  const queryRouter = {
    async semantic(request) {
      return { routed: true, request }
    },
  }

  const result = await desk_recall({
    deskRoot: "/tmp/desk",
    input: { topic: "alpha", limit: 3 },
    opts: { now: 1 },
    queryRouter,
  })

  assert.deepEqual(result, {
    routed: true,
    request: {
      deskRoot: "/tmp/desk",
      kind: "recall",
      limit: 3,
      opts: { now: 1 },
      signal: undefined,
      topic: "alpha",
    },
  })
})

test("without a query router, desk_recall asks the session's search engine", async () => {
  const engine = { lexical: async () => ({}), semantic: async (request) => ({ engine: true, kind: request.kind }) }
  assert.deepEqual(await desk_recall({ deskRoot: "/tmp/desk", input: { topic: "alpha" }, search: engine }), { engine: true, kind: "recall" })
})
