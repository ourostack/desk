// The worker's notice to its launcher, between real processes: the message channel must never change what happens to a worker whose
// launcher is gone. A stand-in launcher starts a real worker twice: once with ignored stdio, as before the channel existed, and once with
// the channel `hooks/loop-start.cjs` now opens. The test stops the launcher by its exact process id. A worker that outlives its launcher
// without the channel must outlive it with the channel too, and must then send its notice through the real `notifyLauncher` and stay
// alive. On macOS and Linux a child outlives its parent, so the whole path is proven there. On Windows, Node puts a child it starts into
// a job object that ends the child with its parent, with or without a channel, so the comparison is what holds there. Every process
// this test starts is stopped by its own id, never by name, and everything lives in a throwaway folder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import "../_isolated_env.mjs"
import { processAlive } from "../../../../../plugins/desk/mcp/src/factory/process-lock.js"

const LOOP_WORKER = pathToFileURL(path.resolve(import.meta.dirname, "../../../../../plugins/desk/mcp/src/factory/loop-worker.js")).href
const LIMIT_MS = 20000
// How long after its launcher is stopped a worker that is still there counts as having outlived it.
const SETTLE_MS = 2000

async function until(check, failure) {
  const deadline = Date.now() + LIMIT_MS
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(failure)
}

const readOrNull = async (file) => fs.readFile(file, "utf8").catch(() => null)

// Starts a stand-in launcher whose worker has `stdio`, stops the launcher by its id, and reports whether the worker outlived it. A worker
// that did is then let go: it waits for its channel (if any) to close, sends the notice, and writes `alive` half a second later.
async function launcherStopped(stdio) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-launcher-channel-"))
  const file = (name) => path.join(dir, name)
  const worker = file("worker.mjs")
  const launcher = file("launcher.cjs")
  await fs.writeFile(worker, `
    import { writeFileSync, existsSync } from "node:fs"
    import { notifyLauncher } from ${JSON.stringify(LOOP_WORKER)}
    const channel = typeof process.send === "function"
    const tick = setInterval(() => {
      if (channel && !process.connected && !existsSync(${JSON.stringify(file("closed"))})) writeFileSync(${JSON.stringify(file("closed"))}, "closed")
      if (!existsSync(${JSON.stringify(file("go"))})) return
      clearInterval(tick)
      writeFileSync(${JSON.stringify(file("connected"))}, String(channel && process.connected))
      notifyLauncher({ desk_loop_extend_ms: 131000 })
      setTimeout(() => { writeFileSync(${JSON.stringify(file("alive"))}, "alive"); process.exit(0) }, 500)
    }, 10)
  `)
  await fs.writeFile(launcher, `
    const { spawn } = require("node:child_process")
    const { writeFileSync } = require("node:fs")
    const child = spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: ${JSON.stringify(stdio)}, windowsHide: true })
    writeFileSync(${JSON.stringify(file("worker.pid"))}, String(child.pid))
    setInterval(() => {}, 1000)
  `)
  const parent = spawn(process.execPath, [launcher], { stdio: "ignore", windowsHide: true })
  let workerPid = null
  try {
    workerPid = Number(await until(() => readOrNull(file("worker.pid")), "the stand-in launcher never started the worker"))
    await until(() => processAlive(workerPid), "the worker never started")
    const gone = new Promise((resolve) => parent.once("exit", resolve))
    process.kill(parent.pid)
    await gone
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    const outlived = processAlive(workerPid)
    if (!outlived) return { outlived }
    const channel = Array.isArray(stdio) && stdio.includes("ipc")
    if (channel) await until(() => readOrNull(file("closed")), "the worker never saw its channel close")
    await fs.writeFile(file("go"), "go")
    const alive = await until(() => readOrNull(file("alive")), "the worker died after its notice to a launcher that is gone")
    await until(() => !processAlive(workerPid), "the worker did not end by itself")
    return { outlived, alive, connected: await readOrNull(file("connected")) }
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) process.kill(parent.pid)
    if (workerPid !== null && processAlive(workerPid)) process.kill(workerPid)
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a worker whose launcher was stopped fares exactly as it did before the channel, and one that outlives it sends its notice and stays alive", async (t) => {
  const before = await launcherStopped("ignore")
  const now = await launcherStopped(["ignore", "ignore", "ignore", "ipc"])
  t.diagnostic(`platform ${process.platform}: without the channel the worker outlived its launcher: ${before.outlived}; with it: ${now.outlived}`)
  assert.equal(now.outlived, before.outlived, "the channel changes nothing about whether a worker outlives its launcher")
  // libuv puts every child spawned without `detached` into a job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE on Windows (src/win/process.c,
  // `uv__init_global_job_handle`), so there the worker ends with its launcher; elsewhere it outlives it and the notice path below runs.
  assert.equal(before.outlived, process.platform !== "win32", "a worker outlives its stopped launcher everywhere but Windows, before the channel as now")
  if (now.outlived) {
    assert.equal(now.connected, "false", "the notice went to a closed channel")
    assert.equal(now.alive, "alive")
  }
})
