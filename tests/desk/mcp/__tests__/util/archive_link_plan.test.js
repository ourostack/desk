import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { planArchiveLinks as plan } from "../../../../../plugins/desk/mcp/src/util/archive-link-plan.js"

function doc(file, before, extra = {}) {
  return {
    path: file, before, mode: 0o644,
    identity: { dev: "1", ino: "9007199254740993", type: "regular_file" },
    version: { size: String(Buffer.byteLength(before)), mtimeNs: "1", ctimeNs: "1" },
    ancestry: [{ type: "directory", dev: "1", ino: "9007199254740995" }],
    ...extra,
  }
}

const base = {
  sourcePrefix: "t/moved", destinationPrefix: "t/_archive/moved", scopePrefix: "",
}
const entry = (file, type = "regular_file") => ({ path: file, type, ancestry: ["directory"] })

test("both directions keep exact intent rather than merely an existing target", () => {
  const answer = plan({
    ...base,
    documents: [
      doc("t/moved/task.md", "---\r\nraw: '../peer/notes.md'\r\n---\r\n" +
        '[peer](../peer/notes.md#proof "title")\r\n[sub](docs/detail.md)\r\n'),
      doc("t/peer/task.md", "[card](../moved/task.md#proof)\r\n"),
      doc("u/peer/task.md", "![attachment](../../t/moved/report%20(final).txt)\r\n"),
    ],
    entries: ["t/moved/task.md", "t/moved/docs/detail.md", "t/moved/report (final).txt",
      "t/peer/notes.md", "t/_archive/peer/notes.md"].map(file => entry(file)),
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.coverage, "supplied_inventory_only")
  const files = new Map(answer.files.map(file => [file.beforePath, file]))
  assert.equal(files.get("t/moved/task.md").afterPath, "t/_archive/moved/task.md")
  assert.equal(files.get("t/moved/task.md").after,
    "---\r\nraw: '../peer/notes.md'\r\n---\r\n" +
    '[peer](../../peer/notes.md#proof "title")\r\n[sub](docs/detail.md)\r\n')
  assert.equal(files.get("t/peer/task.md").after, "[card](../_archive/moved/task.md#proof)\r\n")
  assert.equal(files.get("u/peer/task.md").after,
    "![attachment](../../t/_archive/moved/report%20(final).txt)\r\n")
  for (const file of answer.files) {
    for (const patch of file.patches) {
      assert.equal(file.before.slice(patch.start, patch.end), patch.raw)
      assert.equal(Buffer.from(file.before).subarray(patch.byteStart, patch.byteEnd).toString(), patch.raw)
    }
  }
  assert.ok(answer.links.every(link =>
    path.posix.normalize(path.posix.join(path.posix.dirname(link.newOwner), link.newPath)) === link.newTarget))
  assert.equal(answer.currentness.requiresLiveReadback, true)
})

test("internal and non-filesystem references retain every byte", () => {
  const before = "[internal](./docs/detail.md#proof) [fragment](#proof) " +
    "[web](https://example.test/t/moved/task.md) [custom](desk:task/one) " +
    "[absolute](/t/moved/task.md)\r\n`[code](../peer/notes.md)`\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", before)],
    entries: [entry("t/moved/docs/detail.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, before)
  assert.deepEqual(answer.files[0].patches, [])
})

test("reference definitions, escaped parentheses and angle spaces retain source style", () => {
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md",
      "[ref] ![ref]\r\n\r\n[ref]: <../peer/report (final).md#proof> 'title'\r\n" +
      "[escaped](../peer/report\\(final\\).md)\r\n")],
    entries: [entry("t/peer/report (final).md"), entry("t/peer/report(final).md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "[ref] ![ref]\r\n\r\n[ref]: <../../peer/report (final).md#proof> 'title'\r\n" +
    "[escaped](../../peer/report\\(final\\).md)\r\n")
  assert.equal(answer.files[0].patches.length, 2)
})

test("Unicode reference labels retain distinct targets under full case folding", () => {
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md",
      "[I] [\u0131]\n\n[I]: ../peer/one.md\n[\u0131]: ../peer/two.md\n")],
    entries: [entry("t/peer/one.md"), entry("t/peer/two.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "[I] [\u0131]\n\n[I]: ../../peer/one.md\n[\u0131]: ../../peer/two.md\n")
  assert.equal(answer.links.length, 2)
})

test("full-fold Unicode aliases cannot hide a used reference definition", () => {
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", "[STRASSE]\n\n[STRA\u1e9eE]: ../peer/notes.md\n")],
    entries: [entry("t/peer/notes.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, "[STRASSE]\n\n[STRA\u1e9eE]: ../../peer/notes.md\n")
})

test("container reference definitions produce destination-only UTF-8 byte patches", () => {
  const before = "\u{1f600}\r\n[ref][ref] [ref][] [ref] ![ref]\r\n" +
    '> [ref]: <../peer/notes.md#proof> "title"\r\n'
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/notes.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n[ref][ref] [ref][] [ref] ![ref]\r\n" +
    '> [ref]: <../../peer/notes.md#proof> "title"\r\n')
  assert.equal(answer.files[0].patches.length, 1)
  const patch = answer.files[0].patches[0]
  assert.equal(patch.start, before.indexOf("../peer/notes"))
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/notes.md#proof")
})

test("inverse nesting preserves prefixes, UTF-8 bounds and the intended target", () => {
  const before = "\u{1f600}\r\n[label][ref]\r\n\r\n- > [ref]: <../peer/notes.md#proof> \"title\"\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/notes.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n[label][ref]\r\n\r\n- > [ref]: <../../peer/notes.md#proof> \"title\"\r\n")
  assert.equal(answer.files[0].patches.length, 1)
  const patch = answer.files[0].patches[0]
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/notes.md#proof")
})

