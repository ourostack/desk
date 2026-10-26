// lesson_add — a correction lands where something loads it, and the reply says whether it is in effect.
//
// personal: a line in the person's AGENTS.md, which every session start prints.
// desk: a system friction entry plus an improvement card against the named owner.
// team: lesson_team.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { lesson_add as lessonAdd } from "../../../../../plugins/desk/mcp/src/tools/lesson.js"
import { AGENTS_MD_CAP_BYTES } from "../../../../../plugins/desk/mcp/src/runtime/agents-md.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { osEnv } from "../_os_env.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"

const DAY = /\d{4}-\d{2}-\d{2}/u.source
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk")
const SOLO = async () => ({ status: "ok", personPrefix: "" })

// Every call gets a fixed environment and, unless the test says otherwise, a session start that resolves a solo desk.
const lesson_add = (args) => lessonAdd({ env: {}, personOf: SOLO, ...args })

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
  assert.match(result.message, /session start prints for you/u)
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
  const root = await crewRoot()
  const result = await lesson_add({ deskRoot: root, person: "ari", personOf: async () => ({ status: "ok", personPrefix: "desks/ari" }), input: personal("Rule", "Do it.") })
  assert.equal(result.path, path.posix.join("desks", "ari", "AGENTS.md"))
  assert.equal(result.in_effect, true)
  assert.ok(await exists(path.join(root, "desks", "ari", "AGENTS.md")))
  assert.equal(await exists(path.join(root, "AGENTS.md")), false)
})

test("lesson_add personal refuses in a shared workspace when the session has no person, so the team's AGENTS.md is never written", async () => {
  const root = await crewRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Crew\n", "utf8")
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("Rule", "I want short replies.") }), /shared workspace and this session has no person/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, person: " ", input: personal("Rule", "I want short replies.") }), /no person/u)
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "# Crew\n")
})

test("lesson_add personal is not in effect when session start resolves a different person, or none", async () => {
  const root = await crewRoot()
  const other = await lesson_add({ deskRoot: root, person: "ari", personOf: async () => ({ status: "ok", personPrefix: "desks/bo" }), input: personal("Rule", "Do it.") })
  assert.equal(other.in_effect, false)
  assert.equal(other.message, "Written to desks/ari/AGENTS.md, but not in effect: session start on this desk prints desks/bo/AGENTS.md, not this file; set DESK_PERSON to the alias this session writes for.")
  const none = await lesson_add({ deskRoot: root, person: "ari", personOf: async () => ({ status: "unresolved", reason: "login_not_cached" }), input: personal("Rule", "Do it.") })
  assert.equal(none.in_effect, false)
  assert.match(none.message, /cannot tell whose desk this is \(login_not_cached\)/u)
  const solo = await mkTempDeskRoot()
  const elsewhere = await lesson_add({ deskRoot: solo, person: "ari", input: personal("Rule", "Do it.") })
  assert.equal(elsewhere.in_effect, false)
  assert.match(elsewhere.message, /prints only the desk's AGENTS\.md, not this file/u)
})

test("lesson_add personal asks session start's own lookup, with the call's environment", async () => {
  const root = await crewRoot()
  const result = await lessonAdd({ deskRoot: root, person: "ari", env: { DESK_PERSON: "ari" }, input: personal("Rule", "Do it.") })
  assert.equal(result.in_effect, true)
  const unset = await lessonAdd({ deskRoot: root, person: "ari", env: { HOME: root }, now: Date.now(), input: personal("Rule", "Do it again.") })
  assert.equal(unset.in_effect, false)
})

test("lesson_add personal counts the desk's AGENTS.md against the shared budget session start prints", async () => {
  const root = await crewRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), `# Crew\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 40)}\n`, "utf8")
  await assert.rejects(() => lesson_add({ deskRoot: root, person: "ari", input: personal("Rule", "Do it.") }), /session start prints only the first \d+ bytes of desks\/ari\/AGENTS\.md \(what the desk's AGENTS\.md leaves of the 16 KB both share\)/u)
  assert.equal(await exists(path.join(root, "desks", "ari", "AGENTS.md")), false)
})

test("lesson_add personal judges a lesson by the part of the file session start prints, even when the lesson fits but the file runs past it", async () => {
  const root = await mkTempDeskRoot()
  // The Lessons section comes first, so the new line lands near the top while the file as a whole passes the cap.
  const long = `# Desk\n\n## Lessons\n\n- **Old.** Kept. (2026-01-01)\n\n## Notes\n\n${"x".repeat(AGENTS_MD_CAP_BYTES)}\n`
  await fs.writeFile(path.join(root, "AGENTS.md"), long, "utf8")
  const result = await lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") })
  assert.equal(result.in_effect, true)
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /\*\*Rule\.\*\* Do it\./u)
})

