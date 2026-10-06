// A small local record of the done-claim gate's quiet failures, so a gate that keeps failing is visible and never blocks anything.
//
// The gate fails quietly in three places that cannot block a turn: its own Stop error after a retry, a PostToolUse recording failure, and the hook wrapper's import or JSON failure. Each calls `recordGateFailure`, which counts it in one file under Desk's state folder. `desk_doctor` reads the record with `gateHealthSummary` and warns with the count and the last time, while the last failure is recent. Writing the record is best effort: if even that fails, nothing more can be done, and the gate carries on.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const GATE_HEALTH_FILE = "done-gate-failures.json"
/** A failure older than this no longer raises the warning. */
export const GATE_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const healthFile = (stateDir) => path.join(stateDir, GATE_HEALTH_FILE)

/** The record `{ count, last_at, last_kind }`, or null when none exists or it cannot be read. */
export function readGateHealth({ env = process.env, stateDir = resolveDeskStateDir({ env }) } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(healthFile(stateDir), "utf8"))
    return Number.isInteger(parsed?.count) && parsed.count > 0 && typeof parsed.last_at === "string" ? { count: parsed.count, last_at: parsed.last_at, last_kind: typeof parsed.last_kind === "string" ? parsed.last_kind : "unknown" } : null
  } catch {
    return null
  }
}

/** Count one quiet failure (`kind`: `stop_error`, `record_failed`, `wrapper_error`). Never throws. `options` (`env`, `stateDir`, `now`) are for tests. */
export function recordGateFailure(kind, { env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now } = {}) {
  try {
    assertNotRealStateUnderTest(stateDir)
    const before = readGateHealth({ stateDir })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const file = healthFile(stateDir)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ count: (before?.count ?? 0) + 1, last_at: new Date(now()).toISOString(), last_kind: kind })}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // Best effort: a record that cannot be written leaves the gate exactly as it was.
  }
}

/** The doctor's section: a warning with the count and the last time while the last failure is recent, else null. */
export function gateHealthSummary({ env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now } = {}) {
  const record = readGateHealth({ stateDir })
  if (record === null || now() - Date.parse(record.last_at) > GATE_HEALTH_WINDOW_MS) return null
  return `Done-claim gate\n  warning: ${record.count} quiet failure${record.count === 1 ? "" : "s"} (last ${record.last_kind} at ${record.last_at}); the gate could not check some replies, and nothing was blocked for it`
}
