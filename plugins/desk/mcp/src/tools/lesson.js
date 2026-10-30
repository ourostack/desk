// lesson_add — a correction lands where something loads it, and the reply says whether it is in effect.
//
// A lesson is one rule on one line. `scope` says whose behaviour it changes:
//   - personal: one person's preference. It becomes a line in the `## Lessons` section of that person's AGENTS.md
//     (the desk root's, or `desks/<alias>/AGENTS.md` in a shared workspace), which session start prints. The reply says
//     it is in effect only when it is committed and session start resolves the same person. When the line would fall
//     past what session start prints of the AGENTS.md files (a size limit they share), the oldest lessons move to the
//     LESSONS.md shelf beside it until the new one fits, and if the rest of the file leaves no room the new lesson goes
//     on the shelf itself (runtime/lessons-shelf.js). Session start lists every shelved topic and task_focus returns the
//     shelved lessons, so none is dropped, and the reply names every lesson that moved.
//   - desk: how Desk's tools and installed plugins' skills behave. It is recorded as system friction against the `owner`
//     that carries the behaviour, which opens an improvement card; the lesson is in effect only once that card's change
//     ships. A desk lesson without an owner is refused.
//   - team: how every teammate's agents work in a repository the team shares. The tool writes the line into that
//     repository's root AGENTS.md itself, through a pull request it merges (lesson-team.js).
//
// Before this, lessons went to `_meta/tips/<topic>.md`, which nothing loaded. The tips files that remain stay
// searchable; this tool no longer writes them.

