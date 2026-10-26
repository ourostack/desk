// lesson_add — a correction lands where something loads it, and the reply says whether it is in effect.
//
// A lesson is one rule on one line. `scope` says whose behaviour it changes:
//   - personal: one person's preference. It becomes a line in the `## Lessons` section of that person's AGENTS.md
//     (the desk root's, or `desks/<alias>/AGENTS.md` in a shared workspace), which every session start prints. A line
//     that would push the file past what session start prints is refused, because nothing would load it.
//   - desk: how Desk's tools and shared skills behave. It is recorded as system friction against the `owner` that
//     carries the behaviour, which opens an improvement card; the lesson is in effect only once that card's change
//     ships. A desk lesson without an owner is refused.
//   - team: how every teammate's agents work in a shared workspace. The line belongs in the workspace's own AGENTS.md,
//     a shared path, so this call only builds the attributed line; the agent writes it through Crew's shared-path
//     protocol, and it is in effect for every teammate's agents once that pull request merges.
//
// Before this, lessons went to `_meta/tips/<topic>.md`, which nothing loaded. The tips files that remain stay
// searchable; this tool no longer writes them.

import { promises as fs, existsSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { today, slugify, pathExists } from "../util/fm.js"
import { deskRelativePath, resolveWriteTarget } from "../util/paths.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { AGENTS_MD_CAP_BYTES } from "../runtime/agents-md.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { TOOL_NAMES } from "../tool-names.js"
import { stagingAllowed, stageAndCommitFile } from "./_card-commit.js"
import { friction_add } from "./friction.js"

// Every field lesson_add reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const LESSON_ADD_FIELDS = ["scope", "topic", "body", "owner"]

const SCOPES = new Set(["personal", "desk", "team"])
const SECTION = "## Lessons"
const CAP_WORDS = `${AGENTS_MD_CAP_BYTES / 1024} KB`
// Desk's own skills, so an owner names a skill that exists. Other plugins' skills are checked by shape only, because an
// installed Desk does not carry their folders.
const DESK_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills")
const OTHER_PLUGINS = new Set(["crew", "superpowers", "plain-language"])
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u

function oneLine(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`lesson_add: \`${name}\` is required (string)`)
  const trimmed = value.trim()
  if (/[\r\n]/u.test(trimmed)) throw new Error(`lesson_add: \`${name}\` must be one line: a lesson is one rule`)
  return trimmed
}

// The topic as the line's bold lead, without the full stop the line adds.
function topicOf(value) {
  const topic = oneLine(value, "topic").replace(/[.\s]+$/u, "")
  if (topic === "" || !slugify(topic)) throw new Error("lesson_add: `topic` is required (string) and must hold a word")
  return topic
}

const lead = (topic) => `- **${topic}.**`

/**
 * `ownerOf(owner) -> { owner, plugin, frictionClass }`: where a desk lesson takes effect. `skill:<plugin>:<skill>` is a
 * skill (for Desk, one that exists), `tool:<name>` a Desk tool, `brief` the brief mapper that writes every child brief,
 * and `foundation` the always-on `using-desk` text.
 */
function ownerOf(owner) {
  const usage = "lesson_add: a desk lesson needs `owner`: skill:<plugin>:<skill>, tool:<tool name>, brief or foundation"
  if (typeof owner !== "string") throw new Error(usage)
  if (owner === "brief" || owner === "foundation") return { owner, plugin: "desk", frictionClass: "skill" }
  const tool = /^tool:(.+)$/u.exec(owner)
  if (tool) {
    if (!TOOL_NAMES.includes(tool[1])) throw new Error(`lesson_add: Desk has no tool named ${tool[1]}`)
    return { owner, plugin: "desk", frictionClass: "mcp_tool" }
  }
  const skill = /^skill:([a-z-]+):(.+)$/u.exec(owner)
  if (!skill || !SKILL_NAME.test(skill[2]) || (skill[1] !== "desk" && !OTHER_PLUGINS.has(skill[1]))) throw new Error(usage)
  if (skill[1] === "desk" && !existsSync(path.join(DESK_SKILLS, skill[2], "SKILL.md"))) throw new Error(`lesson_add: Desk has no skill named ${skill[2]}`)
  return { owner, plugin: skill[1], frictionClass: "skill" }
}

/**
 * `withLesson(text, line, topic) -> { text, replaced }`: the AGENTS.md text with `line` in its `## Lessons` section. A
 * line for the same topic is replaced in place; otherwise the line goes after the section's last line, before the next
 * heading of the same or a higher level, and a file with no section gets one at the end.
 */
function withLesson(text, line, topic) {
  const lines = text === "" ? [] : text.replace(/\n+$/u, "").split("\n")
  const start = lines.indexOf(SECTION)
  if (start === -1) {
    const head = lines.length === 0 ? [] : [...lines, ""]
    return { text: `${[...head, SECTION, "", line].join("\n")}\n`, replaced: false }
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2} /u.test(lines[index])) {
      end = index
      break
    }
  }
  const prefix = `${lead(topic)} `
  const same = lines.findIndex((entry, index) => index > start && index < end && entry.startsWith(prefix))
  if (same !== -1) {
    lines[same] = line
    return { text: `${lines.join("\n")}\n`, replaced: true }
  }
  let last = end - 1
  while (last > start && lines[last].trim() === "") last -= 1
  const insert = last === start ? [lines.slice(0, start + 1), [""], [line]] : [lines.slice(0, last + 1), [line]]
  const rest = lines.slice(last + 1)
  const after = rest.length > 0 && rest[0].trim() !== "" ? ["", ...rest] : rest
  return { text: `${[...insert.flat(), ...after].join("\n")}\n`, replaced: false }
}

