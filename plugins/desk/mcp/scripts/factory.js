#!/usr/bin/env node
// The Desk factory CLI.
//
//   node scripts/factory.js consent --store <owner/repo> --contribute yes|no [--account <gh login>]
//   node scripts/factory.js validate-pr --base <sha> --head <sha> --author-association <value>
//   node scripts/factory.js build --store <directory> --out <directory>
//   node scripts/factory.js job-link --store <owner/repo> --desk-remote <url> --person-prefix <prefix> --track <track> --slug <slug>
//
// Every subcommand prints one JSON value on success. Validation failures print
// their stable JSON result and exit 1; usage errors print one line to stderr.
// Candidate revisions are inspected through Git as bytes and are never loaded.
// validate-pr judges the tree that merging the head into the base produces
// (`git merge-tree`, Git 2.38 or later), not a diff against one merge base.
// `validate-pr` accepts published facts (`facts/<host>-<session id>.json`) and
// published labels (`labels/<job>/<session id>.json`) from anyone; anything
// else is maintenance.
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

import { listFinalizeRequests, listMarkers, readStatus, setConsent } from "../src/factory/outbox.js"
import { build, jobLink } from "../src/factory/pipeline/build.js"
import { factsPathsForSession, isFactsPath, labelsPathParts, validatePr } from "../src/factory/pipeline/validate-pr.js"

export const SUPPORTED_COMMANDS = Object.freeze(["consent", "derive", "status", "validate-pr", "build", "job-link"])
const CONSENT_OPTIONS = new Set(["store", "contribute", "account"])
const CONTRIBUTE_VALUES = new Set(["yes", "no"])
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const GIT_REF = /^[0-9a-f]{40}$/u
const AUTHOR_ASSOCIATION = /^[A-Z_]{2,40}$/u

/** `{ "store": "...", "contribute": "yes" }`-shaped options from `--flag value` pairs, or `null` for a malformed argv. */
export function parseOptions(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (typeof flag !== "string" || !flag.startsWith("--") || flag.length <= 2 || typeof value !== "string" || options.has(flag.slice(2))) return null
    options.set(flag.slice(2), value)
  }
  return options
}

export async function runDeriveCommand({ argv, env }) {
  const options = parseOptions(argv)
  if (options === null || !options.has("marker") || [...options.keys()].some((key) => !["marker", "wait-quiet"].includes(key))) {
    throw new Error("Usage: factory.js derive --marker <file> [--wait-quiet <milliseconds>]")
  }
  const raw = options.get("wait-quiet") ?? "0"
  if (!/^\d{1,6}$/u.test(raw) || Number(raw) > 30000) throw new Error("factory.js derive: wait-quiet must be 0..30000")
  const { deriveFile } = await import("../src/factory/derive-run.js")
  return deriveFile(env, options.get("marker"), { quietMs: Number(raw) })
}

export async function runStatusCommand({ argv, env }) {
  if (argv.length) throw new Error("Usage: factory.js status")
  return { ...await readStatus(env), markers: (await listMarkers(env)).length, finalize: (await listFinalizeRequests(env)).length }
}

function runGit(args, { cwd, encoding = "utf8", maxBuffer = 32 * 1024 * 1024 }) {
  try {
    return execFileSync("git", args, { cwd, encoding, maxBuffer, stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    const failure = new Error("factory.js validate-pr: Git data could not be read")
    failure.status = typeof error?.status === "number" ? error.status : null
    throw failure
  }
}

// `git merge-tree --write-tree` arrived in Git 2.38. Anything older, or a
// version that cannot be read, fails closed.
const MERGE_TREE_MINIMUM = [2, 38]

function requireMergeTree({ cwd, git }) {
  const match = /^git version (\d+)\.(\d+)/u.exec(git(["version"], { cwd }))
  const major = match === null ? 0 : Number(match[1])
  const minor = match === null ? 0 : Number(match[2])
  if (major < MERGE_TREE_MINIMUM[0] || (major === MERGE_TREE_MINIMUM[0] && minor < MERGE_TREE_MINIMUM[1])) {
    throw new Error("factory.js validate-pr: git_too_old (merge-tree needs Git 2.38 or later)")
  }
}

// The tree the merge of `head` into `base` produces, as `git merge-tree`
// builds it from every merge base (the same `ort` merge GitHub performs), or
// `null` when the merge has conflicts.
function mergeResultTree({ base, head, cwd, git }) {
  let output
  try {
    output = git(["merge-tree", "--write-tree", "--no-messages", base, head], { cwd })
  } catch (error) {
    if (error.status === 1) return null
    throw new Error("factory.js validate-pr: merge_tree_unavailable")
  }
  const tree = output.split("\n")[0]
  if (!GIT_REF.test(tree)) throw new Error("factory.js validate-pr: Git data could not be read")
  return tree
}

// What merging `head` changes on `base`: the base commit against the merge
// result's tree. A `base...head` diff reads only one merge base and can
// differ from what the merge lands when there are several (review C1).
function changedPaths({ base, tree, cwd, git }) {
  const output = git(["diff", "--name-status", "-z", "--no-renames", base, tree], { cwd })
  const fields = output.split("\0").filter((field) => field !== "")
  const changes = []
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]
    const filePath = fields[index + 1]
    if (filePath === undefined) throw new Error("factory.js validate-pr: Git change list is malformed")
    changes.push({
      path: filePath,
      status: status === "A" ? "added" : status === "M" ? "modified" : status === "D" ? "removed" : "unknown",
    })
  }
  return changes
}

