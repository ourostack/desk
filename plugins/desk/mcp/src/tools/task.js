// Runtime CRUD tools for `task.md` cards — task_create, task_update, task_archive.
//
// Each export is invoked from server.js with a parsed { deskRoot, input }
// pair. The implementation owns the on-disk layout under
// `<root>/<track>/<slug>/task.md` and obeys the schema documented in
// `plugins/desk/skills/task-card-format/SKILL.md` (schema_version 1).
//
// On a Git desk, each tool stages exactly what it wrote and then commits
// exactly those paths, synchronously in the tool call (M4-6 Part 2); pushing
// is a later part. A commit failure never loses the write — it comes back as
// `commit: { status: "failed", reason }` on the result, omitted entirely on
// a normal, silent success or on a non-Git desk.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import {
  nowIso,
  readMarkdown,
  writeMarkdown,
  patchMarkdownFrontmatter,
  pathExists,
} from "../util/fm.js"
import { readRecord, toFrontmatter, move, needsReturnReason, parseReturn, RETURN_REASONS, STATUSES } from "../factory/outcome.js"
import { isPathContained, resolveWriteTarget, personPrefix } from "../util/paths.js"
import { isGitRepository, hasUnstagedWork, stagePaths, commitPaths } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { validateName, describeNameRejection } from "../desk/naming.js"
import { factoryStateRoot, requestEvaluation, requestFinalize } from "../factory/outbox.js"
import { jobId } from "../factory/binding.js"
import { readDeskRemote, resolveJobIdentity } from "../factory/desk-repo.js"
import { LIFECYCLE_STATES, TERMINAL_STATES, invalidStatusMessage } from "../desk/lifecycle.js"
import { objectInput } from "../util/object-input.js"
import { reportLink } from "./factory-context.js"
import { assertCodeRepoEvidence, recordedRepos } from "./done-evidence.js"
import { assertLocalOnlyUnchanged, withLocalOnlyRecorded } from "./local-only.js"
import { setTaskState } from "./track-row.js"
import { appendProgressNote, localDate, replaceNextStep } from "./task-body.js"
import { withCreatedDirs } from "../util/created-dirs.js"
import { blockerOf, nextStepOf } from "../desk/active-tasks.js"
import { saysElsewhere } from "../runtime/elsewhere-note.js"
import { redactCredentialLikeText } from "../util/redact.js"
import { focusNote } from "./task-focus.js"

// Said in the first lines of the response and in plain imperatives: an agent that has just made a change expects to publish it, and one that read only the tail of the response ran `git push` on the desk after this call.
// It is also about the card only: three Copilot boot-acceptance runs (rounds P, V and W) read "pushing it in the background" as their own project commit having been pushed and reported "commit 4c90a44 pushed to the branch" with no push of the project's code run. The harness reads the phrase "is pushing it in the background" (evals/boot-acceptance/claims.mjs), so it stays.
const DESK_COMMIT_NOTE = "Desk card only: Desk committed this card and is pushing it in the background, so run no git for it. Desk did not push your project's code; say code was pushed only if your own git push succeeded."

const TERMINAL_STATUSES = new Set(TERMINAL_STATES)
const DONE_EVIDENCE_KINDS = new Set(["pr", "commit", "ci_run", "non_code"])
const DONE_EVIDENCE_EXAMPLE = '{"kind": "pr", "ref": "https://github.com/org/repo/pull/123"}'
const DONE_EVIDENCE_USAGE =
  "`evidence.kind` is one of pr, commit, ci_run, non_code; `evidence.ref` is a reference in that " +
  "kind's own checkable shape -- a PR URL for pr, a commit sha or commit URL for commit, an " +
  "https URL for ci_run, or an https URL or desk-relative path for non_code."

