// A hosted chat such as claude.ai never shows the model a server's MCP instructions and cannot load Desk's skills as plugin skills.
// desk_skill reads the skills through the server, and the first desk_status answer of a hosted session carries the instructions.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { deskSkill, SKILLS_ROOT } from "../../../../plugins/desk/mcp/src/runtime/skills.js"
import { HOSTED_SHELL_SKILLS, withHostedStartup } from "../../../../plugins/desk/mcp/src/runtime/hosted.js"
import { mkTempDeskRoot } from "./tools/_helpers.js"

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

test("the first hosted desk_status answer carries the instructions once; other tools and later calls are untouched", async () => {
  const calls = []
  const callTool = withHostedStartup({ callTool: async (call) => { calls.push(call.name); return answer({ state: "ready" }) }, instructions: "RULES", sleep: async () => {} })
  assert.equal((await callTool({ name: "desk_search" })).content.length, 1)
  const first = await callTool({ name: "desk_status" })
  assert.equal(first.content.length, 2)
  assert.match(first.content[1].text, /^# Desk instructions for this session\n[\s\S]*RULES$/u)
  assert.equal((await callTool({ name: "desk_status" })).content.length, 1)
  assert.deepEqual(calls, ["desk_search", "desk_status", "desk_status"])
})

test("the first hosted desk_status waits for a pending detail, a bounded number of times", async () => {
  const replies = [answer({ state: "ready", detail_pending: true }), answer({ state: "ready", detail_pending: true }), answer({ state: "ready", root: { path: "/d" } })]
  const slept = []
  const callTool = withHostedStartup({ callTool: async () => replies.shift(), instructions: "RULES", waitMs: 5_000, pollMs: 1_000, sleep: async (ms) => { slept.push(ms) } })
  const result = await callTool({ name: "desk_status" })
  assert.deepEqual(JSON.parse(result.content[0].text).root, { path: "/d" })
  assert.deepEqual(slept, [1_000, 1_000])

  let asked = 0
  const stuck = withHostedStartup({ callTool: async () => { asked += 1; return answer({ state: "ready", detail_pending: true }) }, instructions: "RULES", waitMs: 3_000, pollMs: 1_000, sleep: async () => {} })
  const still = await stuck({ name: "desk_status" })
  assert.equal(asked, 4)
  assert.equal(still.content.length, 2, "the instructions still arrive when the detail never loads")
})

test("an error answer or an unparseable one never carries the instructions, and the next desk_status still does", async () => {
  const replies = [answer({ code: "x" }, true), { content: [{ type: "text", text: "not json" }] }]
  const callTool = withHostedStartup({ callTool: async () => replies.shift(), instructions: "RULES", sleep: async () => {} })
  assert.equal((await callTool({ name: "desk_status" })).content.length, 1)
  assert.equal((await callTool({ name: "desk_status" })).content.length, 2)

  const late = [answer({ detail_pending: true }), answer({ code: "y" }, true), answer({ state: "ready" })]
  const flaky = withHostedStartup({ callTool: async () => late.shift(), instructions: "RULES", sleep: async () => {} })
  assert.equal((await flaky({ name: "desk_status" })).isError, true)
  assert.equal((await flaky({ name: "desk_status" })).content.length, 2)
})
