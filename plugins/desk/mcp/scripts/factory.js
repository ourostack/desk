#!/usr/bin/env node
// The Desk factory CLI.
//
//   node scripts/factory.js account --store <owner/repo>
//   node scripts/factory.js consent --store <owner/repo> --contribute yes|no [--account <gh login>]
//   node scripts/factory.js flush --store <owner/repo>
//   node scripts/factory.js finalize --job <job> [--job <job> ...]
//   node scripts/factory.js validate-pr --base <sha> --head <sha> --author-association <value>
//   node scripts/factory.js build --store <directory> --out <directory>
//   node scripts/factory.js job-link --store <owner/repo> --desk-remote <url> [--person-prefix <prefix>] [--desk <desk root>] --track <track> --slug <slug> [--this-machine]
//   node scripts/factory.js evaluate --desk <desk root> --task [desks/<alias>/]<track>/<slug>
//   node scripts/factory.js evaluate --pending
//   node scripts/factory.js evaluate-accept --job <job>
//   node scripts/factory.js kaizen-check --store <directory> --repo <owner/repo> [--author <login>]
//   node scripts/factory.js andon --store <directory> --repo <owner/repo> [--author <login>]
//   node scripts/factory.js reconcile --desk <absolute desk root> --since <iso> --until <iso> [--store <directory>] [--person-prefix desks/<alias>]
//   node scripts/factory.js loop --desk <absolute desk root> [--person-prefix desks/<alias>]
//
// `account` names the signed-in GitHub account that can open intake pull
// requests on the store, asking GitHub with each account's own token rather
// than assuming gh's active account, and prints the named reason and exits 1
// when no signed-in account can deliver; `consent` records the account it names.
// Every subcommand prints one JSON value on success. Validation failures print
// their stable JSON result and exit 1; usage errors print one line to stderr.
// Candidate revisions are inspected through Git as bytes and are never loaded.
// validate-pr judges the tree that merging the head into the base produces
// (`git merge-tree`, Git 2.38 or later), not a diff against one merge base.
// `validate-pr` accepts published facts (`facts/<host>-<session id>.json`),
// published labels (`labels/<job>/<session id>.json`) and a machine's capture
// record (`capture/<intake id>.json`) from anyone; anything
// else is maintenance. `evaluate` prepares the waste evaluator's briefs for a
// finished task's sessions and `evaluate-accept` checks what the evaluator
// wrote; both print paths and codes only, never session content.
// `kaizen-check` runs in a store's build: it compares each open kaizen card's
// measure before and after its version and keeps the card's one comment and
// verdict label current, with the token in `GH_TOKEN`. `andon` opens, updates
// and closes the store's andon issues when a tracked plugin's latest
// comparable version makes a quality measure clearly worse; the tracked
// plugins are the `andon.plugins` list in the store's `factory.json`, and a
// store without that file tracks none. Both print their JSON result and exit
// 1 when any card or issue failed, after checking the rest. `reconcile` compares
// a desk's real task activity in a window with the factory's jobs and prints each
// mismatch with a reason code (`src/factory/reconcile.js`); it only reads. `loop` is the
// detached loop worker (`src/factory/loop-worker.js`, started by `hooks/loop-start.cjs`
// at session start): it runs the improvement steps once and prints one line of codes
// and integers, with no path, name or id in it.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { jobId } from "../src/factory/binding.js"
import { readDeskRemote, resolveJobIdentity } from "../src/factory/desk-repo.js"
import { acceptEvaluations, evaluatePending, evaluateTask } from "../src/factory/evaluate-run.js"
import { kickLoop } from "../src/factory/evaluate-kick.js"
import { orphanPassLine, ownVersion, publishedJobId } from "../src/factory/local-status.js"
import { factoryStateDir } from "../src/factory/boot-check.js"
import { captureCheckLines, retentionLine } from "../src/factory/retention.js"
import { listFinalizeRequests, listMarkers, readMachineSecret, readStatus, setConsent } from "../src/factory/outbox.js"
import { PATTERNS } from "../src/factory/schema.js"
import { normalizeTimestamp } from "../src/factory/time.js"
import { reconcile } from "../src/factory/reconcile.js"
import { keyedJobId } from "../src/factory/publish.js"
import { build, jobReportUrl, storePublicPlugins, storeRecords } from "../src/factory/pipeline/build.js"
import { parseStoreConfig, syncAndon } from "../src/factory/pipeline/andon.js"
import { syncKaizenCards } from "../src/factory/pipeline/kaizen.js"
import { issuesClient } from "../src/factory/store-issues.js"
import { factsPathsForSession, isCapturePath, isFactsPath, labelsPathParts, validatePr } from "../src/factory/pipeline/validate-pr.js"

