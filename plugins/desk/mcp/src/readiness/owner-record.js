// The readiness controller's owner record (owner.json) and whether it names a running owner.
//
// An owner is one process: its PID plus its start time as the operating system reports it (process-start.js), recorded as `owner.process_start` when the controller is elected. A PID that is alive but whose start time differs names some later process that reused the PID, so the recorded owner has ended. A record from an older Desk without a start time is judged by its PID alone.
//
// A controller whose owner process is running is never taken over, even when it does not answer or refuses connections (a stopped process, or one whose accept queue is full): Desk never unlinks its socket and never starts a second controller for the root (fix round 3 ruling). Only an owner that is gone, or a record that is missing or corrupt, lets another session reclaim the socket and elect a new controller.
//
// Dependency-free, so the session can run it before and without the runtime pack.

import { readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { lexicalControllerIdentity, stableStringify } from "./identity.js"
import { readProcessStart } from "./process-start.js"

// An owner that started more than this long before the machine booted is from an earlier boot, so its PID now names some other process.
const BOOT_SLACK_MS = 5 * 60_000

/**
 * Read owner.json. `status` is "valid" (it names this identity, an owner PID, token and start time), "missing" (no file) or "corrupt" (anything else, including a file that cannot be read).
 */
export function readOwnerRecord(stateDir, identity = null) {
  let text
  try {
    text = readFileSync(path.join(stateDir, "owner.json"), "utf8")
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "corrupt", record: null }
  }
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return { status: "corrupt", record: null }
  }
  const owner = record?.owner
  const valid = Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.token === "string" &&
    typeof owner.started_at === "string" && Number.isFinite(Date.parse(owner.started_at)) &&
    (identity === null || stableStringify(lexicalControllerIdentity(record.identity)) === stableStringify(lexicalControllerIdentity(identity)))
  return { status: valid ? "valid" : "corrupt", record }
}

/**
 * Whether a valid record's owner runs: "self" (this process), "dead" (no such process, the owner started before this boot, or the PID now names a process that started at another time) or "alive".
 * A PID that exists but belongs to another user (EPERM) is alive unless its start time differs: Desk cannot tell it apart from its owner otherwise, so it never takes it over. A start time that cannot be read keeps the owner alive too.
 */
export async function ownerLiveness(record, { kill = process.kill, uptimeSeconds = os.uptime, now = Date.now, selfPid = process.pid, processStart = readProcessStart } = {}) {
  const pid = record.owner.pid
  if (pid === selfPid) return "self"
  if (Date.parse(record.owner.started_at) < now() - uptimeSeconds() * 1000 - BOOT_SLACK_MS) return "dead"
  try {
    kill(pid, 0)
  } catch (error) {
    if (error?.code === "ESRCH") return "dead"
  }
  const recorded = record.owner.process_start
  if (typeof recorded !== "string") return "alive"
  const current = await processStart(pid)
  return current !== null && current !== recorded ? "dead" : "alive"
}

/**
 * The owner of a root's controller, as far as taking it over goes: "live" (another process that runs: never take it over), "dead", "self", "missing" or "corrupt".
 * `record` is the parsed owner.json when there is one.
 */
export async function ownerState({ stateDir, identity = null, ...liveness }) {
  const { status, record } = readOwnerRecord(stateDir, identity)
  if (status !== "valid") return { state: status, record }
  const state = await ownerLiveness(record, liveness)
  return { state: state === "alive" ? "live" : state, record }
}
