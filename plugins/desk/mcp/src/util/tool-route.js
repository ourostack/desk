// Desk tools only help (#623). Every failing, timed-out or refusing answer a Desk tool gives carries `route_around`: the
// steps that finish the same operation another way (Git, the filesystem, gh or a validated Desk script), starting with a
// read-back, and a read-back that proves it worked. A tool failure is never a reason to stop.
//
// One place adds it: `withRouteAround` runs on every answer the session returns (desk-session.js and the diagnostic
// server), after the tool, the refusals before it and the exception handler. A tool that knows its exact route (a commit
// that did not finish, util/route-around.js) gives its own and this leaves it alone; every other failure gets its tool's
// route from TOOL_ROUTES, which has one for every tool. `failureOf` decides what counts as a failure, and the contract test
// requires every status a tool can return to be classified as failing or settled, so a new failure cannot slip through.
//
// A guard that protects something keeps protecting it: a refusal for authority, identity or a headless session routes the
// change to someone who may make it rather than making it by hand; a refusal for the checkout's branch makes the change in a
// temporary worktree instead of switching the shared checkout; a live task card is changed through Desk's validated local
// recovery, because the card guard refuses a hand commit of it. A hosted Desk has no shell or Git, so its routes are words.
// Routes never stash, force, add with -f, -a or -A, skip hooks, name the card guard's override, change identity or name a
// remote; "committed here" and "published to the remote" are separate read-backs.

import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { publishArgv, readbacks } from "./route-around.js"

const RECOVERY_SCRIPT = fileURLToPath(new URL("../../scripts/local-recovery.js", import.meta.url))
const SKILLS_DIR = fileURLToPath(new URL("../../../skills/", import.meta.url))
const ROOT_PLACEHOLDER = "<desk root>"
const IMPROVEMENT_CARD = "_meta/improvement/<the card's file>"

/** Top-level statuses that mean the operation did not finish. */
export const FAILING_STATUSES = Object.freeze([
  "failed", "error", "refused", "unknown", "degraded", "not_implemented", "not_found", "not_verified", "undelivered",
  "ambiguous", "setup_required", "archive_pending", "unresolved",
  // improvement_next's refusals (tools/improvement.js NEXT_REFUSALS and the card library's own codes)
  "noninteractive", "claim_held", "cap_reached", "lock_busy", "invalid_session", "unreadable_folder", "invalid_location",
])

/**
 * Top-level statuses that are an answer, not a failure. `nothing_to_commit` alone means there was nothing to commit (with a
 * failed commit beside it, the commit decides); `pr_open` is a team lesson's pull request opened as asked; `routed` is a
 * desk-scope lesson that is not in effect until a product change ships; `none_open` is improvement_next finding no work;
 * `not_git` is a desk that is not a Git repository, where the file write is the whole operation.
 */
export const SETTLED_STATUSES = Object.freeze([
  "ok", "ready", "created", "updated", "unchanged", "added", "committed", "nothing_to_commit", "merged", "pr_open",
  "pending", "delivered", "routed", "resolved", "processing", "focused", "filed", "done", "cleared", "claimed", "archived",
  "already_archived", "acknowledged", "signed", "published", "listed", "duplicate", "cancelled", "terminal", "unchecked",
  "none_open", "not_git", "written",
])

const FAILING = new Set(FAILING_STATUSES)
const COMMIT_NOT_DONE = new Set(["failed", "unknown", "commit_failed", "commit_unknown", "stage_failed"])
const PUBLICATION_NOT_DONE = new Set(["pending", "unknown"])
// Status reads report the session's state, degraded or not; only an answer flagged isError is a failure for them.
const REPORTS = new Set(["desk_status", "desk_doctor"])

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/** Whether a tool's answer means the operation did not finish. `payload` is the parsed JSON answer, or null for text. */
export function failureOf(name, payload, isError) {
  if (isError === true) return true
  if (!isObject(payload) || REPORTS.has(name)) return false
  if (FAILING.has(payload.status)) return true
  if (typeof payload.error === "string") return true
  const commit = payload.commit
  if (typeof commit === "string" ? COMMIT_NOT_DONE.has(commit) : isObject(commit) && COMMIT_NOT_DONE.has(commit.status)) return true
  return isObject(payload.publication) && PUBLICATION_NOT_DONE.has(payload.publication.status)
}

