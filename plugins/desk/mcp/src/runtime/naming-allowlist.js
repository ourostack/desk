// The "named by the operator" half of Desk-only enforcement (controller
// ruling 3): a `UserPromptSubmit` hook reads every operator message of the
// session -- not only the first -- for an explicit naming of one of
// `host-enforcement.js`'s denied surfaces, and once named, that surface stays
// allowed for the rest of the session. This module is the deterministic
// pattern match plus the small on-disk allowlist that makes "for the rest of
// the session" durable across the one-process-per-hook-call reality every
// host gives a `UserPromptSubmit`/`PreToolUse` hook pair.
//
// Review Focus: a negated mention ("don't use an artifact for this") must not
// count as naming. A short list of negation lead-ins is checked in the text
// immediately before a matched phrase, within the same sentence; a match with
// a negation lead-in before it names nothing.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

const ALLOWLIST_DIR = "host-enforcement-naming"

const NEGATION = /\b(?:don't|do not|never|not|won't|will not|shouldn't|should not|can't|cannot)\b/iu

// One or more phrasings an operator plausibly uses to name each denied
// surface (spec §5's exception applies to all five; the weighting note there
// says the pattern list should lean toward Artifact/Claude Docs, which an
// operator asks for by name far more often than the other four -- reflected
// here only in how specific each surface's phrasings are, not in whether one
// gets checked at all). Checked in this order; the first sentence-level match
// wins.
const SURFACE_PATTERNS = {
  "ask-user": [/\bask[- ]user\b/iu, /\baskuserquestion\b/iu, /\bask me a question\b/iu],
  "host-memory": [/\bhost memory\b/iu, /\bautomemoryenabled\b/iu, /\buse (?:your |claude'?s )?memory\b/iu],
  "plan-mode": [/\bplan mode\b/iu, /\benterplanmode\b/iu, /\bexitplanmode\b/iu],
  "host-task": [/\btaskcreate\b/iu, /\bhost task tool\b/iu, /\bpersistent task tool\b/iu],
  artifact: [/\bartifacts?\b/iu, /\bclaude docs?\b/iu, /\bclaude_ai_claude_docs\b/iu],
}

/** Splits on sentence-ending punctuation or a newline, so a later sentence's naming is not shadowed by an earlier, unrelated one. */
function sentencesOf(promptText) {
  return promptText.split(/(?<=[.!?\n])\s+/u)
}

/**
 * The surface id the operator's prompt text names, or `null` when nothing in
 * it names a denied surface -- including when the only mention is negated.
 */
export function namedSurfaceFrom(promptText) {
  if (typeof promptText !== "string" || promptText.trim() === "") return null
  for (const sentence of sentencesOf(promptText)) {
    for (const [surfaceId, patterns] of Object.entries(SURFACE_PATTERNS)) {
      for (const pattern of patterns) {
        const match = sentence.match(pattern)
        if (!match) continue
        const before = sentence.slice(0, match.index)
        if (NEGATION.test(before)) continue
        return surfaceId
      }
    }
  }
  return null
}

/** Records `surfaceId` as named this session. `sessionState` is a `Set` of surface ids, in memory. */
export function recordNamedSurface(sessionState, surfaceId) {
  sessionState.add(surfaceId)
}

/** Whether `surfaceId` was named earlier this session. */
export function isAllowedThisSession(sessionState, surfaceId) {
  return sessionState.has(surfaceId)
}

/** A short, filename-safe digest of a session id -- never the id itself, which may not be filename-safe on every host. */
function sessionKey(sessionId) {
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16)
}

/** Where a session's named-surface allowlist persists across the one-process-per-hook-call reality: Desk's own state directory, never inside the desk repo (it carries no desk content and is never committed). */
export function sessionAllowlistPath({ env = process.env, sessionId }) {
  return path.join(resolveDeskStateDir({ env }), ALLOWLIST_DIR, `${sessionKey(sessionId)}.json`)
}

/**
 * The surfaces named so far this session, or an empty set with nothing
 * recorded yet, an unreadable file, or a corrupt one -- loading always fails
 * toward "nothing named yet" rather than throwing, matching the naming
 * hook's own never-block contract.
 */
export function loadSessionAllowlist({ env = process.env, sessionId }) {
  try {
    const parsed = JSON.parse(readFileSync(sessionAllowlistPath({ env, sessionId }), "utf8"))
    const allowed = Array.isArray(parsed.allowed) ? parsed.allowed.filter((value) => typeof value === "string") : []
    return new Set(allowed)
  } catch {
    return new Set()
  }
}

/**
 * Persists `sessionState` (a `Set` of surface ids) for `sessionId`. Never
 * throws -- a write that fails simply is not persisted, and the next hook
 * call falls back to `loadSessionAllowlist`'s empty-set default, which is the
 * naming hook's own "record nothing" failure mode, not a new one. Returns
 * whether the write succeeded.
 */
export function saveSessionAllowlist({ env = process.env, sessionId, sessionState }) {
  try {
    const file = sessionAllowlistPath({ env, sessionId })
    assertNotRealStateUnderTest(path.dirname(file), { env })
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ allowed: [...sessionState] })}\n`, { mode: 0o600 })
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}