test("an interrupted definition never edits the decoy or hides the valid target's byte patch", () => {
  const before = "[ref]:\r\n> ../peer/wrong.md\r\n\r\n[ref]: ../peer/right.md#proof\r\n\r\n[label][ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/wrong.md"), entry("t/peer/right.md"), entry("t/_archive/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "[ref]:\r\n> ../peer/wrong.md\r\n\r\n[ref]: ../../peer/right.md#proof\r\n\r\n[label][ref]\r\n")
  assert.equal(answer.links.length, 1)
  assert.equal(answer.links[0].oldTarget, "t/peer/right.md")
  assert.equal(answer.files[0].patches[0].start, before.indexOf("../peer/right.md"))
})

for (const prefix of ["> Text\r\n", "===\r\n"]) {
  test(`paragraph state after ${JSON.stringify(prefix)} preserves the decoy and patches only the valid definition`, () => {
    const before = `${prefix}[ref]: ../peer/wrong.md\r\n\r\n[ref]: ../peer/right.md#proof\r\n\r\n[label][ref]\r\n`
    const answer = plan({
      ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
      entries: [entry("t/peer/wrong.md"), entry("t/peer/right.md")],
    })
    assert.deepEqual(answer.refusals, [])
    assert.equal(answer.files[0].after,
      `${prefix}[ref]: ../peer/wrong.md\r\n\r\n[ref]: ../../peer/right.md#proof\r\n\r\n[label][ref]\r\n`)
    assert.equal(answer.links[0].oldTarget, "t/peer/right.md")
  })
}

test("empty angle definitions preserve consecutive eligibility and the first valid target", () => {
  const before = "[empty]: <>\r\n[ref]: ../peer/right.md#proof\r\n[ref]: ../peer/wrong.md\r\n\r\n[empty] [ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md"), entry("t/peer/wrong.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "[empty]: <>\r\n[ref]: ../../peer/right.md#proof\r\n[ref]: ../peer/wrong.md\r\n\r\n[empty] [ref]\r\n")
  assert.equal(answer.files[0].patches.length, 1)
})

test("code immediately after a heading is byte-identical and requires no target inventory", () => {
  const before = "# Heading\r\n    [code](../peer/wrong.md)\r\n[real](../peer/right.md#proof)\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, "# Heading\r\n    [code](../peer/wrong.md)\r\n" +
    "[real](../../peer/right.md#proof)\r\n")
})

test("compatible ordered-sibling definitions yield exact UTF-8 byte and target patches", () => {
  const before = "\u{1f600}\r\n1. Text\r\n2. [ref]: ../peer/right.md#proof\r\n\r\n[label][ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md"), entry("t/_archive/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n1. Text\r\n2. [ref]: ../../peer/right.md#proof\r\n\r\n[label][ref]\r\n")
  assert.equal(answer.links.length, 1)
  assert.equal(answer.links[0].oldTarget, "t/peer/right.md")
  assert.equal(answer.links[0].newTarget, "t/peer/right.md")
  const patch = answer.files[0].patches[0]
  assert.equal(patch.start, before.indexOf("../peer/right.md#proof"))
  assert.equal(patch.byteStart, patch.start + 2)
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/right.md#proof")
})

test("outer quote failure preserves a new root ordered definition's bytes and target identity data", () => {
  const before = "\u{1f600}\r\n> 1. Text\r\n2. [ref]: ../peer/right.md#proof\r\n\r\n[label][ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md"), entry("t/_archive/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n> 1. Text\r\n2. [ref]: ../../peer/right.md#proof\r\n\r\n[label][ref]\r\n")
  assert.equal(answer.links.length, 1)
  assert.equal(answer.links[0].oldTarget, "t/peer/right.md")
  assert.equal(answer.links[0].newTarget, "t/peer/right.md")
  const patch = answer.files[0].patches[0]
  assert.equal(patch.start, before.indexOf("../peer/right.md#proof"))
  assert.equal(patch.byteStart, patch.start + 2)
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/right.md#proof")
})

test("type7-looking tags preserve lazy prose and exact destination-only byte patches", () => {
  const before = "\u{1f600}\r\n> Text\r\n<custom>\r\n[x](../peer/right.md#proof)\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md"), entry("t/_archive/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n> Text\r\n<custom>\r\n[x](../../peer/right.md#proof)\r\n")
  assert.equal(answer.links.length, 1)
  assert.equal(answer.links[0].oldTarget, "t/peer/right.md")
  assert.equal(answer.links[0].newTarget, "t/peer/right.md")
  const patch = answer.files[0].patches[0]
  assert.equal(patch.start, before.indexOf("../peer/right.md#proof"))
  assert.equal(patch.byteStart, patch.start + 2)
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/right.md#proof")
})

test("type7-looking quoted reference destinations preserve an internal target that moves with its owner", () => {
  const before = "> [ref]:\r\n<custom>\r\n\r\n[label][ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/moved/custom")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, before)
  assert.deepEqual(answer.files[0].patches, [])
  assert.equal(answer.links.length, 1)
  assert.equal(answer.links[0].oldTarget, "t/moved/custom")
  assert.equal(answer.links[0].newTarget, "t/_archive/moved/custom")
})