/** The route an answer already carries, at its top level or on the commit or publication that did not finish. */
export function routeOf(payload) {
  if (!isObject(payload)) return null
  return payload.route_around ?? payload.commit?.route_around ?? payload.publication?.route_around ?? null
}

// ---- building blocks ---------------------------------------------------------------------------------------------

const IDENTITY_CODE = /^(?:authority_|identity_|crew_state_|repository_mismatch$|launcher_|headless)/u
const BRANCH_CODE = /branch|^head_moved$|^detached$|^switch_failed$/u

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null)
const segment = (value) => (text(value) && !/[\\/]|^\.\.?$/u.test(value.trim()) ? value.trim() : null)

function where(ctx) {
  const root = text(ctx.root) ?? ROOT_PLACEHOLDER
  const alias = segment(ctx.person)
  return { root, work: alias && root !== ROOT_PLACEHOLDER ? path.join(root, "desks", alias) : alias ? `${root}/desks/${alias}` : root, alias }
}

function rootStep(ctx) {
  return text(ctx.root) ? [] : [{ step: `Desk could not say which desk root this session has. Call desk_status (or read the root on the session-start line) and use it wherever ${ROOT_PLACEHOLDER} appears below.`, tool: "desk_status", arguments: {} }]
}

function lookFirst(work, paths, what) {
  return {
    step: `Read back first: if ${what} is already there, do not do it again. Go straight to the last step.`,
    argv: [["git", "-C", work, "status", "--porcelain", "--", ...paths], ["git", "-C", work, "log", "-1", "--format=%H %s", "--", ...paths]],
  }
}

function proof(_ctx, work, paths) {
  const { committed_locally_when: local, published_when: published } = readbacks(work, paths)
  return { committed_locally_when: local, published_when: published }
}

function publish(root) {
  return { step: "Publish through Desk's push worker, which never forces. If a push for this root is already running, it exits at once and that push delivers the change.", argv: publishArgv(root) }
}

function commitExact(work, paths, message) {
  return {
    step: `Commit exactly ${paths.join(", ")} with this message. Never -a, -A, add -f, --no-verify, a stash or a way past the card guard.`,
    argv: [["git", "-C", work, "add", "--", ...paths], ["git", "-C", work, "commit", "-m", message, "--", ...paths]],
  }
}

/** The route for an operation local-recovery.js carries: the same call through a fresh, fully checked Desk server, once. */
function recovery(name, ctx, paths, { operation = name, input = "the same JSON arguments you passed to " + name } = {}) {
  const { root, work, alias } = where(ctx)
  return {
    summary: `${name} did not finish. Finish it through Desk's validated local recovery, which runs the same checks (admission, authority, the card guard, exact-path commits) and dispatches once.`,
    steps: [
      ...rootStep(ctx),
      lookFirst(work, paths, "the change"),
      {
        step: `Run ${operation} through local recovery. Give it ${input} as JSON on stdin (never in argv). Read its JSON report, not only its exit code: exit 2 means partial or unknown, so read back again before anything else, and never send it twice blind.`,
        argv: [process.execPath, RECOVERY_SCRIPT, "--root", root, "--operation", operation, ...(alias ? ["--person", alias] : [])],
        stdin: input,
      },
      publish(root),
    ],
    ...proof(ctx, work, paths),
  }
}

/** The route for a change made by hand to files no guard protects, then committed by their exact paths. */
function byHand(name, ctx, paths, change, message) {
  const { root, work } = where(ctx)
  return {
    summary: `${name} did not finish. Make the same change by hand, commit exactly those paths, publish, then read back the remote.`,
    steps: [...rootStep(ctx), lookFirst(work, paths, "the change"), { step: `${change} Change nothing else.` }, commitExact(work, paths, message), publish(root)],
    ...proof(ctx, work, paths),
  }
}

/** The route for a read: the same question answered from the files and Git, which is its own read-back. */
function read(name, ctx, steps, expect) {
  return {
    summary: `${name} did not answer. Answer the same question from the files and Git directly.`,
    steps: [...rootStep(ctx), ...steps],
    readback: { expect },
  }
}

const card = (input) => [segment(input?.track) ?? "<track>", segment(input?.slug) ?? "<slug>"].join("/")

// ---- one route for every tool --------------------------------------------------------------------------------------

