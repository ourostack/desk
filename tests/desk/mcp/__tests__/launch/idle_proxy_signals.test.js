// A real Desk MCP process that has gone idle ends on SIGINT, SIGTERM and SIGHUP with that signal, instead of re-raising it at itself in a loop (#1728).
//
// Every subject runs in its own process group with a deadline set by this process, which is not the subject, so a spinning subject cannot hold the test up. Cleanup kills the group and reads ESRCH back: anything else, an unreadable group included, is a failure that keeps the fixture folder.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import * as path from "node:path"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { removeTree } from "../_remove_tree.js"
import { bootstrapPath, isolatedEnv } from "./_mcp_handshake.js"

const IDLE_MS = 400
const DEADLINE_MS = 150000
const SIGNAL_DEADLINE_MS = 30000

// ESRCH is the only proof a group is gone. EPERM is also what macOS answers while a killed member is not yet reaped, so it is retried until the deadline and then reported, never taken as absence.
async function reapGroup(pid, exited) {
  const end = Date.now() + 30000
  let last = "no answer"
  while (Date.now() < end) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if (error.code === "ESRCH") return
      last = String(error.code ?? error)
    }
    await Promise.race([exited, sleep(100)])
    await sleep(50)
  }
  throw new Error(`process group ${pid} not proven gone (last answer ${last})`)
}

// pgrep exits 1 for "no children"; any other failure is not an answer.
function hasChildren(pid) {
  const result = spawnSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`pgrep -P ${pid} failed: status ${result.status} ${result.error ?? result.stderr}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function idleThenSignal(signal) {
  // Not a shared temp root: the folder is removed only once its processes are proven gone.
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "desk-idle-signal-"))
  const fixture = { root, home: path.join(root, "home"), desk: path.join(root, "desk"), cache: path.join(root, "cache"), runtimeCache: path.join(root, "runtime-cache") }
  for (const dir of [fixture.home, fixture.desk, fixture.cache, fixture.runtimeCache]) mkdirSync(dir, { recursive: true })
  const env = isolatedEnv(fixture, { DESK_MCP_IDLE_MS: String(IDLE_MS) })
  const child = spawn(process.execPath, [bootstrapPath, "--root", fixture.desk], { env, cwd: fixture.root, stdio: ["pipe", "pipe", "pipe"], detached: true })
  const exited = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, signal: sig })))
  let stdout = ""
  let stderr = ""
  const askedOfClient = new Set()
  child.stdout.on("data", (chunk) => {
    stdout += chunk
    // A server's own request to its client (such as roots/list) keeps the proxy busy until answered, so this client answers each one.
    for (const line of stdout.split("\n")) {
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.method !== undefined && message.id !== undefined && !askedOfClient.has(message.id)) {
        askedOfClient.add(message.id)
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { roots: [] } })}\n`)
      }
    }
  })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const send = (id, method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  const answered = async (id) => {
    const end = Date.now() + DEADLINE_MS
    while (Date.now() < end) {
      if (stdout.split("\n").some((line) => line.includes(`"id":${id},`))) return true
      await sleep(25)
    }
    return false
  }
  const idle = async (pid) => {
    const end = Date.now() + DEADLINE_MS
    while (hasChildren(pid)) {
      assert.ok(Date.now() < end, `the server never went idle; group:\n${spawnSync("/bin/ps", ["-o", "pid,ppid,etime,command", "-g", String(pid)], { encoding: "utf8" }).stdout}\nstdout:\n${stdout.slice(-1500)}\nstderr:\n${stderr}`)
      await sleep(50)
    }
  }
  let outcome
  let failure
  try {
    send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "idle-signal-test", version: "0" } })
    assert.equal(await answered(1), true, `initialize unanswered; stderr:\n${stderr}`)
    // Idle, the server has ended; the next call proves the proxy is healthy by starting one again, and it must go idle again before the signal.
    await idle(child.pid)
    send(2, "tools/list")
    assert.equal(await answered(2), true, `tools/list unanswered after idle; stderr:\n${stderr}`)
    await idle(child.pid)
    process.kill(child.pid, signal)
    outcome = await Promise.race([exited, sleep(SIGNAL_DEADLINE_MS).then(() => "still running")])
  } catch (error) {
    failure = error
  }
  try {
    await reapGroup(child.pid, exited)
  } catch (error) {
    // Processes may remain: the fixture folder stays for them and the failure is explicit.
    throw new Error(`cleanup failed, ${fixture.root} kept: ${error.message}${failure ? `\nafter: ${failure.message}` : ""}`)
  }
  await removeTree(root)
  if (failure) throw failure
  return outcome
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`an idle Desk MCP process ends on ${signal} with that signal`, { skip: process.platform === "win32", timeout: 600000 }, async () => {
    assert.deepEqual(await idleThenSignal(signal), { code: null, signal })
  })
}
