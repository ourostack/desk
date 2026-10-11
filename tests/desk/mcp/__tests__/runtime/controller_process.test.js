import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { randomUUID, createHash } from "node:crypto"
import * as net from "node:net"
import * as path from "node:path"
import { openDb, closeDb, indexDbPath } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { makeGitDesk, startDesk, writeActivation, writeFile } from "./_admission_fixtures.js"
import { requireControllers } from "../_temp_roots.js"
import { assertProcessesGone, controllerPids, processAlive, waitForProcessesGone } from "./_controller_exit.js"

const require = createRequire(import.meta.url)
const posixOnly = process.platform === "win32" ? "POSIX signal semantics" : false
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function matchHeld(ack, arm, binding) {
  if (!binding || !ack || ack.method !== "beginConvergence" ||
      typeof binding.rpcId !== "string" || ack.rpcId !== binding.rpcId ||
      !Number.isInteger(ack.bytes) || ack.bytes <= 0 ||
      ["nonce", "ownerPid", "ownerGeneration", "sessionPid", "cycle", "mcpId", "document"].some(key =>
        ack[key] !== arm[key] || binding[key] !== arm[key])) {
    throw new Error("invalid held-work correlation")
  }
  return ack
}

function waitForHeld(held, result) {
  return Promise.race([held, result.then(value => {
    throw new Error(`target reindex settled before held work: ${JSON.stringify(value)}`)
  })])
}

async function drainController(session) {
  const result = await session.call("desk_reindex", { force: true })
  assert.equal(result.isError, false, JSON.stringify(result.payload))
  assert.equal(result.payload.status, "ok", JSON.stringify(result.payload))
  assert.equal(result.payload.action, "controller_convergence", JSON.stringify(result.payload))
  return result
}

test("controller drain rejects actual failure and incomplete acknowledgment shapes", async () => {
  for (const result of [
    { isError: true, payload: { message: "actual compaction failure" } },
    { isError: false, payload: { status: "pending", action: "controller_convergence" } },
    { isError: false, payload: { status: "ok", action: "not_convergence" } },
  ]) {
    await assert.rejects(drainController({ call: async () => result }))
  }
  const result = { isError: false, payload: { status: "ok", action: "controller_convergence" } }
  assert.equal(await drainController({ call: async () => result }), result)
  await assert.rejects(drainController({ call: async () => { throw new Error("actual drain rejection") } }),
    /actual drain rejection/u)
})

// Generated only in the selected fixture. No product held hook or fake index:
// the controller must enter its actual target-request async chain, finish an
// actual Markdown read, then withhold that read's resolution until kill.
async function rendezvousPreload(armFile, bindingFile) {
  const { default: fs } = await import("node:fs")
  const { default: net } = await import("node:net")
  const { AsyncLocalStorage } = await import("node:async_hooks")
  const { syncBuiltinESMExports } = await import("node:module")
  const entry = process.argv[1] ?? ""
  const controller = entry.endsWith("/readiness/controller-child.js")
  const parent = entry.endsWith("/mcp/index.js")
  if (!controller && !parent) return
  const local = new AsyncLocalStorage()
  const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null } }
  const frame = chunk => {
    try { return JSON.parse(String(chunk).trim()) } catch { return null }
  }
  if (parent) {
    const emit = process.stdin.emit
    process.stdin.emit = function (event, ...args) {
      const message = event === "data" ? frame(args[0]) : null
      if (message?.method === "tools/call" && message.params?.name === "desk_reindex") {
        const arm = read(armFile)
        if (arm?.mcpId === message.id && arm.sessionPid === process.pid) {
          return local.run({ mcpId: message.id }, () => emit.call(this, event, ...args))
        }
      }
      return emit.call(this, event, ...args)
    }
    const write = net.Socket.prototype.write
    net.Socket.prototype.write = function (chunk, ...args) {
      const message = frame(chunk), arm = read(armFile), context = local.getStore()
      if (message?.method === "beginConvergence" && arm && context && arm.mcpId === context.mcpId &&
          arm.sessionPid === process.pid) {
        fs.writeFileSync(bindingFile, JSON.stringify({ ...arm, rpcId: message.id }), { mode: 0o600 })
      }
      return write.call(this, chunk, ...args)
    }
  } else {
    const emit = net.Socket.prototype.emit
    net.Socket.prototype.emit = function (event, ...args) {
      const message = event === "data" ? frame(args[0]) : null
      if (message?.method === "beginConvergence") {
        return local.run({ rpcId: message.id, method: message.method }, () => emit.call(this, event, ...args))
      }
      return emit.call(this, event, ...args)
    }
    const realRead = fs.promises.readFile
    fs.promises.readFile = async function (file, ...args) {
      const bytes = await realRead.call(this, file, ...args)
      const arm = read(armFile), binding = read(bindingFile), context = local.getStore()
      if (!arm || arm.ownerPid !== process.pid || String(file) !== arm.document ||
          binding?.nonce !== arm.nonce || binding?.rpcId !== context?.rpcId ||
          context?.method !== "beginConvergence" || binding?.mcpId !== arm.mcpId) return bytes
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: arm.port })
        socket.once("connect", () => socket.write(JSON.stringify({ ...binding,
          ownerPid: process.pid, method: context.method, bytes: Buffer.byteLength(bytes) }) + "\n"))
        socket.once("data", data => {
          if (String(data).trim() !== "release") reject(new Error("invalid fixture release"))
          else resolve()
          socket.end()
        })
        socket.once("error", reject)
        socket.once("close", () => reject(new Error("fixture held-work channel closed")))
      })
      return bytes
    }
    syncBuiltinESMExports()
  }
}

