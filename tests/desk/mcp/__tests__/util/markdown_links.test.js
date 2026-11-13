import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import markdown from "../../../../../plugins/desk/mcp/src/util/markdown-links.cjs"

const scan = markdown.extractMarkdownLinks
const cases = [
  ["inline destination excludes its title",
    '[label](../peer/notes.md#proof "unchanged title")\r\n',
    ["../peer/notes.md#proof"]],
  ["balanced parentheses belong to the destination",
    '[label](../peer/report(final).md "title")',
    ["../peer/report(final).md"]],
  ["escaped parentheses keep their original source bytes",
    "[label](../peer/report\\(final\\).md)",
    ["../peer/report\\(final\\).md"]],
  ["angle destinations keep spaces and parentheses",
    '[label](<../peer/report (final).md> "title")',
    ["../peer/report (final).md"]],
  ["inline images are real destinations",
    "![label](../peer/picture%20final.png#view)",
    ["../peer/picture%20final.png#view"]],
  ["one reference definition owns full, collapsed and shortcut uses",
    "[title][ REF ] [ref][] [ref] ![ref]\r\n\r\n[ref]: <../peer/report (final).md> 'title'\r\n",
    ["../peer/report (final).md"]],
  ["reference images use the same winning definition",
    "![label][image]\n\n[image]: ../picture.png\n",
    ["../picture.png"]],
  ["unused and duplicate definitions are not rewrite destinations",
    "[ref]\n\n[ref]: ../first.md\n[ref]: ../duplicate.md\n[unused]: ../unused.md\n",
    ["../first.md"]],
  ["a reference destination may begin on the next line",
    "[ref]\r\n\r\n[ref]:\r\n  <../peer/report.md>\r\n",
    ["../peer/report.md"]],
  ["images nested in a link expose both destinations",
    "[![image](../picture.png)](../notes.md)",
    ["../picture.png", "../notes.md"]],
  ["an inner link prevents an invalid outer link",
    "[outer [inner](../inner.md)](../outer.md)",
    ["../inner.md"]],
  ["escaped opening brackets are ordinary text",
    "\\[not-link](../fake.md) [real](../real.md)",
    ["../real.md"]],
  ["inline code and fenced examples are not links",
    "`[x](../code.md)`\n~~~markdown\n[x](../fenced.md)\n~~~\n[x](../real.md)",
    ["../real.md"]],
  ["unclosed inline-code punctuation does not hide real links",
    "` literal [x](../real.md)",
    ["../real.md"]],
  ["frontmatter and comments are not body link destinations",
    "---\r\nraw: '[metadata](../metadata.md)'\r\n---\r\n" +
      "<!-- [comment](../comment.md) -->\r\n[x](../real.md)",
    ["../real.md"]],
  ["indented code blocks are not destinations",
    "Paragraph.\n\n    [code](../code.md)\n\n[x](../real.md)",
    ["../real.md"]],
  ["URI schemes and absolute references remain extractor data",
    "[x](desk:task/one) [x](mailto:person@example.test) [x](//example.test/file) [x](/file) [x](#anchor)",
    ["desk:task/one", "mailto:person@example.test", "//example.test/file", "/file", "#anchor"]],
  ["a title containing brackets is not another link",
    '[real](../real.md "title [fake](../fake.md)")',
    ["../real.md"]],
  ["comment syntax inside inline code cannot hide a later link",
    "`<!--` [real](../real.md)",
    ["../real.md"]],
  ["comment syntax inside a fence cannot hide a later link",
    "~~~markdown\n<!--\n~~~\n[real](../real.md)",
    ["../real.md"]],
  ["backticks inside an inline comment cannot hide a later link",
    "Paragraph <!-- ` --> [real](../real.md) `",
    ["../real.md"]],
  ["a reference title on its own next line contains no rewrite destinations",
    "[ref]\n\n[ref]: ../real.md\n 'title [fake](../fake.md)'\n",
    ["../real.md"]],
  ["backslashes do not make whitespace legal in bare destinations",
    "[literal](../not\\ a-link.md) [real](../real.md)",
    ["../real.md"]],
  ["a UTF-8 BOM does not turn frontmatter into body destinations",
    "\uFEFF---\r\nraw: '[fake](../fake.md)'\r\n---\r\n[real](../real.md)",
    ["../real.md"]],
  ["raw HTML preformatted code is not a Markdown link context",
    "<pre>\n[code](../code.md)\n</pre>\n[real](../real.md)",
    ["../real.md"]],
  ["raw HTML script code is not a Markdown link context",
    '<script>\n"[code](../code.md)"\n</script>\n[real](../real.md)',
    ["../real.md"]],
  ["fence-looking text inside raw HTML code does not hide a later real link",
    "<pre>\n~~~\n[code](../code.md)\n</pre>\n[real](../real.md)",
    ["../real.md"]],
  ["a closed tilde fence inside a list item remains code",
    "- ~~~markdown\n  [code](../code.md)\n  ~~~\n[real](../real.md)",
    ["../real.md"]],
  ["Markdown-looking text in a raw block HTML region is not a destination",
    "<div>\n[raw](../raw.md)\n</div>\n\n[real](../real.md)",
    ["../real.md"]],
  ["a block HTML comment consumes its entire closing line",
    "<!-- comment --> [raw](../raw.md)\n[real](../real.md)",
    ["../real.md"]],
  ["processing instructions are raw HTML rather than Markdown",
    "<?instruction [raw](../raw.md)?>\n[real](../real.md)",
    ["../real.md"]],
  ["HTML declarations are raw rather than Markdown",
    "<!DOCTYPE [raw](../raw.md)>\n[real](../real.md)",
    ["../real.md"]],
  ["CDATA sections are raw rather than Markdown",
    "<![CDATA[\n[raw](../raw.md)\n]]>\n[real](../real.md)",
    ["../real.md"]],
  ["standalone custom HTML tags delimit a raw block",
    "<custom title='[attribute](../attribute.md)'>\n[raw](../raw.md)\n</custom>\n\n[real](../real.md)",
    ["../real.md"]],
  ["a standalone custom tag cannot interrupt an existing paragraph",
    "Paragraph\n<custom>\n[real](../real.md)",
    ["../real.md"]],
  ["inline HTML attributes are not Markdown destinations",
    '<span title="[attribute](../attribute.md)">[real](../real.md)</span>',
    ["../real.md"]],
  ["any designated raw-code closing tag ends the HTML block",
    "<pre>\n[raw](../raw.md)\n</textarea>\n[real](../real.md)",
    ["../real.md"]],
]

