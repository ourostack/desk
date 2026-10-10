// Find task cards whose `status` is outside the eight lifecycle states and plan their repair. The
// `03-normalize-task-status` migration runs this straight from the installed plugin, so it imports nothing outside
// Node's built-ins and Desk's own dependency-free modules.
//
// Read-only: it never changes a card. A card whose value maps to a state (see `normalizeStatus`) gets one
// `task_update` call in the plan; any other value is listed for a person to look at, because the migration never guesses.
// Scope is the session's own desk: with a person it is `desks/<alias>/`, otherwise the desk root without its `desks/`
// folder (a crew desk's other people's cards are theirs). Live and archived (`_archive/`) cards are both scanned.

import { closeSync, openSync, readdirSync, readSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseFrontmatterLite } from "./frontmatter-lite.js"
import { LIFECYCLE_STATES, normalizeStatus } from "./lifecycle.js"
import { personPrefix, resolveActivationConfigPath, resolveDeskRootWithSource } from "../util/paths.js"

const MAX_CARD_BYTES = 64 * 1024
const ARCHIVE = "_archive"

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

function readCardStatus(file) {
  let fd
  try {
    fd = openSync(file, "r")
    const buffer = Buffer.alloc(MAX_CARD_BYTES)
    const length = readSync(fd, buffer, 0, MAX_CARD_BYTES, 0)
    const { data } = parseFrontmatterLite(buffer.subarray(0, length).toString("utf8"))
    return Object.hasOwn(data, "status") ? data.status : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function scanTracks(scanRoot, { archived, skipDesks }) {
  const cards = []
  for (const track of listDirs(scanRoot)) {
    if (track.startsWith(".") || track.startsWith("_") || (skipDesks && track === "desks")) continue
    for (const slug of listDirs(path.join(scanRoot, track))) {
      const status = readCardStatus(path.join(scanRoot, track, slug, "task.md"))
      if (status === undefined || status === null || LIFECYCLE_STATES.includes(status)) continue
      const { status: mapped, known } = normalizeStatus(status)
      cards.push({ track, slug, archived, value: status, mapped: known ? mapped : null })
    }
  }
  return cards
}

/**
 * statusFindings(subtree, { skipDesks }) -> [{ track, slug, archived, value, mapped }]
 *
 * Every live and archived card under `subtree` whose status is a value other than the eight states. `mapped` is the
 * state the value means, or null when it is unknown.
 */
export function statusFindings(subtree, { skipDesks = false } = {}) {
  return [
    ...scanTracks(subtree, { archived: false, skipDesks }),
    ...scanTracks(path.join(subtree, ARCHIVE), { archived: true, skipDesks: false }),
  ]
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== ""
}

function deskRootFor({ root, env, cwd, homeDir }) {
  if (hasText(root)) return path.resolve(root)
  try {
    const hostProjectRoot = hasText(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : undefined
    return resolveDeskRootWithSource({
      activationConfigPath: resolveActivationConfigPath({ env }),
      env,
      cwd,
      homeDir,
      hostProjectRoot,
      projectRootHint: hostProjectRoot === undefined ? cwd : undefined,
    }).root
  } catch {
    return null
  }
}

/** The one-line summary of a finding for the plan: the call or the hand-check line. */
function planLines(findings) {
  const calls = findings.filter((card) => card.mapped !== null && !card.archived)
  const archived = findings.filter((card) => card.mapped !== null && card.archived)
  const unknown = findings.filter((card) => card.mapped === null)
  const lines = []
  if (calls.length > 0) {
    lines.push("", "Fix these cards with task_update, one call each (the value each card has now is in the comment):")
    for (const card of calls) {
      lines.push(`task_update ${JSON.stringify({ track: card.track, slug: card.slug, frontmatter: { status: card.mapped } })}  # was ${JSON.stringify(card.value)}`)
    }
  }
  if (archived.length > 0) {
    lines.push("", "Archived cards (task_update cannot reach a card under _archive/; set the card's `status:` line to the state shown, with a plain edit and a commit of that one file):")
    for (const card of archived) lines.push(`${ARCHIVE}/${card.track}/${card.slug}: ${JSON.stringify(card.value)} -> ${card.mapped}`)
  }
  if (unknown.length > 0) {
    lines.push("", `Cards to look at by hand (the value is not one this migration maps, so it changes nothing; pick the state from the card's own history from ${LIFECYCLE_STATES.join(", ")}):`)
    for (const card of unknown) lines.push(`${card.archived ? `${ARCHIVE}/` : ""}${card.track}/${card.slug}: ${JSON.stringify(card.value)}`)
  }
  return lines
}

/**
 * The `scripts/status-normalize.js` command line. Modes:
 *   --detect   exit 0 (the migration is pending) when a card holds a status outside the eight states, else 1; prints nothing
 *   --plan     print the plan and exit 0; with nothing to fix, say so
 * `--root <path>` and `--person <alias>` are the Desk tools' own root and person, from `desk_status`.
 */
export function runStatusNormalizeCli({ argv, env, io, cwd = process.cwd(), homeDir = os.homedir() }) {
  const args = { mode: null, root: undefined, person: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--detect" || arg === "--plan") args.mode = arg.slice(2)
    else if ((arg === "--root" || arg === "--person") && index + 1 < argv.length) {
      args[arg.slice(2)] = argv[index + 1]
      index += 1
    } else {
      io.stderr.write(`status-normalize: unknown argument ${JSON.stringify(arg)}\n`)
      return 2
    }
  }
  if (args.mode === null) {
    io.stderr.write("status-normalize: pass --detect or --plan\n")
    return 2
  }
  const deskRoot = deskRootFor({ root: args.root, env, cwd, homeDir })
  const person = hasText(args.person) ? args.person.trim() : null
  let findings = []
  if (deskRoot !== null) {
    try {
      findings = statusFindings(path.resolve(personPrefix(deskRoot, person)), { skipDesks: person === null })
    } catch {
      findings = []
    }
  }
  if (args.mode === "detect") return findings.length > 0 ? 0 : 1
  if (deskRoot === null) {
    io.stdout.write("No desk is bound, so there is no card status to fix.\n")
  } else if (findings.length === 0) {
    io.stdout.write("Every card's status is one of the eight lifecycle states. Nothing to fix.\n")
  } else {
    io.stdout.write([`Desk: ${deskRoot}${person === null ? "" : ` as ${person}`}`, `${findings.length} card${findings.length === 1 ? "" : "s"} hold a status outside ${LIFECYCLE_STATES.join(", ")}.`, ...planLines(findings), ""].join("\n"))
  }
  return 0
}
