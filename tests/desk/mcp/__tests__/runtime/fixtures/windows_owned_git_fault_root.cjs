"use strict"
// Class B only: explicit test Root, never an installed production shim.
// A real retained-root assignment/authentication is required before the fault.
const crypto = require("node:crypto")
const net = require("node:net")
const fs = require("node:fs")
const core = require("../../../../../../plugins/desk/mcp/scripts/owned-git-child.cjs")

function startFaultRoot() {
  const binding = { generation: process.env.DESK_OWNED_GIT_GENERATION,
    preparationDigest: process.env.DESK_OWNED_GIT_PREPARATION_DIGEST, payloadDigest: null }
  const nonce = crypto.randomBytes(32).toString("hex")
  const state = core.createRootState(binding, nonce, process.env.DESK_OWNED_GIT_CAPABILITY)
  const endpoint = process.env.DESK_OWNED_GIT_ENDPOINT
  if (!/^\\\\\.\\pipe\\desk-owned-git-[0-9a-f]{64}$/.test(endpoint)) throw new Error("fault_fixture_bootstrap")
  const socket = net.createConnection({ path: endpoint })
  for (const name of Object.keys(process.env)) if (/^DESK_OWNED_GIT_/i.test(name)) delete process.env[name]
  const writer = core.createFrameWriter(socket, () => socket.destroy())
  const decoder = core.createFrameDecoder({ role: "owner", binding, phase: "hello" })
  const send = (type, extra = {}) => writer.send({ protocol: "desk.owned-git/1", role: "root", type, ...binding, ...extra })
  socket.once("connect", () => writer.send(state.hello()))
  socket.on("error", () => { process.exitCode = 1 })
  socket.on("data", (bytes) => {
    try {
      for (const value of decoder.push(bytes)) {
        const action = state.accept(value)
        if (action === "send_ack") send("ACK", { clientNonce: nonce })
        else if (action === "read_payload") {
          const size = fs.statSync(value.path).size
          if (size <= 0 || size > 1048576) throw new Error("fault_fixture_payload")
          core.parsePayloadBytes(fs.readFileSync(value.path), value.payloadDigest)
          binding.payloadDigest = value.payloadDigest; state.configured(); send("CONFIGURED")
        } else if (action === "start") {
          // Authenticated malformed-body fixture: deliberately no genuine command
          // or RESULT. This cannot qualify genuine-result/post-result families.
          socket.end(Buffer.from([1, 0, 0, 0, 123]))
        }
      }
    } catch { socket.destroy(); process.exitCode = 1 }
  })
  socket.on("end", () => { try { decoder.end() } catch { process.exitCode = 1 } })
}
if (require.main === module) {
  try { startFaultRoot() } catch { process.exitCode = 1 }
}
