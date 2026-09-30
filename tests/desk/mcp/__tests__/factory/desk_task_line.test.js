import { test } from "node:test"
import { strict as assert } from "node:assert"

import { parseDeskTaskLine } from "../../../../../plugins/desk/mcp/src/factory/desk-task-line.js"

const OK = { track: "desk-plugin", slug: "some-task" }

const CASES = [
  ["a single line", "Desk-Task: desk-plugin/some-task", OK],
  ["anywhere in the prompt", "Do the thing.\nDesk-Task: desk-plugin/some-task\nThanks.", OK],
  ["trailing spaces", "Desk-Task: desk-plugin/some-task   \nmore", OK],
  ["CRLF line ends", "intro\r\nDesk-Task: desk-plugin/some-task\r\nmore\r\n", OK],
  ["no line", "just a prompt", null],
  ["empty prompt", "", null],
  ["two matching lines", "Desk-Task: a/b\nDesk-Task: c/d", null],
  ["two identical lines count as one", "Desk-Task: a/b\nDesk-Task: a/b", { track: "a", slug: "b" }],
  ["a header line and a bulleted rule naming the same task", "Desk-Task: desk-plugin/some-task\nRules:\n- Desk-Task: desk-plugin/some-task", OK],
  ["a dash bullet", "- Desk-Task: desk-plugin/some-task", OK],
  ["a star bullet", "* Desk-Task: desk-plugin/some-task", OK],
  ["a blockquote", "> Desk-Task: desk-plugin/some-task", OK],
  ["a blockquote with indentation and trailing space", "intro\n   > Desk-Task: desk-plugin/some-task  \n", OK],
  ["a marker with no space after it", "-Desk-Task: a/b", null],
  ["two markers", "- > Desk-Task: a/b", null],
  ["two lines naming different tasks", "Desk-Task: a/b\n- Desk-Task: c/d", null],
  ["parent traversal track", "Desk-Task: ../x/y", null],
  ["dot slug", "Desk-Task: track/..", null],
  ["hidden slug", "Desk-Task: track/.hidden", null],
  ["reserved track", "Desk-Task: _meta/foo", null],
  ["reserved slug", "Desk-Task: track/_planning", null],
  ["three segments", "Desk-Task: a/b/c", null],
  ["one segment", "Desk-Task: a", null],
  ["backslash segment", "Desk-Task: a\\b/c", null],
  ["inner space", "Desk-Task: a b/c", null],
  ["leading indentation", "  Desk-Task: a/b", { track: "a", slug: "b" }],
  ["wrong case", "desk-task: a/b", null],
  ["prefix text", "see Desk-Task: a/b", null],
  ["trailing text", "Desk-Task: a/b and more", null],
  ["a malformed line plus a valid line is ambiguous, so it binds nothing", "Desk-Task: ../x\nDesk-Task: a/b", null],
]

for (const [name, text, expected] of CASES) {
  test(`parseDeskTaskLine: ${name}`, () => {
    assert.deepEqual(parseDeskTaskLine(text), expected)
  })
}

test("parseDeskTaskLine never throws on non-strings", () => {
  for (const value of [undefined, null, 42, {}, []]) assert.equal(parseDeskTaskLine(value), null)
})
