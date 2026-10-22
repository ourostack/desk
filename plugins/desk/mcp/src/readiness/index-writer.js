// Which Desk build wrote the shared search index last. Every build on a desk writes the one index in it, so each build that has this record can tell whether the index belongs to a newer build and leave it alone; without that, two builds would take the index from each other on every query.
import { compareVersions } from "../runtime/stale-desk.js"

export const INDEX_WRITER_KEY = "index_writer"

// The record names the journal of the generation it was written with. A build that writes no record (an older alpha) leaves a record whose journal no longer matches, so it is never mistaken for the current writer.
export function indexWriterRecord(writer, eventCursor) {
  return JSON.stringify({ journal_id: eventCursor.journal_id, version: writer.version, build: writer.build })
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
  }
}

// Whether `writer` ranks above `self`: the newer Desk version first, then the larger build digest, so any two builds agree on one owner.
export function outranks(writer, self) {
  const order = compareVersions(writer.version, self.version)
  if (order !== null && order !== 0) return order > 0
  return (writer.build ?? "") > (self.build ?? "")
}
