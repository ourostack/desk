// lesson_add — a correction lands where something loads it, and the reply says whether it is in effect.
//
// personal: a line in the person's AGENTS.md, which every session start prints, or on the LESSONS.md shelf beside it once
// AGENTS.md outgrows what session start prints.
// desk: a system friction entry plus an improvement card against the named owner.
// team: lesson_team.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { lesson_add as lessonAdd } from "../../../../../plugins/desk/mcp/src/tools/lesson.js"
import { AGENTS_MD_CAP_BYTES, personAgentsCap, printedPart, readAgentsMd } from "../../../../../plugins/desk/mcp/src/runtime/agents-md.js"
import { SHELF_HEADER, shelfIndex } from "../../../../../plugins/desk/mcp/src/runtime/lessons-shelf.js"
import { lessonEntries } from "../../../../../plugins/desk/mcp/src/runtime/lesson-section.js"
import { taskFocus } from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { task_create } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { createSearchEngine } from "../../../../../plugins/desk/mcp/src/search/engine.js"
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

// The case from ourostack/desk#554: a Crew workspace whose team AGENTS.md is 12,215 bytes leaves 4 KB of the shared 16 KB for
// a person's 10,171-byte AGENTS.md. A new lesson used to be refused; now the oldest lessons move to the shelf, and every
// one of them still loads.
test("lesson_add personal past the shared budget keeps the new lesson in what session start prints, shelves the oldest, and drops none", async () => {
  const root = await crewRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), `# Crew\n\n${"Team rule line that binds every session here.\n".repeat(270)}`.padEnd(12_215, "t"), "utf8")
  const lessons = Array.from({ length: 60 }, (_, index) => `- **Lesson ${index + 1}.** ${index === 1 ? "Validate Kusto dashboards against live data before import." : "A rule the desk learned the hard way, worded at a realistic length for one line."} (2026-${String(1 + Math.floor(index / 28)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")})`)
  const mine = `# Ari\n\n${"Preference prose that is not a lesson.\n".repeat(50)}\n## Lessons\n\n${lessons.join("\n")}\n`
  await fs.writeFile(path.join(root, "desks", "ari", "AGENTS.md"), mine.padEnd(10_171, " "), "utf8")
  const result = await lesson_add({ deskRoot: root, person: "ari", personOf: async () => ({ status: "ok", personPrefix: "desks/ari" }), input: personal("Supervise overnight children with a host schedule", "Use a host schedule to supervise overnight child sessions, not in-session timers.") })
  assert.deepEqual([result.status, result.tier, result.in_effect, result.path], ["added", "session_start", true, "desks/ari/AGENTS.md"])
  const agents = await fs.readFile(path.join(root, "desks", "ari", "AGENTS.md"), "utf8")
  const shelf = await fs.readFile(path.join(root, "desks", "ari", "LESSONS.md"), "utf8")
  const printed = printedPart(agents, personAgentsCap(readAgentsMd(root)))
  assert.match(printed, /\*\*Supervise overnight children with a host schedule\.\*\*/u, "the new lesson is in what session start prints")
  for (const line of lessons) {
    const inAgents = agents.includes(`${line}\n`)
    assert.notEqual(inAgents, shelf.includes(`${line}\n`), `${line.slice(0, 20)} is in exactly one of the two files`)
    if (inAgents) assert.ok(printed.includes(line), "a lesson left in AGENTS.md is one session start prints")
  }
  const shelved = lessonEntries(shelf).map((entry) => entry.topic)
  assert.ok(shelved.length > 0)
  assert.deepEqual(result.shelved, { path: "desks/ari/LESSONS.md", topics: shelved })
  assert.match(result.message, new RegExp(`^In effect: the lesson is in desks/ari/AGENTS\\.md, which session start prints for you on this desk\\. To make room, ${shelved.length} older lessons moved to desks/ari/LESSONS\\.md, where session start lists their topics and task_focus returns them: Lesson 19; Lesson 20; .*; Lesson 60; Lesson 1; Lesson 2\\.$`, "u"), "lessons already past the cut move first")
  assert.deepEqual(shelved.slice(-2), ["Lesson 1", "Lesson 2"], "then the oldest, until the new one fits")
  // Session start lists every shelved topic, and focusing a task returns the shelved lessons, those closest to it first.
  assert.deepEqual(shelfIndex(path.join(root, "desks", "ari")).topics, shelved)
  await task_create({ deskRoot: root, person: "ari", input: { track: "ops", slug: "dashboard-tiles", title: "Fix the Kusto dashboard tiles", status: "processing" } })
  const focus = await taskFocus({ deskRoot: root, person: "ari", input: { track: "ops", slug: "dashboard-tiles" } })
  assert.equal(focus.shelved_lessons.path, "desks/ari/LESSONS.md")
  assert.match(focus.shelved_lessons.lessons[0], /^- \*\*Lesson 2\.\*\* Validate Kusto dashboards/u)
  assert.equal(focus.shelved_lessons.lessons.length + focus.shelved_lessons.not_shown, shelved.length)
})

