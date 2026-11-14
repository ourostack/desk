// Held-out oracle for v2-approved-local-delivery. The runner copies this folder into the scratch repository only after the subject
// has exited, runs it against the subject's finished helper and callers, then removes it, so the subject never sees it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { slugify } from "../src/util/fm.js"
import { lesson_add } from "../src/tools/lesson.js"
import { friction_add } from "../src/tools/friction.js"

const unsafe = /[\/\\\u0000-\u001f\u007f]|\.\./u

async function mkDeskRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "desk-oracle-"))
}

test("ASCII slugs keep the current helper's output", () => {
  const cases = [
    ["Working with gh CLI", "working-with-gh-cli"],
    ["topic-x", "topic-x"],
    ["Visa Logistics", "visa-logistics"],
    ["  Hello,   World!  ", "hello-world"],
    ["v2.1 release", "v2-1-release"],
    ["a__b--c", "a-b-c"],
    ["ABC123", "abc123"],
    ["!!!", ""],
    ["", ""],
    [null, ""],
    [undefined, ""],
    [42, "42"],
  ]
  for (const [input, expected] of cases) {
    assert.equal(slugify(input), expected, JSON.stringify(input))
  }
})

test("Unicode letters and numbers are kept rather than dropped or split", () => {
  assert.equal(slugify("café"), "café")
  assert.equal(slugify("naïve straße"), "naïve-straße")
  assert.equal(slugify("ελληνικά"), "ελληνικά")
  assert.equal(slugify("привет мир"), "привет-мир")
  assert.equal(slugify("日本語 テスト"), "日本語-テスト")
  assert.equal(slugify("релиз 2 ٣"), "релиз-2-٣")
})

test("combining marks that belong to a word stay inside it", () => {
  assert.equal(slugify("नमस्ते दुनिया"), "नमस्ते-दुनिया")
  assert.equal(slugify("हिन्दी भाषा"), "हिन्दी-भाषा")
  assert.equal(slugify("cafe\u0301").normalize("NFC"), "caf\u00e9")
})

test("canonically equivalent text gives the same slug", () => {
  assert.equal(slugify("caf\u00e9"), slugify("cafe\u0301"))
  assert.equal(slugify("\u0958"), slugify("\u0915\u093c"))
  assert.equal(slugify("한글"), slugify("한글".normalize("NFD")))
  assert.equal(slugify("café notes".normalize("NFD")), slugify("café notes"))
})

test("slugs are path-safe and stable under re-slugging", () => {
  const inputs = [
    "नमस्ते दुनिया",
    "cafe\u0301 notes",
    "релиз 2 ٣",
    "../../etc/passwd",
    "a/b\\c",
    "..",
    "bad\u0000name",
    "tab\there",
    "line\nbreak",
    "bell\u0007",
    "del\u007f",
    "café/../x",
    "नमस्ते/दुनिया\\..\\x",
  ]
  for (const input of inputs) {
    const slug = slugify(input)
    assert.doesNotMatch(slug, unsafe, JSON.stringify(input))
    assert.equal(slugify(slug), slug, `stable: ${JSON.stringify(input)}`)
  }
})

test("lesson_add accepts a Unicode topic and still rejects punctuation-only topics", async () => {
  const root = await mkDeskRoot()
  const result = await lesson_add({ deskRoot: root, input: { topic: "नमस्ते दुनिया", body: "Keep the vowel signs." } })
  assert.equal(result.path, path.join("_meta", "tips", "नमस्ते-दुनिया.md"))
  assert.match(await fs.readFile(path.join(root, result.path), "utf8"), /^# नमस्ते दुनिया\n/u)

  for (const topic of ["!!!", "   "]) {
    await assert.rejects(
      () => lesson_add({ deskRoot: root, input: { topic, body: "x" } }),
      /slugified to empty/u,
      JSON.stringify(topic),
    )
  }

  const escaped = await lesson_add({ deskRoot: root, input: { topic: "../../escape", body: "x" } })
  assert.equal(escaped.path, path.join("_meta", "tips", "escape.md"))
})

test("friction_add keeps a Unicode theme and still falls back to untitled for punctuation-only themes", async () => {
  const root = await mkDeskRoot()
  const named = await friction_add({ deskRoot: root, input: { track: "t1", theme: "नमस्ते दुनिया", body: "x" } })
  assert.match(named.path, /^t1\/_friction\/\d{4}-\d{2}-\d{2}-नमस्ते-दुनिया\.md$/u)

  for (const theme of ["!!!", "   ", undefined]) {
    const result = await friction_add({ deskRoot: root, input: { track: "t1", theme, body: "x" } })
    assert.match(result.path, /^t1\/_friction\/\d{4}-\d{2}-\d{2}-untitled\.md$/u, JSON.stringify(theme))
  }

  const escaped = await friction_add({ deskRoot: root, input: { track: "t1", theme: "../../x", body: "x" } })
  assert.match(escaped.path, /^t1\/_friction\/\d{4}-\d{2}-\d{2}-x\.md$/u)
})
