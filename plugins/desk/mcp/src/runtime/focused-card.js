// The focused task card of a stalled session: where its card is, whether the card says the session may rest, and the nudge text.
// This file imports only `node:` built-ins and Desk's lifecycle list: the poller runs from a bare checkout with no installed
// dependencies, so it cannot use the card parser (gray-matter) or the blocker reader in desk/active-tasks.js, and reads the three
// frontmatter keys and the blocker it needs itself.
// Shared by the poller (`stalled.js`, run by an always-on agent runtime) and by Desk's own fallback in a session (`desk_status`
// and the first reply, see docs/stalled-nudges.md). Nothing here writes.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { TERMINAL_STATES } from "../desk/lifecycle.js"

/** The nudge's opening words; a runner that supports `replaces` takes an older copy of it back from a session's queue. */
export const NUDGE_PREFIX = "Your focused card isn't done and nothing is running:"
const NUDGE_BODY = "walk its definition of done; continue, or write the final report (Asked / Delivered / Accept or send back?)."

/** What a wake says. `idle` is a number of minutes. */
export function nudgeText({ track, slug, status, idle }) {
  return `${NUDGE_PREFIX} ${NUDGE_BODY} Card: ${track}/${slug} (${status}), idle ${idle}m. If you are waiting on a person, write the blocker and its date on the card; to stop these nudges set \`nudge: false\` in its frontmatter.`
}

/** What a session sees when it is still running but its card has not moved (the fallback inside a session, where "nothing is running" is not knowable). */
function staleCardText({ track, slug, status, quiet }) {
  return `Your focused card ${track}/${slug} (${status}) isn't done and hasn't moved in ${quiet}m: walk its definition of done; continue, or write the final report (Asked / Delivered / Accept or send back?). If you are waiting on a person, write the blocker and its date on the card; to stop these nudges set \`nudge: false\` in its frontmatter.`
}

// A desk workspace has `_meta/` plus either `_archive/` (a solo desk) or `desks/` (a Crew workspace), as util/paths.js decides.
function isDeskWorkspace(dir) {
  return isDir(path.join(dir, "_meta")) && (isDir(path.join(dir, "_archive")) || isDir(path.join(dir, "desks")))
}

const isDir = (dir) => {
  try {
    return readdirSync(dir) !== null
  } catch {
    return false
  }
}

/** Every folder that can hold `<track>/<slug>/task.md` for a session: desk roots (its working folder, its Git root, `extra`, then the desks in the home folder) and, in a Crew workspace, each member's desk. The session's own folders come first. */
export function cardBases({ cwd, gitRoot, extra, homeDir }) {
  const roots = []
  const add = (dir) => {
    if (typeof dir === "string" && dir !== "" && !roots.includes(dir) && isDeskWorkspace(dir)) roots.push(dir)
  }
  for (const dir of [cwd, gitRoot, ...extra]) add(dir)
  for (const entry of readdirSync(homeDir, { withFileTypes: true })) if (entry.isDirectory()) add(path.join(homeDir, entry.name))
  const bases = []
  for (const root of roots) {
    bases.push(root)
    const desks = path.join(root, "desks")
    if (!isDir(desks)) continue
    for (const entry of readdirSync(desks, { withFileTypes: true })) if (entry.isDirectory()) bases.push(path.join(desks, entry.name))
  }
  return bases
}

const LAYOUTS = (track, slug) => [[track, slug], [track, "_archive", slug], ["_archive", track, slug], ["_archive", track, "_archive", slug]]

/** The focused card: `{ file, archived, data, content }` from the first base that holds it, or null. */
export function findFocusedCard(bases, { track, slug }) {
  for (const base of bases) {
    for (const segments of LAYOUTS(track, slug)) {
      const file = path.join(base, ...segments, "task.md")
      if (existsSync(file)) return { file, archived: segments.includes("_archive"), ...parseCard(readFileSync(file, "utf8")) }
    }
  }
  return null
}

