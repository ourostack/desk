// A hosted chat such as claude.ai never shows the model a server's MCP instructions and cannot load Desk's skills as plugin skills.
// desk_skill reads the skills through the server, and a hosted desk_status answer carries the instructions unless the conversation already has them.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { deskSkill, SKILLS_ROOT } from "../../../../plugins/desk/mcp/src/runtime/skills.js"
import { HAS_INSTRUCTIONS, HOSTED_SHELL_SKILLS, withHostedStartup } from "../../../../plugins/desk/mcp/src/runtime/hosted.js"
import { mkTempDeskRoot } from "./tools/_helpers.js"
import { DESK_STATUS_FIELDS } from "../../../../plugins/desk/mcp/src/tools/status.js"

const HOSTED = { DESK_HOSTED: "1" }
const parse = (result) => JSON.parse(result.content[0].text)

test("SKILLS_ROOT is the plugin's own skills folder", async () => {
  await fs.access(path.join(SKILLS_ROOT, "task-lifecycle", "SKILL.md"))
})

test("desk_skill with no name lists every skill with its description", () => {
  const listed = parse(deskSkill({}, { env: {} }))
  assert.equal(listed.status, "listed")
  const lifecycle = listed.skills.find((skill) => skill.name === "task-lifecycle")
  assert.ok(lifecycle.description.length > 0)
  assert.equal(listed.skills.some((skill) => "hosted_unavailable" in skill), false)
})

test("a hosted desk_skill list marks the skills that need a shell", () => {
  const listed = parse(deskSkill({}, { env: HOSTED }))
  const start = listed.skills.find((skill) => skill.name === "session-start")
  assert.equal(start.hosted_unavailable, HOSTED_SHELL_SKILLS["session-start"])
  assert.equal(listed.skills.find((skill) => skill.name === "task-lifecycle").hosted_unavailable, undefined)
})

test("desk_skill with a name returns that skill's text without its frontmatter", () => {
  const result = deskSkill({ name: "task-lifecycle" }, { env: HOSTED })
  assert.equal(result.isError, undefined)
  const text = result.content[0].text
  assert.match(text, /^# Desk skill: task-lifecycle\n\n/u)
  assert.doesNotMatch(text, /^---$/mu)
})

test("a hosted Desk refuses a skill that needs a shell, with the reason; a local Desk reads it", () => {
  const refused = deskSkill({ name: "git-hygiene" }, { env: HOSTED })
  assert.equal(refused.isError, true)
  assert.deepEqual(parse(refused), { status: "refused", code: "hosted_unavailable", skill: "git-hygiene", reason: HOSTED_SHELL_SKILLS["git-hygiene"] })
  assert.equal(deskSkill({ name: "git-hygiene" }, { env: {} }).isError, undefined)
})

test("desk_skill refuses a malformed or unknown name without reading outside the skills folder", () => {
  for (const name of ["../task-lifecycle", "Task", "a/b", 7]) assert.equal(parse(deskSkill({ name }, { env: {} })).code, "invalid_name", String(name))
  assert.equal(parse(deskSkill({ name: "no-such-skill" }, { env: {} })).code, "unknown_skill")
})

test("desk_skill on a missing or broken skills folder lists nothing and skips folders with no SKILL.md", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "empty-skill"))
  await fs.mkdir(path.join(root, "plain"))
  await fs.writeFile(path.join(root, "plain", "SKILL.md"), "No frontmatter.\n")
  assert.deepEqual(parse(deskSkill({}, { env: {}, skillsRoot: root })).skills, [{ name: "plain", description: "" }])
  assert.deepEqual(parse(deskSkill({}, { env: {}, skillsRoot: path.join(root, "missing") })).skills, [])
})

const answer = (payload, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) })