for (const [name, text, expectedRaw] of cases) {
  test(name, () => {
    const result = scan(text)
    assert.deepEqual(result.links.map(node => node.raw), expectedRaw)
    for (const node of result.links) {
      assert.equal(text.slice(node.start, node.end), node.raw)
      assert.ok(node.uses.length > 0)
      assert.ok(node.line >= 1 && node.column >= 1)
    }
  })
}

test("shared references retain the kind and syntax of every use", () => {
  const { links } = scan("[ref][ref] [ref][] [ref] ![ref]\n\n[ref]: ../target.md\n")
  assert.equal(links.length, 1)
  assert.deepEqual(links[0].uses.map(({ kind, syntax }) => ({ kind, syntax })), [
    { kind: "link", syntax: "full" },
    { kind: "link", syntax: "collapsed" },
    { kind: "link", syntax: "shortcut" },
    { kind: "image", syntax: "shortcut" },
  ])
})

for (const prefix of ["> ", "- ", "1. ", "> - ", "> > "]) {
  for (const [use, syntax] of [
    ["[label][ref]", "full"], ["[ref][]", "collapsed"], ["[ref]", "shortcut"],
  ]) {
    test(`${syntax} references resolve a definition inside ${JSON.stringify(prefix)} with original spans`, () => {
      const raw = "../peer/report%20(final).md#proof"
      const text = `\u{1f600}\r\n${use}\r\n${prefix}[ref]: <${raw}> "title"\r\n`
      const result = scan(text)
      assert.deepEqual(result.diagnostics, [])
      assert.equal(result.links.length, 1)
      const node = result.links[0]
      assert.equal(node.raw, raw)
      assert.equal(node.start, text.indexOf(raw))
      assert.equal(node.end, node.start + raw.length)
      assert.equal(text.slice(node.start, node.end), raw)
      assert.equal(node.uses[0].syntax, syntax)
    })
  }
}

test("quoted multiline definitions retain container prefixes and exclude their titles", () => {
  const text = "[ref]\r\n> > [ref]:\r\n> >   <../peer/notes.md#proof>\r\n" +
    '> >   "title [fake](../fake.md)"\r\n'
  const result = scan(text)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.links.map(node => node.raw), ["../peer/notes.md#proof"])
  assert.equal(result.links[0].start, text.indexOf("../peer/notes"))
})

