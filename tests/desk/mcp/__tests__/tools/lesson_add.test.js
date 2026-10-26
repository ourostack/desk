// lesson_add — a correction lands where something loads it, and the reply says whether it is in effect.
//
// personal: a line in the person's AGENTS.md, which every session start prints.
// desk: a system friction entry plus an improvement card against the named owner.
// team: the exact line for the shared workspace's AGENTS.md, written through Crew's shared-path protocol.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { lesson_add } from "../../../../../plugins/desk/mcp/src/tools/lesson.js"
import { AGENTS_MD_CAP_BYTES } from "../../../../../plugins/desk/mcp/src/runtime/agents-md.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { osEnv } from "../_os_env.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"

const DAY = /\d{4}-\d{2}-\d{2}/u.source

function initGit(root) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  }
  run(["init", "-q"])
  run(["config", "user.email", "test@example.com"])
  run(["config", "user.name", "Test"])
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

const personal = (topic, body) => ({ scope: "personal", topic, body })

// ── personal ────────────────────────────────────────────────────────────────

test("lesson_add personal creates AGENTS.md with a Lessons section and says session start loads it", async () => {
  const root = await mkTempDeskRoot()
  const result = await lesson_add({ deskRoot: root, input: personal("Answer before a long wait.", "Reply to the operator before starting a blocking wait.") })
  assert.equal(result.status, "added")
  assert.equal(result.scope, "personal")
  assert.equal(result.path, "AGENTS.md")
  assert.equal(result.in_effect, true)
  assert.match(result.message, /every session start/u)
  assert.match(result.message, /AGENTS\.md/u)
  const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  assert.match(content, new RegExp(`^## Lessons\\n\\n- \\*\\*Answer before a long wait\\.\\*\\* Reply to the operator before starting a blocking wait\\. \\(${DAY}\\)\\n$`, "u"))
})

test("lesson_add personal adds to the end of an existing Lessons section, before the next section", async () => {
  const root = await mkTempDeskRoot()
  const before = "# Desk\n\n## Operator\n\n- Ari.\n\n## Lessons\n\n- **Old.** Old rule. (2026-01-01)\n\n## North Star\n\nText.\n"
  await fs.writeFile(path.join(root, "AGENTS.md"), before, "utf8")
  await lesson_add({ deskRoot: root, input: personal("New", "New rule.") })
  const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  assert.match(content, new RegExp(`^# Desk\\n\\n## Operator\\n\\n- Ari\\.\\n\\n## Lessons\\n\\n- \\*\\*Old\\.\\*\\* Old rule\\. \\(2026-01-01\\)\\n- \\*\\*New\\.\\*\\* New rule\\. \\(${DAY}\\)\\n\\n## North Star\\n\\nText\\.\\n$`, "u"))
})

test("lesson_add personal appends a Lessons section to an AGENTS.md that has none", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n\nRules.", "utf8")
  await lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") })
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), new RegExp(`^# Desk\\n\\nRules\\.\\n\\n## Lessons\\n\\n- \\*\\*Rule\\.\\*\\* Do it\\. \\(${DAY}\\)\\n$`, "u"))
})

test("lesson_add personal replaces the line for the same topic instead of adding a second one", async () => {
  const root = await mkTempDeskRoot()
  await lesson_add({ deskRoot: root, input: personal("Rule", "First wording.") })
  await lesson_add({ deskRoot: root, input: personal("Other", "Other rule.") })
  const result = await lesson_add({ deskRoot: root, input: personal("Rule.", "Second wording.") })
  assert.equal(result.status, "updated")
  const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  assert.equal(content.includes("First wording"), false)
  assert.match(content, new RegExp(`\\n- \\*\\*Rule\\.\\*\\* Second wording\\. \\(${DAY}\\)\\n- \\*\\*Other\\.\\*\\* Other rule\\.`, "u"))
})

test("lesson_add personal with a person writes that person's AGENTS.md in a shared workspace", async () => {
  const root = await mkTempDeskRoot()
  const result = await lesson_add({ deskRoot: root, person: "ari", input: personal("Rule", "Do it.") })
  assert.equal(result.path, path.posix.join("desks", "ari", "AGENTS.md"))
  assert.ok(await exists(path.join(root, "desks", "ari", "AGENTS.md")))
  assert.equal(await exists(path.join(root, "AGENTS.md")), false)
})

test("lesson_add refuses a lesson that session start would not load because AGENTS.md is past its limit", async () => {
  const root = await mkTempDeskRoot()
  const big = `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 20)}\n`
  await fs.writeFile(path.join(root, "AGENTS.md"), big, "utf8")
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") }), /16 KB/u)
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), big)
})

test("lesson_add checks its input", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(() => lesson_add({ deskRoot: root }), /scope/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: { topic: "x", body: "y" } }), /scope/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: { scope: "everyone", topic: "x", body: "y" } }), /scope/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal(undefined, "y") }), /topic/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal(" . ", "y") }), /topic/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("x", 3) }), /body/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("x\ny", "y") }), /one line/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("x", "first\n\nsecond") }), /one line/u)
  assert.equal(await exists(path.join(root, "AGENTS.md")), false)
})

