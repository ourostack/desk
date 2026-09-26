// The local outbox and consent: the protected, owner-only state folder that
// holds everything a machine keeps before (and instead of) sending anything
// to a factory store — consent per store, pending-session markers, local
// facts waiting to be published, delivered and quarantined records, the
// visibility cache, finalize requests, the jobs index and a machine secret.
//
// This is a small, purpose-built primitive, not a reuse of
// `src/protected/store.js`: that primitive opens a SQLite database and pulls
// in `better-sqlite3`, Windows ACL handling and `src/util/paths.js`, none of
// which `src/factory/**` may import (it is `node:` built-ins and other
// `src/factory/` files only). What this module keeps from it is the two
// guards that matter for a flat JSON-file store: refuse a state root inside
// a Git checkout, and refuse a symlinked path component. Hard-link and
// macOS-extended-ACL handling are `store.js`'s answer to protecting one
// mutable SQLite file; they have no equivalent need here, where every write
// is a whole-file atomic replace (temp file, then rename) of a small JSON
// document.
//
// Local state layout, under `<state>/ouroboros-skills/desk/factory/`
// (`<state>` being `$XDG_STATE_HOME`, else `~/.local/state`):
//
//   consent.json                       per-store consent decisions
//   markers/<host>-<session_id>.json   pending-session bookkeeping
//   outbox/<store-slug>/<host>-<session_id>.json   local facts, never as-is
//   delivered/<store-slug>.json        name -> last delivered published blob sha
//   quarantine/<store-slug>/<name>     { reason, at }
//   visibility.json                    repo visibility cache (7-day expiry)
//   status.json                        last flush result per store
//   finalize/<job>.json                a Desk task tool's sync-at-done request
//   jobs-index.json                    job -> [outbox file names]
//   machine-secret                     32 random bytes, created once
//
// `store-slug` is `owner__repo`. Everything is owner-only (`0700` folders,
// `0600` files); every write is atomic; nothing here ever prints or logs the
// machine secret.

import { randomBytes, createHash } from "node:crypto"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { ENUMS, PATTERNS, validateLocalFacts } from "./schema.js"

const OWNER_DIR_MODE = 0o700
const OWNER_FILE_MODE = 0o600
const ROOT_SEGMENTS = ["ouroboros-skills", "desk", "factory"]
const MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000
const VISIBILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000
const ACCOUNT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/u
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const MARKER_KEYS = [
  "schema_version", "host", "session_id", "log_path", "cwd", "desk_root",
  "end_reason", "ended_at", "plugins", "updated_at",
].sort().join(",")

const defaultNow = () => new Date().toISOString()

function fail(label, detail) {
  throw new TypeError(`${label}: ${detail}`)
}

function unsafeStateRoot(detail) {
  const error = new Error(`unsafe_state_root: ${detail}`)
  error.code = "unsafe_state_root"
  throw error
}

// ---------------------------------------------------------------------------
// Small, reusable guards. Each is exercised directly (both outcomes) by its
// own tests, so every call site below needs no repeat coverage of these
// branches — only its own business logic does.
// ---------------------------------------------------------------------------

function requireString(value, label) {
  if (typeof value !== "string" || value === "") fail(label, "must be a non-empty string")
}

function requirePattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(label, "must match the required pattern")
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(label, "must be a boolean")
}

function requireEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(label, "must be a known value")
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(label, "must be an absolute path")
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "must be an object")
}

// ---------------------------------------------------------------------------
// The protected root.
// ---------------------------------------------------------------------------

function resolveStateHome(env) {
  const home = env.HOME ?? os.homedir()
  const configured = env.XDG_STATE_HOME
  if (typeof configured === "string" && configured.trim() !== "") return path.resolve(configured)
  return path.join(home, ".local", "state")
}

function assertNotGitCheckout(dir) {
  if (lstatIfPresent(path.join(dir, ".git")) !== null) {
    unsafeStateRoot(`refusing the protected state root inside the Git checkout at ${dir}`)
  }
}