export const SUPPORTED_COMMANDS = Object.freeze(["account", "consent", "derive", "status", "flush", "finalize", "validate-pr", "build", "job-link", "evaluate", "evaluate-accept", "kaizen-check", "andon", "reconcile", "loop"])
const CONSENT_OPTIONS = new Set(["store", "contribute", "account"])
const CONTRIBUTE_VALUES = new Set(["yes", "no"])
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const GIT_REF = /^[0-9a-f]{40}$/u
const AUTHOR_ASSOCIATION = /^[A-Z_]{2,40}$/u
const JOB = /^[0-9a-f]{32}$/u
const MAX_FINALIZE_JOBS = 8

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

const DERIVE_HARD_DEADLINE_MS = 360000

// The exit code `timeout(1)` uses, so a worker that hit its ceiling is told apart from one that finished (0).
const DERIVE_DEADLINE_EXIT = 124

export async function runDeriveCommand({ argv, env, deadlineMs = DERIVE_HARD_DEADLINE_MS, exit = process.exit, warn = console.error }) {
  const options = parseOptions(argv)
  if (options === null || !options.has("marker") || [...options.keys()].some((key) => !["marker", "wait-quiet"].includes(key))) {
    throw new Error("Usage: factory.js derive --marker <file> [--wait-quiet <milliseconds>]")
  }
  const raw = options.get("wait-quiet") ?? "0"
  if (!/^\d{1,6}$/u.test(raw) || Number(raw) > 30000) throw new Error("factory.js derive: wait-quiet must be 0..30000")
  const { deriveFile } = await import("../src/factory/derive-run.js")
  // A hard ceiling on the detached worker's life: the quiet wait is capped at five minutes, and derivation after it gets one more minute. A worker still alive then is stuck, so it ends itself.
  const ceiling = setTimeout(() => {
    warn(`factory.js derive: still running after ${Math.round(deadlineMs / 1000)}s; ending it (exit ${DERIVE_DEADLINE_EXIT}) so a hang is not mistaken for success`)
    exit(DERIVE_DEADLINE_EXIT)
  }, deadlineMs)
  ceiling.unref()
  try {
    return await deriveFile(env, options.get("marker"), { quietMs: Number(raw) })
  } finally {
    clearTimeout(ceiling)
  }
}

/** `flush --store <owner/repo>`: one delivery attempt; prints `{ result, pr?, stale_retries?, rejections_unmatched? }`. */
export async function runFlushCommand({ argv, env, runner }) {
  const options = parseOptions(argv)
  if (options === null || options.size !== 1 || !options.has("store")) throw new Error("Usage: factory.js flush --store <owner/repo>")
  const { flush, ghRunner } = await import("../src/factory/flush.js")
  return flush(env, { store: options.get("store"), runner: runner ?? ghRunner({ env }) })
}

/**
 * `finalize --job <job> [--job <job> ...]` (at most eight): finalizes each job in turn; prints `{ jobs: { <job>: result } }`. Finalize has just
 * derived the finished jobs' sessions, so it then starts the loop worker when the evaluator step is due (`kickLoop`, `evaluate-kick.js`): a
 * job's evaluation starts at the end of the turn that finished it. A kick that fails changes nothing printed. `kick` is a seam for tests.
 */