test("every hosted desk_status answer carries the instructions, so a new chat on a reused MCP session gets them; other tools are untouched", async () => {
  const calls = []
  const callTool = withHostedStartup({ callTool: async (call) => { calls.push(call.name); return answer({ state: "ready" }) }, instructions: "RULES", sleep: async () => {} })
  assert.equal((await callTool({ name: "desk_search" })).content.length, 1)
  for (const call of [{ name: "desk_status" }, { name: "desk_status", input: {} }, { name: "desk_status", input: { detail: true } }]) {
    const result = await callTool(call)
    assert.equal(result.content.length, 2)
    assert.match(result.content[1].text, /^# Desk instructions for this conversation\n[\s\S]*has_instructions: true[\s\S]*RULES$/u)
  }
  assert.deepEqual(calls, ["desk_search", "desk_status", "desk_status", "desk_status"])
})

test("has_instructions: true leaves the instructions out; any other value keeps them", async () => {
  assert.equal(HAS_INSTRUCTIONS, "has_instructions")
  assert.ok(DESK_STATUS_FIELDS.includes(HAS_INSTRUCTIONS), "the schema parity test covers the input the wrapper reads")
  const callTool = withHostedStartup({ callTool: async () => answer({ state: "ready" }), instructions: "RULES", sleep: async () => {} })
  assert.equal((await callTool({ name: "desk_status", input: { has_instructions: true } })).content.length, 1)
  assert.equal((await callTool({ name: "desk_status", input: { has_instructions: "true" } })).content.length, 2)
  assert.equal((await callTool({ name: "desk_status", input: { has_instructions: false } })).content.length, 2)
})

test("a hosted desk_status waits for a pending detail, a bounded number of times, even when it leaves the instructions out", async () => {
  const replies = [answer({ state: "ready", detail_pending: true }), answer({ state: "ready", detail_pending: true }), answer({ state: "ready", root: { path: "/d" } })]
  const slept = []
  const callTool = withHostedStartup({ callTool: async () => replies.shift(), instructions: "RULES", waitMs: 5_000, pollMs: 1_000, sleep: async (ms) => { slept.push(ms) } })
  const result = await callTool({ name: "desk_status", input: { has_instructions: true } })
  assert.deepEqual(JSON.parse(result.content[0].text).root, { path: "/d" })
  assert.equal(result.content.length, 1)
  assert.deepEqual(slept, [1_000, 1_000])

  let asked = 0
  const stuck = withHostedStartup({ callTool: async () => { asked += 1; return answer({ state: "ready", detail_pending: true }) }, instructions: "RULES", waitMs: 3_000, pollMs: 1_000, sleep: async () => {} })
  const still = await stuck({ name: "desk_status" })
  assert.equal(asked, 4)
  assert.equal(still.content.length, 2, "the instructions still arrive when the detail never loads")
})

test("an error answer, first or after waiting, never carries the instructions; an unparseable one does", async () => {
  const replies = [answer({ code: "x" }, true), { content: [{ type: "text", text: "not json" }] }]
  const callTool = withHostedStartup({ callTool: async () => replies.shift(), instructions: "RULES", sleep: async () => {} })
  assert.equal((await callTool({ name: "desk_status" })).content.length, 1)
  assert.equal((await callTool({ name: "desk_status" })).content.length, 2)

  const late = [answer({ detail_pending: true }), answer({ code: "y" }, true)]
  const flaky = withHostedStartup({ callTool: async () => late.shift(), instructions: "RULES", sleep: async () => {} })
  const failed = await flaky({ name: "desk_status" })
  assert.equal(failed.isError, true)
  assert.equal(failed.content.length, 1)
})

test("a cancelled desk_status stops waiting and carries no instructions", async () => {
  const controller = new AbortController()
  let asked = 0
  const callTool = withHostedStartup({ callTool: async () => { asked += 1; return answer({ detail_pending: asked < 3 }) }, instructions: "RULES", sleep: async () => { controller.abort() } })
  const cancelled = await callTool({ name: "desk_status", signal: controller.signal })
  assert.equal(cancelled.content.length, 1)
  assert.equal(asked, 2)

  const settled = new AbortController()
  settled.abort()
  const ready = withHostedStartup({ callTool: async () => answer({ state: "ready" }), instructions: "RULES", sleep: async () => {} })
  assert.equal((await ready({ name: "desk_status", signal: settled.signal })).content.length, 1, "an aborted call that already has a ready answer still carries none")
  assert.equal((await ready({ name: "desk_status", signal: settled.signal, input: { has_instructions: true } })).content.length, 1)
})

test("a desk_status that throws while waiting passes the error on", async () => {
  const replies = [async () => answer({ detail_pending: true }), async () => { throw new Error("boom") }]
  const callTool = withHostedStartup({ callTool: () => replies.shift()(), instructions: "RULES", sleep: async () => {} })
  await assert.rejects(callTool({ name: "desk_status" }), /boom/u)
})

test("the runtime server answers desk_skill itself", async () => {
  const { callTool } = await import("../../../../plugins/desk/mcp/src/server.js")
  const result = await callTool({ deskRoot: "/nonexistent", name: "desk_skill", input: { name: "task-lifecycle" }, statusContext: {} })
  assert.match(result.content[0].text, /^# Desk skill: task-lifecycle/u)
})

test("desk_skill called with no arguments lists the plugin's skills from the running environment", () => {
  assert.equal(parse(deskSkill()).status, "listed")
})

test("withHostedStartup's own sleep really waits between polls", async () => {
  const replies = [answer({ detail_pending: true }), answer({ state: "ready" })]
  const callTool = withHostedStartup({ callTool: async () => replies.shift(), instructions: "RULES", waitMs: 50, pollMs: 5 })
  const started = Date.now()
  const result = await callTool({ name: "desk_status" })
  assert.ok(Date.now() - started >= 4)
  assert.equal(result.content.length, 2)
})

test("a hosted desk_status also waits while Desk is still admitting the desk", async () => {
  const replies = [answer({ state: "admitting", root: { path: null } }), answer({ state: "admitting" }), answer({ state: "ready", root: { path: "/d" } })]
  const callTool = withHostedStartup({ callTool: async () => replies.shift(), instructions: "RULES", sleep: async () => {} })
  const result = await callTool({ name: "desk_status" })
  assert.equal(JSON.parse(result.content[0].text).state, "ready")
  assert.equal(result.content.length, 2)
})

test("a desk_status answer with no content, or no answer at all, still carries the instructions", async () => {
  for (const reply of [{}, undefined]) {
    const callTool = withHostedStartup({ callTool: async () => reply, instructions: "RULES", sleep: async () => {} })
    const result = await callTool({ name: "desk_status" })
    assert.equal(result.content.length, 1)
    assert.match(result.content[0].text, /# Desk instructions for this conversation[\s\S]*RULES/)
  }
})

async function listWithDescription(frontmatterLines) {
  const root = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "desk-skills-"))
  await fs.mkdir(path.join(root, "demo"))
  await fs.writeFile(path.join(root, "demo", "SKILL.md"), `---\nname: demo\n${frontmatterLines}\n---\n\nBody\n`)
  return parse(deskSkill({}, { env: {}, skillsRoot: root })).skills[0].description
}

test("desk_skill lists a folded >- description as joined text", async () => {
  assert.equal(await listWithDescription("description: >-\n  First line\n  second line."), "First line second line.")
})

test("desk_skill lists a folded > description as joined text", async () => {
  assert.equal(await listWithDescription("description: >\n  First line\n  second line.\nlicense: x"), "First line second line.")
})

test("desk_skill lists a literal | and |- description as text", async () => {
  assert.equal(await listWithDescription("description: |\n  First line\n  second line."), "First line\nsecond line.")
  assert.equal(await listWithDescription("description: |-\n  First line\n  second line."), "First line\nsecond line.")
})

test("desk_skill lists quoted and plain single-line descriptions", async () => {
  assert.equal(await listWithDescription('description: "Quoted: text here"'), "Quoted: text here")
  assert.equal(await listWithDescription("description: Plain text here"), "Plain text here")
})

test("desk_skill lists a skill whose frontmatter cannot be read with an empty description", async () => {
  assert.equal(await listWithDescription("description: First\ndescription: Second"), "")
})

test("no real plugin skill is listed with an empty or block-indicator description", () => {
  for (const skill of parse(deskSkill({}, { env: {} })).skills) {
    assert.ok(skill.description.length > 0, `${skill.name} has an empty description`)
    assert.doesNotMatch(skill.description, /^[>|]/u, `${skill.name} description starts with a block indicator`)
  }
})
