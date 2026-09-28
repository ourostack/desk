import * as path from "node:path"
import { startInProcess } from "../../runtime/_in_process_desk.js"
import { connectOrStartController } from "../../../src/server.js"

const [root, stateHome, allowedEndpoint] = process.argv.slice(2)
const originalFetch = globalThis.fetch
const requests = []
// Keep real HTTP for the fixture service; never depend on an operator's Ollama.
globalThis.fetch = async (url, options) => {
  requests.push({ url, ...JSON.parse(options.body) })
  if (url !== allowedEndpoint) throw new Error("fixture forbids ambient fallback")
  return originalFetch(url, options)
}
let controller
const desk = await startInProcess({
  argv: ["--root", root],
  readinessPolicy: { semantic: "required" },
  stateHome: path.join(stateHome, "desk-state"),
  runtimeImporter: async () => ({
    async connectOrStartController(options) {
      controller = await connectOrStartController({ ...options, stateHome, ephemeral: true })
      return controller
    },
  }),
}, { connect: false })
const snapshot = await desk.settled()
const started = snapshot.state === "ready"
const failure = snapshot.diagnostic?.observed ?? {}
process.send(started
  ? { started, id: controller.id, contract: controller.identity.semantic_contract, requests }
  : { started, id: controller?.id, code: failure.failure_code, message: failure.message, diagnostic: failure.diagnostic, requests })
await new Promise((resolve) => process.once("message", resolve))
await desk.close()
await controller?.close()
process.disconnect()