export const TOOL_ROUTES = Object.freeze({
  task_create: (input, ctx) => recovery("task_create", ctx, [card(input)]),
  task_update: (input, ctx) => recovery("task_update", ctx, [card(input)]),
  task_archive: (input, ctx) => recovery("task_archive", ctx, [card(input), `${segment(input?.track) ?? "<track>"}/_archive`]),
  task_signoff: (input, ctx) => recovery("task_signoff", ctx, [card(input)], {
    operation: "task_update",
    input: `{"track":"${segment(input?.track) ?? "<track>"}","slug":"${segment(input?.slug) ?? "<slug>"}","note":"Operator's answer: <accepted, or refused and their reason>"} (for a refusal also "status":"processing" and "return_reason"), recording only the answer the operator actually gave`,
  }),
  task_move: (input, ctx) => {
    const { root, work } = where(ctx)
    const from = card(input)
    const to = [segment(input?.to_track) ?? segment(input?.track) ?? "<track>", segment(input?.to_slug) ?? segment(input?.slug) ?? "<slug>"].join("/")
    return {
      summary: "task_move did not finish. Move the folder with git mv (a pure rename passes the card guard), commit exactly both paths, set the card's track through local recovery, publish, then read back the remote.",
      steps: [
        ...rootStep(ctx),
        lookFirst(work, [from, to], "the move"),
        { step: `Move the folder. If ${to} already exists, stop: a move never replaces a task.`, argv: ["git", "-C", work, "mv", from, to] },
        commitExact(work, [from, to], `Move ${from} to ${to}`),
        { step: `If the track changed, set the card's track: through task_update (this session's, or local recovery with {"track":"${to.split("/")[0]}","slug":"${to.split("/")[1]}","frontmatter":{"track":"${to.split("/")[0]}"}} on stdin), and move its row between the tracks' ## Tasks tables by hand, committing each track.md by its exact path.`, argv: [process.execPath, RECOVERY_SCRIPT, "--root", root, "--operation", "task_update"] },
        publish(root),
      ],
      ...proof(ctx, work, [to]),
    }
  },
  task_focus: (input, ctx) => {
    const { work } = where(ctx)
    return read("task_focus", ctx, [{ step: `Read the card directly: ${work}/${card(input)}/task.md, with your file tool. Focus only credits time, and the Desk-Task line in a brief credits it too, so the work goes on without it.` }], "the card's status, recent progress and next step")
  },
  track_create: (input, ctx) => {
    const slug = segment(input?.slug) ?? "<slug>"
    return byHand("track_create", ctx, [`${slug}/track.md`], `Create ${slug}/track.md with the same frontmatter layout as an existing track.md: schema_version: 1, created: today's date, scope: the one-line scope you gave, then the title as its heading.`, `Create track ${slug}`)
  },
  track_update: (input, ctx) => {
    const slug = segment(input?.slug) ?? "<slug>"
    return byHand("track_update", ctx, [`${slug}/track.md`], `Make the same frontmatter change or body append in ${slug}/track.md, keeping schema_version and created.`, `Update track ${slug}`)
  },
  track_rename: (input, ctx) => {
    const { root, work } = where(ctx)
    const from = segment(input?.track) ?? "<track>"
    const to = segment(input?.to) ?? "<new track>"
    return {
      summary: "track_rename did not finish. Rename the folder with git mv (a pure rename passes the card guard), commit exactly both paths, set each card's track through local recovery, publish, then read back the remote.",
      steps: [
        ...rootStep(ctx),
        lookFirst(work, [from, to], "the rename"),
        { step: `Rename the folder. If ${to} already exists, stop.`, argv: ["git", "-C", work, "mv", from, to] },
        commitExact(work, [from, to], `Rename track ${from} to ${to}`),
        { step: `Set track: ${to} on each live card in ${to} through task_update (this session's, or local recovery with that card's {"track","slug","frontmatter":{"track":"${to}"}} on stdin), one card per call.`, argv: [process.execPath, RECOVERY_SCRIPT, "--root", root, "--operation", "task_update"] },
        publish(root),
      ],
      ...proof(ctx, work, [to]),
    }
  },
  friction_add: (input, ctx) => {
    const track = segment(input?.track)
    const file = track ? `${track}/_friction/<YYYY-MM-DD>-${segment(input?.theme) ?? "<theme>"}.md` : "_meta/friction.md"
    return byHand("friction_add", ctx, [file], `Append the entry to ${file} (today's date for <YYYY-MM-DD>), after a separator if the file already has entries. Never rewrite an earlier entry.`, "Add friction entry")
  },
  lesson_add: (input, ctx) => {
    if (input?.scope === "team") {
      const { root } = where(ctx)
      return {
        summary: "lesson_add did not finish the team lesson. Propose it the way Desk does: a pull request to the workspace repository's root AGENTS.md from a temporary worktree, which leaves the shared checkout alone.",
        steps: [
          ...rootStep(ctx),
          { step: "Read back first: if the lesson is already in the root AGENTS.md on the default branch, or an open pull request already adds it, stop there.", argv: [["git", "-C", root, "fetch", "--quiet"], ["git", "-C", root, "grep", "-n", "-F", "-e", text(input?.topic) ?? "<topic>", "@{u}", "--", "AGENTS.md"]] },
          { step: "Make a temporary worktree from the upstream of the checkout's branch on a new branch, add the lesson as one line in its AGENTS.md ## Lessons section, commit exactly AGENTS.md, push that branch and open a pull request with gh. Merge it only if this session already has that authority; otherwise leave it open for the owner." },
        ],
        readback: { argv: ["gh", "pr", "view", "<the new branch>", "--json", "state,mergedAt"], expect: "the pull request exists; only state MERGED means the lesson is in effect" },
      }
    }
    if (input?.scope === "desk") {
      return byHand("lesson_add", ctx, ["_meta/friction.md"], "A desk-scope lesson needs a product change. Record it as friction about the system in _meta/friction.md (or with friction_add, about: system).", "Record a lesson for Desk")
    }
    return byHand("lesson_add", ctx, ["AGENTS.md"], "Add the lesson as one line under ## Lessons in AGENTS.md. If AGENTS.md is too full for session start to print it, move the oldest lessons to LESSONS.md beside it first.", `Add lesson: ${text(input?.topic) ?? "<topic>"}`)
  },
  desk_save: (input, ctx) => {
    const paths = Array.isArray(input?.paths) && input.paths.length > 0
      ? input.paths.filter((p) => typeof p === "string")
      : Array.isArray(input?.files) ? input.files.map((file) => file?.path).filter((p) => typeof p === "string") : []
    return recovery("desk_save", ctx, paths.length > 0 ? paths : ["<the paths you saved>"])
  },
  note_leave: (input, ctx) => {
    const { root } = where(ctx)
    const to = segment(input?.to) ?? "<recipient>"
    return {
      summary: "note_leave did not finish. Leave the note the way Desk does: one new file in the recipient's _inbox, through a pull request from a temporary worktree, which leaves the shared checkout alone.",
      steps: [
        ...rootStep(ctx),
        { step: "Read back first: if this note is already in the recipient's inbox on the default branch or in an open pull request, stop there.", argv: [["git", "-C", root, "fetch", "--quiet"], ["git", "-C", root, "ls-tree", "--name-only", "@{u}", "--", `desks/${to}/_inbox/`]] },
        { step: `Make a temporary worktree from the upstream of the checkout's branch on a new branch, add one new file desks/${to}/_inbox/<YYYY-MM-DD>-<your alias>-<slug>.md with the subject and body, commit exactly that file, push that branch and open a pull request with gh. Write nothing else, and nothing outside that inbox.` },
      ],
      readback: { argv: ["gh", "pr", "view", "<the new branch>", "--json", "state,mergedAt"], expect: "the pull request exists; only state MERGED means the note is delivered" },
    }
  },
  note_ack: (input, ctx) => {
    const note = text(input?.note) ?? "<note>"
    return byHand("note_ack", ctx, [`_inbox/${path.posix.basename(note)}`], `Set status: acknowledged in the frontmatter of _inbox/${path.posix.basename(note)}.`, "Acknowledge note")
  },
  improvement_open: (input, ctx) => byHand("improvement_open", ctx, [IMPROVEMENT_CARD], `Unless a card for source ${text(input?.source) ?? "<source>"} and id ${text(input?.id) ?? "<id>"} is already in _meta/improvement/, add one card file there in the same layout and naming as the cards beside it.`, "Open improvement card"),
  improvement_next: (_input, ctx) => byHand("improvement_next", ctx, [IMPROVEMENT_CARD], "Read the open cards in _meta/improvement/ with your file tool. If this session already holds a claim, finish or release that card first; at the day's claim cap, or in a headless session, take no new card and say so in your report. Otherwise set the claim in the card you take.", "Claim improvement card"),
  improvement_update: (input, ctx) => {
    const { work } = where(ctx)
    const key = text(input?.key) ?? "<key>"
    const route = byHand("improvement_update", ctx, [IMPROVEMENT_CARD], `Make the same state change in that card, only if it holds your claim ${text(input?.claim_id) ?? "<claim_id>"}.`, "Update improvement card")
    route.steps.splice(route.steps.length - 3, 0, { step: `Find the card for ${key}; use its file wherever ${IMPROVEMENT_CARD} appears.`, argv: ["git", "-C", work, "grep", "-l", "-F", "-e", key, "--", "_meta/improvement/"] })
    return route
  },
  desk_search: (input, ctx) => searchRoute("desk_search", ctx, text(input?.query)),
  desk_recall: (input, ctx) => searchRoute("desk_recall", ctx, text(input?.topic)),
  desk_similar: (input, ctx) => searchRoute("desk_similar", ctx, text(input?.path) ? path.posix.basename(input.path).replace(/\.md$/u, "") : null),
  desk_timeline: (input, ctx) => {
    const { work } = where(ctx)
    return read("desk_timeline", ctx, [{ step: "List what changed, newest first.", argv: ["git", "-C", work, "log", `--since=${text(input?.from) ?? "14 days ago"}`, ...(text(input?.to) ? [`--until=${input.to}`] : []), "--name-status", "--format=%h %ad %s", "--date=short"] }], "the commits and the files each changed")
  },
  desk_thread: (input, ctx) => {
    const { work } = where(ctx)
    const start = text(input?.start_path) ?? "<path>"
    return read("desk_thread", ctx, [
      { step: `Read ${start} with your file tool and follow the links in it.` },
      { step: "Find what links to it.", argv: ["git", "-C", work, "grep", "-n", "-F", "-e", path.posix.basename(start)] },
    ], "the file and the files that link to it")
  },
  desk_reindex: (_input, ctx) => searchRoute("desk_reindex", ctx, null),
  desk_status: (_input, ctx) => {
    const { root } = where(ctx)
    return read("desk_status", ctx, [{ step: "Read the checkout's state.", argv: [["git", "-C", root, "status", "--short", "--branch"], ["git", "-C", root, "log", "-1", "--format=%H %s"]] }], "the branch, what is not committed and what is not yet on the upstream")
  },
  desk_doctor: (_input, ctx) => {
    const { root } = where(ctx)
    return read("desk_doctor", ctx, [{ step: "Read the checkout's state, then fix what it shows by hand with Git (never by stashing or forcing).", argv: [["git", "-C", root, "status", "--short", "--branch"], ["git", "-C", root, "rev-parse", "--git-dir"]] }], "the branch and what is not committed")
  },
  desk_skill: (input) => ({
    summary: "desk_skill did not answer. Read the skill's file directly.",
    steps: [{ step: `Read ${path.join(SKILLS_DIR, segment(input?.name) ?? "<name>", "SKILL.md")} with your file tool.` }],
    readback: { expect: "the skill's text" },
  }),
})

