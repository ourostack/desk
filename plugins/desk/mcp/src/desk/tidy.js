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
// MCP finds one, and on a crew desk the person from the crew roster's
// identity column, with `DESK_PERSON` as an override — and the report stops
// with one line when the two disagree. On a crew desk where no person
// resolves, Detect still fires so the tidy can say so in one line: it is
// never silent there.
//
// A crew desk is one whose `_meta/desks.md` holds the crew roster table
// (`crew-roster.js`). A single-owner hub keeps a routing registry in that
// file and a spoke keeps a pointer there; both are tidied at their root.
//
// A desk that is not a Git work tree is never tidied: tidying is safe only
// because every move goes through Git and can be undone.
//
// Ruling (2026-09-27, review of the startup-hook change): the startup hooks
// tell the agent to run the tidy whenever Detect fires, so Detect must not
// fire when the tidy cannot make progress, and only one session may tidy a
// desk at a time.
//
// - A claim. `--report` takes an exclusive claim in the desk's Git folder
//   before it prints the steps, and the steps carry its token to
//   `--write-record` and `--defer`. While another session's claim is fresh
//   (CLAIM_STALE_MS), `--report` prints one line instead of the steps and
//   Detect reports the tidy as held.
// - A hold. When the tidy stops (no person resolves, the tools and the script
//   disagree about the desk, Git is mid-merge, or the agent stops it with
//   `--defer <reason>`), a hold records the reason and a fingerprint of the
//   state that stopped it. Detect then prints `held: <reason>` and exits 1
//   until that state changes or HOLD_MAX_MS passes, so the hooks show one
//   line with the reason instead of the instruction.
// - The `gh` identity lookup. In Detect, a cold identity cache starts the
//   lookup in a background process that writes the cache, and Detect does
//   not fire this time, so a slow `gh` never holds up session start and the
//   next session start has the identity.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { spawn as spawnChild, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { organizationFindings, redactedRelPath } from "./organization.js"
import { operatorNames } from "./naming.js"
import { crewWorkspace, parseCrewRoster, readCrewRoster } from "./crew-roster.js"
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

// A claim older than this is abandoned (its session ended mid-tidy), and
// another session may take it over.
export const CLAIM_STALE_MS = 30 * 60 * 1000
// A hold lapses after this even when nothing changed, so the tidy is tried
// again now and then.
export const HOLD_MAX_MS = 7 * 24 * 60 * 60 * 1000
const CLAIM_FILE = "desk-tidy-claim.json"
const HOLD_FILE = "desk-tidy-hold.json"
const TIDY_STATUS_SCRIPT = fileURLToPath(new URL("../../scripts/tidy-status.js", import.meta.url))

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

/**
 * `[{ alias, identity }]` rows of `_meta/desks.md`'s crew roster that name an
 * alias; [] when the text has no crew roster (see `crew-roster.js`).
 */
