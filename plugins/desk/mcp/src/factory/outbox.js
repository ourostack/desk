// The local outbox and consent: the protected, owner-only state folder that
// holds everything a machine keeps before (and instead of) sending anything
// to a factory store — consent per store, pending-session markers, local
// facts waiting to be published, delivered and quarantined records, the
// visibility cache, finalize requests, the jobs index and a machine secret.
//
// Every guard here is the same implementation `src/protected/store.js` uses,
// shared rather than duplicated: the directory-chain and leaf-file POSIX
// guards (refuse a Git checkout at any ancestor and any owned subfolder,
// refuse a symlink, refuse a hard link, clear a macOS extended ACL) live in
// `./os-protect.js`; Windows owner-only protection is `./windows-acl.js`'s
// `protectWindowsPaths` (a verified NTFS DACL rewrite, batched once per
// operation rather than once per path) — the same routine
// `src/protected/store.js` and `src/readiness/journal.js` call, moved under
// `src/factory/` (the one place every caller, including this one, can
// import from: `src/factory/**` may only import `node:` built-ins and other
// `src/factory/` files) with a one-line re-export left at its original path
// so nothing else has to change.
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
// `0600` files); every write is atomic (temp file, fsync, then rename), with
// stale (older than one hour) temp files swept on the next write to that
// folder; every read-modify-write of a shared JSON file (`consent.json`,
// `jobs-index.json`, `delivered/*.json`, `visibility.json`, `status.json`)
// is serialized by a stale-recoverable lock file, the same shape as the
// planned `flush.lock`; a JSON state file that fails to parse, or parses to
// the wrong shape, is moved aside and read as empty, and a corrupt
// local-facts file is quarantined with reason `invalid`, rather than either
// throwing and blocking every other file. A read re-checks the same
// symlink/hard-link/mode/ACL guards a write does, so a file tampered with
// between writes is refused or repaired before any of its bytes are used.
// Nothing here ever prints or logs the machine secret.

import { randomBytes, createHash } from "node:crypto"
import { promises as fsp } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  assertNotGitCheckout,
  assertOutsideGitWorkspace,
  ensureOwnerOnlyDirectory,
  expandHome,
  lstatIfPresent,
  protectLeafFile,
  realpathExistingPrefix,
} from "./os-protect.js"
import { assertWindowsAclAvailable, protectWindowsPaths } from "./windows-acl.js"
import { ENUMS, PATTERNS, isPlainObject, validateLocalFacts } from "./schema.js"

const OWNER_FILE_MODE = 0o600
const ROOT_SEGMENTS = ["ouroboros-skills", "desk", "factory"]
const MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000
const VISIBILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000
const STALE_TMP_MS = 60 * 60 * 1000
const LOCK_STALE_MS = 10 * 60 * 1000
const LOCK_RETRY_DELAY_MS = 15
const ACCOUNT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/u
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const VISIBILITY_VALUES = ["public", "private", "unknown"]
const SESSION_ID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const OUTBOX_NAME_PATTERN = new RegExp(`^(?:${ENUMS.host.join("|")})-${SESSION_ID_SRC}\\.json$`, "u")
const FINALIZE_NAME_PATTERN = /^[0-9a-f]{32}\.json$/u
const MARKER_KEYS = [
  "schema_version", "host", "session_id", "log_path", "cwd", "desk_root",
  "end_reason", "ended_at", "plugins", "updated_at",
].sort().join(",")

// `store.js` uses one `naming` per caller (`desk_feedback`, `desk_work_ledger`);
// this is the factory outbox's, also passed as `protectWindowsPaths`'s `label`.
const NAMING = { label: "desk_factory", subject: "factory state" }

// Shape checks for `readJsonFileSafe`: valid JSON of the wrong shape is
// moved aside exactly like a parse failure, rather than throwing when a
// caller reaches into a field that isn't there.
const isConsentShape = (value) => isPlainObject(value) && isPlainObject(value.stores)
const isStatusShape = (value) => isPlainObject(value) && isPlainObject(value.last_flush)