function searchRoute(name, ctx, query) {
  const { work } = where(ctx)
  return read(name, ctx, [{ step: "Search the files directly; the index only makes this faster.", argv: ["git", "-C", work, "grep", "-n", "-i", "-I", "-F", "-e", query ?? "<what you are looking for>"] }], "the matching lines and their files")
}

// ---- guards keep their protection ---------------------------------------------------------------------------------

function guardedRoute(name, ctx, code) {
  return {
    summary: `${name} was refused (${code}) to protect who may change this desk. Finish the job without crossing that line: never write it by hand, change identity or treat the refusal as permission.`,
    steps: [
      { step: "Read back who this session is and what it may write.", tool: "desk_status", arguments: {} },
      { step: "Hand the exact change (the paths and what goes in them) to whoever may make it: in your report to the parent or operator, or as a pull request from your own branch for its owner to merge. Say that Desk refused and why." },
    ],
    readback: { expect: "the change is with its owner (named in your report, or an open pull request); nothing was written here" },
  }
}

function branchRoute(name, input, ctx, code) {
  const { root } = where(ctx)
  const branch = text(ctx.stateBranch)
  const temp = `${root}.desk-route-${name}`
  // The tool's own route, run inside a worktree on the branch Desk writes to; its publish step pushes that worktree's branch.
  const inner = TOOL_ROUTES[name](input, { ...ctx, root: temp })
  const { summary: _summary, steps, ...readback } = inner
  const on = branch ?? "<the branch Desk writes to (desk_status names it)>"
  return {
    summary: `${name} was refused (${code}): the checkout is not on ${on}, and switching a shared checkout by hand could move another session's work. Let Desk switch it if that is safe; otherwise make the same change in a temporary worktree on ${on}, publish it from there and remove the worktree.`,
    steps: [
      ...rootStep(ctx),
      { step: "Read back the checkout's branch and what is not committed.", argv: ["git", "-C", root, "status", "--short", "--branch"] },
      { step: "Ask Desk to switch to its branch. It switches only when nothing would be lost. If it does, call the tool again, once, and stop here.", tool: "desk_doctor", arguments: { repair: "switch_state_branch" } },
      { step: `Otherwise make a temporary worktree on ${on}. If Git says ${on} is already checked out in another worktree, that worktree is not yours: stop and hand the change to the operator in your report.`, argv: ["git", "-C", root, "worktree", "add", temp, on] },
      ...steps,
    ],
    ...readback,
    cleanup: { step: "Only once published_when passes, remove the temporary worktree (it holds nothing else); a push still running pushes from it.", argv: ["git", "-C", root, "worktree", "remove", temp] },
  }
}

