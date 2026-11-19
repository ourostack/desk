import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))

function invoke(env, payload) {
  const result = spawnSync(process.execPath, [path.join(plugin, "hooks/copilot-lane-model.cjs")], {
    env, input: JSON.stringify(payload), encoding: "utf8", timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function envWith(config) {
  const root = await mkTempRoot("lane-model-")
  if (config !== undefined) {
    const dir = path.join(root, "ouroboros-skills", "desk")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "config.json"), JSON.stringify(config))
  }
  const env = { ...process.env, XDG_STATE_HOME: root }
  delete env.DESK_LANE_MODEL
  return env
}

const call = (toolName, toolArgs) => ({ sessionId: "s", timestamp: 1, cwd: "/", toolName, toolArgs })

test("a session start with no kickoff.model gets the lane default, with the other arguments kept", async () => {
  const env = await envWith()
  for (const toolName of ["create_session", "open_issue_session", "open_pr_session"]) {
    for (const wrap of [x => x, JSON.stringify]) {
      const out = invoke(env, call(toolName, wrap({ name: "lane", kickoff: { prompt: "go" } })))
      assert.equal(out.permissionDecision, "allow")
      assert.deepEqual(out.modifiedArgs, { name: "lane", kickoff: { prompt: "go", model: "claude-sonnet-5.5", mode: "autopilot" } })
    }
  }
  assert.deepEqual(invoke(env, call("create_session", { name: "x" })).modifiedArgs, { name: "x", kickoff: { model: "claude-sonnet-5.5", mode: "autopilot" } })
  assert.equal(invoke(env, call("app-create_session", { name: "x" })).modifiedArgs.kickoff.model, "claude-sonnet-5.5")
})

test("an explicit model is never changed; the default is configurable", async () => {
  const env = await envWith({ laneModel: "claude-haiku-4.5" })
  assert.deepEqual(invoke(env, call("create_session", { kickoff: { model: "claude-opus-4.6", mode: "plan" } })), {})
  assert.equal(invoke(env, call("create_session", { kickoff: { model: "claude-opus-4.6" } })).modifiedArgs.kickoff.model, "claude-opus-4.6")
  assert.equal(invoke(env, call("create_session", { kickoff: { prompt: "p" } })).modifiedArgs.kickoff.model, "claude-haiku-4.5")
  assert.equal(invoke({ ...env, DESK_LANE_MODEL: "gpt-5.3-codex" }, call("create_session", {})).modifiedArgs.kickoff.model, "gpt-5.3-codex")
})

test("an explicit mode is never changed, and a missing one becomes autopilot", async () => {
  const env = await envWith()
  assert.deepEqual(invoke(env, call("create_session", { kickoff: { model: "m", mode: "plan" } })), {})
  assert.deepEqual(invoke(env, call("open_pr_session", { kickoff: { prompt: "p", mode: "interactive" } })).modifiedArgs.kickoff, { prompt: "p", mode: "interactive", model: "claude-sonnet-5.5" })
  assert.deepEqual(invoke(env, call("open_issue_session", { kickoff: { prompt: "p", model: "m" } })).modifiedArgs.kickoff, { prompt: "p", model: "m", mode: "autopilot" })
})

test("a cloud session is started locally so it loads the plugin bundle, unless DESK_ALLOW_CLOUD_SESSIONS=1", async () => {
  const env = await envWith()
  const args = { project_id: "p", execution_location: "cloud", kickoff: { prompt: "p", model: "m", mode: "autopilot" } }
  assert.deepEqual(invoke(env, call("create_session", args)).modifiedArgs, { project_id: "p", kickoff: args.kickoff })
  assert.deepEqual(invoke(env, call("create_session", { ...args, execution_location: "local" })), {})
  assert.deepEqual(invoke({ ...env, DESK_ALLOW_CLOUD_SESSIONS: "1" }, call("create_session", args)), {})
})

test("other tools and unreadable input are left alone", async () => {
  const env = await envWith("not an object")
  for (const payload of [call("bash", { command: "ls" }), call("create_session_x", {}), call("create_session", "{"), call("create_session", { kickoff: "x" }), null, []])
    assert.deepEqual(invoke(env, payload), {})
  assert.equal(invoke(env, call("create_session", {})).modifiedArgs.kickoff.model, "claude-sonnet-5.5")
})
