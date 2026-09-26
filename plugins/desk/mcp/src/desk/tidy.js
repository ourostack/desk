// The one-time tidy (M4-5): the state the `02-tidy-desk` migration reads and
// the one file it writes.
//
// Ruling (2026-09-25): the migration's Detect fires when the doctor reports
// organization findings in this session's own desk subtree and that
// subtree's `_meta/organization.json` does not record `tidy_version: 1`.
// `stale_task` findings do not count (fix-round ruling): the tidy never
// changes a task's status, so a stale task alone gives it nothing to do. The
// tidy itself is agent work done with the Desk tools; this module only
// reports what the doctor sees, checks that tidying is safe right now, and
// writes the record once the tidy is committed.
//
// It runs from `scripts/tidy-status.js`, straight from the installed plugin,
// where no npm dependency is installed. Everything it imports is
// dependency-free: `organization.js` falls back to its own card reader.
//
// The same desk the tools use (fix-round ruling): the driver passes the
// Desk MCP's own root and person from `desk_status` (`--root`, `--person`).
// The script also resolves the desk on its own — the root the way the Desk
// MCP finds one, and on a crew desk the person from `_meta/desks.md`'s
// identity column, with `DESK_PERSON` as an override — and the report stops
// with one line when the two disagree. On a crew desk where no person
// resolves, Detect still fires so the tidy can say so in one line: it is
// never silent there.
//
// A desk that is not a Git work tree is never tidied: tidying is safe only
// because every move goes through Git and can be undone.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { organizationFindings, redactedRelPath } from "./organization.js"
import { operatorNames } from "./naming.js"
import {
  expandHome,
  personPrefix,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../util/paths.js"

export const TIDY_VERSION = 1
export const ORGANIZATION_RECORD = path.join("_meta", "organization.json")

// Findings the tidy acts on. `stale_task` is reported, never acted on.
const REPORT_ONLY_CODES = new Set(["stale_task"])

const IN_PROGRESS_MARKERS = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
]

const IDENTITY_TIMEOUT_MS = 10_000

// The `gh` identity lookup is cached in Desk's state folder, keyed by the
// desk root, so Detect makes no network call at most session starts (fix
// round 2): a found identity for 24 hours, a failed lookup for 1 hour.
const IDENTITY_FOUND_TTL_MS = 24 * 60 * 60 * 1000
const IDENTITY_FAILED_TTL_MS = 60 * 60 * 1000

/** `{ schema_version: 1, tidy_version: 1, tidied_at: <iso> }` */
export function organizationRecord(now = new Date()) {
  return { schema_version: 1, tidy_version: TIDY_VERSION, tidied_at: now.toISOString() }
}

/** The parsed record under `subtree`, or null when it is missing or unreadable. */
export function readOrganizationRecord(subtree) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(subtree, ORGANIZATION_RECORD), "utf8"))
    return parsed !== null && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function tidied(record) {
  return typeof record?.tidy_version === "number" && record.tidy_version >= TIDY_VERSION
}

function run(spawn, command, args) {
  try {
    return spawn(command, args, { encoding: "utf8", timeout: IDENTITY_TIMEOUT_MS })
  } catch {
    return { status: 1, stdout: "" }
  }
}

function isGitWorkTree(root, spawnGit) {
  const result = run(spawnGit, "git", ["-C", root, "rev-parse", "--is-inside-work-tree"])
  return result.status === 0 && result.stdout.trim() === "true"
}

function real(p) {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function samePath(a, b) {
  return real(a) === real(b)
}

function resolveRoot({ env, cwd, homeDir }) {
  try {
    return resolveDeskRootWithSource({
      activationConfigPath: resolveActivationConfigPath({ env }),
      env,
      cwd,
      homeDir,
      hostProjectRoot: env.CLAUDE_PROJECT_DIR,
    }).root
  } catch {
    return null
  }
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== ""
}

/** `[{ alias, identity }]` rows of a `_meta/desks.md` registry table. */
export function parseDeskRegistry(raw) {
  const rows = []
  let header = null
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) continue
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())
    if (header === null) {
      header = cells.map((cell) => cell.toLowerCase())
      continue
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    const alias = cells[header.indexOf("alias")] ?? ""
    const identity = cells[header.indexOf("identity")] ?? ""
    if (alias !== "") rows.push({ alias, identity })
  }
  return rows
}

