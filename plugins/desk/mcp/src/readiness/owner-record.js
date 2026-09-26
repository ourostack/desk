// The readiness controller's owner record (owner.json) and whether it names a running owner.
//
// A controller whose owner process is running is never taken over, even when it does not answer or refuses connections (a stopped process, or one whose accept queue is full): Desk never unlinks its socket and never starts a second controller for the root (fix round 3 ruling). Only an owner that is gone, or a record that is missing or corrupt, lets another session reclaim the socket and elect a new controller.
//
// Dependency-free, so the session can run it before and without the runtime pack.

import { readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { lexicalControllerIdentity, stableStringify } from "./identity.js"

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
 * Whether a valid record's owner runs: "self" (this process), "dead" (no such process, or the owner started before this boot) or "alive".
 * A PID that exists but belongs to another user (EPERM) is alive: Desk cannot tell it apart from its owner, so it never takes it over.
 */
export function ownerLiveness(record, { kill = process.kill, uptimeSeconds = os.uptime, now = Date.now, selfPid = process.pid } = {}) {
  const pid = record.owner.pid
  if (pid === selfPid) return "self"
  if (Date.parse(record.owner.started_at) < now() - uptimeSeconds() * 1000 - BOOT_SLACK_MS) return "dead"
  try {
    kill(pid, 0)
    return "alive"
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "alive"
  }
}

/**
 * The owner of a root's controller, as far as taking it over goes: "live" (another process that runs: never take it over), "dead", "self", "missing" or "corrupt".
 * `record` is the parsed owner.json when there is one.
 */
export function ownerState({ stateDir, identity = null, ...liveness }) {
  const { status, record } = readOwnerRecord(stateDir, identity)
  if (status !== "valid") return { state: status, record }
  const state = ownerLiveness(record, liveness)
  return { state: state === "alive" ? "live" : state, record }
}
