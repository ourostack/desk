// The one-time tidy (M4-5): the state the `02-tidy-desk` migration reads and
// the one file it writes.
//
// Ruling (2026-09-25): the migration's Detect fires when the doctor reports
// organization findings in this session's own desk subtree and that
// subtree's `_meta/organization.json` does not record `tidy_version: 1`. The
// tidy itself is agent work done with the Desk tools; this module only
// reports what the doctor sees, checks that tidying can be undone, and
// writes the record once the tidy is committed.
//
// It runs from `scripts/tidy-status.js`, straight from the installed plugin,
// where no npm dependency is installed. Everything it imports is
// dependency-free: `organization.js` falls back to its own card reader.
//
// Own subtree: `desks/<alias>/` for a person-scoped session (the alias comes
// from `--person` or `DESK_PERSON`), the desk root otherwise. A crew desk
// (one with a `_meta/desks.md` registry) with no alias is never tidied,
// because the session's own desk is unknown and a peer's desk is theirs.
//
// A desk that is not a Git work tree is never tidied either: tidying is safe
// only because every move goes through Git and can be undone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { organizationFindings } from "./organization.js"
import { operatorNames } from "./naming.js"
import {
  personPrefix,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../util/paths.js"

export const TIDY_VERSION = 1
export const ORGANIZATION_RECORD = path.join("_meta", "organization.json")

const IN_PROGRESS_MARKERS = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
]

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

function git(root, args, spawnGit) {
  try {
    return spawnGit("git", ["-C", root, ...args], { encoding: "utf8" })
  } catch {
    return { status: 1, stdout: "" }
  }
}

function isGitWorkTree(root, spawnGit) {
  const result = git(root, ["rev-parse", "--is-inside-work-tree"], spawnGit)
  return result.status === 0 && result.stdout.trim() === "true"
}

function resolveRoot({ root, env, cwd, homeDir }) {
  try {
    return resolveDeskRootWithSource({
      explicitRoot: root,
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

function notApplicable(fields, reason) {
  return { ...fields, applicable: false, reason, needed: false, tidy_version: null, findings: [] }
}

/**
 * tidyStatus({ root?, person?, env, cwd?, homeDir?, now?, spawnGit? }) ->
 *   { root, subtree, applicable, reason, needed, tidy_version, findings }
 *
 * Read-only. `root` defaults to the desk the Desk MCP would bind; `person`
 * defaults to `env.DESK_PERSON`. `needed` is the Detect predicate.
 */
export function tidyStatus({
  root,
  person,
  env,
  cwd = process.cwd(),
  homeDir = os.homedir(),
  now,
  spawnGit = spawnSync,
}) {
  const alias = person ?? env.DESK_PERSON ?? null
  const deskRoot = resolveRoot({ root, env, cwd, homeDir })
  if (deskRoot === null) return notApplicable({ root: null, subtree: null }, "no desk is bound")

  let subtree
  try {
    subtree = path.resolve(personPrefix(deskRoot, alias))
  } catch {
    return notApplicable({ root: deskRoot, subtree: null }, "the crew alias is not a valid desk name")
  }
  const fields = { root: deskRoot, subtree }
  if (subtree === path.resolve(deskRoot) && existsSync(path.join(deskRoot, "_meta", "desks.md"))) {
    return notApplicable(fields, "this is a crew desk and no alias names this session's own desk")
  }
  if (!existsSync(subtree)) return notApplicable(fields, "this session's own desk does not exist yet")
  if (!isGitWorkTree(deskRoot, spawnGit)) {
    return notApplicable(fields, "the desk is not a Git repository, so a tidy could not be undone")
  }

  const findings = organizationFindings(deskRoot, {
    personPrefix: subtree,
    operatorNames: operatorNames(deskRoot),
    now,
  })
  const record = readOrganizationRecord(subtree)
  const done = tidied(record)
  return {
    ...fields,
    applicable: true,
    reason: done ? "already tidied" : findings.length === 0 ? "nothing to tidy" : "tidy needed",
    needed: !done && findings.length > 0,
    tidy_version: done ? record.tidy_version : null,
    findings,
  }
}

/**
 * Why tidying is unsafe right now, or null when it is safe: Git is in the
 * middle of a merge, rebase, cherry-pick or revert in the desk repository.
 */
export function tidySafetyProblem(root, { spawnGit = spawnSync } = {}) {
  const result = git(root, ["rev-parse", "--absolute-git-dir"], spawnGit)
  if (result.status !== 0) return "the desk is not a Git repository, so a tidy could not be undone"
  const gitDir = result.stdout.trim()
  for (const [marker, what] of IN_PROGRESS_MARKERS) {
    if (existsSync(path.join(gitDir, marker))) {
      return `the desk repository is in the middle of ${what}; finish it, then start a new session`
    }
  }
  return null
}

/** Writes the record under `subtree` and returns its path. */
export function writeOrganizationRecord(subtree, now = new Date()) {
  const file = path.join(subtree, ORGANIZATION_RECORD)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(organizationRecord(now), null, 2)}\n`)
  return file
}

function reportText(status) {
  const lines = [`Desk: ${status.root}`, `This session's own desk: ${status.subtree}`]
  lines.push(`Organization findings in it: ${status.findings.length}`)
  for (const finding of status.findings) {
    lines.push(`  ${finding.code}: ${finding.path} — ${finding.hint}`)
  }
  return `${lines.join("\n")}\n`
}

function parseArgs(argv) {
  const args = { mode: "json", root: undefined, person: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root" || arg === "--person") {
      args[arg.slice(2)] = argv[index + 1]
      index += 1
    } else if (["--detect", "--safety", "--report", "--write-record"].includes(arg)) {
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
 *   --safety        exit 0 when tidying is safe now, else print why and exit 1
 *   --report        print the findings in this session's own desk; exit 0
 *   --write-record  write _meta/organization.json in this session's own desk
 * `--root <path>` and `--person <alias>` override the bound desk and
 * `DESK_PERSON`.
 */
export function runTidyStatusCli({
  argv = process.argv.slice(2),
  env = process.env,
  io = process,
  cwd,
  homeDir,
  now,
  spawnGit = spawnSync,
} = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    io.stderr.write(`${error.message}\n`)
    return 2
  }
  const status = tidyStatus({ root: args.root, person: args.person, env, cwd, homeDir, now, spawnGit })

  if (args.mode === "detect") return status.needed ? 0 : 1

  if (args.mode === "json") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }

  if (!status.applicable) {
    io.stdout.write(`The desk cannot be tidied: ${status.reason}.\n`)
    return 1
  }

  if (args.mode === "safety") {
    const problem = tidySafetyProblem(status.root, { spawnGit })
    if (problem === null) return 0
    io.stdout.write(`The tidy waits: ${problem}.\n`)
    return 1
  }

  if (args.mode === "report") {
    io.stdout.write(reportText(status))
    return 0
  }

  const file = writeOrganizationRecord(status.subtree, now === undefined ? undefined : new Date(now))
  io.stdout.write(`${path.relative(status.root, file)}\n`)
  return 0
}
