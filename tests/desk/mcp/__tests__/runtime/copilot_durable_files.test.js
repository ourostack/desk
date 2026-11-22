import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const SESSION = "11111111-2222-4333-8444-555555555555"

function invoke(env, payload, raw) {
  const result = spawnSync(process.execPath, [path.join(plugin, "hooks/copilot-durable-files.cjs")], {
    env, input: raw ?? JSON.stringify(payload), encoding: "utf8", timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function machine({ focus }) {
  const home = await mkTempRoot("durable-files-")
  const copilot = path.join(home, ".copilot")
  const session = path.join(copilot, "session-state", SESSION)
  mkdirSync(path.join(session, "files"), { recursive: true })
  const desk = path.join(home, "desk")
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "_archive"), { recursive: true })
  mkdirSync(path.join(desk, "tooling", "ship-it"), { recursive: true })
  writeFileSync(path.join(desk, "tooling", "ship-it", "task.md"), "---\nstatus: active\n---\nbody\n")
  const events = focus ? [{ type: "tool.execution_start", data: { toolCallId: "f1", toolName: "desk-task_focus", arguments: { track: "tooling", slug: "ship-it" } } }] : []
  writeFileSync(path.join(session, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n")
  writeFileSync(path.join(session, "workspace.yaml"), `cwd: ${desk}\n`)
  return { env: { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot }, copilot, desk }
}

const call = (copilot, toolName, file) => ({ sessionId: SESSION, timestamp: 1, cwd: "/", toolName, toolArgs: { path: path.join(copilot, "session-state", SESSION, ...file) } })

test("a durable file in the session's files folder is allowed with a note naming the focused task's folder", async () => {
  const { env, copilot, desk } = await machine({ focus: true })
  for (const [tool, file] of [["create", ["files", "inventory.md"]], ["edit", ["files", "report.csv"]], ["generate_image", ["images", "art.png"]]]) {
    const out = invoke(env, call(copilot, tool, file))
    assert.equal(out.permissionDecision, "allow")
    assert.match(out.additionalContext, new RegExp(`desk folder instead: ${path.join(desk, "tooling", "ship-it").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"))
  }
})

test("with no focused task the note says to run start-task first", async () => {
  const { env, copilot } = await machine({ focus: false })
  const out = invoke(env, call(copilot, "create", ["files", "plan.md"]))
  assert.equal(out.permissionDecision, "allow")
  assert.match(out.additionalContext, /run start-task first/u)
})

test("scratch, other folders and unreadable input are left alone, and the hook never fails", async () => {
  const { env, copilot, desk } = await machine({ focus: true })
  assert.deepEqual(invoke(env, call(copilot, "create", ["files", "scratch.txt"])), {}, "a throwaway extension")
  assert.deepEqual(invoke(env, { sessionId: SESSION, toolName: "create", toolArgs: { path: path.join(desk, "tooling", "ship-it", "report.md") } }), {}, "the desk folder")
  assert.deepEqual(invoke(env, call(copilot, "create", ["plan.md"])), {}, "outside files/ and images/")
  assert.deepEqual(invoke(env, null, "not json"), {})
  assert.deepEqual(invoke(env, { toolName: "create", toolArgs: "{" }), {})
})

test("oversized input stays fail-open but reports its byte limit", () => {
  for (const raw of ['{"data":"' + "x".repeat(262145) + '"}', '{"data":"' + "\u00e9".repeat(140000) + '"}']) {
    const result = spawnSync(process.execPath, [path.join(plugin, "hooks/copilot-durable-files.cjs")], {
      env: process.env, input: raw, encoding: "utf8", timeout: 5000,
    })
    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout), {})
    assert.match(result.stderr, /input_too_large.*262144 bytes/u)
  }
})