// Per-kind ref shape, checkable without a network call (2026-09-29 review of
// #106): a reviewer pointed out that an unconstrained `ref` string let
// "trust me" pass as evidence so long as it was non-blank. Each kind's
// `test` only checks shape -- it cannot and does not confirm the PR, commit
// or CI run actually exists -- but a shape that cannot possibly be a real
// reference (no scheme, no hex, no URL at all) is refused up front rather
// than recorded as if it proved something.
const PR_REF = /^https:\/\/\S+\/pull(?:request)?\/\d+(?:[/?#]\S*)?$/iu
const COMMIT_SHA_REF = /^[0-9a-f]{7,40}(?![0-9a-f])/iu
const COMMIT_URL_REF = /^https:\/\/\S+\/commit\/[0-9a-f]{7,40}(?:[/?#]\S*)?$/iu
const HTTPS_URL_REF = /^https:\/\/\S+$/iu

// A ref that names a file inside the desk instead of a URL: no scheme, no
// leading `/` or `~` (both machine-specific, see task-card-format's "Local
// path portability"), no Windows drive letter, and no whitespace (a real
// desk path is a kebab-case-segmented relative path, never free prose).
// Format alone still let free text like "done" or "trustme" through, so
// (2026-09-29 controller check of a363c057) the tool -- which has the desk
// root in hand -- also resolves the ref against it and requires that it
// land on an existing file or directory *inside* the desk, rejecting any
// `..` segment that would walk the reference back out of it.
async function isDeskRelativeProofPath(ref, deskRoot) {
  if (/\s/u.test(ref)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(ref)) return false
  if (ref.startsWith("/") || ref.startsWith("~")) return false
  if (/^[a-zA-Z]:[\\/]/u.test(ref)) return false
  const candidate = path.resolve(deskRoot, ref)
  if (!isPathContained(deskRoot, candidate)) return false
  return pathExists(candidate)
}

const DONE_EVIDENCE_REF_CHECKS = {
  pr: {
    test: (ref) => PR_REF.test(ref),
    shape: 'a PR URL, such as "https://github.com/org/repo/pull/123" or an Azure DevOps ".../pullrequest/123" URL',
  },
  commit: {
    test: (ref) => COMMIT_SHA_REF.test(ref) || COMMIT_URL_REF.test(ref),
    shape: 'a 7-40 character hex commit sha, optionally followed by its repo/branch (such as "a1b2c3d on origin/main"), or a commit URL such as "https://github.com/org/repo/commit/a1b2c3d"',
  },
  ci_run: {
    test: (ref) => HTTPS_URL_REF.test(ref),
    shape: "the CI run's own https URL",
  },
  non_code: {
    test: async (ref, deskRoot) => HTTPS_URL_REF.test(ref) || (await isDeskRelativeProofPath(ref, deskRoot)),
    shape:
      "an https URL to the proof, or a desk-relative path to it (not an absolute path, and not free-text with no link) " +
      "that resolves to a file or directory actually present inside the desk -- not a path that escapes it via \"..\", " +
      "and not one that names nothing there",
  },
}

// A move to `done` needs at least one verifiable reference backing the
// completion claim (the invented-completion finding, 2026-09-29): an
// acceptance run told to resume a task instead edited the card directly
// with the host's own Edit tool -- bypassing this function entirely --
// set `status: done` and wrote a "Completed work" section claiming tests
// passed and a branch merged, none of which had happened. `task_update`
// and `task_archive` (when archiving a non-terminal task as completed
// rather than abandoned) are the only tools that can carry a task to
// `done`, so they are the only places this is enforced -- `toolName`
// names whichever one is calling, for the error message. The direct-edit
// bypass that run took is separately caught by the task-status-guard hook
// (../runtime/task-status-guard.js), which points an agent back here.
//
// Only called on the transition into `done`: each caller already guards
// this behind its own "moving from a non-`done` status" check, so
// re-saving an already-`done` card, and moving to any other status
// (including `cancelled`, which makes no completion claim to back), never
// reach this function at all.
//
// A card that records `repos:` names code, so only code evidence finishes it: see `./done-evidence.js` (a PR URL in one
// of those repos, or a pushed commit that resolves in a recorded clone; never `non_code`, `ci_run` or a desk commit).
// `card` carries what the check needs of the task itself: its recorded `repos`, the card file(s) the task lives in
// (a `non_code` ref may not be the card, which any agent can write to say anything) and the git seams.
async function assertDoneEvidence(evidence, deskRoot, toolName, card) {
  if (evidence === undefined) {
    throw new Error(
      `${toolName}: moving a task to \`done\` needs evidence -- pass \`evidence: { kind, ref }\`. ` +
        `${DONE_EVIDENCE_USAGE} Example: ${DONE_EVIDENCE_EXAMPLE}.`,
    )
  }
  const kindOk = DONE_EVIDENCE_KINDS.has(evidence.kind)
  const refPresent = typeof evidence.ref === "string" && evidence.ref.trim().length > 0
  if (!kindOk || !refPresent) {
    throw new Error(
      `${toolName}: \`evidence\` is not valid (got ${JSON.stringify(evidence)}) -- ${DONE_EVIDENCE_USAGE} ` +
        `Example: ${DONE_EVIDENCE_EXAMPLE}.`,
    )
  }
  const check = DONE_EVIDENCE_REF_CHECKS[evidence.kind]
  if (!(await check.test(evidence.ref.trim(), deskRoot))) {
    throw new Error(
      `${toolName}: \`evidence.ref\` is not a checkable ${evidence.kind} reference (got ${JSON.stringify(evidence.ref)}) -- ` +
        `for kind "${evidence.kind}", \`ref\` must be ${check.shape}.`,
    )
  }
  const repos = recordedRepos(card.repos)
  if (evidence.kind === "non_code" && repos.length === 0) {
    const target = path.resolve(deskRoot, evidence.ref.trim())
    if (card.files.some((file) => path.resolve(file) === target)) {
      throw new Error(
        `${toolName}: \`evidence.ref\` ${JSON.stringify(evidence.ref)} is the task card itself, which proves nothing: the card is what the evidence backs. ` +
          "For kind \"non_code\", point at a separate proof (a file or folder in the desk that holds the outcome, or an https URL to it).",
      )
    }
  }
  assertCodeRepoEvidence({ toolName, evidence, repos, deskRoot, spawnGit: card.spawnGit, homeDir: card.homeDir, existingRepos: card.existingRepos, created: card.created })
}

/**
 * The task's job identity as binding computes it: the desk's real path, its
 * remote (else `local:<path>`), the person prefix and the task's birth
 * track/slug (`resolveJobIdentity`, ourostack/desk#76) — the same one
 * `jobId` was hashed over, so a caller building a link or a request from
 * this task uses that birth track/slug too, not the one it was asked about.
 */
async function taskJob({ deskRoot, person, track, slug }) {
  const root = await fs.realpath(deskRoot)
  const prefix = path.relative(deskRoot, personPrefix(deskRoot, person)).split(path.sep).join("/")
  const deskRemote = readDeskRemote({ deskRoot: root }) || `local:${root}`
  const birth = resolveJobIdentity({ deskRoot: root, personPrefix: prefix, track, slug })
  return { root, prefix, deskRemote, track: birth.track, slug: birth.slug, job: jobId({ deskRemote, personPrefix: prefix, track: birth.track, slug: birth.slug }) }
}

async function requestTaskFinalize({ deskRoot, env, identity }) {
  try {
    if (await factoryStateRoot(env, { create: false, deskRoot }) === null) return
    await requestFinalize(env, { job: identity.job, deskRoot: identity.root })
  } catch {
    console.error("desk_factory: finalize_request_deferred")
  }
}

// The job identity, or `null` when it cannot be resolved: both finalize requests then fail the same way reading `identity.job`, and each logs its own deferred message.
async function taskJobOrNull(args) {
  try {
    return await taskJob(args)
  } catch {
    return null
  }
}

// The finalize request after a recorded return; `finalize` is injected in tests.
const requestTaskReturnSync = async ({ deskRoot, person, track, slug, env, finalize }) => finalize({ deskRoot, env, identity: await taskJobOrNull({ deskRoot, person, track, slug }) })

// Records the job's waste-evaluator request (`evaluate-requests/<job>.json`),
// like a finalize request: same opt-in gate (no factory state yet => no-op,
// and never creates it just to check), and any failure is swallowed so it
// can never block or reopen the task. `done` never waits for it, and briefs
// are prepared later, off this path, by the session-start hook's
// `evaluate --pending` (`evaluatePending` in factory/evaluate-run.js).
async function requestTaskEvaluation({ deskRoot, env, identity }) {
  try {
    if (await factoryStateRoot(env, { create: false, deskRoot }) === null) return
    await requestEvaluation(env, { job: identity.job, deskRoot: identity.root })
  } catch {
    console.error("desk_factory: evaluation_request_deferred")
  }
}

// The terminal-status sync a Desk task tool runs alongside the status write:
// a finalize request for every terminal status (`done`/`cancelled`, matching
// `requestFinalize`'s own contract), and, on either terminal status, an
// evaluation request too — `docs/factory-local-capture.md` treats `done` and
// `cancelled` alike as a finished job, and the waste in a cancelled job is
// exactly what the waste evaluator needs to see. The job identity is
// resolved once here (it never differs between the two calls) and handed to
// both; if resolving it throws, both calls still degrade the same way each
// would have on its own, so both deferred messages are logged below.
async function requestTaskTerminalSync({ deskRoot, person, track, slug, env, status }) {
  const identity = await taskJobOrNull({ deskRoot, person, track, slug })
  await requestTaskFinalize({ deskRoot, env, identity })
  if (TERMINAL_STATUSES.has(status)) await requestTaskEvaluation({ deskRoot, env, identity })
}

// The task's factory report answer, `{ link }` or `{ link: null, reason? }` (`local-status.js` `factoryReportLink`): asked on the
// transition to `done`, and on any later update of a card that records why it has no link. A link is deterministic, so done never waits
// for delivery, and nothing here can fail the task operation: a job identity that cannot be read is the reason `job_identity_unavailable`.
async function factoryReportFor({ deskRoot, person, track, slug, env }) {
  try {
    const { root, prefix, deskRemote, track: birthTrack, slug: birthSlug } = await taskJob({ deskRoot, person, track, slug })
    return reportLink({ env, deskRoot: root, deskRemote, personPrefix: prefix, track: birthTrack, slug: birthSlug })
  } catch {
    return { link: null, reason: "job_identity_unavailable" }
  }
}

// The card fields one report answer sets: `factory_report` (the link) or `factory_report_unavailable` (the reason code, and nothing else),
// each `undefined` (removed from the card) when the answer does not carry it, so an older link or reason never outlives a newer answer.
// Without consent the factory is not in use for the desk, and both are removed.
function reportFields(report) {
  return { factory_report: report.link ?? undefined, factory_report_unavailable: report.link === null ? report.reason : undefined }
}

// What a tool result says about the report answer: the reason a card has no link, always, and the link itself when this call filled it
// in on a card that already was done (`filled`); a new delivery's link is on the card, as before.
function reportResult(report, filled) {
  if (report === null) return {}
  if (report.link !== null) return filled ? { factory_report: report.link } : {}
  return report.reason === undefined ? {} : { factory_report_unavailable: report.reason }
}

// Optional runtime fields the operator (or harness) may pass at create time.
// Kept explicit so we don't silently accept arbitrary keys.
const OPTIONAL_RUNTIME_FIELDS = [
  "category",
  "cadence",
  "scheduledAt",
  "requester",
  "validator",
  "artifacts",
  "active_bridge",
  "bridge_sessions",
  "planning_complete",
  "adopted_at",
  "repos",
  "iterations",
  "predecessor",
  "initiated_by",
  "origin_note",
]

// Every field task_create/task_update/task_archive read off `input`, kept
// next to each handler so a field added to its destructuring or to
// OPTIONAL_RUNTIME_FIELDS is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks these against the tool's
// declared schema in tool-schemas.js.
export const TASK_CREATE_FIELDS = ["track", "slug", "title", "status", "body", "focus", ...OPTIONAL_RUNTIME_FIELDS]
export const TASK_UPDATE_FIELDS = ["track", "slug", "status", "frontmatter", "body_append", "note", "next_step", "evidence", "repos_removed_reason", "return_reason"]
export const TASK_ARCHIVE_FIELDS = ["track", "slug", "evidence", "outcome"]

// The three outcome records are written only by the task tools; a caller never supplies them.
const RECORD_KEYS = ["signoff", "flow", "returns", "returns_damaged"]
const RECORD_REFUSAL = "these records are written by the task tools; to record an answer call task_signoff"

// The report link fields are the task tools' answer about the factory report, never the caller's: a hand-set link could name any job on a
// public desk's card, and a hand-set reason would not be a reason code.
const REPORT_KEYS = ["factory_report", "factory_report_unavailable"]
const REPORT_REFUSAL = "`factory_report` and `factory_report_unavailable` are written by the task tools: the move to done writes the link or the reason it has none, and a later update fills a missing link by itself"

function refuseRecordKeys(tool, ...sources) {
  for (const source of sources) {
    if (source == null) continue
    if (RECORD_KEYS.some((key) => Object.hasOwn(source, key))) throw new Error(`${tool}: ${RECORD_REFUSAL}`)
    if (REPORT_KEYS.some((key) => Object.hasOwn(source, key))) throw new Error(`${tool}: ${REPORT_REFUSAL}`)
  }
}

// Where the record follows a status change on an existing card. The caller writes the returned keys, which are empty when nothing in the record changes (`move` returns its input then). A card whose status is missing or off the list is read as moving from `drafting`.
const movingFrom = (data) => (STATUSES.includes(data.status) ? data.status : (readRecord(data).flow?.reached ?? "drafting"))
function applyMove(data, { to, at, returnReason }) {
  const record = readRecord(data)
  const moved = move(record, { from: movingFrom(data), to, at, returnReason })
  return moved === record ? {} : toFrontmatter(moved)
}

// The reason a status change gives for going backwards, checked before anything is written: the reason when this change is a return, `undefined` when it is not. A refusal says what to do next, in words an agent can act on.
const REASON_LIST = "agent_error (you got it wrong), changed_ask (the operator changed what they want), new_information (something nobody knew), external (something outside the task broke)"
function checkReturnReason(data, { to, returnReason }) {
  const from = movingFrom(data)
  const needs = needsReturnReason({ from, to, reached: readRecord(data).flow?.reached })
  const given = returnReason !== undefined && returnReason !== null
  if (given && !needs) throw new Error("task_update: `return_reason` is only for moving a task back; this call is not a return, so drop it.")
  if (needs && !given) throw new Error(`task_update: moving this task from ${from} back to ${to} is a return and needs a reason. Repeat the call with \`return_reason\` set to one of ${REASON_LIST}.`)
  if (needs && !RETURN_REASONS.includes(returnReason)) throw new Error(`task_update: \`return_reason\` must be one of ${RETURN_REASONS.join(", ")}.`)
  return needs ? returnReason : undefined
}

// The first non-blank line of the title, trimmed and cut to 120 characters, so the packet stays three one-line strings.
const TITLE_LIMIT = 120
function packetTitle(data, slug) {
  const first = typeof data.title === "string" ? data.title.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "") : undefined
  return first === undefined ? slug : first.slice(0, TITLE_LIMIT).trimEnd()
}

// What the answer says after a delivery: the state, three lines for the agent to adapt, and one note.
const SIGNOFF_NOTE =
  "This task is delivered, not accepted. If the operator is in this conversation, end your reply with the three lines; do not wait for the answer and do not ask again in this session. When they answer, call task_signoff in that later turn. A subagent never calls task_signoff."
function deliveryAnswer({ data, slug, ref }) {
  return {
    signoff: "delivered_unsigned",
    signoff_packet: [`Asked: ${packetTitle(data, slug)}`, `Delivered: ${ref}`, "Accept or send back?"],
    signoff_note: SIGNOFF_NOTE,
  }
}

const asList = (value) => (Array.isArray(value) ? value : [])

function relPath(deskRoot, absPath) {
  return path.relative(deskRoot, absPath)
}

// On a Git desk, a task tool stages the task.md it writes (M4-5 fix round 4)
// only when the file held no unstaged changes before this write, so a
// dirty/untracked card left by another session is never adopted as this
// tool's own work. `spawnGit` is a test-only seam over `spawnSync`.
function stagingAllowed(filePath, spawnGit) {
  const dir = path.dirname(filePath)
  return isGitRepository(dir, spawnGit) && !hasUnstagedWork(dir, [path.basename(filePath)], spawnGit)
}

// After staging, commits exactly the one file staged (M4-6 Part 2: every
// write tool commits its own paths synchronously; push is a later part).
// A stage failure (e.g. a concurrent call holding .git/index.lock) leaves
// nothing to commit, and neither it nor a commit failure ever throws away
// the write or the tool's own result — either comes back as this function's
// return value, which a caller attaches to its result under `commit` only
// on failure, so a normal, silent success stays byte-identical to today's
// response shape.
function stageAndCommitCard(filePath, message, spawnGit, alsoRelative = []) {
  const dir = path.dirname(filePath)
  const paths = [path.basename(filePath), ...alsoRelative]
  const staged = stagePaths(dir, paths, spawnGit)
  if (!staged.ok) return { status: "failed", reason: staged.stderr }
  const committed = commitPaths(dir, paths, message, spawnGit)
  return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
}

// The next step as `report_as` shows it: credential-like text redacted (the card's text is the agent's own, and the sentence
// is meant to be repeated to the operator), and cut at a word once it passes the cap, pointing at the card for the rest.
const REPORT_STEP_CAP = 300
function reportStep(step) {
  if (step === null) return "no next step recorded"
  const text = redactCredentialLikeText(step)
  if (text.length <= REPORT_STEP_CAP) return text
  const cut = text.slice(0, REPORT_STEP_CAP)
  const space = cut.lastIndexOf(" ")
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()} ... (see card)`
}

// The short sha of the desk's HEAD after a card commit, or null when git cannot say.
function headSha(dir, spawnGit) {
  const answer = spawnGit("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 5000 })
  return answer?.status === 0 && typeof answer.stdout === "string" && answer.stdout.trim() !== "" ? answer.stdout.trim() : null
}

// task_archive moves a folder with a plain `fs.rename`, never `git mv` (see
// task_archive's own doc comment) — but a bare `git add -- <old> <new>`
// still stages the move as a rename (Git detects it from the deletion at
// `<old>` plus the addition at `<new>`; no `-A` needed since both paths are
// named explicitly), so the same stage-then-commit shape as every other
// write tool applies here too (M4-6 Part 2). `root` is the effective
// (person-scoped) desk root; `paths` are absolute.
function stageAndCommitMove(root, paths, message, spawnGit) {
  if (!isGitRepository(root, spawnGit)) return undefined
  const relPaths = paths.map((p) => path.relative(root, p))
  const staged = stagePaths(root, relPaths, spawnGit)
  if (!staged.ok) return { status: "failed", reason: staged.stderr }
  const committed = commitPaths(root, relPaths, message, spawnGit)
  return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
}

async function assertArchiveSourceIsRelocationSafe({
  srcDir,
  srcFile,
  archiveDir,
}) {
  if ((await fs.lstat(srcDir)).isSymbolicLink()) {
    throw new Error(`task_archive: source directory symlink cannot be archived safely: ${srcDir}`)
  }
  if (!(await pathExists(srcFile))) return

  const fileStat = await fs.lstat(srcFile)
  if (!fileStat.isSymbolicLink()) return

  const realSrcDir = await fs.realpath(srcDir)
  const realArchiveDir = await prospectiveArchiveDir(archiveDir)
  if (isPathContained(realSrcDir, realArchiveDir)) {
    throw new Error(`task_archive: archive destination cannot be inside source directory: ${archiveDir}`)
  }

  const sourceReferent = await fs.realpath(srcFile)
  const expectedReferent = isPathContained(realSrcDir, sourceReferent)
    ? path.join(realArchiveDir, path.relative(realSrcDir, sourceReferent))
    : sourceReferent
  const relocatedReferent = await realpathAfterArchive(
    path.join(realArchiveDir, path.basename(srcFile)),
    { realSrcDir, realArchiveDir },
  )
  if (relocatedReferent !== expectedReferent) {
    throw new Error(`task_archive: task.md symlink would change referent when archived: ${srcFile}`)
  }
}

async function prospectiveArchiveDir(archiveDir) {
  const archiveParent = path.dirname(archiveDir)
  const realArchiveParent = await pathExists(archiveParent)
    ? await fs.realpath(archiveParent)
    : path.join(
        await fs.realpath(path.dirname(archiveParent)),
        path.basename(archiveParent),
      )
  return path.join(realArchiveParent, path.basename(archiveDir))
}

async function realpathAfterArchive(candidate, { realSrcDir, realArchiveDir }) {
  let { root, segments } = splitAbsolutePath(candidate)
  let resolved = root
  let followedLinks = 0

  while (segments.length > 0) {
    const virtualPath = path.join(resolved, segments.shift())
    const inspectionPath = pathBeforeArchive(virtualPath, {
      realSrcDir,
      realArchiveDir,
    })
    if (inspectionPath === null) return null

    let stat
    try {
      stat = await fs.lstat(inspectionPath)
    } catch (error) {
      if (
        error?.code === "ENOENT" &&
        isPathContained(virtualPath, realArchiveDir)
      ) {
        resolved = virtualPath
        continue
      }
      const unavailableAfterMove = ["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)
      /* istanbul ignore next -- defensive: lstat during archive-move symlink
       * resolution only fails with ENOENT/ENOTDIR/ELOOP in practice; any
       * other error must still propagate rather than being swallowed, but
       * that path isn't reachable from a portable test fixture. */
      if (!unavailableAfterMove) {
        throw error
      }
      return null
    }

    if (!stat.isSymbolicLink()) {
      resolved = virtualPath
      continue
    }
    followedLinks += 1
    if (followedLinks > 40) return null

    const linkTarget = await fs.readlink(inspectionPath)
    const nextPath = path.resolve(
      path.dirname(virtualPath),
      linkTarget,
      ...segments,
    )
    const splitPath = splitAbsolutePath(nextPath)
    root = splitPath.root
    segments = splitPath.segments
    resolved = root
  }

  return resolved
}

function pathBeforeArchive(candidate, { realSrcDir, realArchiveDir }) {
  if (isPathContained(realArchiveDir, candidate)) {
    return path.join(realSrcDir, path.relative(realArchiveDir, candidate))
  }
  if (isPathContained(realSrcDir, candidate)) return null
  return candidate
}

function splitAbsolutePath(candidate) {
  const resolved = path.resolve(candidate)
  const root = path.parse(resolved).root
  return {
    root,
    segments: resolved.slice(root.length).split(path.sep).filter(Boolean),
  }
}

/**
 * task_create
 *
 * Input:
 *   {
 *     track: string,            // required — a path segment; not itself
 *                               // name-validated (that's track_create's job)
 *     slug: string,             // required — validated, see Errors
 *     title: string,            // required
 *     status?: string,          // default "drafting"
 *     body?: string,            // markdown body (no frontmatter)
 *     ...optional runtime fields per task-card schema
 *   }
 *
 * Side effects: creates `<root>/<track>/<slug>/task.md` (and parent dirs),
 * and stages + commits it on a Git desk (M4-6 Part 2).
 *
 * Errors:
 *   - refuses if the target task.md already exists.
 *   - refuses `slug` that isn't a valid outcome name per `validateName` (see
 *     `desk/naming.js`): wrong shape, too long, prompt-like, or
 *     credential-like.
 *
 * On a Git desk, commits exactly the file it wrote right after staging it. A
 * commit failure never loses the write: it comes back as `commit: { status:
 * "failed", reason }` on the result, omitted entirely on a normal, silent
 * success or on a non-Git desk.
 *
 * Returns: { status: "created", path: "<track>/<slug>/task.md", commit? }
 */
export async function task_create({ deskRoot, input, person = null, readiness, statusContext = {}, env = process.env, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  const { track, slug, title } = values
  if (!Object.hasOwn(values, "track")) {
    throw new Error("task_create: `track` is required (string)")
  }
  if (!Object.hasOwn(values, "slug")) {
    throw new Error("task_create: `slug` is required (string)")
  }
  if (!title || typeof title !== "string") {
    throw new Error("task_create: `title` is required (string)")
  }

  if (values.status != null && !LIFECYCLE_STATES.includes(values.status)) {
    throw new Error(`task_create: ${invalidStatusMessage(values.status)}`)
  }
  if (values.focus !== undefined && typeof values.focus !== "boolean") {
    throw new Error("task_create: `focus` must be true or false")
  }
  refuseRecordKeys("task_create", values, values.frontmatter)

  const filePath = await resolveWriteTarget({
    deskRoot,
    person,
    segments: [track, slug, "task.md"],
  })

  // Path/segment/alias safety (above) is a tool-misuse concern and takes
  // precedence over naming content rules, which are business rules
  // evaluated once the target path itself is known-safe.
  const nameResult = validateName(slug)
  if (!nameResult.ok) {
    throw new Error(
      `task_create: invalid slug: ${describeNameRejection(nameResult)}`,
    )
  }
  if (await pathExists(filePath)) {
    throw new Error(
      `task_create: task already exists at ${relPath(deskRoot, filePath)}`,
    )
  }
  // A delivered task sits in the archive under its own slug; creating over it would start the job again with a clean record.
  if (await pathExists(await resolveWriteTarget({ deskRoot, person, segments: [track, "_archive", slug] }))) {
    throw new Error(`task_create: ${track}/${slug} already exists in the archive. To work on it again, bring it back with task_move (unarchive: true), then task_update with return_reason. To start different work, choose another slug.`)
  }

  const ts = nowIso()
  const data = {
    schema_version: 1,
    title,
    status: values.status ?? "drafting",
    created: ts,
    updated: ts,
    track,
  }
  for (const k of OPTIONAL_RUNTIME_FIELDS) {
    if (values[k] !== undefined) data[k] = values[k]
  }
  // A card starts its flow record here, then moves from drafting to its first status through the same `move` every later change uses, so a card born at `validating` has its first review point and one born `done` is delivered at once, unsigned (it carries no evidence).
  const startedFlow = {
    since: "created",
    rev: 0,
    reached: "drafting",
    first_validating_at: null,
    first_delivered_at: null,
    delivered_at: null,
    deliveries: 0,
  }
  Object.assign(data, toFrontmatter(move(readRecord({ flow: startedFlow }), { from: "drafting", to: data.status, at: ts })))
  // Desk records which repos are local-only (a clone with no remote and no `url`), here and when boot first sees one; a
  // `local_only` the caller wrote is dropped (see `local-only.js`).
  if (data.repos !== undefined) data.repos = withLocalOnlyRecorded(data.repos, { spawnGit, homeDir: env.HOME, deskRoot })

  await writeMarkdown(filePath, data, values.body ?? "")
  let commit
  if (isGitRepository(path.dirname(filePath), spawnGit)) {
    commit = stageAndCommitCard(filePath, `task_create: ${track}/${slug}`, spawnGit)
    if (!commit) schedulePush({ root: deskRoot })
  }
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  const result = { status: "created", path: relPath(deskRoot, filePath) }
  if (commit) result.commit = commit
  if (data.status === "done") {
    result.signoff = "delivered_unsigned"
    result.signoff_note = "This task was created already done, with no evidence, so there is nothing to show the operator; it stays unsigned. Create a task at drafting and finish it with evidence instead."
  }
  // The focus moves only once the card exists: a create that threw above never reaches this line. A create without
  // `focus` (a parked follow-up) leaves the focus alone and, with nothing focused, carries the no-focus hint.
  if (values.focus === true && statusContext.focus) {
    statusContext.focus.set({ track, slug })
    result.focused = true
  } else if (values.focus !== true) {
    const note = focusNote(statusContext)
    if (note !== undefined) result.focus_note = note
  }
  return result
}

// Sets the task's `State` in the track card's Tasks table when the card has one in the documented format and no one has
// unstaged edits in it; returns the card's path when it wrote it, else null. A track card that is missing, unreadable,
// or has no such row is left alone.
async function updateTrackRow({ filePath, slug, status, spawnGit }) {
  const trackFile = path.join(path.dirname(path.dirname(filePath)), "track.md")
  try {
    if (isGitRepository(path.dirname(trackFile), spawnGit) && hasUnstagedWork(path.dirname(trackFile), ["track.md"], spawnGit)) return null
    const next = setTaskState(await fs.readFile(trackFile, "utf8"), slug, String(status))
    if (next === null) return null
    await fs.writeFile(trackFile, next, "utf8")
    return trackFile
  } catch {
    return null
  }
}

/**
 * task_update
 *
 * Input:
 *   {
 *     track: string,
 *     slug: string,
 *     frontmatter?: object,   // shallow-merged into existing frontmatter; a
 *                             // JSON-string object is parsed, anything else
 *                             // is refused before the card is touched
 *     body_append?: string,   // appended to existing body (blank line sep)
 *     evidence?: { kind, ref },  // required only when this call moves the
 *                             // task into `done` from a non-`done` status;
 *                             // see "Evidence gate on `done`" below
 *   }
 *
 * Side effects: rewrites `<root>/<track>/<slug>/task.md` in place, and on a
 * Git desk stages it when it held no unstaged changes before the write.
 *
 * Preserves: `schema_version`, `created`. Always refreshes `updated` to now.
 *
 * Errors: refuses if the task doesn't exist.
 *
 * Evidence gate on `done` (the invented-completion finding): a call whose
 * merged `status` becomes `done` from a different previous status must
 * carry `evidence: { kind, ref }`, `kind` one of `pr`, `commit`, `ci_run`,
 * `non_code`, `ref` a checkable reference in that kind's own shape (a PR
 * URL, a commit sha or commit URL, the CI run's URL, or an https URL or
 * desk-relative path to a non-code proof). Refused with an error that says
 * what to supply, before the card is touched, when `evidence` is missing,
 * malformed, or shaped wrong for its kind. The tool then writes it onto
 * the card as `evidence: { kind, ref, recorded_at }`, alongside
 * `factory_report`. Re-saving an already-`done` card, and every transition
 * to a status other than `done` (including `cancelled`), needs none of
 * this. `task_archive`'s own bump of a non-terminal task to `done` on
 * archive requires the same `evidence` (see its own doc comment) -- it is
 * not a separate, unaffected path.
 *
 * On a Git desk, also commits exactly the file it staged (M4-6 Part 2). A
 * commit failure never loses the write: it comes back as `commit: { status:
 * "failed", reason }` on the result, omitted entirely on a normal, silent
 * success, when the file was already dirty, or on a non-Git desk.
 *
 * Returns: { status: "updated", path, commit?, next_step?, next_step_note?, report_as?, report_note?, desk_commit?, desk_pushed?, desk_note?, factory_report?, factory_report_unavailable? } (`factory_report_unavailable` is the reason code a card that reached done has no report link, and `factory_report` the link when this call filled it in on such a card; when Desk committed the card, `desk_note` is the second field, right after `status`: it says no git is needed and not to add, commit or push the card; `desk_commit` is the short sha of that commit, `desk_pushed` false because the push is scheduled, not yet done; `next_step` and
 * `next_step_note` when the call added a note or changed the status without passing `next_step`: the card's current next
 * step, or null, and a reminder; `report_as` and `report_note` whenever the status is not terminal: the sentence to
 * report the task with, and a line against calling it done)
 */
// `note` and `next_step` are checked before any write: an empty one would record progress that says nothing.
function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`task_update: \`${field}\` must be a non-empty string`)
  }
  return value
}

