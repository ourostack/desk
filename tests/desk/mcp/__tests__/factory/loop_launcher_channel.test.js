// The worker's notice to its launcher, between two real processes: a launcher that is gone must never take the worker with it.
// A stand-in launcher starts a real worker with the same message channel `hooks/loop-start.cjs` opens; the test stops the launcher
// by its exact process id, then lets the worker send its notice through the real `notifyLauncher`. Every process this test starts
// is stopped by its own id, never by name, and everything lives in a throwaway folder.

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

test("a worker whose launcher was stopped sends its notice and stays alive", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-launcher-channel-"))
  const file = (name) => path.join(dir, name)
  const worker = file("worker.mjs")
  const launcher = file("launcher.cjs")
  // The worker waits for the go file and for its channel to close, sends the notice, and writes `alive` half a second later.
  await fs.writeFile(worker, `
    import { writeFileSync, existsSync } from "node:fs"
    import { notifyLauncher } from ${JSON.stringify(LOOP_WORKER)}
    const go = ${JSON.stringify(file("go"))}
    const started = Date.now()
    const tick = setInterval(() => {
      if (!existsSync(go) || (process.connected && Date.now() - started < ${LIMIT_MS})) return
      clearInterval(tick)
      writeFileSync(${JSON.stringify(file("connected"))}, String(process.connected))
      notifyLauncher({ desk_loop_extend_ms: 131000 })
      setTimeout(() => { writeFileSync(${JSON.stringify(file("alive"))}, "alive"); process.exit(0) }, 500)
    }, 10)
  `)
  // The stand-in launcher opens the same channel as hooks/loop-start.cjs and records the worker's id.
  await fs.writeFile(launcher, `
    const { spawn } = require("node:child_process")
    const { writeFileSync } = require("node:fs")
    const child = spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true })
    writeFileSync(${JSON.stringify(file("worker.pid"))}, String(child.pid))
    setInterval(() => {}, 1000)
  `)
  const parent = spawn(process.execPath, [launcher], { stdio: "ignore", windowsHide: true })
  let workerPid = null
  try {
    workerPid = Number(await until(() => readOrNull(file("worker.pid")), "the stand-in launcher never started the worker"))
    const gone = new Promise((resolve) => parent.once("exit", resolve))
    process.kill(parent.pid)
    await gone
    await fs.writeFile(file("go"), "go")
    assert.equal(await until(() => readOrNull(file("alive")), "the worker died after its notice to a launcher that is gone"), "alive")
    assert.equal(await readOrNull(file("connected")), "false", "the notice went to a closed channel")
    await until(() => !processAlive(workerPid), "the worker did not end by itself")
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) process.kill(parent.pid)
    if (workerPid !== null && processAlive(workerPid)) process.kill(workerPid)
    rmSync(dir, { recursive: true, force: true })
  }
})
