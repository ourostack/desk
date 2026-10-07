// Unit 11a: red contract for stable chunk keys and embedding specs.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"

import { chunkBody } from "../../../../../plugins/desk/mcp/src/indexer/chunk.js"
import { ACTIVE_EMBEDDING_SPEC, chunkIdentity } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const keyOf = (options) => chunkIdentity(options).chunk_key

test("active embedding spec is versioned, path-safe, and tied to chunker identity", () => {
  assert.equal(ACTIVE_EMBEDDING_SPEC.model, "nomic-embed-text")
  assert.equal(ACTIVE_EMBEDDING_SPEC.model_revision, "nomic-embed-text-v1.5")
  assert.equal(ACTIVE_EMBEDDING_SPEC.dimension, 768)
  assert.equal(ACTIVE_EMBEDDING_SPEC.chunker_id, "desk-md-h2-paragraph-v2")
  assert.equal(ACTIVE_EMBEDDING_SPEC.normalization_id, "unicode-whitespace-v1")
  assert.match(ACTIVE_EMBEDDING_SPEC.id, /nomic-embed-text-v1_5/u)
  assert.doesNotMatch(ACTIVE_EMBEDDING_SPEC.id, /[\\/: \t\r\n]/u)
})

test("normalized text identity is stable across line endings and insignificant whitespace", () => {
  const docPath = "trackA/task-1/doing.md"
  const left = chunkIdentity({ docPath, chunk: { text: "## Heading\r\nAlpha\u00a0beta  \r\n\r\n" } })
  const right = chunkIdentity({ docPath, chunk: { text: "## Heading\nAlpha beta\n" } })
  const changed = chunkIdentity({ docPath, chunk: { text: "## Heading\nAlpha beta\nchanged\n" } })

  assert.equal(left.text_hash, `sha256:${sha256("## Heading\nAlpha beta")}`)
  assert.equal(left.text_hash, right.text_hash)
  assert.equal(left.chunk_key, right.chunk_key)
  assert.notEqual(changed.text_hash, right.text_hash)
})

test("chunk identity handles empty text and custom embedding specs", () => {
  const docPath = "trackA/task-1/empty.md"
  const defaultIdentity = chunkIdentity({ docPath, chunk: null })
  const customSpec = {
    ...ACTIVE_EMBEDDING_SPEC,
    id: "custom-embedding-spec",
    chunker_id: "custom-chunker",
    normalization_id: "custom-normalizer",
  }
  const customIdentity = chunkIdentity({
    docPath,
    chunk: { text: null },
    embeddingSpec: customSpec,
  })

  assert.equal(defaultIdentity.text_hash, `sha256:${sha256("")}`)
  assert.equal(chunkIdentity({ docPath, chunk: { text: undefined } }).text_hash, defaultIdentity.text_hash)
  assert.equal(keyOf({ docPath, chunk: { heading: "No Text" } }), defaultIdentity.chunk_key)
  assert.equal(defaultIdentity.embedding_spec_id, ACTIVE_EMBEDDING_SPEC.id)
  assert.equal(customIdentity.embedding_spec_id, customSpec.id)
  assert.equal(customIdentity.chunker_id, customSpec.chunker_id)
  assert.equal(customIdentity.normalization_id, customSpec.normalization_id)
  assert.notEqual(customIdentity.chunk_key, defaultIdentity.chunk_key)
})

test("chunk keys are stable when unchanged text moves within a document", () => {
  const docPath = "trackA/task-1/doing.md"
  const before = chunkBody(["## Stable", "same body"].join("\n"))[0]
  const after = chunkBody([
    "## New preface",
    "new text shifts the stable chunk",
    "",
    "## Stable",
    "same body",
  ].join("\n")).find((chunk) => chunk.heading === "Stable")

  const beforeKey = keyOf({ docPath, chunk: before, embeddingSpec: ACTIVE_EMBEDDING_SPEC })
  const afterKey = keyOf({ docPath, chunk: after, embeddingSpec: ACTIVE_EMBEDDING_SPEC })
  const changedKey = keyOf({
    docPath,
    chunk: { ...after, text: `${after.text}\nchanged` },
    embeddingSpec: ACTIVE_EMBEDDING_SPEC,
  })

  assert.equal(afterKey, beforeKey)
  assert.notEqual(changedKey, beforeKey)
})

test("heading and spec identity changes produce distinct chunk keys", () => {
  const docPath = "trackA/task-1/doing.md"
  const original = chunkBody("## Original\n\nsame body")[0]
  const renamedHeading = chunkBody("## Renamed\n\nsame body")[0]
  const nextSpec = {
    ...ACTIVE_EMBEDDING_SPEC,
    id: `${ACTIVE_EMBEDDING_SPEC.id}-next`,
    normalization_id: `${ACTIVE_EMBEDDING_SPEC.normalization_id}-next`,
  }

  const originalKey = keyOf({ docPath, chunk: original })
  const headingKey = keyOf({ docPath, chunk: renamedHeading })
  const specKey = keyOf({ docPath, chunk: original, embeddingSpec: nextSpec })

  assert.notEqual(headingKey, originalKey)
  assert.notEqual(specKey, originalKey)
})
