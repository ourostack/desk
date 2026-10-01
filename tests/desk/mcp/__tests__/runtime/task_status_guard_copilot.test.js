// The task-card guard on Copilot CLI: its `preToolUse` payloads (`bash`, `powershell`, `create`, `edit`, `apply_patch`; live-checked on 1.0.89) are read as the Claude-shaped calls the guard already judges, and a deny is written flat.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"
import { taskStatusGuardHook } from "../../../../../plugins/desk/mcp/src/runtime/task-status-guard.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "task-status-guard.cjs")

const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-copilot-")))
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))
const DESK = path.join(SCRATCH, "desk")
mkdirSync(path.join(DESK, "_meta"), { recursive: true })
mkdirSync(path.join(DESK, "_archive"), { recursive: true })
const CARD_PATH = path.join(DESK, "greenhouse", "watering-api", "task.md")
mkdirSync(path.dirname(CARD_PATH), { recursive: true })
const CARD = "---\ntitle: Watering API\nstatus: processing\n---\n\n# Watering API\n\nNext: write the test.\n"
writeFileSync(CARD_PATH, CARD)

const pre = (toolName, toolArgs, extra = {}) => ({ sessionId: "s1", timestamp: 1790000000000, cwd: DESK, toolName, toolArgs, ...extra })
const guard = (input, context = { root: DESK }) => taskStatusGuardHook(input, "copilot", undefined, context)
const denied = (result) => {
  assert.deepEqual(Object.keys(result).sort(), ["permissionDecision", "permissionDecisionReason"], "flat, with no wrapper")
  assert.equal(result.permissionDecision, "deny")
  assert.match(result.permissionDecisionReason, /task_update/u)
  return result.permissionDecisionReason
}

test("a direct edit of a live card is denied, and the reason names task_update", () => {
  denied(guard(pre("edit", { path: CARD_PATH, old_str: "Next: write the test.", new_str: "Next: celebrate." })))
  const status = denied(guard(pre("edit", { path: CARD_PATH, old_str: "status: processing", new_str: "status: done" })))
  assert.match(status, /evidence/u, "a move to done names the evidence it needs")
})

test("the Copilot deny names the Copilot tool (desk-task_update), not Claude Code's ToolSearch, and is no longer than the Claude Code deny", () => {
  const edit = { path: CARD_PATH, old_str: "Next: write the test.", new_str: "Next: celebrate." }
  const reason = denied(guard(pre("edit", edit)))
  assert.match(reason, /`desk-task_update`/u)
  assert.doesNotMatch(reason, /ToolSearch|mcp__plugin_desk_desk__/u)
  const shell = denied(guard(pre("bash", `sed -i 's/processing/done/' ${CARD_PATH}`)))
  assert.match(shell, /`desk-task_update`/u)
  const claude = taskStatusGuardHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: CARD_PATH, old_string: "Next: write the test.", new_string: "Next: celebrate." }, cwd: DESK }, "claude", undefined, { root: DESK }).hookSpecificOutput.permissionDecisionReason
  assert.match(claude, /ToolSearch/u)
  assert.doesNotMatch(claude, /desk-task_update/u)
  assert.ok(reason.length <= claude.length)
})

test("create over a live card is denied, a new card born done is denied, and a new card not done is allowed", () => {
  denied(guard(pre("create", { path: CARD_PATH, file_text: CARD })))
  denied(guard(pre("create", { path: path.join(DESK, "greenhouse", "fresh-task", "task.md"), file_text: "---\ntitle: x\nstatus: done\n---\n" })))
  assert.deepEqual(guard(pre("create", { path: path.join(DESK, "greenhouse", "fresh-task", "task.md"), file_text: "---\ntitle: x\nstatus: drafting\n---\n" })), {})
})

test("apply_patch on a live card is denied: an update, a delete, a rename away and a rename onto a card", () => {
  const update = "*** Begin Patch\n*** Update File: greenhouse/watering-api/task.md\n@@\n-status: processing\n+status: done\n*** End Patch\n"
  denied(guard(pre("apply_patch", update)))
  const body = "*** Begin Patch\n*** Update File: greenhouse/watering-api/task.md\n@@\n-Next: write the test.\n+Next: celebrate.\n*** End Patch\n"
  denied(guard(pre("apply_patch", body)))
  denied(guard(pre("apply_patch", "*** Begin Patch\n*** Delete File: greenhouse/watering-api/task.md\n*** End Patch\n")))
  denied(guard(pre("apply_patch", "*** Begin Patch\n*** Update File: greenhouse/watering-api/task.md\n*** Move to: greenhouse/elsewhere/other.md\n*** End Patch\n")))
  // The same card, spelled as an absolute path.
  denied(guard(pre("apply_patch", body.replace("greenhouse/watering-api/task.md", CARD_PATH))))
  // A patch that adds a card born done is denied.
  denied(guard(pre("apply_patch", "*** Begin Patch\n*** Add File: greenhouse/brand-new/task.md\n+---\n+status: done\n+---\n*** End Patch\n")))
})

test("apply_patch on anything else is allowed, and so is one that adds a card not done", () => {
  assert.deepEqual(guard(pre("apply_patch", "*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch\n")), {})
  assert.deepEqual(guard(pre("apply_patch", "*** Begin Patch\n*** Add File: greenhouse/brand-new/task.md\n+---\n+status: drafting\n+---\n*** End Patch\n")), {})
  assert.deepEqual(guard(pre("apply_patch", "not a patch")), {})
})