const defaultNow = () => new Date().toISOString()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(label, detail) {
  throw new TypeError(`${label}: ${detail}`)
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

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(label, "must be an absolute path")
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(label, "must be an object")
}

// ---------------------------------------------------------------------------
// The protected root.
// ---------------------------------------------------------------------------

function resolveStateHome(env) {
  const home = typeof env.HOME === "string" && env.HOME.trim() !== "" ? env.HOME : os.homedir()
  const configured = env.XDG_STATE_HOME
  if (typeof configured === "string" && configured.trim() !== "") {
    return path.resolve(expandHome(configured, home))
  }
  return path.join(home, ".local", "state")
}

/**
 * The protected factory state root, created if needed. Resolves as much of
 * `$XDG_STATE_HOME` (else `~/.local/state`) as already exists and walks its
 * ancestors for a Git checkout *before* creating anything (a refused call
 * leaves no new folders behind); `$XDG_STATE_HOME` itself is created plainly
 * if missing (it is shared with other applications, so it is never chmod'd
 * or ACL-swept), and each of this module's own three segments underneath it
 * is then created or re-verified — symlink refusal, mode repair, macOS
 * extended-ACL clearing — on every call. On Windows, the ACL provider's
 * availability is checked before anything is created, and the three
 * segments are protected with one batched call.
 */
export async function factoryStateRoot(env = process.env, { platform = process.platform, runner = undefined } = {}) {
  if (platform === "win32") assertWindowsAclAvailable({ env, label: NAMING.label })
  const stateHome = resolveStateHome(env)
  const { real: realPrefix } = await realpathExistingPrefix(stateHome)
  await assertOutsideGitWorkspace(realPrefix, NAMING)
  await fsp.mkdir(stateHome, { recursive: true })
  const realStateHome = await fsp.realpath(stateHome)

  let cursor = realStateHome
  const windowsBatch = []
  for (const segment of ROOT_SEGMENTS) {
    cursor = path.join(cursor, segment)
    const created = await ensureOwnerOnlyDirectory(cursor, platform, NAMING)
    await assertNotGitCheckout(cursor, NAMING)
    if (platform === "win32") windowsBatch.push({ path: cursor, kind: "directory", created })
  }
  if (windowsBatch.length > 0) await protectWindowsPaths(windowsBatch, { env, runner, label: NAMING.label })
  return cursor
}

/**
 * Creates or re-verifies every directory between `root` and `dir` (a
 * subfolder this module owns, such as `outbox/<slug>` or `markers`):
 * symlink refusal, mode repair, macOS extended-ACL clearing and a Git-
 * checkout refusal at every one of them — `store.js` checks every segment
 * it owns the same way. `batch`, when given, collects `{path, kind, created}`
 * for the caller's own single Windows-protection call instead of protecting
 * each directory separately.
 */
async function ensureDirChain(dir, root, platform, batch = null) {
  const relative = path.relative(root, dir)
  if (relative === "") return
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const created = await ensureOwnerOnlyDirectory(cursor, platform, NAMING)
    await assertNotGitCheckout(cursor, NAMING)
    if (platform === "win32" && batch !== null) batch.push({ path: cursor, kind: "directory", created })
  }
}

// ---------------------------------------------------------------------------
// Atomic read/write of small local files, corrupt-file recovery, and the
// per-file lock that serializes a read-modify-write.
// ---------------------------------------------------------------------------

async function nextSiblingPath(file, tag) {
  for (let n = 1; ; n += 1) {
    const candidate = `${file}.${tag}-${n}`
    if ((await lstatIfPresent(candidate, NAMING)) === null) return candidate
  }
}

/**
 * Reads JSON, re-checking the same guards a write does (symlink, hard link,
 * mode, macOS extended ACL — `protectLeafFile`, which repairs what it can
 * and refuses what it can't) before any byte is read. A file that fails to
 * parse, or parses to something `isValid` refuses, is moved aside as
 * `<file>.corrupt-json-<n>` and `fallback` is returned for it, exactly as
 * for a missing file.
 */