test("lesson_add personal puts the lesson on the shelf when the rest of AGENTS.md leaves it no room, and says so", async () => {
  const root = await mkTempDeskRoot()
  const big = `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 20)}\n`
  await fs.writeFile(path.join(root, "AGENTS.md"), big, "utf8")
  const result = await lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") })
  assert.deepEqual([result.status, result.tier, result.path, result.in_effect, result.shelved], ["added", "shelf", "LESSONS.md", true, undefined])
  assert.equal(result.message, "In effect: the lesson is in LESSONS.md, the lesson shelf: AGENTS.md has no room left in what session start prints once its other rules are in, so session start lists this topic and task_focus returns the lesson for the task you focus.")
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), big, "AGENTS.md is left as it was")
  const shelf = await fs.readFile(path.join(root, "LESSONS.md"), "utf8")
  assert.ok(shelf.startsWith(SHELF_HEADER))
  assert.match(shelf, new RegExp(`\\n## Lessons\\n\\n- \\*\\*Rule\\.\\*\\* Do it\\. \\(${DAY}\\)\\n$`, "u"))
  const again = await lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") })
  assert.deepEqual([again.status, again.tier], ["unchanged", "shelf"])
})

test("lesson_add personal moves lessons already past the cut to the shelf, since nothing loads them where they are", async () => {
  const root = await crewRoot()
  await fs.writeFile(path.join(root, "AGENTS.md"), `# Crew\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 40)}\n`, "utf8")
  await fs.writeFile(path.join(root, "desks", "ari", "AGENTS.md"), "## Lessons\n\n- **Hidden.** Past the cut. (2026-01-01)\n", "utf8")
  const result = await lesson_add({ deskRoot: root, person: "ari", input: personal("Rule", "Do it.") })
  assert.deepEqual([result.tier, result.path, result.shelved.topics], ["shelf", "desks/ari/LESSONS.md", ["Hidden"]])
  assert.equal((await fs.readFile(path.join(root, "desks", "ari", "AGENTS.md"), "utf8")).includes("Hidden"), false)
  assert.deepEqual(lessonEntries(await fs.readFile(path.join(root, "desks", "ari", "LESSONS.md"), "utf8")).map((entry) => entry.topic), ["Hidden", "Rule"])
})

