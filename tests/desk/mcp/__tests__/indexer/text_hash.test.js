// A section's text hash keys its stored vector, so it must not change between builds.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"

import { chunkTextHash } from "../../../../../plugins/desk/mcp/src/indexer/text-hash.js"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

test("the text hash ignores line endings and insignificant whitespace", () => {
  assert.equal(chunkTextHash("## Heading\r\n  Alpha   beta  \r\n"), `sha256:${sha256("## Heading\nAlpha beta")}`)
  assert.equal(chunkTextHash("one\n\n\n\ntwo"), `sha256:${sha256("one\n\ntwo")}`)
  assert.notEqual(chunkTextHash("Alpha beta"), chunkTextHash("Alpha gamma"))
})

test("the text hash of empty or missing text is the hash of nothing", () => {
  assert.equal(chunkTextHash(""), `sha256:${sha256("")}`)
  assert.equal(chunkTextHash(undefined), chunkTextHash(""))
})
