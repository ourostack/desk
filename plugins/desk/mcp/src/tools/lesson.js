// lesson_add — a correction lands where something loads it, and the reply says whether it is in effect.
//
// A lesson is one rule on one line. `scope` says whose behaviour it changes:
//   - personal: one person's preference. It becomes a line in the `## Lessons` section of that person's AGENTS.md
//     (the desk root's, or `desks/<alias>/AGENTS.md` in a shared workspace), which session start prints. The reply says
//     it is in effect only when it is committed and session start resolves the same person; a line that would push the
//     AGENTS.md files session start prints past their shared size limit is refused, because nothing would load it.
//   - desk: how Desk's tools and installed plugins' skills behave. It is recorded as system friction against the `owner`
//     that carries the behaviour, which opens an improvement card; the lesson is in effect only once that card's change
//     ships. A desk lesson without an owner is refused.
//   - team: how every teammate's agents work in a repository the team shares. The tool writes the line into that
//     repository's root AGENTS.md itself, through a pull request it merges (lesson-team.js).
//
// Before this, lessons went to `_meta/tips/<topic>.md`, which nothing loaded. The tips files that remain stay
// searchable; this tool no longer writes them.

import { promises as fs, existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { today, slugify, pathExists } from "../util/fm.js"
import { deskRelativePath, resolveWriteTarget } from "../util/paths.js"
import { isGitRepository } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { improvementPerson } from "../desk/improvement-person.js"
import { holdLock } from "../desk/improvement-cards.js"
import { deskPluginRoot } from "../package-metadata.js"
import { compareVersions } from "../runtime/stale-desk.js"
import { TOOL_NAMES } from "../tool-names.js"
import { stagingAllowed, stageAndCommitFile } from "./_card-commit.js"
import { factoryPluginScan } from "./factory-context.js"
import { friction_add } from "./friction.js"
import { addTeamLesson } from "./lesson-team.js"
import { lead, oneLine, topicOf, withLesson } from "./lesson-lines.js"
import { AGENTS_MD_CAP_BYTES, personAgentsCap, printedPart, readAgentsMd } from "../runtime/agents-md.js"

// Every field lesson_add reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const LESSON_ADD_FIELDS = ["scope", "topic", "body", "owner", "repo", "source"]

const SCOPES = new Set(["personal", "desk", "team"])
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
// An empty folder, so Git never sees it; it serialises writes to one AGENTS.md across sessions.
const LOCK_NAME = ".agents-md.lock"

function pluginManifest(dir) {
  for (const manifest of ["plugin.json", path.join(".claude-plugin", "plugin.json")]) {
    try {
      const { name, version } = JSON.parse(readFileSync(path.join(dir, manifest), "utf8"))
      if (typeof name === "string") return { name, version: typeof version === "string" ? version : null }
    } catch {
      // No manifest here; try the other place a host keeps it.
    }
  }
  return null
}

// Whether `next` is a newer install of the same plugin than `kept`: a version beats none, and the higher version wins.
function newer(next, kept) {
  if (next.version === null) return false
  if (kept.version === null) return true
  return compareVersions(next.version, kept.version) === 1
}

/**
 * The installed plugins a desk lesson can name, as a map of plugin name to its active folder: Desk's own plugin folder
 * plus the plugins the host has installed beside it, read the way the factory reads them (`factoryPluginScan`). Built
 * from what is installed, never from a fixed list, so an overlay's skills (MS Desk, Platform Workflows) are owners too.
 * A host's cache keeps old versions beside the active one; only the running Desk and the newest version of each other
 * plugin count, so a skill an upgrade removed is no owner.
 */
function installedPlugins(env, scan) {
  const plugins = new Map()
  const deskRoot = deskPluginRoot(env)
  for (const dir of [deskRoot, ...scan(env).dirs]) {
    const manifest = pluginManifest(dir)
    if (manifest === null) continue
    const kept = plugins.get(manifest.name)
    if (kept === undefined || (kept.dir !== deskRoot && newer(manifest, kept))) plugins.set(manifest.name, { dir, version: manifest.version })
  }
  return plugins
}

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
  if (plugin === undefined) throw new Error(`lesson_add: no installed plugin is named ${skill[1]} (installed: ${[...plugins.keys()].sort().join(", ")})`)
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
    throw new Error("lesson_add: this is a shared workspace and this session has no person, so a personal lesson would land in the team's AGENTS.md; start Desk with --person <alias>, or use scope team")
  }
  const file = await resolveWriteTarget({ deskRoot, person, segments: ["AGENTS.md"] })
  const where = deskRelativePath(deskRoot, file)
  const prefix = deskRelativePath(deskRoot, path.dirname(file))
  // Session start prints the desk's AGENTS.md and then the person's, from one shared budget; the lesson must be in the
  // part it prints, judged by the same cut session start makes.
  const cap = prefix === "" ? AGENTS_MD_CAP_BYTES : personAgentsCap(readAgentsMd(deskRoot))
  // The lock lives beside the file, so its folder must exist first.
  await fs.mkdir(path.dirname(file), { recursive: true })
  const written = await holdLock(path.join(path.dirname(file), LOCK_NAME), { lockWaitMs }, async () => {
    const current = await readIfPresent(file)
    const line = `${lead(topic)} ${body} (${today()})`
    const { text, replaced } = withLesson(current, line, topic)
    if (!printedPart(text, cap).includes(line)) {
      throw new Error(`lesson_add: session start prints only the first ${cap} bytes of ${where}${prefix === "" ? "" : " (what the desk's AGENTS.md leaves of the 16 KB both share)"}, and this lesson would fall after them, so nothing would load it; shorten that file first`)
    }
    // Checked before this call's own write, so an AGENTS.md another session left dirty is never committed as this call's.
    const git = isGitRepository(path.dirname(file), spawnGit)
    const stage = git && stagingAllowed(file, spawnGit)
    // The same lesson again (same words, same day) changes nothing: it is as committed as the file already is.
    if (text === current) return { replaced, git, committed: stage, commit: undefined }
    await fs.writeFile(file, text, "utf8")
    const commit = stage ? stageAndCommitFile(file, `lesson_add: personal ${slugify(topic)}`, spawnGit) : undefined
    return { replaced, git, committed: stage && commit === undefined, commit, changed: true }
  })
  if (written.result === "lock_busy") throw new Error(`lesson_add: another session is writing ${where}; nothing was written, try again`)
  if (written.committed && written.changed) schedulePush({ root: deskRoot })
  if (written.changed) search?.noteChange(where)
  const unloaded = notLoaded(await personOf({ deskRoot, env, now: now ?? Date.now() }), prefix)
  const uncommitted = written.git && !written.committed
    ? `it is not committed (${written.commit === undefined ? `${where} already held changes from elsewhere, so Desk left it for you to commit` : `the commit failed: ${written.commit.reason}`}), so other machines do not have it`
    : null
  const problems = [uncommitted, unloaded].filter((problem) => problem !== null)
  const result = {
    status: !written.changed ? "unchanged" : written.replaced ? "updated" : "added",
    scope: "personal",
    path: where,
    in_effect: problems.length === 0,
    message: problems.length === 0
      ? `In effect: the lesson is in ${where}, which session start prints for you on this desk.`
      : `Written to ${where}, but not in effect: ${problems.join("; and ")}.`,
  }
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

/**
 * lesson_add
 *
 * Input: { scope: "personal" | "desk" | "team", topic: string, body: string, owner?: string, repo?: string,
 * source?: string }. `topic`, `body` and `source` are one line each; `owner` is required for a desk lesson; `source` is
 * required for a team lesson, and `repo` names the team's clone when the desk is not itself the shared workspace.
 *
 * Returns, by scope:
 *   personal: { status: "added" | "updated", scope, path, in_effect, message, commit? }
 *   desk:     { status: "routed", scope, owner, path, improvement, in_effect: false, message, commit?, improvement_commit? }
 *   team:     { status: "merged" | "pr_open" | "failed", scope, repo, path, section, line, in_effect, message, pr?,
 *               commit?, account?, replaces?, stage?, reason?, claude_code_loads? }
 *
 * A personal write on a Git desk is committed by itself when AGENTS.md held no unstaged changes before it; a commit
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
