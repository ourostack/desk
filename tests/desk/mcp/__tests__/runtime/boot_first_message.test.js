// What the boot says about the operator's first message: new work gets a task before any design (cold dry runs, 2026-10-12).
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText, NEW_WORK_INSTRUCTION as NEW_WORK, NEW_WORK_GO_SENTENCE as GO } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

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


test("with no task named, the boot says what to do when the first message describes new work: a task first, then the design", async () => {
  const root = await desk()
  const result = await boot(root)
  for (const list of lists(result)) {
    const ask = list.findIndex((line) => line.startsWith("No task was named:"))
    assert.equal(list[ask + 1], NEW_WORK, "right after the instruction to ask which task to resume")
  }
  assert.ok(formatBootText(result).includes(NEW_WORK))
})

test("a session with no operator is not told to wait for a go: it gets the instruction without that sentence", async () => {
  const root = await desk()
  assert.ok(NEW_WORK.includes(GO))
  for (const extra of [{}, { taskQuery: "add a moisture threshold to the rain delay policy" }]) {
    const unattended = await boot(root, { ...extra, env: { DESK: root, CLAUDECODE: "1", DESK_FACTORY_HEADLESS: "1" } })
    for (const list of lists(unattended)) {
      assert.ok(list.includes(NEW_WORK.replace(GO, "")), "the task-first instruction is still there")
      assert.ok(!list.some((line) => line.includes("wait for the operator's go")), "nobody is there to give a go")
    }
  }
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
