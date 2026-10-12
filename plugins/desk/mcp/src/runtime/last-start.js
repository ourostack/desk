// Desk's small local record of how its latest start went, for boot checks and agents that did not see the session's tool calls.
//
// `last-start.json` in Desk's state directory holds the latest admission state of any session, its code and the latest repair; `last-start/<root key>.json` holds the same for each desk root, so a boot check reads the record of its own root. Both are rewritten on every state change, starting with `admitting`: the root's own record gets that first `admitting` state as soon as the session resolves the root. `repairs.log` gets one line per repair Desk makes on its own.
//
// `writeLastStart` and `appendRepairLog` are the two places this module actually writes; each calls `assertNotRealStateUnderTest` (`./test-state-guard.js`) first, refusing a non-temp state directory from what looks like a node:test run. `resolveDeskStateDir` itself stays a plain, side-effect-free function — many tests call it only to compute an expected path — so the guard sits at the write points, not there.

import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { renameWithRetryAsync } from "../util/rename-retry.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const LAST_START_FILE = "last-start.json"
export const REPAIR_LOG_FILE = "repairs.log"
export const LAST_START_ROOTS_DIR = "last-start"

/** The per-root record's file name: a short digest of the root path. */
export function lastStartRootKey(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 16)
}

/** Desk's state directory: `$XDG_STATE_HOME/ouroboros-skills/desk`, else `~/.local/state/ouroboros-skills/desk`. */
export function resolveDeskStateDir({ env = process.env, homeDir } = {}) {
  const home = homeDir ?? (hasText(env.HOME) ? env.HOME : os.homedir())
  const stateHome = hasText(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state")
  return path.join(stateHome, "ouroboros-skills", "desk")
}

/** Where readiness controllers keep their owner records and journals, unless a caller passes its own. */
export function resolveReadinessStateHome({ env = process.env, homeDir } = {}) {
  const home = homeDir ?? (hasText(env.HOME) ? env.HOME : os.homedir())
  return path.join(home, ".cache", "ouroboros-skills", "desk", "readiness")
}

/** The record a reader should use: the root's own record once the root is known, else the shared last-start.json. */
export function lastStartPath({ stateDir, root = null }) {
  return root === null ? path.join(stateDir, LAST_START_FILE) : path.join(stateDir, LAST_START_ROOTS_DIR, `${lastStartRootKey(root)}.json`)
}

/**
 * Replace last-start.json, and the root's own record when the root is known, atomically. Resolves to the path of last-start.json.
 * The I/O is asynchronous: on Windows, creating a file can wait on an antivirus scan for over 100 ms, and a Desk session must not stall its event loop (and every tool call it is answering) for that.
 */
export async function writeLastStart({ stateDir, snapshot, root = null, pid = process.pid, now = () => new Date() }) {
  assertNotRealStateUnderTest(stateDir)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = path.join(stateDir, LAST_START_FILE)
  const record = {
    schema_version: 1,
    state: snapshot.state,
    code: snapshot.code,
    repair: snapshot.repair,
    fix: snapshot.fix,
    root,
    pid,
    updated_at: now().toISOString(),
  }
  await replaceFile(file, record, pid)
  if (root !== null) {
    const rootsDir = path.join(stateDir, LAST_START_ROOTS_DIR)
    await mkdir(rootsDir, { recursive: true, mode: 0o700 })
    await replaceFile(lastStartPath({ stateDir, root }), record, pid)
  }
  return file
}

/**
 * A session's writer of its start records: `record` returns at once, the writes run one at a time in the order recorded, and `written()` resolves once every record so far is on disk.
 * Records waiting behind a running write are coalesced to the latest one per root: each file holds only the latest state, so a skipped intermediate record loses nothing, and closing a session waits for at most one record per root.
 * A failed write goes to `onError` and does not stop later ones. `updated_at` is when `record` was called, not when the write ran.
 */
export function createLastStartWriter({ onError, write = writeLastStart }) {
  // Keyed by root and re-inserted on every record, so iteration order is recency order and the newest record is written last, leaving it in the shared last-start.json.
  const pending = new Map()
  let tail = Promise.resolve()
  const report = (error) => {
    try {
      onError(error)
    } catch {
      // A failing error report must not stop the records after it.
    }
  }
  const drain = async () => {
    for (const [root, args] of pending) {
      pending.delete(root)
      try {
        await write(args)
      } catch (error) {
        report(error)
      }
    }
  }
  return {
    record(args) {
      const at = new Date()
      const root = args.root ?? null
      const queued = pending.size > 0
      pending.delete(root)
      pending.set(root, { ...args, now: () => at })
      // A drain already queued picks this record up; otherwise start one after the running write.
      if (!queued) tail = tail.then(drain)
    },
    written: () => tail,
  }
}

async function replaceFile(file, record, pid) {
  // Unique per write: two sessions in one process may write the same record at once.
  const temporary = `${file}.${pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await renameWithRetryAsync(temporary, file)
  } catch (error) {
    // A unique name is never reused, so a failed write removes its own; a failed removal never hides the error.
    await Promise.allSettled([rm(temporary, { force: true })])
    throw error
  }
}

/** Append one repair line: `<time> <root> <line>`. */
export function appendRepairLog({ stateDir, line, root, now = () => new Date() }) {
  assertNotRealStateUnderTest(stateDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = path.join(stateDir, REPAIR_LOG_FILE)
  appendFileSync(file, `${now().toISOString()} ${root} ${line}\n`, { mode: 0o600 })
  return file
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}
