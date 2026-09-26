// A readiness controller whose owner runs but that does not answer: detect it and report it. Never stop it, and never take it over.
//
// A session that cannot elect a controller probes the root's controller socket with a handshake. A probe the socket accepts but does not answer within the probe time is a miss, and so is a probe the socket refuses (or finds no socket for) while the owner record names a running process: a stopped owner, or one whose accept queue is full. After 3 consecutive misses (the session's admission retries space them out on its backoff) the session is `degraded:controller_hung` and stays controller-free: search reads the files directly and writes go straight to the files.
//
// Desk never signals the controller's owner (fix round 2 ruling): the controller runs inside another session's Desk MCP server, and stopping that process would cost that session its Desk connection. Desk never takes a running owner's controller over either (fix round 3 ruling): see owner-record.js. The session recovers when the controller answers again or its owner ends.
//
// Dependency-free, so the session can run it before and without the runtime pack.

import { randomUUID } from "node:crypto"
import * as net from "node:net"
import * as path from "node:path"

import { readinessContracts } from "./contracts.js"
import { controllerIdentity, deriveControllerEndpoint } from "./identity.js"
import { ownerState } from "./owner-record.js"

export const HUNG_MISSES = 3
export const HUNG_PROBE_MS = 5000

/**
 * Where the root's controller is and whether it answers. `state` is one of:
 * "missing" (no socket), "refused" (a socket nobody listens on), "answering", "silent" (accepts, no answer within `timeoutMs`), "unreachable" (refused, no socket or no answer while the owner record names a running process) or "unknown".
 */
export async function probeController({ root, policy, stateHome, timeoutMs = HUNG_PROBE_MS, connect = net.createConnection, liveness = {} }) {
  const identity = controllerIdentity({ root, ...readinessContracts(policy) })
  const stateDir = path.join(stateHome, identity.id)
  const owner = await ownerState({ stateDir, identity, ...liveness })
  const record = owner.record
  const endpoint = typeof record?.endpoint === "string" ? record.endpoint : deriveControllerEndpoint({ identity })
  const answer = await handshakeProbe({ endpoint, record, identity, timeoutMs, connect })
  const state = owner.state === "live" && answer !== "answering" && answer !== "silent" ? "unreachable" : answer
  return { state, endpoint, stateDir, record, identity }
}

/** Whether a probe counts as a missed check: a controller that accepts but does not answer, or whose running owner cannot be reached. */
export function probeMissed(probe) {
  return probe.state === "silent" || probe.state === "unreachable"
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

/**
 * What desk_status and desk_doctor say about a hung controller: its owner (from the owner record) and where it listens.
 * `owner_verified` is true when the record carries the owner's start time, so the running process with that PID was checked to be the owner itself; a record from an older Desk names a PID only, which another process may have reused.
 */
export function hungControllerReport(probe) {
  const pid = probe.record?.owner?.pid
  return {
    state: probe.state,
    endpoint: probe.endpoint,
    owner_pid: Number.isInteger(pid) ? pid : null,
    owner_started_at: typeof probe.record?.owner?.started_at === "string" ? probe.record.owner.started_at : null,
    owner_verified: typeof probe.record?.owner?.process_start === "string",
  }
}