async function readJsonFileSafe(file, fallback, platform, isValid = isPlainObject) {
  const stat = await lstatIfPresent(file, NAMING)
  if (stat === null) return fallback
  await protectLeafFile(file, platform, NAMING)
  const text = await fsp.readFile(file, "utf8")
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    await fsp.rename(file, await nextSiblingPath(file, "corrupt-json"))
    return fallback
  }
  if (!isValid(parsed)) {
    await fsp.rename(file, await nextSiblingPath(file, "corrupt-json"))
    return fallback
  }
  return parsed
}

// Called only from `writeAtomic`, after `ensureDirChain` has already
// created `dir`, so it is never asked to sweep a folder that doesn't exist.
async function sweepStaleTmp(dir) {
  const names = await fsp.readdir(dir)
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith(".tmp-")) continue
    const full = path.join(dir, name)
    let stat
    try {
      stat = await fsp.stat(full)
    } catch {
      continue
    }
    if (now - stat.mtimeMs > STALE_TMP_MS) await fsp.unlink(full).catch(() => {})
  }
}

/**
 * Writes `data` to `file` atomically (temp file in the same folder, `fsync`,
 * then rename) and protects the result — owner-only mode, no symlink, no
 * hard link, no macOS extended ACL. Any subfolder this creates and the leaf
 * file itself are protected on Windows with one batched call.
 */