export async function runFinalizeCommand({ argv, env, runner, kick = kickLoop }) {
  const jobs = []
  let malformed = argv.length === 0
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1]
    if (argv[index] !== "--job" || typeof value !== "string" || !JOB.test(value) || jobs.includes(value)) malformed = true
    else jobs.push(value)
  }
  if (malformed || jobs.length > MAX_FINALIZE_JOBS) throw new Error(`Usage: factory.js finalize --job <32 hex> [--job <32 hex> ...] (at most ${MAX_FINALIZE_JOBS} distinct jobs)`)
  const { finalize, ghRunner } = await import("../src/factory/flush.js")
  const results = {}
  for (const job of jobs) results[job] = await finalize(env, { job, runner: runner ?? ghRunner({ env }) })
  try {
    await kick(env)
  } catch {
    // The next end of a turn or session start starts the worker instead.
  }
  return { jobs: results }
}

export async function runStatusCommand({ argv, env }) {
  if (argv.length) throw new Error("Usage: factory.js status")
  const status = await readStatus(env)
  return { ...status, orphan_pass: orphanPassLine(status.orphans, Date.now(), { version: ownVersion() }), retention: retentionLine(status), capture_check: captureCheckLines(status), markers: (await listMarkers(env)).length, finalize: (await listFinalizeRequests(env)).length }
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
  // Anything but a published facts, labels or capture file, including a non-fact file
  // under `facts/` or `labels/`, is maintenance: the store's merge workflow
  // never merges it. A maintainer's deletion of a facts or labels file is a
  // retraction and validates like any other change at those paths; anyone
  // else's deletion is refused (`removal`).
  let maintenance = false
  const errors = []
  listed.forEach((change, index) => {
    const labels = labelsPathParts(change.path)
    if (!isFactsPath(change.path) && labels === null && !isCapturePath(change.path)) {
      maintenance = true
      if (!trustedMaintainer) errors.push({ code: "path", path: `changes.${index}` })
      return
    }
    if (change.status === "removed" || change.status === "unknown") {
      errors.push(...validatePr({ changes: [change], trustedMaintainer }).errors)
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

const JOB_LINK_USAGE = "Usage: factory.js job-link --store <owner/repo> --desk-remote <url> [--person-prefix <prefix>] [--desk <desk root>] --track <track> --slug <slug> [--this-machine]"

/**
 * `job-link`: the card's report URL. Without `--desk` this hashes the given
 * `--track`/`--slug` as-is, so a renamed or moved card's report will not be
 * found there; pass `--desk <desk root>` (the same value the task tools see)
 * to resolve the card's birth path first, exactly as the task tools and the
 * boot check do, so the link matches the job they already agree on. It
 * follows the task card's rule (`publishedJobId`): only a desk known private
 * gets a link, to its plain job ID; any other desk prints
 * `{ link: null, reason }` (`desk_not_private` or `visibility_not_known`).
 *
 * `--this-machine` answers the operator instead of the card: where this
 * machine's sessions of the job are reported. A desk known private gets the
 * same link, as `{ link, keyed: false }`. A desk known not to be private has
 * its sessions published under the job ID keyed with this machine's secret
 * (`publish.js` `keyedJobId`), so it prints `{ link, keyed: true, note }` to
 * that report, which holds this machine's sessions only; `note` says the link
 * is private. A desk whose visibility is not known prints `{ link: null,
 * reason: "visibility_not_known" }`, and a machine with no secret yet prints
 * `{ link: null, reason: "no_machine_secret" }`: it has published nothing
 * keyed, and this command never creates the secret. The keyed link ties the desk's public
 * card to its store job, which is why the card never carries it: it is for
 * the operator's own reading, never for the card or any public record.
 */
export async function runJobLinkCommand({ argv, env = process.env }) {
  const thisMachine = argv.includes("--this-machine")
  const options = parseOptions(argv.filter((arg) => arg !== "--this-machine"))
  const required = ["store", "desk-remote", "track", "slug"]
  const allowed = [...required, "person-prefix", "desk"]
  if (options === null || required.some((key) => !options.has(key)) || [...options.keys()].some((key) => !allowed.includes(key))) {
    throw new Error(JOB_LINK_USAGE)
  }
  const personPrefix = options.get("person-prefix") ?? ""
  let track = options.get("track")
  let slug = options.get("slug")
  if (options.has("desk")) {
    if (!path.isAbsolute(options.get("desk"))) throw new Error(JOB_LINK_USAGE)
    let root
    try {
      root = realpathSync(options.get("desk"))
    } catch {
      throw new Error("factory.js job-link: the desk folder could not be read")
    }
    const birth = resolveJobIdentity({ deskRoot: root, personPrefix, track, slug })
    track = birth.track
    slug = birth.slug
  }
  const store = options.get("store")
  const deskRemote = options.get("desk-remote")
  // A bad store fails with the usage error before any state is read.
  jobReportUrl({ store, job: "0".repeat(32) })
  const job = jobId({ deskRemote, personPrefix, track, slug })
  const published = publishedJobId({ env, deskRemote, job })
  if (thisMachine) return thisMachineLink({ env, store, job, published })
  return published.job === null ? { link: null, reason: published.reason } : { link: jobReportUrl({ store, job: published.job }) }
}

// Said beside every keyed link, so the agent that receives one is told where it may go.
export const KEYED_LINK_NOTE = "Private: this link ties this desk to its job in the store. Keep it in your private evaluation; never put it on the task card, in a pull request or anywhere public."

// `--this-machine`, see `runJobLinkCommand`. A link that might 404 is never printed: an unknown visibility is `visibility_not_known` (the next
// flush asks GitHub again), and a machine with no secret has published nothing keyed yet (`no_machine_secret`); the secret is never created here.
async function thisMachineLink({ env, store, job, published }) {
  if (published.job !== null) return { link: jobReportUrl({ store, job }), keyed: false }
  if (published.reason === "visibility_not_known") return { link: null, reason: published.reason }
  if (!existsSync(path.join(factoryStateDir(env), "machine-secret"))) return { link: null, reason: "no_machine_secret" }
  return { link: jobReportUrl({ store, job: keyedJobId(job, await readMachineSecret(env)) }), keyed: true, note: KEYED_LINK_NOTE }
}

/** The installed Desk plugin's version, which the evaluator's labels carry. */
export function deskVersion() {
  return JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8")).version
}

const EVALUATE_USAGE = "Usage: factory.js evaluate --desk <absolute desk root> --task [desks/<alias>/]<track>/<slug> | --pending"

/**
 * Runs `evaluate`: the task's job ID, computed exactly as the task tools
 * compute it, then `evaluateTask` (record the job's evaluation request and
 * prepare its briefs). `--pending` prepares every retained request again.
 * Prints results and brief paths only.
 */
export async function runEvaluateCommand({ argv, env, pluginVersion = deskVersion() }) {
  if (argv.length === 1 && argv[0] === "--pending") return evaluatePending(env, { pluginVersion })
  const options = parseOptions(argv)
  if (options === null || options.size !== 2 || !options.has("desk") || !options.has("task") || !path.isAbsolute(options.get("desk"))) {
    throw new Error(EVALUATE_USAGE)
  }
  const segments = options.get("task").split("/")
  const crew = segments.length === 4 && segments[0] === "desks"
  if (segments.length !== (crew ? 4 : 2)) throw new Error(EVALUATE_USAGE)
  let root
  try {
    root = realpathSync(options.get("desk"))
  } catch {
    throw new Error("factory.js evaluate: the desk folder could not be read")
  }
  let job
  try {
    const personPrefix = crew ? `desks/${segments[1].trim()}` : ""
    const deskRemote = readDeskRemote({ deskRoot: root }) || `local:${root}`
    const birth = resolveJobIdentity({ deskRoot: root, personPrefix, track: segments.at(-2), slug: segments.at(-1) })
    job = jobId({ deskRemote, personPrefix, track: birth.track, slug: birth.slug })
  } catch {
    throw new Error(EVALUATE_USAGE)
  }
  return evaluateTask(env, { job, deskRoot: root, pluginVersion })
}

/** Runs `evaluate-accept`: checks each written answer for the job and moves accepted labels into the outbox. */
export async function runEvaluateAcceptCommand({ argv, env, pluginVersion = deskVersion() }) {
  const options = parseOptions(argv)
  if (options === null || options.size !== 1 || !PATTERNS.jobId.test(options.get("job") ?? "")) {
    throw new Error("Usage: factory.js evaluate-accept --job <job>")
  }
  return acceptEvaluations(env, { job: options.get("job"), pluginVersion })
}

/** `account --store <owner/repo>`: the signed-in account that can open intake pull requests there (`chooseAccount`). */
export async function runAccountCommand({ argv, env, runner }) {
  const options = parseOptions(argv)
  if (options === null || options.size !== 1 || !PATTERNS.prRepo.test(options.get("store") ?? "")) throw new Error("Usage: factory.js account --store <owner/repo>")
  const { chooseAccount, ghRunner } = await import("../src/factory/flush.js")
  return chooseAccount({ store: options.get("store"), runner: runner ?? ghRunner({ env }) })
}

const STORE_ISSUE_OPTIONS = ["store", "repo", "author"]

// The options `kaizen-check` (and andon) share: the checked-out store, the
// store's `owner/repo`, the bot login whose comments are the build's own, and
// the token from `GH_TOKEN`.
async function storeIssueContext({ argv, env, runner, usage }) {
  const options = parseOptions(argv)
  if (options === null || !options.has("store") || !PATTERNS.prRepo.test(options.get("repo") ?? "") || [...options.keys()].some((key) => !STORE_ISSUE_OPTIONS.includes(key))) {
    throw new Error(usage)
  }
  const token = env.GH_TOKEN ?? ""
  if (token === "") throw new Error(`${usage}; GH_TOKEN must hold the store's token`)
  const records = storeRecords(options.get("store"))
  const { ghRunner } = await import("../src/factory/flush.js")
  const client = issuesClient({ runner: runner ?? ghRunner({ env }), repo: options.get("repo"), token })
  return { records, client, ...(options.has("author") ? { author: options.get("author") } : {}) }
}

/** Runs `kaizen-check`: the kaizen check on every open card of the store; prints each card's status. */
export async function runKaizenCheckCommand({ argv, env, runner }) {
  const context = await storeIssueContext({ argv, env, runner, usage: "Usage: factory.js kaizen-check --store <directory> --repo <owner/repo> [--author <login>]" })
  return syncKaizenCards(context)
}

/** Runs `andon`: opens, updates, reopens and closes the store's andon issues; prints each alarm's action. */
export async function runAndonCommand({ argv, env, runner }) {
  const context = await storeIssueContext({ argv, env, runner, usage: "Usage: factory.js andon --store <directory> --repo <owner/repo> [--author <login>]" })
  const configPath = path.join(parseOptions(argv).get("store"), "factory.json")
  const config = parseStoreConfig(existsSync(configPath) ? readFileSync(configPath, "utf8") : null)
  if (!config.ok) throw new Error(`factory.js andon: the store's factory.json is not valid (${config.code})`)
  // Other plugins are named only when public by the publishing rule (M3-12).
  return syncAndon({ ...context, plugins: config.plugins, publicPlugins: storePublicPlugins(parseOptions(argv).get("store")) })
}

const RECONCILE_USAGE = "Usage: factory.js reconcile --desk <absolute desk root> --since <iso> --until <iso> [--store <directory>] [--person-prefix desks/<alias>]"
const RECONCILE_OPTIONS = ["desk", "since", "until", "store", "person-prefix"]

/** Runs `reconcile`: bad arguments give `{ ok: false, error }`; see `src/factory/reconcile.js`. */
export async function runReconcileCommand({ argv, env, git = "git" }) {
  const options = parseOptions(argv)
  const fail = (error = RECONCILE_USAGE) => ({ ok: false, error })
  if (options === null || ["desk", "since", "until"].some((key) => !options.has(key)) || [...options.keys()].some((key) => !RECONCILE_OPTIONS.includes(key))) return fail()
  if (!path.isAbsolute(options.get("desk"))) return fail()
  if (options.has("store") && options.get("store") === "") return fail()
  const since = normalizeTimestamp(options.get("since"))
  const until = normalizeTimestamp(options.get("until"))
  if (since === null || until === null || !PATTERNS.timestamp.test(since) || !PATTERNS.timestamp.test(until)) return fail("factory.js reconcile: --since and --until must be exact UTC timestamps")
  if (!(Date.parse(since) < Date.parse(until))) return fail("factory.js reconcile: --since must be before --until")
  return reconcile({
    deskRoot: options.get("desk"), personPrefix: options.get("person-prefix") ?? "", since, until,
    storeDir: options.has("store") ? path.resolve(options.get("store")) : null, env,
    ...(typeof git === "string" ? { git } : {}),
  })
}

const LOOP_USAGE = "Usage: factory.js loop --desk <absolute desk root> [--person-prefix desks/<alias>]"

/** Runs `loop`: one run of the improvement steps for the desk and person given (`src/factory/loop-worker.js`); returns codes and integers only. `impls`, `pluginVersion` and the rest of `extra` are test seams. */
export async function runLoopCommand({ argv, env, pluginVersion = deskVersion(), ...extra }) {
  const options = parseOptions(argv)
  const person = options?.get("person-prefix") ?? ""
  if (options === null || [...options.keys()].some((key) => key !== "desk" && key !== "person-prefix") || (options.has("desk") && !path.isAbsolute(options.get("desk"))) || !/^(?:|desks\/[A-Za-z0-9][A-Za-z0-9._-]*)$/u.test(person)) {
    throw new Error(LOOP_USAGE)
  }
  const { runLoopWorker } = await import("../src/factory/loop-worker.js")
  const { impls, clock, alive, budgetMs, ceilingMs, exit, readStatusImpl } = extra
  return runLoopWorker(env, { deskRoot: options.get("desk") ?? null, personPrefix: person, pluginVersion, impls, clock, alive, budgetMs, ceilingMs, exit, readStatusImpl })
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
export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), git = runGit, runner = undefined, write = (text) => process.stdout.write(text), logError = (text) => process.stderr.write(text) } = {}) {
  const [subcommand, ...rest] = argv
  try {
    if (!SUPPORTED_COMMANDS.includes(subcommand)) {
      throw new Error(`factory.js: unknown subcommand ${JSON.stringify(subcommand ?? "")} (supported: ${SUPPORTED_COMMANDS.join(", ")})`)
    }
    const command = {
      account: runAccountCommand,
      consent: runConsentCommand,
      derive: runDeriveCommand,
      status: runStatusCommand,
      flush: runFlushCommand,
      finalize: runFinalizeCommand,
      "validate-pr": runValidatePrCommand,
      build: runBuildCommand,
      "job-link": runJobLinkCommand,
      evaluate: runEvaluateCommand,
      "evaluate-accept": runEvaluateAcceptCommand,
      "kaizen-check": runKaizenCheckCommand,
      andon: runAndonCommand,
      reconcile: runReconcileCommand,
      loop: runLoopCommand,
    }[subcommand]
    const result = await command({ argv: rest, env, cwd, git, runner })
    write(`${JSON.stringify(result)}\n`)
    const failed = ((subcommand === "validate-pr" || subcommand === "reconcile") && result.ok === false) || (subcommand === "account" && result.result !== "account_found") || Object(result).failed > 0
    return failed ? 1 : 0
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

/** Runs `run` and sets the exit code when `argv1` names this module; otherwise does nothing. Returns whether it ran. */
export async function runIfMain(importMetaUrl, argv1, run = main) {
  if (!isMainModule(importMetaUrl, argv1)) return false
  process.exitCode = await run()
  return true
}

await runIfMain(import.meta.url, process.argv[1])