function revisionBytes({ revision, filePath, cwd, git }) {
  return git(["show", `${revision}:${filePath}`], { cwd, encoding: null })
}

// The facts files a labeled session would have once this pull request
// merged: a facts path the merge adds or modifies is read in the merge
// result, a path it removes is gone, and any other path is read at the base
// tip, where Git lists it only if it exists.
function labeledSessionFacts({ session, listed, base, tree, cwd, git }) {
  const candidates = factsPathsForSession(session)
  const inPullRequest = new Map(listed.filter((change) => candidates.includes(change.path)).map((change) => [change.path, change.status]))
  const outside = candidates.filter((candidate) => !inPullRequest.has(candidate))
  const onBase = new Set(outside.length === 0
    ? []
    : git(["ls-tree", "-z", "--name-only", base, "--", ...outside], { cwd }).split("\0").filter((name) => outside.includes(name)))
  return candidates.flatMap((candidate) => {
    const status = inPullRequest.get(candidate)
    if (status === "added" || status === "modified") return [{ path: candidate, bytes: revisionBytes({ revision: tree, filePath: candidate, cwd, git }) }]
    if (onBase.has(candidate)) return [{ path: candidate, bytes: revisionBytes({ revision: base, filePath: candidate, cwd, git }) }]
    return []
  })
}

export async function runValidatePrCommand({ argv, cwd = process.cwd(), git = runGit }) {
  const options = parseOptions(argv)
  const base = options?.get("base")
  const head = options?.get("head")
  const association = options?.get("author-association")
  if (options === null || !GIT_REF.test(base) || !GIT_REF.test(head) || !AUTHOR_ASSOCIATION.test(association)) {
    throw new Error("Usage: factory.js validate-pr --base <base sha> --head <head sha> --author-association <value>; base and head must be full commit SHAs")
  }
  if ([...options.keys()].some((key) => !["base", "head", "author-association"].includes(key))) {
    throw new Error("factory.js validate-pr: unknown option")
  }

  requireMergeTree({ cwd, git })
  // A pull request head never needs merge commits of its own; refusing them
  // also rules out a crafted second merge base (review C1, defense in depth).
  if (git(["rev-list", "--merges", `${base}..${head}`], { cwd }).trim() !== "") {
    return { ok: false, errors: [{ code: "unexpected_merge", path: "head" }], maintenance: false }
  }
  const tree = mergeResultTree({ base, head, cwd, git })
  if (tree === null) return { ok: false, errors: [{ code: "merge_conflict", path: "head" }], maintenance: false }

  const listed = changedPaths({ base, tree, cwd, git })
  const trustedMaintainer = MAINTAINER_ASSOCIATIONS.has(association)
  if (listed.length > 500) {
    const result = validatePr({ changes: Array.from({ length: 501 }) })
    return { ...result, maintenance: false }
  }
  // Anything but a published facts or labels file, including a non-fact file
  // under `facts/` or `labels/`, and a maintainer's removal of a facts or
  // labels file are maintenance: the store's merge workflow never merges them.
  let maintenance = false
  const errors = []
  listed.forEach((change, index) => {
    const labels = labelsPathParts(change.path)
    if (!isFactsPath(change.path) && labels === null) {
      maintenance = true
      if (!trustedMaintainer) errors.push({ code: "path", path: `changes.${index}` })
      return
    }
    if (change.status === "removed" && trustedMaintainer) {
      maintenance = true
      return
    }
    if (change.status === "removed" || change.status === "unknown") {
      errors.push(...validatePr({ changes: [change] }).errors)
      return
    }
    // The bytes the merge lands, and the bytes they replace on the base.
    const bytes = revisionBytes({ revision: tree, filePath: change.path, cwd, git })
    const current = labels === null
      ? {
          ...change,
          bytes,
          ...(change.status === "modified" ? { previousBytes: revisionBytes({ revision: base, filePath: change.path, cwd, git }) } : {}),
        }
      : {
          ...change,
          bytes,
          ...(change.status === "modified" ? { previousBytes: revisionBytes({ revision: base, filePath: change.path, cwd, git }) } : {}),
          facts: labeledSessionFacts({ session: labels.session, listed, base, tree, cwd, git }),
        }
    errors.push(...validatePr({ changes: [current] }).errors)
  })
  const result = { ok: errors.length === 0, errors }
  return { ...result, maintenance: result.ok && maintenance && trustedMaintainer }
}