function assertOutsideGitWorkspace(start) {
  let cursor = start
  while (true) {
    assertNotGitCheckout(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

// Any failure (missing, a missing parent directory, ...) reads as "not
// present": the callers below only ever branch on symlink-ness or type, and
// a path that can't even be inspected is, for those purposes, not there.
function lstatIfPresent(target) {
  try {
    return lstatSync(target)
  } catch {
    return null
  }
}

function ensureOwnerOnlyDir(dir) {
  let stat = lstatIfPresent(dir)
  if (stat === null) {
    mkdirSync(dir, { mode: OWNER_DIR_MODE })
    stat = lstatSync(dir)
  }
  if (stat.isSymbolicLink()) unsafeStateRoot(`protected state root path component is a symlink: ${dir}`)
  if (!stat.isDirectory()) unsafeStateRoot(`protected state root path component is not a directory: ${dir}`)
  if ((stat.mode & 0o777) !== OWNER_DIR_MODE) chmodSync(dir, OWNER_DIR_MODE)
}

function assertNotSymlink(file, label) {
  const stat = lstatIfPresent(file)
  if (stat !== null && stat.isSymbolicLink()) unsafeStateRoot(`${label} path is a symlink and will not be used: ${file}`)
}

/** The protected factory state root, created if needed. Throws `unsafe_state_root` (see `.code`) inside a Git checkout or through a symlinked path component. */
export function factoryStateRoot(env = process.env) {
  const stateHome = resolveStateHome(env)
  mkdirSync(stateHome, { recursive: true })
  assertOutsideGitWorkspace(stateHome)
  let cursor = stateHome
  for (const segment of ROOT_SEGMENTS) {
    cursor = path.join(cursor, segment)
    ensureOwnerOnlyDir(cursor)
  }
  return cursor
}

function ensureDirChain(dir, root) {
  const relative = path.relative(root, dir)
  if (relative === "") return
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    ensureOwnerOnlyDir(cursor)
  }
}

// ---------------------------------------------------------------------------
// Atomic read/write of small local files.
// ---------------------------------------------------------------------------

function readJsonFile(file, fallback) {
  assertNotSymlink(file, "state file")
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return fallback
    throw error
  }
  return JSON.parse(text)
}

function writeAtomic(root, file, data) {
  assertNotSymlink(file, "state file")
  ensureDirChain(path.dirname(file), root)
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${randomBytes(4).toString("hex")}`)
  writeFileSync(tmp, data, { mode: OWNER_FILE_MODE })
  renameSync(tmp, file)
}

function writeJsonAtomic(root, file, value) {
  writeAtomic(root, file, `${JSON.stringify(value)}\n`)
}

function listDirSafe(dir) {
  try {
    return readdirSync(dir).sort()
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

// ---------------------------------------------------------------------------
// Stores and file names.
// ---------------------------------------------------------------------------

function storeSlug(store) {
  requirePattern(store, PATTERNS.prRepo, "store")
  return store.replace("/", "__")
}

/** `gitBlobSha(bytes) -> string`: `sha1("blob " + length + "\0" + bytes)`, matching `git hash-object`. */
export function gitBlobSha(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const header = Buffer.from(`blob ${buffer.length}\0`, "utf8")
  return createHash("sha1").update(Buffer.concat([header, buffer])).digest("hex")
}

// ---------------------------------------------------------------------------
// Consent.
// ---------------------------------------------------------------------------

/** `readConsent(env) -> Consent`, `{ schema_version: 1, stores: {} }` when nothing has been decided yet. */
export function readConsent(env) {
  const root = factoryStateRoot(env)
  return readJsonFile(path.join(root, "consent.json"), { schema_version: 1, stores: {} })
}

/**
 * `setConsent(env, { store, contribute, account }) -> Consent`. On the
 * first `contribute: true` for a store, generates and keeps that store's
 * `intake_id` (`crypto.randomBytes(8)`, hex); a later decision, yes or no,
 * keeps whatever `intake_id` already exists rather than replacing it.
 */
export function setConsent(env, { store, contribute, account = null } = {}, { now = defaultNow } = {}) {
  requirePattern(store, PATTERNS.prRepo, "store")
  requireBoolean(contribute, "contribute")
  if (account !== null) requirePattern(account, ACCOUNT_PATTERN, "account")
  const consent = readConsent(env)
  const existing = consent.stores[store]
  const intakeId = existing?.intake_id ?? (contribute ? randomBytes(8).toString("hex") : null)
  const next = {
    ...consent,
    stores: { ...consent.stores, [store]: { contribute, decided_at: now(), account, intake_id: intakeId } },
  }
  const root = factoryStateRoot(env)
  writeJsonAtomic(root, path.join(root, "consent.json"), next)
  return next
}

// ---------------------------------------------------------------------------
// Markers.
// ---------------------------------------------------------------------------

function assertMarkerShape(marker) {
  requirePlainObject(marker, "marker")
  if (Object.keys(marker).sort().join(",") !== MARKER_KEYS) fail("marker", "must have exactly the marker fields")
  if (marker.schema_version !== 1) fail("marker.schema_version", "must be 1")
  requireEnum(marker.host, ENUMS.host, "marker.host")
  requirePattern(marker.session_id, PATTERNS.sessionId, "marker.session_id")
  requirePattern(marker.updated_at, PATTERNS.timestamp, "marker.updated_at")
}

/** Writes `markers/<host>-<session_id>.json`. Markers are local bookkeeping only; they never leave the machine. */
export function writeMarker(env, marker) {
  assertMarkerShape(marker)
  const root = factoryStateRoot(env)
  const name = `${marker.host}-${marker.session_id}.json`
  writeJsonAtomic(root, path.join(root, "markers", name), marker)
  return marker
}

/** `listMarkers(env) -> Marker[]`, pruning (deleting) any marker whose `updated_at` is more than 30 days old. */
export function listMarkers(env, { now = defaultNow } = {}) {
  const root = factoryStateRoot(env)
  const dir = path.join(root, "markers")
  const nowMs = Date.parse(now())
  const kept = []
  for (const name of listDirSafe(dir)) {
    const file = path.join(dir, name)
    const marker = JSON.parse(readFileSync(file, "utf8"))
    if (nowMs - Date.parse(marker.updated_at) > MARKER_TTL_MS) {
      unlinkSync(file)
      continue
    }
    kept.push(marker)
  }
  return kept
}

// ---------------------------------------------------------------------------
// Local facts outbox.
// ---------------------------------------------------------------------------

/**
 * Validates `localFacts` and writes it to the outbox for `store`, unless
 * that store's consent is absent or `contribute: false` (a no-op then).
 * Invalid facts are never written.
 */
export function writeLocalFacts(env, store, localFacts) {
  const slug = storeSlug(store)
  const consent = readConsent(env)
  const record = consent.stores[store]
  if (record === undefined || record.contribute !== true) return { written: false, errors: [] }
  const { ok, errors } = validateLocalFacts(localFacts)
  if (!ok) return { written: false, errors }
  const root = factoryStateRoot(env)
  const name = `${localFacts.session.host}-${localFacts.session.id}.json`
  writeAtomic(root, path.join(root, "outbox", slug, name), `${JSON.stringify(localFacts)}\n`)
  return { written: true, name }
}

/**
 * `pendingFiles(env, store, { publishedBytesFor }) -> Array<{ name, localBytes }>`:
 * every outbox file, minus quarantine, whose last delivered published blob
 * SHA differs from `gitBlobSha(publishedBytesFor(localFacts))`. A file
 * `publishedBytesFor` answers `null` for (nothing publishable yet) is
 * skipped, not marked pending.
 */
export function pendingFiles(env, store, { publishedBytesFor }) {
  if (typeof publishedBytesFor !== "function") fail("publishedBytesFor", "must be a function")
  const slug = storeSlug(store)
  const root = factoryStateRoot(env)
  const outboxDir = path.join(root, "outbox", slug)
  const delivered = readJsonFile(path.join(root, "delivered", `${slug}.json`), {})
  const quarantined = new Set(listDirSafe(path.join(root, "quarantine", slug)))
  const pending = []
  for (const name of listDirSafe(outboxDir)) {
    if (quarantined.has(name)) continue
    const localBytes = readFileSync(path.join(outboxDir, name))
    const localFacts = JSON.parse(localBytes.toString("utf8"))
    const publishedBytes = publishedBytesFor(localFacts)
    if (publishedBytes === null) continue
    const sha = gitBlobSha(publishedBytes)
    if (delivered[name] !== sha) pending.push({ name, localBytes })
  }
  return pending
}

/** Records `name` as delivered with `publishedBlobSha` for `store`. */
export function markDelivered(env, store, { name, publishedBlobSha }) {
  requireString(name, "name")
  requirePattern(publishedBlobSha, SHA1, "publishedBlobSha")
  const slug = storeSlug(store)
  const root = factoryStateRoot(env)
  const file = path.join(root, "delivered", `${slug}.json`)
  const next = { ...readJsonFile(file, {}), [name]: publishedBlobSha }
  writeJsonAtomic(root, file, next)
  return next
}

/** Quarantines outbox file `name` for `store` under `reason` (a transform refusal or CI rejection code). */
export function quarantine(env, store, name, reason, { now = defaultNow } = {}) {
  requireString(name, "name")
  if (name.includes("/") || name.includes("\\")) fail("name", "must be a bare file name")
  requirePattern(reason, REASON_PATTERN, "reason")
  const slug = storeSlug(store)
  const root = factoryStateRoot(env)
  const record = { reason, at: now() }
  writeJsonAtomic(root, path.join(root, "quarantine", slug, name), record)
  return record
}

// ---------------------------------------------------------------------------
// Status and the visibility cache.
// ---------------------------------------------------------------------------

/** `readStatus(env) -> { last_flush: { <store>: { at, result } } }`. */
export function readStatus(env) {
  const root = factoryStateRoot(env)
  return readJsonFile(path.join(root, "status.json"), { last_flush: {} })
}

/** Merges `patch` into `status.json`; `patch.last_flush` merges per-store rather than replacing the whole map. */
export function writeStatus(env, patch) {
  requirePlainObject(patch, "patch")
  const root = factoryStateRoot(env)
  const file = path.join(root, "status.json")
  const current = readJsonFile(file, { last_flush: {} })
  const next = { ...current, ...patch }
  if (Object.hasOwn(patch, "last_flush")) next.last_flush = { ...current.last_flush, ...patch.last_flush }
  writeJsonAtomic(root, file, next)
  return next
}

/** `readVisibilityCache(env) -> { <owner/repo>: { visibility, checked_at } }`, entries older than 7 days omitted. */
export function readVisibilityCache(env, { now = defaultNow } = {}) {
  const root = factoryStateRoot(env)
  const cache = readJsonFile(path.join(root, "visibility.json"), {})
  const nowMs = Date.parse(now())
  const fresh = {}
  for (const [key, entry] of Object.entries(cache)) {
    if (nowMs - Date.parse(entry.checked_at) <= VISIBILITY_TTL_MS) fresh[key] = entry
  }
  return fresh
}

/** Merges `patch` entries into `visibility.json` (also holds the desk's own remote, keyed by its normalized form). */
export function writeVisibilityCache(env, patch) {
  requirePlainObject(patch, "patch")
  const root = factoryStateRoot(env)
  const file = path.join(root, "visibility.json")
  const next = { ...readJsonFile(file, {}), ...patch }
  writeJsonAtomic(root, file, next)
  return next
}

// ---------------------------------------------------------------------------
// The machine secret.
// ---------------------------------------------------------------------------

/** 32 random bytes, created once on first use and kept `0600`. Never logged or printed. */
export function readMachineSecret(env) {
  const root = factoryStateRoot(env)
  const file = path.join(root, "machine-secret")
  assertNotSymlink(file, "machine secret")
  try {
    return readFileSync(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const secret = randomBytes(32)
  writeAtomic(root, file, secret)
  return secret
}

// ---------------------------------------------------------------------------
// Finalize requests and the jobs index.
// ---------------------------------------------------------------------------

/** Written by a Desk task tool on `done`/`cancelled` (spec §6, "Syncing when a task is done"). */
export function requestFinalize(env, { job, deskRoot }, { now = defaultNow } = {}) {
  requirePattern(job, PATTERNS.jobId, "job")
  requireAbsolutePath(deskRoot, "deskRoot")
  const root = factoryStateRoot(env)
  const record = { schema_version: 1, job, desk_root: deskRoot, requested_at: now() }
  writeJsonAtomic(root, path.join(root, "finalize", `${job}.json`), record)
  return record
}

/** Every pending finalize request. */
export function listFinalizeRequests(env) {
  const root = factoryStateRoot(env)
  const dir = path.join(root, "finalize")
  return listDirSafe(dir).map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")))
}

/** Removes `finalize/<job>.json` once delivered; a no-op when it is already gone. */
export function clearFinalize(env, job) {
  requirePattern(job, PATTERNS.jobId, "job")
  const root = factoryStateRoot(env)
  try {
    unlinkSync(path.join(root, "finalize", `${job}.json`))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

/** `readJobsIndex(env) -> { <job>: [<outbox file name>, ...] }`. */
export function readJobsIndex(env) {
  const root = factoryStateRoot(env)
  return readJsonFile(path.join(root, "jobs-index.json"), {})
}

/** Adds `fileName` to `job`'s entry (deduplicated); lets finalize and the boot check find a job's sessions without reading logs. */
export function updateJobsIndex(env, job, fileName) {
  requirePattern(job, PATTERNS.jobId, "job")
  requireString(fileName, "fileName")
  const root = factoryStateRoot(env)
  const file = path.join(root, "jobs-index.json")
  const current = readJsonFile(file, {})
  const existing = current[job] ?? []
  const next = { ...current, [job]: existing.includes(fileName) ? existing : [...existing, fileName] }
  writeJsonAtomic(root, file, next)
  return next
}
