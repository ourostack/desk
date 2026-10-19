// task_focus — a session's main agent declares the task it is working on.
//
// The factory reads these calls from the transcript to credit the session's time to that task (the transcript is the
// only record: nothing here is written to disk). The call is light on purpose: no network, no git, no card write. It
// answers with the card's status and its last progress entries, so declaring is also the cheapest way to see where
// the task stands.
//
// The held focus lives in the session layer (runtime/desk-session.js), handed in as `statusContext.focus`:
// `{ get(): { track, slug } | null, set(value), declared(): boolean }`. The hints built here are only hints:
// no tool call fails, waits or changes because focus is unset or different, and every hint is worded for the
// session's main agent because a subagent shares the session's server.

import { readMarkdown, pathExists } from "../util/fm.js"
import { EFFECTIVE_ROOT_MISSING, resolveWriteTarget, validateWriteSegment } from "../util/paths.js"
import { recentProgress } from "./task-body.js"
import { nextStepOf } from "../desk/active-tasks.js"
import { redactCredentialLikeText } from "../util/redact.js"
import { makeSessionLabelProposal } from "../runtime/session-label.js"
import { archiveDueAnswer } from "./task-archive-due.js"

export const TASK_FOCUS_FIELDS = ["track", "slug", "clear", "display_label"]

/** How many progress entries a focus answer carries, and the longest an entry may be (longer ones end in an ellipsis). */
export const PROGRESS_ENTRIES = 5
export const PROGRESS_ENTRY_CHARS = 300

const ACCEPTED = "pass `track` and `slug` to focus a task, or `clear: true` alone to declare no task; `display_label` is optional only with a task"

export const NO_FOCUS_HINT = "If you are the session's main agent: no task in focus; call task_focus with the task you are working on, or with clear: true for none."
export const focusedHint = ({ track, slug }) => `If you are the session's main agent: focused on ${track}/${slug}; call task_focus if you have switched tasks, or with clear: true for none.`

const sameTask = (a, b) => a.track === b.track && a.slug === b.slug

function folderName(field, value) {
  if (typeof value !== "string") throw new Error(`task_focus: \`${field}\` must be a string; ${ACCEPTED}`)
  try {
    validateWriteSegment(value)
  } catch {
    throw new Error(`task_focus: \`${field}\` is not a valid task folder name; ${ACCEPTED}`)
  }
  return value
}

// The card at its live path, else under the track's `_archive`, else in a track that was archived whole into the desk's `_archive/`
// (`trackArchived`; the track is archived once its tasks are terminal, often before the operator answers a delivery). A missing
// person folder reads as a missing card.
export async function findCard({ deskRoot, person, track, slug }) {
  const layouts = [[track, slug, "task.md"], [track, "_archive", slug, "task.md"], ["_archive", track, slug, "task.md"], ["_archive", track, "_archive", slug, "task.md"]]
  for (const segments of layouts) {
    let file
    try {
      file = await resolveWriteTarget({ deskRoot, person, segments, createPersonRoot: false })
    } catch (error) {
      if (!String(error?.message).startsWith(EFFECTIVE_ROOT_MISSING)) throw error
      return null
    }
    if (await pathExists(file)) return { file, archived: segments.includes("_archive"), trackArchived: segments[0] === "_archive" }
  }
  return null
}

/**
 * task_focus
 *
 * Input: { track, slug } or { clear: true }
 *
 * Returns: { status: "focused", track, slug, task_status, recent_progress: [string], next_step: string | null, archived?: true } or
 * { status: "cleared" }. A card found only under `_archive/` is still focused (a session may be wrapping up or
 * reopening finished work) and the answer says `archived: true`. `recent_progress` is the last PROGRESS_ENTRIES entries
 * of the card's `## Progress log`, each cut to PROGRESS_ENTRY_CHARS characters, and is empty when the card has none.
 * Throws `card not found: <track>/<slug>` for a missing card, leaving the focus as it was.
 */
export async function taskFocus({ deskRoot, input, person = null, statusContext = {} }) {
  const values = input ?? {}
  const { track, slug, clear, display_label: displayLabel } = values
  const named = track !== undefined || slug !== undefined
  if (clear !== undefined && clear !== true) throw new Error(`task_focus: \`clear\` can only be true; ${ACCEPTED}`)
  if (clear === true && named) throw new Error(`task_focus: \`clear\` cannot be combined with \`track\` or \`slug\`; ${ACCEPTED}`)
  if (clear === true && displayLabel !== undefined) throw new Error(`task_focus: \`clear\` cannot be combined with \`display_label\`; ${ACCEPTED}`)
  if (clear === true) {
    statusContext.focus?.set(null)
    return { status: "cleared" }
  }
  if (track === undefined || slug === undefined) throw new Error(`task_focus: \`track\` and \`slug\` are both required; ${ACCEPTED}`)
  folderName("track", track)
  folderName("slug", slug)

  const found = await findCard({ deskRoot, person, track, slug })
  if (found === null) throw new Error(`card not found: ${track}/${slug}`)
  const card = await readMarkdown(found.file)
  statusContext.focus?.set({ track, slug })
  const result = {
    status: "focused",
    track,
    slug,
    task_status: typeof card.data.status === "string" ? card.data.status : null,
    recent_progress: recentProgress(card.content, PROGRESS_ENTRIES, PROGRESS_ENTRY_CHARS).map(redactCredentialLikeText),
    next_step: nextStepOf(card.content),
  }
  if (card.data.planning_complete === true) result.planning_complete = true
  if (found.archived) result.archived = true
  result.session_label = makeSessionLabelProposal({ task: { track, slug }, displayLabel })
  Object.assign(result, archiveDueAnswer({ track, slug, status: card.data.status, archived: found.archived }))
  return result
}

/**
 * The `focus_note` hint a task tool adds to its result, or undefined. `target` is the card an update or archive acted
 * on: a different card than the focus gets the "focused on" hint. With nothing focused and nothing ever declared (a focus
 * set, or a deliberate clear), every task tool call gets the "no task in focus" hint.
 */
export function focusNote(statusContext, target) {
  const focus = statusContext?.focus
  if (!focus) return undefined
  const current = focus.get()
  if (current === null) return focus.declared() ? undefined : NO_FOCUS_HINT
  return target !== undefined && !sameTask(current, target) ? focusedHint(current) : undefined
}
