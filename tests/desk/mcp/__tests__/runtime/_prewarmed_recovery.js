import { writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { launchBootstrap, runRecovery } from "../../../../../plugins/desk/mcp/scripts/local-recovery.js"

// The real local-recovery client owns this real bootstrap process throughout.
// Complete a status computation before injecting slow destination verification;
// otherwise the first usable status can arrive only after initial admission.
async function prewarm(transport, { root, marker, evidence }) {
  let sequence = 0
  let buffered = ""
  const waiting = new Map()
  const onData = (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const response = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      waiting.get(response.id)?.(response)
    }
  }
  transport.output.on("data", onData)
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = --sequence
    const timer = setTimeout(() => reject(new Error(`prewarm ${method} did not answer`)), 15000)
    waiting.set(id, (reply) => {
      clearTimeout(timer)
      waiting.delete(id)
      if (reply.error) reject(new Error(reply.error.message))
      else resolve(reply.result)
    })
    transport.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "recovery-prewarm", version: "1" } })
    await request("tools/list", {})
    const deadline = Date.now() + 15000
    for (;;) {
      const started = performance.now()
      const result = await request("tools/call", { name: "desk_status", arguments: { detail: true } })
      const elapsedMs = performance.now() - started
      if (elapsedMs >= 200) throw new Error(`actual bootstrap prewarm status exceeded 200 ms: ${elapsedMs}`)
      const status = JSON.parse(result.content[0].text)
      if (!result.isError && status.state === "ready" && !status.detail_pending &&
          status.root?.path === root && status.root.valid && status.write_scope?.mode === "workspace") {
        writeFileSync(evidence, JSON.stringify({
          state: status.state, root: status.root.path, detail: status.status_detail,
          from: status.status_detail_from, elapsedMs, completedObservedAt: new Date().toISOString(),
        }))
        writeFileSync(marker, "completed same-context status observed\n")
        return
      }
      if (Date.now() >= deadline) throw new Error("actual bootstrap never completed same-context status before resolver injection")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally {
    transport.output.off("data", onData)
  }
}

const result = await runRecovery({
  argv: process.argv.slice(2),
  launch: async (options) => {
    const transport = launchBootstrap(options)
    try {
      const root = options.argv[options.argv.indexOf("--root") + 1]
      await prewarm(transport, { root, marker: process.env.DESK_FIXTURE_DELAY_MARKER, evidence: process.env.DESK_FIXTURE_COMPLETED_STATUS })
      return transport
    } catch (error) {
      await transport.close()
      throw error
    }
  },
})
process.stdout.write(`${JSON.stringify(result.report)}\n`)
process.exitCode = result.exitCode
