import "../_isolated_env.mjs"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { readFileSync, writeFileSync } from "node:fs"
import nativeFs from "node:fs"
import Database from "better-sqlite3"
import { main } from "../../../../../plugins/desk/mcp/index.js"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"

const [seam, marker, phase = "inspectLocalDb"] = process.argv.slice(2)
const children = new Set()
const readers = new Set()
let maxReaders = 0
const originalFork = childProcess.fork
childProcess.fork = (file, args, options) => {
  const child = originalFork(file, args, String(file).endsWith("status-inspection-child.js")
    ? { ...options, execArgv: ["--import", seam] } : options)
  children.add(child)
  if (String(file).endsWith("status-inspection-child.js")) {
    readers.add(child)
    maxReaders = Math.max(maxReaders, readers.size)
    child.once("exit", () => readers.delete(child))
  }
  child.once("exit", () => children.delete(child))
  return child
}
syncBuiltinESMExports()
const originalPrepare = Database.prototype.prepare
Database.prototype.prepare = function(...args) {
  if (phase !== "rootStatus" && new Error().stack.includes(phase)) {
    writeFileSync(marker, JSON.stringify({ pid: process.pid, root: "main-thread" }))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350)
  }
  const exists = nativeFs.existsSync
  nativeFs.existsSync = function(...args) {
    if (phase === "rootStatus" && new Error().stack.includes(phase)) {
      writeFileSync(marker, JSON.stringify({ pid: process.pid, root: "main-thread" }))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350)
    }
    return exists.apply(this, args)
  }
  syncBuiltinESMExports()
  return originalPrepare.apply(this, args)
}
const handle = await main({
  argv: [], env: process.env,
  admissionKickoffMs: 0, runtimeInspector: null,
  runtimeImporter: async () => ({
    ...server,
    connectOrStartController: (options) => server.connectOrStartController({ ...options, ephemeral: true }),
  }),
})
await handle.closed
// A successfully closed session cannot leave status readers or controllers.
if (children.size !== 0) {
  process.stderr.write(`status qualification leaked ${children.size} owned children\n`)
  process.exitCode = 1
}
if (process.connected) {
  process.send({ type: "closed", children: children.size,
    inspected: JSON.parse(readFileSync(marker, "utf8")).pid, maxReaders }, () => process.disconnect())
}