test("lesson_add personal brings a shelved topic back to AGENTS.md when recorded again, or replaces it in place on the shelf when there is no room", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "LESSONS.md"), `${SHELF_HEADER}\n## Lessons\n\n- **Rule.** Old words. (2026-01-01)\n- **Other.** Stays. (2026-01-02)\n`, "utf8")
  const back = await lesson_add({ deskRoot: root, input: personal("Rule", "New words.") })
  assert.deepEqual([back.status, back.tier, back.path], ["updated", "session_start", "AGENTS.md"])
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /\*\*Rule\.\*\* New words\./u)
  assert.deepEqual(lessonEntries(await fs.readFile(path.join(root, "LESSONS.md"), "utf8")).map((entry) => entry.line), ["- **Other.** Stays. (2026-01-02)"])

  const full = await mkTempDeskRoot()
  await fs.writeFile(path.join(full, "AGENTS.md"), `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 20)}\n`, "utf8")
  await fs.writeFile(path.join(full, "LESSONS.md"), `${SHELF_HEADER}\n## Lessons\n\n- **Rule.** Old words. (2026-01-01)\n- **Other.** Stays. (2026-01-02)\n`, "utf8")
  const kept = await lesson_add({ deskRoot: full, input: personal("Rule", "New words.") })
  assert.deepEqual([kept.status, kept.tier], ["updated", "shelf"])
  assert.deepEqual(lessonEntries(await fs.readFile(path.join(full, "LESSONS.md"), "utf8")).map((entry) => entry.topic), ["Rule", "Other"])
})

test("lesson_add personal writes the shelf before AGENTS.md, so a failed write leaves a moved lesson in both files, never in neither", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = await mkTempDeskRoot()
  const old = Array.from({ length: 5 }, (_, index) => `- **Old ${index}.** ${"w".repeat(60)} (2026-01-0${index + 1})`)
  const before = `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 300)}\n\n## Lessons\n\n${old.join("\n")}\n`
  await fs.writeFile(path.join(root, "AGENTS.md"), before, "utf8")
  await fs.chmod(path.join(root, "AGENTS.md"), 0o444)
  await assert.rejects(() => lesson_add({ deskRoot: root, input: personal("Rule", "Do it.") }), /EACCES|EPERM/u)
  await fs.chmod(path.join(root, "AGENTS.md"), 0o644)
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), before)
  const shelf = await fs.readFile(path.join(root, "LESSONS.md"), "utf8")
  assert.ok(lessonEntries(shelf).length > 0)
  for (const entry of lessonEntries(shelf)) assert.ok(before.includes(entry.line), "every shelved line is still in AGENTS.md too")
})

test("lesson_add personal commits AGENTS.md and the shelf together, in one commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const old = Array.from({ length: 5 }, (_, index) => `- **Old ${index}.** ${"w".repeat(60)} (2026-01-0${index + 1})`)
  await fs.writeFile(path.join(root, "AGENTS.md"), `# Desk\n\n${"x".repeat(AGENTS_MD_CAP_BYTES - 300)}\n\n## Lessons\n\n${old.join("\n")}\n`, "utf8")
  git(root, ["add", "AGENTS.md"])
  git(root, ["commit", "-q", "-m", "init"])
  const result = await lesson_add({ deskRoot: root, schedulePush: () => {}, input: personal("Rule", "Do it.") })
  assert.equal(result.tier, "session_start")
  assert.equal(result.commit, undefined)
  assert.equal(result.in_effect, true)
  assert.ok(result.shelved.topics.length > 0)
  assert.deepEqual(git(root, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort(), ["AGENTS.md", "LESSONS.md"])
  assert.equal(git(root, ["status", "--short"]).trim(), "")
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
  await assert.rejects(() => lesson_add({ deskRoot: root, scan, input: desk("skill:elsewhere:x"), addFriction }), /no plugin named elsewhere is installed for any host on this machine \(installed: desk\)/u)
  await assert.rejects(() => lesson_add({ deskRoot: root, scan, input: desk("skill:Bad:x"), addFriction }), /owner/u)
  assert.equal(calls.length, 0)
})