// Desk reads a card's next step and blocker from its body, so a frontmatter key that says either would be written and never read. Keys are matched loosely (case, spaces, hyphens and underscores do not count): the next step takes the same path as top-level `next_step`, and a blocker, which has no field that writes it, is refused.
const looseKey = (key) => key.toLowerCase().replace(/[\s_-]/gu, "")
const NEXT_STEP_KEYS = new Set(["nextstep", "nextsteps", "next", "nextaction"])
const BLOCKER_KEYS = new Set(["blocker", "blockers", "blocked", "blockedby", "blockedon", "waitingon"])
const LOOKS_BODY_READ = /^(?:next|block|wait)/u

function refuseBodyOnlyKeys(frontmatter) {
  const key = frontmatter == null ? undefined : Object.keys(frontmatter).find((name) => BLOCKER_KEYS.has(looseKey(name)))
  if (key !== undefined) {
    throw new Error(`task_update: \`frontmatter.${key}\` is not read: Desk takes a card's blocker from its body (a \`## Blocker\` section or a \`Blocker:\` line), so nothing was changed. Say the blocker with \`body_append\`, or in \`note\`.`)
  }
}

export async function task_update({ deskRoot, input, person = null, readiness, statusContext = {}, env = process.env, spawnGit = spawnSync, schedulePush = schedulePushDefault, finalize = requestTaskFinalize }) {
  const values = input ?? {}
  // A field this tool does not read would otherwise be dropped in silence, and the agent would believe the card changed.
  const unknown = Object.keys(values).filter((key) => !TASK_UPDATE_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `task_update: unknown field${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `\`${key}\``).join(", ")}; nothing was changed. Accepted fields: ${TASK_UPDATE_FIELDS.map((key) => `\`${key}\``).join(", ")}. Other card fields go inside \`frontmatter\`. Example: {"track": "t", "slug": "s", "status": "validating", "note": "what happened"}.`,
    )
  }
  const { track, slug, body_append } = values
  if (
    !Object.hasOwn(values, "track") ||
    !Object.hasOwn(values, "slug")
  ) {
    throw new Error("task_update: `track` and `slug` are required")
  }
  // Checked before anything is read or written: a string spread into the
  // card would write one key per character.
  const givenFrontmatter = objectInput(values.frontmatter, { tool: "task_update", field: "frontmatter" })
  // Top-level `status` is an alias for `frontmatter.status`, the field an agent reaches for first.
  if (values.status !== undefined && givenFrontmatter != null && Object.hasOwn(givenFrontmatter, "status") && givenFrontmatter.status !== values.status) {
    throw new Error("task_update: `status` and `frontmatter.status` disagree; pass the status once, as `status`")
  }
  const statusMerged = values.status === undefined ? givenFrontmatter : { ...(givenFrontmatter ?? {}), status: values.status }
  // Desk reads a card's next step and blocker from its body, so a frontmatter key of that name would be written and never read. The next step takes the same path as top-level `next_step`; a blocker has no field, so it is refused.
  refuseBodyOnlyKeys(statusMerged)
  const aliasKeys = statusMerged == null ? [] : Object.keys(statusMerged).filter((key) => NEXT_STEP_KEYS.has(looseKey(key)))
  let frontmatter = statusMerged
  let nextStepValue = values.next_step
  let nextStepKey = "next_step"
  if (aliasKeys.length > 0) {
    frontmatter = { ...statusMerged }
    for (const key of aliasKeys) {
      const given = frontmatter[key]
      delete frontmatter[key]
      if (typeof given !== "string") throw new Error(`task_update: \`frontmatter.${key}\` must be a non-empty string; nothing was changed`)
      if (nextStepValue !== undefined && (typeof nextStepValue !== "string" || given.trim() !== nextStepValue.trim())) {
        throw new Error(`task_update: \`${nextStepKey}\` and \`frontmatter.${key}\` disagree; pass the next step once, as the top-level \`next_step\``)
      }
      if (nextStepValue === undefined) {
        nextStepValue = given
        nextStepKey = `frontmatter.${key}`
      }
    }
  }
  refuseRecordKeys("task_update", frontmatter)
  const nextStep = nextStepValue === undefined ? undefined : requiredText(nextStepValue, nextStepKey)
  const note = values.note === undefined ? undefined : requiredText(values.note, "note")
  const evidence = objectInput(values.evidence, {
    tool: "task_update",
    field: "evidence",
    effect: "the `done` transition was not recorded",
    example: DONE_EVIDENCE_EXAMPLE,
  })

  if (frontmatter != null && Object.hasOwn(frontmatter, "status") && !LIFECYCLE_STATES.includes(frontmatter.status)) {
    throw new Error(`task_update: ${invalidStatusMessage(frontmatter.status)} (set in \`status\` or \`frontmatter.status\`)`)
  }

  const filePath = await resolveWriteTarget({
    deskRoot,
    person,
    segments: [track, slug, "task.md"],
  })
  if (!(await pathExists(filePath))) {
    throw new Error(
      `task_update: task does not exist at ${relPath(deskRoot, filePath)}`,
    )
  }

  const existing = await readMarkdown(filePath)
  assertLocalOnlyUnchanged(frontmatter?.repos, existing.data.repos)
  const merged = { ...existing.data, ...(frontmatter ?? {}) }

  // Preserve immutable fields even if the caller passed them.
  if (existing.data.schema_version !== undefined) {
    merged.schema_version = existing.data.schema_version
  } else {
    merged.schema_version = 1
  }
  if (existing.data.created !== undefined) {
    merged.created = existing.data.created
  }
  merged.updated = nowIso()
  // The clone guard (`runtime/elsewhere-clone.js`) finds a card that says its work is on another machine through the repos the card names. Dropping or renaming one of them would switch the guard
  // off without the operator's word, so a call that does must also rewrite the next step so it no longer says the work is elsewhere (the operator's word, recorded as `next_step`).
  const blocker = blockerOf(existing.content)
  if (saysElsewhere({ next_step: nextStepOf(existing.content), blocker }) && saysElsewhere({ next_step: nextStep ?? nextStepOf(existing.content), blocker })) {
    const kept = new Set(asList(merged.repos).map((repo) => String(repo?.name ?? "").toLowerCase()))
    const lost = asList(existing.data.repos).map((repo) => String(repo?.name ?? "")).filter((name) => name !== "" && !kept.has(name.toLowerCase()))
    if (lost.length > 0) {
      throw new Error(`task_update: record the operator's word with \`next_step\`; \`repos\` cannot drop a repo from a card marked elsewhere. Dropped: ${lost.map((name) => `\`${name}\``).join(", ")}. Nothing was changed.`)
    }
  }
  // A card's code repos are what make `done` need code evidence, so one call cannot empty them and finish the task on
  // `non_code`. Emptying them is allowed when the call cancels the task, or says why (`repos_removed_reason`, recorded
  // on the card as `repos_removed`) and does not also finish the task: finishing is a separate call.
  const priorRepos = recordedRepos(existing.data.repos)
  if (priorRepos.length > 0 && recordedRepos(merged.repos).length === 0 && merged.status !== "cancelled") {
    const reason = typeof values.repos_removed_reason === "string" ? values.repos_removed_reason.trim() : ""
    if (reason === "") {
      throw new Error(
        "task_update: this call would remove every repo from a card that names code repos, which would let the task finish without code evidence. " +
          "If the work turned out not to touch them, repeat the call with `repos_removed_reason: \"<one line on why>\"` (it is recorded on the card as `repos_removed`), " +
          "and finish the task in a separate call afterwards; to abandon the task, set `status: \"cancelled\"` instead; if the repos were recorded wrongly, fix the entries instead of emptying the list. " +
          "See `task-lifecycle` and `task-card-format`.",
      )
    }
    if (merged.status === "done") {
      throw new Error(
        "task_update: a call that removes every repo cannot also set `status: \"done\"`. Remove the repos with `repos_removed_reason` in this call, then finish the task in a separate call with `non_code` evidence that is not the task card itself.",
      )
    }
    merged.repos_removed = [...asList(existing.data.repos_removed), ...priorRepos.map((repo) => ({ name: repo.name, reason, at: merged.updated }))]
  }
  // A backwards move without a reason is refused here, before anything is written or requested.
  const returnReason = checkReturnReason(existing.data, { to: merged.status, returnReason: values.return_reason })
  let delivered = null
  let report = null
  if (merged.status === "done" && existing.data.status !== "done") {
    await assertDoneEvidence(evidence, deskRoot, "task_update", {
      // The card's repos before this call, plus any this call adds: a card cannot shed its repos to dodge the check.
      repos: [...asList(existing.data.repos), ...asList(frontmatter.repos)],
      // Only these can earn the local-only exemption: repos added in this call never do (`done-evidence.js`).
      existingRepos: existing.data.repos, created: existing.data.created,
      files: [filePath], spawnGit, homeDir: env.HOME,
    })
    merged.evidence = { kind: evidence.kind, ref: evidence.ref, recorded_at: merged.updated }
    delivered = deliveryAnswer({ data: merged, slug, ref: merged.evidence.ref })
    report = await factoryReportFor({ deskRoot, person, track, slug, env })
  } else if (Object.hasOwn(existing.data, "factory_report_unavailable")) {
    // A card that reached done without a link is asked again on every later update, so a link that can now be named is filled in.
    report = await factoryReportFor({ deskRoot, person, track, slug, env })
  }
  if (report !== null) {
    for (const [key, value] of Object.entries(reportFields(report))) {
      if (value === undefined) delete merged[key]
      else merged[key] = value
    }
  }

  // Every status change keeps the card's record (`flow`, and `returns` when work went backwards), not only a move to done.
  if (merged.status !== existing.data.status) {
    const kept = applyMove(existing.data, { to: merged.status, at: merged.updated, returnReason })
    Object.assign(merged, kept)
    // A return from done leaves no current signoff: the card has one current delivery, and its history is in `returns`.
    if (kept.flow !== undefined && kept.signoff === undefined) delete merged.signoff
    // Nor its evidence: the proof of a delivery that was sent back no longer says the task is done. The next `done` records its own.
    if (existing.data.status === "done") delete merged.evidence
  }

  let newBody = existing.content
  if (nextStep !== undefined) newBody = replaceNextStep(newBody, nextStep)
  if (note !== undefined) newBody = appendProgressNote(newBody, note, localDate())
  if (typeof body_append === "string" && body_append.length > 0) {
    const sep = newBody.endsWith("\n\n") || newBody.length === 0 ? "" : "\n\n"
    newBody = `${newBody}${sep}${body_append}`
  }

  const stage = stagingAllowed(filePath, spawnGit)
  await writeMarkdown(filePath, merged, newBody)
  // A status change also moves the task's row in the track card's Tasks table (`track-row.js`), committed with the card.
  const trackRow = merged.status !== existing.data.status ? await updateTrackRow({ filePath, slug, status: merged.status, spawnGit }) : null
  const commit = stage ? stageAndCommitCard(filePath, `task_update: ${track}/${slug}`, spawnGit, trackRow === null ? [] : ["../track.md"]) : undefined
  if (stage && !commit) schedulePush({ root: deskRoot })
  const deskCommit = stage && !commit ? headSha(path.dirname(filePath), spawnGit) : null
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  if (TERMINAL_STATUSES.has(merged.status)) await requestTaskTerminalSync({ deskRoot, person, track, slug, env, status: merged.status })
  // A return asks the factory to re-derive the job's sessions, as a terminal move does; a return to a terminal status was asked for just above.
  else if (returnReason !== undefined) await requestTaskReturnSync({ deskRoot, person, track, slug, env, finalize })
  const result = { status: "updated", path: relPath(deskRoot, filePath) }
  if (commit) result.commit = commit
  if (delivered !== null) Object.assign(result, delivered)
  Object.assign(result, reportResult(report, delivered === null))
  if (returnReason !== undefined) {
    const line = parseReturn(merged.returns.at(-1))
    result.return_recorded = `${line.from} to ${line.to}, ${line.reason}, caught ${line.caught}`
  }
  // Said outright so no agent makes a redundant `git commit` of the card: Desk committed it, and its push is scheduled
  // in the background (so `desk_pushed` is false at this moment, not a failure).
  if (deskCommit !== null) {
    result.desk_commit = deskCommit
    result.desk_pushed = false
    result.desk_note = DESK_COMMIT_NOTE
  }
  // A note or a status change that leaves the next step alone is the common way a card ends up describing work that
  // is already done (a run finished the step, logged it, and reported "Done" over a card still pointing at it): show
  // the step the card still carries and say it was not touched. A terminal status leaves no next step to keep current.
  const terminal = TERMINAL_STATUSES.has(merged.status)
  const currentStep = nextStepOf(newBody)
  if (nextStep !== undefined) result.next_step = currentStep
  // Keys that look like a next step or a blocker but are neither alias nor refused: written as given, never read by Desk.
  const ignored = Object.keys(frontmatter ?? {}).filter((key) => LOOKS_BODY_READ.test(looseKey(key)))
  if (ignored.length > 0) result.ignored_frontmatter_keys = ignored
  if (nextStep === undefined && !terminal && (note !== undefined || merged.status !== existing.data.status)) {
    result.next_step = currentStep
    result.next_step_note = "next_step unchanged \u2014 update it if this work changed it"
  }
  // Agents rarely reread a skill when they reply, so the cue sits in the response they have just read: the sentence to
  // report an unfinished task with, and a line against calling it done (the reply opened "Done." over a validating card
  // in four acceptance rounds running).
  if (!terminal) {
    const status = typeof merged.status === "string" && merged.status !== "" ? merged.status : "no recorded status"
    result.report_as = `Task ${slug} is at ${status} (not done): ${reportStep(currentStep)}`
    result.report_note = `Do not tell the operator this task is done; it is at ${status}.`
  }
  const focus = focusNote(statusContext, { track, slug })
  if (focus !== undefined) result.focus_note = focus
  // The note is the second field, right after `status`, so it is read before the rest of the response (in boot round H a Copilot run ran `git push` on the desk after this response, with the note as the last of several fields).
  return deskCommit !== null ? { status: result.status, desk_note: result.desk_note, ...result } : result
}