import { promises as fs, existsSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { today, slugify, pathExists } from "../util/fm.js"
import { deskRelativePath, resolveWriteTarget } from "../util/paths.js"
import { hasUnstagedWork, isGitRepository } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { improvementPerson } from "../desk/improvement-person.js"
import { holdLock } from "../desk/improvement-cards.js"
import { TOOL_NAMES } from "../tool-names.js"
import { stagingAllowed, stageAndCommitFiles } from "./_card-commit.js"
import { factoryPluginScan } from "./factory-context.js"
import { friction_add } from "./friction.js"
import { installedPlugins } from "./lesson-owners.js"
import { addTeamLesson } from "./lesson-team.js"
import { lead, oneLine, topicOf } from "./lesson-lines.js"
import { AGENTS_MD_CAP_BYTES, personAgentsCap, readAgentsMd } from "../runtime/agents-md.js"
import { SHELF_FILE, shelve, topicList } from "../runtime/lessons-shelf.js"

// Every field lesson_add reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const LESSON_ADD_FIELDS = ["scope", "topic", "body", "owner", "repo", "source"]

const SCOPES = new Set(["personal", "desk", "team"])
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
// An empty folder, so Git never sees it; it serialises writes to one AGENTS.md across sessions.
const LOCK_NAME = ".agents-md.lock"
// The reply names the shelved topics up to this many characters; `shelved.topics` has them all.
const MESSAGE_TOPIC_CHARS = 500

/**
 * `ownerOf(owner) -> { owner, plugin, frictionClass }`: where a desk lesson takes effect. `skill:<plugin>:<skill>` is a
 * skill of an installed plugin, `tool:<name>` a Desk tool, `brief` the brief mapper that writes every child brief, and
 * `foundation` the always-on `using-desk` text.
 */
function ownerOf(owner, { env, scan }) {
  const usage = "lesson_add: a desk lesson needs `owner`: skill:<plugin>:<skill>, tool:<tool name>, brief or foundation"
  if (typeof owner !== "string") throw new Error(usage)
  if (owner === "brief" || owner === "foundation") return { owner, plugin: "desk", frictionClass: "skill" }
  const tool = /^tool:(.+)$/u.exec(owner)
  if (tool) {
    if (!TOOL_NAMES.includes(tool[1])) throw new Error(`lesson_add: Desk has no tool named ${tool[1]}`)
    return { owner, plugin: "desk", frictionClass: "mcp_tool" }
  }
  const skill = /^skill:([^:]+):(.+)$/u.exec(owner)
  if (!skill || !NAME.test(skill[1]) || !NAME.test(skill[2])) throw new Error(usage)
  const plugins = installedPlugins(env, scan)
  const plugin = plugins.get(skill[1])
  if (plugin === undefined) {
    throw new Error(`lesson_add: no plugin named ${skill[1]} is installed for any host on this machine (installed: ${[...plugins.keys()].sort().join(", ")}). If ${skill[1]} is a real plugin, install it here for any host and record the lesson again, or file the lesson in that plugin's own repository, through its pull requests or issues.`)
  }
  if (!existsSync(path.join(plugin.dir, "skills", skill[2], "SKILL.md"))) throw new Error(`lesson_add: the ${skill[1]} plugin has no skill named ${skill[2]}`)
  return { owner, plugin: skill[1], frictionClass: "skill" }
}

async function readIfPresent(file) {
  return (await pathExists(file)) ? fs.readFile(file, "utf8") : ""
}

// Why the reply cannot say "in effect", or null when it can.
function notLoaded(who, prefix) {
  if (who.status !== "ok") return `session start on this desk cannot tell whose desk this is (${who.reason}), so it prints no person's AGENTS.md; set DESK_PERSON to your alias`
  if (who.personPrefix === prefix) return null
  const loaded = who.personPrefix === "" ? "only the desk's AGENTS.md" : `${who.personPrefix}/AGENTS.md`
  return `session start on this desk prints ${loaded}, not this file; set DESK_PERSON to the alias this session writes for`
}

async function addPersonal({ deskRoot, person, env, now, topic, body, spawnGit, schedulePush, search, personOf, lockWaitMs }) {
  const alias = typeof person === "string" ? person.trim() : ""
  if (alias === "" && crewWorkspace(deskRoot).crew) {
    throw new Error("lesson_add: this is a shared workspace and this session has no person, so a personal lesson would land in the team's AGENTS.md; call desk_status to see why there is no person, or use scope team")
  }
  const file = await resolveWriteTarget({ deskRoot, person, segments: ["AGENTS.md"] })
  const shelfFile = await resolveWriteTarget({ deskRoot, person, segments: [SHELF_FILE] })
  const where = deskRelativePath(deskRoot, file)
  const shelfWhere = deskRelativePath(deskRoot, shelfFile)
  const prefix = deskRelativePath(deskRoot, path.dirname(file))
  // Session start prints the desk's AGENTS.md and then the person's, from one shared budget; the lesson must be in the
  // part it prints, judged by the same cut session start makes, or on the shelf beside it.
  const cap = prefix === "" ? AGENTS_MD_CAP_BYTES : personAgentsCap(readAgentsMd(deskRoot))
  // The lock lives beside the file, so its folder must exist first.
  await fs.mkdir(path.dirname(file), { recursive: true })
  const written = await holdLock(path.join(path.dirname(file), LOCK_NAME), { lockWaitMs }, async () => {
    const current = await readIfPresent(file)
    const currentShelf = await readIfPresent(shelfFile)
    const line = `${lead(topic)} ${body} (${today()})`
    const next = shelve({ agents: current, shelf: currentShelf, line, topic, cap })
    const changes = [[file, current, next.agents], [shelfFile, currentShelf, next.shelf]].filter(([, before, after]) => before !== after)
    const outcome = { replaced: next.replaced, tier: next.tier, moved: next.moved }
    // Checked before this call's own write, so a file another session left dirty is never committed as this call's.
    const git = isGitRepository(path.dirname(file), spawnGit)
    const names = changes.map(([changed]) => path.basename(changed))
    const stage = git && names.length > 0 && !hasUnstagedWork(path.dirname(file), names, spawnGit)
    // The same lesson again (same words, same day) changes nothing: it is as committed as the files already are.
    if (changes.length === 0) return { ...outcome, git, committed: git && stagingAllowed(next.tier === "shelf" ? shelfFile : file, spawnGit), commit: undefined }
    for (const [changed, , after] of changes) await fs.writeFile(changed, after, "utf8")
    const commit = stage ? stageAndCommitFiles(path.dirname(file), names, `lesson_add: personal ${slugify(topic)}`, spawnGit) : undefined
    return { ...outcome, git, committed: stage && commit === undefined, commit, changed: changes.map(([changed]) => deskRelativePath(deskRoot, changed)) }
  })
  if (written.result === "lock_busy") throw new Error(`lesson_add: another session is writing ${where}; nothing was written, try again`)
  const changed = written.changed ?? []
  if (written.committed && changed.length > 0) schedulePush({ root: deskRoot })
  for (const each of changed) search?.noteChange(each)
  const unloaded = notLoaded(await personOf({ deskRoot, env, now: now ?? Date.now() }), prefix)
  const home = written.tier === "shelf" ? shelfWhere : where
  const uncommitted = written.git && !written.committed
    ? `it is not committed (${written.commit === undefined ? `${changed.length > 0 ? changed.join(" or ") : home} already held changes from elsewhere, so Desk left it for you to commit` : `the commit failed: ${written.commit.reason}`}), so other machines do not have it`
    : null
  const problems = [uncommitted, unloaded].filter((problem) => problem !== null)
  const topics = written.moved.map((moved) => moved.topic)
  const loads = written.tier === "shelf"
    ? `${home}, the lesson shelf: ${where} has no room left in what session start prints once its other rules are in, so session start lists this topic and task_focus returns the lesson for the task you focus`
    : `${home}, which session start prints for you on this desk`
  const shelvedNote = topics.length > 0 ? ` To make room, ${topics.length} older ${topics.length === 1 ? "lesson" : "lessons"} moved to ${shelfWhere}, where session start lists ${topics.length === 1 ? "its topic" : "their topics"} and task_focus returns ${topics.length === 1 ? "it" : "them"}: ${topicList(topics, MESSAGE_TOPIC_CHARS)}.` : ""
  const result = {
    status: changed.length === 0 ? "unchanged" : written.replaced ? "updated" : "added",
    scope: "personal",
    path: home,
    tier: written.tier,
    in_effect: problems.length === 0,
    message: problems.length === 0
      ? `In effect: the lesson is in ${loads}.${shelvedNote}`
      : `Written to ${home}, but not in effect: ${problems.join("; and ")}.${shelvedNote}`,
  }
  if (topics.length > 0) result.shelved = { path: shelfWhere, topics }
  if (written.commit !== undefined) result.commit = written.commit
  return result
}

async function addDesk({ deskRoot, person, env, now, topic, body, owner, addFriction, spawnGit, schedulePush, search, scan }) {
  const target = ownerOf(owner, { env, scan })
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
    // The card is titled from the lesson, so it can be matched to it from the card alone.
    lesson: { owner: target.owner, topic },
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
      ? `Not in effect yet. ${added.improvement_path === undefined ? "An improvement card" : `Improvement card ${added.improvement_path}`} is open against ${target.owner}; the lesson takes effect when the change it asks for ships.`
      : `Not in effect, and no improvement card opened (${added.improvement}), so nothing will act on this lesson yet. The note is in ${added.path}.`,
  }
  for (const field of ["improvement_key", "improvement_path", "commit", "improvement_commit"]) if (added[field] !== undefined) result[field] = added[field]
  return result
}

