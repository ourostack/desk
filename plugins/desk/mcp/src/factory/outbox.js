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
//   quarantine/<store-slug>/<name>     { reason, at }, and for labels
//                                      held back for quarantined facts
//                                      { reason: "facts_quarantined", facts, at }
//   visibility.json                    repo visibility cache (7-day expiry)
//   status.json                        last flush result per store
//   finalize/<job>.json                a Desk task tool's sync-at-done request
//   jobs-index.json                    job -> [outbox file names]
//   machine-secret                     32 random bytes, created once
//   labels/<store-slug>/<job>/<session_id>.json   local waste labels
//   evaluations/<job>/<store-slug>/<host>-<session_id>.brief.json
//                                      the waste evaluator's brief
//   evaluations/<job>/<store-slug>/<host>-<session_id>.labels.json
//                                      what the evaluator wrote, checked
//                                      before it becomes local labels
//   evaluate-requests/<job>.json       a finished job still needing labels
//   evaluate-requests/quarantine/<job>.json   { reason, at }
//   locks/<name>.lock                  a named critical-section lock with no JSON file of its own
//
// Local labels (`desk.factory.labels/1`) are already on the published
// session clock and carry no free text; like local facts they leave only
// through the publishing transform (`publish.js`'s `toPublishedLabels`),
// which keys the job on a desk that is not known to be private. Their
// delivered record shares `delivered/<store-slug>.json`, keyed
// `labels/<job>/<session_id>.json` so it never meets a facts file name.
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
import { validateLabels } from "./label-schema.js"
import { ENUMS, LIMITS, PATTERNS, isPlainObject, validateLocalFacts } from "./schema.js"
import { MAX_MARKER_BYTES, readSmallText, validMarker } from "./marker.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

const OWNER_FILE_MODE = 0o600
const ROOT_SEGMENTS = ["ouroboros-skills", "desk", "factory"]
const MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000
const VISIBILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000
const STALE_TMP_MS = 60 * 60 * 1000
const LOCK_STALE_MS = 10 * 60 * 1000
const LOCK_RETRY_DELAY_MS = 15
// A GitHub login: letters, digits and hyphens, and for an Enterprise Managed User the enterprise short code after `_`, the account a work store needs.
const ACCOUNT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?(?:_[A-Za-z0-9]{1,20})?$/u
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u
const SHA1 = /^[0-9a-f]{40}$/u
const VISIBILITY_VALUES = ["public", "private", "unknown"]
const SESSION_ID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const OUTBOX_NAME_PATTERN = new RegExp(`^(?:${ENUMS.host.join("|")})-${SESSION_ID_SRC}\\.json$`, "u")
const FINALIZE_NAME_PATTERN = /^[0-9a-f]{32}\.json$/u
const LOCK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
const SESSION_ID_PATTERN = new RegExp(`^${SESSION_ID_SRC}$`, "u")
const LABELS_NAME_PATTERN = new RegExp(`^${SESSION_ID_SRC}\\.json$`, "u")
const LABELS_KEY_PATTERN = new RegExp(`^labels/[0-9a-f]{32}/${SESSION_ID_SRC}\\.json$`, "u")
const BRIEF_NAME_PATTERN = new RegExp(`^((?:${ENUMS.host.join("|")})-${SESSION_ID_SRC})\\.brief\\.json$`, "u")
const STORE_SLUG_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)__([A-Za-z0-9._-]{1,100})$/u

// `store.js` uses one `naming` per caller (`desk_feedback`); this is the
// factory outbox's, also passed as `protectWindowsPaths`'s `label`.
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

async function assertOutsideBoundDesk(target, deskRoot) {
  if (deskRoot === null) return
  requireAbsolutePath(deskRoot, "deskRoot")
  const factory = await realpathExistingPrefix(target)
  const desk = await realpathExistingPrefix(deskRoot)
  const relative = path.relative(path.join(desk.real, ...desk.remainder), path.join(factory.real, ...factory.remainder))
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new Error("desk_factory: private factory state cannot be inside the bound desk")
  }
}

/** Whether `target` resolves under `root` (both realpath'd as far as they already exist). */
async function isUnderRoot(target, root) {
  const resolvedRoot = await realpathExistingPrefix(root)
  const resolvedTarget = await realpathExistingPrefix(target)
  const relative = path.relative(path.join(resolvedRoot.real, ...resolvedRoot.remainder), path.join(resolvedTarget.real, ...resolvedTarget.remainder))
  return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
}