export async function runBuildCommand({ argv }) {
  const options = parseOptions(argv)
  if (options === null || options.size !== 2 || !options.has("store") || !options.has("out")) {
    throw new Error("Usage: factory.js build --store <directory> --out <directory>")
  }
  return build({ storeDir: options.get("store"), outDir: options.get("out") })
}

export async function runJobLinkCommand({ argv }) {
  const options = parseOptions(argv)
  const required = ["store", "desk-remote", "track", "slug"]
  if (options === null || required.some((key) => !options.has(key)) || [...options.keys()].some((key) => ![...required, "person-prefix"].includes(key))) {
    throw new Error("Usage: factory.js job-link --store <owner/repo> --desk-remote <url> [--person-prefix <prefix>] --track <track> --slug <slug>")
  }
  return {
    link: jobLink({
      store: options.get("store"),
      deskRemote: options.get("desk-remote"),
      personPrefix: options.get("person-prefix") ?? "",
      track: options.get("track"),
      slug: options.get("slug"),
    }),
  }
}

/** Runs the `consent` subcommand: validates `argv`, calls `setConsent`, and returns the JSON-ready result. */
export async function runConsentCommand({ argv, env }) {
  const options = parseOptions(argv)
  const store = options?.get("store")
  const contribute = options?.get("contribute")
  if (options === null || store === undefined || !CONTRIBUTE_VALUES.has(contribute)) {
    throw new Error("Usage: factory.js consent --store <owner/repo> --contribute yes|no [--account <gh login>]")
  }
  for (const key of options.keys()) {
    if (!CONSENT_OPTIONS.has(key)) throw new Error(`factory.js consent: unknown option --${key}`)
  }
  const account = options.has("account") ? options.get("account") : null
  const consent = await setConsent(env, { store, contribute: contribute === "yes", account })
  return { store, ...consent.stores[store] }
}

/** Dispatches `argv[0]` to its subcommand and writes the JSON result with `write`. Returns the process exit code. */
export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), git = runGit, write = (text) => process.stdout.write(text), logError = (text) => process.stderr.write(text) } = {}) {
  const [subcommand, ...rest] = argv
  try {
    if (!SUPPORTED_COMMANDS.includes(subcommand)) {
      throw new Error(`factory.js: unknown subcommand ${JSON.stringify(subcommand ?? "")} (supported: ${SUPPORTED_COMMANDS.join(", ")})`)
    }
    const command = {
      consent: runConsentCommand,
      derive: runDeriveCommand,
      status: runStatusCommand,
      "validate-pr": runValidatePrCommand,
      build: runBuildCommand,
      "job-link": runJobLinkCommand,
    }[subcommand]
    const result = await command({ argv: rest, env, cwd, git })
    write(`${JSON.stringify(result)}\n`)
    return subcommand === "validate-pr" && result.ok === false ? 1 : 0
  } catch (error) {
    logError(`${error.message}\n`)
    return 1
  }
}

/** True when this module is the process entry point (`node scripts/factory.js ...`), false when merely imported. */
export function isMainModule(importMetaUrl, argv1) {
  if (typeof argv1 !== "string") return false
  return importMetaUrl === pathToFileURL(argv1).href
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const code = await main()
  process.exitCode = code
}
