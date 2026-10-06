// The delivered tasks that still await the operator's sign-off. A task is
// delivered when its card is `done`; it is unsigned while the card's
// `signoff.state` is still `delivered_unsigned` (src/factory/outcome.js reads
// the record). A `done` card with no record was delivered before sign-off
// existed: it is counted as `not_recorded` and never listed.
//
// The scan is bounded. Live cards are all read (a desk holds few); archived
// cards are read at the head of the file only (frontmatter, never the body),
// newest 500 by modification time. When the cap cuts the scan, every count is
// a lower bound and says so.
//
// Titles and proof references are the operator's own words and appear only in
// what `unsignedDeliveries` returns, which boot shows in the operator's own
// session. `signoffStatus` carries counts and one age and nothing else; it is
// what `status.json.signoff` holds.

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs"
import * as path from "node:path"

import { loadFrontmatterParser } from "./organization.js"
import { outcomeState, recordFromLines, SIGNOFF_ALARM_DAYS } from "../factory/outcome.js"
import { writeStatus } from "../factory/outbox.js"
import { redactCredentialLikeText, redactName } from "../util/redact.js"

const parseFrontmatter = loadFrontmatterParser()

const DAY_MS = 86_400_000
const HEAD_BYTES = 16 * 1024
const TEXT_LIMIT = 80
const NO_PROOF = "no proof recorded"

const subfolders = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}
const visible = (names) => names.filter((name) => !name.startsWith("_"))

// The first bytes of a card, cut at its last line break so no line is half read, and whether the file went on past them. A card that cannot be opened is `{ missing: true }` when there is no file and `{ failed: true }` for any other reason.
function readHead(file) {
  let fd
  try {
    fd = openSync(file, "r")
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? { missing: true } : { failed: true }
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    const text = buffer.toString("utf8", 0, read).replace(/^\uFEFF/u, "")
    return read < HEAD_BYTES ? { text, cut: false } : { text: text.slice(0, Math.max(text.lastIndexOf("\n"), 0)), cut: true }
  } finally {
    closeSync(fd)
  }
}

// The frontmatter lines, or null when there is none. A head that was cut before the closing `---` is read as far as it goes only when it already holds the `signoff:` key; otherwise the card may carry one further down and is unreadable.
function frontmatterLines(text, cut) {
  const lines = text.split(/\r?\n/u)
  if (lines[0] !== "---") return null
  const end = lines.indexOf("---", 1)
  if (end !== -1) return lines.slice(1, end)
  const rest = lines.slice(1)
  return cut && !rest.some((line) => line.startsWith("signoff:")) ? null : rest
}

// One line of at most 80 characters: control characters become spaces, runs of space collapse.
const oneLine = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, TEXT_LIMIT) : "")