// Defense in depth against a test (or a scratch/throwaway run) whose own
// isolation failed to apply: a desk root that lives under the OS temp
// directory is, by construction, ephemeral — a real desk is never bound
// there. Such a desk root paired with a state home that is *not* also under
// the OS temp directory is exactly the shape of that failure (the desk root
// got isolated into a temp fixture; the state home did not), so it is
// refused here rather than recorded, alongside (not instead of) the test
// harness fix that stops it at the source. A desk root outside temp — every
// real desk — is entirely unaffected: the check returns immediately.
async function assertDeskRootTempConsistency(stateHome, deskRoot) {
  if (deskRoot === null) return
  if (!(await isUnderRoot(deskRoot, os.tmpdir()))) return
  if (await isUnderRoot(stateHome, os.tmpdir())) return
  throw new Error("desk_factory: refused a temp-directory desk root paired with a factory state home outside the OS temp directory")
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
 * segments are protected with one batched call. Also refused, the same way
 * and before anything is created: a `deskRoot` under the OS temp directory
 * paired with a state home that is not (`assertDeskRootTempConsistency`) —
 * a throwaway desk whose isolation did not reach the state home too — and,
 * independent of whether a `deskRoot` was even passed, a state home that is
 * not under the OS temp directory while this process itself looks like a
 * node:test run (`assertNotRealStateUnderTest`; see `./test-state-guard.js`).
 */
export async function factoryStateRoot(env = process.env, { platform = process.platform, runner = undefined, create = true, deskRoot = null } = {}) {
  if (platform === "win32") assertWindowsAclAvailable({ env, label: NAMING.label })
  const stateHome = resolveStateHome(env)
  await assertOutsideBoundDesk(path.join(stateHome, ...ROOT_SEGMENTS), deskRoot)
  await assertDeskRootTempConsistency(stateHome, deskRoot)
  assertNotRealStateUnderTest(stateHome, { env })
  if (!create && (await lstatIfPresent(path.join(stateHome, ...ROOT_SEGMENTS), NAMING)) === null) return null
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
  if (!validMarker(marker)) fail("marker", "invalid marker fields")
  if (Buffer.byteLength(JSON.stringify(marker)) > MAX_MARKER_BYTES) fail("marker", "too large")
}

/** Writes `markers/<host>-<session_id>.json`. Markers are local bookkeeping only; they never leave the machine. */
export async function writeMarker(env, marker, { platform = process.platform, runner = undefined } = {}) {
  assertMarkerShape(marker)
  const root = await factoryStateRoot(env, { platform, runner, deskRoot: marker.desk_root })
  const name = `${marker.host}-${marker.session_id}.json`
  await writeJsonAtomic(root, path.join(root, "markers", name), marker, { platform, env, runner })
  return marker
}

async function protectMarkerDirectory(root, { env, platform, runner }) {
  const dir = path.join(root, "markers")
  const before = await lstatIfPresent(dir, NAMING)
  const batch = []
  await ensureDirChain(dir, root, platform, batch)
  if (platform === "win32") await protectWindowsPaths(batch, { env, runner, label: NAMING.label })
  const identity = await fsp.lstat(dir)
  if (before !== null && !sameInode(before, identity)) throw new Error("marker_changed")
  return { dir, identity }
}

const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino

async function assertMarkerDirectory({ dir, identity }) {
  const current = await fsp.lstat(dir)
  if (!current.isDirectory() || !sameInode(identity, current) || current.mode !== identity.mode) throw new Error("marker_changed")
  await assertNotGitCheckout(dir, NAMING)
}

async function assertMarkerLeaf(file, identity) {
  const current = await fsp.lstat(file)
  if (!current.isFile() || current.nlink !== 1 || !sameInode(identity, current) || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs) throw new Error("marker_changed")
}

async function readMarkerAt(file, directory, { env, platform, runner }) {
  await assertMarkerDirectory(directory)
  const identity = await fsp.lstat(file)
  await assertMarkerDirectory(directory)
  const text = readSmallText(file)
  // Do not repair a leaf reached through a transient external parent. Validate the read first.
  await assertMarkerDirectory(directory)
  await assertMarkerLeaf(file, identity)
  await protectLeafFile(file, platform, NAMING)
  if (platform === "win32") await protectWindowsPaths([{ path: file, kind: "file", created: false }], { env, runner, label: NAMING.label })
  await assertMarkerLeaf(file, identity)
  await assertMarkerDirectory(directory)
  const marker = JSON.parse(text)
  return validMarker(marker) && path.basename(file) === `${marker.host}-${marker.session_id}.json` ? marker : null
}

/** Direct reads and enumeration share the protected directory, leaf, byte and identity checks. */
export async function readMarker(env, file, { platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { platform, runner })
  if (typeof file !== "string" || path.dirname(file) !== path.join(root, "markers") || !OUTBOX_NAME_PATTERN.test(path.basename(file))) return null
  const directory = await protectMarkerDirectory(root, { env, platform, runner })
  return readMarkerAt(file, directory, { env, platform, runner })
}

/** Serialize the source read, facts replacement and receipt for one session. */
export async function withDerivationLock(env, name, body, { deskRoot = null } = {}) {
  requirePattern(name, OUTBOX_NAME_PATTERN, "name")
  const root = await factoryStateRoot(env, { deskRoot })
  return withLock(root, path.join(root, "deriving", name), process.platform, () => body(root))
}

/**
 * The general-purpose form of the locks above: serializes `body()` under a named lock with no JSON file
 * of its own, for a critical section that isn't a single file's read-modify-write -- for example, a
 * check-known / check-cap / create-on-a-shared-external-resource sequence two processes (two sessions
 * starting at once, say) must never both be inside at once. `name` scopes the lock (callers from
 * different concerns never block each other); it must be a safe path segment.
 */
export async function withNamedLock(env, name, body, { platform = process.platform, runner = undefined, deskRoot = null } = {}) {
  requirePattern(name, LOCK_NAME_PATTERN, "name")
  const root = await factoryStateRoot(env, { platform, runner, deskRoot })
  return withLock(root, path.join(root, "locks", name), platform, body)
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
  const options = { env, platform, runner }
  const directory = await protectMarkerDirectory(root, options)
  const { dir } = directory
  const nowMs = Date.parse(now())
  const kept = []
  for (const name of await listRegularFiles(dir, OUTBOX_NAME_PATTERN)) {
    const file = path.join(dir, name)
    const before = await lstatIfPresent(file, NAMING)
    let marker = null
    try {
      marker = await readMarkerAt(file, directory, options)
    } catch (error) {
      if (error.code === "ENOENT" || error.message === "metadata_unreadable" || error.message === "marker_changed") continue
      if (!(error instanceof SyntaxError)) throw error
    }
    if (marker === null || nowMs - Date.parse(marker.updated_at) > MARKER_TTL_MS) {
      // Recheck the directory and exact leaf before pruning; never follow a replacement.
      await assertMarkerDirectory(directory)
      const current = await lstatIfPresent(file, NAMING)
      if (before !== null && current !== null && current.isFile() && current.nlink === 1 && current.dev === before.dev && current.ino === before.ino) {
        await fsp.unlink(file).catch(() => {})
      }
    } else {
      kept.push(marker)
    }
  }
  await assertMarkerDirectory(directory)
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
 * outbox name shape are considered. With `includeQuarantined`, quarantined
 * files are candidates too, each entry gaining `quarantine`, its parsed
 * record or `null`; a record that is not a regular file or does not parse
 * still keeps its file out.
 */
export async function pendingFiles(env, store, { publishedBytesFor, includeQuarantined = false }, { platform = process.platform, runner = undefined } = {}) {
  if (typeof publishedBytesFor !== "function") fail("publishedBytesFor", "must be a function")
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env, { platform, runner })
  const outboxDir = path.join(root, "outbox", slug)
  const delivered = await readJsonFileSafe(path.join(root, "delivered", `${slug}.json`), {}, platform)
  const quarantineDir = path.join(root, "quarantine", slug)
  const quarantined = new Set(await listRegularFiles(quarantineDir, OUTBOX_NAME_PATTERN))
  const pending = []
  for (const name of await listRegularFiles(outboxDir, OUTBOX_NAME_PATTERN)) {
    let held = null
    if (quarantined.has(name)) {
      if (!includeQuarantined) continue
      held = await quarantineReason(path.join(quarantineDir, name))
      if (held === null) continue
    } else if (includeQuarantined && (await lstatIfPresent(path.join(quarantineDir, name), NAMING)) !== null) {
      // A record that is not a regular file keeps its file quarantined.
      continue
    }
    let localFacts
    let localBytes
    try {
      localBytes = await fsp.readFile(path.join(outboxDir, name))
      localFacts = JSON.parse(localBytes.toString("utf8"))
    } catch {
      // A quarantined file that still does not parse keeps its record.
      if (held === null) await quarantine(env, store, name, "invalid", { platform, runner })
      continue
    }
    const publishedBytes = publishedBytesFor(localFacts)
    if (publishedBytes === null) continue
    const sha = gitBlobSha(publishedBytes)
    if (delivered[name] !== sha) pending.push(includeQuarantined ? { name, localBytes, quarantine: held } : { name, localBytes })
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

/**
 * Quarantines outbox file `name` for `store` under `reason` (a transform
 * refusal or CI rejection code). `name` is a facts file name or a local
 * labels key, `labels/<job>/<session_id>.json`, which is quarantined at
 * `quarantine/<store-slug>/labels/<job>/<session_id>.json`. `facts`, a facts
 * file name, is recorded beside the reason when given: the quarantined facts
 * a labels key is held back for. `blob`, the git blob sha the store refused,
 * is recorded when given, so a later flush can tell whether the published
 * file has changed since.
 */
export async function quarantine(env, store, name, reason, { facts = undefined, blob = undefined, now = defaultNow, platform = process.platform, runner = undefined } = {}) {
  if (!LABELS_KEY_PATTERN.test(String(name))) requirePattern(name, OUTBOX_NAME_PATTERN, "name")
  requirePattern(reason, REASON_PATTERN, "reason")
  if (facts !== undefined) requirePattern(facts, OUTBOX_NAME_PATTERN, "facts")
  if (blob !== undefined) requirePattern(blob, SHA1, "blob")
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env, { platform, runner })
  const record = { reason, ...(facts === undefined ? {} : { facts }), ...(blob === undefined ? {} : { blob }), at: now() }
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
    if (Object.hasOwn(patch, "derivations")) next.derivations = { ...current.derivations, ...patch.derivations }
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
  const root = await factoryStateRoot(env, { platform, runner, deskRoot })
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

/** Bounded names-only lookup for end-of-turn hooks; never reads request content. */
export async function listFinalizeJobs(env) {
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "finalize")
  await ensureDirChain(dir, root, process.platform)
  const jobs = []
  let scanned = 0
  for await (const entry of await fsp.opendir(dir)) {
    if (entry.isFile() && FINALIZE_NAME_PATTERN.test(entry.name)) {
      const stat = await lstatIfPresent(path.join(dir, entry.name), NAMING)
      if (stat !== null && stat.isFile() && stat.nlink === 1) jobs.push(entry.name.slice(0, -5))
    }
    if (++scanned === 128 || jobs.length === 8) break
  }
  return jobs
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

// ---------------------------------------------------------------------------
// Local facts reads, local labels and the waste evaluator's files.
// ---------------------------------------------------------------------------

/** Reads a regular, owner-only file under the state root; `null` when it is absent. */
async function readProtectedBytes(file) {
  if ((await lstatIfPresent(file, NAMING)) === null) return null
  await protectLeafFile(file, process.platform, NAMING)
  return fsp.readFile(file)
}

/**
 * `readLocalFacts(env, store, name) -> LocalFacts | null`: the outbox file
 * `name` (`<host>-<session_id>.json`) for `store`, or `null` when it is
 * absent, not an outbox name, not JSON or not valid local facts. A symlink
 * or hard link is refused, as on every other read.
 */
export async function readLocalFacts(env, store, name) {
  const slug = storeSlug(store)
  if (typeof name !== "string" || !OUTBOX_NAME_PATTERN.test(name)) return null
  const root = await factoryStateRoot(env)
  const bytes = await readProtectedBytes(path.join(root, "outbox", slug, name))
  if (bytes === null) return null
  let facts
  try {
    facts = JSON.parse(bytes.toString("utf8"))
  } catch {
    return null
  }
  return validateLocalFacts(facts).ok ? facts : null
}

/**
 * Validates `labels` (`validateLabels`) and writes them, as canonical bytes,
 * to `labels/<store-slug>/<job>/<session_id>.json`, unless that store's
 * consent is absent or `contribute: false` (a no-op then). Invalid labels
 * are never written; their errors are `{ code, path }` only.
 */
export async function writeLocalLabels(env, store, labels) {
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env)
  const record = (await readConsentAt(root, process.platform)).stores[store]
  if (record === undefined || record.contribute !== true) return { written: false, errors: [] }
  const { ok, errors } = validateLabels(labels)
  if (!ok) return { written: false, errors }
  const file = path.join(root, "labels", slug, labels.job, `${labels.session}.json`)
  await writeAtomic(root, file, `${JSON.stringify(labels)}\n`, { platform: process.platform, env })
  return { written: true, name: `labels/${labels.job}/${labels.session}.json` }
}

/**
 * `pendingLabels(env, store, { publishedBytesFor }) -> Array<{ name, localBytes }>`:
 * every local labels file for `store` whose last delivered published blob
 * SHA differs from `gitBlobSha(publishedBytesFor(localLabels))`, named
 * `labels/<job>/<session_id>.json`, the key `markDelivered` records. A file
 * `publishedBytesFor` answers `null` for is skipped, and so are one that
 * fails to parse and one that is quarantined. Only regular files of the
 * labels shape under a job folder are considered.
 */
export async function pendingLabels(env, store, { publishedBytesFor } = {}) {
  if (typeof publishedBytesFor !== "function") fail("publishedBytesFor", "must be a function")
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "labels", slug)
  const delivered = await readJsonFileSafe(path.join(root, "delivered", `${slug}.json`), {}, process.platform)
  const pending = []
  for (const job of await listDirSafe(dir)) {
    if (!PATTERNS.jobId.test(job)) continue
    for (const file of await listRegularFiles(path.join(dir, job), LABELS_NAME_PATTERN)) {
      if ((await lstatIfPresent(path.join(root, "quarantine", slug, "labels", job, file), NAMING)) !== null) continue
      const localBytes = await readProtectedBytes(path.join(dir, job, file))
      let localLabels
      try {
        localLabels = JSON.parse(localBytes.toString("utf8"))
      } catch {
        continue
      }
      const publishedBytes = publishedBytesFor(localLabels)
      if (publishedBytes === null) continue
      const name = `labels/${job}/${file}`
      if (delivered[name] !== gitBlobSha(publishedBytes)) pending.push({ name, localBytes })
    }
  }
  return pending
}

/**
 * `holdLabels(env, store, { job, session }) -> string | null`: the facts file
 * name of `session` that is quarantined for `store`, or `null` when none is.
 * Labels can only ever be delivered with their session's facts, so when
 * those facts are quarantined the labels key `labels/<job>/<session>.json`
 * is quarantined too, as `facts_quarantined` naming the facts file, whether
 * or not the labels exist yet; a key already quarantined keeps its record.
 */
export async function holdLabels(env, store, { job, session }) {
  requirePattern(job, PATTERNS.jobId, "job")
  requirePattern(session, SESSION_ID_PATTERN, "session")
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env)
  for (const host of ENUMS.host) {
    const facts = `${host}-${session}.json`
    if ((await lstatIfPresent(path.join(root, "quarantine", slug, facts), NAMING)) === null) continue
    const key = `labels/${job}/${session}.json`
    if ((await lstatIfPresent(path.join(root, "quarantine", slug, key), NAMING)) === null) await quarantine(env, store, key, "facts_quarantined", { facts })
    return facts
  }
  return null
}