function registryPath(root) {
  return path.join(root, "_meta", "desks.md")
}

/** The identity cache file in Desk's state folder (`$XDG_STATE_HOME`, else `~/.local/state`). */
export function identityCachePath({ env, homeDir = os.homedir() }) {
  const stateHome = hasText(env.XDG_STATE_HOME)
    ? path.resolve(expandHome(env.XDG_STATE_HOME.trim(), homeDir))
    : path.join(homeDir, ".local", "state")
  return path.join(stateHome, "ouroboros-skills", "desk", "identity-cache.json")
}

function readIdentityCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function freshEntry(entry, now) {
  if (entry === null || typeof entry !== "object") return false
  if (typeof entry.checked_at !== "number" || !(typeof entry.identity === "string" || entry.identity === null)) return false
  const age = now - entry.checked_at
  const ttl = entry.identity === null ? IDENTITY_FAILED_TTL_MS : IDENTITY_FOUND_TTL_MS
  return age >= 0 && age < ttl
}

// The GitHub login `gh` reports, through the cache. A cache that cannot be
// written only costs a lookup next time.
function ghIdentity(root, { env, spawnGh, homeDir, now }) {
  const file = identityCachePath({ env, homeDir })
  const key = real(root)
  const cache = readIdentityCache(file)
  if (freshEntry(cache[key], now)) return cache[key].identity
  const result = run(spawnGh, "gh", ["api", "user", "--jq", ".login"])
  const identity = result.status === 0 && hasText(result.stdout) ? result.stdout.trim() : null
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ ...cache, [key]: { identity, checked_at: now } }, null, 2)}\n`)
  } catch {
    // Unwritable state folder: the next Detect looks the identity up again.
  }
  return identity
}

/**
 * The person this script resolves for `root`: `DESK_PERSON` when set, else,
 * on a crew desk, the alias whose `identity` matches this session's
 * identity (`DESK_IDENTITY`, else the cached `gh` login), else null.
 */
export function resolvePerson(root, { env, spawnGh = spawnSync, homeDir = os.homedir(), now = Date.now() }) {
  if (hasText(env.DESK_PERSON)) return env.DESK_PERSON.trim()
  if (root === null || !existsSync(registryPath(root))) return null
  const identity = hasText(env.DESK_IDENTITY)
    ? env.DESK_IDENTITY.trim()
    : ghIdentity(root, { env, spawnGh, homeDir, now })
  if (identity === null) return null
  const rows = parseDeskRegistry(readFileSync(registryPath(root), "utf8"))
  const row = rows.find((candidate) => candidate.identity.toLowerCase() === identity.toLowerCase())
  return row === undefined ? null : row.alias
}

function base(fields, reason) {
  return { ...fields, applicable: false, reason, needed: false, unresolved_person: false, tidy_version: null, findings: [] }
}

/**
 * tidyStatus({ root?, person?, env, cwd?, homeDir?, now?, spawnGit?, spawnGh? }) ->
 *   { root, person, subtree, resolved, mismatch: false|"root"|"person", applicable, reason, needed,
 *     unresolved_person, tidy_version, findings }
 *
 * Read-only. `root`/`person` are the Desk tools' own (from `desk_status`);
 * without `root` the script's own resolution is used. `needed` is the
 * Detect predicate.
 */
export function tidyStatus({
  root,
  person,
  env,
  cwd = process.cwd(),
  homeDir = os.homedir(),
  now,
  spawnGit = spawnSync,
  spawnGh = spawnSync,
}) {
  const resolvedRoot = resolveRoot({ env, cwd, homeDir })
  const bound = hasText(root)
  const deskRoot = bound ? path.resolve(root) : resolvedRoot
  const resolvedPerson = resolvePerson(deskRoot, { env, spawnGh, homeDir, now: now ?? Date.now() })
  const alias = bound ? (hasText(person) ? person.trim() : null) : resolvedPerson
  const resolved = { root: resolvedRoot, person: resolvedPerson }
  // "root" when the script finds another desk (or none), "person" when it
  // resolves another person (or none) for the same desk, false otherwise.
  let mismatch = false
  if (bound && (resolvedRoot === null || !samePath(resolvedRoot, deskRoot))) mismatch = "root"
  else if (bound && resolvedPerson !== alias) mismatch = "person"
  const fields = { root: deskRoot, person: alias, subtree: null, resolved, mismatch }

  if (deskRoot === null) return base(fields, "no desk is bound")
  const crew = existsSync(registryPath(deskRoot))
  if (crew && alias === null) {
    return { ...base(fields, "this is a crew desk and no person names this session's own desk"), needed: true, unresolved_person: true }
  }

  let subtree
  try {
    subtree = path.resolve(personPrefix(deskRoot, alias))
  } catch {
    return { ...base(fields, "the person is not a valid desk name"), needed: true, unresolved_person: true }
  }
  fields.subtree = subtree
  if (!existsSync(subtree)) return base(fields, "this session's own desk does not exist yet")
  if (!isGitWorkTree(deskRoot, spawnGit)) {
    return base(fields, "the desk is not a Git repository, so a tidy could not be undone")
  }

  const record = readOrganizationRecord(subtree)
  if (tidied(record)) {
    return { ...base(fields, "already tidied"), applicable: true, tidy_version: record.tidy_version }
  }

  const findings = organizationFindings(deskRoot, {
    personPrefix: subtree,
    operatorNames: operatorNames(deskRoot),
    now,
  })
  const actionable = findings.filter((finding) => !REPORT_ONLY_CODES.has(finding.code))
  return {
    ...fields,
    applicable: true,
    reason: actionable.length === 0 ? "nothing to tidy" : "tidy needed",
    needed: actionable.length > 0,
    unresolved_person: false,
    tidy_version: null,
    findings,
  }
}

/**
 * Why tidying must wait, or null when it is safe now: Git is in the middle
 * of a merge, rebase, cherry-pick or revert in the desk repository.
 */
export function tidySafetyProblem(root, { spawnGit = spawnSync } = {}) {
  const result = run(spawnGit, "git", ["-C", root, "rev-parse", "--absolute-git-dir"])
  if (result.status !== 0) return "the desk is not a Git repository, so a tidy could not be undone"
  const gitDir = result.stdout.trim()
  for (const [marker, what] of IN_PROGRESS_MARKERS) {
    if (existsSync(path.join(gitDir, marker))) return `the desk repository is in the middle of ${what}`
  }
  return null
}

/**
 * Paths under `subtree` with uncommitted changes (staged, unstaged or
 * untracked; ignored files are left out), relative to `root` and redacted
 * like every doctor finding. Another session may be working there.
 */
export function uncommittedPaths(root, subtree, { spawnGit = spawnSync } = {}) {
  const top = run(spawnGit, "git", ["-C", root, "rev-parse", "--show-toplevel"])
  const status = run(spawnGit, "git", ["-C", root, "status", "--porcelain=v1", "-z", "--", subtree])
  if (top.status !== 0 || status.status !== 0) return []
  const toplevel = top.stdout.trim()
  const realRoot = real(root)
  const entries = status.stdout.split("\0")
  const paths = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 4) continue
    paths.push(redactedRelPath(realRoot, path.join(toplevel, entry.slice(3))))
    // A rename or copy carries its source path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") index += 1
  }
  return [...new Set(paths)].sort()
}

/** Writes the record under `subtree` and returns its path. */
export function writeOrganizationRecord(subtree, now = new Date()) {
  const file = path.join(subtree, ORGANIZATION_RECORD)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(organizationRecord(now), null, 2)}\n`)
  return file
}

