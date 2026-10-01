// The boot script's readable output. Agents read the boot result straight off a Bash call, and round B's critiques
// all said the same thing: the instructions sat buried in a JSON array among fields they did not need. By default the
// script now prints plain text (a status line, the desk's path, the numbered instructions, then the data), and
// `--json` keeps the structured result for tools and tests. This module also holds the two pieces of desk state the
// text shows that are not part of the scan itself: the desk's own AGENTS.md (included, size-capped, so no agent has
// to be told to go and read it) and when the local desk was last in sync with its remote.

import { execFileSync } from "node:child_process"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import * as path from "node:path"

/** How much of the desk's AGENTS.md boot prints; the rest stays in the file, named by its path. */
export const AGENTS_MD_CAP_BYTES = 6 * 1024

/**
 * The desk's AGENTS.md as `{ path, text, truncated }`, at most `cap` bytes of text, or null when the desk has none or
 * it cannot be read. A cut never ends in the middle of a character.
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
    const truncated = bytesRead > cap
    const text = buffer.toString("utf8", 0, Math.min(bytesRead, cap)).replace(/�$/u, "")
    return { path: file, text, truncated }
  } finally {
    closeSync(fd)
  }
}

/** When the desk's last fetch finished (FETCH_HEAD's modified time) as ISO text, or null when it never fetched or git cannot say. */
export function lastSyncedAt(root, { runGit = execFileSync, stat = statSync } = {}) {
  try {
    const gitDir = runGit("git", ["-C", root, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", timeout: 5000 }).trim()
    return new Date(stat(path.join(gitDir, "FETCH_HEAD")).mtimeMs).toISOString()
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

/**
 * One plain sentence about the sync, never a word like "partial": a failed sync pulled nothing and pushed nothing.
 * `sync` is `syncWorkspace`'s answer (null when it did not return one); `timedOut` says the boot's time budget ended
 * it; `lastSyncAt` is ISO text or null.
 */
export function syncSummary({ sync, timedOut = false, lastSyncAt = null }) {
  const asOf = `local desk is as of ${lastSyncAt ?? "unknown"}`
  const failed = (why) => `sync failed: ${why}; nothing was pulled or pushed; ${asOf}`
  if (timedOut) return failed("it did not finish within the boot's time budget")
  if (sync === null || sync === undefined) return failed("it did not run")
  if (sync.state === "unresolved") return failed(FAILURE_WORDS[sync.cause] ?? "the pull did not complete")
  if (sync.state === "quarantined") {
    const count = Array.isArray(sync.quarantinedPaths) ? sync.quarantinedPaths.length : 0
    return `sync ok: moved ${count} stray untracked path${count === 1 ? "" : "s"} to _cache/ first, then pulled`
  }
  return "sync ok"
}

function taskLine(track, task) {
  const named = `${track.desk ? `${track.desk}/` : ""}${track.track}/${task.slug}`
  const title = typeof task.title === "string" && task.title !== task.slug ? ` "${task.title}"` : ""
  const hidden = /redacted/u.test(named) ? ` (handle ${task.handle})` : ""
  const updated = typeof task.updated === "string" ? `, updated ${task.updated.slice(0, 10)}` : ""
  return `- ${named}${title}: ${task.status ?? "no status"}${updated}${hidden}`
}

function repoLine(state) {
  const where = `${state.desk ? `${state.desk}/` : ""}${state.track}/${state.slug}`
  if (state.present === false) return `- ${state.repo} (${where}): not at ${state.local_path}${state.url ? `; clone url ${state.url}` : ""}`
  const sync = state.local_only ? "no remote configured" : state.fetched ? "fetched" : "fetch failed"
  return `- ${state.repo} (${where}): branch ${state.branch ?? "unknown"}, ${state.dirty ? "uncommitted changes" : "clean"}, ${sync}`
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
  lines.push(...namedTaskLines(result.task))
  if (result.agents_md) {
    lines.push("", `The desk's AGENTS.md (${result.agents_md.path}); its rules bind this session:`, "-----", result.agents_md.text.replace(/\n+$/u, ""), "-----")
    if (result.agents_md.truncated) lines.push(`[Cut at ${AGENTS_MD_CAP_BYTES / 1024} KB: read the rest at ${result.agents_md.path}]`)
  }
  return `${lines.join("\n")}\n`
}
