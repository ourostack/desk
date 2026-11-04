import { writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { launchBootstrap, runRecovery } from "../../../../../plugins/desk/mcp/scripts/local-recovery.js"

// The real local-recovery client owns this real bootstrap process throughout.
// Establish a completed, fast cache observation before injecting slow destination verification; retain cold or descheduled round trips rather than treating them as qualified observations.
export async function prewarm(transport, {
  root, marker, evidence, now = () => performance.now(),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let sequence = 0
  let buffered = ""
  const waiting = new Map()
  const observations = []
  const failure = (message) => Object.assign(new Error(message), { observations: observations.slice() })
  const onData = (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const response = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      waiting.get(response.id)?.finish(response)
    }
  }
  transport.output.on("data", onData)
  const request = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = --sequence
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(failure(`prewarm ${method} did not answer`))
    }, timeoutMs)
    waiting.set(id, { timer, finish(reply) {
      clearTimeout(timer)
      waiting.delete(id)
      if (reply.error) reject(failure(reply.error.message))
      else resolve(reply.result)
    } })
    transport.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
  const expired = () => failure(
    `actual bootstrap never completed same-context status before resolver injection; ${observations.length} round trips observed, maximum ${Math.max(0, ...observations.map((sample) => sample.elapsedMs))} ms`,
  )
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "recovery-prewarm", version: "1" } })
    await request("tools/list", {})
    const startedAt = now()
    const deadline = startedAt + 15000
    for (;;) {
      const started = now()
      if (started >= deadline) throw expired()
      const result = await request("tools/call", { name: "desk_status", arguments: { detail: true } }, deadline - started)
      const elapsedMs = now() - started
      const status = JSON.parse(result.content[0].text)
      // A detail marked "Destination verification is pending" was answered during a revalidation, so it is not yet complete.
      const ready = !result.isError && status.state === "ready" && !status.detail_pending &&
          !String(status.status_detail ?? "").includes("Destination verification is pending") &&
          status.root?.path === root && status.root.valid && status.write_scope?.mode === "workspace"
      const qualified = Boolean(ready) && elapsedMs < 200 && now() < deadline
      observations.push({ elapsedMs, state: status.state, ready: Boolean(ready), qualified })
      if (now() >= deadline) throw expired()
      if (qualified) {
        writeFileSync(evidence, JSON.stringify({
          state: status.state, root: status.root.path, detail: status.status_detail,
          from: status.status_detail_from, elapsedMs, observations, readinessElapsedMs: now() - startedAt,
          completedObservedAt: new Date().toISOString(),
        }))
        writeFileSync(marker, "completed same-context status observed\n")
        return
      }
      await pause(Math.min(20, deadline - now()))
    }
  } finally {
    transport.output.off("data", onData)
    for (const { timer } of waiting.values()) clearTimeout(timer)
    waiting.clear()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRecovery({
    argv: process.argv.slice(2),
    launch: async (options) => {
      const transport = launchBootstrap(options)
      try {
        const root = options.argv[options.argv.indexOf("--root") + 1]
        await prewarm(transport, { root, marker: process.env.DESK_FIXTURE_DELAY_MARKER, evidence: process.env.DESK_FIXTURE_COMPLETED_STATUS })
        return transport
      } catch (error) {
        // runRecovery reports a launch failure only as recovery_error; the test prints this stderr when the run fails.
        process.stderr.write(`prewarm failed: ${error.message}\n`)
        if (error.observations) process.stderr.write(`prewarm round trips: ${JSON.stringify(error.observations)}\n`)
        await transport.close()
        throw error
      }
    },
  })
  process.stdout.write(`${JSON.stringify(result.report)}\n`)
  process.exitCode = result.exitCode
}
