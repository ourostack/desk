#!/usr/bin/env node
// Crew workspace setup, one deterministic step at a time. Prints one JSON result.
//
//   node crew.js status --repo <clone> [--identity <login>]      (also reports `session`: what a Desk session started there binds)
//   node crew.js start  --repo <clone> [--team <name>] [--founder <alias>=<identity>] [--people <roster.md>]
//                       [--tooling-repo <owner/name> --tooling-path <dir> --tooling-plugin <name>
//                        --tooling-ref <branch> --tooling-marketplace <name>] [--apply]
//   node crew.js join   --repo <clone> --identity <login> --alias <alias> [--about <file>] [--preferences <file>] [--apply]
//   node crew.js roster --repo <clone> --identity <login> [--apply]
//
// `start` works on a new or an existing repository. With --tooling-repo the workspace is dual-repo (the team's plugin
// lives in that separate repository); without it, a monorepo (the plugin, if any, in its own plugins/ folder).
// `--people` names the team's roster, a Markdown file in the repository (by default _shared/landscape/roster.md). `join`
// adds the Markdown in `--about` to the new desk's README.md and in `--preferences` to its AGENTS.md (files outside the
// clone), and lands an uncommitted change to the team's roster with the desk-list row. `roster` lands a member's
// uncommitted change to the team's roster on its own.
// Without --apply, start, join and roster print their plan and change nothing. `--repo` defaults to the current folder.
// Exits 1 when the result is refused, failed or not a Git clone, and 2 for a usage error.

import process from "node:process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { crewStatus, joinWorkspace, startWorkspace, updateRoster } from "../src/crew/workspace.js"

const VALUE_FLAGS = new Set(["repo", "identity", "alias", "team", "tooling-repo", "tooling-path", "tooling-plugin", "tooling-ref", "tooling-marketplace", "founder", "people", "about", "preferences"])
const ALLOWED = {
  status: ["repo", "identity"],
  start: ["repo", "team", "tooling-repo", "tooling-path", "tooling-plugin", "tooling-ref", "tooling-marketplace", "founder", "people", "apply"],
  join: ["repo", "identity", "alias", "about", "preferences", "apply"],
  roster: ["repo", "identity", "apply"],
}
const USAGE = "usage: crew.js <status|start|join|roster> --repo <clone> [options]; see the comment at the top of crew.js"

// Parses `argv` into `{ action, options }`, or `{ error }`.
function parseArguments(argv) {
  const [action, ...rest] = argv
  if (!Object.hasOwn(ALLOWED, action ?? "")) return { error: `unknown action ${JSON.stringify(action ?? "")}` }
  const options = {}
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const name = flag.startsWith("--") ? flag.slice(2) : null
    if (name === null || !ALLOWED[action].includes(name)) return { error: `${action} does not take ${flag}` }
    if (!VALUE_FLAGS.has(name)) {
      options[name] = true
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` }
    options[name] = value
    i += 1
  }
  return { action, options }
}

function founderOf(text) {
  if (text === undefined) return undefined
  const at = text.indexOf("=")
  return at === -1 ? { alias: text, identity: "" } : { alias: text.slice(0, at), identity: text.slice(at + 1) }
}

const FAILED = new Set(["refused", "failed", "not_git"])

export async function main({ argv = process.argv.slice(2), cwd = process.cwd(), write = (text) => process.stdout.write(text), engine = { crewStatus, startWorkspace, joinWorkspace, updateRoster } } = {}) {
  const parsed = parseArguments(argv)
  if (parsed.error) {
    write(`${JSON.stringify({ state: "usage", message: `${parsed.error}. ${USAGE}` }, null, 2)}\n`)
    return 2
  }
  const { action, options } = parsed
  const repo = options.repo ?? cwd
  let result
  // status also says what a Desk session started in the clone binds (`session`), the check a join runs before it delivers.
  if (action === "status") result = await engine.crewStatus({ repo, identity: options.identity, session: true })
  else if (action === "join") result = await engine.joinWorkspace({ repo, identity: options.identity, alias: options.alias, about: options.about, preferences: options.preferences, apply: options.apply === true })
  else if (action === "roster") result = await engine.updateRoster({ repo, identity: options.identity, apply: options.apply === true })
  else {
    result = await engine.startWorkspace({
      repo,
      apply: options.apply === true,
      team: options.team,
      people: options.people,
      founder: founderOf(options.founder),
      tooling: { repo: options["tooling-repo"], path: options["tooling-path"], plugin: options["tooling-plugin"], ref: options["tooling-ref"], marketplace: options["tooling-marketplace"] },
    })
  }
  write(`${JSON.stringify(result, null, 2)}\n`)
  return FAILED.has(result.state) ? 1 : 0
}

/** Whether this file is the script node was started with (compared as real paths, since a temp folder may be a link). */
export function isEntrypoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.exitCode = await main()
}
