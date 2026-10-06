// Which unsigned deliveries an earlier boot of this same session already listed.
//
// Boot runs again when a session resumes or is compacted, and each run listed the same unsigned deliveries with "raise them, once": an
// agent that lost the earlier turn in compaction raised them a second time, and the operator was asked twice for one answer. The host
// gives the boot script its session id in the environment (Claude Code's `CLAUDE_CODE_SESSION_ID`, Copilot's
// `COPILOT_AGENT_SESSION_ID`), so boot keeps a small session-scoped record of the deliveries it has listed, and a later boot of the same
// session says they were listed already instead of asking for them again. A host with no session id in the environment (Codex) gets the
// plain line, as before.
//
// Fails open: an unreadable or unwritable record means "not known", never "listed".

import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const SIGNOFF_LISTED_DIR = "signoff-listed"
const STALE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_KEYS = 200

const hasText = (value) => typeof value === "string" && value.trim() !== ""

/** The host's id for this session from the environment, or null when the host gives none. */
export function hostSessionId(env) {
  for (const name of ["CLAUDE_CODE_SESSION_ID", "COPILOT_AGENT_SESSION_ID"]) if (hasText(env?.[name])) return env[name].trim()
  return null
}

/** The record for one session: a digest of its id, so no id can name another path. */
export function listedFile(stateDir, sessionId) {
  return path.join(stateDir, SIGNOFF_LISTED_DIR, `${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32)}.json`)
}

function readKeys(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(parsed?.tasks) ? parsed.tasks.filter((key) => typeof key === "string") : []
  } catch {
    return []
  }
}

// A record may vanish between the listing and the check (another session pruning it): each one is judged on its own.
function pruneStale(dir, now) {
  for (const name of readdirSync(dir)) {
    try {
      const file = path.join(dir, name)
      if (now - statSync(file).mtimeMs > STALE_MS) unlinkSync(file)
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Notes the deliveries `found` lists (the `recordUnsigned` result) as listed in this session, and answers whether an earlier boot of the
 * same session had listed every one of them already: `true` (listed before), `false` (at least one is new) or `undefined` (nothing to
 * list, no session id, or the record could not be read or written).
 */
export function noteSignoffListed(env, found, { stateDir, now = Date.now } = {}) {
  const sessionId = hostSessionId(env)
  const tasks = Array.isArray(found?.tasks) ? found.tasks.filter((task) => hasText(task?.track) && hasText(task?.slug)).map((task) => `${task.track}/${task.slug}`) : []
  if (sessionId === null || tasks.length === 0 || !hasText(stateDir)) return undefined
  try {
    assertNotRealStateUnderTest(stateDir)
    const file = listedFile(stateDir, sessionId)
    const before = readKeys(file)
    const seen = tasks.every((key) => before.includes(key))
    if (!seen) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify({ tasks: [...new Set([...before, ...tasks])].slice(-MAX_KEYS) })}\n`, { mode: 0o600 })
      renameSync(temp, file)
      pruneStale(path.dirname(file), now())
    }
    return seen
  } catch {
    return undefined
  }
}