function isoOf(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function proofOf(evidence) {
  const ref = oneLine(evidence?.ref)
  if (ref === "") return NO_PROOF
  const kind = oneLine(evidence?.kind)
  return oneLine(redactCredentialLikeText(kind === "" ? ref : `${kind} ${ref}`))
}

// What one card says about its sign-off: `{ missing }` for a folder with no card, `{ unreadable }` for a card that cannot be read in full.
function readCard(file, { now }) {
  const head = readHead(file)
  if (head.missing) return { missing: true }
  const lines = head.failed ? null : frontmatterLines(head.text, head.cut)
  if (lines === null) return { unreadable: true }
  let data
  try {
    data = parseFrontmatter(`---\n${lines.join("\n")}\n---\n`).data
  } catch {
    return { unreadable: true }
  }
  const record = recordFromLines(lines)
  const status = typeof data.status === "string" ? data.status : null
  if (status !== "done") return { status }
  const state = outcomeState(record, status)
  const deliveredMs = isoOf(record.flow?.delivered_at) ?? isoOf(data.evidence?.recorded_at)
  return {
    status,
    state,
    title: oneLine(data.title),
    proof: proofOf(data.evidence),
    age_days: deliveredMs === null ? null : Math.floor(Math.max(now - deliveredMs, 0) / DAY_MS),
  }
}

// Every card folder of the desk and of each `desks/<alias>/` subtree: `{ file, desk, track, slug, archived }`.
function cardFiles(deskRoot) {
  const found = []
  const scanRoot = (base, desk) => {
    const add = (track, slug, folder, archived) => found.push({ file: path.join(folder, slug, "task.md"), desk, track, slug, archived })
    for (const track of visible(subfolders(base))) {
      if (desk === null && track === "desks") continue
      const trackDir = path.join(base, track)
      for (const slug of visible(subfolders(trackDir))) add(track, slug, trackDir, false)
      for (const slug of visible(subfolders(path.join(trackDir, "_archive")))) add(track, slug, path.join(trackDir, "_archive"), true)
    }
    for (const track of visible(subfolders(path.join(base, "_archive")))) {
      for (const slug of visible(subfolders(path.join(base, "_archive", track)))) add(track, slug, path.join(base, "_archive", track), true)
    }
  }
  scanRoot(deskRoot, null)
  for (const alias of visible(subfolders(path.join(deskRoot, "desks")))) scanRoot(path.join(deskRoot, "desks", alias), alias)
  return found
}

function modifiedAt(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

const trackOf = ({ desk, track }) => [desk, track].filter((part) => part !== null).map((part) => redactName(part)).join("/")

/**
 * `{ count, at_least, overdue, oldest_age_days, not_recorded, tasks }` for the desk at `deskRoot`. `now` is milliseconds (or a
 * Date). `count` is the unsigned deliveries found; `at_least` is true when the archive cap cut the scan, so every figure is then
 * a lower bound. `tasks` is the oldest `shown` of them, oldest first, a card of unknown age last:
 * `{ track, slug, title, age_days, overdue, proof }` (with `desk` first in `track` for a crew desk). `oldest_age_days` ignores a
 * card of unknown age and is null when none has a known age.
 */
export function unsignedDeliveries(deskRoot, { now, archiveCap = 500, shown = 15 }) {
  const at = now instanceof Date ? now.getTime() : now
  if (typeof at !== "number" || !Number.isFinite(at)) throw new TypeError("now must be a time in milliseconds")
  const all = cardFiles(deskRoot)
  const archived = all.filter((entry) => entry.archived).map((entry) => ({ ...entry, modified: modifiedAt(entry.file) })).sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file))
  const scanned = [...all.filter((entry) => !entry.archived), ...archived.slice(0, archiveCap)]
  const unsigned = []
  let notRecorded = 0
  let unreadable = 0
  for (const entry of scanned) {
    const card = readCard(entry.file, { now: at })
    if (card.unreadable) unreadable += 1
    if (card.missing || card.unreadable || card.status !== "done") continue
    if (card.state === "not_recorded") notRecorded += 1
    else if (card.state === "delivered_unsigned") unsigned.push({ track: trackOf(entry), slug: redactName(entry.slug), title: card.title, age_days: card.age_days, overdue: card.age_days !== null && card.age_days >= SIGNOFF_ALARM_DAYS, proof: card.proof })
  }
  const ordered = unsigned.sort((a, b) => (a.age_days === null) - (b.age_days === null) || (b.age_days ?? 0) - (a.age_days ?? 0) || `${a.track}/${a.slug}`.localeCompare(`${b.track}/${b.slug}`))
  const ages = ordered.filter((task) => task.age_days !== null).map((task) => task.age_days)
  return {
    count: ordered.length,
    at_least: archived.length > archiveCap,
    overdue: ordered.filter((task) => task.overdue).length,
    oldest_age_days: ages.length === 0 ? null : Math.max(...ages),
    not_recorded: notRecorded,
    unreadable,
    tasks: ordered.slice(0, shown),
  }
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

/**
 * `status.json.signoff` for a scan: counts and one age, each `{ state, value }`, and a time. Nothing that names a task. When the
 * archive cap cut the scan every figure is a lower bound and its state is `partial`. The oldest age is `unavailable` when there is
 * none to report: `none_unsigned` when nothing is unsigned, `age_unknown` when none of the unsigned has a readable delivery time.
 */
export function signoffStatus(found, now) {
  const unreadable = (found.unreadable ?? 0) > 0
  const reason = found.at_least ? { reason: "archive_cap" } : unreadable ? { reason: "cards_unreadable" } : {}
  const state = found.at_least || unreadable ? "partial" : "measured"
  const figure = (value) => ({ state, value, ...reason })
  const oldest = found.oldest_age_days === null ? { state: "unavailable", reason: found.count > 0 ? "age_unknown" : unreadable && !found.at_least ? "cards_unreadable" : "none_unsigned" } : figure(found.oldest_age_days)
  return { checked_at: new Date(now).toISOString(), unsigned: figure(found.count), overdue: figure(found.overdue), oldest_unsigned_age_days: oldest, not_recorded: figure(found.not_recorded) }
}

// The one place the figures are merged into `status.json`; the file's other keys stay as they are.
const mergeSignoff = (env, signoff) => writeStatus(env, { signoff })

/**
 * Scans the desk and writes `status.json.signoff`; returns the scan. A scan that throws writes `{ state: "unavailable", reason:
 * "scan_failed" }` for every figure, never a zero, and returns null. `scan` is the scan to run (a test passes a failing one).
 */
export async function refreshSignoffStatus(env, deskRoot, { now, scan = unsignedDeliveries }) {
  let found = null
  let signoff
  try {
    found = scan(deskRoot, { now })
    signoff = signoffStatus(found, now)
  } catch {
    const failed = { state: "unavailable", reason: "scan_failed" }
    signoff = { checked_at: new Date(now).toISOString(), unsigned: failed, overdue: failed, oldest_unsigned_age_days: failed, not_recorded: failed }
  }
  await mergeSignoff(env, signoff)
  return found
}

/**
 * What boot calls: the scan, with the counts recorded. Recording is a convenience: a state folder that cannot be written never
 * hides the list. Returns the scan, or null when the scan itself failed.
 */
export async function recordUnsigned(env, deskRoot, now, { scan = unsignedDeliveries } = {}) {
  try {
    return await refreshSignoffStatus(env, deskRoot, { now, scan })
  } catch {
    try {
      return scan(deskRoot, { now })
    } catch {
      return null
    }
  }
}

/** The one instruction, as a list of zero or one lines: none when nothing is unsigned or the session has no operator in it. */
export function signoffInstructions(found, { noninteractive }) {
  if (noninteractive || !found || found.count === 0) return []
  const { count, oldest_age_days: oldest } = found
  const atLeast = found.at_least || (found.unreadable ?? 0) > 0
  const lead = atLeast ? "at least " : ""
  const age = oldest === null ? "of unknown age" : `the oldest for ${atLeast ? "at least " : ""}${plural(oldest, "day", "days")}`
  const head = count === 1 ? `${lead}1 delivered task awaits sign-off, ${age}.` : `${lead}${count} delivered tasks await sign-off, ${age}.`
  const raise = count === 1 ? "raise it, once, as three lines (asked, delivered with proof, accept or send back), and record the answer" : "raise them together, once, each as three lines (asked, delivered with proof, accept or send back), and record each answer"
  return [`${head} Finish what the operator asked first. Then ${raise} with task_signoff. Do not raise ${count === 1 ? "it" : "them"} in a noninteractive session.`]
}

/** The boot text section: one line per listed task, `<track>/<slug>, <age>, <proof>`, with `overdue` marked, and one line when some cards could not be read. Empty when there is nothing to say. */
export function unsignedLines(found) {
  if (!found) return []
  const unread = found.unreadable > 0 ? [`${plural(found.unreadable, "task card", "task cards")} could not be read, so this list may be short.`] : []
  if (found.count === 0) return unread.length === 0 ? [] : ["", ...unread]
  const lines = found.tasks.map((task) => `- ${task.track}/${task.slug}, ${task.age_days === null ? "age unknown" : plural(task.age_days, "day", "days")}, ${task.proof}${task.overdue ? ", overdue" : ""}`)
  if (found.count > found.tasks.length) lines.push(`- ...and ${found.count - found.tasks.length} more`)
  return ["", "Delivered, awaiting sign-off:", ...lines, ...unread]
}