test("complete unused definitions keep lazy type7 link intent and original byte bounds", () => {
  const before = "\u{1f600}\r\n> [ref]: unused.md\r\n<custom>\r\n[x](../peer/right.md#proof)\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md"), entry("t/_archive/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n> [ref]: unused.md\r\n<custom>\r\n[x](../../peer/right.md#proof)\r\n")
  assert.equal(answer.links.length, 1)
  assert.equal(answer.links[0].oldTarget, "t/peer/right.md")
  assert.equal(answer.links[0].newTarget, "t/peer/right.md")
  const patch = answer.files[0].patches[0]
  assert.equal(patch.start, before.indexOf("../peer/right.md#proof"))
  assert.equal(patch.byteStart, patch.start + 2)
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/right.md#proof")
})

test("nonblank indented links after definitions require both real destination patches", () => {
  const before = "\u{1f600}\r\n\r\n[ref]: ../peer/right.md\r\n    [code](../peer/wrong.md)\r\n[ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md"), entry("t/peer/wrong.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n\r\n[ref]: ../../peer/right.md\r\n    [code](../../peer/wrong.md)\r\n[ref]\r\n")
  assert.deepEqual(answer.links.map(link => link.oldTarget), ["t/peer/right.md", "t/peer/wrong.md"])
  assert.equal(answer.files[0].patches.length, 2)
  for (const patch of answer.files[0].patches) {
    assert.equal(patch.byteStart, patch.start + 2)
    assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), patch.raw)
  }
})

test("a missing indented-link target after a definition produces an explicit refusal", () => {
  const before = "[ref]: ../peer/right.md\r\n    [code](../peer/wrong.md)\r\n[ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", before)],
    entries: [entry("t/peer/right.md")],
  })
  assert.ok(answer.refusals.some(refusal =>
    refusal.code === "target_unqualified" && refusal.start === before.indexOf("../peer/wrong.md")))
})

test("a definition followed by a blank preserves literal code without code-target inventory", () => {
  const before = "[ref]: ../peer/right.md\r\n\r\n    [code](../peer/wrong.md)\r\n[ref]\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", before)],
    entries: [entry("t/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "[ref]: ../../peer/right.md\r\n\r\n    [code](../peer/wrong.md)\r\n[ref]\r\n")
  assert.equal(answer.files[0].patches.length, 1)
})

for (const prefix of ["Text ", "[unused]: unused.md\r\n    Text "]) {
  test(`literal unclosed inline comments after ${JSON.stringify(prefix)} preserve real byte/target patches`, () => {
    const before = `\u{1f600}\r\n\r\n${prefix}<!-- [x](../peer/right.md#proof)\r\n`
    const answer = plan({
      ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
      entries: [entry("t/peer/right.md"), entry("t/_archive/peer/right.md")],
    })
    assert.deepEqual(answer.refusals, [])
    assert.equal(answer.files[0].after,
      `\u{1f600}\r\n\r\n${prefix}<!-- [x](../../peer/right.md#proof)\r\n`)
    assert.equal(answer.links.length, 1)
    assert.equal(answer.links[0].oldTarget, "t/peer/right.md")
    assert.equal(answer.links[0].newTarget, "t/peer/right.md")
    const patch = answer.files[0].patches[0]
    assert.equal(patch.start, before.indexOf("../peer/right.md#proof"))
    assert.equal(patch.byteStart, patch.start + 2)
    assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/right.md#proof")
  })
}

test("missing real targets after literal inline comments are explicitly unqualified", () => {
  const before = "[unused]: unused.md\r\n    Text <!-- [x](../peer/right.md)\r\n"
  const answer = plan({ ...base, documents: [doc("t/moved/task.md", before)], entries: [] })
  assert.ok(answer.refusals.some(refusal =>
    refusal.code === "target_unqualified" && refusal.start === before.indexOf("../peer/right.md")))
})

test("real block comments through EOF stay literal without target inventory", () => {
  const before = "<!-- unfinished\r\n[x](../peer/right.md)\r\n"
  const answer = plan({ ...base, documents: [doc("t/moved/task.md", before)], entries: [] })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, before)
  assert.deepEqual(answer.files[0].patches, [])
  assert.deepEqual(answer.links, [])
})

for (const [first, afterFirst, tail, file] of [
  ['[a](../peer/a.md "<!--")', '[a](../../peer/a.md "<!--")', "", "a.md"],
  ['[a](../peer/a.md "`")', '[a](../../peer/a.md "`")', " `", "a.md"],
  ["[a](../peer/<!--.md)", "[a](../../peer/<!--.md)", "", "<!--.md"],
]) {
  test(`literal destination/title syntax ${JSON.stringify(first)} preserves both destination-only byte patches`, () => {
    const before = `\u{1f600} ${first} [b](../peer/b.md)${tail}\r\n`
    const answer = plan({
      ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
      entries: [entry(`t/peer/${file}`), entry("t/peer/b.md")],
    })
    assert.deepEqual(answer.refusals, [])
    assert.equal(answer.files[0].after, `\u{1f600} ${afterFirst} [b](../../peer/b.md)${tail}\r\n`)
    assert.equal(answer.links.length, 2)
    assert.deepEqual(answer.links.map(link => link.oldTarget), [`t/peer/${file}`, "t/peer/b.md"])
    assert.equal(answer.files[0].patches.length, 2)
    for (const patch of answer.files[0].patches) {
      assert.equal(patch.byteStart, patch.start + 2)
      assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), patch.raw)
    }
  })
}

