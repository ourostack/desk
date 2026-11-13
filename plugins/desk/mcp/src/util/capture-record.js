// The record of a card commit Desk could not finish: what the call meant to commit (the HEAD and branch it read, the captured
// entries, the paths and the message), kept in Desk's own state folder under `pending-captures/<id>.json`. Only Desk writes it.
// A route names the record by its id, so a card's change is finished only from a record Desk wrote, never from bytes or entries
// a caller supplies on the command line (the card guard lets such a finish through, so this is what keeps it to Desk's own changes).
// A record is removed once its commit is proven landed, and a record older than a week is pruned when the next one is written.

import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { renameWithRetry } from "./rename-retry.js"
import { assertNotRealStateUnderTest } from "../runtime/test-state-guard.js"

export const CAPTURE_DIR = "pending-captures"
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

const dirOf = (stateDir) => path.join(stateDir, CAPTURE_DIR)
const fileOf = (stateDir, id) => path.join(dirOf(stateDir), `${id}.json`)

function pruneOld(dir, now) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    const file = path.join(dir, name)
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true })
    } catch {
      // Another process removed it first.
    }
  }
}

/** Writes the record of a captured change and returns its id. Throws when the state folder cannot be written. */
export function writeCaptureRecord({ stateDir, root, paths, message, capture, now = Date.now() }) {
  assertNotRealStateUnderTest(stateDir)
  mkdirSync(dirOf(stateDir), { recursive: true, mode: 0o700 })
  pruneOld(dirOf(stateDir), now)
  const id = randomUUID()
  const record = { schema_version: 1, id, root, paths, message, before: capture.before, branch: capture.branch, expected: capture.expected, created: new Date(now).toISOString() }
  const file = fileOf(stateDir, id)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" })
  renameWithRetry(temporary, file)
  return id
}

const isText = (value) => typeof value === "string" && value.length > 0
const isRecord = (record) => record !== null && typeof record === "object" && record.schema_version === 1 && ID.test(record.id ?? "") &&
  isText(record.root) && Array.isArray(record.paths) && record.paths.length > 0 && record.paths.every(isText) &&
  typeof record.message === "string" && isText(record.before) && isText(record.branch) &&
  Array.isArray(record.expected) && record.expected.every(isText)

/** The record for `id`: `{ record }`, or `{ error }` saying why Desk cannot use it. */
export function readCaptureRecord({ stateDir, id }) {
  if (typeof id !== "string" || !ID.test(id)) return { error: "the capture id is not one Desk issues" }
  let text
  try {
    text = readFileSync(fileOf(stateDir, id), "utf8")
  } catch {
    return { error: "Desk has no record of this change: it was never written here, or it was removed once the commit landed" }
  }
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return { error: "Desk's record of this change is unreadable" }
  }
  return isRecord(record) && record.id === id ? { record } : { error: "Desk's record of this change is malformed" }
}

/** Removes the record for `id`, a valid id Desk issued; a missing record is already removed. */
export function removeCaptureRecord({ stateDir, id }) {
  rmSync(fileOf(stateDir, id), { force: true })
}
