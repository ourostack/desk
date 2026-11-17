#!/usr/bin/env node
// The Desk factory CLI.
//
//   node scripts/factory.js account --store <owner/repo>
//   node scripts/factory.js consent --store <owner/repo> --contribute yes|no [--account <gh login>]
//   node scripts/factory.js flush --store <owner/repo>
//   node scripts/factory.js context-request --store <owner/repo> --job <public job id>
//   node scripts/factory.js finalize --job <job> [--job <job> ...]
//   node scripts/factory.js validate-pr --base <sha> --head <sha> --author-association <value>
//     Triage data also requires --repo <owner/repo> --pr <number> for trusted API authority.
//   node scripts/factory.js build --store <directory> --out <directory>
//   node scripts/factory.js job-link --store <owner/repo> --desk-remote <url> [--person-prefix <prefix>] [--desk <desk root>] --track <track> --slug <slug> [--this-machine]
//   node scripts/factory.js evaluate --desk <desk root> --task [desks/<alias>/]<track>/<slug>
//   node scripts/factory.js evaluate --pending
//   node scripts/factory.js evaluate-accept --job <job>
//   node scripts/factory.js kaizen-check --store <directory> --repo <owner/repo> [--author <login>]
//   node scripts/factory.js andon --store <directory> --repo <owner/repo> [--author <login>]
//   node scripts/factory.js reconcile --desk <absolute desk root> --since <iso> --until <iso> [--store <directory>] [--person-prefix desks/<alias>]
//   node scripts/factory.js loop --desk <absolute desk root> [--person-prefix desks/<alias>]
//   node scripts/factory.js proof <session id> [--desk <absolute desk root>]
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

import { AxError } from "../src/lib/ouro-ui/registry/ouro/ax/problem.ts"
import { defineCli, defineCommand } from "../src/lib/ouro-ui/registry/ouro/ax/command.ts"
import { runCli } from "../src/lib/ouro-ui/registry/ouro/ax/cli.ts"
import { jobId } from "../src/factory/binding.js"
import { readDeskRemote, resolveJobIdentity } from "../src/factory/desk-repo.js"
import { acceptEvaluations, evaluatePending, evaluateTask } from "../src/factory/evaluate-run.js"
import { kickLoop } from "../src/factory/evaluate-kick.js"
import { runRequestedTaskContext } from "../src/factory/context-run.js"
import { orphanPassLine, ownVersion, publishedJobId } from "../src/factory/local-status.js"
import { factoryStateDir } from "../src/factory/boot-check.js"
import { captureCheckLines, retentionLine } from "../src/factory/retention.js"
import { listFinalizeRequests, listMarkers, readMachineSecret, readStatus, setConsent } from "../src/factory/outbox.js"
import { PATTERNS } from "../src/factory/schema.js"
import { normalizeTimestamp } from "../src/factory/time.js"
import { reconcile } from "../src/factory/reconcile.js"
import { markProofSession } from "../src/factory/proof-session.js"
import { keyedJobId } from "../src/factory/publish.js"
import { build, jobReportUrl, storePublicPlugins, storeRecords } from "../src/factory/pipeline/build.js"
import { parseStoreConfig, syncAndon } from "../src/factory/pipeline/andon.js"
import { syncKaizenCards } from "../src/factory/pipeline/kaizen.js"
import { issuesClient } from "../src/factory/store-issues.js"
import { contextPathParts, factsPathsForSession, isCapturePath, isFactsPath, labelsPathParts, validatePr } from "../src/factory/pipeline/validate-pr.js"
import { isTriagePath } from "../src/factory/triage-schema.js"

export const SUPPORTED_COMMANDS = Object.freeze(["account", "consent", "derive", "status", "flush", "context-request", "finalize", "validate-pr", "build", "job-link", "evaluate", "evaluate-accept", "kaizen-check", "andon", "reconcile", "loop", "proof"])
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const GIT_REF = /^[0-9a-f]{40}$/u
const AUTHOR_ASSOCIATION = /^[A-Z_]{2,40}$/u
const JOB = /^[0-9a-f]{32}$/u
const MAX_FINALIZE_JOBS = 8

