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
//   - `{ line: FACTORY_NO_CONSENT_LINE }` when the store has no consent
//     decision at all, so the agent asks the operator once;
//   - `{ jobs }` otherwise: up to eight jobs, sorted, each with a pending
//     finalize request (whatever person prefix the task tools bound it
//     under) or finished (a card whose status is `done` or `cancelled` and
//     whose `updated` time is within 30 days) with an outbox file not yet
//     delivered or quarantined. The caller starts one detached `factory.js
//     finalize` for them. A declined store, an invalid store declaration, no
//     bound desk or unreadable state return `{ jobs: [] }`.
//
// `labelsBootCheck({ env, now })` reads, when a store has `contribute: true`,
// the names in `evaluate-requests/` and in each contributing store's
// `quarantine/<store-slug>/labels/<job>/`, the times of those job folders,
// and, only when both hold something, `jobs-index.json`. It returns
// `{ count, quarantined }`:
//
//   - `count`: retained waste evaluation requests (a finished job whose
//     labels are not complete yet), except a job whose every indexed
//     session has quarantined labels, which can never be completed;
//   - `quarantined`: finished jobs with quarantined labels, which will not
//     be delivered: a job folder in labels quarantine updated within 30
//     days, or a request left out of `count` for that reason. Labels are
//     quarantined when the store's gate refuses them or when their facts are
//     quarantined (`outbox.js`'s `holdLabels`).
//
// `labelsLine(count)` and `labelsQuarantinedLine(quarantined)` are the
// agent lines for a number above zero.
//
// Task cards are found only in the desk layout: `<track>/<task>/task.md`,
// `<track>/_archive/<task>/task.md` and the same under `_archive/<track>/`,
// below `desks/<alias>/` when a person prefix is given. A crew root's
// `desks/` folder is never read as a track, and nothing infers a person from
// other files. The job ID is computed exactly as the task tools compute it.
// Every file read is regular-file-only, no-follow and size-capped; every
// directory listing is capped. `deadline` (a `performance.now()` value) stops
// the scan, and bounds the desk remote's Git calls together, with a thrown
// `boot_check_budget` error.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { closeSync, constants, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { checkPersonPrefix, jobId } from "./binding.js"
import { readDeskRemote } from "./desk-repo.js"
import { readSmallText } from "./marker.js"
import { expandHome } from "./os-protect.js"
import { isPlainObject } from "./schema.js"
import { resolveStore } from "./store-route.js"
import { normalizeTimestamp } from "./time.js"