for (const supplyTarget of [false, true]) {
  test(`cross-block nonlink text is unchanged with target inventory ${supplyTarget}`, () => {
    const before = "[x\r\n\r\n](../peer/wrong.md)\r\n"
    const answer = plan({
      ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
      entries: supplyTarget ? [entry("t/peer/wrong.md")] : [],
    })
    assert.deepEqual(answer.refusals, [])
    assert.equal(answer.files[0].after, before)
    assert.deepEqual(answer.files[0].patches, [])
    assert.deepEqual(answer.links, [])
  })
}

test("a real multiline quote link retains prefixes, title and destination-only byte bounds", () => {
  const before = "\u{1f600}\r\n> [multi\r\n> label](<../peer/right.md#proof> \"unchanged title\")\r\n"
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
    entries: [entry("t/peer/right.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "\u{1f600}\r\n> [multi\r\n> label](<../../peer/right.md#proof> \"unchanged title\")\r\n")
  const patch = answer.files[0].patches[0]
  assert.equal(patch.start, before.indexOf("../peer/right.md#proof"))
  assert.equal(patch.byteStart, patch.start + 2)
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/right.md#proof")
})

test("external autolinks remain byte-identical without requiring local target inventory", () => {
  const before = "<https://example.test/[x](../peer/notes.md)>\r\n"
  const answer = plan({ ...base, documents: [doc("t/moved/task.md", Buffer.from(before))], entries: [] })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, before)
  assert.deepEqual(answer.files[0].patches, [])
})

for (const comment of ["<!-->", "<!--->"]) {
  test(`a real link after ${comment} retains exact source and byte bounds in the plan`, () => {
    const before = `\u{1f600} Text ${comment} [x](../peer/notes.md#proof)\r\n`
    const answer = plan({
      ...base, documents: [doc("t/moved/task.md", Buffer.from(before))],
      entries: [entry("t/peer/notes.md")],
    })
    assert.deepEqual(answer.refusals, [])
    assert.equal(answer.files[0].after, `\u{1f600} Text ${comment} [x](../../peer/notes.md#proof)\r\n`)
    const patch = answer.files[0].patches[0]
    assert.equal(patch.start, before.indexOf("../peer/notes"))
    assert.equal(patch.byteStart, patch.start + 2)
    assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), "../peer/notes.md#proof")
  })
}

