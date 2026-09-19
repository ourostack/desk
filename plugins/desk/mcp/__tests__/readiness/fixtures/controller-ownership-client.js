import { Server } from "node:net"
import { connectOrStartController } from "../../../src/readiness/controller-client.js"
import { rebuildIndex } from "../../../src/indexer/index.js"

const [root, stateHome, encodedContract] = process.argv.slice(2)
const semanticContract = JSON.parse(encodedContract)
let start, release, controller, work
const started = new Promise((resolve) => { start = resolve })
const held = new Promise((resolve) => { release = resolve })
const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  this.once("listening", () => process.send({ event: "listener-started" }))
  return listen.apply(this, args)
}
process.on("message", async (message) => {
  if (message === "start") start()
  if (message === "release") release()
  if (message === "converge") {
    work = controller.beginConvergence()
    try { process.send({ event: "converged", result: await work }) }
    catch (error) { process.send({ event: "failed", message: error.message }) }
  }
  if (message === "close") {
    release()
    await work?.catch(() => {})
    await controller?.close()
    process.disconnect()
  }
})
process.send({ event: "ready" })
await started
try {
  controller = await connectOrStartController({
    root, stateHome, protocolVersion: 1, lexicalContract: { schema: 1 }, semanticContract, ephemeral: true,
    handlers: { async beginConvergence({ eventCursor }) {
      process.send({ event: "mutation-started" })
      const summary = await rebuildIndex(root, {
        eventCursor,
        embed: { fetch: async () => {
          process.send({ event: "embedding-held" })
          await held
          return { ok: true, json: async () => ({ embedding: Array(768).fill(0.1) }) }
        } },
      })
      return { summary }
    } },
  })
  process.send({ event: "accepted", id: controller.id, ownerPid: (await controller.status()).owner.pid })
} catch (error) {
  process.send({ event: "refused", code: error.code, diagnostic: error.diagnostic, message: error.message })
}
