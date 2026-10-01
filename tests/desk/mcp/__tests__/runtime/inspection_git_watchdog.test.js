// Unit tests for the inspection-Git watchdog pieces: the kernel alarm wrapper, the process-group kill and the reaper bookkeeping.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { inspectionCommand, isExecutable, inspectionSpawnOptions, killProcessGroup, liveInspectionChildren, readInspectionGit, reapOnSignal, resolveWatchdog, watchdogSeconds } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"
import * as path from "node:path"
import { blockedRepo, posixOnly } from "../_process_hygiene.js"

test("the watchdog never fires on a Git read that answers, and the in-process timeout still reports ETIMEDOUT", { skip: posixOnly }, async (t) => {
  const quick = blockedRepo(t)
  const result = await readInspectionGit(quick.prot, ["--version"], {})
  assert.equal(result.ok, true)
  assert.match(result.stdout, /^git version /u)
  await assert.rejects(() => readInspectionGit(quick.prot, ["symbolic-ref", "HEAD"], {}, { timeoutMs: 300 }), { code: "ETIMEDOUT" })
  assert.equal(liveInspectionChildren(), 0)
})

test("a Git read that fails reports the exit code rather than hanging", { skip: posixOnly }, async (t) => {
  const quick = blockedRepo(t)
  const result = await readInspectionGit(quick.root, ["rev-parse", "--git-dir"], { GIT_DIR: path.join(quick.root, "missing") })
  assert.equal(result.ok, false)
  assert.equal(result.code, 128)
})

test("resolveWatchdog picks the first executable perl and nothing on Windows", () => {
  assert.equal(resolveWatchdog({ platform: "win32", accessible: () => true }), undefined)
  assert.equal(resolveWatchdog({ platform: "linux", accessible: (file) => file === "/usr/local/bin/perl" }), "/usr/local/bin/perl")
  assert.equal(resolveWatchdog({ platform: "linux", accessible: () => false }), undefined)
  assert.equal(typeof resolveWatchdog({ platform: process.platform }) === "string" || process.platform === "win32", true)
})

test("the alarm fires one second after the parent's own timeout, rounded up", () => {
  assert.equal(watchdogSeconds(2000), 3)
  assert.equal(watchdogSeconds(2001), 4)
  assert.equal(watchdogSeconds(1), 2)
})

test("killProcessGroup kills the group, falls back to the child, and skips an exited child", () => {
  const calls = []
  killProcessGroup({ pid: 42, exitCode: null, signalCode: null, kill: (s) => calls.push(["child", s]) }, { kill: (pid, s) => calls.push([pid, s]), platform: "linux" })
  killProcessGroup({ pid: 42, exitCode: null, signalCode: null, kill: (s) => calls.push(["child", s]) }, { kill: () => { throw new Error("ESRCH") }, platform: "linux" })
  killProcessGroup({ pid: 42, exitCode: null, signalCode: null, kill: (s) => calls.push(["win", s]) }, { platform: "win32" })
  killProcessGroup({ pid: 42, exitCode: null, signalCode: null, kill: () => { throw new Error("gone") } }, { kill: () => { throw new Error("ESRCH") }, platform: "linux" })
  killProcessGroup({ pid: 42, exitCode: 0, signalCode: null, kill: (s) => calls.push(["late", s]) }, { kill: (pid, s) => calls.push([pid, s]), platform: "linux" })
  assert.deepEqual(calls, [[-42, "SIGKILL"], ["child", "SIGKILL"], ["win", "SIGKILL"]])
})


test("the child leads its own process group everywhere but Windows", () => {
  assert.deepEqual(inspectionSpawnOptions("linux"), { detached: true })
  assert.deepEqual(inspectionSpawnOptions("darwin"), { detached: true })
  assert.deepEqual(inspectionSpawnOptions("win32"), { detached: false })
  assert.equal(typeof inspectionSpawnOptions().detached, "boolean")
})

test("inspectionCommand puts Git behind the alarm wrapper, drops Perl's code and library variables, and runs Git bare without a wrapper", () => {
  const env = { PATH: "/usr/bin", PERL5OPT: "-e1", PERL5LIB: "/x", PERLLIB: "/y" }
  const wrapped = inspectionCommand({ watchdog: "/usr/bin/perl", git: "/usr/bin/git", args: ["status"], timeoutMs: 2000, env })
  assert.equal(wrapped.file, "/usr/bin/perl")
  assert.deepEqual(wrapped.argv.slice(0, 1), ["-e"])
  assert.match(wrapped.argv[1], /^alarm shift @ARGV; exec /u)
  assert.deepEqual(wrapped.argv.slice(2), ["3", "/usr/bin/git", "status"])
  assert.deepEqual(env, { PATH: "/usr/bin" })
  const bare = inspectionCommand({ watchdog: undefined, git: "/usr/bin/git", args: ["status"], timeoutMs: 2000, env: { PERL5OPT: "keep" } })
  assert.deepEqual(bare, { file: "/usr/bin/git", argv: ["status"] })
})

test("reapOnSignal delivers the signal again only when nobody else listens for it", () => {
  const raised = []
  reapOnSignal("SIGTERM", { listenerCount: () => 1, raise: (name) => raised.push(name) })
  assert.deepEqual(raised, [])
  reapOnSignal("SIGTERM", { listenerCount: () => 0, raise: (name) => raised.push(name) })
  assert.deepEqual(raised, ["SIGTERM"])
})

test("two concurrent reads share one set of handlers, and the handlers are gone once both finish", { skip: posixOnly }, async (t) => {
  const quick = blockedRepo(t)
  const before = process.listenerCount("exit")
  const both = Promise.all([readInspectionGit(quick.root, ["--version"], {}), readInspectionGit(quick.root, ["--version"], {})])
  assert.equal(liveInspectionChildren(), 2)
  assert.equal(process.listenerCount("exit"), before + 1)
  await both
  assert.equal(liveInspectionChildren(), 0)
  assert.equal(process.listenerCount("exit"), before)
})

test("isExecutable is true for an executable file and false for a missing one", { skip: posixOnly }, () => {
  assert.equal(isExecutable(process.execPath), true)
  assert.equal(isExecutable("/nonexistent/desk-no-such-binary"), false)
})

test("a SIGTERM delivered to a process with a live read kills that read's Git and removes the handlers", { skip: posixOnly }, async (t) => {
  const f = blockedRepo(t)
  const host = () => {}
  process.on("SIGTERM", host)
  t.after(() => process.removeListener("SIGTERM", host))
  const before = process.listenerCount("SIGTERM")
  const read = readInspectionGit(f.prot, ["symbolic-ref", "HEAD"], {}, { timeoutMs: 60000 })
  assert.equal(process.listenerCount("SIGTERM"), before + 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  process.emit("SIGTERM", "SIGTERM")
  await assert.rejects(read)
  assert.equal(liveInspectionChildren(), 0)
  assert.equal(process.listenerCount("SIGTERM"), before)
})