/**
 * lesson_add
 *
 * Input: { scope: "personal" | "desk" | "team", topic: string, body: string, owner?: string, repo?: string,
 * source?: string }. `topic`, `body` and `source` are one line each; `owner` is required for a desk lesson; `source` is
 * required for a team lesson, and `repo` names the team's clone when the desk is not itself the shared workspace.
 *
 * Returns, by scope:
 *   personal: { status: "added" | "updated" | "unchanged", scope, path, tier: "session_start" | "shelf", in_effect, message,
 *               shelved?: { path, topics }, commit? }
 *   desk:     { status: "routed", scope, owner, path, improvement, in_effect: false, message, improvement_key?, improvement_path?, commit?,
 *               improvement_commit? }
 *   team:     { status: "merged" | "pr_open" | "failed", scope, repo, path, section, line, in_effect, message, pr?,
 *               commit?, account?, replaces?, stage?, reason?, claude_code_loads? }
 *
 * A personal write on a Git desk is committed by itself, AGENTS.md and LESSONS.md in one commit, when the files it changes
 * held no unstaged changes before it; a commit
 * failure never loses the write and comes back as `commit: { status: "failed", reason }`. A personal lesson is in effect
 * only when it is committed (on a Git desk) and session start resolves the same person the write used.
 */
export async function lesson_add({ deskRoot, input, person = null, search, env = process.env, now, addFriction = friction_add, spawnGit = spawnSync, schedulePush = schedulePushDefault, personOf = improvementPerson, scan = factoryPluginScan, lockWaitMs, team = addTeamLesson }) {
  const values = input ?? {}
  if (!SCOPES.has(values.scope)) throw new Error("lesson_add: `scope` is required: personal (this person's preference), desk (how Desk's tools and installed plugins' skills behave) or team (every teammate's agents in a repository the team shares)")
  const topic = topicOf(values.topic)
  const body = oneLine(values.body, "body")
  if (values.scope === "personal") return addPersonal({ deskRoot, person, env, now, topic, body, spawnGit, schedulePush, search, personOf, lockWaitMs })
  if (values.scope === "desk") return addDesk({ deskRoot, person, env, now, topic, body, owner: values.owner, addFriction, spawnGit, schedulePush, search, scan })
  return team({ deskRoot, person, topic, body, repo: values.repo, source: values.source, spawnGit })
}
