// Marks an existing local session as a controlled proof (`factory.js proof <session id>`, issue #578). Only a session whose own marker shows
// a desk recorded it on this machine can be marked. An unknown, foreign, ambiguous or ledger-only id is refused with a content-free reason, and
// every attempt that reaches the state folder is audited by the session's keyed hash in `proof-audit.json` (`appendProofAudit`).
//
// A session's marker must exist, because its `proof: true` lives there. A session whose marker was pruned after 30 days is refused as `no_marker`.

import { realpathSync } from "node:fs"

import { appendProofAudit, factoryStateRoot, markSessionProof, proofSessionHash, readStatus, sessionMarkers } from "./outbox.js"
import { PATTERNS } from "./schema.js"

const realOrNull = (file) => {
  try {
    return realpathSync(file)
  } catch {
    return null
  }
}

// What this machine holds for the session: its markers, and the hosts its derivation ledger names (the receipts are keyed `<host>-<session_id>.json`).
async function recordsOf(env, sessionId) {
  const markers = await sessionMarkers(env, sessionId)
  const suffix = `-${sessionId}.json`
  const ledger = Object.keys((await readStatus(env)).derivations ?? {}).filter((name) => name.endsWith(suffix)).map((name) => name.slice(0, -suffix.length))
  return { markers, hosts: new Set([...markers.map(({ host }) => host), ...ledger]) }
}

// How each marking outcome is audited and reported: the action taken, the audited outcome and the result the caller sees.
const MARK_OUTCOMES = {
  marked: { action: "mark", outcome: "ok", result: "marked" },
  already: { action: "none", outcome: "already", result: "already_proof" },
  failed: { action: "mark", outcome: "failed", result: "failed" },
  uncertain: { action: "mark", outcome: "uncertain", result: "uncertain" },
}

/**
 * `markProofSession(env, { sessionId, desk }) -> { result, reason? }`. `desk` (an absolute desk root, optional) pins the owner: the session's
 * marker must name that desk. Results: `marked`, `already_proof` (nothing to do), `failed` (the write did not land), `uncertain` (the write may have
 * landed and the marker cannot be read back) or `refused` with a `reason`: `invalid_id`, `unknown` (nothing recorded here), `no_marker` (only the
 * derivation ledger knows the session), `ambiguous` (more than one host records it), or `foreign` (no desk recorded it, its desk folder is gone, or
 * it is not `desk`).
 */
export async function markProofSession(env, { sessionId, desk = null, write = markSessionProof, readBack = sessionMarkers }) {
  if (typeof sessionId !== "string" || !PATTERNS.sessionId.test(sessionId)) return { result: "refused", reason: "invalid_id" }
  // No state folder means nothing is recorded here, and nothing is created to audit it in.
  if ((await factoryStateRoot(env, { create: false })) === null) return { result: "refused", reason: "unknown" }
  const audit = async (stateBefore, action, outcome) => appendProofAudit(env, { session: await proofSessionHash(env, sessionId), state_before: stateBefore, action, outcome, at: new Date().toISOString() })
  const refuse = async (reason) => {
    await audit("not_owned", "none", `refused_${reason}`)
    return { result: "refused", reason }
  }
  const { markers, hosts } = await recordsOf(env, sessionId)
  if (hosts.size === 0) return refuse("unknown")
  if (hosts.size > 1) return refuse("ambiguous")
  if (markers.length === 0) return refuse("no_marker")
  const { marker } = markers[0]
  const owner = typeof marker.desk_root === "string" ? realOrNull(marker.desk_root) : null
  if (owner === null || (desk !== null && owner !== realOrNull(desk))) return refuse("foreign")
  if (marker.proof === true) {
    await audit("proof", "none", "already")
    return { result: "already_proof" }
  }
  let how
  try {
    const written = await write(env, marker)
    how = written === "marked" ? "marked" : "already"
  } catch {
    // The write may have landed before it failed, so the marker is read back rather than guessed.
    const proven = await readBack(env, sessionId).then((found) => found[0]?.marker?.proof === true, () => undefined)
    how = proven === undefined ? "uncertain" : proven ? "marked" : "failed"
  }
  const { action, outcome, result } = MARK_OUTCOMES[how]
  await audit("ordinary", action, outcome)
  return { result }
}
