import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import * as path from "node:path"
import { openDb, closeDb, indexDbPath } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { makeGitDesk, startDesk, writeActivation, writeFile } from "./_admission_fixtures.js"
import { assertProcessesGone, controllerPids, processAlive, waitForProcessesGone } from "./_controller_exit.js"

const require = createRequire(import.meta.url)
const posixOnly = process.platform === "win32" ? "POSIX signal semantics" : false
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

test("a 6,000-document reindex keeps the owning MCP session's tools/list within 200 ms", { timeout: 120000 }, async (t) => {
  const fixture = await makeGitDesk("desk-controller-latency-")
  const session = await readySession(t, fixture)
  // The controller child holds the index open, so the index is never deleted to force real indexing (Windows refuses, and a live controller's file is not the test's to remove). Instead 5,998 new documents arrive after convergence, built beside the desk and moved in at once, and the forced reindex has to index them all.
  const staged = path.join(fixture.root, "staged-tips")
  populate(fixture, staged)
  renameSync(staged, path.join(fixture.desk, "_meta", "tips"))
  let finished = false
  const reindex = session.call("desk_reindex", { force: true }).finally(() => { finished = true })
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
  assert.ok(timings.length > 1, "requests overlap the real reindex")
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
  const session = await readySession(t, fixture)
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const original = ownerRecord(fixture)
    assert.notEqual(original.owner.pid, session.child.pid, "only a separate controller may be killed")
    await removeDerivedIndex(fixture)
    let completed = false
    const reindex = session.call("desk_reindex", { force: true }).finally(() => { completed = true })
    await until(() => existsSync(indexDbPath(fixture.desk)), "the child must enter the real index rebuild before it is killed", 20000)
    assert.equal(completed, false, "the real reindex is still in flight when the controller dies")
    process.kill(original.owner.pid, "SIGKILL")
    const interrupted = await reindex
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