test("lesson_add personal commits exactly AGENTS.md and schedules one push", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "other.md"), "x", "utf8")
  git(root, ["add", "other.md"])
  const calls = []
  const result = await lesson_add({ deskRoot: root, input: personal("Rule", "Do it."), schedulePush: (opts) => calls.push(opts) })
  assert.equal(result.commit, undefined)
  assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "lesson_add: personal rule")
  assert.deepEqual(git(root, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean), ["AGENTS.md"])
  assert.match(git(root, ["status", "--short"]), /^A  other\.md$/mu)
  assert.deepEqual(calls, [{ root }])
})

test("lesson_add personal leaves an AGENTS.md that already held unstaged edits uncommitted", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n", "utf8")
  git(root, ["add", "AGENTS.md"])
  git(root, ["commit", "-q", "-m", "init"])
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n\nAnother session's edit.\n", "utf8")
  const calls = []
  await lesson_add({ deskRoot: root, input: personal("Rule", "Do it."), schedulePush: (opts) => calls.push(opts) })
  assert.equal(git(root, ["log", "--format=%s"]).trim(), "init")
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /Another session's edit\.\n\n## Lessons/u)
  assert.deepEqual(calls, [])
})

test("lesson_add personal reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "boom" } : spawnSync(cmd, args, opts))
  const result = await lesson_add({ deskRoot: root, input: personal("Rule", "Do it."), spawnGit, schedulePush: () => {} })
  assert.equal(result.commit.status, "failed")
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /Do it\./u)
})

// ── desk ────────────────────────────────────────────────────────────────────

function frictionSpy(answer) {
  const calls = []
  const addFriction = async (args) => {
    calls.push(args)
    return answer
  }
  return { calls, addFriction }
}

test("lesson_add desk refuses a lesson with no owner, or an owner nothing has", async () => {
  const root = await mkTempDeskRoot()
  const { calls, addFriction } = frictionSpy({})
  const desk = (owner) => ({ scope: "desk", topic: "Rule", body: "Do it.", owner })
  await assert.rejects(() => lesson_add({ deskRoot: root, input: desk(undefined), addFriction }), /owner/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: desk("somewhere"), addFriction }), /owner/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: desk("skill:desk:no-such-skill"), addFriction }), /no-such-skill/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: desk("tool:no_such_tool"), addFriction }), /no_such_tool/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: desk("skill:elsewhere:x"), addFriction }), /owner/u)
  assert.equal(calls.length, 0)
})

test("lesson_add desk records system friction against the owner and says it is not in effect until the card ships", async () => {
  const root = await mkTempDeskRoot()
  const { calls, addFriction } = frictionSpy({ status: "added", path: "_meta/friction.md", kaizen: "candidate", improvement: "opened" })
  const env = { marker: true }
  const result = await lesson_add({ deskRoot: root, person: "ari", env, input: { scope: "desk", topic: "Answer before a long wait", body: "Reply before a blocking wait.", owner: "skill:desk:interaction-style" }, addFriction })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].deskRoot, root)
  assert.equal(calls[0].person, "ari")
  assert.equal(calls[0].env, env)
  assert.deepEqual(calls[0].input, {
    about: "system",
    title: "Lesson for skill:desk:interaction-style: Answer before a long wait",
    plugin: "desk",
    friction_class: "skill",
    body: "Lesson for `skill:desk:interaction-style`: **Answer before a long wait.** Reply before a blocking wait.",
  })
  assert.deepEqual(result, {
    status: "routed",
    scope: "desk",
    owner: "skill:desk:interaction-style",
    path: "_meta/friction.md",
    improvement: "opened",
    in_effect: false,
    message: "Not in effect yet. An improvement card is open against skill:desk:interaction-style; the lesson takes effect when the change it asks for ships.",
  })
})

test("lesson_add desk maps each kind of owner to its plugin and friction class", async () => {
  const root = await mkTempDeskRoot()
  const { calls, addFriction } = frictionSpy({ improvement: "duplicate" })
  for (const owner of ["tool:lesson_add", "brief", "foundation", "skill:crew:shared-desk-conventions", "skill:superpowers:brainstorming", "skill:plain-language:plain-language"]) {
    await lesson_add({ deskRoot: root, input: { scope: "desk", topic: "Rule", body: "Do it.", owner }, addFriction })
  }
  assert.deepEqual(calls.map((call) => [call.input.plugin, call.input.friction_class]), [
    ["desk", "mcp_tool"], ["desk", "skill"], ["desk", "skill"], ["crew", "skill"], ["superpowers", "skill"], ["plain-language", "skill"],
  ])
})