// A store refuses a facts file without `refs.private.plugins` with this
// code (ourostack/factory's intake check). Only a Desk from before plugin
// names were withheld can send such a file, and this Desk always writes the
// field, so such a refusal is lifted here and the file goes out again.
const REFUSED_PLUGIN_NAMES = "private_plugins_missing"

// A quarantine record's reason, read without the repair `readJsonFileSafe`
// performs: a record that does not parse stays exactly where it is, so its
// file stays quarantined.
async function quarantineReason(file) {
  try {
    const record = JSON.parse(await fsp.readFile(file, "utf8"))
    return isPlainObject(record) ? record : null
  } catch {
    return null
  }
}

/**
 * `releaseQuarantined(env, store, names) -> { facts, labels }`: removes the
 * quarantine records of the facts files `names`, and the labels records held
 * back as `facts_quarantined` for one of them, so the next listing sends
 * those files again. Only regular files of the right name shape are touched,
 * a record that does not parse stays, and nothing is followed through a
 * symlink. Returns the released facts names and labels keys, each sorted.
 */
export async function releaseQuarantined(env, store, names) {
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "quarantine", slug)
  const wanted = new Set(names)
  const facts = []
  for (const name of await listRegularFiles(dir, OUTBOX_NAME_PATTERN)) {
    if (!wanted.has(name) || (await quarantineReason(path.join(dir, name))) === null) continue
    await fsp.unlink(path.join(dir, name))
    facts.push(name)
  }
  const released = new Set(facts)
  const labels = []
  for (const job of await listDirSafe(path.join(dir, "labels"))) {
    const jobDir = path.join(dir, "labels", job)
    if (!PATTERNS.jobId.test(job) || !(await lstatIfPresent(jobDir, NAMING)).isDirectory()) continue
    for (const file of await listRegularFiles(jobDir, LABELS_NAME_PATTERN)) {
      const record = await quarantineReason(path.join(jobDir, file))
      if (!(record?.reason === "facts_quarantined" && released.has(record.facts))) continue
      await fsp.unlink(path.join(jobDir, file))
      labels.push(`labels/${job}/${file}`)
    }
  }
  return { facts: facts.sort(), labels: labels.sort() }
}

