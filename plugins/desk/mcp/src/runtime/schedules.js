// Schedules: a prompt a session wants every N minutes, owned by the always-on runtime instead of the app's session automations.
// The app queues every run it misses while a session is busy and replays them back to back; a schedule here never does. It is
// the same contract as `drains.js poll`: no model turn, the wakes are printed and the runner delivers them and reports back
// with `ack`. A schedule is due once however many intervals went by, and its next run is counted from the delivery that
// landed, so missed runs fold into one. See docs/schedules.md.
import { createHash } from "node:crypto"
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { drainsHome } from "./drains.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

const MINUTE_MS = 60_000

export function schedulePaths(options = {}) {
  const home = drainsHome(options)
  return { config: path.join(home, "schedules.json"), state: path.join(home, "schedules-state.json"), lock: path.join(home, "schedule.lock") }
}

function problem(code, thing, probably, look, fix) {
  return new Error(deskFailure({ code, thing, probably, look, keepWorking: "no schedule moved and nothing was sent", fix }))
}

const isText = (value) => typeof value === "string" && value.trim() !== ""

/** The schedules in a config file's text, validated. A bad entry is an error, never a silent drop: a dropped schedule would stop a watchdog. */
export function parseScheduleConfig(raw, file) {
  const bad = (what) => problem("desk_schedules_config_invalid", "schedules config", `${file} ${what}, probably a hand edit`, "open the file and compare it with docs/schedules.md", "correct the entry and run the command again")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw bad("is not valid JSON")
  }
  const list = parsed?.schedules
  if (!Array.isArray(list)) throw bad('has no "schedules" array')
  const names = new Set()
  return list.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw bad(`schedules[${index}] is not an object`)
    const { session, prompt, everyMinutes, name } = entry
    if (!isText(session)) throw bad(`schedules[${index}].session is not a session id`)
    if (!isText(prompt)) throw bad(`schedules[${index}].prompt is not the text to send`)
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1) throw bad(`schedules[${index}].everyMinutes is not a whole number of minutes, 1 or more`)
    if (name !== undefined && !isText(name)) throw bad(`schedules[${index}].name is not a name`)
    const key = (name ?? session).trim()
    if (names.has(key)) throw bad(`schedules[${index}] reuses the name ${key}; give each schedule on one session its own "name"`)
    names.add(key)
    return { name: key, session: session.trim(), prompt, everyMinutes }
  })
}

export function readScheduleConfig(file) {
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT") throw problem("desk_schedules_config_unreadable", "schedules config", `${file} cannot be read (${error.code}), probably because its owner or permissions changed`, "check the file's permissions", "fix them and run the command again")
    return []
  }
  return parseScheduleConfig(raw, file)
}

export function readScheduleStates(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeScheduleStates(file, states) {
  assertNotRealStateUnderTest(path.dirname(file))
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`)
  renameSync(temporary, file)
}

const scheduleWakeId = (schedule, nextAt) => createHash("sha1").update(JSON.stringify([schedule.name, schedule.session, schedule.prompt, nextAt])).digest("hex").slice(0, 16)

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS))
  return minutes < 1 ? "under 1m" : minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

/** One line per schedule: its cadence, when it last landed and when it runs next. */
export function scheduleStatusLines(schedules, states, now) {
  return schedules.map((schedule) => {
    const state = states[schedule.name]
    const head = `schedule ${schedule.name} -> ${schedule.session.slice(0, 8)}: every ${schedule.everyMinutes}m`
    if (!state?.nextAt) return `${head}, not polled yet`
    const sent = state.lastSentAt ? `last sent ${span(now - Date.parse(state.lastSentAt))} ago` : "never sent"
    const wait = Date.parse(state.nextAt) - now
    const next = wait <= 0 ? "due now" : `next run in ${span(wait)} (${state.nextAt})`
    return `${head}, ${sent}, ${next}${state.lastError ? `, last error: ${state.lastError}` : ""}`
  })
}

/**
 * Print the schedules that are due. A new schedule is first due one interval after it is first seen. A due schedule is offered
 * once per poll with the same id until a delivery lands, so a runner that holds it (the session still has the last prompt
 * queued) leaves exactly one prompt waiting, never a pile. Each wake names its own text as `replaces`, so a runner takes an
 * older copy still queued in the session back before it sends the new one.
 */
export function pollSchedules({ paths, now, ackCommand, ackFlags = [] }) {
  const schedules = readScheduleConfig(paths.config)
  const stored = readScheduleStates(paths.state)
  const states = {}
  for (const schedule of schedules) {
    const previous = stored[schedule.name]
    const reseed = !previous?.nextAt || previous.everyMinutes !== schedule.everyMinutes
    states[schedule.name] = reseed
      ? { ...(previous?.lastSentAt ? { lastSentAt: previous.lastSentAt } : {}), everyMinutes: schedule.everyMinutes, nextAt: new Date(now + schedule.everyMinutes * MINUTE_MS).toISOString() }
      : { ...previous }
  }
  const wakes = []
  for (const schedule of schedules) {
    const state = states[schedule.name]
    if (Date.parse(state.nextAt) > now) continue
    const id = scheduleWakeId(schedule, state.nextAt)
    state.offered = id
    wakes.push({ id, name: schedule.name, session: schedule.session, message: schedule.prompt, replaces: schedule.prompt, done: [...ackCommand, "schedule", "ack", "--name", schedule.name, "--wake", id, ...ackFlags] })
  }
  writeScheduleStates(paths.state, states)
  const errors = schedules.filter((schedule) => states[schedule.name].lastError).map((schedule) => ({ name: schedule.name, error: states[schedule.name].lastError }))
  return { at: new Date(now).toISOString(), wakes, errors, status: scheduleStatusLines(schedules, states, now) }
}

/** Record how a wake went. A delivery that landed moves the next run one interval on from now; a failed one keeps the schedule due. A wake that is not the one offered last is left alone. */
export function ackSchedule({ paths, name, wake, error, now }) {
  const states = readScheduleStates(paths.state)
  const state = states[name]
  if (!state || state.offered !== wake) return { ok: true, changed: false, reason: "this wake is not the one waiting, so the next poll offers the current one" }
  if (error) {
    state.lastError = `the prompt was not delivered: ${error}`
  } else {
    delete state.lastError
    delete state.offered
    states[name] = { ...state, lastSentAt: new Date(now).toISOString(), nextAt: new Date(now + state.everyMinutes * MINUTE_MS).toISOString() }
  }
  writeScheduleStates(paths.state, states)
  return { ok: true, changed: true, reason: error ? "recorded the failed delivery; the schedule stays due" : "recorded the delivery and moved the next run one interval on" }
}