export function parseDeskRegistry(raw) {
  return (parseCrewRoster(raw) ?? []).filter((row) => row.alias !== "")
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
// With `spawnBackground`, a cold cache starts `tidy-status.js
// --refresh-identity` in its own process group and returns undefined: the
// lookup finishes and writes the cache even when the caller is stopped.
function ghIdentity(root, { env, spawnGh, homeDir, now, spawnBackground }) {
  const file = identityCachePath({ env, homeDir })
  const key = real(root)
  const cache = readIdentityCache(file)
  if (freshEntry(cache[key], now)) return cache[key].identity
  if (spawnBackground !== undefined) {
    try {
      spawnBackground(process.execPath, [TIDY_STATUS_SCRIPT, "--refresh-identity", "--root", root], { env, detached: true, stdio: "ignore", windowsHide: true }).unref()
    } catch {
      // Could not start it: the next Detect tries again.
    }
    return undefined
  }
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
 * `roster` is the desk's already parsed crew roster (null for a desk that has
 * none); when it is left out, it is read from `root`. A desk without a crew
 * roster has no person, so no identity is looked up for it. With
 * `spawnBackground`, a cold `gh` lookup runs in the background and the result
 * is undefined: not known yet.
 */
export function resolvePerson(root, { env, spawnGh = spawnSync, homeDir = os.homedir(), now = Date.now(), roster, spawnBackground }) {
  if (hasText(env.DESK_PERSON)) return env.DESK_PERSON.trim()
  if (root === null) return null
  const rows = (roster === undefined ? readCrewRoster(root) : roster)?.filter((row) => row.alias !== "")
  if (rows === undefined || rows.length === 0) return null
  const identity = hasText(env.DESK_IDENTITY)
    ? env.DESK_IDENTITY.trim()
    : ghIdentity(root, { env, spawnGh, homeDir, now, spawnBackground })
  if (identity === undefined || identity === null) return identity
  const row = rows.find((candidate) => candidate.identity.toLowerCase() === identity.toLowerCase())
  return row === undefined ? null : row.alias
}

function base(fields, reason) {
  return { ...fields, applicable: false, reason, needed: false, unresolved_person: false, tidy_version: null, findings: [] }
}

/**
 * tidyStatus({ root?, person?, env, cwd?, homeDir?, now?, spawnGit?, spawnGh?, spawnBackground? }) ->
 *   { root, person, subtree, resolved, mismatch: false|"root"|"person", applicable, reason, needed,
 *     unresolved_person, tidy_version, findings }
 *
 * Read-only, except that `spawnBackground` lets a cold identity lookup run
 * in the background (see `ghIdentity`); until it lands, `needed` is false.
 * `root`/`person` are the Desk tools' own (from `desk_status`); without
 * `root` the script's own resolution is used. `needed` is the Detect
 * predicate, before any claim or hold (see `heldReason`).
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
  spawnBackground,
}) {
  const resolvedRoot = resolveRoot({ env, cwd, homeDir })
  const bound = hasText(root)
  const deskRoot = bound ? path.resolve(root) : resolvedRoot
  // Read once: the crew workspace check decides crew mode, and its roster
  // resolves the person.
  const workspace = crewWorkspace(deskRoot)
  const lookedUp = resolvePerson(deskRoot, { env, spawnGh, homeDir, now: now ?? Date.now(), roster: workspace.roster, spawnBackground })
  const resolvedPerson = lookedUp ?? null
  const alias = bound ? (hasText(person) ? person.trim() : null) : resolvedPerson
  const resolved = { root: resolvedRoot, person: resolvedPerson }
  // "root" when the script finds another desk (or none), "person" when it
  // resolves another person (or none) for the same desk, false otherwise.
  let mismatch = false
  if (bound && (resolvedRoot === null || !samePath(resolvedRoot, deskRoot))) mismatch = "root"
  else if (bound && resolvedPerson !== alias) mismatch = "person"
  const fields = { root: deskRoot, person: alias, subtree: null, resolved, mismatch }

  if (deskRoot === null) return base(fields, "no desk is bound")
  if (lookedUp === undefined) return base(fields, "this session's GitHub identity is still being looked up")
  // A crew workspace is one whose `_meta/desks.md` holds the crew roster, or
  // one it cannot rule out (see `crewWorkspace`). A hub's routing registry or
  // a spoke's pointer in that file is not one: that desk is tidied at its
  // root like any single-owner desk.
  const crew = workspace.crew
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

// Why the tidy cannot run this session, or null when it can: `line` is what
// the agent says instead of the Announce line, and `kind` names the state
// whose fingerprint holds the tidy until it changes (null: nothing to hold,
// because Detect does not fire for it).
function stopReason(status, spawnGit) {
  if (status.unresolved_person) {
    return { kind: "who", reason: "no person in this crew workspace's roster matches this session", line: "I couldn't tell which desk in this crew workspace is mine, so I left every desk as it is." }
  }
  if (status.mismatch === "person" && status.resolved.person === null) {
    return { kind: "who", reason: "the Desk tools' person does not match this session's identity", line: `I left my desk untidied: the Desk tools name ${status.person} as this session's person, but I couldn't resolve this session's identity to a person in the crew registry.` }
  }
  if (status.mismatch) {
    return { kind: "who", reason: "the Desk tools and the tidy resolve different desks", line: `I left my desk untidied: the Desk tools use ${describe(status.root, status.person)}, but the tidy found ${describe(status.resolved.root, status.resolved.person)}.` }
  }
  if (!status.applicable) return { kind: null, line: `I left my desk untidied: ${status.reason}.` }
  const problem = tidySafetyProblem(status.root, { spawnGit })
  if (problem !== null) return { kind: "busy", reason: problem, line: `I left my desk untidied for now because ${problem}; I'll tidy it in a later session.` }
  return null
}

// ── Claim and hold, both in the desk repository's Git folder ─────────────

function gitCommonDir(root, spawnGit) {
  const result = run(spawnGit, "git", ["-C", root, "rev-parse", "--git-common-dir"])
  return result.status === 0 && hasText(result.stdout) ? path.resolve(root, result.stdout.trim()) : null
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function removeFile(file) {
  try {
    unlinkSync(file)
  } catch {
    // Already gone.
  }
}

function freshClaim(claim, now) {
  return claim !== null && typeof claim.token === "string" && typeof claim.claimed_at === "number" &&
    now - claim.claimed_at >= 0 && now - claim.claimed_at < CLAIM_STALE_MS
}

/**
 * takeClaim(gitDir, { now, token? }) -> { token } | { held: { claimed_at } }
 *
 * The exclusive claim on tidying this desk. A stale or unreadable claim is
 * replaced; a fresh one is another session's.
 */
export function takeClaim(gitDir, { now, token = randomUUID() }) {
  const file = path.join(gitDir, CLAIM_FILE)
  const current = readJson(file)
  if (freshClaim(current, now)) return { held: current }
  if (existsSync(file)) removeFile(file)
  let fd
  try {
    fd = openSync(file, "wx", 0o600)
  } catch {
    // Another session created it between the check and here.
    return { held: readJson(file) ?? { claimed_at: now } }
  }
  try {
    writeSync(fd, `${JSON.stringify({ token, claimed_at: now })}\n`)
  } finally {
    closeSync(fd)
  }
  return { token }
}

// Another session's fresh claim, or null when `token` may act.
function otherClaim(gitDir, token, now) {
  const current = readJson(path.join(gitDir, CLAIM_FILE))
  return freshClaim(current, now) && current.token !== token ? current : null
}

function releaseClaim(gitDir, token, now) {
  if (otherClaim(gitDir, token, now) === null) removeFile(path.join(gitDir, CLAIM_FILE))
}

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)

