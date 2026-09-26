import { fork } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { lstatSync, unlinkSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { controllerSocketIdentity, releaseRendezvous } from "./controller-server.js"
import { ownerState, readOwnerRecord } from "./owner-record.js"
import { probeController, probeMissed } from "./hung-controller.js"
import { validateControllerEndpoint, validatePrivateDirectory } from "./identity.js"
import { request } from "./controller-client.js"

const childEntry = fileURLToPath(new URL("./controller-child.js", import.meta.url))

export function supervisorEndpoint(endpoint, platform = process.platform) {
  const id = randomUUID()
  return platform === "win32" ? `\\\\.\\pipe\\desk-supervisor-${id}` : path.join(path.dirname(endpoint), `${id}.sock`)
}

/** The only process that can terminate a controller is the parent holding its actual child handle. */
export async function startControllerProcess(options, { spawn = fork, timeoutMs = 10000, createServer = net.createServer, socketTimeoutMs = 10000 } = {}) {
  const { identity, endpoint, stateDir } = options
  const supervisor = { endpoint: supervisorEndpoint(endpoint), token: randomUUID() }
  validateControllerEndpoint(supervisor.endpoint)
  const events = new EventEmitter()
  let child
  let record = null
  let ended = false
  let resolveExit
  const exited = new Promise((resolve) => { resolveExit = resolve })
  const server = createServer((socket) => {
    let pending = ""
    socket.setEncoding("utf8")
    socket.setTimeout(socketTimeoutMs, () => socket.destroy())
    socket.on("error", () => socket.destroy())
    socket.on("data", (chunk) => {
      pending += chunk
      if (pending.length > 16384) { socket.destroy(); return }
      const newline = pending.indexOf("\n")
      if (newline < 0) return
      const line = pending.slice(0, newline)
      pending = ""
      void reclaim(line).then(
        (result) => socket.end(`${JSON.stringify({ result })}\n`),
        (error) => socket.end(`${JSON.stringify({ error: { message: error.message, code: error.code } })}\n`),
      )
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(supervisor.endpoint, () => { server.off("error", reject); resolve() })
  })
  supervisor.socket = controllerSocketIdentity(supervisor.endpoint)
  server.on("error", (error) => process.stderr.write(`[desk-mcp] controller supervisor error: ${error.message}\n`))
  server.unref()

  async function reclaim(line) {
    const message = JSON.parse(line)
    if (message.method !== "reclaim" || message.params?.supervisor_token !== supervisor.token ||
        message.params?.token !== record?.owner.token || message.params?.identity !== identity.id ||
        message.params?.owner_pid !== child?.pid || ended) {
      return { reclaimed: false, reason: "supervisor_owner_mismatch" }
    }
    const probe = await probeController({
      root: identity.root, policy: options.policy, stateHome: path.dirname(stateDir), timeoutMs: 1000,
    })
    if (!probeMissed(probe)) return { reclaimed: false, reason: "controller_answering" }
    const verification = await verifyOwnedChild({ child, record, stateDir, identity, endpoint })
    if (!verification.ok) return { reclaimed: false, reason: verification.reason }
    if (!child.kill("SIGKILL")) return { reclaimed: false, reason: "child_stop_failed" }
    await exited
    return { reclaimed: true, owner_pid: child.pid }
  }

  function onExit() {
    ended = true
    if (record) releaseRendezvous({ stateDir, endpoint, owner: record.owner, socket: record.socket })
    server.close()
    resolveExit()
    events.emit("exit")
  }

  try {
    // Host execArgv may contain a session-only preload or --test. The runtime and its dependency mirror are already selected.
    child = spawn(childEntry, [], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true })
    child.once("exit", onExit)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("readiness controller child startup timed out")), timeoutMs)
      const failed = (error) => { clearTimeout(timeout); reject(error) }
      child.once("error", failed)
      child.once("exit", () => failed(new Error("readiness controller child exited before admission")))
      child.once("message", (message) => {
        clearTimeout(timeout)
        if (message?.type !== "ready") {
          reject(Object.assign(new Error(message?.message ?? "readiness controller child sent an invalid startup message"), { code: message?.code }))
          return
        }
        const candidate = readOwnerRecord(stateDir, identity)
        if (candidate.status !== "valid" || candidate.record.owner.pid !== child.pid || candidate.record.owner.token !== message.owner?.token) {
          reject(new Error("readiness controller child published an unexpected owner"))
          return
        }
        record = candidate.record
        resolve()
      })
      child.send({ type: "start", options: { ...options, supervisor } })
    })
    child.unref()
    child.channel.unref()
  } catch (error) {
    if (child?.pid && !ended) { child.kill("SIGKILL"); await exited }
    else server.close()
    throw error
  }
  return {
    owner: record.owner,
    onExit(listener) {
      if (ended) { queueMicrotask(listener); return () => {} }
      events.on("exit", listener)
      return () => events.off("exit", listener)
    },
    async close() {
      if (ended) return
      child.ref()
      const timeout = setTimeout(() => child.kill("SIGKILL"), 1000)
      if (child.connected) child.send({ type: "close" })
      await exited
      clearTimeout(timeout)
    },
  }
}