for (const prefix of ["- > ", "1. > ", "> - > ", "- > - ", "- > > "]) {
  for (const use of ["[label][ref]", "[ref][]", "[ref]"]) {
    test(`inverse container nesting ${JSON.stringify(prefix)} resolves ${use} at original offsets`, () => {
      const raw = "../peer/notes.md#proof"
      const text = `${use}\r\n\r\n${prefix}[ref]: <${raw}> "title"\r\n`
      const result = scan(text)
      assert.deepEqual(result.diagnostics, [])
      assert.deepEqual(result.links.map(node => node.raw), [raw])
      assert.equal(result.links[0].start, text.indexOf(raw))
    })
  }
}

test("list-to-quote nested definitions accept only their own continuation prefix", () => {
  const text = "[ref]\r\n\r\n- > [ref]:\r\n  >   <../peer/notes.md#proof>\r\n" +
    '  >   "title [fake](../fake.md)"\r\n'
  const result = scan(text)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.links.map(node => node.raw), ["../peer/notes.md#proof"])
  assert.equal(result.links[0].start, text.indexOf("../peer/notes"))
})

for (const interruption of [
  "> ../peer/wrong.md", "- ../peer/wrong.md",
  "~~~\r\n../peer/wrong.md\r\n~~~",
]) {
  test(`an incomplete definition cannot cross ${JSON.stringify(interruption)} and shadow a valid later one`, () => {
    const text = `[ref]:\r\n${interruption}\r\n\r\n[ref]: ../peer/right.md\r\n\r\n[label][ref]\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md"])
    assert.equal(result.links[0].start, text.indexOf("../peer/right.md"))
  })
}

for (const [prefix, continuation] of [["", ""], ["> ", "> "], ["- > ", "  > "]]) {
  test(`a definition in already-started prose ${JSON.stringify(prefix)} cannot become the winner`, () => {
    const text = `${prefix}Text\r\n${continuation}[ref]: ../peer/wrong.md\r\n\r\n` +
      "[ref]: ../peer/right.md\r\n\r\n[label][ref]\r\n"
    const result = scan(text)
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md"])
  })
}

test("a new list item is eligible even after prose in its preceding sibling", () => {
  const result = scan("- > Text\r\n- > [ref]: ../right.md\r\n\r\n[ref]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
})

for (const [first, sibling] of [
  ["1. Text", "2. "], ["7) Text", "8) "], ["> 1. Text", "> 2. "],
  ["- 1. Text", "  2. "], ["1. > Text", "2. > "],
]) {
  test(`compatible ordered sibling ${JSON.stringify(sibling)} is a new definition block`, () => {
    const text = `\u{1f600}\r\n\r\n${first}\r\n${sibling}[ref]: ../peer/right.md#proof\r\n\r\n[label][ref]\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md#proof"])
    assert.equal(result.links[0].start, text.indexOf("../peer/right.md#proof"))
  })
}

test("a changed ordered delimiter at sibling level starts a new list", () => {
  const text = "1. Text\r\n2) [ref]: ../right.md\r\n\r\n[ref]: ../wrong.md\r\n\r\n[ref]\r\n"
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
})

test("a new ordered list starting at two cannot interrupt a root paragraph", () => {
  const text = "Text\r\n2. [ref]: ../wrong.md\r\n\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n"
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
})

test("a multiline definition cannot read its label from an ordered sibling", () => {
  const text = "1. [ref\r\n2. ]: ../wrong.md\r\n\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n"
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
})

