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
// `labelsBootCheck({ env })` counts, by name only, the retained waste
// evaluation requests in `evaluate-requests/` (a finished job whose labels
// are not complete yet) when a store has `contribute: true`, and returns
// `{ count }`; `labelsLine(count)` is the agent line for a count above zero.
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

/** Whether any store has `contribute: true`, from a bounded read of `consent.json`; the session-start hooks start delivery only then. */
export function hasContributingStore(env = process.env) {
  const consent = readState(path.join(factoryStateDir(env), "consent.json"), null)
  return isPlainObject(consent?.stores) && Object.values(consent.stores).some((record) => isPlainObject(record) && record.contribute === true)
}

/** The agent line for `count` finished tasks whose waste labels are not complete. */
export function labelsLine(count) {
  return `Factory: ${count} finished tasks have no waste labels yet; run the evaluator for them in the background`
}

/** See the header. Never writes and never opens a request; names are counted, capped with every listing. */
export function labelsBootCheck({ env = process.env } = {}) {
  if (!hasContributingStore(env)) return { count: 0 }
  return { count: listNames(path.join(factoryStateDir(env), "evaluate-requests")).filter((name) => FINALIZE_NAME.test(name)).length }
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
  const consent = readState(path.join(dir, "consent.json"), { stores: {} })
  if (consent === null) return { jobs: [] }
  const record = isPlainObject(consent.stores) ? consent.stores[route.store] : undefined
  if (!isPlainObject(record)) return { line: FACTORY_NO_CONSENT_LINE }
  if (record.contribute !== true) return { jobs: [] }

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