test("encoded filename fragments are not mistaken for URL fragments", () => {
  const answer = plan({
    ...base,
    documents: [doc("t/moved/task.md", "[x](../peer/a%23b.md?view=1#proof)")],
    entries: [entry("t/peer/a#b.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, "[x](../../peer/a%23b.md?view=1#proof)")
})

for (const [name, changes, expectedCode] of [
  ["foreign document", { scopePrefix: "desks/a", sourcePrefix: "desks/a/t/moved",
    destinationPrefix: "desks/a/t/_archive/moved",
    documents: [doc("desks/b/task.md", "[x](../a/t/moved/task.md)")] }, "document_outside_scope"],
  ["symlink document", { documents: [doc("t/peer/task.md", "[x](../moved/task.md)",
    { identity: { dev: "1", ino: "2", type: "symlink" } })] }, "document_not_regular"],
  ["symlink ancestry", { documents: [doc("t/peer/task.md", "[x](../moved/task.md)",
    { ancestry: [{ type: "symlink", dev: "1", ino: "2" }] })] }, "unsafe_ancestry"],
  ["stale input size", { documents: [doc("t/peer/task.md", "[x](../moved/task.md)",
    { version: { size: "0", mtimeNs: "1", ctimeNs: "1" } })] }, "input_version_mismatch"],
  ["malformed URI encoding", { documents: [doc("t/peer/task.md", "[x](../moved/bad%ZZ.md)")] },
    "invalid_encoding"],
  ["encoded path separator", { documents: [doc("t/peer/task.md", "[x](../moved/a%2Fb.md)")] },
    "encoded_separator"],
  ["unqualified target", { entries: [] }, "target_unqualified"],
  ["symlink target", { entries: [entry("t/moved/task.md", "symlink")] }, "target_not_regular"],
]) {
  test(`${name} is explicitly refused without filesystem repair`, () => {
    const answer = plan({
      ...base, documents: [doc("t/peer/task.md", "[x](../moved/task.md)")],
      entries: [entry("t/moved/task.md")], ...changes,
    })
    assert.ok(answer.refusals.some(refusal => refusal.code === expectedCode), JSON.stringify(answer.refusals))
    assert.equal(answer.currentness.requiresLiveReadback, true)
  })
}

test("planning is deterministic, input-preserving and JSON data rather than authority", () => {
  const input = {
    ...base, documents: [doc("t/peer/task.md", "[x](../moved/task.md)")],
    entries: [entry("t/moved/task.md")],
  }
  const before = structuredClone(input)
  const first = plan(input)
  assert.deepEqual(first, plan(input))
  assert.deepEqual(input, before)
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
  assert.equal(first.currentness.requiresLiveReadback, true)
})

test("unaffected links in other documents need no repair or target discovery", () => {
  const answer = plan({
    ...base,
    documents: [doc("t/peer/task.md",
      "[unrelated](../missing/file.md)\r\n[affected](../moved/task.md)\r\n")],
    entries: [entry("t/moved/task.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after,
    "[unrelated](../missing/file.md)\r\n[affected](../_archive/moved/task.md)\r\n")
})

test("directory targets and a leading dot/trailing slash retain spelling", () => {
  const answer = plan({
    ...base, documents: [doc("t/track.md", "[folder](./moved/#proof)\r\n")],
    entries: [entry("t/moved", "directory")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, "[folder](./_archive/moved/#proof)\r\n")
})

test("a supplied foreign target does not grant writes to a foreign document", () => {
  const answer = plan({
    sourcePrefix: "desks/a/t/moved", destinationPrefix: "desks/a/t/_archive/moved", scopePrefix: "desks/a",
    documents: [doc("desks/a/t/moved/task.md", "[target](../../../b/other.md)")],
    entries: [entry("desks/b/other.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, "[target](../../../../b/other.md)")
  assert.equal(answer.files[0].afterPath, "desks/a/t/_archive/moved/task.md")
  assert.equal(answer.files.length, 1)
})

test("opaque or non-JSON metadata is not propagated into a plan", () => {
  const record = doc("t/peer/task.md", "[x](../moved/task.md)")
  record.identity.callerObject = { secretCapability: 1n }
  record.version.callerObject = { unexpected: 2n }
  const answer = plan({ ...base, documents: [record], entries: [entry("t/moved/task.md")] })
  assert.deepEqual(answer.refusals, [])
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), answer)
  assert.deepEqual(Object.keys(answer.files[0].identity).sort(), ["dev", "ino", "type"])
})

for (const destination of ["c:/private/file.md", "D:\\private\\file.md", "..\\moved\\task.md"]) {
  test(`ambiguous drive/backslash reference ${destination} is refused`, () => {
    const answer = plan({
      ...base, documents: [doc("t/peer/task.md", `[x](${destination})`)],
      entries: [entry("t/moved/task.md")],
    })
    assert.ok(answer.refusals.some(refusal =>
      ["ambiguous_drive_reference", "ambiguous_separator"].includes(refusal.code)), JSON.stringify(answer.refusals))
  })
}

test("astral characters adjacent to destination bounds have lossless UTF-8 offsets", () => {
  const before = "\u{1f600}[x](../moved/\u{1f600}%20file.md#\u{1f600})\r\n"
  const answer = plan({
    ...base, documents: [doc("t/peer/task.md", before)],
    entries: [entry("t/moved/\u{1f600} file.md")],
  })
  assert.deepEqual(answer.refusals, [])
  const file = answer.files[0], patch = file.patches[0]
  assert.equal(patch.start, 6)
  assert.equal(patch.byteStart, 8)
  assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(),
    "../moved/\u{1f600}%20file.md#\u{1f600}")
  assert.equal(file.after, "\u{1f600}[x](../_archive/moved/\u{1f600}%20file.md#\u{1f600})\r\n")
})

for (const destination of ["../moved/bad%FF.md", "../moved/bad%ED%A0%80.md", "../moved/bad%C0%AF.md"]) {
  test(`unknown or invalid UTF-8 encoding ${destination} is refused`, () => {
    const answer = plan({
      ...base, documents: [doc("t/peer/task.md", `[x](${destination})`)],
      entries: [],
    })
    assert.ok(answer.refusals.some(refusal => refusal.code === "invalid_encoding"))
  })
}

test("unpaired surrogate source text is rejected without lossy conversion", () => {
  const answer = plan({
    ...base, documents: [doc("t/peer/task.md", "\ud800[x](../moved/task.md)")],
    entries: [entry("t/moved/task.md")],
  })
  assert.ok(answer.refusals.some(refusal => refusal.code === "invalid_utf8_input"))
  assert.deepEqual(answer.files, [])
})

test("exact supplied UTF-8 bytes retain their BOM and metadata while mapping destination bytes", () => {
  const before = Buffer.from("\uFEFF---\r\nraw: '[fake](../moved/missing.md)'\r\n---\r\n" +
    "\u{1f600}[x](../moved/\u{1f600}%20file.md#proof)\r\n")
  const answer = plan({
    ...base, documents: [doc("t/peer/task.md", before)],
    entries: [entry("t/moved/\u{1f600} file.md")],
  })
  assert.deepEqual(answer.refusals, [])
  assert.deepEqual(Buffer.from(answer.files[0].before), before)
  assert.deepEqual(Buffer.from(answer.files[0].after),
    Buffer.from("\uFEFF---\r\nraw: '[fake](../moved/missing.md)'\r\n---\r\n" +
      "\u{1f600}[x](../_archive/moved/\u{1f600}%20file.md#proof)\r\n"))
})

test("malformed supplied UTF-8 bytes refuse rather than becoming replacement characters", () => {
  const before = Buffer.from([0xed, 0xa0, 0x80])
  const answer = plan({
    ...base, documents: [doc("t/peer/task.md", before)], entries: [],
  })
  assert.ok(answer.refusals.some(refusal => refusal.code === "invalid_utf8_input"))
  assert.deepEqual(answer.files, [])
})

test("a drive-shaped move prefix is refused as non-desk-relative data", () => {
  const answer = plan({
    sourcePrefix: "c:/t/moved", destinationPrefix: "c:/t/_archive/moved", scopePrefix: "",
    documents: [], entries: [],
  })
  assert.ok(answer.refusals.some(refusal => refusal.code === "invalid_move_prefix"))
})

test("an incomplete extraction explicitly blocks the plan", () => {
  const answer = plan({
    ...base, documents: [doc("t/moved/task.md", "[x](".repeat(200))], entries: [],
  })
  assert.ok(answer.refusals.some(refusal => refusal.code === "parse_budget_exceeded"))
})

test("the plan performs no filesystem, process or network IO", () => {
  const restored = []
  const deny = (object, names) => {
    for (const name of names) {
      restored.push([object, name, object[name]])
      object[name] = () => { throw new Error("Pure archive-link planning attempted IO") }
    }
  }
  let answer
  try {
    deny(fs, ["readFileSync", "writeFileSync", "openSync", "statSync", "lstatSync", "readdirSync", "renameSync"])
    deny(fs.promises, ["readFile", "writeFile", "open", "stat", "lstat", "readdir", "rename"])
    deny(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"])
    deny(globalThis, ["fetch"])
    syncBuiltinESMExports()
    answer = plan({
      ...base, documents: [doc("t/peer/task.md", "[x](../moved/task.md)")],
      entries: [entry("t/moved/task.md")],
    })
  } finally {
    for (const [object, name, original] of restored) object[name] = original
    syncBuiltinESMExports()
  }
  assert.deepEqual(answer.refusals, [])
  assert.equal(answer.files[0].after, "[x](../_archive/moved/task.md)")
})

test("owned synthetic documents preserve target identity and every unrelated byte after applying the data plan", async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "desk-link-plan-oracle-"))
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true })
    await assert.rejects(fs.promises.access(root), { code: "ENOENT" })
  })
  const safe = relative => {
    const absolute = path.resolve(root, relative)
    assert.ok(absolute.startsWith(`${root}${path.sep}`), "the oracle only writes its owned fixture")
    return absolute
  }
  const metadata = "---\r\nraw: '../peer-a/notes.md'\r\ncustom: 'unchanged'\r\n---\r\n"
  const inputFiles = new Map([
    ["t/moved/task.md", metadata +
      '[peer](../peer-a/notes.md#proof "title")\r\n[sub](docs/detail.md)\r\n'],
    ["t/moved/docs/detail.md", "[external](../../peer-a/notes.md#proof)\r\n"],
    ["t/moved/containers.md", "\u{1f600}\r\n[ref][ref] [ref][] [ref]\r\n" +
      '> [ref]: <../peer-a/notes.md#proof> "title"\r\n'],
    ["t/moved/autolinks.md", "<https://example.test/[x](../peer-a/notes.md)>\r\n" +
      "[real](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/comments.md", "Text <!--> [one](../peer-a/notes.md#proof)\r\n" +
      "Text <!---> [two](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/nested.md", "[ref]\r\n\r\n- > [ref]: <../peer-a/notes.md#proof> \"title\"\r\n"],
    ["t/moved/interrupted.md", "[ref]:\r\n> ../peer-a/wrong.md\r\n\r\n" +
      "[ref]: ../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/moved/lazy.md", "> Text\r\n[ref]: ../peer-a/wrong.md\r\n\r\n" +
      "[ref]: ../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/moved/equals.md", "===\r\n[ref]: ../peer-a/wrong.md\r\n\r\n" +
      "[ref]: ../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/moved/empty.md", "[empty]: <>\r\n[ref]: ../peer-a/notes.md#proof\r\n" +
      "[ref]: ../peer-a/wrong.md\r\n\r\n[empty] [ref]\r\n"],
    ["t/moved/heading.md", "# Heading\r\n    [code](../peer-a/wrong.md)\r\n" +
      "[real](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/ordered.md", "\u{1f600}\r\n1. Text\r\n2. [ref]: ../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/moved/nonlinks.md", "[x\r\n\r\n](../peer-a/wrong.md)\r\n\r\n" +
      "[x\r\n# Heading\r\n](../peer-a/wrong.md)\r\n\r\n[real](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/multiline.md", "\u{1f600}\r\n> [multi\r\n> label](<../peer-a/notes.md#proof> \"title\")\r\n"],
    ["t/moved/outer.md", "> 1. Text\r\n2. [ref]: ../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/moved/title-syntax.md", '[a](../peer-a/notes.md "<!--") [b](../peer-a/second.md)\r\n'],
    ["t/moved/destination-syntax.md", "[a](../peer-a/`notes.md) [b](../peer-a/second.md) `\r\n"],
    ["t/moved/lazy-type7.md", "\u{1f600}\r\n> Text\r\n<custom>\r\n[x](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/definition-type7.md", "> [ref]:\r\n<custom>\r\n\r\n[label][ref]\r\n"],
    ["t/moved/custom", "Internal type7-looking destination.\n"],
    ["t/moved/complete-definition.md", "> [ref]: unused.md\r\n<custom>\r\n[x](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/definition-indented.md", "[ref]: ../peer-a/notes.md\r\n    [code](../peer-a/wrong.md)\r\n[ref]\r\n"],
    ["t/moved/definition-code.md", "[ref]: ../peer-a/notes.md\r\n\r\n    [code](../peer-a/wrong.md)\r\n[ref]\r\n"],
    ["t/moved/inline-comment.md", "Text <!-- [x](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/definition-inline-comment.md", "[unused]: unused.md\r\n    Text <!-- [x](../peer-a/notes.md#proof)\r\n"],
    ["t/moved/block-comment.md", "<!-- unfinished\r\n[x](../peer-a/wrong.md)\r\n"],
    ["t/moved/report (final).txt", "Attachment bytes.\n"],
    ["t/peer-a/task.md", "[card](../moved/task.md#proof)\r\n[brief]\r\n\r\n" +
      '[brief]: ../moved/docs/detail.md "title"\r\n'],
    ["u/peer-b/task.md", "![attachment](../../t/moved/report%20(final).txt)\r\n"],
    ["t/peer-a/notes.md", "Real target bytes.\n"],
    ["t/peer-a/second.md", "Second literal-syntax target.\n"],
    ["t/peer-a/`notes.md", "Backtick filename target.\n"],
    ["t/peer-a/wrong.md", "Wrong definition decoy.\n"],
    ["t/_archive/peer-a/notes.md", "Existing wrong-location decoy.\n"],
    ["unrelated.md", "---\r\nraw: t/moved/task.md\r\n---\r\n" +
      "`[example](t/moved/task.md)`\r\n[web](https://example.test/t/moved/task.md)\r\n"],
  ])
  const expectedFiles = new Map([
    ["t/_archive/moved/task.md", metadata +
      '[peer](../../peer-a/notes.md#proof "title")\r\n[sub](docs/detail.md)\r\n'],
    ["t/_archive/moved/docs/detail.md", "[external](../../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/containers.md", "\u{1f600}\r\n[ref][ref] [ref][] [ref]\r\n" +
      '> [ref]: <../../peer-a/notes.md#proof> "title"\r\n'],
    ["t/_archive/moved/autolinks.md", "<https://example.test/[x](../peer-a/notes.md)>\r\n" +
      "[real](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/comments.md", "Text <!--> [one](../../peer-a/notes.md#proof)\r\n" +
      "Text <!---> [two](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/nested.md", "[ref]\r\n\r\n- > [ref]: <../../peer-a/notes.md#proof> \"title\"\r\n"],
    ["t/_archive/moved/interrupted.md", "[ref]:\r\n> ../peer-a/wrong.md\r\n\r\n" +
      "[ref]: ../../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/_archive/moved/lazy.md", "> Text\r\n[ref]: ../peer-a/wrong.md\r\n\r\n" +
      "[ref]: ../../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/_archive/moved/equals.md", "===\r\n[ref]: ../peer-a/wrong.md\r\n\r\n" +
      "[ref]: ../../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/_archive/moved/empty.md", "[empty]: <>\r\n[ref]: ../../peer-a/notes.md#proof\r\n" +
      "[ref]: ../peer-a/wrong.md\r\n\r\n[empty] [ref]\r\n"],
    ["t/_archive/moved/heading.md", "# Heading\r\n    [code](../peer-a/wrong.md)\r\n" +
      "[real](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/ordered.md", "\u{1f600}\r\n1. Text\r\n2. [ref]: ../../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/_archive/moved/nonlinks.md", "[x\r\n\r\n](../peer-a/wrong.md)\r\n\r\n" +
      "[x\r\n# Heading\r\n](../peer-a/wrong.md)\r\n\r\n[real](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/multiline.md", "\u{1f600}\r\n> [multi\r\n> label](<../../peer-a/notes.md#proof> \"title\")\r\n"],
    ["t/_archive/moved/outer.md", "> 1. Text\r\n2. [ref]: ../../peer-a/notes.md#proof\r\n\r\n[label][ref]\r\n"],
    ["t/_archive/moved/title-syntax.md", '[a](../../peer-a/notes.md "<!--") [b](../../peer-a/second.md)\r\n'],
    ["t/_archive/moved/destination-syntax.md", "[a](../../peer-a/`notes.md) [b](../../peer-a/second.md) `\r\n"],
    ["t/_archive/moved/lazy-type7.md", "\u{1f600}\r\n> Text\r\n<custom>\r\n[x](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/definition-type7.md", "> [ref]:\r\n<custom>\r\n\r\n[label][ref]\r\n"],
    ["t/_archive/moved/custom", "Internal type7-looking destination.\n"],
    ["t/_archive/moved/complete-definition.md", "> [ref]: unused.md\r\n<custom>\r\n[x](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/definition-indented.md", "[ref]: ../../peer-a/notes.md\r\n    [code](../../peer-a/wrong.md)\r\n[ref]\r\n"],
    ["t/_archive/moved/definition-code.md", "[ref]: ../../peer-a/notes.md\r\n\r\n    [code](../peer-a/wrong.md)\r\n[ref]\r\n"],
    ["t/_archive/moved/inline-comment.md", "Text <!-- [x](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/definition-inline-comment.md", "[unused]: unused.md\r\n    Text <!-- [x](../../peer-a/notes.md#proof)\r\n"],
    ["t/_archive/moved/block-comment.md", "<!-- unfinished\r\n[x](../peer-a/wrong.md)\r\n"],
    ["t/_archive/moved/report (final).txt", "Attachment bytes.\n"],
    ["t/peer-a/task.md", "[card](../_archive/moved/task.md#proof)\r\n[brief]\r\n\r\n" +
      '[brief]: ../_archive/moved/docs/detail.md "title"\r\n'],
    ["u/peer-b/task.md", "![attachment](../../t/_archive/moved/report%20(final).txt)\r\n"],
    ["t/peer-a/notes.md", "Real target bytes.\n"],
    ["t/peer-a/second.md", "Second literal-syntax target.\n"],
    ["t/peer-a/`notes.md", "Backtick filename target.\n"],
    ["t/peer-a/wrong.md", "Wrong definition decoy.\n"],
    ["t/_archive/peer-a/notes.md", "Existing wrong-location decoy.\n"],
    ["unrelated.md", inputFiles.get("unrelated.md")],
  ])
  for (const [file, bytes] of inputFiles) {
    await fs.promises.mkdir(path.dirname(safe(file)), { recursive: true })
    await fs.promises.writeFile(safe(file), bytes)
  }
  const rootStat = await fs.promises.stat(root, { bigint: true })
  const ancestry = [{ type: "directory", dev: String(rootStat.dev), ino: String(rootStat.ino) }]
  const documents = []
  for (const [file, before] of inputFiles) {
    if (!file.endsWith(".md")) continue
    const stat = await fs.promises.lstat(safe(file), { bigint: true })
    documents.push({ path: file, before: Buffer.from(before), mode: Number(stat.mode & 0o777n),
      identity: { type: "regular_file", dev: String(stat.dev), ino: String(stat.ino) },
      version: { size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) },
      ancestry })
  }
  const references = [
    ["t/moved/task.md", "t/_archive/moved/task.md", "[peer](", ' "title")\r\n',
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/task.md", "t/_archive/moved/task.md", "[sub](", ")\r\n",
      "t/moved/docs/detail.md", "t/_archive/moved/docs/detail.md"],
    ["t/moved/docs/detail.md", "t/_archive/moved/docs/detail.md", "[external](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/containers.md", "t/_archive/moved/containers.md", "[ref]: <", '> "title"\r\n',
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/autolinks.md", "t/_archive/moved/autolinks.md", "[real](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/comments.md", "t/_archive/moved/comments.md", "[one](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/comments.md", "t/_archive/moved/comments.md", "[two](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/nested.md", "t/_archive/moved/nested.md", "[ref]: <", '> "title"\r\n',
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/interrupted.md", "t/_archive/moved/interrupted.md", "[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/lazy.md", "t/_archive/moved/lazy.md", "\r\n\r\n[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/equals.md", "t/_archive/moved/equals.md", "\r\n\r\n[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/empty.md", "t/_archive/moved/empty.md", "[empty]: <>\r\n[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/heading.md", "t/_archive/moved/heading.md", "[real](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/ordered.md", "t/_archive/moved/ordered.md", "[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/nonlinks.md", "t/_archive/moved/nonlinks.md", "[real](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/multiline.md", "t/_archive/moved/multiline.md", "label](<", '> "title")\r\n',
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/outer.md", "t/_archive/moved/outer.md", "[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/title-syntax.md", "t/_archive/moved/title-syntax.md", "[a](", ' "<!--")',
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/title-syntax.md", "t/_archive/moved/title-syntax.md", "[b](", ")\r\n",
      "t/peer-a/second.md", "t/peer-a/second.md"],
    ["t/moved/destination-syntax.md", "t/_archive/moved/destination-syntax.md", "[a](", ") [b]",
      "t/peer-a/`notes.md", "t/peer-a/`notes.md"],
    ["t/moved/destination-syntax.md", "t/_archive/moved/destination-syntax.md", "[b](", ") `\r\n",
      "t/peer-a/second.md", "t/peer-a/second.md"],
    ["t/moved/lazy-type7.md", "t/_archive/moved/lazy-type7.md", "[x](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/definition-type7.md", "t/_archive/moved/definition-type7.md", "<", ">\r\n",
      "t/moved/custom", "t/_archive/moved/custom"],
    ["t/moved/complete-definition.md", "t/_archive/moved/complete-definition.md", "[x](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/definition-indented.md", "t/_archive/moved/definition-indented.md", "[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/definition-indented.md", "t/_archive/moved/definition-indented.md", "[code](", ")\r\n",
      "t/peer-a/wrong.md", "t/peer-a/wrong.md"],
    ["t/moved/definition-code.md", "t/_archive/moved/definition-code.md", "[ref]: ", "\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/inline-comment.md", "t/_archive/moved/inline-comment.md", "[x](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/moved/definition-inline-comment.md", "t/_archive/moved/definition-inline-comment.md", "[x](", ")\r\n",
      "t/peer-a/notes.md", "t/peer-a/notes.md"],
    ["t/peer-a/task.md", "t/peer-a/task.md", "[card](", ")\r\n",
      "t/moved/task.md", "t/_archive/moved/task.md"],
    ["t/peer-a/task.md", "t/peer-a/task.md", "[brief]: ", ' "title"\r\n',
      "t/moved/docs/detail.md", "t/_archive/moved/docs/detail.md"],
    ["u/peer-b/task.md", "u/peer-b/task.md", "![attachment](", ")\r\n",
      "t/moved/report (final).txt", "t/_archive/moved/report (final).txt"],
  ]
  const originalTargets = await Promise.all(references.map(reference =>
    fs.promises.stat(safe(reference[4]), { bigint: true })))
  const answer = plan({ ...base, documents, entries: [...inputFiles.keys()].map(file => entry(file)) })
  assert.deepEqual(answer.refusals, [])
  for (const file of answer.files) {
    const original = documents.find(document => document.path === file.beforePath)
    assert.equal(file.mode, original.mode)
    assert.deepEqual(file.identity, original.identity)
    assert.deepEqual(file.version, original.version)
  }
  await fs.promises.rename(safe("t/moved"), safe("t/_archive/moved"))
  for (const file of answer.files) await fs.promises.writeFile(safe(file.afterPath), file.after)
  for (const [file, expected] of expectedFiles)
    assert.deepEqual(await fs.promises.readFile(safe(file)), Buffer.from(expected), file)
  for (let index = 0; index < references.length; index++) {
    const [, owner, prefix, suffix, , target] = references[index]
    const text = await fs.promises.readFile(safe(owner), "utf8")
    const label = text.indexOf(prefix)
    assert.ok(label >= 0)
    const start = label + prefix.length
    const end = text.indexOf(suffix, start)
    assert.ok(end >= start)
    const href = text.slice(start, end)
    const actual = safe(path.join(path.dirname(owner), decodeURIComponent(href.split("#")[0])))
    assert.equal(await fs.promises.realpath(actual), await fs.promises.realpath(safe(target)))
    const stat = await fs.promises.stat(actual, { bigint: true })
    assert.equal(stat.dev, originalTargets[index].dev)
    assert.equal(stat.ino, originalTargets[index].ino, `${owner}: target identity, not existence only`)
    assert.equal(stat.mode & 0o777n, originalTargets[index].mode & 0o777n)
  }
})
