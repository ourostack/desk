#!/usr/bin/env node
// Crew workspace setup, one deterministic step at a time. Prints one JSON result.
//
//   node crew.js status --repo <clone> [--identity <login>]      (also reports `session`: what a Desk session started there binds)
//   node crew.js start  --repo <clone> [--team <name>] [--founder <alias>=<identity>]
//                       [--tooling-repo <owner/name> --tooling-path <dir> --tooling-plugin <name>
//                        --tooling-ref <branch> --tooling-marketplace <name>] [--apply]
//   node crew.js join   --repo <clone> --identity <login> --alias <alias> [--adopt-existing <reviewed-commit>] [--apply]
//   node crew.js initiative new   <slug> [--title <name>] [--repo <clone>]      (a shared initiative: _shared/tracks/<slug>/README.md)
//   node crew.js initiative adopt <file-or-folder> [--slug <slug>] [--title <name>] [--repo <clone>]
//   node crew.js initiative check [--repo <clone>]                               (exits 1 and names the fix when _shared/tracks/ is laid out wrong)
//
// `start` works on a new or an existing repository. With --tooling-repo the workspace is dual-repo (the team's plugin
// lives in that separate repository); without it, a monorepo (the plugin, if any, in its own plugins/ folder).
// Without --apply, no member or shared files change; join may fetch missing Git history for its preview.
// `--repo` defaults to the current folder.
// `initiative` writes the working tree only; publish the result through the shared-path protocol.
// Exits 1 when the result is refused, failed, has layout problems or is not a Git clone, and 2 for a usage error.

import process from "node:process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { crewStatus, joinWorkspace, startWorkspace } from "../src/crew/workspace.js"
import { adoptInitiative, checkTracks, newInitiative } from "../src/crew/initiative.js"

const VALUE_FLAGS = new Set(["repo", "identity", "alias", "team", "tooling-repo", "tooling-path", "tooling-plugin", "tooling-ref", "tooling-marketplace", "founder", "adopt-existing", "slug", "title"])
const ALLOWED = {
  status: ["repo", "identity"],
  start: ["repo", "team", "tooling-repo", "tooling-path", "tooling-plugin", "tooling-ref", "tooling-marketplace", "founder", "apply"],
  join: ["repo", "identity", "alias", "apply", "adopt-existing"],
  initiative: ["repo", "slug", "title"],
}
const INITIATIVE_ALLOWED = { new: ["repo", "title"], adopt: ["repo", "slug", "title"], check: ["repo"] }
const INITIATIVE_USAGE = "usage: crew.js initiative new <slug> | adopt <file-or-folder> [--slug <slug>] | check [--repo <clone>]"
const USAGE = "usage: crew.js <status|start|join> --repo <clone> [options]; see the comment at the top of crew.js"

// Parses `argv` into `{ action, options }`, or `{ error }`.
function parseArguments(argv) {
  const [action, ...tail] = argv
  if (!Object.hasOwn(ALLOWED, action ?? "")) return { error: `unknown action ${JSON.stringify(action ?? "")}` }
  const options = {}
  let rest = tail
  const hint = action === "initiative" ? { usage: INITIATIVE_USAGE } : {}
  let allowed = ALLOWED[action]
  if (action === "initiative") {
    const [sub, ...after] = tail
    if (!Object.hasOwn(INITIATIVE_ALLOWED, sub ?? "")) return { error: `initiative needs new, adopt or check, not ${JSON.stringify(sub ?? "")}`, usage: INITIATIVE_USAGE }
    options.sub = sub
    allowed = INITIATIVE_ALLOWED[sub]
    // `new` and `adopt` take one positional: the slug, or the path to bring in.
    if (sub !== "check" && after[0] !== undefined && !after[0].startsWith("--")) {
      options.target = after[0]
      rest = after.slice(1)
    } else rest = after
    if (sub !== "check" && options.target === undefined) return { error: `initiative ${sub} needs ${sub === "new" ? "a slug" : "a file or folder"}`, usage: INITIATIVE_USAGE }
  }
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const name = flag.startsWith("--") ? flag.slice(2) : null
    if (name === null || !allowed.includes(name)) return { error: `${action} does not take ${flag}`, ...hint }
    if (!VALUE_FLAGS.has(name)) {
      options[name] = true
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value`, ...hint }
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

const FAILED = new Set(["refused", "failed", "not_git", "problems"])

export async function main({ argv = process.argv.slice(2), cwd = process.cwd(), write = (text) => process.stdout.write(text), engine = { crewStatus, startWorkspace, joinWorkspace, newInitiative, adoptInitiative, checkTracks }, script = fileURLToPath(import.meta.url) } = {}) {
  const parsed = parseArguments(argv)
  if (parsed.error) {
    write(`${JSON.stringify({ state: "usage", message: `${parsed.error}. ${parsed.usage ?? USAGE}` }, null, 2)}\n`)
    return 2
  }
  const { action, options } = parsed
  const repo = options.repo ?? cwd
  let result
  if (action === "initiative") {
    const { sub, target, slug, title } = options
    if (sub === "new") result = engine.newInitiative({ repo, slug: target, title })
    else if (sub === "adopt") result = engine.adoptInitiative({ repo, source: target, slug, title })
    else result = engine.checkTracks({ repo, crewScript: script })
  } else if (action === "status") {
    // status also says what a Desk session started in the clone binds (`session`), the check a join runs before it delivers.
    result = await engine.crewStatus({ repo, identity: options.identity, session: true })
  } else if (action === "join") result = await engine.joinWorkspace({ repo, identity: options.identity, alias: options.alias, apply: options.apply === true, ...(options["adopt-existing"] === undefined ? {} : { adoptExisting: options["adopt-existing"] }) })
  else {
    result = await engine.startWorkspace({
      repo,
      apply: options.apply === true,
      team: options.team,
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