const DERIVE_HARD_DEADLINE_MS = 360000

// The exit code `timeout(1)` uses, so a worker that hit its ceiling is told apart from one that finished (0).
const DERIVE_DEADLINE_EXIT = 124

export async function runDeriveCommand({ marker, "wait-quiet": waitQuiet = 0 }, { env, deadlineMs = DERIVE_HARD_DEADLINE_MS, exit = process.exit, warn = console.error }) {
  const { deriveFile } = await import("../src/factory/derive-run.js")
  // A hard ceiling on the detached worker's life: the quiet wait is capped at five minutes, and derivation after it gets one more minute. A worker still alive then is stuck, so it ends itself.
  const ceiling = setTimeout(() => {
    warn(`factory.js derive: still running after ${Math.round(deadlineMs / 1000)}s; ending it (exit ${DERIVE_DEADLINE_EXIT}) so a hang is not mistaken for success`)
    exit(DERIVE_DEADLINE_EXIT)
  }, deadlineMs)
  ceiling.unref()
  try {
    return await deriveFile(env, marker, { quietMs: waitQuiet })
  } finally {
    clearTimeout(ceiling)
  }
}

/** `flush --store <owner/repo>`: one delivery attempt; prints `{ result, pr?, stale_retries?, rejections_unmatched? }`. */
export async function runFlushCommand({ store }, { env, runner }) {
  const { flush, ghRunner } = await import("../src/factory/flush.js")
  return flush(env, { store, runner: runner ?? ghRunner({ env }) })
}

/**
 * `finalize --job <job> [--job <job> ...]` (at most eight): finalizes each job in turn; prints `{ jobs: { <job>: result } }`. Finalize has just
 * derived the finished jobs' sessions, so it then starts the loop worker when the evaluator step is due (`kickLoop`, `evaluate-kick.js`): a
 * job's evaluation starts at the end of the turn that finished it. A kick that fails changes nothing printed. `kick` is a seam for tests.
 */
