// Which Desk build wrote the shared search index last. Every build on a desk writes the one index in it, so each build that has this record can tell whether the index belongs to a newer build and leave it alone; without that, two builds would take the index from each other on every query.
import { readdirSync } from "node:fs"
import * as path from "node:path"
import { compareVersions } from "../runtime/stale-desk.js"
import { ownerState, readOwnerRecord } from "./owner-record.js"

export const INDEX_WRITER_KEY = "index_writer"
const CONTROLLER_ID = /^[0-9a-f]{64}$/u

// The record names the journal of the generation it was written with. A build that writes no record (an older alpha) leaves a record whose journal no longer matches, so it is never mistaken for the current writer.
export function indexWriterRecord(writer, eventCursor) {
  return JSON.stringify({ journal_id: eventCursor.journal_id, version: writer.version, build: writer.build, controller: writer.controller })
}

// The writer of the generation whose cursor is `cursor`, or null when unknown.
export function readIndexWriter(value, cursor) {
  if (typeof value !== "string" || typeof cursor?.journal_id !== "string") return null
  let record
  try { record = JSON.parse(value) } catch { return null }
  if (record?.journal_id !== cursor.journal_id) return null
  return {
    version: typeof record.version === "string" ? record.version : null,
    build: typeof record.build === "string" ? record.build : null,
    // The writing controller's identity id, which names its state folder.
    controller: typeof record.controller === "string" && CONTROLLER_ID.test(record.controller) ? record.controller : null,
  }
}

// Whether `writer` ranks above `self`: the newer Desk version first, then the larger build digest, so any two builds agree on one owner.
export function outranks(writer, self) {
  const order = compareVersions(writer.version, self.version)
  if (order !== null && order !== 0) return order > 0
  return (writer.build ?? "") > (self.build ?? "")
}

// Whether the controller that wrote the index still runs, judged by its owner record the way controller election judges it. `ownStateDir` is this session's controller folder; the writer's folder sits beside it. An unknown writer, or a check that fails, counts as running, so a newer owner is never displaced on a guess.
export async function writerRuns(writer, ownStateDir, { inspect = ownerState } = {}) {
  if (writer.controller === null || typeof ownStateDir !== "string") return true
  try {
    const owner = await inspect({ stateDir: path.join(path.dirname(ownStateDir), writer.controller) })
    return owner.state === "live" || owner.state === "self"
  } catch {
    return true
  }
}

/**
 * The running Desk build that owns this desk's shared search index, when it is not `self`: the highest-ranked build, by `outranks`, among the controllers on this desk that publish their Desk version in their owner record (`desk_version`) and the controller that wrote the index last. Only the owner writes the index; a lower build stands aside and reads from it. Returns null when no running controller ranks above `self`.
 *
 * `self` is `{ version, build, controller }`; `stateDir` is this controller's folder, with the other controllers' folders beside it. `indexWriter` is the writer of the active generation (readIndexWriter), or null.
 */
export async function indexOwner({ self, root, stateDir, indexWriter = null, inspect = ownerState, list = readdirSync }) {
  const home = path.dirname(stateDir)
  const candidates = indexWriter !== null && indexWriter.controller !== self.controller ? [indexWriter] : []
  let names = []
  try {
    names = list(home)
  } catch {
    // No folder beside this one: no other controller has run here.
  }
  for (const name of names) {
    if (name === self.controller || !CONTROLLER_ID.test(name) || candidates.some((known) => known.controller === name)) continue
    const { status, record } = readOwnerRecord(path.join(home, name))
    if (status !== "valid" || record.identity?.root !== root || typeof record.desk_version !== "string") continue
    candidates.push({ version: record.desk_version, build: typeof record.identity.build === "string" ? record.identity.build : null, controller: name })
  }
  const higher = candidates.filter((candidate) => outranks(candidate, self))
    .sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0))
  for (const candidate of higher) {
    // A writer whose controller is unknown cannot be checked, and "running" there would stop this build from ever writing.
    if (candidate.controller !== null && await writerRuns(candidate, stateDir, { inspect })) return candidate
  }
  return null
}

/** One plain sentence naming the Desk build that owns the search index (`{ version, this_controller }`), or null when it is not known. */
export function indexOwnerSentence(owner) {
  if (typeof owner?.version !== "string") return null
  return owner.this_controller === true
    ? `Desk ${owner.version} (this session) owns the search index.`
    : `Desk ${owner.version} (another session) owns the search index; this session only reads it.`
}
