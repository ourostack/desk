// chunk.test.js — golden splitting cases for the chunker.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { chunkBody } from "../../src/indexer/chunk.js"

test("empty / whitespace body yields zero chunks", () => {
  assert.deepEqual(chunkBody(), [])
  assert.deepEqual(chunkBody(""), [])
  assert.deepEqual(chunkBody("   \n\n  "), [])
})

test("single paragraph doc → one chunk, no heading", () => {
  const out = chunkBody("just a sentence, no headings here.")
  assert.equal(out.length, 1)
  assert.equal(out[0].index, 0)
  assert.equal(out[0].heading, null)
  assert.ok(out[0].text.includes("just a sentence"))
})

test("H2-bounded doc splits into one chunk per section + preamble", () => {
  const body = [
    "preamble paragraph",
    "",
    "## Section A",
    "alpha content",
    "",
    "## Section B",
    "beta content",
  ].join("\n")
  const out = chunkBody(body)
  assert.equal(out.length, 3)
  assert.equal(out[0].heading, null)
  assert.equal(out[1].heading, "Section A")
  assert.equal(out[2].heading, "Section B")
  // Indexes are dense + 0-based.
  assert.deepEqual(
    out.map((c) => c.index),
    [0, 1, 2],
  )
})

test("oversized section splits on paragraph boundary", () => {
  const big = "lorem ipsum dolor sit amet, ".repeat(40) // ~1120 chars
  const second = "second paragraph that is also reasonably long. ".repeat(15)
  const body = [
    "## Big section",
    big,
    "",
    second,
    "",
    "small trailing paragraph.",
  ].join("\n")
  const out = chunkBody(body)
  // The whole section is one heading but should produce multiple chunks
  // because the body crosses the 800-char threshold.
  assert.ok(out.length >= 2, `expected >=2 chunks, got ${out.length}`)
  // All chunks attached to the same heading.
  for (const c of out) {
    assert.equal(c.heading, "Big section")
  }
})

test("oversized single paragraph splits into embeddable chunks with source offsets", () => {
  const body = `## Transcript\n${"spoken-word ".repeat(400).trim()}`
  const out = chunkBody(body)

  assert.ok(out.length > 1, `expected multiple chunks, got ${out.length}`)
  for (const chunk of out) {
    assert.ok(chunk.text.length <= 800, `chunk length ${chunk.text.length} exceeds 800`)
    assert.equal(body.slice(chunk.start_offset, chunk.end_offset).trim(), chunk.text)
    assert.equal(chunk.heading, "Transcript")
  }
})

test("oversized prose splits without breaking Unicode surrogate pairs", () => {
  const body = `## Emoji\n${"😀".repeat(500)}`
  const out = chunkBody(body)

  assert.ok(out.length > 1, `expected multiple chunks, got ${out.length}`)
  for (const chunk of out) {
    assert.ok(chunk.text.length <= 800, `chunk length ${chunk.text.length} exceeds 800`)
    assert.equal(body.slice(chunk.start_offset, chunk.end_offset), chunk.text)
    for (let index = 0; index < chunk.text.length; index += 1) {
      const codeUnit = chunk.text.charCodeAt(index)
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = chunk.text.charCodeAt(index + 1)
        assert.ok(next >= 0xdc00 && next <= 0xdfff, "high surrogate must retain its low surrogate")
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        const previous = chunk.text.charCodeAt(index - 1)
        assert.ok(previous >= 0xd800 && previous <= 0xdbff, "low surrogate must retain its high surrogate")
      }
    }
  }
})

test("code fence is never split mid-fence", () => {
  // Build a fenced block that itself exceeds the threshold + a heading
  // before it so we know which section the fence lives in.
  const fence = ["```js", "x".repeat(900), "```"].join("\n")
  const body = ["## Has code", fence].join("\n")
  const out = chunkBody(body)
  // Even though the fence is huge, it must come out atomic — i.e., one
  // chunk contains both the opening and closing fence markers.
  const fenceChunks = out.filter(
    (c) => c.text.includes("```js") && c.text.endsWith("```"),
  )
  assert.equal(
    fenceChunks.length,
    1,
    `expected exactly one chunk to contain the full fence; got ${out.length} chunks`,
  )
})