/**
 * `releaseRefusedPluginNames(env, store) -> { facts, labels }`: removes the
 * quarantine records an older Desk wrote for `store` when the store refused
 * its facts as `private_plugins_missing`, so the next listing sends those
 * files again, published by this Desk with `refs.private.plugins`. Labels
 * quarantined with the same code are released, and so are labels held back
 * as `facts_quarantined` for a facts file released here. Every other record
 * stays, and so does one that is not a regular file or does not parse.
 * Returns the released facts names and labels keys, each sorted.
 */
export async function releaseRefusedPluginNames(env, store) {
  const slug = storeSlug(store)
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "quarantine", slug)
  const refused = []
  for (const name of await listRegularFiles(dir, OUTBOX_NAME_PATTERN)) {
    if ((await quarantineReason(path.join(dir, name)))?.reason === REFUSED_PLUGIN_NAMES) refused.push(name)
  }
  const { facts, labels } = await releaseQuarantined(env, store, refused)
  for (const job of await listDirSafe(path.join(dir, "labels"))) {
    const jobDir = path.join(dir, "labels", job)
    if (!PATTERNS.jobId.test(job) || !(await lstatIfPresent(jobDir, NAMING)).isDirectory()) continue
    for (const file of await listRegularFiles(jobDir, LABELS_NAME_PATTERN)) {
      if ((await quarantineReason(path.join(jobDir, file)))?.reason !== REFUSED_PLUGIN_NAMES) continue
      await fsp.unlink(path.join(jobDir, file))
      labels.push(`labels/${job}/${file}`)
    }
  }
  return { facts, labels: labels.sort() }
}