export async function runFinalizeCommand({ job: jobs }, { env, runner, kick = kickLoop }) {
  if (jobs.length > MAX_FINALIZE_JOBS || new Set(jobs).size !== jobs.length || !jobs.every((job) => JOB.test(job))) {
    throw usageError("finalize", `--job takes up to ${MAX_FINALIZE_JOBS} distinct 32-hex job ids`, "factory finalize --job <32 hex> [--job <32 hex> ...]")
  }
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

/** `proof <session id> [--desk <absolute desk root>]`: marks an existing local session as a controlled proof (`proof-session.js`); prints `{ result, reason? }`. */
export async function runProofCommand({ session: sessionId, desk = null }, { env }) {
  if (desk !== null && !path.isAbsolute(desk)) throw usageError("proof", "--desk must be an absolute desk root", "factory proof <session id> --desk <absolute desk root>")
  return markProofSession(env, { sessionId, desk })
}

export async function runStatusCommand(_input, { env }) {
  const status = await readStatus(env)
  return { ...status, orphan_pass: orphanPassLine(status.orphans, Date.now(), { version: ownVersion() }), retention: retentionLine(status), capture_check: captureCheckLines(status), markers: (await listMarkers(env)).length, finalize: (await listFinalizeRequests(env)).length }
}

function runGit(args, { cwd, encoding = "utf8", maxBuffer = 32 * 1024 * 1024 }) {
  try {
    return execFileSync("git", args, { windowsHide: true, cwd, encoding, maxBuffer, stdio: ["ignore", "pipe", "pipe"] })
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

function mergedContextFacts({ tree, cwd, git }) {
  return git(["ls-tree", "-r", "-z", tree, "--", "facts/"], { cwd }).split("\0").flatMap((entry) => {
    const match = /^(\d{6}) (\w+) [0-9a-f]{40}\t(.+)$/u.exec(entry)
    if (match === null || !isFactsPath(match[3])) return []
    return [{
      path: match[3],
      bytes: ["100644", "100755"].includes(match[1]) && match[2] === "blob"
        ? revisionBytes({ revision: tree, filePath: match[3], cwd, git }) : null,
    }]
  })
}

// Keep legacy facts/labels/capture diff behavior. Triage additionally reads
// rename/copy status and exact tree modes; never relabel a replacement as add.
// Similar new correction batches are legitimate additions. Only byte-exact
// copies count as copied; resemblance is not mutation of a historical path.
function triageStatuses({ base, tree, cwd, git }) {
  const fields = git(["diff", "--name-status", "-z", "--find-renames", "-C100%", "--find-copies-harder", base, tree], { cwd }).split("\0").filter(Boolean)
  const statuses = new Map()
  for (let i = 0; i < fields.length;) {
    const code = fields[i++], from = fields[i++]
    if (from === undefined) throw new Error("factory.js validate-pr: Git change list is malformed")
    if (/^[RC][0-9]+$/u.test(code)) {
      const to = fields[i++]
      if (to === undefined) throw new Error("factory.js validate-pr: Git change list is malformed")
      const status = code.startsWith("R") ? "renamed" : "copied"
      if (isTriagePath(from)) statuses.set(from, status)
      if (isTriagePath(to)) statuses.set(to, status)
    } else if (isTriagePath(from)) {
      statuses.set(from, ({ A:"added", M:"modified", D:"removed", T:"type_changed" })[code] ?? "unknown")
    }
  }
  return statuses
}

function triageTreeEntry({ revision, filePath, cwd, git }) {
  const output = git(["ls-tree", "-z", revision, "--", filePath], { cwd })
  if (output === "") return null
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/u.exec(output)
  return match && match[3] === filePath ? { regular: true } : { regular: false }
}

// The real PR actor and permission come only from successful trusted API
// reads. Association, JSON ownership/version, Git author, and random IDs are
// not authority. A second read pins actor/head across local validation.
async function readTriageActor({ repo, pr, head, runner, token }) {
  if (typeof repo !== "string" || !PATTERNS.prRepo.test(repo) || !/^[1-9][0-9]{0,9}$/u.test(pr)) return null
  try {
    const response = await runner(["api", `repos/${repo}/pulls/${pr}`], { token, timeoutMs: 12000 })
    if (response?.code !== 0) return null
    const value = JSON.parse(response.stdout)
    const actor = value?.user?.login
    if (value?.head?.sha !== head || typeof actor !== "string" || !/^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/u.test(actor)) return null
    return actor
  } catch { return null }
}
async function triageActorPermission({ repo, actor, runner, token }) {
  try {
    const response = await runner(["api", `repos/${repo}/collaborators/${encodeURIComponent(actor)}/permission`], { token, timeoutMs: 12000 })
    if (response?.code !== 0) return undefined
    const value = JSON.parse(response.stdout)
    if (["write", "maintain", "admin"].includes(value?.permission)) return true
    if (["none", "read", "triage"].includes(value?.permission)) return false
    return undefined
  } catch { return undefined }
}

const VALIDATE_PR_FLAGS = ["base", "head", "author-association", "repo", "pr"]

/**
 * Validates a store pull request: `flags` is `{ base, head, "author-association", repo?, pr? }` and `seams` the
 * runner, git, cwd and env. A store's workflows import this from Desk main and run their default branch's own
 * caller, which can still pass the older `({ argv, runner, env })` call (ourostack/factory#1020 moves factory off
 * it). That call still works: its `--flag value` list becomes the flags, and a malformed or unknown flag is a usage error.
 */
export async function runValidatePrCommand(flags, seams) {
  if (seams === undefined && Array.isArray(flags?.argv)) {
    const { argv, ...rest } = flags
    const named = {}
    for (let index = 0; index < argv.length; index += 2) {
      const name = typeof argv[index] === "string" && argv[index].startsWith("--") ? argv[index].slice(2) : ""
      if (!VALIDATE_PR_FLAGS.includes(name) || typeof argv[index + 1] !== "string" || Object.hasOwn(named, name)) {
        throw usageError("validate-pr", `${JSON.stringify(argv[index])} is not one of --${VALIDATE_PR_FLAGS.join(", --")} with a value, given once`, "factory validate-pr --base <base sha> --head <head sha> --author-association <value>")
      }
      named[name] = argv[index + 1]
    }
    return validatePrRequest(named, rest)
  }
  return validatePrRequest(flags, seams)
}

async function validatePrRequest({ base, head, "author-association": association, repo, pr }, { cwd = process.cwd(), git = runGit, runner, env = process.env }) {
  if (!GIT_REF.test(base) || !GIT_REF.test(head)) throw usageError("validate-pr", "--base and --head must be full commit SHAs", "factory validate-pr --base <base sha> --head <head sha> --author-association <value>")
  if (!AUTHOR_ASSOCIATION.test(association)) throw usageError("validate-pr", "--author-association is not an association such as NONE or OWNER", "factory validate-pr --author-association <value>")

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
  const triageChanges = listed.filter((c) => isTriagePath(c.path))
  let triageAuthority, actor, api
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN
  const statuses = triageChanges.length ? triageStatuses({ base, tree, cwd, git }) : new Map()
  if (triageChanges.length && repo !== undefined && pr !== undefined) {
    api = runner ?? (await import("../src/factory/flush.js")).ghRunner({ env })
    actor = await readTriageActor({ repo, pr, head, runner: api, token })
    if (actor !== null) triageAuthority = await triageActorPermission({ repo, actor, runner: api, token })
  }
  // Anything but a published facts, labels or capture file, including a non-fact file
  // under `facts/` or `labels/`, is maintenance: the store's merge workflow
  // never merges it. A maintainer's deletion of a facts or labels file is a
  // retraction and validates like any other change at those paths; anyone
  // else's deletion is refused (`removal`).
  let maintenance = false
  let contextFacts
  const errors = []
  listed.forEach((change, index) => {
    const labels = labelsPathParts(change.path)
    const context = contextPathParts(change.path)
    if (isTriagePath(change.path)) {
      const status = statuses.get(change.path) ?? "unknown"
      // No read of symlink/submodule contents or any removed/renamed file.
      const previous = triageTreeEntry({ revision: base, filePath: change.path, cwd, git })
      const entry = ["added", "modified"].includes(status) ? triageTreeEntry({ revision: tree, filePath: change.path, cwd, git }) : null
      const current = {
        path: change.path, status: status === "added" && entry?.regular !== true ? "type_changed" : status,
        ...(previous !== null ? { previousBytes: previous.regular
          ? revisionBytes({ revision: base, filePath: change.path, cwd, git }) : null } : {}),
        ...(["added", "modified"].includes(status) && entry?.regular === true
          ? { bytes: revisionBytes({ revision: tree, filePath: change.path, cwd, git }) } : {}),
      }
      errors.push(...validatePr({ changes: [current], trustedMaintainer: triageAuthority }).errors)
      return
    }
    if (!isFactsPath(change.path) && labels === null && context === null && !isCapturePath(change.path)) {
      maintenance = true
      if (!trustedMaintainer) errors.push({ code: "path", path: `changes.${index}` })
      return
    }
    if (change.status === "removed" || change.status === "unknown") {
      errors.push(...validatePr({ changes: [change], trustedMaintainer }).errors)
      return
    }
    if (context !== null && triageTreeEntry({ revision: tree, filePath: change.path, cwd, git })?.regular !== true) {
      errors.push({ code: "context_not_regular", path: change.path })
      return
    }
    // The bytes the merge lands, and the bytes they replace on the base.
    const bytes = revisionBytes({ revision: tree, filePath: change.path, cwd, git })
    if (context !== null) {
      contextFacts ??= mergedContextFacts({ tree, cwd, git })
      const current = {
        ...change, bytes,
        ...(change.status === "modified" ? { previousBytes: revisionBytes({ revision: base, filePath: change.path, cwd, git }) } : {}),
        facts: contextFacts,
      }
      errors.push(...validatePr({ changes: [current], trustedMaintainer }).errors)
      return
    }
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
  if (triageChanges.length && actor && await readTriageActor({ repo, pr, head, runner: api, token }) !== actor) {
    errors.push(...triageChanges.map((c) => ({ code: "triage_authority_check_unavailable", path: c.path })))
  }
  const result = { ok: errors.length === 0, errors }
  return { ...result, maintenance: result.ok && maintenance && trustedMaintainer }
}

export async function runBuildCommand({ store, out }) {
  return build({ storeDir: store, outDir: out })
}


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
export async function runJobLinkCommand({ store, "desk-remote": deskRemote, track: trackFlag, slug: slugFlag, "person-prefix": personPrefix = "", desk, "this-machine": thisMachine = false }, { env }) {
  let track = trackFlag
  let slug = slugFlag
  if (desk !== undefined) {
    if (!path.isAbsolute(desk)) throw usageError("job-link", "--desk is not an absolute path", "factory job-link --desk <absolute desk root> ...")
    let root
    try {
      root = realpathSync(desk)
    } catch {
      throw new Error("factory.js job-link: the desk folder could not be read")
    }
    const birth = resolveJobIdentity({ deskRoot: root, personPrefix, track, slug })
    track = birth.track
    slug = birth.slug
  }
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

const EVALUATE_FIX = "factory evaluate --desk <absolute desk root> --task [desks/<alias>/]<track>/<slug> | --pending"

/**
 * Runs `evaluate`: the task's job ID, computed exactly as the task tools
 * compute it, then `evaluateTask` (record the job's evaluation request and
 * prepare its briefs). `--pending` prepares every retained request again.
 * Prints results and brief paths only.
 */
export async function runEvaluateCommand({ desk, task, pending = false }, { env, pluginVersion = deskVersion() }) {
  if (pending) return evaluatePending(env, { pluginVersion })
  if (desk === undefined || task === undefined || !path.isAbsolute(desk)) throw usageError("evaluate", "--desk must be an absolute path and --task given", EVALUATE_FIX)
  const segments = task.split("/")
  const crew = segments.length === 4 && segments[0] === "desks"
  if (segments.length !== (crew ? 4 : 2)) throw usageError("evaluate", "--task is not <track>/<slug> or desks/<alias>/<track>/<slug>", EVALUATE_FIX)
  let root
  try {
    root = realpathSync(desk)
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
    throw usageError("evaluate", "--task is not <track>/<slug> or desks/<alias>/<track>/<slug>", EVALUATE_FIX)
  }
  return evaluateTask(env, { job, deskRoot: root, pluginVersion })
}

/** Runs `evaluate-accept`: checks each written answer for the job and moves accepted labels into the outbox. */
export async function runEvaluateAcceptCommand({ job }, { env, pluginVersion = deskVersion() }) {
  if (!PATTERNS.jobId.test(job)) throw usageError("evaluate-accept", "--job is not a job id", "factory evaluate-accept --job <job>")
  return acceptEvaluations(env, { job, pluginVersion })
}

/** `account --store <owner/repo>`: the signed-in account that can open intake pull requests there (`chooseAccount`). */
export async function runAccountCommand({ store }, { env, runner }) {
  if (!PATTERNS.prRepo.test(store)) throw usageError("account", "--store is not an owner/repo", "factory account --store <owner/repo>")
  const { chooseAccount, ghRunner } = await import("../src/factory/flush.js")
  return chooseAccount({ store, runner: runner ?? ghRunner({ env }) })
}


// The options `kaizen-check` (and andon) share: the checked-out store, the
// store's `owner/repo`, the bot login whose comments are the build's own, and
// the token from `GH_TOKEN`.
async function storeIssueContext({ store, repo, author }, { env, runner }, thing) {
  if (!PATTERNS.prRepo.test(repo)) throw usageError(thing, "--repo is not an owner/repo", `factory ${thing} --store <directory> --repo <owner/repo>`)
  const token = env.GH_TOKEN ?? ""
  if (token === "") throw usageError(thing, "GH_TOKEN is empty", "set GH_TOKEN to the store's token")
  const records = storeRecords(store)
  const { ghRunner } = await import("../src/factory/flush.js")
  const client = issuesClient({ runner: runner ?? ghRunner({ env }), repo, token })
  return { records, client, ...(author === undefined ? {} : { author }) }
}

/** Runs `kaizen-check`: the kaizen check on every open card of the store; prints each card's status. */
export async function runKaizenCheckCommand(flags, ctx) {
  const context = await storeIssueContext(flags, ctx, "kaizen-check")
  return syncKaizenCards(context)
}

/** Runs `andon`: opens, updates, reopens and closes the store's andon issues; prints each alarm's action. */
export async function runAndonCommand(flags, ctx) {
  const context = await storeIssueContext(flags, ctx, "andon")
  const configPath = path.join(flags.store, "factory.json")
  const config = parseStoreConfig(existsSync(configPath) ? readFileSync(configPath, "utf8") : null)
  if (!config.ok) throw new Error(`factory.js andon: the store's factory.json is not valid (${config.code})`)
  // Other plugins are named only when public by the publishing rule (M3-12).
  return syncAndon({ ...context, plugins: config.plugins, publicPlugins: storePublicPlugins(flags.store) })
}

/** Runs `reconcile`: bad arguments are usage errors; see `src/factory/reconcile.js`. */
export async function runReconcileCommand({ desk, since: sinceFlag, until: untilFlag, store, "person-prefix": personPrefix = "" }, { env, git = "git" }) {
  if (!path.isAbsolute(desk)) throw usageError("reconcile", "--desk is not an absolute path", "factory reconcile --desk <absolute desk root> --since <iso> --until <iso>")
  if (store === "") throw usageError("reconcile", "--store is empty", "factory reconcile --store <directory> ...")
  const since = normalizeTimestamp(sinceFlag)
  const until = normalizeTimestamp(untilFlag)
  if (since === null || until === null || !PATTERNS.timestamp.test(since) || !PATTERNS.timestamp.test(until)) throw usageError("reconcile", "--since and --until must be exact UTC timestamps", "factory reconcile --since 2026-09-28T00:00:00Z --until 2026-09-29T00:00:00Z")
  if (!(Date.parse(since) < Date.parse(until))) throw usageError("reconcile", "--since is not before --until", "factory reconcile --since <earlier iso> --until <later iso>")
  return reconcile({
    deskRoot: desk, personPrefix, since, until,
    storeDir: store === undefined ? null : path.resolve(store), env,
    ...(typeof git === "string" ? { git } : {}),
  })
}

/** An explicit operator request owns one existing source-bound job, never a background budget override. */
export async function runContextRequestCommand({ store, job }, { env, run = runRequestedTaskContext }) {
  if (!PATTERNS.prRepo.test(store) || !JOB.test(job)) throw usageError("context-request", "--store must be an owner/repo and --job a 32-hex public job id", "factory context-request --store <owner/repo> --job <public job id>")
  return run(env, { store, job })
}

/** Runs `loop`: one run of the improvement steps for the desk and person given (`src/factory/loop-worker.js`); returns codes and integers only. `impls`, `pluginVersion` and the rest of `extra` are test seams. */
export async function runLoopCommand({ desk, "person-prefix": person = "" }, { env, pluginVersion = deskVersion(), ...extra }) {
  if ((desk !== undefined && !path.isAbsolute(desk)) || !/^(?:|desks\/[A-Za-z0-9][A-Za-z0-9._-]*)$/u.test(person)) {
    throw usageError("loop", "--desk must be absolute and --person-prefix empty or desks/<alias>", "factory loop --desk <absolute desk root> [--person-prefix desks/<alias>]")
  }
  const { runLoopWorker } = await import("../src/factory/loop-worker.js")
  const { impls, clock, alive, budgetMs, ceilingMs, exit, readStatusImpl } = extra
  return runLoopWorker(env, { deskRoot: desk ?? null, personPrefix: person, pluginVersion, impls, clock, alive, budgetMs, ceilingMs, exit, readStatusImpl })
}

/** Runs the `consent` subcommand and returns the JSON-ready result: calls `setConsent`. */
export async function runConsentCommand({ store, contribute, account = null }, { env }) {
  const consent = await setConsent(env, { store, contribute: contribute === "yes", account })
  return { store, ...consent.stores[store] }
}

const usageError = (thing, problem, fix) => new AxError({ code: "usage", exit: 2, thing, problem, fix })

const STORE = { type: "string", required: true, placeholder: "<owner/repo>", description: "The store, as owner/repo." }
const JOB_FLAG = { type: "string", required: true, placeholder: "<job>", description: "The job id." }
const ISSUE_FLAGS = { store: { type: "string", required: true, placeholder: "<directory>", description: "The checked-out store." }, repo: { type: "string", required: true, placeholder: "<owner/repo>", description: "The store's owner/repo." }, author: { type: "string", placeholder: "<login>", description: "The bot login whose comments are the build's own." } }
const text = (result) => JSON.stringify(result)
const exitFor = (ok) => (ok ? "ok" : "error")
const noFailures = (result) => exitFor(!(Object(result).failed > 0))

/** The commands defined with Ouro AX; each prints one JSON value on one line, and a refusal exits 1. */
function factoryCli({ env, cwd, git, runner }) {
  const ctx = { env, cwd, git, runner }
  const command = (name, def, run) => defineCommand({ name, effect: "private", output: "one JSON value", text, ...def, run: (input) => run(input, ctx) })
  return defineCli({
    name: "factory",
    about: "The Desk factory: delivers a machine's session facts to a store and runs the store's pipeline.",
    commands: [
      command("account", { summary: "Name the signed-in GitHub account that can open intake pull requests on the store.", readOnly: true, flags: { store: STORE }, exit: (r) => exitFor(r.result === "account_found") }, runAccountCommand),
      command("consent", { summary: "Record whether this machine contributes to the store.", flags: { store: STORE, contribute: { type: "enum", values: ["yes", "no"], required: true, description: "Whether to contribute." }, account: { type: "string", placeholder: "<gh login>", description: "The GitHub account to deliver with." } } }, runConsentCommand),
      command("derive", { summary: "Derive facts from one marker file (the detached worker).", flags: { marker: { type: "string", required: true, placeholder: "<file>", description: "The marker file." }, "wait-quiet": { type: "number", min: 0, max: 30000, placeholder: "<milliseconds>", description: "How long to wait for the session to go quiet first." } } }, runDeriveCommand),
      command("status", { summary: "Print the factory's local status.", readOnly: true }, runStatusCommand),
      command("flush", { summary: "Make one delivery attempt to the store.", flags: { store: STORE } }, runFlushCommand),
      command("context-request", { summary: "Request the task context of one existing job, as the operator.", flags: { store: STORE, job: { ...JOB_FLAG, placeholder: "<public job id>" } }, exit: (r) => exitFor(r.ok !== false) }, runContextRequestCommand),
      command("finalize", { summary: "Finalize up to eight finished jobs, then start the loop worker when its step is due.", flags: { job: { ...JOB_FLAG, repeat: true } } }, runFinalizeCommand),
      command("build", { summary: "Build the store's reports.", flags: { store: { type: "string", required: true, placeholder: "<directory>", description: "The checked-out store." }, out: { type: "string", required: true, placeholder: "<directory>", description: "Where to write the build." } } }, runBuildCommand),
      command("evaluate-accept", { summary: "Check what the evaluator wrote for a job and move accepted labels into the outbox.", flags: { job: JOB_FLAG } }, runEvaluateAcceptCommand),
      command("evaluate", { summary: "Record a job's evaluation request and prepare its briefs; --pending prepares every retained request again.", flags: { desk: { type: "string", placeholder: "<absolute desk root>", description: "The desk." }, task: { type: "string", placeholder: "<track>/<slug>", description: "The task, as [desks/<alias>/]<track>/<slug>." }, pending: { type: "boolean", description: "Prepare every retained request again." } } }, runEvaluateCommand),
      command("job-link", { summary: "Print the keyed link of a job in the store (private).", readOnly: true, flags: { store: STORE, "desk-remote": { type: "string", required: true, placeholder: "<url>", description: "The desk's remote." }, track: { type: "string", required: true, placeholder: "<track>", description: "The track." }, slug: { type: "string", required: true, placeholder: "<slug>", description: "The task slug." }, "person-prefix": { type: "string", placeholder: "<prefix>", description: "The person prefix, desks/<alias>." }, desk: { type: "string", placeholder: "<desk root>", description: "The desk, to follow a renamed task." }, "this-machine": { type: "boolean", description: "Print only this machine's own link." } } }, runJobLinkCommand),
      command("kaizen-check", { summary: "Run the kaizen check on every open card of the store.", flags: ISSUE_FLAGS, exit: noFailures }, runKaizenCheckCommand),
      command("andon", { summary: "Open, update, reopen and close the store's andon issues.", flags: ISSUE_FLAGS, exit: noFailures }, runAndonCommand),
      command("reconcile", { summary: "Reconcile a desk's sessions against the store for a time window.", readOnly: true, flags: { desk: { type: "string", required: true, placeholder: "<absolute desk root>", description: "The desk." }, since: { type: "string", required: true, placeholder: "<iso>", description: "Window start, a UTC timestamp." }, until: { type: "string", required: true, placeholder: "<iso>", description: "Window end, a UTC timestamp." }, store: { type: "string", placeholder: "<directory>", description: "The store checkout." }, "person-prefix": { type: "string", placeholder: "desks/<alias>", description: "The person prefix." } }, exit: (r) => exitFor(r.ok !== false) }, runReconcileCommand),
      command("loop", { summary: "Run the improvement steps once for the desk and person given.", flags: { desk: { type: "string", placeholder: "<absolute desk root>", description: "The desk." }, "person-prefix": { type: "string", placeholder: "desks/<alias>", description: "The person prefix." } } }, runLoopCommand),
      command("validate-pr", { summary: "Validate a store pull request against the facts its merge would leave.", readOnly: true, flags: { base: { type: "string", required: true, placeholder: "<base sha>", description: "The base commit." }, head: { type: "string", required: true, placeholder: "<head sha>", description: "The pull request head commit." }, "author-association": { type: "string", required: true, placeholder: "<value>", description: "The author's association, such as NONE or OWNER." }, repo: { type: "string", placeholder: "<owner/repo>", description: "The store, to read the triage actor." }, pr: { type: "string", placeholder: "<number>", description: "The pull request number." } }, exit: (r) => exitFor(r.ok !== false) }, runValidatePrCommand),
      command("proof", { summary: "Mark an existing local session as a controlled proof.", args: [{ name: "session", required: true, description: "The session id." }], flags: { desk: { type: "string", placeholder: "<absolute desk root>", description: "The desk the session belongs to." } }, exit: (r) => exitFor(["marked", "already_proof"].includes(r.result)) }, runProofCommand),
    ],
  })
}

/** Dispatches `argv[0]` to its subcommand and writes the JSON result with `write`. Returns the process exit code. */
export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), git = runGit, runner = undefined, write = (text) => process.stdout.write(text), logError = (text) => process.stderr.write(text) } = {}) {
  // A failure from the code underneath is already a whole line of its own; the kit's tool-name prefix would say it twice.
  return runCli(factoryCli({ env, cwd, git, runner }), argv, { stdout: { write }, stderr: { write: logError } })
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
