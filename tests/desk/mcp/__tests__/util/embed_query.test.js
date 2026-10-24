// A search query is embedded once per request: an answered query's vector is kept in the request's `queryVectors`, and a failed answer is not.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { embedQuery } from "../../../../../plugins/desk/mcp/src/util/embed-query.js"

const vector = Array(768).fill(0.5)

function service(answers) {
  const prompts = []
  return {
    prompts,
    endpoint: "http://127.0.0.1:11434",
    fetch: async (_url, request) => {
      prompts.push(JSON.parse(request.body).prompt)
      return answers.shift()()
    },
  }
}

test("an empty query is not sent to the embedding service", async () => {
  const embed = service([])
  assert.deepEqual(await embedQuery("  ", embed), { vector: null, available: false, diagnostic: null })
  assert.deepEqual(embed.prompts, [])
  assert.deepEqual(await embedQuery(""), { vector: null, available: false, diagnostic: null })
})

test("within one request an answered query is embedded once, and a failed one is asked again", async () => {
  const embed = service([
    () => { throw new Error("connect ECONNREFUSED") },
    () => new Response(JSON.stringify({ embedding: vector })),
  ])
  const queryVectors = new Map()
  assert.equal((await embedQuery("quartz", { ...embed, queryVectors })).available, false)
  assert.equal((await embedQuery("quartz", { ...embed, queryVectors })).available, true)
  assert.equal((await embedQuery("quartz", { ...embed, queryVectors })).available, true)
  assert.deepEqual(embed.prompts, ["quartz", "quartz"])
})