async function writeAtomic(root, file, data, { platform, env, runner }) {
  const dir = path.dirname(file)
  const windowsBatch = []
  await ensureDirChain(dir, root, platform, windowsBatch)
  await sweepStaleTmp(dir)
  const existedBefore = (await lstatIfPresent(file, NAMING)) !== null
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${randomBytes(4).toString("hex")}`)
  const handle = await fsp.open(tmp, "w", OWNER_FILE_MODE)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(tmp, file)
  await protectLeafFile(file, platform, NAMING)
  if (platform === "win32") {
    windowsBatch.push({ path: file, kind: "file", created: !existedBefore })
    await protectWindowsPaths(windowsBatch, { env, runner, label: NAMING.label })
  }
}

async function writeJsonAtomic(root, file, value, options) {
  await writeAtomic(root, file, `${JSON.stringify(value)}\n`, options)
}

async function listDirSafe(dir) {
  try {
    return (await fsp.readdir(dir)).sort()
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

/** Directory entries matching `pattern`, `lstat`-checked one by one: a symlink, a directory, a hard-linked file or any other non-regular entry is silently skipped, never read and never followed. */
async function listRegularFiles(dir, pattern) {
  const kept = []
  for (const name of await listDirSafe(dir)) {
    if (!pattern.test(name)) continue
    const stat = await lstatIfPresent(path.join(dir, name), NAMING)
    if (stat !== null && stat.isFile() && stat.nlink === 1) kept.push(name)
  }
  return kept
}

/**
 * Serializes a read-modify-write of `file` with an `O_EXCL` lock file next
 * to it (`<file>.lock`, holding `{pid, started_at}`), the same shape as the
 * planned `flush.lock`: a lock older than 10 minutes is treated as
 * abandoned and removed before retrying, never waited on. The lock file
 * itself is not Windows-ACL-protected — it lives inside an already-protected
 * directory (every directory this module owns grants only the current user,
 * with inheritance, so a fresh file created inside one is never exposed by
 * default) and is gone again within milliseconds.
 */
async function withLock(root, file, platform, body) {
  const lockFile = `${file}.lock`
  await ensureDirChain(path.dirname(lockFile), root, platform)
  while (true) {
    try {
      const handle = await fsp.open(lockFile, "wx", OWNER_FILE_MODE)
      try {
        // Content is written for a human or a later debugging session to
        // read; staleness itself never depends on it (see below), so a
        // waiter can never observe it as half-written and misjudge a live
        // lock as abandoned.
        await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      // Staleness is judged from the lock file's own creation time
      // (filesystem metadata, set atomically by `open`), never by parsing
      // its content: content is written in a second step after the file
      // already exists, so a waiter that read it for staleness instead
      // could catch it empty or partial, misread a live lock as abandoned,
      // delete it out from under its legitimate holder, and acquire its
      // own — two holders at once, and a lost update.
      let stale
      try {
        stale = Date.now() - (await fsp.stat(lockFile)).mtimeMs > LOCK_STALE_MS
      } catch (statError) {
        if (statError.code === "ENOENT") continue // already gone; retry the open right away
        throw statError
      }
      if (stale) {
        await fsp.unlink(lockFile).catch(() => {})
        continue
      }
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }
  try {
    return await body()
  } finally {
    await fsp.unlink(lockFile).catch(() => {})
  }
}

/** Lock-guarded `readJsonFileSafe` + `mutate` + atomic write; returns the written value. */
async function updateJsonLocked(root, file, fallback, mutate, options, isValid = isPlainObject) {
  const { platform } = options
  return withLock(root, file, platform, async () => {
    const current = await readJsonFileSafe(file, fallback, platform, isValid)
    const next = mutate(current)
    await writeJsonAtomic(root, file, next, options)
    return next
  })
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

async function readConsentAt(root, platform) {
  return readJsonFileSafe(path.join(root, "consent.json"), { schema_version: 1, stores: {} }, platform, isConsentShape)
}

/** `readConsent(env) -> Consent`, `{ schema_version: 1, stores: {} }` when nothing has been decided yet. */
export async function readConsent(env, { platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  return readConsentAt(root, platform)
}

/**
 * `setConsent(env, { store, contribute, account }) -> Consent`. On the
 * first `contribute: true` for a store, generates and keeps that store's
 * `intake_id` (`crypto.randomBytes(8)`, hex); a later decision, yes or no,
 * keeps whatever `intake_id` already exists rather than replacing it.
 * Concurrent decisions for different stores are serialized so none is lost.
 */
export async function setConsent(env, { store, contribute, account = null } = {}, { now = defaultNow, platform = process.platform, runner = undefined } = {}) {
  requirePattern(store, PATTERNS.prRepo, "store")
  requireBoolean(contribute, "contribute")
  if (account !== null) requirePattern(account, ACCOUNT_PATTERN, "account")
  const root = await factoryStateRoot(env, { platform, runner })
  const file = path.join(root, "consent.json")
  return updateJsonLocked(root, file, { schema_version: 1, stores: {} }, (consent) => {
    const existing = consent.stores[store]
    const intakeId = existing?.intake_id ?? (contribute ? randomBytes(8).toString("hex") : null)
    return {
      ...consent,
      stores: { ...consent.stores, [store]: { contribute, decided_at: now(), account, intake_id: intakeId } },
    }
  }, { platform, env, runner }, isConsentShape)
}

// ---------------------------------------------------------------------------
// Markers.
// ---------------------------------------------------------------------------

function assertMarkerShape(marker) {
  requirePlainObject(marker, "marker")
  if (Object.keys(marker).sort().join(",") !== MARKER_KEYS) fail("marker", "must have exactly the marker fields")
  if (marker.schema_version !== 1) fail("marker.schema_version", "must be 1")
  if (!ENUMS.host.includes(marker.host)) fail("marker.host", "must be a known host")
  requirePattern(marker.session_id, PATTERNS.sessionId, "marker.session_id")
  requirePattern(marker.updated_at, PATTERNS.timestamp, "marker.updated_at")
}

/** Writes `markers/<host>-<session_id>.json`. Markers are local bookkeeping only; they never leave the machine. */
export async function writeMarker(env, marker, { platform = process.platform, runner = undefined } = {}) {
  assertMarkerShape(marker)
  const root = await factoryStateRoot(env, { platform, runner })
  const name = `${marker.host}-${marker.session_id}.json`
  await writeJsonAtomic(root, path.join(root, "markers", name), marker, { platform, env, runner })
  return marker
}

/**
 * `listMarkers(env) -> Marker[]`: prunes (deletes) a marker whose
 * `updated_at` cannot be parsed or is more than 30 days old; a marker that
 * fails to parse as JSON is dropped the same way rather than blocking every
 * other marker. Only regular files matching the marker name shape are
 * considered; a symlink, a hard link, a leftover temp file or anything else
 * is skipped.
 */
export async function listMarkers(env, { now = defaultNow, platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  const dir = path.join(root, "markers")
  const nowMs = Date.parse(now())
  const kept = []
  for (const name of await listRegularFiles(dir, OUTBOX_NAME_PATTERN)) {
    const file = path.join(dir, name)
    let marker
    try {
      marker = JSON.parse(await fsp.readFile(file, "utf8"))
    } catch {
      await fsp.unlink(file).catch(() => {})
      continue
    }
    const updatedMs = Date.parse(marker?.updated_at)
    if (!Number.isFinite(updatedMs) || nowMs - updatedMs > MARKER_TTL_MS) {
      await fsp.unlink(file).catch(() => {})
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
export async function writeLocalFacts(env, store, localFacts, { platform = process.platform, runner = undefined } = {}) {
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env, { platform, runner })
  const consent = await readConsentAt(root, platform)
  const record = consent.stores[store]
  if (record === undefined || record.contribute !== true) return { written: false, errors: [] }
  const { ok, errors } = validateLocalFacts(localFacts)
  if (!ok) return { written: false, errors }
  const name = `${localFacts.session.host}-${localFacts.session.id}.json`
  await writeAtomic(root, path.join(root, "outbox", slug, name), `${JSON.stringify(localFacts)}\n`, { platform, env, runner })
  return { written: true, name }
}

/**
 * `pendingFiles(env, store, { publishedBytesFor }) -> Array<{ name, localBytes }>`:
 * every outbox file, minus quarantine, whose last delivered published blob
 * SHA differs from `gitBlobSha(publishedBytesFor(localFacts))`. A file
 * `publishedBytesFor` answers `null` for (nothing publishable yet) is
 * skipped; a file that fails to parse as JSON is quarantined with reason
 * `invalid` instead of blocking the rest. Only regular files matching the
 * outbox name shape are considered.
 */
export async function pendingFiles(env, store, { publishedBytesFor }, { platform = process.platform, runner = undefined } = {}) {
  if (typeof publishedBytesFor !== "function") fail("publishedBytesFor", "must be a function")
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env, { platform, runner })
  const outboxDir = path.join(root, "outbox", slug)
  const delivered = await readJsonFileSafe(path.join(root, "delivered", `${slug}.json`), {}, platform)
  const quarantined = new Set(await listRegularFiles(path.join(root, "quarantine", slug), OUTBOX_NAME_PATTERN))
  const pending = []
  for (const name of await listRegularFiles(outboxDir, OUTBOX_NAME_PATTERN)) {
    if (quarantined.has(name)) continue
    let localFacts
    let localBytes
    try {
      localBytes = await fsp.readFile(path.join(outboxDir, name))
      localFacts = JSON.parse(localBytes.toString("utf8"))
    } catch {
      await quarantine(env, store, name, "invalid", { platform, runner })
      continue
    }
    const publishedBytes = publishedBytesFor(localFacts)
    if (publishedBytes === null) continue
    const sha = gitBlobSha(publishedBytes)
    if (delivered[name] !== sha) pending.push({ name, localBytes })
  }
  return pending
}

/** Records `name` as delivered with `publishedBlobSha` for `store`. Concurrent deliveries for the same store are serialized so none is lost. */
export async function markDelivered(env, store, { name, publishedBlobSha }, { platform = process.platform, runner = undefined } = {}) {
  requireString(name, "name")
  requirePattern(publishedBlobSha, SHA1, "publishedBlobSha")
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env, { platform, runner })
  const file = path.join(root, "delivered", `${slug}.json`)
  return updateJsonLocked(root, file, {}, (current) => ({ ...current, [name]: publishedBlobSha }), { platform, env, runner })
}

/** Quarantines outbox file `name` (must be a real outbox file name) for `store` under `reason` (a transform refusal or CI rejection code). */
export async function quarantine(env, store, name, reason, { now = defaultNow, platform = process.platform, runner = undefined } = {}) {
  requirePattern(name, OUTBOX_NAME_PATTERN, "name")
  requirePattern(reason, REASON_PATTERN, "reason")
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env, { platform, runner })
  const record = { reason, at: now() }
  await writeJsonAtomic(root, path.join(root, "quarantine", slug, name), record, { platform, env, runner })
  return record
}

// ---------------------------------------------------------------------------
// Status and the visibility cache.
// ---------------------------------------------------------------------------

/** `readStatus(env) -> { last_flush: { <store>: { at, result } } }`. */
export async function readStatus(env, { platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  return readJsonFileSafe(path.join(root, "status.json"), { last_flush: {} }, platform, isStatusShape)
}

/** Merges `patch` into `status.json`; `patch.last_flush` merges per-store rather than replacing the whole map. Concurrent patches are serialized so none is lost. */
export async function writeStatus(env, patch, { platform = process.platform, runner = undefined } = {}) {
  requirePlainObject(patch, "patch")
  const root = await factoryStateRoot(env, { platform, runner })
  const file = path.join(root, "status.json")
  return updateJsonLocked(root, file, { last_flush: {} }, (current) => {
    const next = { ...current, ...patch }
    if (Object.hasOwn(patch, "last_flush")) next.last_flush = { ...current.last_flush, ...patch.last_flush }
    return next
  }, { platform, env, runner }, isStatusShape)
}

function assertVisibilityEntries(patch) {
  for (const [key, entry] of Object.entries(patch)) {
    requirePlainObject(entry, `patch[${JSON.stringify(key)}]`)
    if (!VISIBILITY_VALUES.includes(entry.visibility)) fail(`patch[${JSON.stringify(key)}].visibility`, "must be public, private or unknown")
    requirePattern(entry.checked_at, PATTERNS.timestamp, `patch[${JSON.stringify(key)}].checked_at`)
  }
}

/** `readVisibilityCache(env) -> { <owner/repo>: { visibility, checked_at } }`, entries older than 7 days, or not shaped like an entry at all, omitted. */
export async function readVisibilityCache(env, { now = defaultNow, platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  const cache = await readJsonFileSafe(path.join(root, "visibility.json"), {}, platform)
  const nowMs = Date.parse(now())
  const fresh = {}
  for (const [key, entry] of Object.entries(cache)) {
    if (!isPlainObject(entry)) continue
    if (nowMs - Date.parse(entry.checked_at) <= VISIBILITY_TTL_MS) fresh[key] = entry
  }
  return fresh
}

/** Merges validated `patch` entries into `visibility.json` (also holds the desk's own remote, keyed by its normalized form). Concurrent patches are serialized so none is lost. */
export async function writeVisibilityCache(env, patch, { platform = process.platform, runner = undefined } = {}) {
  requirePlainObject(patch, "patch")
  assertVisibilityEntries(patch)
  const root = await factoryStateRoot(env, { platform, runner })
  const file = path.join(root, "visibility.json")
  return updateJsonLocked(root, file, {}, (current) => ({ ...current, ...patch }), { platform, env, runner })
}

// ---------------------------------------------------------------------------
// The machine secret.
// ---------------------------------------------------------------------------

async function recordSecretRotated(root, env, platform, runner, from) {
  const file = path.join(root, "status.json")
  await updateJsonLocked(root, file, { last_flush: {} }, (current) => ({
    ...current,
    machine_secret: { status: "secret_rotated", at: defaultNow(), from: path.basename(from) },
  }), { platform, env, runner }, isStatusShape)
}

/**
 * 32 random bytes, created once on first use and kept `0600`. Created with
 * an exclusive hard link (write a fully-synced, uniquely named temp file,
 * then `link` it into place) so the final file is either absent or fully
 * written — never partial — and concurrent first callers all end up reading
 * the same winner's bytes rather than minting their own. Read back, it must
 * be exactly 32 bytes; a wrong size is rotated *under this file's own lock*,
 * re-checking the size inside it (so concurrent readers of a corrupt secret
 * serialize on the fix-up instead of racing each other to rename the same
 * file), moved aside as `machine-secret.corrupt-<n>` with a fresh one
 * created and `status.json` recording `{status: "secret_rotated"}` — a
 * rotated secret only changes the keyed job IDs of a public desk, which is
 * acceptable. Never logged or printed.
 */
export async function readMachineSecret(env, { platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  return resolveMachineSecret(root, env, platform, runner)
}

async function resolveMachineSecret(root, env, platform, runner) {
  const file = path.join(root, "machine-secret")
  const existing = await lstatIfPresent(file, NAMING)
  if (existing === null) return createMachineSecret(root, file, env, platform, runner)
  return readExistingSecret(root, file, env, platform, runner)
}

async function createMachineSecret(root, file, env, platform, runner) {
  const secret = randomBytes(32)
  const tmp = path.join(root, `.tmp-machine-secret-${process.pid}-${randomBytes(4).toString("hex")}`)
  const handle = await fsp.open(tmp, "w", OWNER_FILE_MODE)
  try {
    await handle.writeFile(secret)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.link(tmp, file)
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    if (error.code === "EEXIST") return readExistingSecret(root, file, env, platform, runner)
    throw error
  }
  await fsp.unlink(tmp).catch(() => {})
  await protectSecretFile(root, file, platform, NAMING)
  if (platform === "win32") {
    await protectWindowsPaths([{ path: file, kind: "file", created: true }], { env, runner, label: NAMING.label })
  }
  return secret
}

// If the winner of `createMachineSecret`'s `link` crashed before its own
// `unlink(tmp)`, the leftover `.tmp-machine-secret-*` keeps this file's
// `nlink` at 2 forever (nothing but a write to the root's own folder sweeps
// a stale temp file, and this secret's own reads never write there).
// Detect a leftover that is genuinely the same inode — not merely a
// same-shaped name, which could belong to a different, still-in-flight
// creation — and remove it before treating a lingering `nlink !== 1` as a
// real hard-link attack.
async function cleanupOrphanedSecretLink(root, ino) {
  let names
  try {
    names = await fsp.readdir(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(".tmp-machine-secret-")) continue
    const candidate = path.join(root, name)
    const candidateStat = await lstatIfPresent(candidate, NAMING)
    if (candidateStat !== null && candidateStat.ino === ino) await fsp.unlink(candidate).catch(() => {})
  }
}

// `createMachineSecret`'s own winner also briefly holds two names for the
// same inode (`tmp`, then `file`) between its `link` and its own
// `unlink(tmp)`; a concurrent loser reading `file` in that narrow window
// sees `nlink === 2` and would otherwise misread its rival's own
// cleanup-in-progress as a real hard-link attack. A few short retries clear
// a transient `nlink` before falling back to the crash-leftover cleanup
// above and, failing that, `protectLeafFile`'s hard-link refusal.
async function protectSecretFile(root, file, platform, naming) {
  let stat
  for (let attempt = 0; attempt < 5; attempt += 1) {
    stat = await lstatIfPresent(file, naming)
    if (stat === null || stat.isSymbolicLink() || !stat.isFile() || stat.nlink === 1) break
    await sleep(5)
  }
  if (stat !== null && stat.isFile() && !stat.isSymbolicLink() && stat.nlink !== 1) {
    await cleanupOrphanedSecretLink(root, stat.ino)
  }
  await protectLeafFile(file, platform, naming)
}

async function readExistingSecret(root, file, env, platform, runner) {
  try {
    await protectSecretFile(root, file, platform, NAMING)
    const bytes = await fsp.readFile(file)
    if (bytes.length === 32) return bytes
  } catch {
    // Anything unexpected here (a validation failure, or the file changing
    // out from under this read) resolves the same way: work it out properly
    // under the lock below, rather than trying to distinguish every cause.
  }
  return withLock(root, file, platform, () => resolveSecretLocked(root, file, env, platform, runner))
}

// Runs under `file`'s own lock: re-reads and re-validates from scratch, so a
// caller that loses the race to a concurrent rotation simply sees the
// winner's already-fixed-up file instead of redoing the fix-up itself.
async function resolveSecretLocked(root, file, env, platform, runner) {
  const existing = await lstatIfPresent(file, NAMING)
  if (existing === null) return createMachineSecret(root, file, env, platform, runner)
  await protectSecretFile(root, file, platform, NAMING)
  const bytes = await fsp.readFile(file)
  if (bytes.length === 32) return bytes
  const corrupt = await nextSiblingPath(file, "corrupt")
  await fsp.rename(file, corrupt)
  await recordSecretRotated(root, env, platform, runner, corrupt)
  return createMachineSecret(root, file, env, platform, runner)
}

// ---------------------------------------------------------------------------
// Finalize requests and the jobs index.
// ---------------------------------------------------------------------------

/** Written by a Desk task tool on `done`/`cancelled` (spec §6, "Syncing when a task is done"). */
export async function requestFinalize(env, { job, deskRoot }, { now = defaultNow, platform = process.platform, runner = undefined } = {}) {
  requirePattern(job, PATTERNS.jobId, "job")
  requireAbsolutePath(deskRoot, "deskRoot")
  const root = await factoryStateRoot(env, { platform, runner })
  const record = { schema_version: 1, job, desk_root: deskRoot, requested_at: now() }
  await writeJsonAtomic(root, path.join(root, "finalize", `${job}.json`), record, { platform, env, runner })
  return record
}

/** Every pending finalize request; a request that fails to parse is skipped rather than blocking the rest. */
export async function listFinalizeRequests(env, { platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  const dir = path.join(root, "finalize")
  const results = []
  for (const name of await listRegularFiles(dir, FINALIZE_NAME_PATTERN)) {
    try {
      results.push(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")))
    } catch {
      // A corrupt finalize request is dropped, not allowed to block the rest.
    }
  }
  return results
}

/** Removes `finalize/<job>.json` once delivered; a no-op when it is already gone. */
export async function clearFinalize(env, job, { platform = process.platform, runner = undefined } = {}) {
  requirePattern(job, PATTERNS.jobId, "job")
  const root = await factoryStateRoot(env, { platform, runner })
  try {
    await fsp.unlink(path.join(root, "finalize", `${job}.json`))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

/** `readJobsIndex(env) -> { <job>: [<outbox file name>, ...] }`. */
export async function readJobsIndex(env, { platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  return readJsonFileSafe(path.join(root, "jobs-index.json"), {}, platform)
}

/** Adds `fileName` to `job`'s entry (deduplicated); lets finalize and the boot check find a job's sessions without reading logs. Concurrent updates for different jobs are serialized so none is lost. */
export async function updateJobsIndex(env, job, fileName, { platform = process.platform, runner = undefined } = {}) {
  requirePattern(job, PATTERNS.jobId, "job")
  requireString(fileName, "fileName")
  const root = await factoryStateRoot(env, { platform, runner })
  const file = path.join(root, "jobs-index.json")
  return updateJsonLocked(root, file, {}, (current) => {
    const existing = current[job] ?? []
    return { ...current, [job]: existing.includes(fileName) ? existing : [...existing, fileName] }
  }, { platform, env, runner })
}