export const FACTORY_NO_CONSENT_LINE = "Factory: this desk hasn't decided whether to contribute measurement data; ask the operator once (desk:session-start)"
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
function readState(file, fallback) {
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

/** The agent line for `count` finished tasks whose waste labels are not complete. */
export function labelsLine(count) {
  return `Factory: ${count} finished tasks have no waste labels yet; run the evaluator for them in the background`
}

/** The agent line for `count` finished tasks whose waste labels are quarantined. */
export function labelsQuarantinedLine(count) {
  return `Factory: ${count} finished tasks have quarantined waste labels that will not be delivered; tell the operator (desk:session-start)`
}

/** See the header. Never writes and never opens a request or a quarantine record; every listing is capped. */
export function labelsBootCheck({ env = process.env, now = Date.now() } = {}) {
  const stores = contributingStores(env)
  if (stores.length === 0) return { count: 0, quarantined: 0 }
  const dir = factoryStateDir(env)
  const requests = listNames(path.join(dir, "evaluate-requests")).filter((name) => FINALIZE_NAME.test(name)).map((name) => name.slice(0, -5))
  // job -> the sessions whose labels are quarantined, in any contributing store; and the jobs quarantined recently.
  const held = new Map()
  const quarantined = new Set()
  for (const store of stores) {
    const base = path.join(dir, "quarantine", store.replace("/", "__"), "labels")
    for (const job of listNames(base).filter((name) => JOB_NAME.test(name))) {
      const sessions = held.get(job) ?? new Set()
      for (const name of listNames(path.join(base, job))) if (SESSION_FILE.test(name)) sessions.add(name.slice(0, -5))
      held.set(job, sessions)
      // A folder gone since the listing has no time, and the comparison with `undefined` is false.
      if (sessions.size > 0 && now - lstatSync(path.join(base, job), { throwIfNoEntry: false })?.mtimeMs <= RECENT_MS) quarantined.add(job)
    }
  }
  const index = held.size > 0 && requests.length > 0 ? readState(path.join(dir, "jobs-index.json"), {}) ?? {} : {}
  let count = 0
  for (const job of requests) {
    const names = Array.isArray(index[job]) ? index[job] : []
    const sessions = names.map((name) => SESSION_OF.exec(String(name))?.[1])
    if (sessions.length > 0 && sessions.every((session) => held.get(job)?.has(session))) quarantined.add(job)
    else count += 1
  }
  return { count, quarantined: quarantined.size }
}

/** `[{ track, slug }]` for finished, recent cards of the desk; see the header. */
export function finishedTasks({ deskRoot, personPrefix = "", now = Date.now(), deadline = Infinity, clock = () => performance.now() }) {
  const alias = checkPersonPrefix(personPrefix, "finishedTasks")
  const base = alias === null ? deskRoot : path.join(deskRoot, "desks", alias)
  const tasks = []
  const tracks = []
  for (const name of subdirectories(base)) {
    if (name === "_archive") for (const archived of subdirectories(path.join(base, name))) if (!archived.startsWith("_")) tracks.push(path.join(base, name, archived))
    if (name.startsWith("_") || (alias === null && name === "desks")) continue
    tracks.push(path.join(base, name))
  }
  for (const trackDir of tracks) {
    const track = path.basename(trackDir)
    for (const folder of [trackDir, path.join(trackDir, "_archive")]) {
      for (const slug of subdirectories(folder)) {
        if (clock() > deadline) throw new BudgetExceeded()
        if (slug.startsWith("_")) continue
        const head = readCardHead(path.join(folder, slug, "task.md"))
        if (head === null) continue
        const fields = frontmatter(head)
        const updated = updatedAt(fields.updated)
        if (TERMINAL.has(fields.status) && Number.isFinite(updated) && now - updated <= RECENT_MS && updated - now <= RECENT_MS) tasks.push({ track, slug })
      }
    }
  }
  return tasks
}

/** See the header. Never writes; throws only `boot_check_budget` (and caller-contract errors for a bad person prefix). */
export function factoryBootCheck({
  env = process.env, deskRoot, personPrefix = "", pluginDirs = [], pluginScanIncomplete = false, now = Date.now(), deadline = Infinity, clock = () => performance.now(), readRemote = readDeskRemote,
}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) return { jobs: [] }
  const route = resolveStore({ deskRoot, pluginDirs, read: (file) => readSmallText(file) })
  // As in the end hook: an incomplete plugin scan may have missed an overlay's declaration, so only the desk's own counts.
  if (route.store === null || (pluginScanIncomplete && route.source !== "desk")) return { jobs: [] }
  const dir = factoryStateDir(env)
  // The same decision desk_status reports, so the boot line asks exactly when desk_status says `undecided`.
  const decided = consentDecision(consentRecords(dir), route.store)
  if (decided === "undecided") return { line: FACTORY_NO_CONSENT_LINE }
  if (decided !== "yes") return { jobs: [] }

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
    let job
    try {
      job = jobId({ deskRemote: remote, personPrefix, track, slug: task })
    } catch {
      continue
    }
    const files = Array.isArray(index[job]) ? index[job] : []
    if (files.some((name) => typeof name === "string" && outbox.has(name) && !Object.hasOwn(delivered, name) && !quarantined.has(name))) jobs.add(job)
  }
  return { jobs: [...jobs].sort().slice(0, MAX_FINALIZE_JOBS) }
}