test("lesson_add desk says plainly when no improvement card opened", async () => {
  const root = await mkTempDeskRoot()
  const base = await mkTempDeskRoot()
  // No factory state on this machine: the friction entry is written, but no card can open.
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  const result = await lesson_add({ deskRoot: root, env, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "foundation" } })
  assert.equal(result.in_effect, false)
  assert.equal(result.improvement, "factory_state_unavailable")
  assert.equal(result.message, "Not in effect, and no improvement card opened (factory_state_unavailable), so nothing will act on this lesson yet. The note is in _meta/friction.md.")
  assert.match(await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8"), /Lesson for `foundation`: \*\*Rule\.\*\* Do it\./u)
})

test("lesson_add desk opens a real improvement card when the factory state is ready", async () => {
  const root = await mkTempDeskRoot()
  const base = await mkTempDeskRoot()
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  await factoryStateRoot(env)
  const result = await lesson_add({ deskRoot: root, env, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "brief" } })
  assert.equal(result.improvement, "opened")
  assert.equal((await fs.readdir(path.join(root, "_meta", "improvement"))).filter((name) => name.endsWith(".md")).length, 1)
})

// ── team ────────────────────────────────────────────────────────────────────

async function crewRoot() {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n", "utf8")
  return root
}

test("lesson_add team refuses outside a shared workspace", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(() => lesson_add({ deskRoot: root, person: "ari", input: { scope: "team", topic: "Rule", body: "Do it." } }), /shared workspace/u)
})

test("lesson_add team needs a person to attribute the lesson to", async () => {
  const root = await crewRoot()
  await assert.rejects(() => lesson_add({ deskRoot: root, input: { scope: "team", topic: "Rule", body: "Do it." } }), /person/u)
})

test("lesson_add team gives the exact line for the shared AGENTS.md and writes nothing", async () => {
  const root = await crewRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Crew\n", "utf8")
  const result = await lesson_add({ deskRoot: root, person: "ari", input: { scope: "team", topic: "Build what was asked", body: "When someone asks for a List, build a List." } })
  assert.equal(result.status, "shared_write_needed")
  assert.equal(result.scope, "team")
  assert.equal(result.path, "AGENTS.md")
  assert.equal(result.section, "## Lessons")
  assert.match(result.line, new RegExp(`^- \\*\\*Build what was asked\\.\\*\\* When someone asks for a List, build a List\\. \\(ari, ${DAY}\\)$`, "u"))
  assert.equal(result.in_effect, false)
  assert.match(result.message, /shared-path/u)
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "# Crew\n")
  assert.equal(await exists(path.join(root, "desks", "ari", "AGENTS.md")), false)
})

test("lesson_add team refuses when the shared AGENTS.md would pass the session start limit", async () => {
  const root = await crewRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(AGENTS_MD_CAP_BYTES), "utf8")
  await assert.rejects(() => lesson_add({ deskRoot: root, person: "ari", input: { scope: "team", topic: "Rule", body: "Do it." } }), /16 KB/u)
})

test("lesson_add team names the line it replaces when the topic is already there", async () => {
  const root = await crewRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Crew\n\n## Lessons\n\n- **Rule.** Old wording. (bo, 2026-01-01)\n", "utf8")
  const result = await lesson_add({ deskRoot: root, person: "ari", input: { scope: "team", topic: "Rule", body: "New wording." } })
  assert.equal(result.replaces, "- **Rule.** Old wording. (bo, 2026-01-01)")
})

test("lesson_add personal refuses an AGENTS.md that is a link out of the desk", async () => {
  const root = await mkTempDeskRoot()
  const outside = await mkTempDeskRoot()
  await fs.writeFile(path.join(outside, "AGENTS.md"), "# Elsewhere\n", "utf8")
  await fs.symlink(path.join(outside, "AGENTS.md"), path.join(root, "AGENTS.md"))
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") }), /symbolic link/u)
  assert.equal(await fs.readFile(path.join(outside, "AGENTS.md"), "utf8"), "# Elsewhere\n")
})

test("lesson_add personal fills an empty Lessons section and tells search what changed", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\n\n## Lessons\n\n## Later\n", "utf8")
  const changed = []
  await lesson_add({ deskRoot: root, input: personal("Rule", "Do it."), search: { noteChange: (rel) => changed.push(rel) } })
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), new RegExp(`^# Desk\\n\\n## Lessons\\n\\n- \\*\\*Rule\\.\\*\\* Do it\\. \\(${DAY}\\)\\n\\n## Later\\n$`, "u"))
  assert.deepEqual(changed, ["AGENTS.md"])
})

test("lesson_add refuses a topic with no word in it and a skill owner that is not a skill name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("!!!", "y") }), /topic/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "skill:desk:Bad Name" }, addFriction: async () => ({}) }), /owner/u)
})

test("lesson_add personal keeps a blank line before a heading that followed the last lesson directly", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "## Lessons\n\n- **Old.** Old. (2026-01-01)\n## Next\n", "utf8")
  await lesson_add({ deskRoot: root, input: personal("New", "New.") })
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), new RegExp(`^## Lessons\\n\\n- \\*\\*Old\\.\\*\\* Old\\. \\(2026-01-01\\)\\n- \\*\\*New\\.\\*\\* New\\. \\(${DAY}\\)\\n\\n## Next\\n$`, "u"))
})
