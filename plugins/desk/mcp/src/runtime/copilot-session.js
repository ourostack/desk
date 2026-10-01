// How the Desk MCP server learns which folder a Copilot CLI session was opened in.
//
// Copilot passes its MCP servers no session folder (live-checked on Copilot CLI 1.0.89): the server's working folder is the plugin's own, `roots/list` answers an empty list, and `PWD` is only whatever shell launched Copilot. The one per-session value in the server's environment is COPILOT_AGENT_SESSION_ID. The `sessionStart` hook receives that same id as `sessionId`, together with the session's folder as `cwd`. So the hook records the folder (and the saved desk binding it saw, which Copilot also keeps out of the server's environment) in a small file keyed by the id, and the server reads that file every time it resolves its root.
//
// Ordering. Copilot starts the server before it fires `sessionStart`, so the server's first resolution finds no record and degrades to `no_desk_root`. Desk's admission re-resolves the root on every `desk_status`, before every gated tool call and on its own retry schedule, so the first call after the hook has run binds, with no restart.
// Concurrent sessions. Each session id has its own file, written to a temporary name and renamed into place, so a reader sees the old record or the new one and one session never reads another's.
// A stale record. The record is only a hint for `hostProjectRoot`, which binds only a folder that is a desk right now, so a folder that has since moved or lost its desk layout falls through to the saved binding, `$DESK` and the home fallbacks. A saved-binding path that has gone is ignored. Records no session has rewritten for 30 days are pruned the next time any session records one.
//
// The hook side never throws: a session must start whether or not the record could be written.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const COPILOT_SESSION_DIR = "copilot-sessions"
export const COPILOT_SESSION_ENV = "COPILOT_AGENT_SESSION_ID"
const RECORD_VERSION = 1
const STALE_MS = 30 * 24 * 60 * 60 * 1000

const hasText = (value) => typeof value === "string" && value.trim() !== ""

// Whether the session's file already carries the first-prompt claim; an unreadable or absent file carries none.
function bootClaimed(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))?.boot_directed === true
  } catch {
    return false
  }
}

/** The record file for a session: a digest of its id, so no id can name another path. */
export function copilotSessionFile(stateDir, sessionId) {
  return path.join(stateDir, COPILOT_SESSION_DIR, `${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32)}.json`)
}

// A file may vanish between the listing and the check (another session's hook pruning it): each one is judged on its own.
function pruneStale(dir, now) {
  for (const name of readdirSync(dir)) {
    try {
      const file = path.join(dir, name)
      const info = statSync(file)
      if (info.isFile() && now - info.mtimeMs > STALE_MS) unlinkSync(file)
    } catch {
      // Gone already, or not ours to remove: skip it.
    }
  }
}

/**
 * The `sessionStart` hook's half: records the session's folder and the saved desk binding the hook resolved. Returns whether a record was written; never throws.
 * `stateDir` and `now` are for tests.
 */
export function recordCopilotSession({ sessionId, folder, activationConfig = null, env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now } = {}) {
  if (!hasText(sessionId) || !hasText(folder) || !path.isAbsolute(folder)) return false
  try {
    assertNotRealStateUnderTest(stateDir)
    const file = copilotSessionFile(stateDir, sessionId)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const record = { version: RECORD_VERSION, folder, activation_config: hasText(activationConfig) ? activationConfig : null, recorded_at: new Date(now()).toISOString() }
    // The first-prompt hook runs before this one on a new session, and its claim must survive this write.
    if (bootClaimed(file)) record.boot_directed = true
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    renameSync(temp, file)
    pruneStale(path.dirname(file), now())
    return true
  } catch {
    return false
  }
}

/**
 * The server's half: `{ folder, activationConfig }` the hook recorded for the session this server belongs to (COPILOT_AGENT_SESSION_ID), or null when there is no session id, no record or one it cannot trust.
 * `activationConfig` is null unless the hook saw a binding file that still exists.
 */
export function readCopilotSession({ env = process.env, stateDir = resolveDeskStateDir({ env }) } = {}) {
  const sessionId = env?.[COPILOT_SESSION_ENV]
  if (!hasText(sessionId)) return null
  let record
  try {
    record = JSON.parse(readFileSync(copilotSessionFile(stateDir, sessionId), "utf8"))
  } catch {
    return null
  }
  if (record === null || typeof record !== "object" || record.version !== RECORD_VERSION) return null
  if (!hasText(record.folder) || !path.isAbsolute(record.folder)) return null
  const binding = record.activation_config
  return { folder: record.folder, activationConfig: hasText(binding) && path.isAbsolute(binding) && existsSync(binding) ? binding : null }
}

/**
 * The first-prompt hook's half: true exactly once per session id, the first time it is asked, whether or not the `sessionStart` hook has recorded the session yet.
 * It must not wait for the record: Copilot fires `userPromptSubmitted` for a new session's first prompt before it fires `sessionStart` (Copilot CLI 1.0.89, `-p` and interactive), so a pointer that required the record was never delivered with the first prompt, which is the one that matters.
 * The claim is kept in the session's own file (a stub with no folder when the hook has not run yet; `recordCopilotSession` keeps the claim when it writes the folder), so a resumed session is not directed again: its history already holds the boot.
 * A record it cannot read or a file it cannot write claims nothing, so a failure never repeats the direction. Never throws.
 */
export function markBootDirected({ sessionId, env = process.env, stateDir = resolveDeskStateDir({ env }) } = {}) {
  if (!hasText(sessionId)) return false
  try {
    assertNotRealStateUnderTest(stateDir)
    const file = copilotSessionFile(stateDir, sessionId)
    let record = { version: RECORD_VERSION }
    if (existsSync(file)) {
      record = JSON.parse(readFileSync(file, "utf8"))
      if (record === null || typeof record !== "object" || record.version !== RECORD_VERSION || record.boot_directed === true) return false
    } else {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    }
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ ...record, boot_directed: true })}\n`, { mode: 0o600 })
    renameSync(temp, file)
    return true
  } catch {
    return false
  }
}