for (const [first, next] of [
  ["> 1. Text", "2. "], ["> - Text", "2. "], ["> > Text", "2) "],
  ["- > Text", "  2. "], ["> 1. > Text", "> 2. "], ["> Text", "2. "],
]) {
  test(`new ordered blocks after ${JSON.stringify(first)} use the last matched container`, () => {
    const text = `\u{1f600}\r\n${first}\r\n${next}[ref]: ../peer/right.md#proof\r\n\r\n[label][ref]\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md#proof"])
    assert.equal(result.links[0].start, text.indexOf("../peer/right.md#proof"))
  })
}

for (const [first, lazy] of [
  ["> Text", "[ref]: ../wrong.md"], ["> 1. Text", "[ref]: ../wrong.md"],
  ["- > Text", "  [ref]: ../wrong.md"], ["> > Text", "> [ref]: ../wrong.md"],
]) {
  test(`non-block lazy text after ${JSON.stringify(first)} remains paragraph prose`, () => {
    const text = `${first}\r\n${lazy}\r\n\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n`
    assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
  })
}

test("definition lookahead cannot use a new root ordered block after quote failure", () => {
  const text = "> [ref]:\r\n2.\r\n\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n"
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
})

for (const [first, tag, link] of [
  ["> Text", "<custom>", "[x](../peer/right.md#proof)"],
  ["> > Text", "> <custom>", "> [x](../peer/right.md#proof)"],
  ["- > Text", "  <custom>", "  [x](../peer/right.md#proof)"],
  ["1. Text", "<custom>", "[x](../peer/right.md#proof)"],
]) {
  test(`type7 HTML after ${JSON.stringify(first)} cannot interrupt pending lazy prose`, () => {
    const text = `\u{1f600}\r\n${first}\r\n${tag}\r\n${link}\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md#proof"])
    assert.equal(result.links[0].start, text.indexOf("../peer/right.md#proof"))
  })
}

test("type7-looking angle destinations may continue a pending quoted definition", () => {
  const text = "> [ref]:\r\n<custom>\r\n\r\n[label][ref]\r\n"
  const result = scan(text)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.links.map(node => node.raw), ["custom"])
  assert.equal(result.links[0].start, text.indexOf("custom"))
})

for (const [definition, tag, link] of [
  ["> [ref]: unused.md", "<custom>", "[x](../peer/right.md#proof)"],
  ["> > [ref]: unused.md", "> <custom>", "> [x](../peer/right.md#proof)"],
  ["- > [ref]: unused.md", "  <custom>", "  [x](../peer/right.md#proof)"],
  ["[ref]: unused.md", "<custom>", "[x](../peer/right.md#proof)"],
]) {
  test(`consumed definition ${JSON.stringify(definition)} leaves a pending paragraph for type7 prose`, () => {
    const text = `${definition}\r\n${tag}\r\n${link}\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md#proof"])
    assert.equal(result.links[0].start, text.indexOf("../peer/right.md#proof"))
  })
}

test("a completed definition does not allow a new ordered list to interrupt its root paragraph", () => {
  const text = "[unused]: unused.md\r\n2. [ref]: ../wrong.md\r\n\r\n[ref]: ../right.md\r\n\r\n[label][ref]\r\n"
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
})

test("indented consecutive definitions remain eligible within their pending paragraph", () => {
  const text = "[unused]: unused.md\r\n    [ref]: ../right.md\r\n\r\n[label][ref]\r\n"
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
})

test("actual setext prose after a definition closes the block before indented code", () => {
  const text = "[unused]: unused.md\r\nHeading\r\n===\r\n    [code](../wrong.md)\r\n[real](../right.md)\r\n"
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
})

for (const rawBlock of [
  "<pre>\r\n[hidden](../wrong.md)\r\n</pre>",
  "<!-- comment\r\n[hidden](../wrong.md)\r\n-->",
  "<?instruction\r\n[hidden](../wrong.md)\r\n?>",
  "<!DOCTYPE\r\n[hidden](../wrong.md)>",
  "<![CDATA[\r\n[hidden](../wrong.md)\r\n]]>",
  "<div>\r\n[hidden](../wrong.md)\r\n</div>\r\n",
]) {
  test(`type1-6 block ${JSON.stringify(rawBlock.split("\r\n")[0])} really interrupts quoted prose`, () => {
    const result = scan(`> Text\r\n${rawBlock}\r\n[real](../right.md)\r\n`)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
  })
}

for (const preceding of ["> # Heading\r\n", "> Text\r\n\r\n"]) {
  test(`type7 blocks remain opaque after closed prose ${JSON.stringify(preceding)}`, () => {
    const result = scan(`${preceding}<custom>\r\n[hidden](../wrong.md)\r\n</custom>\r\n\r\n[real](../right.md)\r\n`)
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
  })
}

for (const [first, tail, raw] of [
  ['[a](../peer/a.md "<!--")', "", "../peer/a.md"],
  ['[a](../peer/a.md "`")', " `", "../peer/a.md"],
  ['[a](../peer/a.md "<span title=\'")', " '>", "../peer/a.md"],
  ["[a](../peer/<!--.md)", "", "../peer/<!--.md"],
  ["[a](../peer/`a.md)", " `", "../peer/`a.md"],
]) {
  test(`admitted destination/title syntax in ${JSON.stringify(first)} cannot mask the following link`, () => {
    const text = `\u{1f600} ${first} [b](../peer/b.md)${tail}`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), [raw, "../peer/b.md"])
    assert.equal(result.links[0].start, text.indexOf(raw))
    assert.equal(result.links[1].start, text.indexOf("../peer/b.md"))
  })
}