// The already-archived card's status, read fail-safe: a missing file reads
// as no status (as before), and corrupted frontmatter (bad YAML from hand
// editing or a partial write) degrades the same way rather than throwing
// out of `task_archive` — the idempotent already-archived branch must keep
// returning `already_archived`, not break, on a card it doesn't control the
// shape of. A `null` status skips the evaluation request further down
// (`requestTaskTerminalSync` only requests one for a terminal status), but
// the finalize request still fires.
async function archivedTaskStatus(archivedFile) {
  if (!(await pathExists(archivedFile))) return null
  try {
    return (await readMarkdown(archivedFile)).data.status
  } catch {
    return null
  }
}

// A card already in `_archive/` that records why it has no report link (`factory_report_unavailable`) is asked again whenever task_archive is
// called for it, which is the one tool path that reaches an archived card; `factory reconcile` counts such cards (`report_link_unavailable`).
// Returns the result fields: the filled link or the current reason, `commit` when committing the card failed, and
// `factory_report_unchanged: true` when the answer is the one the card already records, so nothing was written or committed.
async function refillArchivedReport({ deskRoot, person, track, slug, env, archivedFile, readiness, spawnGit, schedulePush }) {
  let data
  try {
    data = (await readMarkdown(archivedFile)).data
  } catch {
    return {}
  }
  if (!Object.hasOwn(data, "factory_report_unavailable")) return {}
  const report = await factoryReportFor({ deskRoot, person, track, slug, env })
  const fields = reportFields(report)
  // The same answer the card already records changes nothing: no write and no commit (an empty commit would read as a failed one).
  if (Object.entries(fields).every(([key, value]) => data[key] === value)) return { ...reportResult(report, false), factory_report_unchanged: true }
  await patchMarkdownFrontmatter(archivedFile, fields)
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, archivedFile) }] })
  const root = path.resolve(personPrefix(deskRoot, person))
  const commit = stageAndCommitMove(root, [archivedFile], `task_archive: ${track}/${slug} report link`, spawnGit)
  if (commit === undefined && isGitRepository(root, spawnGit)) schedulePush({ root: deskRoot })
  return { ...reportResult(report, true), ...(commit === undefined ? {} : { commit }) }
}