/** `{ data: { status, nudge, updated }, content }` from a card's text: the top-level frontmatter keys Desk reads here, and the body. */
function parseCard(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/u.exec(raw)
  const data = {}
  for (const line of (match?.[1] ?? "").split(/\r?\n/u)) {
    const pair = /^(status|nudge|updated):[ \t]*(.*?)[ \t]*$/u.exec(line)
    if (pair === null) continue
    const value = pair[2].replace(/^(['"])(.*)\1$/u, "$2")
    data[pair[1]] = value
  }
  return { data, content: match?.[2] ?? "" }
}

const BLOCKER_HEADING = /^#{1,6}[ \t]+(?:blockers?|waiting on|blocked on|blocked by)[ \t]*:?[ \t]*$/iu
const BLOCKER_LINE = /^(?:[-*+][ \t]+)?(?:>[ \t]*)?(?:\*\*(?:blockers?|waiting on|blocked on|blocked by):?\*\*:?|(?:blockers?|waiting on|blocked on|blocked by):)[ \t]*(.*)$/iu
const NO_BLOCKER = /^(?:none|n\/a|na|nil|no blockers?|nothing|-|—)\.?$/iu

/** The card's recorded blocker as one line (a `## Blocker`, `## Blockers` or `## Waiting on` section, or a `Blocker:` line), or null. */
function blockerOf(content) {
  const lines = content.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    let text = null
    if (BLOCKER_HEADING.test(lines[index].trim())) {
      let end = index + 1
      while (end < lines.length && !/^#{1,6}\s/u.test(lines[end])) end += 1
      text = lines.slice(index + 1, end).join(" ")
    } else {
      text = BLOCKER_LINE.exec(lines[index].trim())?.[1] ?? null
    }
    const clean = text === null ? "" : text.replace(/\s+/gu, " ").trim()
    if (clean !== "" && !NO_BLOCKER.test(clean)) return clean
  }
  return null
}

const GATE_WORD = /\b(?:approv\w*|sign-?off|review\w*|decision|decide|operator|requester|human|owner|go-ahead|answer|repl(?:y|ies)|response)\b|^waiting on\b/iu
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/u
const OTHER_DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/iu

/** Whether a blocker names a person's decision and a date, so the session is waiting rather than stalled. An ISO date already past means the wait is overdue, which is not a reason to rest. */
export function namesHumanGate(blocker, now) {
  if (blocker === null || !GATE_WORD.test(blocker)) return false
  const iso = ISO_DATE.exec(blocker)?.[1]
  if (iso !== undefined) return Date.parse(`${iso}T23:59:59Z`) >= now
  return OTHER_DATE.test(blocker)
}

/**
 * Why a card lets its session rest, or null when the card is unfinished and nothing excuses it: a finished or archived card, a card
 * that opted out (`nudge: false`), a task waiting for a person's approval (`collaborating`), or a blocker that names a person's
 * decision and a date.
 */
export function cardRestReason(card, now) {
  const status = cardStatus(card)
  if (card.archived || TERMINAL_STATES.includes(status)) return `the card is ${card.archived ? "archived" : status}`
  if (String(card.data.nudge).toLowerCase() === "false") return "the card says nudge: false"
  if (status === "collaborating") return "the card is collaborating: it waits for a person's approval"
  const blocker = blockerOf(card.content)
  if (namesHumanGate(blocker, now)) return `the card's blocker names a person's decision and a date: ${blocker.slice(0, 120)}`
  return null
}

export const cardStatus = (card) => card.data.status ?? "unknown"

/** Minutes since the card's `updated` stamp, or null when it has none. */
function minutesSinceUpdated(card, now) {
  const at = Date.parse(String(card.data.updated))
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null
}

const STALE_MINUTES = 15

/** The fallback's lead line for a session that is still running: its focused card is unfinished, nothing excuses it, and it has not been updated for 15 minutes. Null otherwise. */
export function staleCardLead({ bases, focus, now }) {
  const card = findFocusedCard(bases, focus)
  if (card === null || cardRestReason(card, now) !== null) return null
  const quiet = minutesSinceUpdated(card, now)
  return quiet === null || quiet < STALE_MINUTES ? null : staleCardText({ track: focus.track, slug: focus.slug, status: cardStatus(card), quiet })
}