async function controllerRendezvous(t, fixture) {
  const armFile = path.join(fixture.root, "kill-arm.json"), bindingFile = path.join(fixture.root, "kill-binding.json")
  const preload = path.join(fixture.root, "kill-preload.mjs")
  // The preserved coverage preload resolves its Babel plugins from cwd.
  // Reuse the maintained installed dependencies in this isolated cwd, rather
  // than stripping instrumentation or installing a second dependency set.
  symlinkSync(path.resolve(path.dirname(require.resolve("@istanbuljs/esm-loader-hook")), "../.."),
    path.join(fixture.root, "node_modules"), "dir")
  writeFile(preload, `await (${rendezvousPreload.toString()})(${JSON.stringify(armFile)},${JSON.stringify(bindingFile)});\n`)
  let arm = null, accept, reject, connection = null
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket))
    socket.on("error", error => reject(error))
    let input = ""
    socket.on("data", chunk => {
      input += chunk
      if (!input.includes("\n")) return
      try {
        const ack = JSON.parse(input.trim())
        matchHeld(ack, arm, JSON.parse(readFileSync(bindingFile, "utf8")))
        if (connection) throw new Error("duplicate held-work connection")
        connection = socket; accept(ack)
      } catch (error) { reject(error); socket.destroy() }
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const disarm = ({ killed = false } = {}) => {
    rmSync(armFile, { force: true }); rmSync(bindingFile, { force: true })
    for (const socket of sockets) {
      if (killed) socket.destroy()
      else socket.end("release\n")
    }
    connection = null; arm = null
  }
  t.after(async () => {
    disarm()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return {
    env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${JSON.stringify(preload)}`].filter(Boolean).join(" "),
      ...Object.fromEntries(["NYC_CONFIG", "NYC_CWD"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) },
    arm(session, owner, cycle) {
      let completed = false
      const held = new Promise((resolve, fail) => { accept = resolve; reject = fail })
      arm = { nonce: randomUUID(), cycle, ownerPid: owner.pid,
        ownerGeneration: createHash("sha256").update(owner.token).digest("hex"),
        sessionPid: session.child.pid, port: server.address().port,
        document: path.join(fixture.desk, "_meta", "tips", "entry-0.md") }
      const write = session.child.stdin.write
      session.child.stdin.write = function (chunk, ...args) {
        const message = JSON.parse(String(chunk))
        if (message.method === "tools/call" && message.params.name === "desk_reindex") {
          arm.mcpId = message.id
          writeFile(armFile, JSON.stringify(arm))
        }
        return write.call(this, chunk, ...args)
      }
      let result
      try { result = session.call("desk_reindex", { force: true }).finally(() => { completed = true }) }
      finally { session.child.stdin.write = write }
      let budget
      const deadline = new Promise((_resolve, fail) => { budget = setTimeout(() => fail(new Error("target held-work acknowledgment deadline")), 20000) })
      return { result, completed: () => completed,
        held: waitForHeld(Promise.race([held, deadline]), result).finally(() => clearTimeout(budget)),
        verify: ack => {
          assert.equal(connection?.destroyed, false, "the matched read is still held")
          return matchHeld(ack, arm, JSON.parse(readFileSync(bindingFile, "utf8")))
        } }
    },
    disarm,
  }
}

test("controller rendezvous rejects wrong owner, background work and mismatched target IDs", () => {
  const arm = { nonce: "cycle", ownerPid: 8, ownerGeneration: "generation", cycle: 1, mcpId: 17, document: "/fixture/doc.md" }
  const binding = { ...arm, rpcId: "controller-request" }
  const ack = { ...binding, method: "beginConvergence", bytes: 12 }
  assert.equal(matchHeld(ack, arm, binding), ack)
  for (const changed of [{ ownerPid: 9 }, { rpcId: null }, { rpcId: "background" },
    { mcpId: 18 }, { ownerGeneration: "stale" }, { nonce: "old" }, { cycle: 0 }, { document: "/elsewhere" }, { method: "status" }]) {
    assert.throws(() => matchHeld({ ...ack, ...changed }, arm, binding), /invalid held-work correlation/u)
  }
})

test("controller rendezvous early settlement surfaces actual result and rejection", async () => {
  const held = new Promise(() => {})
  await assert.rejects(waitForHeld(held, Promise.resolve({ isError: true, payload: { message: "actual refusal" } })),
    /actual refusal/u)
  await assert.rejects(waitForHeld(held, Promise.reject(new Error("actual request rejection"))),
    /actual request rejection/u)
})

async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await pause(20)
  }
}

// The owner record as it is on disk right now, or null while a re-election has removed it or is still writing it (the controller writes owner.json in place, so a reader can see it missing or half-written).
function currentOwner(ownerFile) {
  try {
    return JSON.parse(readFileSync(ownerFile, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null
    throw error
  }
}

function ownerRecord(fixture) {
  const [directory] = readdirSync(fixture.readinessHome)
  const ownerFile = path.join(fixture.readinessHome, directory, "owner.json")
  return { ...JSON.parse(readFileSync(ownerFile, "utf8")), ownerFile }
}

// Every session of a fixture is closed together, then the fixture's controller child is waited for. The child outlives its sessions (it ends after its parent's channel drops), holds the derived index open, and Windows will not delete a file a process holds, so nothing may remove the fixture before the child is gone.
const sessionsByFixture = new Map()

export async function closeFixtureAndAwaitController(fixture, sessions) {
  const pids = controllerPids([fixture.readinessHome])
  await Promise.all(sessions.map((session) => session.close()))
  await waitForProcessesGone(pids)
  assertProcessesGone(pids)
}

async function readySession(t, fixture, options = {}) {
  const configPath = writeActivation(fixture)
  const session = await startDesk(fixture, { args: ["--activation-config", configPath], ...options })
  if (!sessionsByFixture.has(fixture)) {
    const sessions = []
    sessionsByFixture.set(fixture, sessions)
    t.after(() => closeFixtureAndAwaitController(fixture, sessions))
  }
  sessionsByFixture.get(fixture).push(session)
  await session.statusUntil((status) => status.state === "ready" && status.readiness?.detail.convergence.status === "succeeded", { deadlineMs: 90000 })
  // Convergence succeeded, so a controller must exist; an empty list would make the wait at teardown pass for nothing.
  requireControllers(fixture.root)
  return session
}

// makeGitDesk supplies two Markdown documents; this adds 5,998 so there are exactly 6,000.
function populate(fixture, directory = path.join(fixture.desk, "_meta", "tips")) {
  for (let index = 0; index < 5998; index += 1) {
    writeFile(path.join(directory, `entry-${index}.md`), `# Entry ${index}\n\nHarbor navigation reference ${index}. The lighthouse keeper records the crossing.\n`)
  }
}

// Windows refuses to delete a file another process still has open (EPERM, EBUSY or EACCES). After convergence reports done, a handle (a SQLite handle, a scanner such as antivirus or
// the search indexer, or a child reaped late) can still be open for a moment, so the delete is retried for a bounded time, then fails with its own error: a handle that is never released is a real fault.
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"])
export async function removeWithRetry(file, { remove = rmSync, wait = pause, attempts = 50, delayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return remove(file, { force: true })
    } catch (error) {
      if (!HELD_OPEN.has(error.code) || attempt >= attempts) throw error
      await wait(delayMs)
    }
  }
}

// POSIX only: a Windows run cannot delete the index while its controller child holds it open.
async function removeDerivedIndex(fixture) {
  // Convergence has finished. Force real indexing, not a warm hash-only scan.
  for (const suffix of ["", "-wal", "-shm"]) await removeWithRetry(`${indexDbPath(fixture.desk)}${suffix}`)
}

test("removing a file another process holds open is retried a bounded number of times, and any other failure or a lasting hold is surfaced", async () => {
  const held = (code) => Object.assign(new Error(code), { code })
  const calls = []
  const waits = []
  const flaky = (file) => { calls.push(file); if (calls.length < 4) throw held(["EPERM", "EBUSY", "EACCES"][calls.length - 1]) }
  await removeWithRetry("index", { remove: flaky, wait: async (ms) => { waits.push(ms) } })
  assert.equal(calls.length, 4)
  assert.deepEqual(waits, [100, 100, 100])
  let tries = 0
  await assert.rejects(() => removeWithRetry("index", { remove: () => { tries += 1; throw held("EPERM") }, wait: async () => {}, attempts: 5 }), { code: "EPERM" })
  assert.equal(tries, 5, "a hold that lasts is surfaced after the last attempt")
  tries = 0
  await assert.rejects(() => removeWithRetry("index", { remove: () => { tries += 1; throw held("EIO") }, wait: async () => {} }), { code: "EIO" })
  assert.equal(tries, 1, "an error that is not a hold is not retried")
  assert.equal(await removeWithRetry("index", { remove: () => "gone", wait: async () => {} }), "gone")
  // The default path, with nothing injected: a real file is deleted, and a file that is already missing is not an error.
  const folder = mkdtempSync(path.join(tmpdir(), "desk-remove-retry-"))
  try {
    const file = path.join(folder, "desk-index.sqlite")
    writeFileSync(file, "x")
    await removeWithRetry(file)
    assert.equal(existsSync(file), false)
    await removeWithRetry(file)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

async function assertConnected(sessions) {
  for (const session of sessions) {
    assert.equal(session.child.exitCode, null)
    assert.equal(session.child.signalCode, null)
    assert.deepEqual((await session.request("ping")).result, {})
    assert.deepEqual((await session.request("tools/list")).result.tools, session.tools.result.tools)
  }
}

test("a fixture's derived index is deleted only after its readiness controller child has exited", { timeout: 120000 }, async (t) => {
  const fixture = await makeGitDesk("desk-controller-exit-order-")
  const session = await readySession(t, fixture)
  const controller = ownerRecord(fixture).owner.pid
  assert.notEqual(controller, session.child.pid, "the controller is a separate process from the session")
  assert.equal(processAlive(controller), true, "the controller is running and holds the index while the session is open")
  assert.deepEqual(controllerPids([fixture.readinessHome]), [controller])
  await closeFixtureAndAwaitController(fixture, sessionsByFixture.get(fixture))
  assert.equal(processAlive(controller), false, "the controller has exited before anything is deleted")
  // A plain delete, with no retry: nothing holds the index now, on any platform.
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${indexDbPath(fixture.desk)}${suffix}`, { force: true })
  assert.equal(existsSync(indexDbPath(fixture.desk)), false)
})

test("a 6,000-document reindex keeps the owning MCP session's tools/list within 200 ms", { timeout: 180000 }, async (t) => {
  const fixture = await makeGitDesk("desk-controller-latency-")
  // The 6,000 documents exist before the session starts, so the controller child indexes all of them from an empty index. Nothing is deleted or moved while the controller runs: it holds the index open and a recursive watch covers the desk, and Windows refuses to delete or rename under both.
  populate(fixture)
  const session = await startDesk(fixture, { args: ["--activation-config", writeActivation(fixture)] })
  t.after(() => closeFixtureAndAwaitController(fixture, [session]))
  // The handshake comes before admission, and a tool call made while Desk is still admitting is refused with `admitting`. Wait for admission only: `ready` is reached without waiting for convergence when semantic search is unsupported (runtime/desk-session.js:318 returns it, and :375 starts the convergence in the background), so the 6,000 documents are still being indexed.
  const admitted = await session.statusUntil((status) => status.state === "ready", { deadlineMs: 90000 })
  assert.notEqual(admitted.readiness?.detail.convergence.status, "succeeded", "indexing is still running when the measurement starts")
  // Admission started the controller, so there is one for the teardown wait to find.
  requireControllers(fixture.root)
  // The forced reindex joins the controller's convergence and returns only when every document is indexed. That can outlast the session helper's 20 s default on a slow Windows box, so the call has its own limit.
  const reindexTimeoutMs = 150000
  let finished = false
  const reindex = session.call("desk_reindex", { force: true }, { timeout: reindexTimeoutMs }).finally(() => { finished = true })
  const timings = []
  while (!finished) {
    const { ms, response } = await session.timed("tools/list")
    assert.deepEqual(response.result.tools, session.tools.result.tools)
    timings.push(ms)
    await pause(10)
  }
  const result = await reindex
  assert.equal(result.isError, false, JSON.stringify(result.payload))
  assert.equal(result.payload.action, "controller_convergence")
  const db = openDb(fixture.desk)
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM docs").get().n, 6000)
  } finally {
    closeDb(db)
  }
  t.diagnostic(JSON.stringify({ documents: 6000, requests: timings.length, maxToolsListMs: Math.max(...timings) }))
  assert.ok(timings.length >= 20, `only ${timings.length} requests overlapped the real reindex`)
  assert.ok(Math.max(...timings) <= 200, `owning tools/list took ${Math.max(...timings)} ms during the reindex`)
  assert.notEqual(ownerRecord(fixture).owner.pid, session.child.pid, "the index writer is not the MCP session")
})

test("reclaim_controller stops only a verified hung child while every MCP connection survives, twice", { skip: posixOnly, timeout: 180000 }, async (t) => {
  const fixture = await makeGitDesk("desk-controller-reclaim-child-")
  const first = await readySession(t, fixture, { env: { DESK_READINESS_PROBE_MS: "100" } })
  const second = await readySession(t, fixture, { env: { DESK_READINESS_PROBE_MS: "100" } })
  const sessions = [first, second]
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const record = ownerRecord(fixture)
    assert.ok(!sessions.some((session) => session.child.pid === record.owner.pid), "a child, never a session, owns the controller")
    process.kill(record.owner.pid, "SIGSTOP")
    t.after(() => {
      try { process.kill(record.owner.pid, "SIGCONT") } catch (error) { if (error.code !== "ESRCH") throw error }
    })
    const hung = await second.statusUntil((status) => status.state === "degraded:controller_hung", { deadlineMs: 60000 })
    assert.equal(hung.admission.hung_controller.owner_verified, true)
    await assertConnected(sessions)
    const reclaimed = await second.call("desk_doctor", { repair: "reclaim_controller" })
    assert.equal(reclaimed.isError, false, JSON.stringify(reclaimed.payload))
    assert.equal(reclaimed.payload.reclaimed, true, JSON.stringify(reclaimed.payload))
    assert.equal(reclaimed.payload.controller.owner_pid, record.owner.pid)
    await assertConnected(sessions)
    for (const session of sessions) await session.statusUntil((status) => status.state === "ready", { deadlineMs: 60000 })
    const replacement = ownerRecord(fixture)
    assert.notEqual(replacement.owner.pid, record.owner.pid)
    assert.notEqual(replacement.owner.token, record.owner.token)
    t.diagnostic(JSON.stringify({ cycle: cycle + 1, sessions: sessions.map((session) => session.child.pid), reclaimed: record.owner.pid, replacement: replacement.owner.pid }))
  }
})

test("child death during a 6,000-document reindex re-elects and returns the owning connection to ready, twice", { skip: posixOnly, timeout: 180000 }, async (t) => {
  const fixture = await makeGitDesk("desk-controller-reindex-death-")
  populate(fixture)
  const rendezvous = await controllerRendezvous(t, fixture)
  const session = await readySession(t, fixture, { env: rendezvous.env })
  for (let cycle = 0; cycle < 2; cycle += 1) {
    // A successful recovery read may start new fenced reconciliation. Drain
    // that real work while disarmed; it is not the later target's held proof.
    rendezvous.disarm()
    const drained = await drainController(session)
    const original = ownerRecord(fixture)
    t.diagnostic(JSON.stringify({ cycle, drained: drained.payload, owner_after_drain: original.owner.pid }))
    assert.notEqual(original.owner.pid, session.child.pid, "only a separate controller may be killed")
    await removeDerivedIndex(fixture)
    const request = rendezvous.arm(session, original.owner, cycle)
    let interrupted
    try {
      const ack = await request.held
      request.verify(ack)
      const liveOwner = ownerRecord(fixture).owner
      assert.equal(liveOwner.pid, ack.ownerPid)
      assert.equal(createHash("sha256").update(liveOwner.token).digest("hex"), ack.ownerGeneration)
      assert.equal(processAlive(ack.ownerPid), true)
      assert.equal(request.completed(), false, "the real reindex is still in flight when the controller dies")
      t.diagnostic(JSON.stringify({ cycle, held: ack, action: "kill_before_release" }))
      process.kill(original.owner.pid, "SIGKILL")
      rendezvous.disarm({ killed: true })
      interrupted = await request.result
    } finally {
      rendezvous.disarm()
      await request.result.catch(() => {})
    }
    assert.equal(interrupted.isError, true, "an interrupted reindex is not reported as success")
    await assertConnected([session])
    const recovered = await session.statusUntil((status) => status.state === "ready" && status.readiness?.detail.convergence.status === "succeeded", { deadlineMs: 90000 })
    assert.equal(recovered.admission.controller, "connected")
    const replacement = ownerRecord(fixture)
    assert.notEqual(replacement.owner.pid, original.owner.pid)
    assert.notEqual(replacement.owner.token, original.owner.token)
    const search = await session.call("desk_search", { query: "navigation" })
    assert.equal(search.isError, false, JSON.stringify(search.payload))
    const db = openDb(fixture.desk)
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM docs").get().n, 6000)
    } finally {
      closeDb(db)
    }
    t.diagnostic(JSON.stringify({ cycle: cycle + 1, session: session.child.pid, killed: original.owner.pid, replacement: replacement.owner.pid }))
  }
})

for (const observers of ["passive-v3", "passive-v4", "passive-v3-v4", "capturing-v4"]) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    test(`${observers}: ${signal} preserves ordinary termination or deliberate capture without stranding the controller`, { skip: posixOnly, timeout: 60000 }, async (t) => {
      const fixture = await makeGitDesk("desk-controller-observers-")
      const preload = path.join(fixture.root, "observers.cjs")
      const v3 = require.resolve("signal-exit")
      const v4 = require.resolve("signal-exit", { paths: [path.dirname(require.resolve("foreground-child"))] })
      const capturing = observers === "capturing-v4"
      writeFile(preload, [
        observers.includes("v3") ? `require(${JSON.stringify(v3)})((code, signal) => { process.stderr.write("V3_EXIT:" + signal + "\\n") })` : "",
        observers.includes("v4") ? `require(${JSON.stringify(v4)}).onExit((code, signal) => { process.stderr.write("V4_EXIT:" + signal + "\\n"); return ${capturing} })` : "",
      ].join("\n"))
      const session = await readySession(t, fixture, { nodeArgs: ["--require", preload] })
      const record = ownerRecord(fixture)
      session.child.kill(signal)
      if (capturing) {
        await until(() => session.stderr().includes(`V4_EXIT:${signal}`), "the intentional capture callback ran")
        await assertConnected([session])
        const other = await readySession(t, fixture)
        await assertConnected([session, other])
        assert.equal(ownerRecord(fixture).owner.token, record.owner.token, "a retained host keeps its one live controller")
        await other.close()
        await session.close()
      } else {
        await until(() => session.child.signalCode !== null, `${observers} swallowed ${signal}`, 2000)
        assert.equal(session.child.signalCode, signal)
        for (const version of ["v3", "v4"]) {
          if (observers.includes(version)) assert.ok(session.stderr().includes(`${version.toUpperCase()}_EXIT:${signal}`))
        }

      }
      await until(() => !existsSync(record.ownerFile) && !existsSync(record.endpoint), "the ended session's child released its rendezvous")
    })
  }
}

// A child that swallowed the signal never re-elects at all, so the wait only bounds how long a loaded machine may take to end the child and publish its replacement.
const REELECTION_WAIT_MS = 30000

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`a controller child inherits a passive v4 preload but ${signal} still ends it and re-elects, twice`, { skip: posixOnly, timeout: 60000 }, async (t) => {
    const fixture = await makeGitDesk("desk-child-inherited-observer-")
    const preload = path.join(fixture.root, "passive-v4.cjs")
    const v4 = require.resolve("signal-exit", { paths: [path.dirname(require.resolve("foreground-child"))] })
    writeFile(preload, `require(${JSON.stringify(v4)}).onExit(() => {})\n`)
    const session = await readySession(t, fixture, { env: { NODE_OPTIONS: `--require=${preload}` } })
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const record = ownerRecord(fixture)
      process.kill(record.owner.pid, signal)
      const signalled = performance.now()
      await until(() => {
        const current = currentOwner(record.ownerFile)
        return current !== null && current.owner.token !== record.owner.token
      }, `the child swallowed ${signal} with an inherited passive observer`, REELECTION_WAIT_MS)
      t.diagnostic(`cycle ${cycle + 1}: ${signal} ended the child and a new owner was published ${Math.round(performance.now() - signalled)} ms later`)
      await assertConnected([session])
      await session.statusUntil((status) => status.state === "ready")
    }
  })
}
