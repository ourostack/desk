import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { bindSession } from "./binding.js"
import { deriveClaudeSession } from "./derive-claude.js"
import { deriveCopilotSession } from "./derive-copilot.js"
import { createDeskReaders, readDeskRemote } from "./desk-repo.js"
import { validMarker } from "./marker.js"
import { factoryStateRoot, listMarkers, readConsent, readMarker, readStatus, updateJobsIndex, withDerivationLock, writeLocalFacts, writeStatus } from "./outbox.js"
import { resolveStore } from "./store-route.js"

async function sourceStamp(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("source_unreadable")
  return { size: stat.size, mtime: stat.mtimeMs }
}

function markerHash(marker) {
  const { updated_at, ...content } = marker
  return createHash("sha256").update(JSON.stringify(content)).digest("hex")
}

export async function deriveMarker(env, marker, { claude = deriveClaudeSession, copilot = deriveCopilotSession } = {}) {
  if (!validMarker(marker)) return { result: "invalid", store: null }
  try {
    return await withDerivationLock(env, `${marker.host}-${marker.session_id}.json`, () => deriveUnlocked(env, marker, { claude, copilot }))
  } catch {
    return { result: "source_unreadable", store: null }
  }
}

async function deriveUnlocked(env, marker, { claude, copilot }) {
  let store = null
  try {
    if (marker.desk_root === null) return { result: "held", store }
    const current = resolveStore({ deskRoot: marker.desk_root })
    const route = current.source === "default" && marker.routing ? marker.routing : current
    store = route.store
    const name = `${marker.host}-${marker.session_id}.json`
    if (route.warnings.length) await writeStatus(env, { routing_warnings: route.warnings })
    if (store === null) return { result: "held", store }
    if ((await readConsent(env)).stores[store]?.contribute !== true) return { result: "not_opted_in", store }
    const before = await sourceStamp(marker.log_path)
    const hash = markerHash(marker)
    const receipt = (await readStatus(env)).derivations?.[name]
    const root = await factoryStateRoot(env)
    const destination = path.join(root, "outbox", store.replace("/", "__"), name)
    if (receipt?.store === store && receipt.marker === hash && receipt.size === before.size && receipt.mtime === before.mtime) {
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
    } else {
      const home = path.resolve(marker.log_path, "..", "..", "..")
      if (path.join(home, "session-state", marker.session_id, "events.jsonl") !== marker.log_path) return { result: "invalid", store }
      derived = await copilot({ sessionId: marker.session_id, copilotHome: home, plugins: marker.plugins, endReason: marker.end_reason, entrypoint: marker.entrypoint })
    }
    if (derived.facts === null) return { result: derived.reason, store }
    if (derived.facts.session.id !== marker.session_id) return { result: "invalid", store }
    const personPrefix = marker.person_prefix ?? ""
    const deskRoot = marker.desk_root
    const { jobs } = bindSession({
      events: derived.events, deskRoot, deskRemote: readDeskRemote({ deskRoot }), personPrefix,
      ...createDeskReaders({ deskRoot, personPrefix }),
    })
    derived.facts.jobs = jobs
    const written = await writeLocalFacts(env, store, derived.facts)
    if (!written.written) return { result: written.errors.length ? "invalid" : "not_opted_in", store }
    for (const job of jobs) await updateJobsIndex(env, job.job, written.name)
    await writeStatus(env, { derivations: { [name]: { store, marker: hash, ...before } } })
    return { result: "written", store }
  } catch (error) {
    return { result: error.code === "ENOENT" ? "log_missing" : "source_unreadable", store }
  }
}

export async function sweep(env, { quietMs = 600000 } = {}) {
  const summary = { written: 0, held: 0, skipped: 0, not_opted_in: 0, log_missing: 0, source_unreadable: 0, invalid: 0 }
  for (const marker of await listMarkers(env)) {
    if (!validMarker(marker)) { summary.invalid += 1; continue }
    try {
      const stamp = await sourceStamp(marker.log_path)
      if (marker.ended_at === null && Date.now() - stamp.mtime < quietMs) { summary.skipped += 1; continue }
    } catch (error) {
      summary[error.code === "ENOENT" ? "log_missing" : "source_unreadable"] += 1
      continue
    }
    const { result } = await deriveMarker(env, marker)
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
    return deriveMarker(env, marker)
  } catch (error) {
    return { result: error.code === "ENOENT" ? "log_missing" : "source_unreadable", store: null }
  }
}