test("lesson_add desk records system friction against the owner and says it is not in effect until the card ships", async () => {
  const root = await mkTempDeskRoot()
  const card = "_meta/improvement/friction_candidate--0123456789ab.md"
  const { calls, addFriction } = frictionSpy({ status: "added", path: "_meta/friction.md", kaizen: "candidate", improvement: "opened", improvement_key: "friction_candidate:0123", improvement_path: card })
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
  // The card is titled from the lesson: its owner and topic.
  assert.deepEqual(calls[0].lesson, { owner: "skill:desk:interaction-style", topic: "Answer before a long wait" })
  assert.deepEqual(result, {
    status: "routed",
    scope: "desk",
    owner: "skill:desk:interaction-style",
    path: "_meta/friction.md",
    improvement: "opened",
    improvement_key: "friction_candidate:0123",
    improvement_path: card,
    in_effect: false,
    message: `Not in effect yet. Improvement card ${card} is open against skill:desk:interaction-style; the lesson takes effect when the change it asks for ships.`,
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
  const result = await lesson_add({ deskRoot: root, env, input: { scope: "desk", topic: "credential gates need evidence", body: "Do it.", owner: "brief" } })
  assert.equal(result.improvement, "opened")
  assert.equal((await fs.readdir(path.join(root, "_meta", "improvement"))).filter((name) => name.endsWith(".md")).length, 1)
  // The reply names the card, and the card names the lesson.
  assert.match(result.improvement_key, /^friction_candidate:[0-9a-f]{32}$/u)
  assert.match(result.improvement_path, /^_meta\/improvement\/friction_candidate--[0-9a-f]{12}\.md$/u)
  assert.equal(result.message, `Not in effect yet. Improvement card ${result.improvement_path} is open against brief; the lesson takes effect when the change it asks for ships.`)
  assert.match(await fs.readFile(path.join(root, ...result.improvement_path.split("/")), "utf8"), /\n# Lesson for brief: credential gates need evidence\n/u)
  // A topic with a line or paragraph separator opens a card that Desk reads back, under the fixed words.
  for (const topic of ["check the gate\u2028before merging", "check the build\u2029before shipping"]) {
    const separated = await lesson_add({ deskRoot: root, env, input: { scope: "desk", topic, body: "Do it.", owner: "brief" } })
    assert.equal(separated.improvement, "opened", JSON.stringify(topic))
    const listing = await readCards({ deskRoot: root, personPrefix: "" })
    assert.deepEqual(listing.skipped, {}, JSON.stringify(topic))
    assert.equal(listing.cards.find((card) => separated.improvement_key === card.key)?.title, "System friction in the desk plugin", JSON.stringify(topic))
  }
})

// A home folder with plugins installed for other hosts than the one running: Claude Code's registry, Copilot CLI's own
// installs, Agency's cache (Copilot under Agency) and Codex's plugin folder.
async function otherHosts() {
  const home = await mkTempDeskRoot()
  const put = async (rel, content) => {
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true })
    await fs.writeFile(path.join(home, rel), typeof content === "string" ? content : JSON.stringify(content), "utf8")
  }
  const skill = (dir, name) => put(path.join(dir, "skills", name, "SKILL.md"), "---\nname: x\n---\n")
  await put(".claude/plugins/installed_plugins.json", { version: 2, plugins: { "claude-only@mkt": [{ installPath: path.join(home, "claude-cache", "claude-only", "1.0.0"), version: "1.0.0" }], "broken@mkt": "not a list" } })
  await put("claude-cache/claude-only/1.0.0/.claude-plugin/plugin.json", { name: "claude-only", version: "1.0.0" })
  await skill("claude-cache/claude-only/1.0.0", "from-claude")
  const cache = ".local/agency/plugins/cache"
  await put(`${cache}/cache_index.json`, { entries: { "copilot:github:acme/ms-desk:plugins/ms-desk@main": { dir_name: "new" }, "copilot:github:acme/ms-desk:plugins/ms-desk@old": { dir_name: "old" }, "copilot:market:x": { dir_name: "../escape" }, odd: null } })
  await put(`${cache}/entries/new/agency.json`, { name: "ms-desk", version: "2.0.0" })
  await skill(`${cache}/entries/new`, "using-ms-desk")
  await put(`${cache}/entries/old/plugin.json`, { name: "ms-desk", version: "1.0.0" })
  await skill(`${cache}/entries/old`, "removed-since")
  await put(".copilot/installed-plugins/mkt/copilot-only/plugin.json", { name: "copilot-only" })
  await skill(".copilot/installed-plugins/mkt/copilot-only", "from-copilot")
  // A folder at the deepest level read that holds no plugin is passed over, not searched further.
  await put(".copilot/installed-plugins/mkt/not-a-plugin/notes.json", { note: "no manifest here" })
  await put(".codex/plugins/cache/mkt/codex-only/1.0.0/.codex-plugin/plugin.json", { name: "codex-only", version: "1.0.0" })
  await skill(".codex/plugins/cache/mkt/codex-only/1.0.0", "from-codex")
  return home
}

test("lesson_add desk accepts a skill of a plugin installed for any host on this machine, its newest version, and never a made-up one", async () => {
  const root = await mkTempDeskRoot()
  const home = await otherHosts()
  const { calls, addFriction } = frictionSpy({ improvement: "opened" })
  const scan = () => ({ dirs: [] })
  const desk = (owner) => lesson_add({ deskRoot: root, env: { HOME: home }, scan, addFriction, input: { scope: "desk", topic: "Rule", body: "Do it.", owner } })
  for (const owner of ["skill:ms-desk:using-ms-desk", "skill:claude-only:from-claude", "skill:copilot-only:from-copilot", "skill:codex-only:from-codex"]) assert.equal((await desk(owner)).owner, owner)
  assert.deepEqual(calls.map((call) => call.input.plugin), ["ms-desk", "claude-only", "copilot-only", "codex-only"])
  // The newest install of a plugin is the one that counts.
  await assert.rejects(() => desk("skill:ms-desk:removed-since"), /the ms-desk plugin has no skill named removed-since/u)
  // A plugin no host has installed is refused, with how to file a lesson for a real one.
  await assert.rejects(() => desk("skill:made-up:thing"), /^Error: lesson_add: no plugin named made-up is installed for any host on this machine \(installed: claude-only, codex-only, copilot-only, desk, ms-desk\)\. If made-up is a real plugin, install it here for any host and record the lesson again, or file the lesson in that plugin's own repository, through its pull requests or issues\.$/u)
  // CODEX_HOME, COPILOT_HOME and CLAUDE_CONFIG_DIR move those hosts' folders.
  const moved = await mkTempDeskRoot()
  await fs.rename(path.join(home, ".codex"), path.join(moved, "codex"))
  await assert.rejects(() => desk("skill:codex-only:from-codex"), /no plugin named codex-only/u)
  assert.equal((await lesson_add({ deskRoot: root, env: { HOME: home, CODEX_HOME: path.join(moved, "codex") }, scan, addFriction, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "skill:codex-only:from-codex" } })).owner, "skill:codex-only:from-codex")
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

test("lesson_add personal: desk_search finds the lesson right after it is written, in the desk's AGENTS.md and in a person's own", async (t) => {
  for (const [root, person, where] of [[await mkTempDeskRoot(), null, "AGENTS.md"], [await crewRoot(), "ari", "desks/ari/AGENTS.md"]]) {
    // The engine a Desk server runs, already holding the desk in its index before the lesson is written.
    const search = createSearchEngine({ deskRoot: root, semantic: "unsupported", pauseMs: 0, cleanup: () => ({ removed: false, bytes: 0 }), watch: () => ({ close() {} }) })
    t.after(() => search.close())
    await fs.mkdir(path.join(root, "ops", "task-a"), { recursive: true })
    await fs.writeFile(path.join(root, "ops", "task-a", "task.md"), "# Task\n\nSomething else.\n", "utf8")
    assert.deepEqual((await search.lexical({ query: "bbxfeed1234" })).results, [])
    await lesson_add({ deskRoot: root, person, search, input: personal("Blackbox bbxfeed1234", "Real-host check bbxfeed1234 secret.") })
    assert.deepEqual((await search.lexical({ query: "bbxfeed1234" })).results.map((result) => result.path), [where])
  }
})

test("lesson_add desk reads other hosts' plugins within bounds, and skips registries it cannot read", async () => {
  const root = await mkTempDeskRoot()
  const home = await mkTempDeskRoot()
  const { addFriction } = frictionSpy({ improvement: "opened" })
  const scan = () => ({ dirs: [] })
  await fs.mkdir(path.join(home, ".claude", "plugins"), { recursive: true })
  await fs.writeFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), "{}", "utf8")
  await fs.mkdir(path.join(home, ".local", "agency", "plugins", "cache"), { recursive: true })
  await fs.writeFile(path.join(home, ".local", "agency", "plugins", "cache", "cache_index.json"), "{}", "utf8")
  // More plugins than one host's reading looks at: it stops at 512 folders, whatever order they are listed in.
  const installs = path.join(home, ".copilot", "installed-plugins")
  for (let i = 0; i < 520; i++) {
    await fs.mkdir(path.join(installs, `p${i}`), { recursive: true })
    await fs.writeFile(path.join(installs, `p${i}`, "plugin.json"), JSON.stringify({ name: `p${i}` }), "utf8")
  }
  const refused = await lesson_add({ deskRoot: root, env: { USERPROFILE: home }, scan, addFriction, input: { scope: "desk", topic: "Rule", body: "Do it.", owner: "skill:made-up:x" } }).catch((error) => error.message)
  const installed = /\(installed: ([^)]*)\)/u.exec(refused)[1].split(", ")
  assert.equal(installed.filter((name) => /^p\d+$/u.test(name)).length, 512)
})