export function releaseSupervisor(supervisor, { stat = lstatSync, unlink = unlinkSync, stderr = process.stderr } = {}) {
  if (!supervisor.socket) return
  try {
    const current = stat(supervisor.endpoint)
    if (current.dev === supervisor.socket.dev && current.ino === supervisor.socket.ino) unlink(supervisor.endpoint)
  } catch (error) {
    if (error.code !== "ENOENT") stderr.write(`[desk-mcp] controller supervisor cleanup failed: ${error.message}\n`)
  }
}

export async function verifyOwnedChild({ child, record, stateDir, identity, endpoint, inspect = ownerState, platform = process.platform, stat = lstatSync }) {
  if (child.exitCode !== null || child.signalCode !== null || record?.owner?.kind !== "controller_child" ||
      record.owner.pid !== child.pid || record.owner.parent_pid !== process.pid) {
    return { ok: false, reason: "not_owned_child" }
  }
  const current = await inspect({ stateDir, identity })
  if (!current.verified || current.state !== "live") return { ok: false, reason: "owner_unverified" }
  if (current.record.owner.pid !== child.pid || current.record.owner.token !== record.owner.token ||
      current.record.owner.process_start !== record.owner.process_start || current.record.endpoint !== endpoint) {
    return { ok: false, reason: "owner_changed" }
  }
  if (platform !== "win32") {
    validatePrivateDirectory(stateDir)
    validatePrivateDirectory(path.dirname(endpoint))
    const socket = stat(endpoint)
    if (!socket.isSocket() || socket.uid !== process.getuid() || socket.dev !== record.socket?.dev || socket.ino !== record.socket?.ino) {
      return { ok: false, reason: "endpoint_changed" }
    }
  }
  return { ok: true }
}

export async function reclaimControllerChild(probe, { platform = process.platform, stat = lstatSync, call = request } = {}) {
  const supervisor = probe.record?.supervisor
  if (!probe.ownerVerified || probe.record?.owner?.kind !== "controller_child" || typeof supervisor?.endpoint !== "string") {
    return { reclaimed: false, reason: "not_verified_child" }
  }
  validateControllerEndpoint(supervisor.endpoint, platform)
  if (platform !== "win32") {
    if (path.dirname(supervisor.endpoint) !== path.dirname(probe.endpoint)) return { reclaimed: false, reason: "supervisor_endpoint_changed" }
    validatePrivateDirectory(path.dirname(supervisor.endpoint))
    const socket = stat(supervisor.endpoint)
    if (!socket.isSocket() || socket.uid !== process.getuid()) return { reclaimed: false, reason: "supervisor_not_owned" }
    if (socket.dev !== supervisor.socket?.dev || socket.ino !== supervisor.socket?.ino) return { reclaimed: false, reason: "supervisor_endpoint_changed" }
  } else if (!/^\\\\\.\\pipe\\desk-supervisor-[a-f0-9-]{36}$/u.test(supervisor.endpoint)) {
    return { reclaimed: false, reason: "supervisor_endpoint_changed" }
  }
  return call({
    endpoint: supervisor.endpoint, identity: probe.identity, method: "reclaim", timeoutMs: 10000,
    params: { supervisor_token: supervisor.token, token: probe.record.owner.token, owner_pid: probe.record.owner.pid },
  })
}
