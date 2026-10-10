import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import childProcess from "node:child_process"
import nativeFs from "node:fs"
import { pathToFileURL } from "node:url"
import * as path from "node:path"
import Database from "better-sqlite3"
import { indexDbPath } from "../../../../../plugins/desk/mcp/src/db/init.js"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"
import { startInProcess } from "./_in_process_desk.js"
import { mkTempRoot } from "../_temp_roots.js"

for (const phase of ["rootStatus", "inspectLocalDb", "openSnapshot"]) {
test(`synchronous ${phase} work cannot stall the answering thread or its budget`, async (t) => {
  const root = await mkTempRoot("status-sql-")
  mkdirSync(path.join(root, "_meta"))
  mkdirSync(path.join(root, "_archive"))
  writeFileSync(path.join(root, "task.md"), "# SQLite status seam\n")
  const desk = await startInProcess({
    argv: ["--root", root], env: process.env,
    readinessPolicy: { semantic: "unsupported" },
    runtimeImporter: async () => ({
      ...server,
      connectOrStartController: (options) => server.connectOrStartController({ ...options, ephemeral: true }),
    }),
  })
  t.after(async () => {
    await desk.handle.admission.idle({ waitMs: 15000 })
    await desk.close()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  assert.equal((await desk.settled()).state, "ready")
  const controller = desk.handle.session.context.admission.controller
  const observed = await controller.status()
  assert.notEqual(observed.owner.pid, process.pid, "the controller must run on its own event loop")
  // A real DB is needed: missing-index status must not pass without traversing SQLite.
  await server.ensureIndex(root, { skipEmbed: true, snapshots: false, vectorPacks: false })
  const marker = path.join(root, "sql-entered")
  const seam = path.join(root, "sql-seam.mjs")
  const from = new URL("../../../../../plugins/desk/mcp/package.json", import.meta.url).href
  writeFileSync(seam, `
    import { createRequire } from "node:module";
    import { writeFileSync } from "node:fs";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const Database = createRequire(${JSON.stringify(from)})("better-sqlite3");
    const original = Database.prototype.prepare;
    let blocked = false;
    Database.prototype.prepare = function(...args) {
      if (!blocked && new Error().stack.includes(${JSON.stringify(phase)})) {
        blocked = true;
        writeFileSync(${JSON.stringify(marker)}, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      }
      return original.apply(this, args);
    };
    const exists = fs.existsSync;
    fs.existsSync = function(...args) {
      if (!blocked && new Error().stack.includes(${JSON.stringify(phase)}) && ${JSON.stringify(phase)} === "rootStatus") {
        blocked = true;
        writeFileSync(${JSON.stringify(marker)}, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      }
      return exists.apply(this, args);
    };
    syncBuiltinESMExports();
  `)
  const originalFork = childProcess.fork
  t.mock.method(childProcess, "fork", (file, args, options) =>
    originalFork(file, args, String(file).endsWith("status-inspection-child.js")
      ? { ...options, execArgv: ["--import", pathToFileURL(seam).href] } : options))
  syncBuiltinESMExports()
  const originalPrepare = Database.prototype.prepare
  const originalExists = nativeFs.existsSync
  let blocked = false
  t.mock.method(Database.prototype, "prepare", function(...args) {
    if (!blocked && new Error().stack.includes(phase)) {
      blocked = true
      writeFileSync(marker, String(process.pid))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350)
    }
    return originalPrepare.apply(this, args)
  })
  t.mock.method(nativeFs, "existsSync", function(...args) {
    if (!blocked && phase === "rootStatus" && new Error().stack.includes(phase)) {
      blocked = true
      writeFileSync(marker, String(process.pid))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350)
    }
    return originalExists.apply(this, args)
  })
  syncBuiltinESMExports()
  const started = Date.now()
  let timerMs = null
  const timer = setTimeout(() => { timerMs = Date.now() - started }, 25)
  const pending = desk.call("desk_status", { detail: true })
  const result = await pending
  const elapsedMs = Date.now() - started
  clearTimeout(timer)
  assert.ok(elapsedMs < 200, `status took ${elapsedMs} ms at the actual SQLite seam`)
  assert.ok(timerMs !== null && timerMs < 200, `the answering thread's 25 ms timer took ${timerMs} ms`)
  assert.equal(result.payload.state, "ready")
  const deadline = Date.now() + 5000
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(existsSync(marker), "the real status computation must reach the controlled SQLite seam")
  const inspectionPid = Number(readFileSync(marker, "utf8"))
  assert.notEqual(inspectionPid, process.pid, "both SQLite inspections must leave the answering process")
  const pingStarted = Date.now()
  let busyTimerMs
  await Promise.all([desk.client.ping(), desk.client.listTools(),
    new Promise((resolve) => setTimeout(() => { busyTimerMs = Date.now() - pingStarted; resolve() }, 25))])
  const controlMs = Date.now() - pingStarted
  assert.ok(controlMs < 200, "ping and tools/list stay responsive while SQLite blocks")
  assert.ok(busyTimerMs < 200, "a timer scheduled after SQLite enters its blocking seam must stay responsive")
  const detail = await desk.statusUntil((value) => value.local_db?.state === "available")
  assert.equal(detail.root.path, root)
  assert.equal(detail.local_db.path, indexDbPath(root))
  assert.ok(detail.status_detail_from, "a late computation must carry its actual start timestamp")
  t.diagnostic(JSON.stringify({ phase, statusMs: elapsedMs, firstTimerMs: timerMs, busyTimerMs,
    controlMs, inspectionPid, controllerPid: observed.owner.pid, capMs: 200,
    fields: ["state", "root.path", "local_db.path", "status_detail_from"] }))
})
}