test("lesson_add desk follows a linked plugin folder once, skips a dangling link, a loop and an oversized manifest, and falls back to the account's home folder", async () => {
  const root = await mkTempDeskRoot()
  const home = await mkTempDeskRoot()
  const elsewhere = await mkTempDeskRoot()
  const { addFriction } = frictionSpy({ improvement: "opened" })
  const scan = () => ({ dirs: [] })
  const link = (target, at) => fs.symlink(target, at, process.platform === "win32" ? "junction" : "dir")
  const plugin = async (dir, name, manifest = JSON.stringify({ name })) => {
    await fs.mkdir(path.join(dir, "skills", "rule"), { recursive: true })
    await fs.writeFile(path.join(dir, "plugin.json"), manifest, "utf8")
    await fs.writeFile(path.join(dir, "skills", "rule", "SKILL.md"), "---\nname: rule\n---\n", "utf8")
  }
  const market = path.join(home, ".copilot", "installed-plugins", "local")
  await fs.mkdir(market, { recursive: true })
  // A local install is often a link to the plugin's own checkout.
  await plugin(path.join(elsewhere, "linked-checkout"), "linked")
  await link(path.join(elsewhere, "linked-checkout"), path.join(market, "linked"))
  await link(path.join(elsewhere, "linked-checkout"), path.join(market, "linked-again"))
  await link(path.join(elsewhere, "gone"), path.join(market, "dangling"))
  await link(path.join(home, ".copilot"), path.join(market, "loop"))
  // A manifest past the size limit is not read.
  await plugin(path.join(market, "huge"), "huge", JSON.stringify({ name: "huge", pad: "x".repeat(70 * 1024) }))
  const desk = (env, owner) => lesson_add({ deskRoot: root, env, scan, addFriction, input: { scope: "desk", topic: "Rule", body: "Do it.", owner } })
  assert.equal((await desk({ HOME: home }, "skill:linked:rule")).owner, "skill:linked:rule")
  await assert.rejects(() => desk({ HOME: home }, "skill:huge:rule"), /no plugin named huge is installed for any host on this machine \(installed: desk, linked\)/u)
  // A home folder that is not absolute reads no host's folders.
  await assert.rejects(() => desk({ HOME: "relative-home" }, "skill:linked:rule"), /no plugin named linked/u)
  // With neither HOME nor USERPROFILE set, the account's home folder is read.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    assert.equal((await desk({}, "skill:linked:rule")).owner, "skill:linked:rule")
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