function refuseOverCap(text, where) {
  if (Buffer.byteLength(text, "utf8") > AGENTS_MD_CAP_BYTES) {
    throw new Error(`lesson_add: ${where} would pass the ${CAP_WORDS} that session start prints, so nothing would load this lesson; shorten that file first`)
  }
}

async function readIfPresent(file) {
  return (await pathExists(file)) ? fs.readFile(file, "utf8") : ""
}

async function addPersonal({ deskRoot, person, topic, body, spawnGit, schedulePush, search }) {
  const file = await resolveWriteTarget({ deskRoot, person, segments: ["AGENTS.md"] })
  const where = deskRelativePath(deskRoot, file)
  const { text, replaced } = withLesson(await readIfPresent(file), `${lead(topic)} ${body} (${today()})`, topic)
  refuseOverCap(text, where)
  // Checked before this call's own write, so an AGENTS.md another session left dirty is never committed as this call's.
  await fs.mkdir(path.dirname(file), { recursive: true })
  const stage = stagingAllowed(file, spawnGit)
  await fs.writeFile(file, text, "utf8")
  const commit = stage ? stageAndCommitFile(file, `lesson_add: personal ${slugify(topic)}`, spawnGit) : undefined
  if (stage && !commit) schedulePush({ root: deskRoot })
  search?.noteChange(where)
  const result = {
    status: replaced ? "updated" : "added",
    scope: "personal",
    path: where,
    in_effect: true,
    message: `In effect: the lesson is in ${where}, which every session start on this desk prints.`,
  }
  if (commit) result.commit = commit
  return result
}

async function addDesk({ deskRoot, person, env, now, topic, body, owner, addFriction, spawnGit, schedulePush, search }) {
  const target = ownerOf(owner)
  const added = await addFriction({
    deskRoot,
    person,
    env,
    now,
    search,
    spawnGit,
    schedulePush,
    input: {
      about: "system",
      title: `Lesson for ${target.owner}: ${topic}`,
      plugin: target.plugin,
      friction_class: target.frictionClass,
      body: `Lesson for \`${target.owner}\`: **${topic}.** ${body}`,
    },
  })
  const opened = ["opened", "duplicate", "reopened"].includes(added.improvement)
  const result = {
    status: "routed",
    scope: "desk",
    owner: target.owner,
    path: added.path,
    improvement: added.improvement,
    in_effect: false,
    message: opened
      ? `Not in effect yet. An improvement card is open against ${target.owner}; the lesson takes effect when the change it asks for ships.`
      : `Not in effect, and no improvement card opened (${added.improvement}), so nothing will act on this lesson yet. The note is in ${added.path}.`,
  }
  for (const field of ["commit", "improvement_commit"]) if (added[field] !== undefined) result[field] = added[field]
  return result
}

async function addTeam({ deskRoot, person, topic, body }) {
  if (!crewWorkspace(deskRoot).crew) throw new Error("lesson_add: a team lesson needs a shared workspace (a Crew repository); this desk is not one, so use personal or desk")
  if (typeof person !== "string" || person === "") throw new Error("lesson_add: a team lesson is attributed to its person, and this session has no person")
  const file = path.join(deskRoot, "AGENTS.md")
  const line = `${lead(topic)} ${body} (${person}, ${today()})`
  const current = await readIfPresent(file)
  refuseOverCap(withLesson(current, line, topic).text, "AGENTS.md")
  const result = {
    status: "shared_write_needed",
    scope: "team",
    path: "AGENTS.md",
    section: SECTION,
    line,
    in_effect: false,
    message: `Not in effect yet. Put this line in the ${SECTION} section of the workspace's AGENTS.md through the shared-path protocol (pull main, branch, write, pull request, merge now); every teammate's agents load it from their next session after the merge.`,
  }
  const existing = current.split("\n").find((entry) => entry.startsWith(`${lead(topic)} `))
  if (existing !== undefined) result.replaces = existing
  return result
}

/**
 * lesson_add
 *
 * Input: { scope: "personal" | "desk" | "team", topic: string, body: string, owner?: string }. `topic` and `body` are
 * one line each; `owner` is required for a desk lesson.
 *
 * Returns, by scope:
 *   personal: { status: "added" | "updated", scope, path, in_effect: true, message, commit? }
 *   desk:     { status: "routed", scope, owner, path, improvement, in_effect: false, message, commit?, improvement_commit? }
 *   team:     { status: "shared_write_needed", scope, path: "AGENTS.md", section, line, in_effect: false, message, replaces? }
 *
 * A personal write on a Git desk is committed by itself when AGENTS.md held no unstaged changes before it; a commit
 * failure never loses the write and comes back as `commit: { status: "failed", reason }`.
 */
export async function lesson_add({ deskRoot, input, person = null, search, env = process.env, now, addFriction = friction_add, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  if (!SCOPES.has(values.scope)) throw new Error("lesson_add: `scope` is required: personal (this person's preference), desk (how Desk's tools and skills behave) or team (every teammate's agents in a shared workspace)")
  const topic = topicOf(values.topic)
  const body = oneLine(values.body, "body")
  if (values.scope === "personal") return addPersonal({ deskRoot, person, topic, body, spawnGit, schedulePush, search })
  if (values.scope === "desk") return addDesk({ deskRoot, person, env, now, topic, body, owner: values.owner, addFriction, spawnGit, schedulePush, search })
  return addTeam({ deskRoot, person, topic, body })
}
