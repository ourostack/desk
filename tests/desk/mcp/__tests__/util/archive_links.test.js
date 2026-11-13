import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { rewriteForMove } from "../../../../../plugins/desk/mcp/src/util/archive-links.js"

// The task `track/slug` moves to `track/_archive/slug`.
const SOURCE = "track/slug"
const DESTINATION = "track/_archive/slug"
const move = (filePath, text) => rewriteForMove({ text, filePath, sourcePrefix: SOURCE, destinationPrefix: DESTINATION })

test("archive links rewrites inline links out of the moved folder", () => {
  const result = move(
    "track/_archive/slug/brief.md",
    "See [notes](../other-task/notes.md) and [lessons](../../LESSONS.md#top).\n",
  )
  assert.equal(result.text, "See [notes](../../other-task/notes.md) and [lessons](../../../LESSONS.md#top).\n")
  assert.equal(result.rewritten, 2)
  assert.deepEqual(result.unresolved, [])
})

test("archive links rewrites inbound links and reference definitions into the moved folder", () => {
  const result = move(
    "track/other/x.md",
    "[card](../slug/brief.md#top) and [folder](../slug/)\n\n[ref]: ../slug/brief.md \"Title\"\n\nUse [it][ref].\n",
  )
  assert.equal(
    result.text,
    "[card](../_archive/slug/brief.md#top) and [folder](../_archive/slug/)\n\n[ref]: ../_archive/slug/brief.md \"Title\"\n\nUse [it][ref].\n",
  )
  assert.equal(result.rewritten, 3)
})

test("archive links keeps query strings and fragments and only touches destination spans", () => {
  const result = move("track/other/x.md", "[a](../slug/brief.md?view=raw#h) ![img](../slug/pic.png \"t\")\n")
  assert.equal(result.text, "[a](../_archive/slug/brief.md?view=raw#h) ![img](../_archive/slug/pic.png \"t\")\n")
})

test("archive links keeps angle-bracket destinations and their spaces", () => {
  const result = move("track/other/x.md", "[a](<../slug/my task.md>)\n")
  assert.equal(result.text, "[a](<../_archive/slug/my task.md>)\n")
})

test("archive links keeps a percent-encoded destination encoded", () => {
  const result = move("track/other/x.md", "[a](../slug/my%20task.md)\n")
  assert.equal(result.text, "[a](../_archive/slug/my%20task.md)\n")
})

test("archive links encodes a new segment only in a destination that was already percent-encoded", () => {
  const percent = rewriteForMove({ text: "[a](<../a%20b/x%20y.md>)\n", filePath: "track/other/x.md", sourcePrefix: "track/a b", destinationPrefix: "track/_archive/a b" })
  assert.equal(percent.text, "[a](<../_archive/a%20b/x%20y.md>)\n", "a reused segment keeps its original spelling")
  const introduced = rewriteForMove({ text: "[a](<../a%20b/x.md>)\n", filePath: "track/other/x.md", sourcePrefix: "track/a b", destinationPrefix: "track/_archive/a (b)" })
  assert.equal(introduced.text, "[a](<../_archive/a%20%28b%29/x.md>)\n")
  const newSegment = rewriteForMove({ text: "[a](<../src/x%20y.md>)\n", filePath: "track/other/x.md", sourcePrefix: "track/src", destinationPrefix: "track/arch (v2)/src" })
  assert.equal(newSegment.text, "[a](<../arch%20%28v2%29/src/x%20y.md>)\n")
})

test("archive links reports a new segment that the original plain form cannot hold, and leaves it unchanged", () => {
  const text = "[a](../src/x.md)\n"
  const result = rewriteForMove({ text, filePath: "track/other/x.md", sourcePrefix: "track/src", destinationPrefix: "track/arch (v2)/src" })
  assert.equal(result.text, text)
  assert.equal(result.rewritten, 0)
  assert.equal(result.unresolved.length, 1)
  assert.equal(result.unresolved[0].destination, "../src/x.md")
  assert.match(result.unresolved[0].reason, /cannot hold/u)
})

test("archive links rewrites links from a moved file to the desk root and to its sibling tasks", () => {
  const result = move("track/_archive/slug/research/a.md", "[up](../../../LESSONS.md) [sib](../../other/notes.md)\n")
  assert.equal(result.text, "[up](../../../../LESSONS.md) [sib](../../../other/notes.md)\n")
})

test("archive links rewrites a link from a moved file to a file inside the moved folder", () => {
  const result = move("track/_archive/slug/research/a.md", "[card](../task.md) [same](b.md) [self](../research/a.md)\n")
  assert.equal(result.text, "[card](../task.md) [same](b.md) [self](a.md)\n")
  assert.equal(result.rewritten, 1)
})

test("archive links reports a link whose target leaves the desk after the move", () => {
  const result = move("track/_archive/slug/brief.md", "[out](../../../../outside.md) [in](../other/x.md)\n")
  assert.equal(result.text, "[out](../../../../outside.md) [in](../../other/x.md)\n")
  assert.deepEqual(result.unresolved, [{ destination: "../../../../outside.md", reason: "the target is outside the desk after the move" }])
})

test("archive links leaves links that the move does not affect alone", () => {
  const text = "[out](../../../../outside.md) [other](../../other/x.md) [same](x.md)\n"
  const result = move("track/other/y.md", text)
  assert.equal(result.text, text)
  assert.equal(result.rewritten, 0)
  assert.deepEqual(result.unresolved, [])
})

test("archive links leaves code spans, external links, anchors and absolute paths alone", () => {
  const text = "`[c](../slug/brief.md)` [w](https://example.com/slug/brief.md) [m](mailto:a@b.c) [anchor](#top) [abs](/track/slug/brief.md) [q](?x=1) [e]()\n"
  const result = move("track/other/x.md", text)
  assert.equal(result.text, text)
  assert.equal(result.rewritten, 0)
})

test("archive links reports a destination that uses backslash escapes instead of guessing", () => {
  const result = move("track/other/x.md", "[e](../slug/a\\_b.md)\n")
  assert.equal(result.text, "[e](../slug/a\\_b.md)\n")
  assert.equal(result.unresolved.length, 1)
  assert.match(result.unresolved[0].reason, /escapes/u)
})

test("archive links returns the input text unchanged when a file has no relative links", () => {
  const text = "# Title\n\nNo links here, only https://example.com and `code [x](y)`.\r\n"
  const result = move("track/_archive/slug/brief.md", text)
  assert.equal(result.text, text)
  assert.equal(result.rewritten, 0)
  assert.deepEqual(result.unresolved, [])
})

test("archive links reports a file whose link parse runs out of work budget instead of rewriting part of it", () => {
  const text = "[a](../slug/x.md) " + "[a](".repeat(3000)
  const result = move("track/other/x.md", text)
  assert.equal(result.text, text)
  assert.equal(result.rewritten, 0)
  assert.equal(result.unresolved.length, 1)
  assert.match(result.unresolved[0].reason, /work budget/u)
})

test("archive links rejects a non-string text", () => {
  assert.throws(() => move("track/other/x.md", null), TypeError)
})

test("archive links leaves a link to the moved folder itself from inside it, and keeps a malformed percent escape readable", () => {
  const self = move("track/_archive/slug/brief.md", "[here](./)\n")
  assert.equal(self.text, "[here](./)\n")
  assert.equal(self.rewritten, 0)
  const odd = move("track/other/x.md", "[odd](../slug/100%.md)\n")
  assert.equal(odd.text, "[odd](../_archive/slug/100%.md)\n")
  assert.equal(odd.rewritten, 1)
})
