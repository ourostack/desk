// Five servers racing for one root each start a controller. On Windows each of them used to read its own process start time (PowerShell, seconds on a loaded machine) before binding the pipe, so all five paid for it and none of them finished within the 10 s startup window. The pipe is now bound first on Windows: a controller that loses the election fails at once without the read, and a session that lost waits for the winner as long as a winner is given to start.

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, rmSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { startReadinessController } from "../../../../../plugins/desk/mcp/src/readiness/controller-server.js"
import { createExitRelease } from "../../../../../plugins/desk/mcp/src/readiness/exit-release.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { mkTempRoot } from "../_temp_roots.js"

const quietExit = () => {
  const proc = new EventEmitter()
  proc.pid = process.pid
  proc.kill = () => {}
  return createExitRelease(proc)
}

async function fixture(t, prefix) {
  const root = await mkTempRoot(prefix)
  const identity = controllerIdentity({ root, protocolVersion: 1, lexicalContract: {} })
  const endpoint = deriveControllerEndpoint({ identity })
  const stateDir = path.join(root, "state", identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  t.after(() => rmSync(endpoint, { force: true }))
  return { root, identity, endpoint, stateDir, stateHome: path.join(root, "state") }
}

const accepting = (endpoint) => new Promise((resolve) => {
  const socket = net.createConnection(endpoint)
  socket.once("connect", () => { socket.destroy(); resolve(true) })
  socket.once("error", () => resolve(false))
})

test("with the bind first, the process start is read after the pipe is bound, and only by the controller that bound it", { timeout: 60_000 }, async (t) => {
  const { identity, endpoint, stateDir } = await fixture(t, "desk-bindfirst-")
  const reads = []
  const winner = await startReadinessController({
    identity, endpoint, stateDir, ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: true,
    ownProcessStart: async () => { reads.push(await accepting(endpoint)); return "win32:2026-10-08T00:00:00.000Z" },
  })
  t.after(() => winner.close())
  assert.deepEqual(reads, [true], "the read ran once, with the endpoint already accepting")
  assert.equal(winner.owner.process_start, "win32:2026-10-08T00:00:00.000Z")
  let lost = 0
  await assert.rejects(startReadinessController({
    identity, endpoint, stateDir: path.join(stateDir, "loser"), ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: true,
    ownProcessStart: async () => { lost += 1; return null },
  }), { code: "EADDRINUSE" })
  assert.equal(lost, 0, "a controller that lost the bind never read its process start")
})

test("without the bind first, the process start is read before the bind, as before", { timeout: 60_000 }, async (t) => {
  const { identity, endpoint, stateDir } = await fixture(t, "desk-readfirst-")
  const reads = []
  const controller = await startReadinessController({
    identity, endpoint, stateDir, ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: false,
    ownProcessStart: async () => { reads.push(await accepting(endpoint)); return null },
  })
  t.after(() => controller.close())
  assert.deepEqual(reads, [false], "the endpoint was not yet bound when the read ran")
  assert.equal(controller.owner.process_start, undefined)
})

test("the bind-first default follows the platform: Windows binds first, the others read first", { timeout: 60_000 }, async (t) => {
  const { identity, endpoint, stateDir } = await fixture(t, "desk-bindfirst-default-")
  const reads = []
  const controller = await startReadinessController({
    identity, endpoint, stateDir, ephemeral: true, exitRelease: quietExit(),
    ownProcessStart: async () => { reads.push(await accepting(endpoint)); return null },
  })
  t.after(() => controller.close())
  assert.deepEqual(reads, [process.platform === "win32"])
})

test("a process start read that fails after the bind releases the pipe and reports the failure", { timeout: 60_000 }, async (t) => {
  const { identity, endpoint, stateDir } = await fixture(t, "desk-bindfirst-fail-")
  await assert.rejects(startReadinessController({
    identity, endpoint, stateDir, ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: true,
    ownProcessStart: async () => { throw new Error("the read failed") },
  }), /the read failed/u)
  assert.equal(await accepting(endpoint), false, "the pipe is not left bound")
})

test("a session that lost the bind waits for a winner that is still starting, and gives up with a reason when none comes", { timeout: 60_000 }, async (t) => {
  const inUse = () => { throw Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" }) }

  const late = await fixture(t, "desk-election-late-")
  let winner
  const client = await connectOrStartController({
    root: late.root, stateHome: late.stateHome, ephemeral: true,
    startController: async (options) => {
      // The winner is slow: it holds the pipe now and publishes its owner record 1.5 s later, longer than the old 20 tries of 25 ms.
      setTimeout(() => {
        startReadinessController({ ...options, ephemeral: true, exitRelease: quietExit(), ownProcessStart: () => new Promise((resolve) => setTimeout(() => resolve(null), 1500)) })
          .then((controller) => { winner = controller })
      }, 0)
      return inUse()
    },
  })
  try {
    assert.equal((await client.status()).state, "CONTROL_READY")
  } finally {
    await client.close()
    await winner?.close()
  }

  const nobody = await fixture(t, "desk-election-nobody-")
  const started = Date.now()
  await assert.rejects(
    connectOrStartController({ root: nobody.root, stateHome: nobody.stateHome, ephemeral: true, startController: inUse, electionWaitMs: 300 }),
    /readiness controller election did not converge/u,
  )
  assert.ok(Date.now() - started < 5000, `gave up after ${Date.now() - started} ms`)
})
