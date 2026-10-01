// The boot script's readable output. Agents read the boot result straight off a Bash call, and round B's critiques
// all said the same thing: the instructions sat buried in a JSON array among fields they did not need. By default the
// script now prints plain text (a status line, the desk's path, the numbered instructions, then the data), and
// `--json` keeps the structured result for tools and tests. This module also holds the two pieces of desk state the
// text shows that are not part of the scan itself: the desk's own AGENTS.md (included, size-capped, so no agent has
// to be told to go and read it) and when the local desk was last in sync with its remote.

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import * as path from "node:path"
import { readSyncStatus } from "./sync-worker.js"

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
  if (sync.nothingToSync === "no_remote") return "no remote; nothing to sync"
  if (sync.nothingToSync === "no_upstream") return "no upstream branch; nothing to sync"
  return "sync ok"
}

function taskLine(track, task) {
  const named = `${track.desk ? `${track.desk}/` : ""}${track.track}/${task.slug}`
  const title = typeof task.title === "string" && task.title !== task.slug ? ` "${task.title}"` : ""
  const hidden = /redacted/u.test(named) ? ` (handle ${task.handle})` : ""
  const updated = typeof task.updated === "string" ? `, updated ${task.updated.slice(0, 10)}` : ""
  const next = typeof task.next_step === "string" && task.next_step !== "" ? `\n  next: ${task.next_step}` : ""
  return `- ${named}${title}: ${task.status ?? "no status"}${updated}${hidden}${next}`
}

function repoLine(state) {
  const where = `${state.desk ? `${state.desk}/` : ""}${state.track}/${state.slug}`
  if (state.present === false) return `- ${state.repo} (${where}): not at ${state.local_path}${state.url ? `; clone url ${state.url}` : ""}`
  const sync = state.local_only ? "no remote configured" : state.fetched ? "fetched" : "fetch failed"
  return `- ${state.repo} (${where}): branch ${state.branch ?? "unknown"}, ${state.dirty ? "uncommitted changes" : "clean"}, ${sync}`
}

// One line per distinct store, outcome, account and route, naming the task(s) it is for: the full list behind the few
// push-route notes among the numbered instructions.
function pushRouteLines(accounts) {
  const groups = new Map()
  for (const entry of accounts) {
    const how =
      entry.result === "account_found"
        ? `push as ${entry.account}${entry.route ? ` (route ${entry.route})` : ""}`
        : entry.result === "no_account_can_deliver"
          ? "no signed-in account can push"
          : entry.result === "not_a_github_repo"
            ? "no GitHub remote, so no push route to check"
            : `not checked (${entry.result}${entry.reason ? `: ${entry.reason}` : ""})`
    const key = `${entry.store ?? entry.repo}|${how}`
    const group = groups.get(key) ?? { subject: entry.store ?? entry.repo, how, where: [] }
    const where = `${entry.desk ? `${entry.desk}/` : ""}${entry.track}/${entry.slug}`
    if (!group.where.includes(where)) group.where.push(where)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => `- ${group.subject}: ${group.how} (${group.where.join(", ")})`)
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

/**
 * The boot result as readable text: status, desk, numbered instructions, then data sections and the desk's
 * AGENTS.md. Every section is omitted when it has nothing to say, so a healthy boot stays short.
 */
export function formatBootText(result) {
  const lines = [`Desk boot: ${result.status}`]
  for (const line of result.degraded ?? []) lines.push(`- degraded: ${line}`)
  for (const line of result.pending ?? []) lines.push(`- pending (not finished in time, carry it): ${line}`)
  lines.push("")
  if (result.root?.path) lines.push(`Desk: ${result.root.path}${result.root.source ? ` (bound by ${result.root.source})` : ""}`)
  if (result.host) lines.push(`Host: ${result.host.hostname ?? "unknown"} / ${result.host.user ?? "unknown"} / ${result.host.agent ?? "unknown"}`)
  if (lines.at(-1) !== "") lines.push("")
  lines.push("Instructions, in order:")
  ;(result.instructions ?? []).forEach((instruction, index) => lines.push(`${index + 1}. ${instruction}`))
  if (result.sync_summary) lines.push("", result.sync_summary)
  const tracks = result.active_tasks?.tracks
  if (Array.isArray(tracks)) {
    lines.push("", `Active tasks (${result.active_tasks.task_count}):`)
    if (tracks.length === 0) lines.push("- none")
    for (const track of tracks) for (const task of track.tasks) lines.push(taskLine(track, task))
  } else if (result.status !== "setup_required") {
    lines.push("", "Active tasks: unavailable (see degraded)")
  }
  if ((result.open_prs ?? []).length > 0) lines.push("", "Open pull requests:", ...result.open_prs.map(prLine))
  if ((result.repo_states ?? []).length > 0) lines.push("", "Repos of open tasks:", ...result.repo_states.map(repoLine))
  if ((result.push_accounts ?? []).length > 0) lines.push("", "Push routes:", ...pushRouteLines(result.push_accounts))
  lines.push(...namedTaskLines(result.task))
  if (result.agents_md) {
    // A heading, not a fence: the file's own text may hold any fence or rule line.
    lines.push("", `## The desk's AGENTS.md (${result.agents_md.path}); its rules bind this session`, "", result.agents_md.text.replace(/\n+$/u, ""))
    if (result.agents_md.truncated) lines.push("", `[Cut after ${result.agents_md.shownBytes} of ${result.agents_md.bytes} bytes (limit ${AGENTS_MD_CAP_BYTES / 1024} KB): read the rest at ${result.agents_md.path}]`)
  }
  return `${lines.join("\n")}\n`
}
