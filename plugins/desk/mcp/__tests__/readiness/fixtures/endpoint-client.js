import { main } from "../../../index.js"
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
let started = false
try {
  await main({
    argv: ["--root", root],
    readinessPolicy: { semantic: "required" },
    runtimeImporter: async () => ({
      async connectOrStartController(options) {
        controller = await connectOrStartController({ ...options, stateHome, ephemeral: true })
        return controller
      },
      async startServer() { started = true },
    }),
  })
  process.send({ started, id: controller.id, contract: controller.identity.semantic_contract, requests })
} catch (error) {
  process.send({ started, id: controller?.id, code: error.code, message: error.message, diagnostic: error.diagnostic, requests })
}
await new Promise((resolve) => process.once("message", resolve))
await controller?.close()
process.disconnect()
