import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const sessionId = "11111111-1111-4111-8111-111111111111"
const input = cwd => ({
  sessionId, timestamp: 1792283246000, cwd, toolName: "skill",
  toolArgs: { skill: "brainstorming" },
  toolResult: { resultType: "success",
    textResultForLlm: 'Skill "brainstorming" loaded successfully. Follow the instructions in the skill context.' },
})

function invoke(cwd, env, value) {
  const result = spawnSync(process.execPath, [path.join(plugin, "hooks/copilot-intake-context.cjs")], {
    cwd, env, input: JSON.stringify(value), encoding: "utf8", timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  return JSON.parse(result.stdout)
}

test("a known root skill success receives bounded source-owned intake context, not another lifecycle", async () => {
  const cwd = await mkTempRoot("copilot-intake-root-")
  const good = input(cwd), env = { ...process.env, XDG_STATE_HOME: path.join(cwd, "state") }
  assert.equal(recordCopilotSession({ sessionId, folder: cwd, env }), true)
  for (const toolArgs of [good.toolArgs, JSON.stringify(good.toolArgs)]) {
    const result = invoke(cwd, env, { ...good, toolArgs })
    assert.deepEqual(Object.keys(result), ["additionalContext"])
    assert.ok(Buffer.byteLength(result.additionalContext) < 10000)
    for (const text of ["task", "Outcome", "Assumptions", "Recommended decisions", "Done means",
      "before", "existing", "go", "normal chat", "using-superpowers-with-desk"])
      assert.ok(result.additionalContext.includes(text), text)
    assert.doesNotMatch(result.additionalContext, /run the boot|session-boot|task_signoff|accepted|permissionDecision/u)
    assert.equal(JSON.stringify(good), JSON.stringify(input(cwd)), "input and tool result stay untouched")
  }
})

test("children, unknown scopes, failures and unrelated skills receive no context", async () => {
  const cwd = await mkTempRoot("copilot-intake-refusals-"), good = input(cwd)
  const env = { ...process.env, XDG_STATE_HOME: path.join(cwd, "state") }
  assert.equal(recordCopilotSession({ sessionId, folder: cwd, env }), true)
  const cases = [
    null, [], {}, { ...good, unknown: true }, { ...good, sessionId: "unknown" }, { ...good, sessionId: [sessionId] },
    { ...good, timestamp: null }, { ...good, cwd: "relative" }, { ...good, toolName: "task" },
    { ...good, toolArgs: [] }, { ...good, toolArgs: "{" },
    { ...good, toolArgs: { skill: "brainstorming", extra: true } },
    { ...good, toolArgs: { skill: "superpowers:brainstorming" } },
    { ...good, toolArgs: { skill: "writing-plans" } },
    { ...good, toolResult: null }, { ...good, toolResult: [] },
    { ...good, toolResult: { resultType: "failure", textResultForLlm: "failed" } },
    { ...good, toolResult: { resultType: "success", textResultForLlm: "unknown result" } },
    { ...good, toolResult: { ...good.toolResult, extra: true } },
  ]
  for (const key of ["agentId", "agentType", "parentAgentId"])
    for (const value of [null, "", "child"]) cases.push({ ...good, [key]: value })
  for (const candidate of cases) assert.deepEqual(invoke(cwd, env, candidate), {})
})

test("intake and its adapter put canonical task identity ahead of method selection", () => {
  const start = readFileSync(path.join(plugin, "skills/start-task/SKILL.md"), "utf8")
  const adapter = readFileSync(path.join(plugin, "skills/using-superpowers-with-desk/SKILL.md"), "utf8")
  assert.match(start, /canonical task.*before.*adapter/iu)
  assert.match(adapter, /canonical task.*before.*provider/iu)
})

test("the actual hook reads only its started-session binding and emits the same finite source context", async () => {
  const cwd = await mkTempRoot("copilot-intake-command-")
  const env = { ...process.env, XDG_STATE_HOME: path.join(cwd, "state") }
  const execute = raw => spawnSync(process.execPath, [path.join(plugin, "hooks/copilot-intake-context.cjs")], {
    cwd, env, input: raw, encoding: "utf8", timeout: 5000,
  })
  const good = input(cwd)
  const unstarted = execute(JSON.stringify(good))
  assert.equal(unstarted.status, 0, unstarted.stderr)
  assert.deepEqual(JSON.parse(unstarted.stdout), {})
  assert.equal(recordCopilotSession({ sessionId, folder: cwd, env }), true)
  const actual = execute(JSON.stringify(good))
  assert.equal(actual.status, 0, actual.stderr)
  assert.equal(actual.stderr, "")
  const context = JSON.parse(actual.stdout)
  assert.deepEqual(Object.keys(context), ["additionalContext"])
  assert.match(context.additionalContext, /^Desk intake handoff \(context only;/u)
  for (const candidate of [{ ...good, cwd: path.dirname(cwd) }, { ...good, agentId: null }]) {
    const refused = execute(JSON.stringify(candidate))
    assert.equal(refused.status, 0, refused.stderr)
    assert.deepEqual(JSON.parse(refused.stdout), {})
    assert.equal(refused.stderr, "")
  }
  for (const raw of ["{", "x".repeat(262145)]) {
    const refused = execute(raw)
    assert.equal(refused.status, 0)
    assert.deepEqual(JSON.parse(refused.stdout), {})
    assert.match(refused.stderr, /^Desk intake context unavailable: (SyntaxError|input_too_large)\n$/u)
  }
  for (const activation_targets of [[], [{ id: "desk:worker" }], [{ id: "desk:worker", depends_on: ["work-suite"] }]]) {
    const code = `
      const fs=require("node:fs"),read=fs.readFileSync;
      fs.readFileSync=function(file,...args){
        return file===${JSON.stringify(path.join(plugin, "activation/desk.activation.json"))}?
          ${JSON.stringify(JSON.stringify({ provides: { activation_targets } }))}:read.call(this,file,...args);
      };
      require(${JSON.stringify(path.join(plugin, "hooks/copilot-intake-context.cjs"))});
    `
    const refused = spawnSync(process.execPath, ["-e", code], { cwd, env, input: JSON.stringify(good), encoding: "utf8", timeout: 5000 })
    assert.equal(refused.status, 0)
    assert.deepEqual(JSON.parse(refused.stdout), {}, "a missing or different selected method cannot emit intake context")
  }
})