function describe(root, person) {
  if (root === null) return "no desk"
  return `${root}${person === null ? "" : ` as ${person}`}`
}

// The one line the agent says instead of the Announce line when the tidy
// cannot run this session, or null when it can.
function stopLine(status, spawnGit) {
  if (status.unresolved_person) {
    return "I couldn't tell which desk in this crew workspace is mine, so I left every desk as it is."
  }
  if (status.mismatch === "person" && status.resolved.person === null) {
    return `I left my desk untidied: the Desk tools name ${status.person} as this session's person, but I couldn't resolve this session's identity to a person in the crew registry.`
  }
  if (status.mismatch) {
    return `I left my desk untidied: the Desk tools use ${describe(status.root, status.person)}, but the tidy found ${describe(status.resolved.root, status.resolved.person)}.`
  }
  if (!status.applicable) return `I left my desk untidied: ${status.reason}.`
  const problem = tidySafetyProblem(status.root, { spawnGit })
  if (problem !== null) return `I left my desk untidied for now because ${problem}; I'll tidy it in a later session.`
  return null
}

function reportText(status, dirty) {
  const lines = [
    `Desk tools: ${describe(status.root, status.person)}`,
    `This script: ${describe(status.resolved.root, status.resolved.person)}`,
    `This session's own desk: ${status.subtree}`,
    `Organization findings in it: ${status.findings.length}`,
  ]
  for (const finding of status.findings) {
    const note = REPORT_ONLY_CODES.has(finding.code) ? " (reported only; the tidy leaves it alone)" : ""
    lines.push(`  ${finding.code}: ${finding.path} — ${finding.hint}${note}`)
  }
  lines.push(`Uncommitted changes in it: ${dirty.length}`)
  for (const entry of dirty) lines.push(`  ${entry}`)
  return `${lines.join("\n")}\n`
}