// An archive never changes the held focus: the factory credits a declared task until the next `task_focus` call, so the held focus
// stays what the transcript says, and a later update of another card gets the "focused on" hint. An archive of any other card
// carries the hint for a session that is focused elsewhere, or the no-focus hint.
function withArchiveFocus(statusContext, target, result) {
  const note = focusNote(statusContext, target)
  return note === undefined ? result : { ...result, focus_note: note }
}

/**
 * task_archive
 *
 * Input:
 *   {
 *     track: string,
 *     slug: string,
 *     evidence?: { kind, ref },  // required only when this call bumps a
 *                             // non-terminal task to `done` on archive --
 *                             // see "Evidence gate on the archive bump"
 *     outcome?: "cancelled",  // archive a non-terminal task as abandoned
 *                             // instead, with no evidence required
 *   }
 *
 * Side effects: moves `<root>/<track>/<slug>/` → `<root>/<track>/_archive/<slug>/`.
 * Bumps a non-terminal task to `done` or `cancelled` (see below) as part of
 * the same call.
 *
 * Idempotent: if the source dir doesn't exist AND `_archive/<slug>` does,
 * returns `{ status: "already_archived" }` without staging or committing
 * anything (nothing changed). Throws if neither exists.
 *
 * Evidence gate on the archive bump (the invented-completion finding): a
 * card already in a terminal status (`done` or `cancelled`) archives as-is,
 * needing neither `evidence` nor `outcome` -- archiving is itself the record
 * of intentional closure once a status already carries one. A card with no
 * `task.md` at all (a bare directory) makes no completion claim either, so
 * it archives untouched too. Otherwise -- a live, non-terminal card -- this
 * call must say which kind of closure it is: `evidence: { kind, ref }` for
 * completed work (checked by the same `assertDoneEvidence` `task_update`
 * uses, see its own doc comment for the shape each `kind` needs), or
 * `outcome: "cancelled"` for abandoned work, which needs no evidence and
 * bumps the card to `cancelled` instead of `done`. Neither, or both, is
 * refused with an error before anything is touched: "edit the body with
 * invented work, then task_archive with nothing" is exactly the bypass this
 * closes, and it must fail the same way a bare `task_update` to `done`
 * does, not silently fall back to fabricating a completion.
 *
 * On a Git desk, stages the move (a plain `fs.rename`, never `git mv`) with
 * `git add -- <source> <destination>` — Git detects the rename itself from
 * the deletion and the addition, no `-A` needed — then commits exactly those
 * two paths (M4-6 Part 2). A commit failure never loses the archive: it
 * comes back as `commit: { status: "failed", reason }` on the result,
 * omitted entirely on a normal, silent success or on a non-Git desk.
 *
 * Returns: { status: "archived" | "already_archived", path, commit? }
 */
