import { test } from "node:test"
import assert from "node:assert/strict"
import nativeChildProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { pathToFileURL } from "node:url"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"
import { startInProcess } from "./_in_process_desk.js"
import { mkTempRoot } from "../_temp_roots.js"

for (const mode of ["replacement", "disposal"]) {
test(`settled natural-close nonexit gates actual ${mode} until that owned process exits`, async (t) => {
  const root = await mkTempRoot("status-natural-close-")
  mkdirSync(path.join(root, "_meta"))
  mkdirSync(path.join(root, "_archive"))
  writeFileSync(path.join(root, "task.md"), "# Actual retained status reader\n")
  const preload = path.join(root, "held-reader.mjs")
  writeFileSync(preload, `setInterval(() => {}, 1000); process.on("disconnect", () => {});`)
  const originalFork = nativeChildProcess.fork
  const readers = []
  let desk
  t.after(async () => {
    for (const child of readers) {
      if (child.exitCode === null && child.signalCode === null) child.realKill("SIGKILL")
      await child.exited
    }
    await desk?.handle.session.dispose()
    await desk?.close()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  t.mock.method(nativeChildProcess, "fork", (file, args, options) => {
    if (!String(file).endsWith("status-inspection-child.js")) return originalFork(file, args, options)
    const execArgv = ["--import", pathToFileURL(preload).href]
    assert.equal(new URL(execArgv[1]).protocol, "file:", "Node ESM preload must be a file URL, not a Windows drive-path specifier")
    const child = originalFork(file, args, { ...options, execArgv })
    child.realKill = child.kill.bind(child)
    child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
    child.signals = []
    if (readers.length === 0) {
      child.disconnect = () => {}
      child.kill = (signal) => { child.signals.push(signal); return false }
    }
    readers.push(child)
    return child
  })
  syncBuiltinESMExports()
  desk = await startInProcess({
    argv: ["--root", root], env: process.env,
    readinessPolicy: { semantic: "unsupported" },
    runtimeImporter: async () => ({
      ...server,
      connectOrStartController: (options) => server.connectOrStartController({ ...options, ephemeral: true }),
    }),
  })
  assert.equal((await desk.settled()).state, "ready")
  const first = await desk.call("desk_status", { detail: true })
  const failureDeadline = Date.now() + 5000
  let failed = first.payload
  while (failed.status !== "error" && !failed.status_error && Date.now() < failureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    failed = (await desk.call("desk_status", { detail: true })).payload
  }
  assert.ok(failed.status === "error" || failed.status_error, "natural-close failure must be observable")
  assert.equal(readers.length, 1)
  assert.deepEqual(readers[0].signals, ["SIGTERM", "SIGKILL"])
  assert.equal(readers[0].exitCode, null)
  assert.equal(readers[0].signalCode, null)
  const blocked = await desk.call("desk_status", { detail: true })
  assert.match(blocked.payload.status_error, /did not exit/u)
  assert.equal(readers.length, 1, "two naturally failed status calls must not create two live readers")
  const old = readers[0]
  if (mode === "disposal") {
    await assert.rejects(desk.handle.session.dispose(), (error) =>
      error.code === "status_reader_not_exited" && error.pid === old.pid)
    assert.equal(old.exitCode, null)
    assert.equal(old.signalCode, null)
  }
  assert.equal(old.realKill("SIGKILL"), true)
  const release = await old.exited
  assert.ok(release.signal !== null || release.code !== null, "release requires an actual child exit event")
  let recovered
  if (mode === "replacement") {
    recovered = await desk.statusUntil((value) => value.root?.path === root && value.status === "ok")
    assert.equal(recovered.root.path, root)
    assert.ok(readers.length >= 2, "a later verified exit must permit status to recover")
  } else {
    await desk.handle.session.dispose()
    assert.equal(readers.length, 1)
  }
  await desk.close()
  for (const child of readers) await child.exited
  assert.ok(readers.every((child) => child.exitCode !== null || child.signalCode !== null))
  t.diagnostic(JSON.stringify({ mode, defaultDeadlines: true, heldReaderPid: old.pid,
    readersBeforeVerifiedExit: 1, recovered: true, allReadersExited: true,
    sameContextTimestampPreserved: recovered?.status_detail_from ?? null }))
})
}