for (const outside of [
  "<!-- [hidden](../hidden.md) -->", "`[hidden](../hidden.md)`",
  '<span title="[hidden](../hidden.md)">text</span>',
]) {
  test(`actual outside-link syntax ${JSON.stringify(outside)} stays opaque`, () => {
    const result = scan(`Text ${outside} [b](../peer/b.md)`)
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/b.md"])
  })
}

test("a rejected link candidate does not consume actual inline comments as a title", () => {
  const text = '[a](../peer/a.md "<!-- [hidden](../hidden.md) -->" extra) [b](../peer/b.md)'
  assert.deepEqual(scan(text).links.map(node => node.raw), ["../peer/b.md"])
})

for (const text of [
  "Text <!-- [x](../peer/right.md#proof)\r\n",
  "[unused]: unused.md\r\n    Text <!-- [x](../peer/right.md#proof)\r\n",
  "> Text <!-- [x](../peer/right.md#proof)\r\n",
  "Text <!-- unfinished\r\ncontinued [x](../peer/right.md#proof)\r\n",
]) {
  test(`an unterminated inline comment is literal in ${JSON.stringify(text)}`, () => {
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md#proof"])
    assert.equal(result.links[0].start, text.indexOf("../peer/right.md#proof"))
  })
}

for (const comment of ["<!-- [hidden](../hidden.md) -->", "<!-->", "<!--->"]) {
  test(`closed inline comment ${JSON.stringify(comment)} remains opaque in post-definition prose`, () => {
    const text = `[unused]: unused.md\r\n    Text ${comment} [x](../peer/right.md)\r\n`
    assert.deepEqual(scan(text).links.map(node => node.raw), ["../peer/right.md"])
  })
}

for (const text of ["<!-- unfinished\r\n[x](../hidden.md)\r\n", "> <!-- unfinished\r\n> [x](../hidden.md)\r\n"]) {
  test(`an actual block comment remains opaque through EOF in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(scan(text).links, [])
  })
}

for (const text of [
  "`` literal [real](../right.md) `",
  "``` literal [real](../right.md) ``",
]) {
  test(`an unmatched code delimiter run is consumed whole in ${JSON.stringify(text)}`, () => {
    assert.deepEqual(scan(text).links.map(node => node.raw), ["../right.md"])
  })
}

for (const text of [
  "[x\r\n\r\n](../wrong.md)",
  "[x\r\n# Heading\r\n](../wrong.md)",
  "# [x\r\n](../wrong.md)",
  "[x\r\n> ](../wrong.md)",
  "1. [x\r\n2. ](../wrong.md)",
  "[x\r\n---\r\n](../wrong.md)",
  "[x\r\n<!-- comment -->\r\n](../wrong.md)",
  '[x](../wrong.md "title\r\n# Heading\r\nend")',
  '[x](../wrong.md "title\r\n~~~\r\ntext\r\n~~~\r\nend")',
]) {
  test(`brackets and destination/title readers cannot cross blocks in ${JSON.stringify(text)}`, () => {
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links, [])
  })
}

for (const text of [
  "[x\r\nlabel](../right.md#proof)",
  "[x](\r\n<../right.md#proof>\r\n\"title\")",
  "> [x\r\n> label](<../right.md#proof> \"title\")",
  "- > [x\r\n  > label](../right.md#proof)",
  "[multi\r\nlabel][]\r\n\r\n[multi label]: ../right.md#proof\r\n",
  "> [multi\r\n> label][]\r\n\r\n[multi label]: ../right.md#proof\r\n",
  "[x](../right.md#proof \"title\r\ncontinued\")",
  "> [x](../right.md#proof \"title\r\n> continued\")",
]) {
  test(`legal multiline links retain original spans in ${JSON.stringify(text)}`, () => {
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md#proof"])
    assert.equal(result.links[0].start, text.indexOf("../right.md#proof"))
    assert.equal(text.slice(result.links[0].start, result.links[0].end), "../right.md#proof")
  })
}

