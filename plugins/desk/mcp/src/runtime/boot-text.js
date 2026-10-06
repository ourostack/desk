// The boot script's readable output. Agents read the boot result straight off a Bash call, and round B's critiques
// all said the same thing: the instructions sat buried in a JSON array among fields they did not need. By default the
// script now prints plain text (one status line, the work grouped by state with each task's push route, then only the
// instructions that apply to this boot), and
// `--json` keeps the structured result for tools and tests. This module also holds the two pieces of desk state the
// text shows that are not part of the scan itself: the desk's own AGENTS.md (included, size-capped, so no agent has
// to be told to go and read it) and when the local desk was last in sync with its remote.

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import * as path from "node:path"
import { ELSEWHERE_NOTE, saysElsewhere } from "./elsewhere-note.js"
import { readSyncStatus } from "./sync-worker.js"
import { unsignedLines } from "../desk/unsigned-deliveries.js"

/** How much of the desk's AGENTS.md boot prints; the rest stays in the file, named by its path. */
export const AGENTS_MD_CAP_BYTES = 16 * 1024

/**
 * The desk's AGENTS.md as `{ path, text, truncated, bytes, shownBytes }`, or null when the desk has none or it cannot
 * be read. A file over `cap` bytes is cut at its last line break inside the cap (or, with none, at a character
 * boundary), so a rule is never shown half-written.
 */
export function readAgentsMd(root, { cap = AGENTS_MD_CAP_BYTES } = {}) {
  const file = path.join(root, "AGENTS.md")
  let fd
  try {
    fd = openSync(file, "r")
  } catch {
    return null
  }
  try {
    // One byte past the cap tells a file of exactly `cap` bytes from a longer one.
    const buffer = Buffer.alloc(cap + 1)
    const bytesRead = readSync(fd, buffer, 0, cap + 1, 0)
    if (bytesRead <= cap) return { path: file, text: buffer.toString("utf8", 0, bytesRead), truncated: false, bytes: bytesRead, shownBytes: bytesRead }
    let end = buffer.subarray(0, cap).lastIndexOf(0x0a)
    if (end === -1) {
      end = cap
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
    }
    return { path: file, text: buffer.toString("utf8", 0, end), truncated: true, bytes: fstatSync(fd).size, shownBytes: end }
  } finally {
    closeSync(fd)
  }
}

/**
 * When the local desk last finished a real pull, as ISO text, or null when none is recorded. This reads the sync
 * record's `last_success_at` (written when a pull completes), never FETCH_HEAD's modified time: a failed fetch touches
 * FETCH_HEAD too, so its time would claim a sync that did not happen.
 */
export function lastSyncedAt({ root, env }, { readStatus = readSyncStatus } = {}) {
  try {
    const at = readStatus({ root, env })?.last_success_at
    return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null
  } catch {
    return null
  }
}

const FAILURE_WORDS = {
  unreachable: "remote unreachable",
  auth_failed: "remote refused this host's credentials",
  deadline: "git timed out",
  conflict: "the pull hit a conflict",
  diverged: "the desk and its remote have diverged",
}

