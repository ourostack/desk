// Temporary probe (probe branch only, never merged): what does this platform's rename and a no-replace move do to an existing target?
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const stage = (root, name) => {
  const dir = path.join(root, name)
  mkdirSync(dir)
  writeFileSync(path.join(dir, "owner-new"), "new")
  return dir
}
const describe = (target) => {
  try {
    const stat = statSync(target)
    return stat.isDirectory() ? `dir[${readdirSync(target).join(",")}]` : `file[${readFileSync(target, "utf8")}]`
  } catch (error) {
    return `absent(${error.code})`
  }
}
const targets = {
  absent: () => {},
  file: (p) => writeFileSync(p, "OLD-FILE-LOCK"),
  openFile: (p) => { writeFileSync(p, "OLD-FILE-LOCK"); return openSync(p, "r+") },
  emptyDir: (p) => mkdirSync(p),
  nonemptyDir: (p) => { mkdirSync(p); writeFileSync(path.join(p, "owner-old"), "old") },
}
const movers = {
  nodeRename: (from, to) => { try { renameSync(from, to); return "ok" } catch (error) { return `threw ${error.code}` } },
  dotnetMove: (from, to) => {
    for (const shell of ["pwsh", "powershell"]) {
      const run = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "try { [System.IO.Directory]::Move($env:FROM, $env:TO); 'ok' } catch { 'threw ' + $_.Exception.GetType().Name + ' ' + $_.Exception.HResult }"], { env: { ...process.env, FROM: from, TO: to }, encoding: "utf8" })
      if (!run.error) return `${shell}: ${String(run.stdout).trim()}${run.status ? ` status ${run.status}` : ""}`
    }
    return "no powershell"
  },
}

test("probe: what each mover does to each existing target", () => {
  const lines = []
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-probe-"))
  try {
    for (const [moverName, move] of Object.entries(movers)) {
      for (const [targetName, make] of Object.entries(targets)) {
        const from = stage(root, `${moverName}-${targetName}-new`)
        const to = path.join(root, `${moverName}-${targetName}-lock`)
        const handle = make(to)
        const result = move(from, to)
        if (handle !== undefined) closeSync(handle)
        lines.push(`PROBE ${process.platform} ${moverName} onto ${targetName}: ${result}; target now ${describe(to)}; source now ${describe(from)}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.fail(lines.join(" ## "))
})
