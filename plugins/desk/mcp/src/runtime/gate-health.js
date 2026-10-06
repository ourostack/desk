// A small local record of the done-claim gate's quiet failures, so a gate that keeps failing is visible.
//
// The gate fails quietly in four places: its own Stop error (which blocks once, then lets the retry through), a PostToolUse recording failure, the hook wrapper's import or JSON failure, and a long Copilot transcript whose reply could not be found. Each calls `recordGateFailure`, which counts it in one file under Desk's state folder. `desk_doctor` reads the record with `gateHealthSummary` and warns with the count, the last time and what that last failure means, while the last failure is recent. Writing the record is best effort: if even that fails, nothing more can be done, and the gate carries on.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const GATE_HEALTH_FILE = "done-gate-failures.json"
/** A failure older than this no longer raises the warning. */
export const GATE_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// What the last failure means for the reply it touched, per kind.
const MEANING = {
  stop_error: "the gate hit an error checking a reply and blocked it once",
  record_failed: "a touched task was not recorded, so its reply went unchecked",
  wrapper_error: "the hook wrapper failed, so the reply went unchecked",
  reply_unread: "no reply was found in a long Copilot transcript, so it went unchecked",
}

const healthFile = (stateDir) => path.join(stateDir, GATE_HEALTH_FILE)

/**
 * The record `{ count, last_at, last_kind, lost_history }`, null when there is none, or `{ unreadable: true }` when the file is there but cannot be read as a record (not JSON, the wrong shape, a time that is not a time).
 */
export function readGateHealth({ env = process.env, stateDir = resolveDeskStateDir({ env }) }) {
  let text
  try {
    text = readFileSync(healthFile(stateDir), "utf8")
  } catch (error) {
    return error?.code === "ENOENT" ? null : { unreadable: true }
  }
  try {
    const parsed = JSON.parse(text)
    const good = Number.isInteger(parsed?.count) && parsed.count > 0 && typeof parsed.last_at === "string" && Number.isFinite(Date.parse(parsed.last_at))
    return good ? { count: parsed.count, last_at: parsed.last_at, last_kind: typeof parsed.last_kind === "string" ? parsed.last_kind : "unknown", lost_history: parsed.lost_history === true } : { unreadable: true }
  } catch {
    return { unreadable: true }
  }
}

/** Count one quiet failure (`kind`: `stop_error`, `record_failed`, `wrapper_error`, `reply_unread`). Never throws. An unreadable record is kept beside the new one as `.unreadable`, and the new record says its history was lost. `options` (`env`, `stateDir`, `now`) are for tests. */
export function recordGateFailure(kind, { env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now } = {}) {
  try {
    assertNotRealStateUnderTest(stateDir)
    const before = readGateHealth({ stateDir })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const file = healthFile(stateDir)
    const lost = before?.unreadable === true
    if (lost) renameSync(file, `${file}.unreadable`)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ count: (lost ? 0 : before?.count ?? 0) + 1, last_at: new Date(now()).toISOString(), last_kind: kind, ...(lost || before?.lost_history ? { lost_history: true } : {}) })}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // Best effort: a record that cannot be written leaves the gate exactly as it was.
  }
}

/** The doctor's section: a warning with the count, the last time and what it means while the last failure is recent; a warning that the record is unreadable; else null. */
export function gateHealthSummary({ env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now }) {
  const record = readGateHealth({ stateDir })
  if (record === null) return null
  if (record.unreadable === true) return `Done-claim gate\n  warning: the failure record (${GATE_HEALTH_FILE}) is unreadable, so the count and the last time of the gate's quiet failures are unknown`
  if (now() - Date.parse(record.last_at) > GATE_HEALTH_WINDOW_MS) return null
  const lost = record.lost_history ? "; earlier history was unreadable and was set aside" : ""
  return `Done-claim gate\n  warning: ${record.count} quiet failure${record.count === 1 ? "" : "s"} (last ${record.last_kind} at ${record.last_at}): ${MEANING[record.last_kind] ?? "the gate could not check a reply"}${lost}`
}