test("inline code delimiters cannot hide a link in a different heading block", () => {
  const result = scan("` unfinished\r\n# [real](../right.md)\r\n` later\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
})

for (const [first, lazy] of [
  ["> Text", "[ref]: ../peer/wrong.md"],
  ["- Text", "[ref]: ../peer/wrong.md"],
  ["- > Text", "  [ref]: ../peer/wrong.md"],
]) {
  test(`lazy paragraph continuation after ${JSON.stringify(first)} cannot declare a reference`, () => {
    const text = `${first}\r\n${lazy}\r\n\r\n[ref]: ../peer/right.md\r\n\r\n[label][ref]\r\n`
    const result = scan(text)
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md"])
    assert.equal(result.links[0].start, text.indexOf("../peer/right.md"))
  })
}

test("standalone equals is prose rather than a heading boundary", () => {
  const text = "===\r\n[ref]: ../peer/wrong.md\r\n\r\n[ref]: ../peer/right.md\r\n\r\n[label][ref]\r\n"
  const result = scan(text)
  assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md"])
})

test("a real setext heading ends its preceding paragraph and permits a definition", () => {
  const result = scan("Heading\r\n===\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
})

test("equals immediately after a valid definition is still prose, not heading content", () => {
  const result = scan("[first]: ../first.md\r\n===\r\n[ref]: ../wrong.md\r\n\r\n" +
    "[ref]: ../right.md\r\n\r\n[first] [ref]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../first.md", "../right.md"])
})

test("an empty angle definition is valid and cannot hide the following genuine definition", () => {
  const result = scan("[empty]: <>\r\n[ref]: ../right.md\r\n[ref]: ../wrong.md\r\n\r\n[empty] [ref]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["", "../right.md"])
  assert.equal(result.links[0].start, result.links[0].end)
})

test("an omitted destination is not an empty angle definition", () => {
  const result = scan("[empty]:\r\n\r\n[empty]\r\n")
  assert.deepEqual(result.links, [])
})

for (const header of ["# Heading", "Heading\r\n==="]) {
  test(`indented text directly after ${JSON.stringify(header)} is code, not paragraph prose`, () => {
    const result = scan(`${header}\r\n    [code](../peer/wrong.md)\r\n[real](../peer/right.md)\r\n`)
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/right.md"])
  })
}

test("indented paragraph continuation after a definition is a real link", () => {
  const result = scan("[ref]: ../right.md\r\n    [code](../wrong.md)\r\n[ref]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md", "../wrong.md"])
})

test("a blank after a definition permits genuine indented code", () => {
  const result = scan("[ref]: ../right.md\r\n\r\n    [code](../wrong.md)\r\n[ref]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
})

test("consecutive valid definitions remain eligible before prose starts", () => {
  const result = scan("[one]: ../one.md\r\n[two]: ../two.md\r\n\r\n[one] [two]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../one.md", "../two.md"])
})

test("a heading boundary permits a following reference definition without a blank line", () => {
  const result = scan("# Heading\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
})

for (const [header, code] of [
  ["> # Heading", ">     [code](../wrong.md)"],
  ["- > Heading\r\n  > ===", "  >     [code](../wrong.md)"],
]) {
  test(`closed heading in ${JSON.stringify(header)} leaves indented code opaque`, () => {
    const text = `${header}\r\n${code}\r\n\r\n[real](../right.md)\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
    assert.equal(result.links[0].start, text.indexOf("../right.md"))
  })
}

for (const first of ["> Text", "- Text", "- > Text"]) {
  test(`an unmarked equals line remains lazy prose after ${JSON.stringify(first)}`, () => {
    const text = `${first}\r\n===\r\n[ref]: ../wrong.md\r\n\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
    assert.equal(result.links[0].start, text.indexOf("../right.md"))
  })
}

for (const boundary of ["# Heading", "---", "~~~\r\n~~~"]) {
  test(`${JSON.stringify(boundary)} really interrupts lazy quoted prose`, () => {
    const text = `> Text\r\n${boundary}\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
  })
}

test("indented paragraph continuation is not mistaken for code", () => {
  const result = scan("Text\r\n    [real](../right.md)\r\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
})

for (const malformed of ['<>"adjacent title"', '<../wrong.md>"adjacent title"']) {
  test(`${malformed} cannot become a winning definition without a title separator`, () => {
    const text = `[ref]: ${malformed}\r\n\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
  })
}

test("definition lookahead retains multiline label, destination and indented title spans", () => {
  const text = "\u{1f600}\r\n\r\n- > [multi\r\n  > label]:\r\n  >   <../peer/notes.md#proof>\r\n" +
    '  >         "title [fake](../wrong.md)"\r\n\r\n[multi label]\r\n'
  const result = scan(text)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.links.map(node => node.raw), ["../peer/notes.md#proof"])
  assert.equal(result.links[0].start, text.indexOf("../peer/notes.md#proof"))
})

test("an incomplete declaration cannot use a setext underline as its destination", () => {
  const text = "[ref]:\r\n===\r\n\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n"
  const result = scan(text)
  assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
})

for (const marker of ["-", "*", "1."]) {
  test(`an empty ${marker} list item is a block boundary, not paragraph prose`, () => {
    const result = scan(`${marker}\r\n[ref]: ../right.md\r\n\r\n[ref]\r\n`)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../right.md"])
  })
}

test("a reference destination can continue lazily without creating another container", () => {
  const text = "> [ref]:\r\n<../peer/notes.md#proof>\r\n\r\n[ref]\r\n"
  const result = scan(text)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.links.map(node => node.raw), ["../peer/notes.md#proof"])
  assert.equal(result.links[0].start, text.indexOf("../peer/notes.md#proof"))
})

