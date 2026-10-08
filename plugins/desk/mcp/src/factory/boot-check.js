// The factory boot check: what a session start needs to know about delivery,
// read synchronously from bounded local state only.
//
// `factoryBootCheck({ env, deskRoot, personPrefix, pluginDirs, pluginScanIncomplete, now, deadline })`
// resolves the bound desk's store (`resolveStore`), then reads, and never
// writes, the protected factory state: `consent.json`, `jobs-index.json`,
// `delivered/<store-slug>.json`, the names in `outbox/<store-slug>/`,
// `quarantine/<store-slug>/` and `finalize/`, and the first 40 lines of the
// bound desk's task cards. It returns:
//
//   - `{ jobs }`: up to eight jobs, sorted, each with a pending
//     finalize request (whatever person prefix the task tools bound it
//     under) or finished (a card whose status is `done` or `cancelled` and
//     whose `updated` time is within 30 days) with an outbox file not yet
//     delivered or quarantined. The caller starts one detached `factory.js
//     finalize` for them. An undecided or declined store, an invalid store
//     declaration, no bound desk or unreadable state return `{ jobs: [] }`.
//     An undecided store adds no line: the boot script's `instructions` own
//     the consent question, which never comes first and is never raised in a
//     noninteractive session, and a hook line cannot know either.
//
// `labelsBootCheck({ env, now })` reads, when a store has `contribute: true`,
// the names in `evaluate-requests/` and in each contributing store's
// `quarantine/<store-slug>/labels/<job>/`, the times of those job folders,
// the reason in each quarantine record there, and, only when both hold
// something, `jobs-index.json`; it also reads the
// first requests' own times and `status.json`'s `evaluator` record. It returns
// `{ count, quarantined, oldest_days, evaluator }`:
//
//   - `count`: retained waste evaluation requests (a finished job whose
//     labels are not complete yet), except a job whose every indexed
//     session has quarantined labels, which can never be completed;
//   - `quarantined`: finished jobs with quarantined labels, which will not
//     be delivered: a job folder in labels quarantine updated within 30
//     days, or a request left out of `count` for that reason. Labels are
//     quarantined when the store's gate refuses them or when their facts are
//     quarantined (`outbox.js`'s `holdLabels`). A job folder whose every
//     record is a `job_unbound` withdrawal (`label-binding.js`) is not
//     reported: the flush withdrew those labels on purpose, and the hold
//     lifts by itself if the session binds the job again;
//   - `oldest_days`: whole days since the oldest counted request was made
//     (the first 200 are read), or null when there is none to read;
//   - `evaluator`: `{ state, expired_total, gave_up, lag_minutes }` from
//     `status.json`'s `evaluator` record, each null when it is not recorded
//     (never 0), or null when there is no record. `lag_minutes` is the age, in
//     whole minutes, of the oldest finished job whose labelable session has
//     no labels yet, from the evaluator step's lag record (`lag`), 0 when it
//     recorded none, and null when the record is missing, damaged, dated in
//     the future or older than 72 hours.
//
// The lines come from stored numbers only and never tell the agent to start
// the evaluator: the plugin runs it. `labelsLine(summary, { cardOpen })` is the
// evaluator line, `labelsQuarantinedLine(count, { cardOpen })` the quarantined
// labels line, and `andonLine(store, issues, { openKeys })` the andon line for
// one store. A line says a card is open only when the cards it was given say so:
// `cardOpen` and `openKeys` come from `improvementBootCheck`, and when the
// cards could not be read (null) the line says that instead.
//
// `andonUnknown({ env, now })` names each contributing store whose andon
// state is not known (no record, an unreadable `status.json`, a failed or a
// stale refresh), or one entry with `store: null` (`consent_unreadable`) when
// `consent.json` exists but cannot be read, and `andonUnknownLine` says so;
// see it.
//
// `andonBootCheck({ env })` reads, when a store has `contribute: true`,
// `status.json`'s `andon` record, which the start-time delivery refreshes
// (`andon-watch.js`), and returns the open andon issues for each such store.
//
// `improvementBootCheck({ deskRoot, personPrefix, env, now, deadline, clock })`
// reads the improvement cards of the desk (`readCards`, bounded to 200 files)
// and returns `{ status, open, oldest_days, open_keys, truncated, set_aside,
// unreadable_files }`: `status` is `ok` or `unreadable`; `open` counts the
// cards a session may take (open, or claimed with a claim that ran out);
// `open_keys` lists every card that is not closed. It stops with a thrown
// `boot_check_budget` error at `deadline` (a `clock()` value). `improvementLine`
// is the agent line for it, `improvementCountText` the count with its age and
// `improvementNotes` the files only a session can repair.
//
// Task cards are found only in the desk layout: `<track>/<task>/task.md`,
// `<track>/_archive/<task>/task.md` and the same under `_archive/<track>/`,
// below `desks/<alias>/` when a person prefix is given. A crew root's
// `desks/` folder is never read as a track, and nothing infers a person from
// other files. The job ID is computed exactly as the task tools compute it,
// birth path (`resolveJobIdentity`) included, so a pending finalize request
// filed under a renamed task's birth ID is still recognized here.
// Every file read is regular-file-only, no-follow and size-capped; every
// directory listing is capped. `deadline` (a `performance.now()` value) stops
// the scan, and bounds the desk remote's Git calls and each finished task's
// birth-path resolution the same way: `resolveIdentity` gets this check's own
// `deadline` and `clock`, so a slow Git call inside one task's own resolution
// is bounded too, not only the loop between tasks. Either the loop's own
// check (once per finished task, before that task's own Git call starts) or
// `resolveJobIdentity`'s own `git_deadline` (thrown if a call it made reaches
// the deadline) ends the check the same way, with a thrown `boot_check_budget`
// error.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { closeSync, constants, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { checkPersonPrefix, jobId } from "./binding.js"
import { readDeskRemote, resolveJobIdentity } from "./desk-repo.js"
import { readSmallText } from "./marker.js"
import { expandHome } from "./os-protect.js"
import { createRequire } from "node:module"
import { readWorker } from "./loop-worker-state.js"
import { isPlainObject } from "./schema.js"
import { resolveStore } from "./store-route.js"
import { normalizeTimestamp } from "./time.js"