test("lesson_add personal treats the same lesson twice on one day as already in effect, with nothing to commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const pushes = []
  const schedulePush = (call) => pushes.push(call)
  const first = await lesson_add({ deskRoot: root, schedulePush, input: personal("Rule", "Do it.") })
  const again = await lesson_add({ deskRoot: root, schedulePush, input: personal("Rule", "Do it.") })
  assert.equal(first.in_effect, true)
  assert.deepEqual([again.status, again.in_effect, again.commit], ["unchanged", true, undefined])
  assert.equal(git(root, ["log", "--format=%s"]).trim().split("\n").length, 1)
  assert.equal(pushes.length, 1)
})

test("lesson_add personal keeps a CRLF file's line ending and finds its Lessons section", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Desk\r\n\r\n## Lessons\r\n\r\n- **Rule.** Old. (2026-01-01)\r\n\r\n## Next\r\n", "utf8")
  await lesson_add({ deskRoot: root, input: personal("New", "New.") })
  const result = await lesson_add({ deskRoot: root, input: personal("Rule", "Replaced.") })
  assert.equal(result.status, "updated")
  const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  assert.match(content, new RegExp(`^# Desk\\r\\n\\r\\n## Lessons\\r\\n\\r\\n- \\*\\*Rule\\.\\*\\* Replaced\\. \\(${DAY}\\)\\r\\n- \\*\\*New\\.\\*\\* New\\. \\(${DAY}\\)\\r\\n\\r\\n## Next\\r\\n$`, "u"))
  assert.equal(content.match(/## Lessons/gu).length, 1)
})

test("lesson_add personal serialises writes to one AGENTS.md, so two at once both land", async () => {
  const root = await mkTempDeskRoot()
  await Promise.all(["One", "Two", "Three", "Four"].map((topic) => lesson_add({ deskRoot: root, input: personal(topic, `${topic} rule.`) })))
  const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf8")
  for (const topic of ["One", "Two", "Three", "Four"]) assert.match(content, new RegExp(`\\*\\*${topic}\\.\\*\\*`, "u"))
  assert.equal(await exists(path.join(root, ".agents-md.lock")), false)
})

test("lesson_add personal refuses, writing nothing, while another session holds the AGENTS.md lock", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, ".agents-md.lock", "held"), { recursive: true })
  await assert.rejects(() => lesson_add({ deskRoot: root, lockWaitMs: 30, input: personal("Rule", "Do it.") }), /another session is writing AGENTS\.md/u)
  assert.equal(await exists(path.join(root, "AGENTS.md")), false)
})

test("lesson_add refuses a lesson that session start would not load because AGENTS.md is past its limit", async () => {
  const root = await mkTempDeskRoot()
  const big = `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 20)}\n`
  await fs.writeFile(path.join(root, "AGENTS.md"), big, "utf8")
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") }), new RegExp(`session start prints only the first ${AGENTS_MD_CAP_BYTES} bytes of AGENTS\\.md,`, "u"))
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
  assert.equal(result.in_effect, true)
  assert.equal(result.message, "In effect: the lesson is in AGENTS.md, which session start prints for you on this desk.")
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
  const result = await lesson_add({ deskRoot: root, input: personal("Rule", "Do it."), schedulePush: (opts) => calls.push(opts) })
  assert.equal(result.in_effect, false)
  assert.equal(result.message, "Written to AGENTS.md, but not in effect: it is not committed (AGENTS.md already held changes from elsewhere, so Desk left it for you to commit), so other machines do not have it.")
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
  assert.equal(result.in_effect, false)
  assert.match(result.message, /the commit failed: boom/u)
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
  const scan = () => ({ dirs: [] })
  await assert.rejects(() => lesson_add({ deskRoot: root, scan, input: desk("skill:desk:no-such-skill"), addFriction }), /the desk plugin has no skill named no-such-skill/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: desk("tool:no_such_tool"), addFriction }), /no_such_tool/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, scan, input: desk("skill:elsewhere:x"), addFriction }), /no installed plugin is named elsewhere \(installed: desk\)/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, scan, input: desk("skill:Bad:x"), addFriction }), /owner/u)
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
  const scan = () => ({ dirs: plugins })
  // What a host has installed: a Copilot-style plugin.json, a Claude-style .claude-plugin/plugin.json, two folders of
  // one plugin, and folders with no or a broken manifest.
  const plugins = [
    await plugin({ "plugin.json": { name: "ms-desk" } }, ["ecs-rollout"]),
    await plugin({ ".claude-plugin/plugin.json": { name: "superpowers" } }, ["brainstorming"]),
    // A host's cache keeps old versions beside the active one: only the newest counts, and a version beats none.
    await plugin({ "plugin.json": { name: "pwf" } }, ["removed"]),
    await plugin({ "plugin.json": { name: "pwf", version: "1.2.0" } }, ["adapter-acceptance"]),
    await plugin({ "plugin.json": { name: "pwf", version: "1.1.0" } }, ["removed"]),
    await plugin({ "plugin.json": { name: "pwf" } }, ["removed"]),
    // An old Desk in the same cache never stands in for the Desk that is running.
    await plugin({ "plugin.json": { name: "desk", version: "99.0.0" } }, ["stale-only"]),
    await plugin({ "plugin.json": "{not json" }, ["x"]),
    await plugin({ "plugin.json": { version: "1.0.0" } }, ["x"]),
    await plugin({}, ["x"]),
  ]
  for (const owner of ["tool:lesson_add", "brief", "foundation", "skill:desk:evidence-discipline", "skill:ms-desk:ecs-rollout", "skill:superpowers:brainstorming", "skill:pwf:adapter-acceptance"]) {
    await lesson_add({ deskRoot: root, scan, input: { scope: "desk", topic: "Rule", body: "Do it.", owner }, addFriction })
  }
  assert.deepEqual(calls.map((call) => [call.input.plugin, call.input.friction_class]), [
    ["desk", "mcp_tool"], ["desk", "skill"], ["desk", "skill"], ["desk", "skill"], ["ms-desk", "skill"], ["superpowers", "skill"], ["pwf", "skill"],
  ])
  await assert.rejects(() => lesson_add({ deskRoot: root, scan, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "skill:superpowers:no-such" }, addFriction }), /the superpowers plugin has no skill named no-such/u)
  for (const [owner, plugin] of [["skill:pwf:removed", "pwf"], ["skill:desk:stale-only", "desk"]]) {
    await assert.rejects(() => lesson_add({ deskRoot: root, scan, input: { scope: "desk", topic: "Rule", body: "Do it.", owner }, addFriction }), new RegExp(`the ${plugin} plugin has no skill named`, "u"))
  }
})

