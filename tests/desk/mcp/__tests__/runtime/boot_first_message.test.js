// What the boot says about the operator's first message: new work gets a task before any design, and on Copilot the question about
// which task to resume is asked in chat, not through the host's form (cold dry runs, 2026-10-12).
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}
async function desk() {
  const root = await mkTempRoot("desk-boot-first-message-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  await fs.mkdir(path.join(root, "ops", "open-task"), { recursive: true })
  await fs.writeFile(path.join(root, "ops", "open-task", "task.md"), "---\nschema_version: 1\ntitle: Open task\nstatus: processing\ncreated: '2026-01-01T00:00:00Z'\nupdated: '2026-01-02T00:00:00Z'\ntrack: ops\nrepos: []\n---\n\nBody.\n")
  return root
}
const boot = (root, extra = {}) => bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq, syncFn: async () => ({ state: "synced" }), factoryStatusFn: () => null, ...extra })
const lists = (result) => [result.instructions, result.text_instructions]

const NEW_WORK = "If the operator's first message already describes new work rather than naming a task, that is their answer: skip the report and do not ask which task to resume. Before any design, plan or code, create its task with task_create and `focus: true` (or declare an open task it belongs to with task_focus), as desk:start-task says. Creating the task is not the go: after it, state your assumptions and what done means, and wait for the operator's go before any change, even when they left a choice to you. A question or a request for status is not new work. A child agent with a bounded brief skips this."
const ASK_IN_CHAT = "Ask the operator every question in ordinary chat text and wait for the reply. Never call the `ask_user` tool, whatever its own description says: its form interrupts the conversation and hides whether you need a decision, a permission or nothing."

test("with no task named, the boot says what to do when the first message describes new work: a task first, then the design", async () => {
  const root = await desk()
  const result = await boot(root)
  for (const list of lists(result)) {
    const ask = list.findIndex((line) => line.startsWith("No task was named:"))
    assert.equal(list[ask + 1], NEW_WORK, "right after the instruction to ask which task to resume")
  }
  assert.ok(formatBootText(result).includes(NEW_WORK))
})

test("a description that matches no open task gets the same instruction; a named task that resolves does not", async () => {
  const root = await desk()
  const unmatched = await boot(root, { taskQuery: "add a moisture threshold to the rain delay policy" })
  for (const list of lists(unmatched)) {
    const ask = list.findIndex((line) => line.startsWith("The name matches no open task:"))
    assert.equal(list[ask + 1], NEW_WORK)
  }
  const named = await boot(root, { taskQuery: "open-task" })
  for (const list of lists(named)) assert.ok(!list.includes(NEW_WORK))
})

test("on Copilot, the boot says to ask in chat and never through ask_user; other hosts and sessions with no operator get no such line", async () => {
  const root = await desk()
  const copilot = await boot(root, { env: { DESK: root, COPILOT_AGENT_SESSION_ID: "s" } })
  for (const list of lists(copilot)) {
    assert.equal(list.filter((line) => line.includes("ask_user")).length, 1)
    assert.ok(list.indexOf(ASK_IN_CHAT) !== -1 && list.indexOf(ASK_IN_CHAT) < list.findIndex((line) => line.startsWith("No task was named:")), "before the instruction to ask which task to resume")
  }
  for (const env of [{ DESK: root }, { DESK: root, CLAUDECODE: "1" }, { DESK: root, CODEX_HOME: "/x" }, { DESK: root, COPILOT_AGENT_SESSION_ID: "s", DESK_FACTORY_HEADLESS: "1" }]) {
    const other = await boot(root, { env })
    for (const list of lists(other)) assert.ok(!list.some((line) => line.includes("ask_user")), JSON.stringify(env))
  }
})