function parseArgs(argv) {
  const args = { mode: "json", root: undefined, person: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root" || arg === "--person") {
      args[arg.slice(2)] = argv[index + 1]
      index += 1
    } else if (["--detect", "--report", "--write-record"].includes(arg)) {
      args.mode = arg.slice(2)
    } else {
      throw new Error(`tidy-status: unknown argument ${JSON.stringify(arg)}`)
    }
  }
  return args
}

/**
 * The `scripts/tidy-status.js` command line. Modes:
 *   (none)          print tidyStatus as JSON; exit 0
 *   --detect        exit 0 when the tidy is needed, 1 otherwise; print nothing
 *   --report        print the report and exit 0 when the tidy can run now;
 *                   otherwise print the one line to say instead and exit 1
 *   --write-record  write _meta/organization.json in this session's own desk
 * `--root <path>` and `--person <alias>` are the Desk tools' own root and
 * person, from `desk_status`.
 */
export function runTidyStatusCli({
  argv = process.argv.slice(2),
  env = process.env,
  io = process,
  cwd,
  homeDir,
  now,
  spawnGit = spawnSync,
  spawnGh = spawnSync,
} = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 2
  }
  const status = tidyStatus({ root: args.root, person: args.person, env, cwd, homeDir, now, spawnGit, spawnGh })

  if (args.mode === "detect") return status.needed ? 0 : 1

  if (args.mode === "json") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }

  const stop = stopLine(status, spawnGit)
  if (stop !== null) {
    io.stdout.write(`${stop}\n`)
    return 1
  }

  if (args.mode === "report") {
    io.stdout.write(reportText(status, uncommittedPaths(status.root, status.subtree, { spawnGit })))
    return 0
  }

  const file = writeOrganizationRecord(status.subtree, now === undefined ? undefined : new Date(now))
  io.stdout.write(`${path.relative(status.root, file)}\n`)
  return 0
}
