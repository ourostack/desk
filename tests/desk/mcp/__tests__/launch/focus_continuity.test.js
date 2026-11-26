// A focus declared with task_focus survives the idle proxy ending and restarting the real server child.
//
// This drives the real bootstrap.cjs (its idle proxy and its index.js child) over stdio against a synthetic git desk. It proves the mechanism with a short idle time, not the original #1811 incident or any live host.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { git, makeGitDesk, startDesk, settled } from "../runtime/_admission_fixtures.js"

const preload = fileURLToPath(new URL("./focus_continuity_preload.cjs", import.meta.url))
const NO_FOCUS = "no task in focus"
const IDLE_MS = 1200

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    if (error.code === "EPERM") return true
    throw error
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, what, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

async function open(extraEnv = {}) {
  const fixture = await makeGitDesk("desk-focus-continuity-")
  const log = path.join(fixture.root, "processes.jsonl")
  writeFileSync(log, "")
  const session = await startDesk(fixture, {
    entry: "bootstrap",
    args: ["--root", fixture.desk],
    env: { DESK_MCP_IDLE_MS: String(IDLE_MS), NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, DESK_TEST_PROCESS_LOG: log, ...extraEnv },
  })
  const processes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const servers = () => processes().filter((entry) => String(entry.argv1).endsWith("index.js"))
  await session.statusUntil(settled)
  const note = (result) => JSON.stringify(result.payload).includes("focused on") ? "focused" : JSON.stringify(result.payload).includes(NO_FOCUS) ? "none" : "silent"
  return { fixture, session, servers, processes, note }
}

// A call that changes nothing, used to bring the next child up before the probe.
const resume = (session) => session.request("tools/list")

async function idleRestart(h) {
  const before = h.servers()
  const pid = before[before.length - 1].pid
  await waitFor(() => !alive(pid), "the idle child to end")
  await resume(h.session)
  const after = await waitFor(() => (h.servers().length > before.length ? h.servers() : null), "a new child")
  assert.notEqual(after[after.length - 1].pid, pid)
  return after[after.length - 1]
}

const harbor = { track: "ops", slug: "harbor-lights" }
const update = (session, task = harbor) => session.call("task_update", { ...task, status: "paused" })

// The product files and card bytes, by hash, so a failure names the file and not 30 MB of model weights. The search index's SQLite files and the downloaded embedding model are runtime cache that a server may touch at any time, so they alone are left out.
const RUNTIME_CACHE = [/^\.state\/desk-vectors\.sqlite(?:-shm|-wal|-journal)?$/u, /^\.state\/embedding-model(?:\/|$)/u]

function snapshotDesk(fixture) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue
      const full = path.join(dir, entry.name)
      const relative = path.relative(fixture.desk, full).split(path.sep).join("/")
      if (RUNTIME_CACHE.some((pattern) => pattern.test(relative))) continue
      if (entry.isDirectory()) walk(full)
      else files.push([relative, createHash("sha256").update(readFileSync(full)).digest("hex")])
    }
  }
  walk(fixture.desk)
  files.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return { files, head: git(fixture.desk, "rev-parse", "HEAD"), porcelain: git(fixture.desk, "status", "--porcelain") }
}

test("a task_focus survives an idle restart: the resume writes nothing and task_update carries no no-focus note", async (t) => {
  const h = await open()
  t.after(() => h.session.close())
  const focused = await h.session.call("task_focus", { action: "focus", ...harbor })
  assert.equal(focused.isError, false, JSON.stringify(focused.payload))
  const first = h.servers()[0]
  const toolsBefore = JSON.stringify((await h.session.request("tools/list")).result)
  // Captured before the lifecycle transition, so the whole resume and restore is bracketed.
  const before = snapshotDesk(h.fixture)
  const second = await idleRestart(h)
  assert.ok(String(second.argv1).endsWith("index.js"))
  // tools/list is answered only after the restore ended; nothing may have been written by then.
  assert.equal(JSON.stringify((await h.session.request("tools/list")).result), toolsBefore)
  assert.deepEqual(snapshotDesk(h.fixture), before)
  const result = await update(h.session)
  assert.equal(result.isError, false, JSON.stringify(result.payload))
  assert.equal(h.note(result), "silent", JSON.stringify(result.payload))
  assert.match(h.session.stderr(), /focus handoff restored/u)
  assert.notEqual(first.pid, second.pid)
})

test("an explicit clear stays a declaration across a restart: no no-focus note", async (t) => {
  const h = await open()
  t.after(() => h.session.close())
  await h.session.call("task_focus", { action: "focus", ...harbor })
  await h.session.call("task_focus", { action: "clear" })
  await idleRestart(h)
  assert.equal(h.note(await update(h.session)), "silent")
  assert.match(h.session.stderr(), /focus handoff restored/u)
})

test("a card that moved while the server was idle is reported, not silently dropped", async (t) => {
  const h = await open()
  t.after(() => h.session.close())
  await h.session.call("task_focus", { action: "focus", ...harbor })
  const pid = h.servers()[0].pid
  await waitFor(() => !alive(pid), "the idle child to end")
  renameSync(path.join(h.fixture.desk, "ops", "harbor-lights"), path.join(h.fixture.desk, "ops", "harbor-moved"))
  await resume(h.session)
  await waitFor(() => h.session.stderr().includes("focus handoff card_missing"), "the missing card to be classified", 8000)
  const result = await update(h.session, { track: "ops", slug: "harbor-moved" })
  assert.doesNotMatch(JSON.stringify(result.payload), /focused on ops\/harbor-lights/u)
})

test("with the idle proxy off there is no handoff channel", async (t) => {
  const h = await open({ DESK_MCP_IDLE_MS: "0" })
  t.after(() => h.session.close())
  const log = h.processes().filter((entry) => String(entry.argv1).endsWith("index.js"))
  assert.ok(log.every((entry) => entry.ipc === false))
})
