// similar.test.js — the public desk_similar wrapper; the engine's similarity is covered in ../search/engine.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { desk_similar } from "../../../../../plugins/desk/mcp/src/tools/search.js"
import {
  buildFixtureIndex,
  makeEmbedFetch,
  makeFailingFetch,
  mkTempDeskRoot,
  writeFile,
} from "./_search_helpers.js"

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