// Where the quarantine put the moved paths: `_cache/stray-<date>/` under the desk, from the first moved path.
function strayDir(sync, root) {
  const first = Array.isArray(sync.quarantinedPaths) ? sync.quarantinedPaths[0] : undefined
  const dir = typeof first === "string" ? first.split("/").slice(0, 2).join("/") : "_cache"
  return root ? `${root}/${dir}/` : `${dir}/`
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`

/**
 * One plain sentence about the sync, phrased for what happened, never a word like "partial". A failed sync pulled
 * nothing and pushed nothing; a conflict while restoring local changes means the pull itself succeeded; a desk with no
 * remote or upstream has nothing to sync, which is not a sync that worked. `sync` is `syncWorkspace`'s answer (null
 * when it did not return one); `timedOut` says the boot's time budget ended it; `lastSyncAt` is ISO text or null;
 * `root` is the desk's path, used to name where moved files went.
 */
export function syncSummary({ sync, timedOut = false, lastSyncAt = null, root = "" }) {
  const asOf = `local desk is as of ${lastSyncAt ?? "unknown"}`
  const failed = (why) => `sync failed: ${why}; nothing was pulled or pushed; ${asOf}`
  if (timedOut) return failed("it did not finish within the boot's time budget")
  if (sync === null || sync === undefined) return failed("it did not run")
  if (sync.state === "unresolved") {
    const moved = Array.isArray(sync.quarantinedPaths) && sync.quarantinedPaths.length > 0 ? ` (${plural(sync.quarantinedPaths.length, "stray untracked path")} had been moved to ${strayDir(sync, root)} first)` : ""
    if (typeof sync.reason === "string" && sync.reason.startsWith("autostash_pop_conflict")) {
      const paths = Array.isArray(sync.conflicted) && sync.conflicted.length > 0 ? ` (conflicted: ${sync.conflicted.join(", ")})` : ""
      return `sync: the pull succeeded, but the desk's uncommitted local changes conflict with what came in${paths}; nothing was pushed; resolve them before changing the desk${moved}`
    }
    return `${failed(FAILURE_WORDS[sync.cause] ?? "the pull did not complete")}${moved}`
  }
  if (sync.state === "quarantined") return `sync ok: moved ${plural(sync.quarantinedPaths?.length ?? 0, "stray untracked path")} to ${strayDir(sync, root)} first, then pulled`
  if (sync.nothingToSync === "headless") return "headless session; nothing synced"
  if (sync.nothingToSync === "no_remote") return "no remote; nothing to sync"
  if (sync.nothingToSync === "no_upstream") return "no upstream branch; nothing to sync"
  return "sync ok"
}

/** How many active tasks the boot text lists; the rest are counted, never cut mid-sentence. */
export const TASKS_SHOWN_CAP = 15

const NO_NEXT_STEP = "no next step recorded"

/** The longest next step or blocker boot prints; longer ones are cut at a word boundary and point at the card. */
export const TEXT_CEILING = 600

/**
 * `text` as it is printed: whole when it fits `TEXT_CEILING`, otherwise cut at the last space inside the ceiling, backing
 * out of an open `code` span, so an identifier or a path is never split, then "... (see card)".
 */
