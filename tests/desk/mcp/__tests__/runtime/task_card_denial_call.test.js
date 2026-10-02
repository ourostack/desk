// The exact `task_update` call a denial of a direct card edit names, built from what the edit tried to set.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { taskStatusGuardHook } from "../../../../../plugins/desk/mcp/src/runtime/task-status-guard.js"
import { deskToolName } from "../../../../../plugins/desk/mcp/src/runtime/desk-tool-name.js"

test("the Desk tool is named the way the host calls it", () => {
  assert.equal(deskToolName("claude", "task_update"), "mcp__plugin_desk_desk__task_update")
  assert.equal(deskToolName("copilot", "task_update"), "desk-task_update")
  assert.equal(deskToolName("codex", "task_update"), "task_update")
  assert.equal(deskToolName("unknown", "task_create"), "task_create")
})

function deskWith(t, card) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "card-call-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  const file = path.join(root, "t", "s", "task.md")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, card)
  const deny = (toolName, toolInput) => taskStatusGuardHook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { file_path: file, ...toolInput }, cwd: root }, "claude", undefined, { root, home: root })?.hookSpecificOutput?.permissionDecisionReason
  return { deny }
}

const CARD = "---\ntitle: T\nstatus: processing\n---\n\nbody\n"

test("the call carries the changed fields, the appended text, or a note to fill in", (t) => {
  const { deny } = deskWith(t, CARD)
  const call = (reason) => /(?:with|The call:) (\{.*?\})\.(?: Desk denies|$)/u.exec(reason)?.[1]
  // Frontmatter that no longer parses leaves nothing to name but the note, unless the status line changed.
  assert.equal(call(deny("Write", { content: "---\nstatus: processing\ntitle: [unclosed\n---\nbody\n" })), '{"track":"t","slug":"s","note":"<one line of what actually happened>"}')
  assert.equal(call(deny("Write", { content: "---\n\n---\nbody\n" })), '{"track":"t","slug":"s","note":"<one line of what actually happened>"}')
  assert.equal(call(deny("Write", {})), '{"track":"t","slug":"s","note":"<one line of what actually happened>"}')
  // An edit whose old text is not in the card cannot be applied: it is judged from its fragments.
  assert.equal(call(deny("Edit", { old_string: "no such text", new_string: "other text" })), '{"track":"t","slug":"s","note":"<one line of what actually happened>"}')
  assert.equal(call(deny("Edit", { old_string: "status: processing\nextra", new_string: "status: validating\nextra" })), '{"track":"t","slug":"s","frontmatter":{"status":"validating"}}')
  // A changed field and the status together, and the evidence a move to done needs.
  assert.equal(call(deny("Write", { content: CARD.replace("title: T", "title: U").replace("processing", "validating") })), '{"track":"t","slug":"s","frontmatter":{"title":"U","status":"validating"}}')
  assert.equal(call(deny("Write", { content: CARD.replace("processing", "done") })), '{"track":"t","slug":"s","frontmatter":{"status":"done"},"evidence":{"kind":"pr","ref":"<PR URL>"}}')
  // Text added after the card's end is a body_append.
  assert.equal(call(deny("Write", { content: `${CARD}more\n` })), '{"track":"t","slug":"s","body_append":"more\\n"}')
})

test("a status change and appended text are both in the call, and a long call is shortened", (t) => {
  const { deny } = deskWith(t, CARD)
  const call = (reason) => /(?:with|The call:) (\{.*?\})\. (?:Pass|Desk denies)/u.exec(reason)?.[1]
  assert.equal(call(deny("Write", { content: `${CARD.replace("processing", "validating")}more\n` })), '{"track":"t","slug":"s","frontmatter":{"status":"validating"},"body_append":"more\\n"}')
  const big = "x".repeat(50000)
  const reason = deny("Write", { content: `${CARD}${big}\n` })
  assert.ok(reason.length < 5000)
  assert.equal(call(reason), '{"track":"t","slug":"s","body_append":"<your appended text>"}')
  assert.match(reason, /Pass your text in the placeholder fields/u)
  const fields = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field_${i}`, "value ".repeat(5)]))
  const many = deny("Write", { content: `---\ntitle: T\nstatus: processing\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\nbody\n${big}\n` })
  assert.equal(call(many), '{"track":"t","slug":"s","frontmatter":"<the fields you changed>","body_append":"<your appended text>"}')
})