/**
 * `evaluationPaths(env, { job, store, name }) -> { brief, output }`: where
 * the waste evaluator's brief for outbox file `name` of `store` lives, and
 * where the evaluator writes its labels.
 */
export async function evaluationPaths(env, { job, store, name }) {
  requirePattern(job, PATTERNS.jobId, "job")
  const slug = storeSlug(store)
  requirePattern(name, OUTBOX_NAME_PATTERN, "name")
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "evaluations", job, slug)
  const base = name.slice(0, -".json".length)
  return { brief: path.join(dir, `${base}.brief.json`), output: path.join(dir, `${base}.labels.json`) }
}

/** Writes the evaluator's `brief` for `{ job, store, name }` and returns its path. */
export async function writeEvaluationBrief(env, { job, store, name, brief }) {
  const paths = await evaluationPaths(env, { job, store, name })
  const root = await factoryStateRoot(env)
  await writeJsonAtomic(root, paths.brief, brief, { platform: process.platform, env })
  // The folder exists now, so the evaluator can write its output beside the brief.
  return paths.brief
}

/**
 * `listEvaluationBriefs(env, job) -> Array<{ store, name, brief, output }>`:
 * every brief file for `job`, by store; `brief` is `null` for one that is
 * unsafe or fails to parse. A folder or file of the wrong shape is skipped.
 */
