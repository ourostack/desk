// The crew declaration: `_meta/crew.json` at a Crew workspace's root, beside the roster in `_meta/desks.md`. Every Crew
// workspace has the same shape (`desks/`, `_shared/landscape/`, `_shared/decisions/`, the root AGENTS.md); the
// declaration says only where the team's plugin lives:
//
//   { "schema_version": 1,
//     "tooling": { "repo": "owner/name", "path": "plugins/x", "plugin": "x", "ref": "main", "marketplace": "owner" } }
//
//   { ..., "people": "team/roster.md" }
//
// `people` is the team's roster, a Markdown file of everyone the team works with; without it, `_shared/landscape/roster.md`.
// `tooling.repo` makes the workspace dual-repo: the plugin lives in that separate tooling repository. Without it the
// workspace is a monorepo, with the plugin in its own `plugins/` folder, which is how every workspace made before the
// declaration existed reads. Every field is optional; a value that cannot be honored is reported in `problems` and
// never followed.
//
// Dependency-free (`node:` modules only), like `crew-roster.js`, so the crew script can read it before Desk's runtime
// dependencies exist.

import { readFileSync } from "node:fs"
import * as path from "node:path"

export const CREW_CONFIG_FILE = path.join("_meta", "crew.json")
export const DEFAULT_PEOPLE = "_shared/landscape/roster.md"
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const REPO = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9._-]+$/u

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const shown = (value) => JSON.stringify(value)

// A repository-relative path in `/` form with no `.` segments, or null when it leaves the repository or is empty.
function inside(raw) {
  if (typeof raw !== "string") return null
  const text = raw.replace(/\\/gu, "/").trim()
  if (text === "" || text.startsWith("/") || /^[A-Za-z]:/u.test(text)) return null
  const parts = text.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.length === 0 || parts.includes("..")) return null
  return parts.join("/")
}

function name(raw, field, problems, what = "a name") {
  if (raw === undefined || raw === null) return null
  if (typeof raw === "string" && NAME.test(raw)) return raw
  problems.push(`${field}: must be ${what}`)
  return null
}

function block(raw, field, problems) {
  if (raw === undefined) return {}
  if (isObject(raw)) return raw
  problems.push(`${field}: must be an object`)
  return {}
}

function readTooling(raw, problems) {
  const repo = raw.repo === undefined ? null : REPO.test(String(raw.repo)) ? raw.repo : (problems.push(`tooling.repo: ${shown(raw.repo)} is not owner/name`), null)
  let toolPath = ""
  if (raw.path !== undefined && raw.path !== "") {
    toolPath = inside(raw.path)
    if (toolPath === null) {
      problems.push(`tooling.path: ${shown(raw.path)} is not a folder inside the tooling repository`)
      toolPath = ""
    }
  }
  const plugin = name(raw.plugin, "tooling.plugin", problems)
  const ref = name(raw.ref, "tooling.ref", problems, "a branch name") ?? "main"
  const marketplace = name(raw.marketplace, "tooling.marketplace", problems)
  if (repo === null && toolPath === "") return null
  return { repo, path: toolPath, plugin, ref, marketplace }
}

// The roster's repository-relative path: a Markdown file outside Crew's own files (`_meta/`, `desks/`, the root AGENTS.md).
function readPeople(raw, problems) {
  if (raw === undefined || raw === null) return DEFAULT_PEOPLE
  const rel = inside(raw)
  if (rel !== null && /\.md$/iu.test(rel) && !/^(?:_meta|desks)\//iu.test(rel) && rel.toLowerCase() !== "agents.md") return rel
  problems.push(`people: ${shown(raw)} is not a Markdown file inside this repository outside _meta/, desks/ and AGENTS.md`)
  return DEFAULT_PEOPLE
}

/**
 * parseCrewConfig(text) -> { declared, setup: "monorepo" | "dual-repo", tooling, people, problems }
 *
 * `text` is the file's content, or null when there is no file. `tooling` is null when nothing is declared; a tooling
 * repository with no `plugin` is a stub to point to, with nothing to install.
 */
export function parseCrewConfig(text) {
  const problems = []
  const config = { declared: text !== null, setup: "monorepo", tooling: null, people: DEFAULT_PEOPLE, problems }
  if (text === null) return config
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    raw = undefined
  }
  if (!isObject(raw)) {
    problems.push("_meta/crew.json is not a JSON object")
    return config
  }
  config.tooling = readTooling(block(raw.tooling, "tooling", problems), problems)
  if (config.tooling?.repo) config.setup = "dual-repo"
  config.people = readPeople(raw.people, problems)
  return config
}

/** The crew declaration of the workspace at `root`; an absent or unreadable file is undeclared (a monorepo). */
export function readCrewConfig(root) {
  if (typeof root !== "string" || root === "") return parseCrewConfig(null)
  let text
  try {
    text = readFileSync(path.join(root, CREW_CONFIG_FILE), "utf8")
  } catch {
    return parseCrewConfig(null)
  }
  return parseCrewConfig(text)
}
