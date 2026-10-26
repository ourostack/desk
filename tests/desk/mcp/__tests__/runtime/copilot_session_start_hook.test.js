// Copilot's sessionStart hook records the session folder for the Desk server, and the plugin registers every guard Copilot can run.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
  assert.match(context, new RegExp(`Desk startup: \\$DESK is ${desk.replace(/[.*+?^${}()|[\]\\\/]/gu, "\\$&")} \\(this session's project folder is a desk\\)`, "u"))
})

test("a hook payload with no session id records nothing but still starts the session", () => {
  const { env, context } = start({ cwd: ROOT }, "two")
  assert.equal(readCopilotSession({ env: { ...env, COPILOT_AGENT_SESSION_ID: "undefined" } }), null)
  assert.match(context, /Desk startup:/u)
})

test("a session start turns Copilot's AI co-author commit trailer and question form off once when the operator never set them, and says so in one combined line", () => {
  const home = path.join(ROOT, "trailer")
  mkdirSync(path.join(home, ".copilot"), { recursive: true })
  const settings = path.join(home, ".copilot", "settings.json")
  const first = start({ sessionId: "sess-trailer", cwd: ROOT, source: "new" }, "trailer")
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { memory: false, includeCoAuthoredBy: false, askUser: false })
  const lines = first.context.split("\n").filter((line) => /includeCoAuthoredBy|askUser/u.test(line))
  assert.equal(lines.length, 1, "a first session gets one line for both settings")
  assert.match(first.context, /\n\nDesk startup: set `includeCoAuthoredBy: false` and `askUser: false` in \S+settings\.json, so from the next session Copilot adds no AI co-author trailer and the ask_user form is off; in this session add no trailer and ask in plain chat\. Desk keeps a value the operator sets\.\n\n/u)
  assert.doesNotMatch(start({ sessionId: "sess-trailer-2", cwd: ROOT, source: "new" }, "trailer").context, /includeCoAuthoredBy|askUser/u, "the next session says nothing")
  assert.doesNotMatch(start({ sessionId: "sess-no-copilot", cwd: ROOT, source: "new" }, "no-copilot-folder").context, /includeCoAuthoredBy|askUser/u, "a home with no Copilot folder is left alone")
})

test("a session start that sets only the question form says so in its own line and keeps an explicit choice", () => {
  const home = path.join(ROOT, "ask-only")
  mkdirSync(path.join(home, ".copilot"), { recursive: true })
  const settings = path.join(home, ".copilot", "settings.json")
  writeFileSync(settings, JSON.stringify({ memory: false, includeCoAuthoredBy: false }))
  const { context } = start({ sessionId: "sess-ask-only", cwd: ROOT, source: "new" }, "ask-only")
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { memory: false, includeCoAuthoredBy: false, askUser: false })
  assert.doesNotMatch(context, /includeCoAuthoredBy/u)
  assert.equal(context.split("\n").filter((line) => line.includes("askUser")).length, 1)
  writeFileSync(settings, JSON.stringify({ memory: false, includeCoAuthoredBy: false, askUser: true }))
  assert.doesNotMatch(start({ sessionId: "sess-ask-kept", cwd: ROOT, source: "new" }, "ask-only").context, /askUser/u)
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).askUser, true, "an explicit askUser: true is kept")
})

test("every Copilot session is told to act as Desk's worker unless it was started as another agent", () => {
  const { context } = start({ sessionId: "sess-worker", cwd: ROOT, source: "new" }, "worker")
  assert.match(context, /\n\nUnless started with `--agent`, act as Desk's worker: read \S+worker\.agent\.md first\.\n\n# Using Desk/u, "the pointer comes just before the foundation, whose frontmatter is dropped")
  assert.doesNotMatch(context, /^name: using-desk$/mu)
})

test("every Desk session disables explicitly enabled native memory and injects the versioned prohibition", () => {
  const home = path.join(ROOT, "native-memory")
  mkdirSync(path.join(home, ".copilot"), { recursive: true })
  const settings = path.join(home, ".copilot", "settings.json")
  for (let attempt = 0; attempt < 2; ++attempt) {
    writeFileSync(settings, JSON.stringify({ memory: true, model: "x", includeCoAuthoredBy: false, askUser: false }))
    const { context } = start({ sessionId: `sess-memory-${attempt}`, cwd: ROOT, source: "new" }, "native-memory")
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { memory: false, model: "x", includeCoAuthoredBy: false, askUser: false })
    assert.match(context, /Disable host memory \(`store_memory`\/`vote_memory`\)/u)
    assert.match(context, /native memory/u)
  }
})

test("the plugin registers only Desk's own boundary hooks for Copilot", () => {
  const hooks = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json"), "utf8")).hooks
  const commands = (event) => hooks[event].map((entry) => entry.bash)
  assert.equal(hooks.preToolUse, undefined, "Desk registers no hook on the host's tool calls")
  assert.deepEqual(commands("postToolUse"), ['node "${PLUGIN_ROOT}/hooks/copilot-intake-context.cjs"'])
  assert.equal(hooks.postToolUse[0].matcher, "skill")
  assert.deepEqual(commands("agentStop"), ['node "${PLUGIN_ROOT}/hooks/factory-end.cjs" copilot'])
  assert.deepEqual(commands("userPromptSubmitted"), ['node "${PLUGIN_ROOT}/hooks/copilot-boot-prompt.cjs"'])
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
  assert.match(first.additionalContext, /^Desk boot is pending for this session: run `node \S*session-boot\.js` first \(one quick call\), then answer this message\. Do this before anything else, including any search of files or folders; nothing else counts as the boot\. A child agent with a bounded brief skips this\.$/u)
  assert.deepEqual(prompt("sess-boot"), {})
  assert.deepEqual(prompt("sess-boot", null), {}, "a broken payload fails open")

  // Copilot's real order on a new session: the prompt hook runs first, before sessionStart has recorded anything, and still directs the boot, once.
  const fresh = prompt("sess-prompt-first")
  assert.match(fresh.additionalContext, /^Desk boot is pending for this session/u)
  const session = spawnSync(process.execPath, [path.join(plugin, "hooks", "copilot-session-start.cjs")], { input: JSON.stringify({ sessionId: "sess-prompt-first", cwd: desk, source: "new" }), env, encoding: "utf8" })
  assert.equal(session.status, 0, session.stderr)
  assert.deepEqual(prompt("sess-prompt-first"), {}, "sessionStart after the claim does not re-arm the pointer")
})