export async function listEvaluationBriefs(env, job) {
  requirePattern(job, PATTERNS.jobId, "job")
  const root = await factoryStateRoot(env)
  const results = []
  for (const slug of await listDirSafe(path.join(root, "evaluations", job))) {
    const store = STORE_SLUG_PATTERN.exec(slug)
    if (store === null) continue
    const dir = path.join(root, "evaluations", job, slug)
    for (const file of await listRegularFiles(dir, BRIEF_NAME_PATTERN)) {
      const base = BRIEF_NAME_PATTERN.exec(file)[1]
      let brief = null
      try {
        brief = JSON.parse((await readProtectedBytes(path.join(dir, file))).toString("utf8"))
      } catch {
        // A corrupt or unsafe brief is listed as `null`, so the caller can report it.
      }
      results.push({ store: `${store[1]}/${store[2]}`, name: `${base}.json`, brief, output: path.join(dir, `${base}.labels.json`) })
    }
  }
  return results
}

/**
 * `readEvaluationOutput(env, file) -> Buffer | null`: what the evaluator
 * wrote at an output path `evaluationPaths` gave, `null` when it has not
 * written it. The file is made owner-only first; a symlink, a hard link, a
 * path outside the evaluations folder or a file over the facts size cap is
 * refused.
 */