function hostedRoute(name) {
  return {
    summary: `${name} cannot run in a hosted Desk, which has no shell or Git here. Finish it where it can run.`,
    steps: [
      { step: `Run ${name} from a local Desk session on this desk, or make the same change in the desk's repository on GitHub's web editor, committing only the files the operation changes.` },
    ],
    readback: { expect: "the change is on the desk repository's default branch, read back on GitHub" },
  }
}

/** The route for `name` when it failed: a guard's route for a guard's refusal, the tool's own route otherwise. */
export function toolRoute(name, input, ctx = {}) {
  if (ctx.hosted) return hostedRoute(name)
  const code = text(ctx.code) ?? ""
  if (IDENTITY_CODE.test(code)) return guardedRoute(name, ctx, code)
  const build = TOOL_ROUTES[name]
  if (build === undefined) {
    return {
      summary: `${name} is not a Desk tool. Do the job with Git and the filesystem directly.`,
      steps: [{ step: "List Desk's tools with the client's tool list, or call desk_status, and use the tool that does this job." }],
      readback: { expect: "the job's own result, read back from the files" },
    }
  }
  if (BRANCH_CODE.test(code)) return branchRoute(name, input, ctx, code)
  return build(input ?? {}, ctx)
}

/**
 * The MCP answer `result` for `name`, with `route_around` added when it failed and carries none. A JSON answer gets the
 * field; a text answer gets a second text item holding `{ route_around }`. Everything else stays as it was.
 */
