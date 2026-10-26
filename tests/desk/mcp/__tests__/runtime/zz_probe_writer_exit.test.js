// EXPERIMENT (never merged): what workspace tidy's writer check sees for a fixture writer, under suite load on Windows.
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

test("probe", async () => {
  const rows = []
  for (let i = 0; i < 60; i += 1) {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" })
    await once(child, "spawn")
    let t = Date.now()
    const start = await readProcessStart(child.pid)
    const startMs = Date.now() - t
    child.kill()
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit")
    let alive
    try { process.kill(child.pid, 0); alive = "openable" } catch (error) { alive = error.code }
    let after = null, afterMs = null
    if (alive === "openable") { t = Date.now(); after = await readProcessStart(child.pid); afterMs = Date.now() - t }
    rows.push({ startNull: start === null, startMs, alive, after, afterMs })
  }
  const out = path.join(process.env.PROBE_DIR ?? process.cwd(), `probe-${process.pid}.json`)
  fs.writeFileSync(out, JSON.stringify(rows))
})
