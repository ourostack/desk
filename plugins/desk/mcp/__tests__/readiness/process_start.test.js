// A process's start time as the operating system reports it: with its PID, it names one process, so a reused PID is never mistaken for the process that recorded it.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import {
  readOwnProcessStart, readProcessStart, resetOwnProcessStart, runForText,
} from "../../src/readiness/process-start.js"

const nativeRead = process.platform === "linux" || process.platform === "darwin" ? false : "reads /proc or ps"

test("this machine: a running process has one start time, read the same way every time, and a later process has another", { skip: nativeRead }, async (t) => {
  const own = await readProcessStart(process.pid)
  assert.match(own, new RegExp(`^${process.platform}:`, "u"))
  assert.equal(await readProcessStart(process.pid), own, "stable across reads")
  // ps reports whole seconds: the later process must start in a later second.
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" })
  t.after(() => sleeper.kill("SIGKILL"))
  await new Promise((resolve) => sleeper.once("spawn", resolve))
  const other = await readProcessStart(sleeper.pid)
  assert.match(other, new RegExp(`^${process.platform}:`, "u"))
  assert.notEqual(other, own)
  sleeper.kill("SIGKILL")
  await new Promise((resolve) => sleeper.once("exit", resolve))
  assert.equal(await readProcessStart(sleeper.pid), null, "a process that has ended has no start time")
})

test("a PID that is not a positive integer, or a platform with no reader, has no start time", async () => {
  for (const pid of [0, -1, 1.5, "7", null]) assert.equal(await readProcessStart(pid), null)
  assert.equal(await readProcessStart(7, { platform: "aix" }), null)
  assert.equal(await readProcessStart(7, { platform: "toString" }), null, "only the platform's own reader")
})

test("Linux: field 22 of /proc/<pid>/stat, counted after the command name, with the boot id", async () => {
  const files = {
    "/proc/7/stat": "7 (a) b) c) S 1 7 7 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 12345 1000 10\n",
    "/proc/sys/kernel/random/boot_id": "0f2e-boot\n",
  }
  const read = async (file) => {
    if (!(file in files)) throw Object.assign(new Error("no"), { code: "ENOENT" })
    return files[file]
  }
  assert.equal(await readProcessStart(7, { platform: "linux", read }), "linux:0f2e-boot:12345")
  assert.equal(await readProcessStart(8, { platform: "linux", read }), null, "no such process")
  files["/proc/9/stat"] = "9 (x) S 1\n"
  assert.equal(await readProcessStart(9, { platform: "linux", read }), null, "a stat line too short to hold field 22")
  delete files["/proc/sys/kernel/random/boot_id"]
  assert.equal(await readProcessStart(7, { platform: "linux", read }), "linux:unknown-boot:12345", "no boot id: the ticks alone")
  files["/proc/sys/kernel/random/boot_id"] = "  \n"
  assert.equal(await readProcessStart(7, { platform: "linux", read }), "linux:unknown-boot:12345")
})

test("macOS: ps -o lstart= -p <pid> as an argument array, in UTC and the C locale", async () => {
  const calls = []
  const answer = (text) => async (file, args, options) => { calls.push({ file, args, options }); return text }
  assert.equal(await readProcessStart(7, { platform: "darwin", run: answer("Fri Sep 25 10:00:00 2026    \n") }), "darwin:2026-09-25T10:00:00.000Z")
  assert.deepEqual(calls[0].args, ["-o", "lstart=", "-p", "7"])
  assert.equal(calls[0].file, "/bin/ps")
  assert.deepEqual(calls[0].options.env, { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" })
  assert.equal(await readProcessStart(7, { platform: "darwin", run: answer(null) }), null, "ps failed: no such process")
  assert.equal(await readProcessStart(7, { platform: "darwin", run: answer("\n") }), null, "an empty answer")
})

test("Windows: Get-CimInstance Win32_Process CreationDate, in UTC", async () => {
  const calls = []
  const answer = (text) => async (file, args, options) => { calls.push({ file, args, options }); return text }
  const env = { SystemRoot: "C:\\Windows" }
  assert.equal(await readProcessStart(7, { platform: "win32", env, run: answer("2026-09-25T10:00:00.1234567Z\r\n") }), "win32:2026-09-25T10:00:00.123Z")
  assert.equal(calls[0].file, "powershell.exe")
  assert.deepEqual(calls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"])
  assert.match(calls[0].args[3], /Get-CimInstance Win32_Process -Filter "ProcessId=7".*CreationDate\.ToUniversalTime\(\)/u)
  assert.equal(calls[0].options.env, env)
  assert.equal(await readProcessStart(7, { platform: "win32", run: answer("") }), null, "no such process prints nothing")
  assert.equal(await readProcessStart(7, { platform: "win32", run: answer(null) }), null)
  assert.equal(calls[1].options.env, process.env, "the default environment")
})

test("runForText resolves with stdout, or null when the command fails or cannot run", async () => {
  assert.equal(await runForText(process.execPath, ["-e", "process.stdout.write('hi')"], { timeout: 10000, env: process.env }), "hi")
  assert.equal(await runForText(process.execPath, ["-e", "process.exit(3)"], { timeout: 10000, env: process.env }), null)
  assert.equal(await runForText("/no/such/command", [], { timeout: 10000, env: process.env }), null)
})

test("this process's own start time is read once, and a failed read is no start time", async (t) => {
  t.after(resetOwnProcessStart)
  resetOwnProcessStart()
  let reads = 0
  const read = async (pid) => { reads += 1; return `test:${pid}` }
  assert.equal(await readOwnProcessStart({ pid: 5, read }), "test:5")
  assert.equal(await readOwnProcessStart({ pid: 6, read }), "test:5", "cached")
  assert.equal(reads, 1)
  resetOwnProcessStart()
  assert.equal(await readOwnProcessStart({ read: async () => { throw new Error("boom") } }), null)
  resetOwnProcessStart()
  assert.equal(await readOwnProcessStart({ read: () => { throw new Error("sync boom") } }), null, "a reader that throws at once")
  resetOwnProcessStart()
  assert.equal(await readOwnProcessStart(), await readProcessStart(process.pid), "the defaults read this process")
})
