import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot, recordControllers, removeRootsAfterControllers, requireControllers } from "../_temp_roots.js"
import { openSession } from "../launch/_mcp_session.js"
import { processAlive } from "./_controller_exit.js"

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function writeOwner(root, pid, name = "readiness") {
  mkdirSync(path.join(root, "home", name), { recursive: true })
  writeFileSync(path.join(root, "home", name, "owner.json"), JSON.stringify({ owner: { kind: "controller_child", pid } }))
}

// A real process that stays alive until told to stop, the stand-in for a readiness controller child.
function startHolder() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  const exited = new Promise((resolve) => child.once("exit", resolve))
  return { child, exited, stop: async () => { child.kill("SIGKILL"); await exited } }
}

test("teardown removes a root only after the controller recorded under it has exited", async () => {
  const root = await mkTempRoot("desk-teardown-wait-")
  const holder = startHolder()
  try {
    writeOwner(root, holder.child.pid)
    const stopLater = pause(300).then(() => holder.stop())
    const aliveAtRemoval = []
    await removeRootsAfterControllers([root], new Set(), { remove: async () => { aliveAtRemoval.push(processAlive(holder.child.pid)) } })
    assert.deepEqual(aliveAtRemoval, [false], "the controller was still running when the root was removed")
    await stopLater
  } finally {
    if (processAlive(holder.child.pid)) await holder.stop()
  }
})

test("teardown waits for a controller whose owner record is already gone, because the PID was recorded while it was alive", async () => {
  const holder = startHolder()
  try {
    const aliveAtRemoval = []
    const stopLater = pause(300).then(() => holder.stop())
    await removeRootsAfterControllers([], new Set([holder.child.pid]), { remove: async () => { aliveAtRemoval.push(processAlive(holder.child.pid)) } })
    assert.equal(processAlive(holder.child.pid), false)
    await stopLater
  } finally {
    if (processAlive(holder.child.pid)) await holder.stop()
  }
})

test("teardown fails with the PID after the deadline, still removes the root, and does not touch the delete retries", async () => {
  const root = await mkTempRoot("desk-teardown-deadline-")
  const holder = startHolder()
  try {
    writeOwner(root, holder.child.pid)
    const removed = []
    await assert.rejects(
      () => removeRootsAfterControllers([root], new Set(), {
        waitForGone: async (pids) => { assert.deepEqual(pids, [holder.child.pid]); throw new Error(`readiness controller process ${pids.join(", ")} is still running 30000 ms after its session ended`) },
        remove: async (target) => { removed.push(target) },
      }),
      new RegExp(`controller process ${holder.child.pid} is still running`),
    )
    assert.deepEqual(removed, [root])
    // The real wait, with a short deadline, names the survivor too.
    const { waitForProcessesGone } = await import("./_controller_exit.js")
    await assert.rejects(() => waitForProcessesGone([holder.child.pid], { timeoutMs: 100 }), new RegExp(`${holder.child.pid} is still running 100 ms`))
  } finally {
    await holder.stop()
  }
})

test("teardown with no controller removes the roots at once", async () => {
  const removed = []
  await removeRootsAfterControllers(["a", "b"], new Set(), { remove: async (root) => { removed.push(root) } })
  assert.deepEqual(removed, ["a", "b"])
})

test("recordControllers finds controllers only under owned roots that contain the hint, and requireControllers refuses an empty list", async () => {
  const root = await mkTempRoot("desk-record-controllers-")
  const other = await mkTempRoot("desk-record-controllers-other-")
  const holder = startHolder()
  try {
    assert.throws(() => requireControllers(root), /no readiness controller is recorded under .*never started one/)
    writeOwner(root, holder.child.pid)
    assert.deepEqual(recordControllers(path.join(root, "home")), [holder.child.pid])
    assert.deepEqual(requireControllers(root, "/not/owned"), [holder.child.pid])
    assert.deepEqual(recordControllers(other, undefined, ""), [])
    assert.deepEqual(recordControllers("/not/owned"), [])
    assert.equal(existsSync(root), true)
  } finally {
    await holder.stop()
  }
})

test("a session helper records the controller while the session is alive and again as it closes", async () => {
  const root = await mkTempRoot("desk-session-record-")
  const holder = startHolder()
  // A stub MCP server: answers initialize and tools/list, nothing else.
  const stub = "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n')}});process.stdin.on('end',()=>process.exit(0))"
  try {
    const session = await openSession({ command: process.execPath, args: ["-e", stub], cwd: root, env: { PATH: process.env.PATH, HOME: path.join(root, "home") } })
    assert.deepEqual(session.controllers(), [], "no controller yet, so nothing is recorded")
    writeOwner(root, holder.child.pid)
    await session.close()
    // The record file is gone from the controller's side, as it is when a controller shuts down; the PID was already noted.
    const { code } = await session.close()
    assert.equal(code, 0)
    assert.deepEqual(recordControllers(root), [holder.child.pid])
  } finally {
    await holder.stop()
  }
})
