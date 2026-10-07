// task_signoff — records the operator's answer to a delivered task: accepted or refused.
//
// The one tool that writes `signoff`. A call is recorded as the operator's answer: Desk does not check which turn or which agent made it.
//
// A refusal also sends the task back to `processing` and records the return (`refuse`), after bringing an archived card back to the live tree through
// `task_move`. The card is written, staged, committed and finalized the way `task_update` writes it. Everything is checked before anything is written.
//
// The answer carries the slug, codes and the desk-relative card path only: no title, no body text, no absolute path.

import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { readMarkdown, patchMarkdownFrontmatter } from "../util/fm.js"
import { validateWriteSegment } from "../util/paths.js"
import { readRecord, toFrontmatter, sign, refuse, STATUSES, REFUSAL_REASONS, RETURN_REASONS } from "../factory/outcome.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { findCard } from "./task-focus.js"
import { refreshSignoffStatus } from "../desk/unsigned-deliveries.js"
import { task_move } from "./move.js"
import { DESK_COMMIT_NOTE, relPath, stagingAllowed, stageAndCommitCard, headSha, updateTrackRow, taskJobOrNull, requestTaskFinalize } from "./task.js"

export const TASK_SIGNOFF_FIELDS = ["track", "slug", "outcome", "reason", "return_reason"]

const given = (value) => value !== undefined && value !== null

function folderName(field, value) {
  try {
    validateWriteSegment(value)
  } catch {
    throw new Error(`task_signoff: \`${field}\` is not a valid task folder name.`)
  }
}

// Everything the call can get wrong, checked before the card is read.
function checkInput(values) {
  const { track, slug, outcome, reason, return_reason: returnReason } = values
  if (typeof track !== "string" || typeof slug !== "string") throw new Error("task_signoff: `track` and `slug` are required.")
  if (outcome !== "accepted" && outcome !== "refused") throw new Error("task_signoff: `outcome` must be accepted or refused.")
  folderName("track", track)
  folderName("slug", slug)
  if (outcome === "accepted") {
    if (given(reason) || given(returnReason)) throw new Error("task_signoff: an acceptance takes no `reason` or `return_reason`; drop them.")
    return
  }
  if (!REFUSAL_REASONS.includes(reason)) throw new Error(`task_signoff: a refusal needs \`reason\`, the operator's reason, one of ${REFUSAL_REASONS.join(", ")}.`)
  if (!RETURN_REASONS.includes(returnReason)) throw new Error(`task_signoff: a refusal needs \`return_reason\`, your own reading of the cause, one of ${RETURN_REASONS.join(", ")}.`)
}

// The one sentence the agent includes in its reply.
export function sentence({ slug, outcome, reason, changed }) {
  const lead = changed ? "Recorded" : "Already recorded"
  if (outcome === "refused") return changed ? `${lead}: ${slug} sent back (${reason}); it is back in processing.` : `${lead}: ${slug} sent back.`
  return `${lead}: ${slug} accepted.`
}

/**
 * task_signoff
 *
 * Input: { track, slug, outcome: "accepted" | "refused", reason?, return_reason? }
 *
 * `reason` (the operator's, one of REFUSAL_REASONS) and `return_reason` (the agent's own reading, one of RETURN_REASONS) are required for a refusal and refused for an acceptance.
 * `now` (milliseconds), `finalize` and `refreshSignoff` are injected in tests; `refreshSignoff(env, deskRoot, { now })` refreshes `status.json.signoff`; the default is the session-start scan's own `refreshSignoffStatus`.
 *
 * Returns: { status: "signed" | "unchanged", path, signoff, say, report_as?, report_note?, commit?, desk_commit?, desk_pushed?, desk_note? }.
 * `say` is the sentence the agent includes in its reply. Every refusal of the call writes nothing.
 */
export async function taskSignoff({
  deskRoot, input, person = null, readiness, statusContext = {}, env = process.env, spawnGit = spawnSync,
  schedulePush = schedulePushDefault, now = Date.now, finalize = requestTaskFinalize, refreshSignoff = refreshSignoffStatus,
}) {
  const values = input ?? {}
  checkInput(values)
  const { track, slug, outcome, reason, return_reason: returnReason } = values

  const found = await findCard({ deskRoot, person, track, slug })
  if (found === null) throw new Error(`task_signoff: there is no task ${track}/${slug} in this desk; check the track and slug. Nothing was recorded.`)
  const card = await readMarkdown(found.file)
  if (card.data.status !== "done") {
    const shown = STATUSES.includes(card.data.status) ? card.data.status : "no recognised status"
    throw new Error(`task_signoff: only a delivered task can be signed; this one is at ${shown}.`)
  }

  const atMs = now()
  const at = new Date(atMs).toISOString()
  let signed
  try {
    signed = sign(readRecord(card.data), { status: "done", outcome, reason, returnReason, at })
  } catch (error) {
    throw new Error(`task_signoff: ${error.message}`)
  }
  const result = { status: "unchanged", path: relPath(deskRoot, found.file), signoff: signed.record.signoff }
  result.say = sentence({ slug, outcome, reason: signed.record.signoff.reason, changed: signed.changed })
  if (!signed.changed) return result

  const refused = outcome === "refused"
  const next = refused ? refuse(signed.record, { at, reason, returnReason }) : signed.record
  let file = found.file
  if (refused && found.archived) {
    try {
      await task_move({ deskRoot, input: { track, slug, unarchive: true }, person, readiness, statusContext, spawnGit, schedulePush })
    } catch (error) {
      throw new Error(`task_signoff: the archived task could not be brought back (${error.message}); nothing was recorded. Bring it back with task_move (unarchive: true), then call task_signoff again.`)
    }
    file = path.join(path.dirname(path.dirname(path.dirname(found.file))), slug, "task.md")
    result.path = relPath(deskRoot, file)
  }

  const stage = stagingAllowed(file, spawnGit)
  await patchMarkdownFrontmatter(file, { ...(refused ? { status: "processing" } : {}), updated: at.replace(/\.\d+Z$/u, "Z"), ...toFrontmatter(next) })
  const trackRow = refused ? await updateTrackRow({ filePath: file, slug, status: "processing", spawnGit }) : null
  const commit = stage ? stageAndCommitCard(file, `task_signoff: ${track}/${slug}`, spawnGit, trackRow === null ? [] : ["../track.md"]) : undefined
  if (stage && !commit) schedulePush({ root: deskRoot })
  const deskCommit = stage && !commit ? headSha(path.dirname(file), spawnGit) : null
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, file) }] })
  await finalize({ deskRoot, env, identity: await taskJobOrNull({ deskRoot, person, track, slug }) })
  try {
    await refreshSignoff(env, deskRoot, { now: atMs })
  } catch {
    console.error("desk_factory: signoff_status_refresh_deferred")
  }

  result.status = "signed"
  if (commit) result.commit = commit
  if (refused) {
    result.report_as = `Task ${slug} is back at processing (not done).`
    result.report_note = "Do not tell the operator this task is done; it is at processing."
  }
  if (deskCommit === null) return result
  // Said outright, and first, so no agent runs git for a card Desk has committed and is pushing.
  return { status: result.status, desk_note: DESK_COMMIT_NOTE, ...result, desk_commit: deskCommit, desk_pushed: false }
}