export function withRouteAround(name, input, result, ctx = {}) {
  if (!isObject(result) || !Array.isArray(result.content) || result.content.length === 0) return result
  const first = result.content[0]
  let payload = null
  if (first?.type === "text" && typeof first.text === "string") {
    try { payload = JSON.parse(first.text) } catch { payload = null }
  }
  if (!failureOf(name, payload, result.isError)) return result
  if (routeOf(payload) !== null) return result
  const route = toolRoute(name, input, { ...ctx, code: isObject(payload) ? payload.code : null })
  if (isObject(payload)) {
    const pretty = first.text.includes("\n")
    const textOut = JSON.stringify({ ...payload, route_around: route }, null, pretty ? 2 : undefined)
    return { ...result, content: [{ ...first, text: textOut }, ...result.content.slice(1)] }
  }
  return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({ route_around: route }) }] }
}

/** `callTool` with every answer passed through withRouteAround; `context()` gives the session's root, person, branch and hosted flag at call time. */
// A synchronous answer stays synchronous, so a front door that writes it at once keeps its ordering.
export function routedCallTool(callTool, context) {
  return (call) => {
    const route = (result) => withRouteAround(call?.name, call?.input, result, context())
    const result = callTool(call)
    return typeof result?.then === "function" ? result.then(route) : route(result)
  }
}