function rosterText(root) {
  try {
    return readFileSync(path.join(root, "_meta", "desks.md"), "utf8")
  } catch {
    return ""
  }
}

// The state a hold of `kind` waits on. "who": which desk and person the
// script resolves, and the crew roster. "busy": the Git operation in
// progress. "agent" (from `--defer`): the desk's latest commit and the
// uncommitted paths in this session's own desk.
function holdFingerprint(kind, status, spawnGit) {
  if (kind === "who") return digest([status.resolved, rosterText(status.resolved.root ?? status.root)])
  if (kind === "busy") return digest(tidySafetyProblem(status.root, { spawnGit }))
  const head = run(spawnGit, "git", ["-C", status.root, "rev-parse", "HEAD"])
  return digest([head.stdout.trim(), uncommittedPaths(status.root, status.subtree ?? status.root, { spawnGit })])
}

function writeHold(gitDir, status, { kind, reason }, { spawnGit, now }) {
  try {
    writeFileSync(path.join(gitDir, HOLD_FILE), `${JSON.stringify({ kind, reason, fingerprint: holdFingerprint(kind, status, spawnGit), held_at: now }, null, 2)}\n`)
  } catch {
    // An unwritable Git folder only means Detect fires again next session.
  }
}

/**
 * Why Detect should not fire although the tidy is needed, or null: another
 * session's fresh claim, or a hold whose state has not changed.
 */
export function heldReason(status, { spawnGit = spawnSync, now = Date.now() } = {}) {
  const gitDir = gitCommonDir(status.root, spawnGit)
  if (gitDir === null) return null
  const claim = readJson(path.join(gitDir, CLAIM_FILE))
  if (freshClaim(claim, now)) return `another session has been tidying this desk since ${new Date(claim.claimed_at).toISOString()}`
  const hold = readJson(path.join(gitDir, HOLD_FILE))
  if (hold === null || !["who", "busy", "agent"].includes(hold.kind) || typeof hold.held_at !== "number" || !hasText(hold.reason)) return null
  if (now - hold.held_at < 0 || now - hold.held_at >= HOLD_MAX_MS) return null
  return hold.fingerprint === holdFingerprint(hold.kind, status, spawnGit) ? hold.reason.trim() : null
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
  const args = { mode: "json", root: undefined, person: undefined, claim: undefined, reason: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root" || arg === "--person" || arg === "--claim") {
      args[arg.slice(2)] = argv[index + 1]
      index += 1
    } else if (arg === "--defer") {
      args.mode = "defer"
      args.reason = argv[index + 1]
      index += 1
    } else if (["--detect", "--report", "--write-record", "--refresh-identity"].includes(arg)) {
      args.mode = arg.slice(2)
    } else {
      throw new Error(`tidy-status: unknown argument ${JSON.stringify(arg)}`)
    }
  }
  return args
}