test("indented backtick and tilde fences remain atomic when oversized", () => {
  for (const [opening, closing] of [
    ["   ```js", "   ```"],
    ["~~~js", "~~~"],
  ]) {
    const fence = [opening, "x".repeat(900), closing].join("\n")
    const body = ["## Has code", fence].join("\n")
    const out = chunkBody(body)
    const fenceChunks = out.filter(
      (chunk) => chunk.text.includes(opening) && chunk.text.endsWith(closing),
    )
    assert.equal(
      fenceChunks.length,
      1,
      `expected one atomic ${opening.trimStart()[0]} fence, got ${out.length} chunks`,
    )
  }
})

test("H2 lookalike inside code fence does not trigger split", () => {
  const body = [
    "## Real heading",
    "",
    "```",
    "## not a heading, still inside a fence",
    "more code",
    "```",
    "",
    "## Other heading",
    "tail",
  ].join("\n")
  const out = chunkBody(body)
  // We expect exactly 2 sections (the two real H2 headings), not 3.
  const headings = out.map((c) => c.heading)
  assert.deepEqual(headings.sort(), ["Other heading", "Real heading"].sort())
})

test("invalid backtick info strings do not suppress later H2 headings", () => {
  const body = [
    "## First",
    "```bad`info",
    "ordinary text",
    "## Second",
    "tail",
  ].join("\n")

  const out = chunkBody(body)

  assert.deepEqual(out.map((chunk) => chunk.heading), ["First", "Second"])
})

test("valid unclosed fences remain atomic through end of file", () => {
  const body = [
    "## First",
    "```text",
    "## still fenced",
    "x".repeat(900),
  ].join("\n")

  const out = chunkBody(body)

  assert.equal(out.length, 1)
  assert.equal(out[0].heading, "First")
  assert.equal(out[0].text, body)
})

test("oversized prose consumes trailing whitespace without emitting an empty chunk", () => {
  const body = `${"x".repeat(800)}   `
  const out = chunkBody(body)

  assert.equal(out.length, 1)
  assert.equal(out[0].text, "x".repeat(800))
})

test("oversized sections ignore repeated leading and trailing blank paragraphs", () => {
  const body = `\n\n${"word ".repeat(200)}\n\n`
  const out = chunkBody(body)

  assert.ok(out.length > 1)
  assert.equal(out[0].text.startsWith("word"), true)
  assert.equal(out.at(-1).text.endsWith("word"), true)
})

test("oversized prose handles repeated hard splits and standalone surrogate boundaries", () => {
  const repeated = chunkBody("x".repeat(1700))
  assert.deepEqual(repeated.map((chunk) => chunk.text.length), [800, 800, 100])

  const standaloneHighSurrogate = chunkBody(`${"x".repeat(799)}\ud800tail`)
  assert.equal(standaloneHighSurrogate[0].text.length, 800)
  assert.equal(standaloneHighSurrogate[0].text.charCodeAt(799), 0xd800)

  const pairedSurrogate = chunkBody(`a${"😀".repeat(500)}`)
  assert.equal(pairedSurrogate[0].text.length, 799)
  assert.equal(pairedSurrogate[1].text.startsWith("😀"), true)
})

test("mismatched and undersized closing fences remain inside the active fence", () => {
  for (const closing of ["~~~", "``"]) {
    const body = [
      "## First",
      "````text",
      closing,
      "## still fenced",
      "tail",
    ].join("\n")
    const out = chunkBody(body)
    assert.equal(out.length, 1)
    assert.equal(out[0].heading, "First")
  }
})
