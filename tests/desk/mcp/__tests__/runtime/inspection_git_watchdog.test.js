// Unit tests for the inspection-Git watchdog pieces: the kernel alarm wrapper, the process-group kill and the reaper bookkeeping.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { inspectionCommand, isExecutable, inspectionSpawnOptions, killProcessGroup, liveInspectionChildren, readInspectionGit, reapOnSignal, resetWatchdogForTests, watchdogIsBroken, resolveWatchdog, watchdogSeconds } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { blockedRepo, posixOnly, removeFixtureAfter } from "../_process_hygiene.js"

test("the watchdog never fires on a Git read that answers, and the in-process timeout still reports ETIMEDOUT", { skip: posixOnly }, async (t) => {
  const quick = blockedRepo(t)
  const result = await readInspectionGit(quick.prot, ["--version"])
  assert.equal(result.ok, true)
  assert.match(result.stdout, /^git version /u)
  await assert.rejects(() => readInspectionGit(quick.prot, ["symbolic-ref", "HEAD"], { timeoutMs: 300 }), { code: "ETIMEDOUT" })
  assert.equal(liveInspectionChildren(), 0)
})

test("a Git read that fails reports the exit code rather than hanging", { skip: posixOnly }, async (t) => {
  const quick = blockedRepo(t)
  const result = await readInspectionGit(quick.root, ["cat-file", "-t", "deadbeef"])
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
  assert.deepEqual(wrapped.env, { PATH: "/usr/bin" })
  assert.deepEqual(env, { PATH: "/usr/bin", PERL5OPT: "-e1", PERL5LIB: "/x", PERLLIB: "/y" }, "the caller's environment is not changed")
  const bare = inspectionCommand({ watchdog: undefined, git: "/usr/bin/git", args: ["status"], timeoutMs: 2000, env: { PERL5OPT: "keep" } })
  assert.deepEqual(bare, { file: "/usr/bin/git", argv: ["status"], env: { PERL5OPT: "keep" } })
})

test("reapOnSignal delivers the signal again only when nobody else listens for it", () => {
  const raised = []
  reapOnSignal("SIGTERM", { listenerCount: () => 1, kill: (pid, name) => raised.push([pid === process.pid, name]) })
  assert.deepEqual(raised, [])
  reapOnSignal("SIGTERM", { listenerCount: () => 0, kill: (pid, name) => raised.push([pid === process.pid, name]) })
  assert.deepEqual(raised, [[true, "SIGTERM"]])
})

test("two concurrent reads share one set of handlers, and the handlers are gone once both finish", { skip: posixOnly }, async (t) => {
  const quick = blockedRepo(t)
  const before = process.listenerCount("exit")
  const both = Promise.all([readInspectionGit(quick.root, ["--version"]), readInspectionGit(quick.root, ["--version"])])
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
  const read = readInspectionGit(f.prot, ["symbolic-ref", "HEAD"], { timeoutMs: 60000 })
  assert.equal(process.listenerCount("SIGTERM"), before + 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  process.emit("SIGTERM", "SIGTERM")
  await assert.rejects(read)
  assert.equal(liveInspectionChildren(), 0)
  assert.equal(process.listenerCount("SIGTERM"), before)
})

// A repository whose `git status` runs a slow fsmonitor hook: a Git grandchild that only a group kill can reach.
function fsmonitorRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-guard-fsmonitor-"))
  removeFixtureAfter(t, root)
  execFileSync("git", ["init", "-q", "-b", "main", root])
  const pidFile = path.join(root, "hook.pid")
  const hook = path.join(root, "hook.sh")
  writeFileSync(hook, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 300\n`)
  chmodSync(hook, 0o755)
  return { root, pidFile, args: ["-c", `core.fsmonitor=${hook}`, "status"] }
}

async function assertHookGone(f) {
  assert.ok(existsSync(f.pidFile), "the fsmonitor hook started")
  const pid = Number(readFileSync(f.pidFile, "utf8"))
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(pid, 0) } catch (error) { assert.equal(error.code, "ESRCH"); return }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`the Git helper ${pid} outlived the kill`)
}

test("an in-process timeout kills Git's helper as well as Git", { skip: posixOnly }, async (t) => {
  const f = fsmonitorRepo(t)
  await assert.rejects(() => readInspectionGit(f.root, f.args, { timeoutMs: 1500 }), { code: "ETIMEDOUT" })
  await assertHookGone(f)
})

test("an abort kills Git's helper as well as Git", { skip: posixOnly }, async (t) => {
  const f = fsmonitorRepo(t)
  const controller = new AbortController()
  const read = readInspectionGit(f.root, f.args, { signal: controller.signal, timeoutMs: 60000 })
  for (let attempt = 0; attempt < 50 && !existsSync(f.pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  controller.abort()
  await assert.rejects(read, { name: "AbortError" })
  await assertHookGone(f)
})

function fakePerl(t, body) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-guard-fakeperl-"))
  removeFixtureAfter(t, root)
  const file = path.join(root, "perl")
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return { root, file }
}

test("a wrapper that fails before exec is retried once with bare Git and then remembered as broken", { skip: posixOnly }, async (t) => {
  resetWatchdogForTests()
  t.after(resetWatchdogForTests)
  const f = fakePerl(t, 'echo "exec failed: No such file or directory" >&2; exit 127')
  const first = await readInspectionGit(f.root, ["--version"], { watchdog: f.file })
  assert.equal(first.ok, true)
  assert.match(first.stdout, /^git version /u)
  assert.equal(watchdogIsBroken(), true)
  const second = await readInspectionGit(f.root, ["--version"])
  assert.equal(second.ok, true)
})

test("a wrapper that cannot start at all is retried with bare Git", { skip: posixOnly }, async (t) => {
  resetWatchdogForTests()
  t.after(resetWatchdogForTests)
  const result = await readInspectionGit(tmpdir(), ["--version"], { watchdog: "/nonexistent/desk-no-such-perl" })
  assert.equal(result.ok, true)
  assert.equal(watchdogIsBroken(), true)
})

test("a Git failure is never mistaken for a broken wrapper, even with exit 127 or another code", { skip: posixOnly }, async (t) => {
  resetWatchdogForTests()
  t.after(resetWatchdogForTests)
  const plain127 = fakePerl(t, "exit 127")
  const first = await readInspectionGit(plain127.root, ["--version"], { watchdog: plain127.file })
  assert.deepEqual([first.ok, first.code], [false, 127])
  const other = fakePerl(t, 'echo "exec failed: x" >&2; exit 5')
  const second = await readInspectionGit(other.root, ["--version"], { watchdog: other.file })
  assert.deepEqual([second.ok, second.code], [false, 5])
  assert.equal(watchdogIsBroken(), false)
})

test("a missing working directory is not blamed on the wrapper", { skip: posixOnly }, async (t) => {
  resetWatchdogForTests()
  t.after(resetWatchdogForTests)
  await assert.rejects(readInspectionGit("/nonexistent/desk-no-such-cwd", ["--version"]), /ENOENT/u)
  assert.equal(watchdogIsBroken(), false)
})

test("output past the 1 MiB limit kills Git and is reported as an error", { skip: posixOnly }, async (t) => {
  const f = fsmonitorRepo(t)
  await assert.rejects(() => readInspectionGit(f.root, ["-c", "alias.big=!head -c 1300000 /dev/zero", "big"], { timeoutMs: 10000 }), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
})
