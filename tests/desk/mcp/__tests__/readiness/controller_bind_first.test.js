// Five servers racing for one root each start a controller. On Windows each of them used to read its own process start time (PowerShell, seconds on a loaded machine) before binding the pipe, so all five paid for it and none of them finished within the 10 s startup window. The pipe is now bound first on Windows: a controller that loses the election fails at once without the read. A session that lost waits for the winner for 10 s on Windows. The winner's own start window is 15 s (10 s plus the 5 s cap on the read), but the loser's wait only has to cover the winner's read: the winner binds first, so the loser's wait starts after the bind, and the read it waits for is capped at 5 s, half the wait. A winner that dies leaves the pipe free and is noticed at once, so the loser never waits out a dead winner.

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
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
  // A POSIX socket leaves a file behind. A Windows named pipe is not a file: removing its path throws EINVAL, and a throwing after hook stops every hook registered after it, which left the winner's server open and kept the test process alive forever.
  t.after(() => {
    try { rmSync(endpoint, { force: true }) } catch { /* the pipe goes with its server */ }
  })
  return { root, identity, endpoint, stateDir, stateHome: path.join(root, "state") }
}

const accepting = (endpoint) => new Promise((resolve) => {
  const socket = net.createConnection(endpoint)
  const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 2000)
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true) })
  socket.once("error", () => { clearTimeout(timer); resolve(false) })
})

// Close a controller at the end of a test, waiting at most 10 s, so a controller that cannot close fails the hook instead of hanging it.
const closeBounded = (controller) => Promise.race([
  controller.close(),
  new Promise((_, reject) => setTimeout(() => reject(new Error("the controller did not close within 10 s")), 10_000).unref()),
])

// Wait until the endpoint accepts, for at most 10 s, so a controller that never binds fails the test instead of hanging it.
async function untilAccepting(endpoint) {
  const deadline = Date.now() + 10_000
  while (!(await accepting(endpoint))) {
    assert.ok(Date.now() < deadline, "the endpoint never started accepting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("with the bind first, the process start is read after the pipe is bound, and only by the controller that bound it", { timeout: 60_000 }, async (t) => {
  const { identity, endpoint, stateDir } = await fixture(t, "desk-bindfirst-")
  const reads = []
  const winner = await startReadinessController({
    identity, endpoint, stateDir, ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: true,
    ownProcessStart: async () => { reads.push(await accepting(endpoint)); return "win32:2026-10-08T00:00:00.000Z" },
  })
  t.after(() => closeBounded(winner))
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
  t.after(() => closeBounded(controller))
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
  t.after(() => closeBounded(controller))
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
  // The winner holds the pipe now and publishes its owner record 1.5 s later, longer than the old 20 tries of 25 ms.
  const starting = startReadinessController({
    identity: late.identity, endpoint: late.endpoint, stateDir: late.stateDir, ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: true,
    ownProcessStart: () => new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
  })
  t.after(async () => { try { await closeBounded(await starting) } catch { /* it never started */ } })
  await untilAccepting(late.endpoint)
  const client = await connectOrStartController({ root: late.root, stateHome: late.stateHome, ephemeral: true, startController: inUse, electionWaitMs: 10_000 })
  const winner = await starting
  try {
    assert.equal((await client.status()).state, "CONTROL_READY")
  } finally {
    await client.close()
    await closeBounded(winner)
  }

  const nobody = await fixture(t, "desk-election-nobody-")
  const started = Date.now()
  await assert.rejects(
    connectOrStartController({ root: nobody.root, stateHome: nobody.stateHome, ephemeral: true, startController: inUse, electionWaitMs: 30_000 }),
    /readiness controller election winner is gone/u,
  )
  assert.ok(Date.now() - started < 5000, `the dead winner was noticed after ${Date.now() - started} ms, not after the 30 s wait`)
})

test("a session that handshakes while the winner has bound the pipe but not published its owner record gets no controller, and joins once it is published", { timeout: 60_000 }, async (t) => {
  const { root, identity, endpoint, stateDir, stateHome } = await fixture(t, "desk-election-window-")
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const starting = startReadinessController({
    identity, endpoint, stateDir, ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: true,
    ownProcessStart: async () => { await gate; return null },
  })
  t.after(async () => { release(); try { await closeBounded(await starting) } catch { /* it never started */ } })
  await untilAccepting(endpoint)
  const inUse = () => { throw Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" }) }
  await assert.rejects(
    connectOrStartController({ root, stateHome, ephemeral: true, startController: inUse, electionWaitMs: 300 }),
    /readiness controller election did not converge|token|owner/u,
    "no half-started controller answers before the owner record is published",
  )
  release()
  const winner = await starting
  t.after(() => closeBounded(winner))
  const client = await connectOrStartController({ root, stateHome, ephemeral: true, startController: inUse, electionWaitMs: 300 })
  try {
    assert.equal((await client.status()).state, "CONTROL_READY")
  } finally {
    await client.close()
  }
})

test("a failing process start read still reports its own error when releasing the pipe fails too", { timeout: 60_000 }, async (t) => {
  const { identity, endpoint, stateDir } = await fixture(t, "desk-bindfirst-closefail-")
  await assert.rejects(startReadinessController({
    identity, endpoint, stateDir, ephemeral: true, exitRelease: quietExit(), bindBeforeProcessStart: true,
    // An owner record that cannot be parsed makes the release fail.
    ownProcessStart: async () => { writeFileSync(path.join(stateDir, "owner.json"), "{not json"); throw new Error("the read failed") },
  }), /the read failed/u)
})
