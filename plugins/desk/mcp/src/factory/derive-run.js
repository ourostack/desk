import { createHash } from "node:crypto"
import { readFileSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { bindSession } from "./binding.js"
import { deriveClaudeSession } from "./derive-claude.js"
import { deriveCodexSession } from "./derive-codex.js"
import { deriveCopilotSession } from "./derive-copilot.js"
import { createDeskReaders, readDeskRemote } from "./desk-repo.js"
import { validMarker } from "./marker.js"
import { factoryStateRoot, listMarkers, readConsent, readMarker, jobsIndexRebuilt, rebuildJobsIndex, readStatus, setJobsForFile, withDerivationLock, writeLocalFacts, writeStatus } from "./outbox.js"
import { compareVersions, isVersion } from "./pipeline/versions.js"
import { resolveStore } from "./store-route.js"
import { reconcileMarker } from "./session-lifetime.js"

async function sourceStamp(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("source_unreadable")
  return { size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev }
}

/** Bump when binding changes what a derived session credits; sessions with a lower or missing receipt version re-derive once. */
export const BINDING_VERSION = 3

const sameSource = (a, b) => a.size === b.size && a.mtime === b.mtime && a.ino === b.ino && a.dev === b.dev

function markerHash(marker) {
  const { updated_at, ...content } = marker
  return createHash("sha256").update(JSON.stringify(content)).digest("hex")
}

// The version of Desk actually running this code, read from the plugin.json
// that ships beside it. A long-lived session's own plugin metadata can name a
// newer Desk than the one still executing (its hook stays pinned to whatever
// was on disk when the session started), so this is never taken from a
// marker or an installed-plugins registry.
function ownDeskVersion() {
  return JSON.parse(readFileSync(new URL("../../../plugin.json", import.meta.url), "utf8")).version
}

// How long a stale-deriver hold (below) is honored before this deriver stops
// waiting for a fresher process and derives with the code it is actually
// running. A marker's declared version is frozen at the moment it is
// written; if the machine later rolls back to an older Desk, the marker
// keeps naming a version no installed deriver can ever reach, and without an
// expiry every deriver would hold it forever, until outbox.js's own marker
// pruning (MARKER_TTL_MS, 30 days) deletes it unpublished and the session's
// facts are lost outright. Seven days sits well inside that 30-day window,
// so a genuinely stale process still gets a real chance to be replaced by a
// fresher one before this deriver gives up on waiting and just derives.
const STALE_DERIVER_HOLD_MS = 7 * 24 * 60 * 60 * 1000

// The marker's declared "desk" plugin version, or null when there is none to
// trust: no "desk" entry, or more than one "desk" entry naming different
// versions. Two different-origin "desk" installs can coexist in
// marker.plugins; when they disagree, picking one over the other would be
// arbitrary, so an ambiguous declaration is treated the same as no
// declaration at all — it never causes a hold.
function declaredDeskVersion(plugins) {
  const versions = new Set(plugins.filter((plugin) => plugin.name === "desk").map((plugin) => plugin.version))
  return versions.size === 1 ? [...versions][0] : null
}

// Whether the marker declares a "desk" plugin newer than the code actually
// running it. A stale deriver must hold rather than bind with logic its own
// declared version has already superseded (an unreadable or malformed own
// version fails open: proceed as before, as does an ambiguous declaration —
// see declaredDeskVersion — and a hold older than STALE_DERIVER_HOLD_MS).
function isStaleDeriver(ownVersion, plugins, updatedAt, now) {
  const declared = declaredDeskVersion(plugins)
  if (declared === null) return false
  if (now() - Date.parse(updatedAt) > STALE_DERIVER_HOLD_MS) return false
  let own
  try {
    own = ownVersion()
  } catch {
    return false
  }
  return isVersion(own) && compareVersions(own, declared) < 0
}

export async function deriveMarker(env, marker, { claude = deriveClaudeSession, copilot = deriveCopilotSession, codex = deriveCodexSession, quietMs = 0, requireQuiet = false, requireStored = false, ownVersion = ownDeskVersion, now = Date.now } = {}) {
  if (!validMarker(marker)) return { result: "invalid", store: null }
  if (marker.desk_root === null) return { result: "held", store: null }
  try {
    return await withDerivationLock(env, `${marker.host}-${marker.session_id}.json`, (root) => deriveUnlocked(env, marker, { claude, copilot, codex, quietMs, requireQuiet, requireStored, root, ownVersion, now }), { deskRoot: marker.desk_root })
  } catch {
    return { result: "source_unreadable", store: null }
  }
}

async function newestMarker(env, root, marker, requireStored) {
  try {
    const stored = await readMarker(env, path.join(root, "markers", `${marker.host}-${marker.session_id}.json`))
    if (stored === null) throw new Error("invalid_marker")
    if (requireStored) return stored
    return (stored.ended_at ?? stored.updated_at) > (marker.ended_at ?? marker.updated_at) ? stored : marker
  } catch (error) {
    if (error.code === "ENOENT" && !requireStored) return marker
    throw error
  }
}

async function deriveUnlocked(env, input, { claude, copilot, codex, quietMs, requireQuiet, requireStored, root, ownVersion, now }) {
  let store = null
  try {
    let marker = await newestMarker(env, root, input, requireStored)
    if (marker.desk_root === null) return { result: "held", store }
    if (isStaleDeriver(ownVersion, marker.plugins, marker.updated_at, now)) return { result: "held", store }
    await factoryStateRoot(env, { deskRoot: marker.desk_root })
    const current = resolveStore({ deskRoot: marker.desk_root })
    const route = current.source === "default" && marker.routing ? marker.routing : current
    store = route.store
    const name = `${marker.host}-${marker.session_id}.json`
    if (route.warnings.length) await writeStatus(env, { routing_warnings: route.warnings })
    if (store === null) return { result: "held", store }
    if ((await readConsent(env)).stores[store]?.contribute !== true) return { result: "not_opted_in", store }
    const before = await sourceStamp(marker.log_path)
    marker = await reconcileMarker(marker)
    if (!sameSource(before, await sourceStamp(marker.log_path))) return { result: "skipped", store }
    if (quietMs > 0 && (requireQuiet || marker.ended_at === null) && Date.now() - before.mtime < quietMs) return { result: "skipped", store }
    const hash = markerHash(marker)
    const receipt = (await readStatus(env)).derivations?.[name]
    const destination = path.join(root, "outbox", store.replace("/", "__"), name)
    if (receipt?.store === store && receipt.marker === hash && receipt.binding_version >= BINDING_VERSION && sameSource(receipt, before)) {
      try {
        await sourceStamp(destination)
        return { result: "skipped", store }
      } catch {
        // A lost outbox file must be rebuilt even when the log is unchanged.
      }
    }
    let derived
    if (marker.host === "claude-code") {
      derived = await claude({ transcriptPath: marker.log_path, plugins: marker.plugins, endReason: marker.end_reason })
    } else if (marker.host === "codex-cli") {
      // A rollout lives at <codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl; when it does not, the deriver resolves the home itself.
      const sessions = path.resolve(marker.log_path, "..", "..", "..", "..")
      derived = await codex({ rolloutPath: marker.log_path, codexHome: path.basename(sessions) === "sessions" ? path.dirname(sessions) : undefined, plugins: marker.plugins, endReason: marker.end_reason })
    } else {
      const home = path.resolve(marker.log_path, "..", "..", "..")
      if (path.join(home, "session-state", marker.session_id, "events.jsonl") !== marker.log_path) return { result: "invalid", store }
      derived = await copilot({ sessionId: marker.session_id, copilotHome: home, plugins: marker.plugins, endReason: marker.end_reason, entrypoint: marker.entrypoint })
    }
    if (!sameSource(before, await sourceStamp(marker.log_path))) return { result: "skipped", store }
    if (derived.facts === null) return { result: derived.reason, store }
    if (derived.facts.session.id !== marker.session_id) return { result: "invalid", store }
    const personPrefix = marker.person_prefix ?? ""
    const deskRoot = marker.desk_root
    const { jobs } = bindSession({
      events: derived.events, agents: derived.facts.agents, deskRoot, deskRemote: readDeskRemote({ deskRoot }), personPrefix,
      ...createDeskReaders({ deskRoot, personPrefix }),
    })
    derived.facts.jobs = jobs
    const written = await writeLocalFacts(env, store, derived.facts)
    if (!written.written) return { result: written.errors.length ? "invalid" : "not_opted_in", store }
    await setJobsForFile(env, written.name, jobs.map((j) => j.job))
    await writeStatus(env, { derivations: { [name]: { store, marker: hash, binding_version: BINDING_VERSION, ...before } } })
    return { result: "written", store }
  } catch (error) {
    return { result: error.code === "ENOENT" ? "log_missing" : "source_unreadable", store }
  }
}

export async function sweep(env, { quietMs = 600000 } = {}) {
  const summary = { written: 0, held: 0, skipped: 0, not_opted_in: 0, log_missing: 0, source_unreadable: 0, invalid: 0 }
  try {
    if (!(await jobsIndexRebuilt(env))) await rebuildJobsIndex(env)
  } catch {
    // The rebuild retries on the next sweep; it must never stop this one deriving.
  }
  for (const marker of await listMarkers(env)) {
    const { result } = await deriveMarker(env, marker, { quietMs, requireStored: true })
    summary[result] += 1
  }
  return summary
}

export async function deriveFile(env, file, { quietMs = 0, maxWaitMs = 300000 } = {}) {
  try {
    let marker = await readMarker(env, file)
    if (marker === null) return { result: "invalid", store: null }
    const deadline = Date.now() + maxWaitMs
    while (quietMs > 0) {
      const stamp = await sourceStamp(marker.log_path)
      const remaining = quietMs - (Date.now() - stamp.mtime)
      if (remaining <= 0) break
      if (Date.now() + remaining > deadline) return { result: "skipped", store: null }
      await sleep(remaining)
      marker = await readMarker(env, file)
      if (marker === null) return { result: "invalid", store: null }
    }
    return deriveMarker(env, marker, { quietMs, requireQuiet: true, requireStored: true })
  } catch (error) {
    return { result: error.code === "ENOENT" ? "log_missing" : "source_unreadable", store: null }
  }
}
