// Copilot's sessionStart hook records the session folder for the Desk server, and the plugin registers every guard Copilot can run.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { readCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "copilot-start-")))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

function start(input, name) {
  const home = path.join(ROOT, name)
  mkdirSync(home, { recursive: true })
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: process.env.PATH }
  const result = spawnSync(process.execPath, [path.join(plugin, "hooks", "copilot-session-start.cjs")], { input: JSON.stringify(input), env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return { env, context: JSON.parse(result.stdout).additionalContext }
}

test("the hook records the session folder under the session id, and the line names the same desk the server will bind", () => {
  const desk = path.join(ROOT, "a-desk")
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "_archive"), { recursive: true })
  const { env, context } = start({ sessionId: "sess-1", cwd: desk, source: "new" }, "one")
  assert.deepEqual(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "sess-1" } }), { folder: desk, activationConfig: null })
  assert.match(context, new RegExp(`Desk startup: \\$DESK is ${desk.replaceAll("/", "\\/")} \\(this session's project folder is a desk\\)`, "u"))
})

test("a hook payload with no session id records nothing but still starts the session", () => {
  const { env, context } = start({ cwd: ROOT }, "two")
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "undefined" } }), null)
  assert.match(context, /Desk startup:/u)
})

test("the plugin registers the card guard, the done-claim gate and its two feeders for Copilot", () => {
  const hooks = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json"), "utf8")).hooks
  const commands = (event) => hooks[event].map((entry) => entry.bash)
  assert.ok(commands("preToolUse").includes('node "${PLUGIN_ROOT}/hooks/task-status-guard.cjs" copilot'))
  assert.ok(commands("agentStop").includes('node "${PLUGIN_ROOT}/hooks/done-claim-gate.cjs" copilot stop'))
  assert.deepEqual(commands("postToolUse"), ['node "${PLUGIN_ROOT}/hooks/done-claim-gate.cjs" copilot track'])
  assert.deepEqual(commands("userPromptSubmitted"), ['node "${PLUGIN_ROOT}/hooks/done-claim-gate.cjs" copilot prompt', 'node "${PLUGIN_ROOT}/hooks/copilot-boot-prompt.cjs"'])
})

test("the first prompt of a session gets the boot direction as context, in either order with sessionStart, and later prompts get none", () => {
  const desk = path.join(ROOT, "boot-desk")
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "_archive"), { recursive: true })
  const { env } = start({ sessionId: "sess-boot", cwd: desk, source: "new" }, "boot")
  const prompt = (sessionId, input = "hi") => {
    const result = spawnSync(process.execPath, [path.join(plugin, "hooks", "copilot-boot-prompt.cjs")], { input: typeof input === "string" ? JSON.stringify({ sessionId, cwd: desk, prompt: input }) : "not json", env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const first = prompt("sess-boot")
  assert.match(first.additionalContext, /^Desk boot is pending for this session: run `node \S*session-boot\.js` first \(one quick call\), then answer this message\. A child agent with a bounded brief skips this\.$/u)
  assert.deepEqual(prompt("sess-boot"), {})
  assert.deepEqual(prompt("sess-boot", null), {}, "a broken payload fails open")

  // Copilot's real order on a new session: the prompt hook runs first, before sessionStart has recorded anything, and still directs the boot, once.
  const fresh = prompt("sess-prompt-first")
  assert.match(fresh.additionalContext, /^Desk boot is pending for this session/u)
  const session = spawnSync(process.execPath, [path.join(plugin, "hooks", "copilot-session-start.cjs")], { input: JSON.stringify({ sessionId: "sess-prompt-first", cwd: desk, source: "new" }), env, encoding: "utf8" })
  assert.equal(session.status, 0, session.stderr)
  assert.deepEqual(prompt("sess-prompt-first"), {}, "sessionStart after the claim does not re-arm the pointer")
})
