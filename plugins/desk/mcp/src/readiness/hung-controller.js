// A readiness controller that accepts connections but never answers: detect it and report it. Never stop it.
//
// A session that cannot elect a controller probes the root's controller socket with a handshake. A probe the socket accepts but does not answer within the probe time is a miss; after 3 consecutive misses (the session's admission retries space them out on its backoff) the session is `degraded:controller_hung` and stays controller-free: reads and writes work, and search reads the files directly.
//
// Desk never signals the controller's owner (controller ruling, fix round 2): today the controller runs inside another session's Desk MCP server, and stopping that process would cost that session its Desk connection. Once the controller runs in a child process of its own (task A2b), reclaiming it can stop that child without touching any session's server.
//
// Dependency-free, so the session can run it before and without the runtime pack.

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import { readinessContracts } from "./contracts.js"
import { controllerIdentity, deriveControllerEndpoint } from "./identity.js"

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

/** What desk_status and desk_doctor say about a hung controller: its owner (from the owner record) and where it listens. */
export function hungControllerReport(probe) {
  const pid = probe.record?.owner?.pid
  return {
    state: probe.state,
    endpoint: probe.endpoint,
    owner_pid: Number.isInteger(pid) ? pid : null,
    owner_started_at: typeof probe.record?.owner?.started_at === "string" ? probe.record.owner.started_at : null,
  }
}