test("a shell command that writes a live card is denied, and one that only reads it is allowed", () => {
  for (const toolName of ["bash", "powershell"]) {
    denied(guard(pre(toolName, { command: `echo "status: done" >> ${CARD_PATH}`, description: "x" })))
    denied(guard(pre(toolName, { command: "sed -i 's/processing/done/' greenhouse/watering-api/task.md" })))
    assert.deepEqual(guard(pre(toolName, { command: `cat ${CARD_PATH}` })), {})
    assert.deepEqual(guard(pre(toolName, { command: "git status" })), {})
  }
  assert.deepEqual(guard(pre("bash", { description: "no command" })), {})
  assert.deepEqual(guard(pre("bash", { command: 7 })), {})
})

test("a tool that writes nothing, or a card outside the bound desk, is allowed", () => {
  assert.deepEqual(guard(pre("view", { path: CARD_PATH })), {})
  assert.deepEqual(guard(pre("grep", { pattern: "status", path: CARD_PATH })), {})
  assert.deepEqual(guard(pre("desk-task_update", { track: "greenhouse", slug: "watering-api", note: "x" })), {})
  const outside = path.join(SCRATCH, "elsewhere", "t", "s", "task.md")
  mkdirSync(path.dirname(outside), { recursive: true })
  writeFileSync(outside, CARD)
  assert.deepEqual(guard(pre("edit", { path: outside, old_str: "status: processing", new_str: "status: done" })), {})
})

test("the session's recorded folder, not the current folder, decides which desk the guard protects", () => {
  const home = path.join(SCRATCH, "home")
  mkdirSync(home, { recursive: true })
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: process.env.PATH }
  const elsewhere = path.join(SCRATCH, "not-a-desk")
  mkdirSync(elsewhere, { recursive: true })
  const command = { command: `echo x >> $DESK/greenhouse/watering-api/task.md` }
  // No record and no other binding: $DESK means nothing, so a card named through it is not recognized.
  assert.deepEqual(taskStatusGuardHook(pre("bash", command, { sessionId: "unrecorded", cwd: elsewhere }), "copilot", undefined, { env }), {})
  recordCopilotSession({ sessionId: "recorded", folder: DESK, env })
  denied(taskStatusGuardHook(pre("bash", command, { sessionId: "recorded", cwd: elsewhere }), "copilot", undefined, { env }))
})

test("any other host, and a malformed payload, are allowed", () => {
  for (const host of [undefined, "codex", "some-future-host"]) assert.deepEqual(taskStatusGuardHook(pre("edit", { path: CARD_PATH, old_str: "a", new_str: "b" }), host, undefined, { root: DESK }), {})
  assert.deepEqual(guard(undefined), {})
  assert.deepEqual(guard({}), {})
})

function runHook(host, input, env = { PATH: process.env.PATH }) {
  const result = spawnSync(process.execPath, [hook, host], { input: typeof input === "string" ? input : JSON.stringify(input), env, encoding: "utf8" })
  return { result, output: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) }
}

test("the entry point answers Copilot's deny flat over real stdin/stdout, allows what it does not judge, and fails open on a broken call", () => {
  const home = path.join(SCRATCH, "process-home")
  mkdirSync(home, { recursive: true })
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: process.env.PATH }
  const { result, output } = runHook("copilot", pre("edit", { path: CARD_PATH, old_str: "status: processing", new_str: "status: done" }), env)
  assert.equal(result.status, 0)
  assert.match(denied(output), /evidence/u)
  const patch = runHook("copilot", pre("apply_patch", "*** Begin Patch\n*** Update File: greenhouse/watering-api/task.md\n@@\n-status: processing\n+status: done\n*** End Patch\n"), env)
  denied(patch.output)
  // A tool it does not judge is answered without loading the guard.
  assert.deepEqual(runHook("copilot", pre("view", { path: CARD_PATH }), env).output, {})
  assert.deepEqual(runHook("copilot", pre("desk-desk_status", {}), env).output, {})
  // A shell command that never names task.md is answered without loading the guard, in either host's spelling.
  assert.deepEqual(runHook("copilot", pre("bash", { command: "ls -la" }), env).output, {})
  assert.deepEqual(runHook("claude", { tool_name: "Bash", tool_input: { command: "ls -la" } }, env).output, {})
  const shell = runHook("copilot", pre("bash", { command: `echo hi >> ${CARD_PATH}` }), env)
  denied(shell.output)
  const broken = runHook("copilot", "not json", env)
  // On Copilot a nonzero exit is itself a signal to the host, so an internal error answers `{}` and exits 0; Claude's behaviour is unchanged (exit 1, never 2).
  assert.equal(broken.result.status, 0)
  assert.deepEqual(broken.output, {})
  assert.match(broken.result.stderr, /could not inspect this call, allowing it/u)
  const brokenClaude = runHook("claude", "not json", env)
  assert.equal(brokenClaude.result.status, 1)
})

test("a Copilot tool Desk has never heard of is denied when it edits a live card, and a view of the card is allowed", () => {
  for (const name of ["str_replace", "write", "multi_edit"]) denied(guard(pre(name, { path: CARD_PATH, old_str: "status: processing", new_str: "status: done" })))
  denied(guard(pre("edit", { file_path: CARD_PATH, old_str: "status: processing", new_str: "status: done" })))
  assert.deepEqual(guard(pre("view", { path: CARD_PATH })), {})
  assert.deepEqual(guard(pre("read_file", { file_path: CARD_PATH })), {})
  assert.deepEqual(guard(pre("write", { path: path.join(SCRATCH, "notes.md"), new_str: "x" })), {}, "a file that is not a card")
})
