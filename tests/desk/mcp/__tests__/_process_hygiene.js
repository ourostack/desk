// Shared hygiene for tests that leave git or node children running under a temporary fixture.
// A test that deletes its fixture while a child still has it as its working directory (or is blocked reading a FIFO inside it) leaves that child behind for good: nothing will ever wake it. These helpers find such children by working directory, kill them, and wait for them to exit, so a fixture folder is only removed once nothing is running in it.
import { execFileSync, spawn } from "node:child_process"
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { killAndWait } from "./_kill_and_wait.js"

const inside = (root, dir) => dir === root || dir.startsWith(root + path.sep)

/** Processes whose current directory is inside `root`, as [{ pid, command, cwd }]. Linux reads /proc; macOS asks lsof. */
export function processesWithCwdUnder(root) {
  let resolved
  try { resolved = realpathSync(root) } catch { resolved = path.resolve(root) }
  const found = []
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue
      try {
        const cwd = readlinkSync(`/proc/${entry}/cwd`)
        if (inside(resolved, cwd)) found.push({ pid: Number(entry), cwd, command: readlinkSync(`/proc/${entry}/exe`).split(path.sep).pop() })
      } catch { /* exited, or not ours to read */ }
    }
    return found.filter((p) => p.pid !== process.pid)
  }
  let out = ""
  try { out = execFileSync("lsof", ["-a", "-d", "cwd", "-Fpcn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }) } catch (error) { out = error.stdout ?? "" }
  let current
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) current = { pid: Number(line.slice(1)), command: "", cwd: "" }
    else if (line.startsWith("c") && current) current.command = line.slice(1)
    else if (line.startsWith("n") && current) {
      current.cwd = line.slice(1)
      if (inside(resolved, current.cwd) && current.pid !== process.pid) found.push({ ...current })
    }
  }
  return found
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until no process has its cwd inside `root`, or `timeoutMs` passes. Returns what is left. */
export async function waitForNoProcessesUnder(root, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const left = processesWithCwdUnder(root)
    if (left.length === 0 || Date.now() > deadline) return left
    await sleep(100)
  }
}

/** Kill every process whose cwd is inside `root` and wait until they are gone. Call before removing the folder. */
export async function reapProcessesUnder(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const left = processesWithCwdUnder(root)
    if (left.length === 0) return
    for (const { pid } of left) { try { process.kill(pid, "SIGKILL") } catch { /* already gone */ } }
    await sleep(50)
  }
}

/** Register cleanup for a fixture folder: SIGKILL anything still running in it, wait until it is gone, then delete the folder. Hooks run in registration order, so this does not depend on the other cleanups having run first. */
export function removeFixtureAfter(t, root) {
  t.after(async () => {
    await reapProcessesUnder(root)
    try {
      // Windows holds a folder for a moment after the last process in it exits (virus scan, indexer), so retry longer there.
      rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 40 : 5, retryDelay: process.platform === "win32" ? 250 : 100 })
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code)) throw error
      // Windows keeps a folder as "delete pending" while any process still has a handle on it, even after every file in it is gone (the runner's scanner does this). A folder that is gone or empty is cleaned up for every purpose this fixture has, so only a folder that still holds files is a failure.
      let left
      try { left = readdirSync(root) } catch (listError) { if (listError.code === "ENOENT") return; throw error }
      if (left.length === 0) return
      const why = []
      for (const name of left.slice(0, 3)) {
        try { rmSync(path.join(root, name), { recursive: true, force: true }) } catch (inner) { why.push(`${inner.code} ${inner.path ?? name}: ${inner.message}`) }
      }
      let rest = ""
      try { rest = readdirSync(root, { recursive: true }).slice(0, 40).join(", ") } catch { /* diagnostic only */ }
      throw new Error(`${error.message}; still in the folder: ${left.join(", ")}; removing the first ones says: ${why.join(" | ")}; remaining entries: ${rest}`)
    }
  })
}

/**
 * Make every inspection read of the repository at `prot` block on a FIFO included from its own configuration, so Git never answers on its own. Returns { fifo, writer }. On cleanup the writer is killed and the FIFO is opened once for writing so any reader still blocked in open() wakes; `removeFixtureAfter` kills whatever is left in the fixture.
 */
export function slowGit(t, prot, env, delayMs, { writer: withWriter = true } = {}) {
  const fifo = path.join(path.dirname(prot), "slow.cfg")
  execFileSync("mkfifo", [fifo])
  execFileSync("git", ["-C", prot, "config", "include.path", fifo], { env })
  let writer
  if (withWriter) {
    writer = spawn(process.execPath, ["-e", `
    const fs = require("node:fs")
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    for (;;) { const fd = fs.openSync(${JSON.stringify(fifo)}, "w"); sleep(${delayMs}); fs.closeSync(fd) }
  `], { stdio: "ignore" })
  }
  t.after(async () => {
    if (writer) await killAndWait(writer)
    // O_RDWR never blocks; a reader blocked in open() wakes once any writer exists.
    try { closeSync(openSync(fifo, constants.O_RDWR)) } catch { /* fixture already gone */ }
  })
  return { fifo, writer }
}

export const posixOnly = process.platform === "win32" ? "mkfifo and process groups are POSIX-only" : false

/** A throwaway repository whose every Git read blocks in open() on a FIFO that has no writer. */
export function blockedRepo(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-guard-orphans-")))
  removeFixtureAfter(t, root)
  const home = path.join(root, "home")
  mkdirSync(home)
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n")
  const env = { HOME: home, GIT_CONFIG_NOSYSTEM: "1", PATH: process.env.PATH }
  const prot = path.join(root, "prot")
  execFileSync("git", ["init", "-q", "-b", "main", prot], { env })
  // No writer: every read of this repository's configuration blocks in open() until the process is killed.
  slowGit(t, prot, env, 0, { writer: false })
  return { root, prot, env }
}
