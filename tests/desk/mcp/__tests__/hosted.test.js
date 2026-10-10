// Hosted Desk: the flag, the refusal list, the skill list and the tool annotations.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { READ_ONLY_TOOLS } from "../../../../plugins/desk/mcp/src/factory/headless-flag.js"
import { FRONT_DOOR_TOOLS } from "../../../../plugins/desk/mcp/src/runtime/front-door.js"
import { createDeskSession } from "../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import {
  HOSTED_SHELL_SKILLS,
  HOSTED_UNAVAILABLE,
  HOSTED_UNAVAILABLE_REPAIRS,
  TOOL_ANNOTATIONS,
  hostedRefusal,
  isHosted,
} from "../../../../plugins/desk/mcp/src/runtime/hosted.js"
import { TOOL_NAMES } from "../../../../plugins/desk/mcp/src/tool-names.js"
import { DOCTOR_REPAIRS } from "../../../../plugins/desk/mcp/src/tool-schemas.js"
import { mkTempRoot } from "./_temp_roots.js"

const hosted = { DESK_HOSTED: "1" }
const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../plugins/desk/skills")

test("isHosted: unset, empty and 0 are off; anything else is on", () => {
  for (const env of [{}, undefined, { DESK_HOSTED: "" }, { DESK_HOSTED: "0" }]) assert.equal(isHosted(env), false)
  assert.equal(isHosted(hosted), true)
  assert.equal(isHosted({ DESK_HOSTED: " " }), true)
})

test("hostedRefusal refuses the listed tools with the exact reason and leaves the rest alone", () => {
  assert.deepEqual(hostedRefusal("improvement_next", {}, hosted), {
    status: "refused",
    code: "hosted_unavailable",
    tool: "improvement_next",
    reason: "A claimed improvement card needs a coding harness to work it; a hosted chat claim would only hold the card.",
  })
  for (const name of ["desk_recall", "desk_similar"]) assert.equal(hostedRefusal(name, {}, hosted).reason, "Hosted Desk has no embedding endpoint; use desk_search.")
  assert.equal(hostedRefusal("task_update", {}, hosted), null)
  assert.equal(hostedRefusal("improvement_next", {}, {}), null, "an ordinary session is never refused")
  assert.equal(hostedRefusal("desk_recall", {}, { DESK_HOSTED: "0" }), null)
})

test("hostedRefusal refuses only the host-machine doctor repairs", () => {
  for (const repair of Object.keys(HOSTED_UNAVAILABLE_REPAIRS)) {
    const refused = hostedRefusal("desk_doctor", { repair }, hosted)
    assert.equal(refused.code, "hosted_unavailable")
    assert.equal(refused.reason, "This repair acts on the machine Desk runs on, which is the hosted service, not yours.")
    assert.equal(hostedRefusal("desk_doctor", { repair }, {}), null)
  }
  assert.equal(hostedRefusal("desk_doctor", {}, hosted), null)
  assert.equal(hostedRefusal("desk_doctor", null, hosted), null)
  assert.equal(hostedRefusal("desk_doctor", { repair: "switch_state_branch" }, hosted), null)
  assert.equal(hostedRefusal("desk_doctor", { repair: "toString" }, hosted), null)
  assert.equal(hostedRefusal("task_update", { repair: "reclaim_controller" }, hosted), null)
})

test("the lists name real tools, repairs and skills", () => {
  for (const name of Object.keys(HOSTED_UNAVAILABLE)) assert.ok(TOOL_NAMES.includes(name), name)
  for (const repair of Object.keys(HOSTED_UNAVAILABLE_REPAIRS)) assert.ok(DOCTOR_REPAIRS.includes(repair), repair)
  for (const skill of Object.keys(HOSTED_SHELL_SKILLS)) assert.ok(existsSync(path.join(skillsDir, skill, "SKILL.md")), skill)
  for (const reason of Object.values(HOSTED_SHELL_SKILLS)) assert.ok(reason.length > 0)
})

test("TOOL_ANNOTATIONS covers every tool: read-only is the read-only list minus desk_doctor; destructive is the four overwriting tools", () => {
  assert.deepEqual(Object.keys(TOOL_ANNOTATIONS), TOOL_NAMES)
  const readOnly = TOOL_NAMES.filter((name) => TOOL_ANNOTATIONS[name].readOnlyHint)
  assert.deepEqual(readOnly.sort(), READ_ONLY_TOOLS.filter((name) => name !== "desk_doctor").sort())
  const destructive = TOOL_NAMES.filter((name) => TOOL_ANNOTATIONS[name].destructiveHint)
  assert.deepEqual(destructive.sort(), ["desk_save", "task_archive", "task_move", "track_rename"])
  assert.equal(TOOL_ANNOTATIONS.desk_doctor.readOnlyHint, false)
})

test("every front-door tool carries its annotations", () => {
  assert.equal(FRONT_DOOR_TOOLS.length, TOOL_NAMES.length)
  for (const tool of FRONT_DOOR_TOOLS) assert.deepEqual(tool.annotations, TOOL_ANNOTATIONS[tool.name], tool.name)
})

async function sessionWith(t, env) {
  const base = await mkTempRoot("desk-hosted-")
  const root = path.join(base, "desk")
  mkdirSync(root, { recursive: true })
  const calls = []
  const runtime = {
    callTool: async ({ name }) => {
      calls.push(name)
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", tool: name }) }] }
    },
    connectOrStartController: async () => ({ accepted: true, async status() { return { state: "READY" } } }),
  }
  const session = createDeskSession({
    args: { person: null },
    env,
    deskStateDir: path.join(base, "state"),
    readinessStateHome: path.join(base, "readiness"),
    stderr: { write: () => {} },
    resolveInputs: async () => ({ root: { root, source: "explicit-root" }, activation: { activationStatus: null, readinessPolicy: { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" }, stateBranch: null } }),
    loadRuntime: async () => ({ runtimeServer: runtime, runtimeStatus: { state: "ready" } }),
    hung: { probe: async () => ({ state: "refused" }) },
  })
  t.after(() => session.dispose())
  return { session, calls }
}

test("a hosted session refuses improvement_next and a host-machine repair before any implementation runs", async (t) => {
  const { session, calls } = await sessionWith(t, hosted)
  const result = await session.callTool({ name: "improvement_next" })
  assert.equal(result.isError, true)
  assert.deepEqual(JSON.parse(result.content[0].text), hostedRefusal("improvement_next", {}, hosted))
  const repair = await session.callTool({ name: "desk_doctor", input: { repair: "prune_readiness_state" } })
  assert.equal(repair.isError, true)
  assert.equal(JSON.parse(repair.content[0].text).code, "hosted_unavailable")
  assert.deepEqual(calls, [])
  assert.equal(JSON.parse((await session.callTool({ name: "desk_search", input: { query: "x" } })).content[0].text).tool, "desk_search")
})

test("a session without the flag still reaches the implementation", async (t) => {
  const { session, calls } = await sessionWith(t, {})
  await session.callTool({ name: "improvement_next" })
  assert.deepEqual(calls, ["improvement_next"])
})

test("a session answers desk_skill itself, before admission and without the runtime", async (t) => {
  const { session, calls } = await sessionWith(t, hosted)
  const result = await session.callTool({ name: "desk_skill", input: { name: "task-lifecycle" } })
  assert.match(result.content[0].text, /^# Desk skill: task-lifecycle/u)
  assert.equal(JSON.parse((await session.callTool({ name: "desk_skill", input: { name: "git-hygiene" } })).content[0].text).code, "hosted_unavailable")
  assert.deepEqual(calls, [])
})