export function ceiling(text, limit = TEXT_CEILING) {
  if (text.length <= limit) return text
  let cut = text.slice(0, limit + 1)
  const space = cut.lastIndexOf(" ")
  // One unbroken word longer than the limit stays whole, up to the next space.
  if (space > 0) cut = cut.slice(0, space)
  else cut = text.indexOf(" ", limit) === -1 ? text : text.slice(0, text.indexOf(" ", limit))
  if ((cut.match(/`/gu) ?? []).length % 2 === 1 && cut.lastIndexOf("`") > 0) cut = cut.slice(0, cut.lastIndexOf("`"))
  return `${cut.trimEnd()} ... (see card)`
}

// A task's next step or blocker is printed whole: a cut line made agents guess the rest or open the card. A blocked
// task shows the card's blocker reason (falling back to its next step); a card that records neither says so, so no
// agent invents filler.
// A next step or blocker that says the thing lives only on another machine gets ELSEWHERE_NOTE (elsewhere-note.js, shared with the clone guard).
export { ELSEWHERE_NOTE }

function stepLines(task) {
  const next = typeof task.next_step === "string" && task.next_step !== "" ? task.next_step : null
  const blocker = typeof task.blocker === "string" && task.blocker !== "" ? task.blocker : null
  if (task.status === "blocked") {
    if (blocker !== null) return [`  blocker: ${ceiling(blocker)}`, ...(next === null ? [] : [`  next: ${ceiling(next)}`])]
    return [`  blocker: ${next === null ? "no blocker or next step recorded" : `no blocker recorded; next: ${ceiling(next)}`}`]
  }
  return [`  next: ${next === null ? NO_NEXT_STEP : ceiling(next)}`]
}

// What Desk's own access check found for the active account, in words that claim nothing the check did not show.
const ACCESS_FINDINGS = {
  store_not_visible: "could not see the repository",
  auth_failed: "failed to sign in",
  forking_disabled: "found forking disabled",
  managed_account: "found a managed account",
}

/**
 * How to push a repo, naming the account every time and the fork when the route is one, and saying plainly what was and
 * was not checked about gh's active account when it is a different one: "push as arimendelow via fork
 * arimendelow/widgets. The active gh account is work; Desk routes this repo's pushes through the fork and did not check
 * that account's own access." An agent that read "is not the push account" once wrote "work cannot push" as fact, and
 * another wrote the active account into a card as the push account.
 */
export function pushRoute(entry) {
  const store = typeof entry.store === "string" ? entry.store : ""
  const repoName = store.split("/")[1]
  const fork = entry.route === "fork"
  const via = fork ? ` via fork ${repoName ? `${entry.account}/${repoName}` : `${entry.account}'s fork of ${store}`}` : entry.route ? ` (route ${entry.route})` : ""
  const active = Array.isArray(entry.accounts) ? entry.accounts[0]?.account : undefined
  if (typeof active !== "string" || active === entry.account) return `push as ${entry.account}${via}`
  const reason = entry.accounts[0].reason
  const checked = typeof reason === "string" && reason !== "" ? `its own access check ${ACCESS_FINDINGS[reason] ?? `returned ${reason}`}` : "did not check that account's own access"
  return `push as ${entry.account}${via}. The active gh account is ${active}; Desk routes this repo's pushes through ${fork ? "the fork" : entry.account} and ${checked}.`
}

// The one push-route line for a repo of a task, or null when there is nothing to say (no GitHub remote, or a check that
// has not finished). It is the whole route: where to push, which account, and what never to do, so no second
// instruction repeats it.
function pushNote(entry) {
  const store = entry.store ?? entry.repo
  if (entry.result === "account_found") {
    const route = pushRoute(entry)
    const active = Array.isArray(entry.accounts) ? entry.accounts[0]?.account : undefined
    const fork = entry.route === "fork" ? ` Push your branch to the fork and open the pull request from it; never push to ${store} itself.` : ""
    // A direct push by the account gh already has active needs no line.
    if (entry.route !== "fork" && (typeof active !== "string" || active === entry.account)) return null
    const login = typeof active === "string" && active !== entry.account ? ` For git and gh calls use \`GH_TOKEN=$(gh auth token --user ${entry.account})\`, and name ${entry.account}, never ${active}, as the push account in any note.` : ""
    return `${store}: ${route}${route.endsWith(".") ? "" : "."}${fork}${login} ${SAY_ROUTE} ${ROUTE_CHECKED}`
  }
  if (entry.result === "no_account_can_deliver") {
    const reasons = Array.isArray(entry.accounts) && entry.accounts.length > 0 ? ` (${entry.accounts.map((item) => `${item.account}: ${item.reason}`).join("; ")})` : ""
    return `${store}: no signed-in account can push${reasons}. Do not push; ask the operator which account to use, or fork. ${SAY_ROUTE}`
  }
  if (entry.result === "not_a_github_repo") return null
  if (entry.result === "pending") return `${store}: push route not checked in time; run \`gh auth status\` and check before pushing.`
  return `${store}: push access could not be checked (${entry.result}); verify with \`gh auth status\` before pushing.`
}

const SAY_ROUTE = "Say this route in one line when you report on the task."
// Desk's own route is the answer to "which account and route can deliver"; an agent that re-checks it with gh and gets a failure goes on to probe the token itself.
export const ROUTE_CHECKED = "Desk resolved this route, so say it rather than re-checking it with gh. Using the token inside the git or gh call as above is fine; never print, count or test it on its own, and if a gh call fails, report the error as it is."

const taskKey = (desk, track, slug) => `${desk ?? ""}|${track}|${slug}`

// Each task's push-route lines, keyed by the task, one per distinct repo and route.
function pushNotesByTask(accounts) {
  const byTask = new Map()
  for (const entry of accounts ?? []) {
    const note = pushNote(entry)
    if (note === null) continue
    const key = taskKey(entry.desk, entry.track, entry.slug)
    const notes = byTask.get(key) ?? new Set()
    notes.add(note)
    byTask.set(key, notes)
  }
  return byTask
}

function taskLines(track, task, pushNotes) {
  const named = `${track.desk ? `${track.desk}/` : ""}${track.track}/${task.slug}`
  const title = typeof task.title === "string" && task.title !== task.slug ? ` "${task.title}"` : ""
  const hidden = /redacted/u.test(named) ? ` (handle ${task.handle})` : ""
  const updated = typeof task.updated === "string" ? ` (updated ${task.updated.slice(0, 10)})` : ""
  const push = [...(pushNotes.get(taskKey(track.desk, track.track, task.slug)) ?? [])].map((note) => `  push: ${note}`)
  const elsewhere = saysElsewhere(task) ? [`  ${ELSEWHERE_NOTE}`] : []
  return [`- ${named}${title}${updated}${hidden}`, ...stepLines(task), ...elsewhere, ...push]
}

// A repo's path as boot prints it: already expanded against this machine's HOME, with the card's own spelling after it ("/home/me/code/x (~/code/x)"), so an agent never expands `~` itself
// (round T: two agents guessed `/Users/aris/code/...` for `~/code/...` and edited files there).
export function shownRepoPath(state) {
  const recorded = state.local_path
  const absolute = typeof state.path === "string" && state.path !== "" ? state.path : recorded
  return absolute === recorded || typeof recorded !== "string" ? absolute : `${absolute} (${recorded})`
}

function repoLine(state) {
  const place = shownRepoPath(state)
  const where = `${state.desk ? `${state.desk}/` : ""}${state.track}/${state.slug}`
  if (state.present === false) return `- ${state.repo} (${where}): not at ${place}${state.url ? `; clone url ${state.url}` : ""}`
  const sync = state.local_only ? "no remote configured" : state.fetched ? "fetched" : "fetch failed"
  return `- ${state.repo} (${where}): ${place === undefined ? "" : `${place}, `}branch ${state.branch ?? "unknown"}, ${state.dirty ? "uncommitted changes" : "clean"}, ${sync}`
}

function prLine(pr) {
  return `- ${pr.store}#${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""}${pr.review ? `, ${pr.review}` : ""}: ${pr.url}`
}

function namedTaskLines(task) {
  if (task === null || task === undefined) return []
  if (task.status === "resolved") {
    const shown = task.task
    return ["", `Named task: ${shown.track}/${shown.slug} (${shown.status}), card ${shown.card}`]
  }
  if (task.status === "ambiguous") return ["", `Named task: ambiguous, matches ${task.candidates.map((candidate) => `${candidate.track}/${candidate.slug}`).join(", ")}`]
  return ["", "Named task: matches no open task"]
}

// Two instructions name the active-task list. The structured result (`--json`) names it by its field, `active_tasks`;
// the plain-text boot prints it as the "Active tasks" section, and an agent reading plain text cannot map a field name
// to a section (boot acceptance rounds F, H and J: "where were we?" reported one task). So the text boot says the section.
export const NO_TASK_INSTRUCTION = "No task was named: build the status block from active_tasks, open_prs and repo_states, then ask which task to resume or whether to start new."
export const NO_TASK_INSTRUCTION_TEXT = "No task was named: report every task under \"Active tasks\" above, each with its status and its next step or blocker (and any open pull requests or repo state that matter), then ask which one to resume or whether to start new. Those lines are copied from the cards, so do not open a card just to report on it."
export const UNMATCHED_TASK_INSTRUCTION = "The name matches no open task: show the active_tasks status block and ask what to resume or start."
export const UNMATCHED_TASK_INSTRUCTION_TEXT = "The name matches no open task: report every task under \"Active tasks\" above, each with its status and its next step or blocker, then ask what to resume or start."

const PLAIN_TEXT_INSTRUCTIONS = new Map([
  [NO_TASK_INSTRUCTION, NO_TASK_INSTRUCTION_TEXT],
  [UNMATCHED_TASK_INSTRUCTION, UNMATCHED_TASK_INSTRUCTION_TEXT],
])

/**
 * The sync summary in the words the status line uses: "Desk synced with origin", or "Desk could not sync: <why>; local
 * state shown". `summary` is `syncSummary`'s sentence, which `--json` keeps as it is; any other wording passes through.
 */
export function syncWords(summary) {
  if (typeof summary !== "string" || summary === "") return null
  if (summary === "sync ok") return "Desk synced with origin"
  const moved = /^sync ok: moved (.+) first, then pulled$/u.exec(summary)
  if (moved) return `Desk synced with origin (moved ${moved[1]} first)`
  const failed = /^sync failed: (.+?); nothing was pulled or pushed; local desk is as of (\S+)(.*)$/u.exec(summary)
  if (failed) return `Desk could not sync: ${failed[1]}; local state shown${failed[2] === "unknown" ? "" : `, as of ${failed[2]}`}${failed[3]}`
  const nothing = /^no (remote|upstream branch); nothing to sync$/u.exec(summary)
  if (nothing) return `Desk has no ${nothing[1]}; nothing to sync`
  if (summary.startsWith("sync: the pull succeeded, but ")) return `Desk pulled from origin, but ${summary.slice("sync: the pull succeeded, but ".length)}`
  return summary
}

// The state groups, blocked first, then the others in the order their most recently updated task appears.
function groupHeading(status, count) {
  return status === "blocked" ? `BLOCKED (${count}): these cannot move until the blocker clears` : `${status} (${count})`
}

function taskSection(result, lines) {
  const tracks = result.active_tasks?.tracks
  if (!Array.isArray(tracks)) {
    if (result.status !== "setup_required") lines.push("", "Active tasks: unavailable (see degraded)")
    return
  }
  // With one task named, it leads in full and the rest are one line: the operator asked for that task, and the others pushed the question below the fold (round S2).
  const named = result.task?.status === "resolved" ? result.task.task : null
  const namedOnly = named !== null && tracks.some((track) => track.tasks.some((task) => task.slug === named.slug && track.track === named.track && (track.desk ?? "") === (named.desk ?? "")))
  lines.push("", `Active tasks (${result.active_tasks.task_count})${namedOnly ? ", showing the named one" : ""}:`)
  if (tracks.length === 0) lines.push("- none")
  // Blocked tasks first, then the most recently updated, before the cap cuts the list.
  const rank = ({ task }) => (task.status === "blocked" ? 0 : 1)
  const everyTask = tracks
    .flatMap((track) => track.tasks.map((task) => ({ track, task })))
    .sort((a, b) => rank(a) - rank(b) || (typeof b.task.updated === "string" ? b.task.updated : "").localeCompare(typeof a.task.updated === "string" ? a.task.updated : ""))
  // The task the operator named is always shown, first, whatever its rank: its push route is printed nowhere else.
  const pinnedAt = named === null ? -1 : everyTask.findIndex(({ track, task }) => track.track === named.track && task.slug === named.slug && (track.desk ?? "") === (named.desk ?? ""))
  const pinned = pinnedAt === -1 ? [] : everyTask.splice(pinnedAt, 1)
  const groups = new Map()
  const shownTasks = namedOnly ? pinned : [...pinned, ...everyTask.slice(0, TASKS_SHOWN_CAP - pinned.length)]
  for (const entry of shownTasks) {
    const status = entry.task.status ?? "no status"
    groups.set(status, [...(groups.get(status) ?? []), entry])
  }
  const pushNotes = pushNotesByTask(result.push_accounts)
  for (const [status, entries] of groups) {
    lines.push("", groupHeading(status, entries.length))
    for (const { track, task } of entries) lines.push(...taskLines(track, task, pushNotes))
  }
  const hidden = everyTask.length + pinned.length - shownTasks.length
  if (namedOnly) {
    if (hidden > 0) lines.push("", `Other active tasks: ${hidden} (say 'where were we' to list them)`)
  } else if (hidden > 0) lines.push("", `...and ${hidden} more active tasks (all of them are in \`active_tasks\` with \`--json\`)`)
}

/**
 * The boot result as readable text, leading with the work: one status line (status, desk, host, sync in plain words),
 * the stale-Desk line when there is one, the active tasks grouped by state with each task's push route, the open pull
 * requests and repos, then only the instructions that apply to this boot, and the desk's AGENTS.md. Every section is
 * omitted when it has nothing to say, so a healthy boot stays short. `result.text_instructions`, when the boot made
 * them, are the plain-text wording of the instructions (shorter, with the push routes and the factory script moved out);
 * a result without them prints `instructions`.
 */
export function formatBootText(result) {
  // A sync call that threw has no summary reason but "it did not run"; its error message is in `degraded`, so say that.
  const thrown = (result.degraded ?? []).find((line) => line.startsWith("sync: "))
  const raw = syncWords(result.sync_summary)
  const sync = raw !== null && thrown !== undefined ? raw.replace("Desk could not sync: it did not run;", () => `Desk could not sync: ${thrown.slice("sync: ".length)};`) : raw
  // A failed sync leads the headline, so "degraded" never reads as a success: "Desk boot: degraded (sync failed: <why>; showing local state)".
  const syncFailed = sync !== null && sync.startsWith("Desk could not sync: ")
  const failing = []
  if (syncFailed) failing.push(`sync failed: ${sync.slice("Desk could not sync: ".length).replace(/; local state shown/u, "; showing local state")}`)
  const inHeadline = new Set()
  for (const line of result.degraded ?? []) {
    if (line.startsWith("sync: ")) continue
    if (failing.length < 3 && line.length <= 80) inHeadline.add(line)
    failing.push(line.length > 80 ? `${line.slice(0, 77)}...` : line)
  }
  const waiting = typeof result.needs_operator?.question === "string"
  const waitingWords = waiting ? `, waiting on you (${result.needs_operator.summary})` : ""
  const headline = result.status === "degraded" && failing.length > 0 ? `Desk boot: degraded (${failing.slice(0, 3).join(" and ")}${failing.length > 3 ? ` and ${failing.length - 3} more` : ""})${waitingWords}` : `Desk boot: ${result.status}${waitingWords}`
  const status = [headline]
  if (result.root?.path) status.push(`desk ${result.root.path}${result.root.source ? ` (bound by ${result.root.source})` : ""}`)
  if (result.host) status.push(`host ${result.host.hostname ?? "unknown"} / ${result.host.user ?? "unknown"} / ${result.host.agent ?? "unknown"}`)
  // The headline already says a failed sync; the sync words follow only for a sync that did not fail (it worked, or there was nothing to sync).
  if (sync !== null && !syncFailed) status.push(sync)
  const lines = [status.join(" | ")]
  if (waiting) lines.push(`Needs you first: ${result.needs_operator.question}`)
  if (typeof result.stale_desk?.line === "string") lines.push(result.stale_desk.line)
  // The headline already says why the sync failed and what else failed (up to three short entries), so those entries would only repeat it.
  for (const line of result.degraded ?? []) if (!inHeadline.has(line) && (sync === null || !line.startsWith("sync: "))) lines.push(`- degraded: ${line}`)
  for (const line of result.pending ?? []) lines.push(line.startsWith("auth: ") ? `- warning: ${line.slice("auth: ".length)}` : `- pending (not finished in time, carry it): ${line}`)
  lines.push(...namedTaskLines(result.task))
  taskSection(result, lines)
  lines.push(...unsignedLines(result.unsigned_deliveries))
  if ((result.open_prs ?? []).length > 0) lines.push("", "Open pull requests:", ...result.open_prs.map(prLine))
  if ((result.repo_states ?? []).length > 0) lines.push("", "Repos of open tasks:", ...result.repo_states.map(repoLine))
  const instructions = result.text_instructions ?? (result.instructions ?? []).map((instruction) => PLAIN_TEXT_INSTRUCTIONS.get(instruction) ?? instruction)
  if (instructions.length > 0) lines.push("", "Instructions, in order:", ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`))
  if (result.agents_md) {
    // A heading, not a fence: the file's own text may hold any fence or rule line.
    lines.push("", `## The desk's AGENTS.md (${result.agents_md.path}); its rules bind this session`, "", result.agents_md.text.replace(/\n+$/u, ""))
    if (result.agents_md.truncated) lines.push("", `[Cut after ${result.agents_md.shownBytes} of ${result.agents_md.bytes} bytes (limit ${AGENTS_MD_CAP_BYTES / 1024} KB): read the rest at ${result.agents_md.path}]`)
  }
  return `${lines.join("\n")}\n`
}
