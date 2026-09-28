// Run index.js main() in this process behind the front door, with an MCP SDK client on in-memory streams.
//
// Every caller gets a temporary stateHome, so last-start.json, the repair log and readiness controllers stay out of the real ~/.local/state and ~/.cache.

import { PassThrough } from "node:stream"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { main } from "../../index.js"
import { runAdmissionJob } from "../../src/runtime/admission-worker.js"
import { mkTempRoot } from "../_temp_roots.js"

/** An MCP transport over a pair of streams: the client writes to `toServer` and reads `fromServer`. */
export class StreamTransport {
  constructor({ toServer, fromServer }) {
    this.toServer = toServer
    this.fromServer = fromServer
    this.buffered = ""
  }

  async start() {
    this.fromServer.on("data", (chunk) => {
      this.buffered += chunk.toString("utf8")
      let newline
      while ((newline = this.buffered.indexOf("\n")) >= 0) {
        const line = this.buffered.slice(0, newline)
        this.buffered = this.buffered.slice(newline + 1)
        if (line.trim()) this.onmessage?.(JSON.parse(line))
      }
    })
  }

  async send(message) {
    this.toServer.write(`${JSON.stringify(message)}\n`)
  }

  async close() {
    this.toServer.end()
    this.onclose?.()
  }
}

/**
 * Start main() with `options` and connect a client. Returns `{ handle, client, call, status, statusUntil, close, stateHome }`.
 * `call(name, args)` parses the JSON payload; `status()` is desk_status after admission settles.
 */
export async function startInProcess(options = {}, { connect = true } = {}) {
  const stateHome = options.stateHome ?? path.join(await mkTempRoot("desk-in-process-state-"), "state")
  const input = new PassThrough()
  const output = new PassThrough()
  const stderrLines = []
  const handle = await main({
    env: {},
    // Admission jobs run in this thread, so the coverage run measures them; the spawned tests exercise the real worker.
    offload: runAdmissionJob,
    // The SDK client never sends tools/list on connect: start admission at once instead of after the 1 s fallback.
    admissionKickoffMs: 0,
    stderr: { write: (text) => { stderrLines.push(String(text)); return true } },
    ...options,
    stateHome,
    input,
    output,
  })
  const client = new Client({ name: "desk-in-process-test", version: "1.0.0" })
  if (connect) await client.connect(new StreamTransport({ toServer: input, fromServer: output }))

  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args })
    let payload
    try {
      payload = JSON.parse(response.content[0].text)
    } catch {
      payload = response.content[0].text
    }
    return { isError: response.isError === true, payload, response }
  }

  async function statusUntil(predicate, { deadlineMs = 15000 } = {}) {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const { payload } = await call("desk_status")
      if (predicate(payload)) return payload
      if (Date.now() > deadline) throw new Error(`desk_status never matched; last: ${JSON.stringify(payload)}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** Wait for the first admission attempt (or the one running now) to settle. */
  async function settled({ deadlineMs = 30000 } = {}) {
    const deadline = Date.now() + deadlineMs
    while (handle.admission.snapshot().attempts === 0 || handle.admission.running) {
      if (Date.now() > deadline) throw new Error("admission did not settle")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return handle.admission.snapshot()
  }

  return {
    handle,
    client,
    call,
    statusUntil,
    settled,
    stateHome,
    stderr: () => stderrLines.join(""),
    async close() {
      await client.close()
      if (!input.writableEnded) input.end()
      await handle.closed
    },
  }
}

/**
 * Run admission once without a client and report what it admitted, the way tests used to capture the runtime's startServer options: `{ person, statusContext, snapshot, stderr }`. The session is closed afterwards.
 */
export async function admitInProcess(options = {}) {
  const desk = await startInProcess(options, { connect: false })
  const snapshot = await desk.settled()
  // Background convergence starts in a promise after admission: let it report before the session closes.
  await new Promise((resolve) => setImmediate(resolve))
  const { context } = desk.handle.session
  const result = {
    person: context.person ?? null,
    statusContext: {
      root: context.root,
      activation: context.activation,
      runtime: context.runtime,
      admission: context.admission ?? null,
    },
    snapshot,
    stateHome: desk.stateHome,
    stderr: desk.stderr(),
  }
  await desk.close()
  return result
}

/** The status context a session's tools receive, captured from its admitted context. */
export function statusContextOf(desk) {
  const { context } = desk.handle.session
  return { root: context.root, activation: context.activation, runtime: context.runtime, admission: context.admission ?? null }
}

/**
 * The real controller runtime on this test's event loop, so injected embedding transports stay local; process isolation is exercised by spawned-session tests.
 * `start(semantic)` runs one admission and resolves with its snapshot; `starts` holds the status context of each ready start.
 */
export function realRuntimeHarness(root, { stateHome = path.join(root, "controller-state"), argv = ["--root", root] } = {}) {
  const controllers = []
  const starts = []
  const desks = []
  let convergence
  return {
    controllers,
    starts,
    converged: () => convergence,
    async start(semantic) {
      const server = await import("../../src/server.js")
      const desk = await startInProcess({
        argv,
        env: {},
        readinessPolicy: { semantic },
        runtimeImporter: async () => ({
          callTool: server.callTool,
          async connectOrStartController(options) {
            const controller = await server.connectOrStartController({ ...options, stateHome, ephemeral: true, controllerLauncher: server.startControllerRuntime })
            controllers.push(controller)
            return controller
          },
          beginBackgroundConvergence(admission) {
            convergence = server.beginBackgroundConvergence(admission)
            return convergence
          },
        }),
      }, { connect: false })
      desks.push(desk)
      const snapshot = await desk.settled()
      if (snapshot.state === "ready") starts.push(statusContextOf(desk))
      return snapshot
    },
    async close() {
      await convergence
      for (const desk of desks.splice(0)) await desk.close()
      for (const controller of controllers.reverse()) await controller.close()
    },
  }
}
