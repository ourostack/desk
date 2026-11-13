// Plans the Markdown link rewrites a task_archive move needs, before the folder moves, and applies them afterwards. A file that cannot be
// checked or rewritten is reported in the `links` report; it never stops the archive.
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { rewriteForMove } from "../util/archive-links.js"
import { isGitRepository } from "../util/git-stage.js"

const SKIP_DIRS = new Set(["node_modules", ".git", ".state", "_cache"])
const posixPath = (file) => file.split(path.sep).join("/")
const deskPath = (root, file) => posixPath(path.relative(root, file))
const under = (target, prefix) => target === prefix || target.startsWith(`${prefix}/`)
const NOT_UTF8 = "the file is not UTF-8 text, so its links were not checked"

async function markdownFiles(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await markdownFiles(file, out)
    } else if (entry.isFile() && entry.name.endsWith(".md")) out.push(file)
  }
  return out
}

// The text only when its bytes survive a UTF-8 round trip, so a rewrite can never change another byte.
function utf8Text(buffer) {
  const text = buffer.toString("utf8")
  return Buffer.from(text, "utf8").equals(buffer) ? text : null
}

function gitHasOutsideEdits(root, rel, spawnGit) {
  if (!isGitRepository(root, spawnGit)) return false
  return [
    ["diff", "--name-only", "--", rel],
    ["diff", "--cached", "--name-only", "--", rel],
    ["ls-files", "--others", "--exclude-standard", "--", rel],
  ].some((args) => {
    const answer = spawnGit("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout: 10000 })
    return answer.status !== 0 || String(answer.stdout).trim() !== ""
  })
}

function noteUnresolved(state, file, unresolved) {
  for (const miss of unresolved) state.not_rewritten.push({ file, destination: miss.destination, reason: miss.reason })
}

/** The `links` field of an archive result, with paths as `display(rel)` names them; null when nothing was found. */
export function linksReport(state, display) {
  if (!state.rewritten.length && !state.not_rewritten.length) return null
  return {
    rewritten: state.rewritten.map(display),
    not_rewritten: state.not_rewritten.map((entry) => ({ ...entry, file: display(entry.file) })),
  }
}

/* istanbul ignore next -- defensive: the desk cannot be listed (an unreadable folder); the archive goes ahead and the report says so. */
function planFailed(state, label, error, trackPlan) {
  state.not_rewritten.push({ file: label, reason: `links were not checked: ${error.message}` })
  return { plan: null, state, trackPlan }
}

async function composeTrackLinks({ plan, trackPlan, trackFile, trackRel, trackText, effectiveRoot, spawnGit }) {
  const state = plan.state
  const linked = rewriteForMove({
    text: trackPlan ? trackPlan.after : trackText, filePath: trackRel,
    sourcePrefix: plan.sourcePrefix, destinationPrefix: plan.destinationPrefix,
  })
  noteUnresolved(state, trackRel, linked.unresolved)
  if (linked.rewritten === 0) return trackPlan
  if (gitHasOutsideEdits(effectiveRoot, trackRel, spawnGit)) {
    state.not_rewritten.push({ file: trackRel, reason: "the track card has unstaged, staged or untracked changes, so another session may be editing it; its links were left as they were" })
    return trackPlan
  }
  state.rewritten.push(trackRel)
  return { file: trackFile, before: trackPlan ? trackPlan.before : trackText, after: linked.text }
}

/**
 * Lists what moving `srcDir` to `archiveDir` affects, before anything moves: the task's own Markdown files (outbound) and every other
 * Markdown file in the desk that links into the task (inbound). `track.md` is folded into the track update the archive already makes,
 * so the returned `trackPlan` carries its rewritten links into the same commit. When the desk cannot be listed, `plan` is null and the
 * reason is in `state`. Returns `{ plan, state, trackPlan }`.
 */
export async function planArchiveLinks({ effectiveRoot, srcDir, archiveDir, track, slug, trackFile, trackPlan, spawnGit }) {
  const state = { rewritten: [], not_rewritten: [] }
  try {
    const sourcePrefix = deskPath(effectiveRoot, srcDir)
    const destinationPrefix = deskPath(effectiveRoot, archiveDir)
    const plan = {
      sourcePrefix, destinationPrefix, state,
      outbound: (await markdownFiles(srcDir)).map((file) => posixPath(path.relative(srcDir, file))),
      inbound: [],
    }
    const trackRel = `${track}/track.md`
    let trackText = null
    for (const file of await markdownFiles(effectiveRoot)) {
      const rel = deskPath(effectiveRoot, file)
      if (under(rel, sourcePrefix)) continue
      try {
        const buffer = await fs.readFile(file)
        if (!buffer.toString("utf8").includes(slug)) continue
        const text = utf8Text(buffer)
        if (text === null) {
          state.not_rewritten.push({ file: rel, reason: NOT_UTF8 })
          continue
        }
        if (rel === trackRel) {
          trackText = text
          continue
        }
        const linked = rewriteForMove({ text, filePath: rel, sourcePrefix, destinationPrefix })
        if (linked.rewritten === 0 && linked.unresolved.length === 0) continue
        plan.inbound.push({ file, rel, before: buffer, after: linked.text, rewritten: linked.rewritten, unresolved: linked.unresolved })
      } catch (error) {
        /* istanbul ignore next -- defensive: a file listed a moment ago cannot be read; the report names it and the archive goes ahead. */
        state.not_rewritten.push({ file: rel, reason: error.message })
      }
    }
    const nextTrackPlan = trackText === null ? trackPlan
      : await composeTrackLinks({ plan, trackPlan, trackFile, trackRel, trackText, effectiveRoot, spawnGit })
    return { plan, state, trackPlan: nextTrackPlan }
  } catch (error) {
    /* istanbul ignore next -- see planFailed. */
    return planFailed(state, `${track}/${slug}`, error, trackPlan)
  }
}

/**
 * Applies a plan after the folder has moved: the task's other Markdown files are rewritten in place, and inbound files go through
 * `prepared.relinkInbound`, which also stages them into the archive commit. Never throws.
 */
export async function relinkArchiveLinks({ plan, prepared, archiveDir, noteChange }) {
  const { state, sourcePrefix, destinationPrefix } = plan
  for (const name of plan.outbound) {
    if (name === "task.md") continue
    const file = path.join(archiveDir, name)
    const rel = `${destinationPrefix}/${name}`
    try {
      const text = utf8Text(await fs.readFile(file))
      if (text === null) {
        state.not_rewritten.push({ file: rel, reason: NOT_UTF8 })
        continue
      }
      const linked = rewriteForMove({ text, filePath: rel, sourcePrefix, destinationPrefix })
      noteUnresolved(state, rel, linked.unresolved)
      if (linked.rewritten === 0) continue
      await fs.writeFile(file, linked.text)
      await prepared.cardWritten(linked.text, name)
      state.rewritten.push(rel)
      noteChange(file)
    } catch (error) {
      /* istanbul ignore next -- defensive: a file of the moved folder that cannot be read or written; the report names it and the archive is already moved. */
      state.not_rewritten.push({ file: rel, reason: error.message })
    }
  }
  for (const candidate of plan.inbound) {
    noteUnresolved(state, candidate.rel, candidate.unresolved)
    if (candidate.rewritten === 0) continue
    let reason = null
    try {
      reason = await prepared.relinkInbound(candidate.file, candidate.before, candidate.after)
    } catch (error) {
      /* istanbul ignore next -- defensive: a Git read that fails after the planned bytes were checked; the file is reported, never guessed at. */
      reason = error.message
    }
    if (reason === null) {
      state.rewritten.push(candidate.rel)
      noteChange(candidate.file)
    } else state.not_rewritten.push({ file: candidate.rel, reason: `its links were not rewritten: ${reason}` })
  }
}

/**
 * Rewrites the task card's own links for the move. `text` is the card's text as the archive will commit it. The card on disk must
 * still hold exactly `text`; otherwise nothing is written and the card's own write check reports the change. Returns the text to commit.
 */
export async function relinkCardLinks({ plan, text, cardFile, cardRel }) {
  const linked = rewriteForMove({ text, filePath: cardRel, sourcePrefix: plan.sourcePrefix, destinationPrefix: plan.destinationPrefix })
  noteUnresolved(plan.state, cardRel, linked.unresolved)
  if (linked.rewritten === 0) return text
  /* istanbul ignore next -- the card was written a moment ago; a mismatch is an outside edit, which the card's own write check reports. */
  if (!(await fs.readFile(cardFile)).equals(Buffer.from(text))) return text
  await fs.writeFile(cardFile, linked.text)
  plan.state.rewritten.push(cardRel)
  return linked.text
}
