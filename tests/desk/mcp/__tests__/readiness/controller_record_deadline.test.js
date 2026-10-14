import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { recordCanonicalChanges } from "../../../../../plugins/desk/mcp/src/readiness/journal.js"

test("a queued durable recording returns bounded uncertain effect without replaying the canonical mutation", async (t) => {
  const root = await mkTempRoot("record-deadline-")
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let dispatched
  const entered = new Promise((resolve) => { dispatched = resolve })
  const recorded = []
  const sockets = new Set()
  const client = await connectOrStartController({
    root, stateHome: path.join(root, "state"), ephemeral: true, recordChangeTimeoutMs: 25,
    startController: async ({ endpoint, identity, stateDir }) => {
      const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
        socket.once("data", async (chunk) => {
          const request = JSON.parse(chunk.toString())
          let result = { accepted: true, identity }
          if (request.method === "recordChange") {
            dispatched()
            await gate
            recorded.push(request.params.path)
            result = { recorded: true, sequence: 1, cursor: { journal_id: "journal", sequence: 1 } }
          }
          socket.end(JSON.stringify({ result }) + "\n")
        })
      })
      await new Promise((resolve) => server.listen(endpoint, resolve))
      writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({ identity, owner: { token: "owned" } }))
      return { close: async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => server.close(resolve))
      } }
    },
  })
  t.after(() => client.close())
  const canonical = path.join(root, "task.md")
  writeFileSync(canonical, "already applied canonical mutation\n")
  const outcome = recordCanonicalChanges({ root, readiness: client, changes: [{ path: "task.md" }] }).then(
    () => ({ success: true }), (error) => error,
  )
  await entered
  let timer
  try {
    const result = await Promise.race([outcome, new Promise((resolve) => { timer = setTimeout(() => resolve("unbounded"), 250) })])
    assert.notEqual(result, "unbounded")
    assert.equal(result.code, "canonical_write_recording_failed")
    assert.equal(result.canonical_written, true)
    assert.equal(result.journal_recorded, null, "a lost acknowledgement does not prove the journal mutation failed")
    assert.equal(result.retryable, false)
    assert.equal(result.toJSON().journal_recorded, null)
    assert.equal(result.cause.code, "controller_recording_uncertain")
    assert.deepEqual(recorded, [])
  } finally {
    clearTimeout(timer)
    release()
    await outcome
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(recorded, ["task.md"], "the controller can still apply the one queued record after the caller returns")
})
