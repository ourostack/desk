// Stalled-card nudges: a session whose turn ended with its focused task card unfinished, and nothing running, is told once to walk the
// card's definition of done and either continue or write the final report. It is the same contract as `drains.js poll` and
// `schedule poll`: no model turn here, the wakes are printed and the always-on runner delivers them and reports back with `ack`.
// The facts come from the Copilot app's own files: each session's history (session-activity.js) and its database (read-only).
// See docs/stalled-nudges.md.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { drainPaths, drainsHome, readDrainConfig } from "./drains.js"
import { NUDGE_PREFIX, cardBases, cardRestReason, cardStatus, findFocusedCard, nudgeText } from "./focused-card.js"
import { copilotHome, endsWithFinalReport, findFocus, lastActivity, openWork, readWorkspaceFile, sessionStateDir } from "./session-activity.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const STALLED_DEFAULTS = Object.freeze({ idleMinutes: 15, maxIdleHours: 24, desks: [] })

export function stalledPaths(options) {
  const home = drainsHome(options)
  return { config: path.join(home, "stalled.json"), state: path.join(home, "stalled-state.json"), lock: path.join(home, "stalled.lock") }
}

function problem(code, thing, probably, look, fix) {
  return new Error(deskFailure({ code, thing, probably, look, keepWorking: "no session was nudged and nothing was recorded", fix }))
}

/** The optional `stalled.json`: `idleMinutes` (default 15), `maxIdleHours` (24: older sessions are left alone) and `desks` (extra desk folders to look for cards in). A bad entry is an error, never a silent default. */
export function readStalledConfig(file) {
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return { ...STALLED_DEFAULTS }
    throw problem("desk_stalled_config_unreadable", "stalled-nudge config", `${file} cannot be read (${error.code}), probably because its owner or permissions changed`, "check the file's permissions", "fix them and run the command again")
  }
  const bad = (what) => problem("desk_stalled_config_invalid", "stalled-nudge config", `${file} ${what}, probably a hand edit`, "open the file and compare it with docs/stalled-nudges.md", "correct the entry and run the command again")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw bad("is not valid JSON")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw bad("is not an object")
  const { idleMinutes = STALLED_DEFAULTS.idleMinutes, maxIdleHours = STALLED_DEFAULTS.maxIdleHours, desks = [] } = parsed
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1) throw bad("has an idleMinutes that is not a whole number of minutes, 1 or more")
  if (!Number.isInteger(maxIdleHours) || maxIdleHours < 1) throw bad("has a maxIdleHours that is not a whole number of hours, 1 or more")
  if (!Array.isArray(desks) || desks.some((desk) => typeof desk !== "string" || desk.trim() === "")) throw bad("has a desks that is not a list of folder paths")
  return { idleMinutes, maxIdleHours, desks: desks.map((desk) => (desk.startsWith("~") ? path.join(os.homedir(), desk.slice(1)) : desk)) }
}

function readStalledStates(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sessions !== null && typeof parsed.sessions === "object" ? parsed : { sessions: {} }
  } catch {
    return { sessions: {} }
  }
}

