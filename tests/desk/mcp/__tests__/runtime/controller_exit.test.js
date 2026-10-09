import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { assertProcessesGone, controllerPids, processAlive, waitForProcessesGone } from "./_controller_exit.js"

const record = (root, name, body) => {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(path.join(root, name, "owner.json"), typeof body === "string" ? body : JSON.stringify(body))
}

test("controllerPids names only the controller children whose owner record is readable", async (t) => {
  // Not an owned temp root: the teardown waits for every controller PID under an owned root, and these records name made-up PIDs.
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "desk-controller-exit-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  record(root, "a", { owner: { kind: "controller_child", pid: 111 } })
  record(root, "b", { owner: { kind: "controller_child", pid: 111 } })
  record(root, "c", { owner: { kind: "mcp_session", pid: 222 } })
  record(root, "d", { owner: { kind: "controller_child", pid: "333" } })
  record(root, "e", "{ half written")
  record(root, "f", {})
  record(path.join(root, "node_modules"), "skipped", { owner: { kind: "controller_child", pid: 444 } })
  record(path.join(root, "1", "2", "3"), "deep", { owner: { kind: "controller_child", pid: 555 } })
  assert.deepEqual(controllerPids([root, path.join(root, "absent")]).sort(), [111, 555])
  assert.deepEqual(controllerPids([root], { depth: 2 }), [111], "the search stops at its depth limit")
  assert.deepEqual(controllerPids([path.join(root, "a", "owner.json")]), [], "a file is not a directory to search")
  const unreadable = Object.assign(new Error("denied"), { code: "EACCES" })
  assert.throws(() => controllerPids([root], { list: () => { throw unreadable } }), unreadable)
  assert.throws(() => controllerPids([root], { read: () => { throw unreadable } }), unreadable)
  assert.deepEqual(controllerPids([root], { read: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }) } }), [])
})

test("processAlive tells a live process from a gone one and from one owned by someone else", () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(1, () => { throw Object.assign(new Error("not yours"), { code: "EPERM" }) }), true)
  assert.equal(processAlive(1, () => { throw Object.assign(new Error("none"), { code: "ESRCH" }) }), false)
  const odd = Object.assign(new Error("odd"), { code: "EINVAL" })
  assert.throws(() => processAlive(1, () => { throw odd }), odd)
})

test("waiting for processes to be gone resolves when they end and names the survivor when they do not", async () => {
  const alive = new Set([10, 11])
  const waits = []
  await waitForProcessesGone([10, 11], { alive: (pid) => alive.has(pid), wait: async (ms) => { waits.push(ms); alive.delete(10); if (waits.length > 1) alive.delete(11) } })
  assert.equal(waits.length, 2)
  let clock = 0
  await assert.rejects(
    () => waitForProcessesGone([12], { timeoutMs: 100, intervalMs: 40, alive: () => true, wait: async (ms) => { clock += ms }, now: () => clock }),
    /controller process 12 is still running 100 ms after its session ended/,
  )
  await waitForProcessesGone([])
})

test("a process that is still alive fails the check made before a delete, and passes once it has exited", async () => {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  const exited = new Promise((resolve) => holder.once("exit", resolve))
  try {
    assert.throws(() => assertProcessesGone([holder.pid]), /process \d+ is still running/)
    await assert.rejects(() => waitForProcessesGone([holder.pid], { timeoutMs: 100 }), /still running 100 ms/)
  } finally {
    holder.kill()
    await exited
  }
  await waitForProcessesGone([holder.pid])
  assertProcessesGone([holder.pid])
})