export const MAX_FINALIZE_JOBS = 8

const RECENT_MS = 30 * 24 * 60 * 60 * 1000
const CARD_BYTES = 16 * 1024
const CARD_LINES = 40
const STATE_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 4096
const TERMINAL = new Set(["done", "cancelled"])
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/u
const FINALIZE_NAME = /^[0-9a-f]{32}\.json$/u
const JOB_NAME = /^[0-9a-f]{32}$/u
const SESSION_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const SESSION_FILE = new RegExp(`^${SESSION_SRC}\\.json$`, "u")
// The quarantine reason `label-binding.js` gives a delivered label it withdrew because the session no longer binds the job.
const WITHDRAWN_REASON = "job_unbound"
const SESSION_OF = new RegExp(`-(${SESSION_SRC})\\.json$`, "u")

class BudgetExceeded extends Error {
  constructor() {
    super("boot_check_budget")
    this.code = "boot_check_budget"
  }
}

/** The protected factory state folder for `env`, resolved exactly as the outbox resolves it, without creating anything. */
export function factoryStateDir(env) {
  const home = typeof env.HOME === "string" && env.HOME.trim() !== "" ? env.HOME : os.homedir()
  const configured = env.XDG_STATE_HOME
  const stateHome = typeof configured === "string" && configured.trim() !== "" ? path.resolve(expandHome(configured, home)) : path.join(home, ".local", "state")
  return path.join(stateHome, "ouroboros-skills", "desk", "factory")
}