function writeStalledStates(file, states) {
  assertNotRealStateUnderTest(path.dirname(file))
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`)
  renameSync(temporary, file)
}

/**
 * The app's database, read-only: `{ sessions: Map(id -> { title, running, archived }), childrenOf(id) }`, or null where it cannot be read
 * (no database, or a Node without `node:sqlite`). `childrenOf` lists the sessions a coordinator created and still coordinates.
 */
async function openAppDatabase(env) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(path.join(copilotHome(env), "data.db"), { readOnly: true })
    try {
      return readAppDatabase(db)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function readAppDatabase(db) {
  const sessions = new Map()
  for (const row of db.prepare("SELECT id, title, is_running, archived_at FROM sessions").all()) sessions.set(row.id, { title: row.title ?? null, running: row.is_running === 1, archived: row.archived_at != null })
  const children = new Map()
  for (const row of db.prepare("SELECT session_id, coordinating_creator_session_id AS parent, archived_at FROM workspaces WHERE coordinating_creator_session_id IS NOT NULL AND session_id IS NOT NULL").all()) {
    if (row.archived_at != null) continue
    children.set(row.parent, [...(children.get(row.parent) ?? []), row.session_id])
  }
  return { sessions, childrenOf: (id) => children.get(id) ?? [] }
}

const idOf = (id) => id.slice(0, 8)

// Whether a coordinated session is doing something now: the app says it runs, its last turn has not ended, or it ended less than `idleMs` ago (its report is about to reach the coordinator).
async function childBusy({ id, dir, database, now, idleMs }) {
  if (database.sessions.get(id)?.running) return true
  let last = null
  try {
    last = await lastActivity(path.join(dir, id, "events.jsonl"))
  } catch {
    // A lane whose history is gone is not running.
  }
  return last !== null && !last.closed && !last.stoppedByPerson && (!last.ended || now - last.ms < idleMs)
}

/**
 * Check one session, cheapest question first: `{ session, name, verdict: "nudge" | "leave", reason, ... }`, or null for a session that has been quiet longer
 * than `maxIdleHours`. A session is nudged only when its last turn ended `idleMinutes` or more ago, it declared a focused card
 * that is not finished, nothing runs (subagents, shell jobs, sessions it coordinates, the app's own running flag), nobody is
 * asked for anything (a question, a plan, a permission prompt, the card's own blocker) and this idle stretch has not been nudged.
 */
async function assessSession({ id, dir, now, config, database, drainSessions, state, homeDir }) {
  const file = path.join(dir, id, "events.jsonl")
  // A folder with no history, or one with no meaningful event in it, throws here and is left alone by assessSessions.
  if (now - statSync(file).mtimeMs > config.maxIdleHours * HOUR_MS) return null
  const idleMs = config.idleMinutes * MINUTE_MS
  const workspace = readWorkspaceFile(path.join(dir, id, "workspace.yaml"))
  const name = database?.sessions.get(id)?.title ?? workspace.name ?? idOf(id)
  const base = { session: id, name }
  const leave = (reason, more = {}) => ({ ...base, verdict: "leave", reason, ...more })
  const last = await lastActivity(file)
  if (last.closed) return leave("its window is closed", { early: true })
  if (last.stoppedByPerson) return leave("a person stopped it", { early: true })
  if (!last.ended) return leave("it is working", { early: true })
  const idle = Math.round((now - last.ms) / MINUTE_MS)
  if (now - last.ms < idleMs) return leave(`it has been idle ${idle}m, under ${config.idleMinutes}m`, { early: true })
  const row = database?.sessions.get(id)
  if (row?.archived) return leave("it is archived")
  if (row?.running) return leave("the app says it is running")
  if (drainSessions.has(id) || /^Drain: /u.test(row?.title ?? "")) return leave("it is a drain, which has its own wake")
  if (await endsWithFinalReport(file)) return leave("it wrote its final report and waits for the answer")
  const work = await openWork(file)
  if (work.waiting.length > 0) return leave(`it waits on a person: ${work.waiting[0]}`)
  if (work.subagents > 0) return leave(`running subagents: ${work.subagents}`)
  if (work.shells > 0) return leave(`running background shell jobs: ${work.shells}`)
  if (database !== null) {
    const busy = []
    for (const child of database.childrenOf(id)) if (await childBusy({ id: child, dir, database, now, idleMs })) busy.push(child)
    if (busy.length > 0) return leave(`running sessions it coordinates: ${busy.length}`)
  }
  const found = await findFocus(file, { cached: state?.focus ?? null })
  const focusCache = { size: found.size, focus: found.focus }
  if (found.focus === null) return leave("it has no focused card", { focusCache })
  const { track, slug } = found.focus
  const card = findFocusedCard(cardBases({ cwd: workspace.cwd, gitRoot: workspace.gitRoot, extra: config.desks, homeDir }), found.focus)
  if (card === null) return leave(`its card ${track}/${slug} was not found`, { focusCache })
  const rest = cardRestReason(card, now)
  if (rest !== null) return leave(rest, { focusCache, card: `${track}/${slug}` })
  if (state?.nudgedStretch === last.ms) return leave("it was already nudged for this idle stretch", { focusCache, card: `${track}/${slug}` })
  return { ...base, verdict: "nudge", reason: "its focused card is unfinished and nothing is running", card: `${track}/${slug}`, track, slug, cardStatus: cardStatus(card), idle, stretch: last.ms, focusCache }
}

/** Check every session under the app's session folder. */
export async function assessSessions({ now, config, env, states, homeDir, drainSessions, database }) {
  const dir = sessionStateDir(env)
  let ids = []
  try {
    ids = readdirSync(dir)
  } catch {
    // No session folder means no sessions on this machine.
  }
  const db = database === undefined ? await openAppDatabase(env) : database
  const results = []
  for (const id of ids) {
    try {
      const result = await assessSession({ id, dir, now, config, database: db, drainSessions, state: states.sessions[id], homeDir })
      if (result !== null) results.push(result)
    } catch {
      // A history that cannot be read is left alone: never a reason to nudge.
    }
  }
  return { results, ids, database: db }
}

function drainSessionsOf(env) {
  try {
    return new Set(readDrainConfig(drainPaths({ env }).config).map((drain) => drain.session))
  } catch {
    return new Set()
  }
}

const wakeIdOf = (result) => createHash("sha1").update(JSON.stringify([result.session, result.stretch, result.card])).digest("hex").slice(0, 16)

function statusLines(results, database) {
  const nudges = results.filter((result) => result.verdict === "nudge")
  const focused = results.filter((result) => result.verdict === "leave" && result.card !== undefined)
  const lines = [`stalled nudges: ${results.length} sessions active in the last day checked, ${nudges.length} to nudge now${database === null ? " (the app's database could not be read, so running sessions it coordinates are not seen)" : ""}`]
  for (const result of nudges) lines.push(`would nudge ${result.name} (${idOf(result.session)}) -> ${result.card} [${result.cardStatus}], idle ${result.idle}m`)
  for (const result of focused) lines.push(`leave ${result.name} (${idOf(result.session)}) -> ${result.card}: ${result.reason}`)
  return lines
}

/** What a poll would do now, recording nothing: the sessions to nudge and why each other session with a focused card is left alone. */
export async function stalledStatus({ paths, now, env, homeDir, database }) {
  const config = readStalledConfig(paths.config)
  const states = readStalledStates(paths.state)
  const { results, database: db } = await assessSessions({ now, config, env, states, homeDir, drainSessions: drainSessionsOf(env), database })
  return { checked: results.filter((result) => result.early !== true).map(({ focusCache, stretch, early, ...result }) => result), status: statusLines(results, db) }
}

/**
 * Print the nudges that are due. A session is offered one wake per idle stretch, with the same id on every poll until a delivery
 * lands, so a runner that holds it (the session still has the last wake queued) leaves exactly one nudge waiting. A session that
 * got going again drops its offer, and the next idle stretch may be nudged once more.
 */
export async function pollStalled({ paths, now, ackCommand, ackFlags, env, homeDir, database }) {
  const config = readStalledConfig(paths.config)
  const states = readStalledStates(paths.state)
  const { results, ids, database: db } = await assessSessions({ now, config, env, states, homeDir, drainSessions: drainSessionsOf(env), database })
  const next = { sessions: {} }
  const wakes = []
  for (const id of ids) {
    const previous = states.sessions[id]
    if (previous !== undefined) next.sessions[id] = { ...previous }
  }
  for (const result of results) {
    const state = (next.sessions[result.session] ??= {})
    if (result.focusCache !== undefined) state.focus = result.focusCache
    if (result.verdict !== "nudge") {
      delete state.offered
      continue
    }
    const id = wakeIdOf(result)
    state.offered = { id, stretch: result.stretch }
    wakes.push({ id, name: `stalled card: ${result.name}`, session: result.session, message: nudgeText({ track: result.track, slug: result.slug, status: result.cardStatus, idle: result.idle }), replaces: NUDGE_PREFIX, done: [...ackCommand, "stalled", "ack", "--session", result.session, "--wake", id, ...ackFlags] })
  }
  writeStalledStates(paths.state, next)
  const errors = Object.entries(next.sessions).filter(([, state]) => state.lastError).map(([session, state]) => ({ session, error: state.lastError }))
  return { at: new Date(now).toISOString(), wakes, errors, status: statusLines(results, db) }
}

/** Record how a wake went. A delivery that landed ends the idle stretch's nudge for good; a failed one keeps the wake offered. A wake that is not the one offered last is left alone. */
export function ackStalled({ paths, session, wake, error, now }) {
  const states = readStalledStates(paths.state)
  const state = states.sessions[session]
  if (state?.offered?.id !== wake) return { ok: true, changed: false, reason: "this wake is not the one waiting, so the next poll offers the current one" }
  if (error) {
    state.lastError = `the nudge was not delivered: ${error}`
  } else {
    state.nudgedStretch = state.offered.stretch
    state.nudgedAt = new Date(now).toISOString()
    delete state.offered
    delete state.lastError
  }
  writeStalledStates(paths.state, states)
  return { ok: true, changed: true, reason: error ? "recorded the failed delivery; the nudge stays offered" : "recorded the delivery; this idle stretch is not nudged again" }
}
