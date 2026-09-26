// Desk's small local record of how its latest start went, for boot checks and agents that did not see the session's tool calls.
//
// `last-start.json` in Desk's state directory holds the latest admission state of any session, its code and the latest repair; `last-start/<root key>.json` holds the same for each desk root, so a boot check reads the record of its own root. Both are rewritten on every state change, starting with `admitting`: the root's own record gets that first `admitting` state as soon as the session resolves the root. `repairs.log` gets one line per repair Desk makes on its own.

import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

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

/** Replace last-start.json, and the root's own record when the root is known, atomically. Returns the path of last-start.json. */
export function writeLastStart({ stateDir, snapshot, root = null, pid = process.pid, now = () => new Date() }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
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
  replaceFile(file, record, pid)
  if (root !== null) {
    const rootsDir = path.join(stateDir, LAST_START_ROOTS_DIR)
    mkdirSync(rootsDir, { recursive: true, mode: 0o700 })
    replaceFile(lastStartPath({ stateDir, root }), record, pid)
  }
  return file
}

function replaceFile(file, record, pid) {
  const temporary = `${file}.${pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

/** Append one repair line: `<time> <root> <line>`. */
export function appendRepairLog({ stateDir, line, root, now = () => new Date() }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = path.join(stateDir, REPAIR_LOG_FILE)
  appendFileSync(file, `${now().toISOString()} ${root} ${line}\n`, { mode: 0o600 })
  return file
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}
