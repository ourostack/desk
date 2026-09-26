// A readiness controller that accepts connections but never answers: detect it, and reclaim it when that is provably ours to reclaim.
//
// A session that cannot elect a controller probes the root's controller socket with a handshake. A probe the socket accepts but does not answer within the probe time is a miss. After 3 consecutive misses (the session's admission retries space them out on its backoff), Desk reclaims the controller, and desk_doctor's reclaim_controller repair does the same on request after 3 fresh misses. Reclaiming runs only when all of these hold:
// - the owner record names this root's controller, and the socket file is still the one it published (same device and inode), owned by this user, in a private folder of ours;
// - the owner PID is another process, alive, and ours to signal (not EPERM).
// Desk then sends SIGTERM, waits, sends SIGKILL if needed, and lets the next election reclaim the dead owner's socket as usual. Anything else keeps the controller-free mode (reads and writes work; search reads files directly).
//
// Dependency-free, so the session can run it before and without the runtime pack.

import { randomUUID } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import { readinessContracts } from "./contracts.js"
import {
  controllerIdentity, deriveControllerEndpoint, lexicalControllerIdentity, stableStringify, validatePrivateDirectory,
} from "./identity.js"

export const HUNG_MISSES = 3
export const HUNG_PROBE_MS = 5000

/**
 * Where the root's controller is and whether it answers. `state` is one of:
 * "missing" (no socket), "refused" (a socket nobody listens on), "answering", "silent" (accepts, no answer within `timeoutMs`) or "unknown".
 */
export async function probeController({ root, policy, stateHome, timeoutMs = HUNG_PROBE_MS, connect = net.createConnection }) {
  const identity = controllerIdentity({ root, ...readinessContracts(policy) })
  const stateDir = path.join(stateHome, identity.id)
  const record = readOwnerRecord(stateDir)
  const endpoint = typeof record?.endpoint === "string" ? record.endpoint : deriveControllerEndpoint({ identity })
  const state = await handshakeProbe({ endpoint, record, identity, timeoutMs, connect })
  return { state, endpoint, stateDir, record, identity }
}

function readOwnerRecord(stateDir) {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  } catch {
    return null
  }
}

function handshakeProbe({ endpoint, record, identity, timeoutMs, connect }) {
  return new Promise((resolve) => {
    const socket = connect(endpoint)
    let connected = false
    const finish = (state) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(state)
    }
    const timer = setTimeout(() => finish(connected ? "silent" : "unknown"), timeoutMs)
    socket.once("connect", () => {
      connected = true
      socket.write(`${JSON.stringify({
        type: "request",
        id: randomUUID(),
        method: "handshake",
        params: { token: record?.owner?.token, identity: identity.id, semantic_contract: null },
      })}\n`)
    })
    socket.once("data", () => finish("answering"))
    socket.once("error", (error) => {
      const code = error?.code
      finish(code === "ECONNREFUSED" ? "refused" : code === "ENOENT" ? "missing" : "unknown")
    })
  })
}

/** Whether a silent controller may be reclaimed, and why not when it may not. Returns `{ ok: true, pid, socket }` or `{ ok: false, reason }`. */
export function reclaimPreconditions(probe, { uid = process.getuid?.(), kill = process.kill, platform = process.platform } = {}) {
  if (platform === "win32") return { ok: false, reason: "unsupported_platform" }
  if (probe.state !== "silent") return { ok: false, reason: `controller_${probe.state}` }
  const { record, endpoint, identity, stateDir } = probe
  if (record === null || stableStringify(lexicalControllerIdentity(record.identity ?? {})) !== stableStringify(lexicalControllerIdentity(identity))) {
    return { ok: false, reason: "owner_record_not_ours" }
  }
  let socket
  try {
    validatePrivateDirectory(stateDir)
    validatePrivateDirectory(path.dirname(endpoint))
    socket = lstatSync(endpoint)
  } catch {
    return { ok: false, reason: "endpoint_not_ours" }
  }
  if (!socket.isSocket() || socket.uid !== uid || record.socket?.dev !== socket.dev || record.socket?.ino !== socket.ino) {
    return { ok: false, reason: "endpoint_not_ours" }
  }
  const pid = record.owner?.pid
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return { ok: false, reason: "owner_pid_invalid" }
  try {
    kill(pid, 0)
  } catch (error) {
    return { ok: false, reason: error?.code === "EPERM" ? "owner_not_ours" : "owner_gone" }
  }
  return { ok: true, pid }
}

/** Stop a hung controller's owner: SIGTERM, then SIGKILL. Returns `{ reclaimed: true, pid, line }` or `{ reclaimed: false, reason }`. */
export async function reclaimHungController(probe, {
  kill = process.kill,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  termWaitMs = 2000,
  killWaitMs = 1000,
  ...options
} = {}) {
  const preconditions = reclaimPreconditions(probe, { kill, ...options })
  if (!preconditions.ok) return { reclaimed: false, reason: preconditions.reason }
  const { pid } = preconditions
  const alive = () => {
    try {
      kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const waitForExit = async (ms) => {
    for (let waited = 0; waited < ms && alive(); waited += 50) await sleep(50)
    return !alive()
  }
  try {
    kill(pid, "SIGTERM")
  } catch {
    // Already gone.
  }
  if (!await waitForExit(termWaitMs)) {
    try {
      kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
    if (!await waitForExit(killWaitMs)) return { reclaimed: false, reason: "owner_survived" }
  }
  return { reclaimed: true, pid, line: `repaired: reclaimed a hung readiness controller (pid ${pid}, ${probe.endpoint}) that accepted connections but did not answer` }
}
