// desk_skill: reads Desk's own skills through the MCP server, for a client that cannot load them as plugin skills (claude.ai, ChatGPT and other hosted chats).
//
// It needs no desk and no admission: the skills ship in the plugin, next to this server. Read-only, built from file reads only.

import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { parseFrontmatterLite } from "../desk/frontmatter-lite.js"
import { HOSTED_SHELL_SKILLS, isHosted } from "./hosted.js"

/** The plugin's skills folder: `<plugin>/skills`, three levels above this file (`<plugin>/mcp/src/runtime`). */
export const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills")

/** The input fields desk_skill reads; the schema parity test holds tool-schemas.js to it. */
export const DESK_SKILL_FIELDS = Object.freeze(["name"])

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u

function readSkillFile(skillsRoot, name) {
  try {
    return readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8")
  } catch {
    return null
  }
}

function description(text) {
  try {
    const value = parseFrontmatterLite(text).data.description
    return typeof value === "string" ? value.trim() : ""
  } catch {
    return ""
  }
}

function json(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }
}

/**
 * Without `name`: lists every skill as { name, description }, and on a hosted Desk marks the ones that need a shell with `hosted_unavailable`.
 * With `name`: returns that skill's SKILL.md without its frontmatter, as plain text. A hosted Desk refuses a skill that needs a shell, with the reason.
 */
export function deskSkill(input = {}, { env = process.env, skillsRoot = SKILLS_ROOT } = {}) {
  const hosted = isHosted(env)
  const name = input?.name
  if (name === undefined || name === null || name === "") {
    let entries = []
    try {
      entries = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    } catch {
      entries = []
    }
    const skills = []
    for (const entry of entries) {
      const text = readSkillFile(skillsRoot, entry)
      if (text === null) continue
      const row = { name: entry, description: description(text) }
      if (hosted && Object.hasOwn(HOSTED_SHELL_SKILLS, entry)) row.hosted_unavailable = HOSTED_SHELL_SKILLS[entry]
      skills.push(row)
    }
    return json({ status: "listed", skills, next: "Call desk_skill with a name to read that skill, then follow it." })
  }
  if (typeof name !== "string" || !NAME.test(name)) {
    return json({ status: "refused", code: "invalid_name", fix: "Pass a skill name from desk_skill's list: lowercase letters, digits and hyphens." }, true)
  }
  if (hosted && Object.hasOwn(HOSTED_SHELL_SKILLS, name)) {
    return json({ status: "refused", code: "hosted_unavailable", skill: name, reason: HOSTED_SHELL_SKILLS[name] }, true)
  }
  const text = readSkillFile(skillsRoot, name)
  if (text === null) {
    return json({ status: "refused", code: "unknown_skill", fix: "Call desk_skill with no name for the list of skills." }, true)
  }
  return { content: [{ type: "text", text: `# Desk skill: ${name}\n\n${text.replace(FRONTMATTER, "").trim()}\n` }] }
}