/**
 * The `scripts/tidy-status.js` command line. Modes:
 *   (none)              print tidyStatus as JSON; exit 0
 *   --detect            exit 0 when the tidy is needed and not held, 1
 *                       otherwise; print `held: <reason>` when it is held
 *   --report            take the claim, print the report and its claim token,
 *                       and exit 0 when the tidy can run now; otherwise print
 *                       the one line to say instead (and hold the tidy when
 *                       Detect would fire again) and exit 1
 *   --write-record      write _meta/organization.json in this session's own
 *                       desk, then release the claim and any hold
 *   --defer <reason>    hold the tidy until the desk's latest commit or its
 *                       uncommitted paths change, and release the claim
 *   --refresh-identity  look the `gh` identity up and cache it (Detect starts
 *                       this in the background)
 * `--root <path>` and `--person <alias>` are the Desk tools' own root and
 * person, from `desk_status`; `--claim <token>` is the token `--report`
 * printed.
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
  spawnBackground = spawnChild,
} = {}) {
  let args
  try {
    args = parseArgs(argv)
    if (args.mode === "defer" && !hasText(args.reason)) throw new Error("tidy-status: --defer needs a one-line reason")
    if (args.mode === "refresh-identity" && !hasText(args.root)) throw new Error("tidy-status: --refresh-identity needs --root")
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 2
  }
  const clock = now ?? Date.now()

  if (args.mode === "refresh-identity") {
    ghIdentity(path.resolve(args.root), { env, spawnGh, homeDir: homeDir ?? os.homedir(), now: clock })
    return 0
  }

  const status = tidyStatus({ root: args.root, person: args.person, env, cwd, homeDir, now, spawnGit, spawnGh, spawnBackground: args.mode === "detect" ? spawnBackground : undefined })

  if (args.mode === "detect") {
    if (!status.needed) return 1
    const held = heldReason(status, { spawnGit, now: clock })
    if (held === null) return 0
    io.stdout.write(`held: ${held}\n`)
    return 1
  }

  if (args.mode === "json") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }

  const stop = stopReason(status, spawnGit)
  const gitDir = status.root === null ? null : gitCommonDir(status.root, spawnGit)
  if (stop !== null) {
    if (stop.kind !== null && gitDir !== null && args.mode === "report") writeHold(gitDir, status, stop, { spawnGit, now: clock })
    io.stdout.write(`${stop.line}\n`)
    return 1
  }

  if (args.mode === "report") {
    const claim = takeClaim(gitDir, { now: clock })
    if (claim.held !== undefined) {
      io.stdout.write(`Another session has been tidying this desk since ${new Date(claim.held.claimed_at).toISOString()}, so I left the tidy to it. If that session is this one, carry on with the steps it printed.\n`)
      return 1
    }
    removeFile(path.join(gitDir, HOLD_FILE))
    io.stdout.write(reportText(status, uncommittedPaths(status.root, status.subtree, { spawnGit })))
    io.stdout.write(`Tidy claim: ${claim.token} (this session's until ${new Date(clock + CLAIM_STALE_MS).toISOString()}; the record and defer commands below carry it)\n`)
    return 0
  }

  const other = otherClaim(gitDir, args.claim, clock)
  if (other !== null) {
    io.stdout.write(`Another session has been tidying this desk since ${new Date(other.claimed_at).toISOString()}, so I changed nothing.\n`)
    return 1
  }

  if (args.mode === "defer") {
    const reason = args.reason.replace(/[\x00-\x1f\x7f]+/gu, " ").trim()
    writeHold(gitDir, status, { kind: "agent", reason }, { spawnGit, now: clock })
    releaseClaim(gitDir, args.claim, clock)
    io.stdout.write(`The tidy is on hold: ${reason}. Session start names it until this desk's latest commit or its uncommitted changes differ, and then the tidy runs again.\n`)
    return 0
  }

  const file = writeOrganizationRecord(status.subtree, now === undefined ? undefined : new Date(now))
  releaseClaim(gitDir, args.claim, clock)
  removeFile(path.join(gitDir, HOLD_FILE))
  io.stdout.write(`${path.relative(status.root, file)}\n`)
  return 0
}