async function plugin(files, skills) {
  const dir = await mkTempDeskRoot()
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content), "utf8")
  }
  for (const skill of skills) {
    await fs.mkdir(path.join(dir, "skills", skill), { recursive: true })
    await fs.writeFile(path.join(dir, "skills", skill, "SKILL.md"), "---\nname: x\n---\n", "utf8")
  }
  return dir
}

test("lesson_add desk finds Desk's skills from the installed plugin folder when the code runs from a source mirror", async () => {
  const cache = await mkTempDeskRoot()
  const script = `
    import { importRuntimeServer } from ${JSON.stringify(new URL("../../../../../plugins/desk/mcp/src/runtime/bootstrap.js", import.meta.url).href)}
    import * as path from "node:path"
    import { pathToFileURL } from "node:url"
    const runtime = await importRuntimeServer({ mcpRoot: ${JSON.stringify(path.join(PLUGIN_ROOT, "mcp"))}, runtimeCacheDir: ${JSON.stringify(cache)} })
    const { lesson_add } = await import(pathToFileURL(path.join(runtime._deskRuntime.source_mirror_path, "src", "tools", "lesson.js")).href)
    const result = await lesson_add({ deskRoot: ${JSON.stringify(cache)}, env: process.env, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "skill:desk:evidence-discipline" }, addFriction: async () => ({ path: "_meta/friction.md", improvement: "opened" }) })
    process.stdout.write(JSON.stringify({ mirror: runtime._deskRuntime.source_mirror_path, owner: result.owner }))
  `
  // The installed server's entrypoint (mcp/index.js) sets DESK_PLUGIN_ROOT to its own plugin folder on every host.
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, DESK_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT: "" }, timeout: 120_000 })
  assert.equal(run.status, 0, run.stderr)
  const answer = JSON.parse(run.stdout)
  assert.equal(answer.owner, "skill:desk:evidence-discipline")
  assert.equal(answer.mirror.startsWith(cache), true)
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

test("lesson_add team hands the lesson, repo and source to the team write", async () => {
  const calls = []
  const result = await lesson_add({ deskRoot: "/desk", person: "ari", input: { scope: "team", topic: "Rule.", body: "Do it.", repo: "~/code/cit", source: "Ari, 2026-10-26" }, team: async (args) => calls.push(args) && { status: "merged" } })
  assert.deepEqual(result, { status: "merged" })
  assert.deepEqual(calls.map(({ deskRoot, person, topic, body, repo, source }) => ({ deskRoot, person, topic, body, repo, source })), [{ deskRoot: "/desk", person: "ari", topic: "Rule", body: "Do it.", repo: "~/code/cit", source: "Ari, 2026-10-26" }])
})

async function crewRoot() {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  await fs.writeFile(path.join(root, "_meta", "desks.md"), "| alias | identity |\n| --- | --- |\n| ari | ari@example.com |\n", "utf8")
  return root
}

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
  await assert.rejects(() => lesson_add({ deskRoot: root, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "skill:desk" }, addFriction: async () => ({}) }), /owner/u)
})

test("lesson_add personal keeps a blank line before a heading that followed the last lesson directly", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), "## Lessons\n\n- **Old.** Old. (2026-01-01)\n## Next\n", "utf8")
  await lesson_add({ deskRoot: root, input: personal("New", "New.") })
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), new RegExp(`^## Lessons\\n\\n- \\*\\*Old\\.\\*\\* Old\\. \\(2026-01-01\\)\\n- \\*\\*New\\.\\*\\* New\\. \\(${DAY}\\)\\n\\n## Next\\n$`, "u"))
})