/** A JSON state file: `fallback` when absent, `null` when unsafe or unreadable. */
export function readState(file, fallback) {
  let text
  try {
    text = readSmallText(file, STATE_BYTES)
  } catch (error) {
    return error.code === "ENOENT" ? fallback : null
  }
  try {
    const value = JSON.parse(text)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

/** The recorded consent map from `consent.json` in `dir`: `{}` when nothing is decided, `null` when it is unsafe, unreadable or malformed. */
export function consentRecords(dir) {
  const consent = readState(path.join(dir, "consent.json"), { stores: {} })
  return consent === null || !isPlainObject(consent.stores) ? null : consent.stores
}

/** One store's decision from `consentRecords`: "yes", "no", "undecided" or "unreadable". The boot line, desk_status and the report link all use it. */
export function consentDecision(records, store) {
  if (records === null) return "unreadable"
  const record = Object.hasOwn(records, store) ? records[store] : undefined
  if (!isPlainObject(record) || typeof record.contribute !== "boolean") return "undecided"
  return record.contribute ? "yes" : "no"
}

/** The entry names of a folder, capped; empty when it is absent or unreadable. Names are only compared, never opened. */
function listNames(dir) {
  try {
    return readdirSync(dir).slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

function subdirectories(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.slice(0, MAX_ENTRIES).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name)
}

/** The first bytes of a regular task card, never following a symlink and never blocking on a special file. */
function readCardHead(file) {
  let descriptor
  try {
    if (!lstatSync(file).isFile()) return null
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(CARD_BYTES)
    const length = readSync(descriptor, buffer, 0, CARD_BYTES, 0)
    return buffer.toString("utf8", 0, length)
  } finally {
    closeSync(descriptor)
  }
}

function frontmatter(text) {
  const lines = text.split(/\r?\n/u).slice(0, CARD_LINES)
  const fields = {}
  if (lines[0] !== "---") return fields
  for (const line of lines.slice(1)) {
    if (line === "---") break
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/u.exec(line)
    if (match === null || Object.hasOwn(fields, match[1])) continue
    const raw = match[2].trim()
    const quoted = /^(["'])(.*)\1$/u.exec(raw)
    fields[match[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/u, "").trim()
  }
  return fields
}

function updatedAt(value) {
  const exact = normalizeTimestamp(value)
  if (exact !== null) return Date.parse(exact)
  return typeof value === "string" && BARE_DATE.test(value.trim()) ? Date.parse(`${value.trim()}T00:00:00.000Z`) : Number.NaN
}

/** The stores with `contribute: true`, from a bounded read of `consent.json`. */
function contributingStores(env) {
  const consent = readState(path.join(factoryStateDir(env), "consent.json"), null)
  if (!isPlainObject(consent?.stores)) return []
  return Object.entries(consent.stores).filter(([, record]) => isPlainObject(record) && record.contribute === true).map(([store]) => store)
}

/** Whether any store has `contribute: true`, from a bounded read of `consent.json`; the session-start hooks start delivery only then. */
export function hasContributingStore(env = process.env) {
  return contributingStores(env).length > 0
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_REQUEST_READS = 200
const EVALUATOR_STATES = new Set(["idle", "ran", "no_agent_cli", "no_credentials", "disabled_would_bill", "sign_in_unknown", "budget_exhausted", "disabled", "unsupported_host"])
// The states in which a card opens after two blocked days (the evaluator step's blocked states that a person can change).
const CARD_STATES = new Set(["no_agent_cli", "no_credentials", "unsupported_host", "sign_in_unknown"])

const days = (n) => `${n} ${n === 1 ? "day" : "days"}`
// The label lag target the `label_lag` alarm uses (`loop-health.js` `LABEL_LAG_ALARM_MINUTES`), said in the evaluator line.
const LAG_TARGET_MINUTES = 60
const LAG_FRESH_MS = 72 * 60 * 60 * 1000
const lagText = (minutes) => (minutes < 120 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : minutes < 2880 ? `${Math.floor(minutes / 60)} hours` : days(Math.floor(minutes / 1440)))
const wholeDays = (from, now) => Math.floor(Math.max(0, now - from) / DAY_MS)

/** The agent line for the evaluator: `{ count, oldest_days, evaluator }` from `labelsBootCheck`, `cardOpen` true only when a `loop_alarm:headless_blocked` card is open. */
export function labelsLine({ count, oldest_days: oldest = null, evaluator = null }, { cardOpen = false } = {}) {
  const state = evaluator?.state ?? null
  const lag = typeof evaluator?.lag_minutes === "number" && evaluator.lag_minutes > 0 ? `, and the oldest unlabeled one finished ${lagText(evaluator.lag_minutes)} ago${evaluator.lag_minutes > LAG_TARGET_MINUTES ? ", past the 1-hour target" : ""}` : ""
  const age = `${oldest === null ? "" : ` (oldest ${days(oldest)})`}${lag}`
  const waits = `${count} finished ${count === 1 ? "job waits" : "jobs wait"}`
  const gaveUp = evaluator?.gave_up > 0 ? [`${evaluator.gave_up} ${evaluator.gave_up === 1 ? "has" : "have"} been tried three times without an accepted result`] : []
  const expired = evaluator?.expired_total > 0 ? [`${evaluator.expired_total} evaluation ${evaluator.expired_total === 1 ? "request expired and is" : "requests expired and are"} counted`] : []
  if (state === "disabled_would_bill") return ["Factory evaluator: does not run because this sign-in would be billed per token, and nothing is spent", `${waits}${age}`, ...gaveUp, ...expired].join("; ")
  if (CARD_STATES.has(state)) {
    return [`Factory evaluator: cannot run (${state})`, `${waits}${age}`, ...gaveUp, cardOpen === true ? "a card is open for it" : "the state is shown on the health record", ...expired].join("; ")
  }
  const waiting = `${count} finished ${count === 1 ? "job waits" : "jobs wait"} for labels${age}`
  if (state === "disabled") return ["Factory evaluator: switched off on this machine", waiting, ...gaveUp, ...expired].join("; ")
  const last = state === null ? "no result recorded yet" : state === "unrecognized" ? "last result not recognised by this version" : `last result ${state}`
  return [`Factory evaluator: ${waiting}`, `the plugin labels them in the background, ${last}`, ...gaveUp, ...expired].join("; ")
}

/** The agent line for `count` finished jobs whose waste labels are quarantined; `cardOpen` is true, false, or null when the cards could not be read. */
export function labelsQuarantinedLine(count, { cardOpen = false } = {}) {
  const card = cardOpen === null ? "the improvement cards could not be fully read" : cardOpen === true ? "a card is open for it" : "no card is open for it yet"
  return `Factory: ${count} finished ${count === 1 ? "job has" : "jobs have"} quarantined waste labels; ${card}`
}

/** The agent line for the open andon issues `issues` (`[{ number }]`, at least one) recorded for `store`; `openKeys` lists the cards that are not closed, or is null when the cards could not be read, and `complete` is false when the read was cut off. */
export function andonLine(store, issues, { openKeys = null, complete = true } = {}) {
  const count = issues.length
  const head = `Factory: ${count} open andon ${count === 1 ? "issue" : "issues"} in ${store} (${issues.map(({ number }) => `#${number}`).join(", ")})`
  if (openKeys === null) return `${head}; the improvement cards could not be fully read`
  const open = new Set(openKeys)
  const have = issues.filter(({ number }) => open.has(`andon:${store}#${number}`)).length
  if (have === count) return `${head}; ${count === 1 ? "it has" : "each has"} an improvement card`
  // A card not found in a cut-off read may sit beyond the bound: unknown, not absent.
  if (!complete) return `${head}; the improvement cards could not be fully read`
  if (have === 0) return `${head}; ${count === 1 ? "it has no improvement card yet, and gets one" : "none has an improvement card yet, and each gets one"} at the next background step`
  return `${head}; ${have} of them ${have === 1 ? "has" : "have"} an improvement card, and the rest get one at the next background step`
}

/**
 * `andonBootCheck({ env }) -> [{ store, issues }]`: the open andon issues
 * the last start-time refresh recorded (`andon-watch.js`) in `status.json`,
 * for each store that still has `contribute: true`, sorted by store; stores
 * with none are left out. Never writes; unreadable or misshapen state gives
 * nothing.
 */
export function andonBootCheck({ env }) {
  const stores = contributingStores(env).sort()
  if (stores.length === 0) return []
  const status = readState(path.join(factoryStateDir(env), "status.json"), {}) ?? {}
  const andon = isPlainObject(status.andon) ? status.andon : {}
  const found = []
  for (const store of stores) {
    const record = andon[store]
    const issues = isPlainObject(record) && Array.isArray(record.issues) ? record.issues.filter((issue) => isPlainObject(issue) && Number.isSafeInteger(issue.number) && issue.number > 0) : []
    if (issues.length > 0) found.push({ store, issues })
  }
  return found
}

/** A contributing store's andon record older than this (72 hours) no longer says whether the line is stopped. */
export const ANDON_STALE_MS = 72 * 60 * 60 * 1000
// A refresh stamped further ahead than this was written by a clock that ran fast; it says nothing about now.
const ANDON_SKEW_MS = 5 * 60 * 1000
const ANDON_CODE = /^[a-z0-9_]{1,40}$/u

/**
 * `andonUnknown({ env, now }) -> [{ store, since, code }]`: each store with `contribute: true` whose andon state is not known now, sorted by
 * store, so the boot line says so instead of reading as "no open andon" (fail closed, ruling 2026-10-06). `since` is the ISO time of the
 * last successful refresh, or null when there is none. `code`: `status_unreadable` (`status.json` cannot be read or parsed),
 * `not_refreshed` (no record yet), `future_dated` (the record is stamped more than five minutes ahead), the refresh's own failure code
 * when the last refresh failed after the last success (`auth_failed`, `config_missing`, `http_404`, ...; `andon-watch.js` records it),
 * or `stale` (the last success is older than `ANDON_STALE_MS`). Never writes.
 */
export function andonUnknown({ env, now = Date.now() }) {
  // A consent file that exists and cannot be read hides which stores this machine contributes to: that is said, never read as none.
  if (consentRecords(factoryStateDir(env)) === null) return [{ store: null, since: null, code: "consent_unreadable" }]
  const stores = contributingStores(env).sort()
  if (stores.length === 0) return []
  const status = readState(path.join(factoryStateDir(env), "status.json"), {})
  if (status === null) return stores.map((store) => ({ store, since: null, code: "status_unreadable" }))
  const andon = isPlainObject(status.andon) ? status.andon : {}
  const unknown = []
  for (const store of stores) {
    const record = isPlainObject(andon[store]) ? andon[store] : {}
    const checked = Date.parse(record.checked_at)
    const since = Number.isFinite(checked) && checked <= now + ANDON_SKEW_MS ? checked : null
    const failure = ANDON_CODE.test(record.failure) ? record.failure : null
    const failedAt = Date.parse(record.failed_at)
    const failedLast = failure !== null && Number.isFinite(failedAt) && (since === null || failedAt >= since)
    const code = failedLast ? failure : since === null ? (Number.isFinite(checked) ? "future_dated" : "not_refreshed") : now - since > ANDON_STALE_MS ? "stale" : null
    if (code !== null) unknown.push({ store, since: since === null ? null : new Date(since).toISOString(), code })
  }
  return unknown
}

/** The agent line for one `andonUnknown` entry. */
export function andonUnknownLine({ store, since, code }) {
  if (store === null) return `Factory: andon state unknown (${code}): consent.json cannot be read, so the stores this machine contributes to are unknown`
  return `Factory: andon state unknown for ${store} ${since === null ? "(never refreshed)" : `since ${since.slice(0, 10)}`} (${code})`
}

/** See the header. Never writes and never opens a request or a quarantine record; every listing is capped. */
const HOUR_MS = 60 * 60 * 1000
const { isLoopEnabled } = createRequire(import.meta.url)("./loop-switch.cjs")

/**
 * `loopWorkerLine({ env, now })`: one status line when the loop worker's last recorded result is not a normal run, else `""`. It reads
 * `status.json`'s `loop.worker` and the small file beside the lock; both hold a code and two times. No card is involved.
 */
export function loopWorkerLine({ env = process.env, now = Date.now() } = {}) {
  // The switch is read here, not from the record: a loop that is off launches nothing, so no worker is left to record it.
  if (!isLoopEnabled(env)) return "Factory loop: switched off on this machine (DESK_FACTORY_LOOP)"
  const dir = factoryStateDir(env)
  const worker = readWorker(readState(path.join(dir, "status.json"), {}), dir)
  if (worker === null) return ""
  if (worker.result === "busy") return `Factory loop: has not run for ${Math.max(0, Math.floor((now - Date.parse(worker.since)) / HOUR_MS))} hours because another worker holds the lock`
  if (worker.result === "status_reset" || worker.result === "status_unavailable") return "Factory loop: stopped because its status file was damaged and was set aside; the evaluator rests for the rest of that UTC day"
  if (worker.result === "budget_spent") return "Factory loop: the last run used its whole time budget before every step started"
  return ""
}

export function labelsBootCheck({ env = process.env, now = Date.now() } = {}) {
  const stores = contributingStores(env)
  if (stores.length === 0) return { count: 0, quarantined: 0, oldest_days: null, evaluator: null }
  const dir = factoryStateDir(env)
  const requests = listNames(path.join(dir, "evaluate-requests")).filter((name) => FINALIZE_NAME.test(name)).map((name) => name.slice(0, -5))
  // job -> the sessions whose labels are quarantined, in any contributing store; and the jobs quarantined recently.
  const held = new Map()
  const quarantined = new Set()
  for (const store of stores) {
    const base = path.join(dir, "quarantine", store.replace("/", "__"), "labels")
    for (const job of listNames(base).filter((name) => JOB_NAME.test(name))) {
      const sessions = held.get(job) ?? new Set()
      // A label the flush withdrew on purpose (`job_unbound`) is held back, but it is not a fault to report; a record that does not read is.
      let faults = 0
      for (const name of listNames(path.join(base, job))) {
        if (!SESSION_FILE.test(name)) continue
        sessions.add(name.slice(0, -5))
        if (readState(path.join(base, job, name), null)?.reason !== WITHDRAWN_REASON) faults += 1
      }
      held.set(job, sessions)
      // A folder gone since the listing has no time, and the comparison with `undefined` is false.
      if (faults > 0 && now - lstatSync(path.join(base, job), { throwIfNoEntry: false })?.mtimeMs <= RECENT_MS) quarantined.add(job)
    }
  }
  const index = held.size > 0 && requests.length > 0 ? readState(path.join(dir, "jobs-index.json"), {}) ?? {} : {}
  const waiting = []
  for (const job of requests) {
    const names = Array.isArray(index[job]) ? index[job] : []
    const sessions = names.map((name) => SESSION_OF.exec(String(name))?.[1])
    if (sessions.length > 0 && sessions.every((session) => held.get(job)?.has(session))) quarantined.add(job)
    else waiting.push(job)
  }
  // The oldest request's own time, from the first requests only; a file that does not parse gives no age.
  let oldest = null
  for (const job of waiting.slice(0, MAX_REQUEST_READS)) {
    const at = Date.parse(readState(path.join(dir, "evaluate-requests", `${job}.json`), {})?.requested_at)
    if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at
  }
  return { count: waiting.length, quarantined: quarantined.size, oldest_days: oldest === null ? null : wholeDays(oldest, now), evaluator: evaluatorRecord(dir, now) }
}

/** `status.json`'s `evaluator` record as `{ state, expired_total, gave_up }`, each null when it is not recorded as a plausible value; null with no record. */
function evaluatorRecord(dir, now) {
  const record = readState(path.join(dir, "status.json"), {})?.evaluator
  if (!isPlainObject(record)) return null
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
  // A state this version does not know is said as not recognised, never as no result.
  const recorded = isPlainObject(record.headless) ? record.headless.state : undefined
  const state = EVALUATOR_STATES.has(recorded) ? recorded : typeof recorded === "string" ? "unrecognized" : null
  return { state, expired_total: count(record.expired_total), gave_up: count(record.gave_up), lag_minutes: lagMinutes(record.lag, now) }
}

// The lag record's age of the oldest unlabeled finished job, in whole minutes; 0 with none recorded; null when it says nothing about now.
function lagMinutes(lag, now) {
  if (!isPlainObject(lag)) return null
  const at = Date.parse(lag.at)
  if (Number.isNaN(at) || now - at > LAG_FRESH_MS || at - now > 5 * 60 * 1000) return null
  if (lag.unlabeled_jobs === 0 && lag.oldest_finished_at === null) return 0
  const oldest = Date.parse(lag.oldest_finished_at)
  return Number.isSafeInteger(lag.unlabeled_jobs) && lag.unlabeled_jobs > 0 && !Number.isNaN(oldest) ? Math.max(0, Math.floor((now - oldest) / 60000)) : null
}

const NO_CARDS = Object.freeze({ status: "unreadable", open: 0, oldest_days: null, open_keys: [], truncated: false, set_aside: 0, unreadable_files: 0 })

/** See the header. Reads, and never writes, the improvement cards; `readCards` is a test seam. */
export async function improvementBootCheck({ deskRoot, personPrefix = "", now = Date.now(), readCards, deadline = Infinity, clock = () => performance.now() }) {
  const within = () => {
    if (clock() >= deadline) throw new BudgetExceeded()
  }
  within()
  let found = null
  try {
    found = await (readCards ?? (await import("../desk/improvement-cards.js")).readCards)({ deskRoot, personPrefix })
  } catch {
    found = null
  }
  within()
  if (found === null || found.unreadable) return { ...NO_CARDS, open_keys: [] }
  const live = (card) => card.claim !== null && typeof card.claim?.expires_at === "string" && Date.parse(card.claim.expires_at) > now
  const available = found.cards.filter((card) => card.state === "open" || (card.state === "claimed" && !live(card)))
  const times = available.map((card) => Date.parse(card.last_opened_at)).filter((at) => !Number.isNaN(at))
  return {
    status: "ok",
    open: available.length,
    oldest_days: times.length === 0 ? null : wholeDays(Math.min(...times), now),
    open_keys: found.cards.filter((card) => !String(card.state).startsWith("closed_")).map((card) => card.key),
    truncated: found.truncated === true,
    set_aside: found.set_aside_total,
    unreadable_files: found.unreadable_files,
  }
}

/** True when the card `key` is not closed, false when it is not, null when the cards were not read (or the read was cut off before it was found). */
export function cardOpenState(summary, key) {
  if (summary === null || summary === undefined || summary.status !== "ok") return null
  if (summary.open_keys.includes(key)) return true
  return summary.truncated ? null : false
}

const UNCHECKED = {
  login_not_cached: "this crew desk has several people and this session's person is not known without a network call (set DESK_PERSON to read your cards)",
  no_matching_member: "this session's identity matches no member of this crew desk's roster (set DESK_PERSON to read your cards)",
  invalid_member: "the crew roster names an alias that is not a valid folder name",
}

/** The count of open cards with the age of the oldest, as the improvement line and the boot instruction both say it. */
export function improvementCountText({ open, oldest_days: oldest, truncated }) {
  const age = oldest === null ? "" : ` (oldest ${days(oldest)}${truncated ? " among those read" : ""})`
  return `${truncated ? "at least " : ""}${open} open${age}`
}

/** The card files only a session can repair, one phrase each, for the counts above zero. */
export function improvementNotes({ set_aside: setAside, unreadable_files: unreadable }) {
  return [
    ...(setAside > 0 ? [`${setAside} ${setAside === 1 ? "file was" : "files were"} set aside as invalid in the improvement folder under _meta (restore or delete ${setAside === 1 ? "it" : "them"} and commit)`] : []),
    ...(unreadable > 0 ? [`${unreadable} card ${unreadable === 1 ? "file could not be read and was" : "files could not be read and were"} left in place (fix ${unreadable === 1 ? "its" : "their"} permissions or delete ${unreadable === 1 ? "it" : "them"} and commit)`] : []),
  ]
}

/** The agent line for `summary` from `improvementBootCheck`: the open cards, an unreadable folder (never silence), or the files only a session can repair; empty when there is nothing to say. */
export function improvementLine(summary) {
  if (summary === null || summary === undefined) return ""
  if (summary.status === "unchecked") return `Improvement cards: not checked, because ${UNCHECKED[summary.reason] ?? "this session's person is not known"}`
  if (summary.status !== "ok") return "Improvement cards: unreadable (check the improvement folder under _meta on the desk)"
  const parts = [
    ...(summary.open > 0 ? [`${improvementCountText(summary)}. Standing, pre-authorized work: when your foreground work allows, hand the oldest to a background subagent through improvement_next`] : []),
    ...improvementNotes(summary),
  ]
  return parts.length === 0 ? "" : `Improvement cards: ${parts.join("; ")}`
}

// Every task folder the desk layout allows, live and archived, in a stable order:
// `{ track, slug, file, archived }` with `file` the card's path.
function* cardLocations(deskRoot, alias) {
  const base = alias === null ? deskRoot : path.join(deskRoot, "desks", alias)
  const tracks = []
  for (const name of subdirectories(base)) {
    if (name === "_archive") for (const archived of subdirectories(path.join(base, name))) if (!archived.startsWith("_")) tracks.push({ dir: path.join(base, name, archived), archived: true })
    if (name.startsWith("_") || (alias === null && name === "desks")) continue
    tracks.push({ dir: path.join(base, name), archived: false })
  }
  for (const trackDir of tracks) {
    const track = path.basename(trackDir.dir)
    for (const folder of [trackDir.dir, path.join(trackDir.dir, "_archive")]) {
      for (const slug of subdirectories(folder)) {
        if (slug.startsWith("_")) continue
        yield { track, slug, file: path.join(folder, slug, "task.md"), archived: trackDir.archived || folder !== trackDir.dir }
      }
    }
  }
}

/** `[{ track, slug }]` for finished, recent cards of the desk; see the header. */
export function finishedTasks({ deskRoot, personPrefix = "", now = Date.now(), deadline = Infinity, clock = () => performance.now() }) {
  const alias = checkPersonPrefix(personPrefix, "finishedTasks")
  const tasks = []
  for (const { track, slug, file } of cardLocations(deskRoot, alias)) {
    if (clock() > deadline) throw new BudgetExceeded()
    const head = readCardHead(file)
    if (head === null) continue
    const fields = frontmatter(head)
    const updated = updatedAt(fields.updated)
    if (TERMINAL.has(fields.status) && Number.isFinite(updated) && now - updated <= RECENT_MS && updated - now <= RECENT_MS) tasks.push({ track, slug })
  }
  return tasks
}

// The job ID in the card's `factory_report` link (`.../reports/jobs/<id>.md`), or `null`: the field's own line and its indented continuation,
// since a long link is folded onto the next line.
function reportJobOf(head) {
  const field = /^factory_report:[^\n]*(?:\n[ \t]+[^\n]*)*/mu.exec(head)
  return field === null ? null : /\/reports\/jobs\/([0-9a-f]{32})\.md/u.exec(field[0])?.[1] ?? null
}

/**
 * `[{ track, slug, archived, status, created, updated, report_unavailable, report_job }]`: every readable card of the desk, live or archived, with
 * no status or age filter (`finishedTasks` is this walk with one). `status` is the card's raw text, `created` and `updated`
 * are exact UTC timestamps or `null`, `report_unavailable` is the card's `factory_report_unavailable` text or `null`, and `report_job` is the job ID its `factory_report` link names or `null`. A person
 * prefix reads `desks/<alias>`.
 */
export function allTasks({ deskRoot, personPrefix = "" }) {
  const alias = checkPersonPrefix(personPrefix, "allTasks")
  const tasks = []
  for (const { track, slug, file, archived } of cardLocations(deskRoot, alias)) {
    const head = readCardHead(file)
    if (head === null) continue
    const fields = frontmatter(head)
    tasks.push({ track, slug, archived, status: fields.status ?? null, created: normalizeTimestamp(fields.created), updated: normalizeTimestamp(fields.updated), report_unavailable: fields.factory_report_unavailable ?? null, report_job: reportJobOf(head) })
  }
  return tasks
}

/** See the header. Never writes; throws only `boot_check_budget` (and caller-contract errors for a bad person prefix). */
export function factoryBootCheck({
  env = process.env, deskRoot, personPrefix = "", pluginDirs = [], pluginScanIncomplete = false, now = Date.now(), deadline = Infinity, clock = () => performance.now(), readRemote = readDeskRemote, resolveIdentity = resolveJobIdentity,
}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) return { jobs: [] }
  const route = resolveStore({ deskRoot, pluginDirs, read: (file) => readSmallText(file) })
  // As in the end hook: an incomplete plugin scan may have missed an overlay's declaration, so only the desk's own counts.
  if (route.store === null || (pluginScanIncomplete && route.source !== "desk")) return { jobs: [] }
  const dir = factoryStateDir(env)
  // Only a yes starts finalize work. An undecided store stays silent here: the boot script owns the consent question.
  if (consentDecision(consentRecords(dir), route.store) !== "yes") return { jobs: [] }

  // Every pending finalize request is a job the task tools finished, whatever person prefix they bound it under.
  const jobs = new Set(listNames(path.join(dir, "finalize")).filter((name) => FINALIZE_NAME.test(name)).map((name) => name.slice(0, -5)))
  const finished = finishedTasks({ deskRoot, personPrefix, now, deadline, clock })
  if (finished.length === 0) return { jobs: [...jobs].sort().slice(0, MAX_FINALIZE_JOBS) }
  // The task tools compute job IDs from the desk's real path. The remote read shares the check's deadline; a read cut off by it is an overrun, never "no remote".
  const root = realpathSync(deskRoot)
  let remote
  try {
    remote = readRemote({ deskRoot: root, timeoutMs: 2000, deadline, clock }) || `local:${root}`
  } catch {
    throw new BudgetExceeded()
  }
  const slug = route.store.replace("/", "__")
  const index = readState(path.join(dir, "jobs-index.json"), {}) ?? {}
  const delivered = readState(path.join(dir, "delivered", `${slug}.json`), {}) ?? {}
  const outbox = new Set(listNames(path.join(dir, "outbox", slug)))
  const quarantined = new Set(listNames(path.join(dir, "quarantine", slug)))
  for (const { track, slug: task } of finished) {
    if (clock() > deadline) throw new BudgetExceeded()
    let job
    try {
      const birth = resolveIdentity({ deskRoot: root, personPrefix, track, slug: task, deadline, clock })
      job = jobId({ deskRemote: remote, personPrefix, track: birth.track, slug: birth.slug })
    } catch (error) {
      if (error?.code === "git_deadline") throw new BudgetExceeded()
      continue
    }
    const files = Array.isArray(index[job]) ? index[job] : []
    if (files.some((name) => typeof name === "string" && outbox.has(name) && !Object.hasOwn(delivered, name) && !quarantined.has(name))) jobs.add(job)
  }
  return { jobs: [...jobs].sort().slice(0, MAX_FINALIZE_JOBS) }
}