export async function task_archive({ deskRoot, input, person = null, readiness, statusContext = {}, env = process.env, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  const { track, slug } = values
  if (
    !Object.hasOwn(values, "track") ||
    !Object.hasOwn(values, "slug")
  ) {
    throw new Error("task_archive: `track` and `slug` are required")
  }
  const evidence = objectInput(values.evidence, {
    tool: "task_archive",
    field: "evidence",
    effect: "the task was not archived",
    example: DONE_EVIDENCE_EXAMPLE,
  })
  const outcome = values.outcome
  if (outcome !== undefined && outcome !== "cancelled") {
    throw new Error(
      `task_archive: \`outcome\`, when given, must be "cancelled" (got ${JSON.stringify(outcome)}) -- ` +
        "omit it for a completed task and pass `evidence` instead.",
    )
  }
  if (evidence !== undefined && outcome !== undefined) {
    throw new Error(
      'task_archive: pass either `evidence` (completed work) or `outcome: "cancelled"` (abandoned work), not both',
    )
  }

  const target = (segments) =>
    resolveWriteTarget({ deskRoot, person, segments })
  const srcDir = await target([track, slug])
  const srcFile = await target([track, slug, "task.md"])
  const archiveDir = await target([track, "_archive", slug])
  const archivedFile = await target([track, "_archive", slug, "task.md"])

  const srcExists = await pathExists(srcDir)
  const dstExists = await pathExists(archiveDir)

  if (!srcExists && dstExists) {
    const archivedStatus = await archivedTaskStatus(archivedFile)
    const refilled = await refillArchivedReport({ deskRoot, person, track, slug, env, archivedFile, readiness, spawnGit, schedulePush })
    await requestTaskTerminalSync({ deskRoot, person, track, slug, env, status: archivedStatus })
    return withArchiveFocus(statusContext, { track, slug }, {
      status: "already_archived",
      path: relPath(deskRoot, archivedFile),
      ...refilled,
    })
  }
  if (!srcExists && !dstExists) {
    throw new Error(
      `task_archive: task does not exist at ${relPath(deskRoot, srcDir)}`,
    )
  }
  if (srcExists && dstExists) {
    throw new Error(
      `task_archive: archive destination already exists at ${relPath(
        deskRoot,
        archiveDir,
      )} but source ${relPath(deskRoot, srcDir)} also exists`,
    )
  }

  // Decide, before touching the filesystem, whether this archive would
  // itself carry a completion claim -- a bump from a non-terminal status --
  // and validate `evidence`/`outcome` for it up front, the same
  // "refuse before the card is touched" discipline task_update's own
  // assertDoneEvidence keeps (invented-completion finding). A card already
  // terminal, or no card at all, makes no completion claim and needs
  // neither.
  let archiveBump = null
  if (await pathExists(srcFile)) {
    const sourceCard = await readMarkdown(srcFile)
    if (!TERMINAL_STATUSES.has(sourceCard.data.status)) {
      if (outcome === "cancelled") {
        archiveBump = { status: "cancelled" }
      } else {
        await assertDoneEvidence(evidence, deskRoot, "task_archive", { repos: sourceCard.data.repos, existingRepos: sourceCard.data.repos, created: sourceCard.data.created, files: [srcFile, archivedFile], spawnGit, homeDir: env.HOME })
        archiveBump = { status: "done", evidence: { kind: evidence.kind, ref: evidence.ref } }
      }
      // The record the bump writes is worked out here, before the folder moves: a card whose record cannot be read refuses the archive
      // with the folder untouched, never after a move it would leave unpatched and uncommitted.
      archiveBump.updated = nowIso()
      try {
        archiveBump.record = applyMove(sourceCard.data, { to: archiveBump.status, at: archiveBump.updated })
      } catch (error) {
        throw new Error(`task_archive: nothing was moved. This card's status is not one Desk knows, so Desk took the last status in the card's record as where the task moves from, and that move is refused (${error.message}). Set the card's status with task_update first (a move back from done takes \`return_reason\`), then archive it.`)
      }
    }
  }

  await assertArchiveSourceIsRelocationSafe({
    srcDir,
    srcFile,
    archiveDir,
  })

  // Move the dir. fs.rename is atomic on the same filesystem.
  await withCreatedDirs(path.dirname(archiveDir), () => fs.rename(srcDir, archiveDir))
  // A directory move invalidates both subtrees, including companion documents.
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [
    { path: relPath(deskRoot, srcDir), operation: "delete" },
    { path: relPath(deskRoot, archiveDir), operation: "write" },
  ] })

  // Bump task status per the decision above (and refresh `updated`) if not
  // already terminal.
  await target([track, "_archive", slug])
  const filePath = await target([track, "_archive", slug, "task.md"])
  let finalStatus = null
  let delivered = null
  let report = null
  if (await pathExists(filePath)) {
    const existing = await readMarkdown(filePath)
    finalStatus = existing.data.status
    // Patch only the fields this archive changes (`status:`, `updated:`, the record, `evidence:` and the report link fields) in place:
    // every other byte of the card — quoting, date formats, block scalars, key order — survives.
    const patchFields = {}
    if (archiveBump) {
      const { updated } = archiveBump
      // Every status change the archive makes keeps the card's record, the cancel bump included.
      Object.assign(patchFields, { status: archiveBump.status, updated, ...archiveBump.record })
      if (archiveBump.status === "done") {
        patchFields.evidence = { ...archiveBump.evidence, recorded_at: updated }
        delivered = deliveryAnswer({ data: existing.data, slug, ref: archiveBump.evidence.ref })
        report = await factoryReportFor({ deskRoot, person, track, slug, env })
      }
      finalStatus = archiveBump.status
    }
    // A card that records why it has no report link is asked again whenever it is archived, so archiving never makes the reason permanent.
    if (report === null && Object.hasOwn(existing.data, "factory_report_unavailable")) report = await factoryReportFor({ deskRoot, person, track, slug, env })
    if (report !== null) Object.assign(patchFields, reportFields(report))
    if (Object.keys(patchFields).length > 0) {
      await patchMarkdownFrontmatter(filePath, patchFields)
      await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
    }
  }

  // Stage + commit the move (and any status bump above, already on disk by
  // now) last, once every write this call makes is in place (M4-6 Part 2).
  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  const commit = stageAndCommitMove(effectiveRoot, [srcDir, archiveDir], `task_archive: ${track}/${slug}`, spawnGit)
  if (commit === undefined && isGitRepository(effectiveRoot, spawnGit)) schedulePush({ root: deskRoot })

  await requestTaskTerminalSync({ deskRoot, person, track, slug, env, status: finalStatus })
  const result = { status: "archived", path: relPath(deskRoot, filePath) }
  if (commit) result.commit = commit
  if (delivered !== null) Object.assign(result, delivered)
  Object.assign(result, reportResult(report, delivered === null))
  return withArchiveFocus(statusContext, { track, slug }, result)
}

// The write, stage, commit and finalize helpers `task_signoff` uses, so a sign-off goes through the same path as `task_update`.
export { DESK_COMMIT_NOTE, relPath, stagingAllowed, stageAndCommitCard, headSha, updateTrackRow, taskJobOrNull, requestTaskFinalize }