for (const scheme of ["https", "HTTP", "desk"]) {
  test(`a ${scheme} autolink is opaque even when its URL contains Markdown-looking brackets`, () => {
    const url = `<${scheme}://example.test/[x](../peer/notes.md)>`
    const text = `${url} [real](../real.md)`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../real.md"])
    assert.equal(result.links[0].start, text.indexOf("../real.md"))
  })
}

test("a one-letter scheme is not misclassified as a CommonMark URI autolink", () => {
  const result = scan("<x:/[real](../real.md)>")
  assert.deepEqual(result.links.map(node => node.raw), ["../real.md"])
})

for (const comment of ["<!-->", "<!--->"]) {
  test(`${comment} is a complete inline comment and does not swallow a later destination`, () => {
    const text = `Text ${comment} [real](../peer/notes.md)`
    const result = scan(text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.links.map(node => node.raw), ["../peer/notes.md"])
    assert.equal(result.links[0].start, text.indexOf("../peer/notes.md"))
  })
  test(`${comment} at a block boundary still consumes its entire line`, () => {
    const result = scan(`${comment} [raw](../raw.md)\r\n[real](../real.md)`)
    assert.deepEqual(result.links.map(node => node.raw), ["../real.md"])
  })
}

test("the default legacy label policy does not conflate Latin I with dotless i", () => {
  const result = scan("[I] [\u0131]\n\n[I]: ../one.md\n[\u0131]: ../two.md\n")
  assert.deepEqual(result.links.map(node => node.raw), ["../one.md", "../two.md"])
})

test("semantic decoding preserves URI encoding for filesystem classification", () => {
  const { links } = scan("[x](../report\\(final\\)%20name.md#proof)")
  assert.equal(links[0].destination, "../report(final)%20name.md#proof")
})

test("Unicode source spans preserve unrelated characters before a destination", () => {
  const text = "A \u{1f600} label [caf\u00e9](../caf%C3%A9.md#proof)\r\n"
  const { links } = scan(text)
  assert.equal(links[0].start, text.indexOf("../caf"))
  assert.equal(text.slice(links[0].start, links[0].end), "../caf%C3%A9.md#proof")
})

test("pathological unfinished destinations report bounded extraction rather than silent partial success", () => {
  const result = scan("[x](".repeat(200))
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "parse_budget_exceeded"))
})

for (const name of ["constructor", "toString", "valueOf"]) {
  test(`an unsupported entity named ${name} cannot resolve through the entity table prototype`, () => {
    const raw = `../&${name};.md`
    const result = scan(`[x](${raw})`)
    assert.equal(result.links[0].destination, raw)
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "unsupported_entity"))
  })
}

test("an unquoted HTML attribute value is skipped as part of its tag, and an empty one does not hide a later link", () => {
  const { links } = scan("<img src=a.png alt=b> [kept](../kept.md)\n<a href=>[also](../also.md)\n")
  assert.deepEqual(links.map(link => link.destination), ["../kept.md", "../also.md"])
})

test("an angle-bracket destination that never closes yields no link", () => {
  const result = scan("[x](<../unclosed.md")
  assert.deepEqual(result.links, [])
})