export async function readEvaluationOutput(env, file) {
  const root = await factoryStateRoot(env)
  const relative = typeof file === "string" ? path.relative(path.join(root, "evaluations"), file).split(path.sep) : []
  if (relative.length !== 3 || !PATTERNS.jobId.test(relative[0]) || !STORE_SLUG_PATTERN.test(relative[1]) || !/\.labels\.json$/u.test(relative[2])) {
    fail("file", "must be an evaluation output path")
  }
  const stat = await lstatIfPresent(file, NAMING)
  if (stat !== null && stat.size > LIMITS.maxBytes) fail("file", "evaluation output is too large")
  return readProtectedBytes(file)
}

/** Whether `store` holds local labels for `job`'s session `session`. */
export async function hasLocalLabels(env, store, job, session) {
  const slug = storeSlug(store)
  requirePattern(job, PATTERNS.jobId, "job")
  const root = await factoryStateRoot(env)
  return (await lstatIfPresent(path.join(root, "labels", slug, job, `${session}.json`), NAMING)) !== null
}

/**
 * Records that `job` finished and still needs waste labels
 * (`evaluate-requests/<job>.json`), kept until its labels are complete or
 * the request is quarantined, like a finalize request.
 */
export async function requestEvaluation(env, { job, deskRoot }) {
  requirePattern(job, PATTERNS.jobId, "job")
  requireAbsolutePath(deskRoot, "deskRoot")
  const root = await factoryStateRoot(env, { deskRoot })
  const file = path.join(root, "evaluate-requests", `${job}.json`)
  const existing = await readJsonFileSafe(file, null, process.platform)
  const record = { schema_version: 1, job, desk_root: deskRoot, requested_at: existing?.requested_at ?? defaultNow() }
  await writeJsonAtomic(root, file, record, { platform: process.platform, env })
  return record
}

/** Every pending evaluation request; one that fails to parse or has the wrong shape is skipped. */
export async function listEvaluationRequests(env) {
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "evaluate-requests")
  const results = []
  for (const name of await listRegularFiles(dir, FINALIZE_NAME_PATTERN)) {
    const record = await readJsonFileSafe(path.join(dir, name), null, process.platform)
    if (record !== null && record.job === name.slice(0, -".json".length) && typeof record.desk_root === "string" && PATTERNS.timestamp.test(record.requested_at ?? "")) results.push(record)
  }
  return results
}

/** Removes `evaluate-requests/<job>.json`, or moves it to `evaluate-requests/quarantine/<job>.json` with `reason` (a stable code). */
export async function clearEvaluationRequest(env, job, reason = null) {
  requirePattern(job, PATTERNS.jobId, "job")
  const root = await factoryStateRoot(env)
  const file = path.join(root, "evaluate-requests", `${job}.json`)
  if (reason !== null) {
    requirePattern(reason, REASON_PATTERN, "reason")
    await writeJsonAtomic(root, path.join(root, "evaluate-requests", "quarantine", `${job}.json`), { reason, at: defaultNow() }, { platform: process.platform, env })
  }
  await fsp.rm(file, { force: true })
}

/** Removes the brief and the output for `{ job, store, name }`; a no-op for either one already gone. */
export async function clearEvaluation(env, { job, store, name }) {
  const paths = await evaluationPaths(env, { job, store, name })
  for (const file of [paths.brief, paths.output]) await fsp.rm(file, { force: true })
}
