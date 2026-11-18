// The idle memory budget: a Desk MCP server that nobody has spoken to for a while holds under 100 MB (it was about 460 MB per hosted
// session on the Mac mini, 15 GB for 33 of them). The host's process stays, the server behind it leaves, and the next call brings it
// back with the answer unchanged.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { bootstrapPath, isolatedEnv, makeIsolatedHome } from "../launch/_mcp_handshake.js"

const IDLE_MS = 1500
const IDLE_BUDGET_MB = 100
const HOT_CALL_BUDGET_MS = 1500
const TASKS = 300

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function syntheticDesk(desk) {
  const git = (...args) => spawnSync("git", ["-C", desk, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  for (let task = 0; task < TASKS; task += 1) {
    const folder = path.join(desk, "tasks", `t${String(task).padStart(3, "0")}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, "README.md"), `# Task ${task}\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20)}\n`)
  }
  git("add", "-A")
  git("commit", "-q", "-m", "synthetic desk")
}

function rssMb(pid) {
  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()
  return Number(out) / 1024
}

function memoryDetail(pid) {
  try {
    return readFileSync(`/proc/${pid}/status`, "utf8").split("\n").filter((line) => /^(VmRSS|RssAnon|RssFile|Threads)/u.test(line)).join(" ").replace(/\s+/gu, " ")
  } catch {
    return ""
  }
}

function childPids(pid) {
  return spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)
}

test("an idle Desk MCP server holds under 100 MB: its server process is released after the idle time and the next call brings it back", { skip: process.platform === "win32", timeout: 120000 }, async () => {
  const fixture = await makeIsolatedHome("desk-idle-memory-")
  syntheticDesk(fixture.desk)
  const proxy = spawn(process.execPath, [bootstrapPath, "--root", fixture.desk], {
    env: isolatedEnv(fixture, { DESK_MCP_IDLE_MS: String(IDLE_MS) }),
    stdio: ["pipe", "pipe", "pipe"],
  })
  const waiting = new Map()
  let buffered = ""
  let stderr = ""
  proxy.stderr.on("data", (chunk) => { stderr += chunk })
  proxy.stdout.on("data", (chunk) => {
    buffered += chunk
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      try { const message = JSON.parse(line); waiting.get(message.id)?.(message) } catch { /* not a message */ }
    }
  })
  let nextId = 1
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr:\n${stderr}`)), 60000)
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message) })
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
  const status = () => request("tools/call", { name: "desk_status", arguments: {} })

  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "budget", version: "1" } })
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    const first = await status()
    assert.ok(first.result, `the first call answers: ${JSON.stringify(first)}`)
    assert.equal(childPids(proxy.pid).length, 1, "the server runs while it is in use")

    for (let waited = 0; childPids(proxy.pid).length > 0 && waited < 30000; waited += 250) await sleep(250)
    assert.equal(childPids(proxy.pid).length, 0, "the server is released after the idle time")
    const idleMb = rssMb(proxy.pid)
    assert.ok(idleMb < IDLE_BUDGET_MB, `an idle session holds ${idleMb.toFixed(1)} MB, budget ${IDLE_BUDGET_MB} MB (${memoryDetail(proxy.pid)}; node ${process.version})`)

    const resumed = await status()
    assert.deepEqual(Object.keys(resumed.result).sort(), Object.keys(first.result).sort(), "the call after the release gets the same kind of answer")
    const started = Date.now()
    await status()
    const hotMs = Date.now() - started
    assert.ok(hotMs < HOT_CALL_BUDGET_MS, `a call on a running server took ${hotMs} ms, budget ${HOT_CALL_BUDGET_MS} ms`)
  } finally {
    const closed = new Promise((resolve) => proxy.once("exit", resolve))
    proxy.stdin.end()
    const killer = setTimeout(() => proxy.kill("SIGKILL"), 10000)
    await closed
    clearTimeout(killer)
  }
})
