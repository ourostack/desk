import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { acquireSyncLock, readSyncStatus, recordPullOutcome, resolveSyncLockPath, updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { pullStillFailing } from "../../../../../plugins/desk/mcp/src/runtime/health.js"
import { syncSummary } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { removeTree } from "../_remove_tree.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

if (process.platform === "darwin") {
  process.env.PATH = `/usr/bin:/bin:${process.env.PATH}`
  process.env.GIT_EXEC_PATH = "/Library/Developer/CommandLineTools/usr/libexec/git-core"
}
delete process.env.GIT_TEMPLATE_DIR
delete process.env.GIT_CONFIG_PARAMETERS
delete process.env.GIT_CONFIG_COUNT

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: process.env, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function pendingSettlement(value) {
  return value.finalized !== true && !["owner_lost", "owner_generation_mismatch"].includes(value.reason) &&
    (["starting", "accepted", "running"].includes(value.state) || Boolean(value.recordedState) || Boolean(value.historicalState))
}

function fixture(t, { delay = 0.3, hang = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-owned-recovery-"))
  const origin = path.join(dir, "origin.git")
  const root = path.join(dir, "desk")
  const env = { ...process.env, XDG_STATE_HOME: path.join(dir, "state") }
  env.HOME = path.join(dir, "home")
  env.GH_CONFIG_DIR = path.join(env.HOME, "gh")
  mkdirSync(env.GH_CONFIG_DIR, { recursive: true })
  const filingAttempts = []
  const fileProblem = (input) => {
    filingAttempts.push(input)
    return { file: "fixture recording no-op; no external dispatch" }
  }
  const bin = path.join(dir, "bin")
  mkdirSync(bin)
  for (const name of ["gh", "jq"]) {
    const executable = path.join(bin, name)
    writeFileSync(executable, "#!/bin/sh\nexit 127\n")
    chmodSync(executable, 0o700)
  }
  env.PATH = `${bin}:${env.PATH}`
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name]
  mkdirSync(origin)
  mkdirSync(root)
  git(origin, "init", "--bare", "-q")
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.name", "Recovery fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  writeFileSync(path.join(root, "seed"), "original\n")
  git(root, "add", "seed")
  git(root, "commit", "-qm", "seed")
  git(root, "remote", "add", "origin", origin)
  git(root, "push", "-qu", "origin", "main")
  const starts = path.join(dir, "starts")
  const helper = path.join(dir, "upload-pack")
  writeFileSync(helper, `#!/bin/sh\nprintf 'start\\n' >> '${starts}'\n${hang ? "trap '' TERM\nsleep 30" : `sleep ${delay}`}\nexec git-upload-pack "$@"\n`)
  chmodSync(helper, 0o700)
  git(root, "config", "remote.origin.uploadpack", helper)
  t.after(async () => {
    assert.equal(filingAttempts.length, 0, "The fixed recovery path never delegates to an external filer")
    const operation = readSyncStatus({ root, env })?.recovery
    if (operation && pendingSettlement(operation)) await settled({ root, env }, operation.id)
    const final = readSyncStatus({ root, env })?.recovery
    if (final?.state === "unknown" || final?.resources?.childrenClosed === false) {
      t.diagnostic(JSON.stringify({ retainedFixture: dir, operationId: final.id, ownerPid: final.owner?.pid, nativeGroup: final.resources?.childPid, reason: final.reason }))
      return
    }
    await removeTree(dir)
  })
  return { dir, root, origin, env, starts, fileProblem, scheduleDelivery: () => {} }
}

async function settled(f, id, timeout = 30000) {
  // The reader is exercised once before this bounded wait; it never probes the remote.
  let state = readSyncStatus(f)?.recovery
  assert.equal(state?.id, id)
  const deadline = Date.now() + timeout
  while (pendingSettlement(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    state = readSyncStatus(f)?.recovery
  }
  assert.ok(!pendingSettlement(state), JSON.stringify(state))
  if (state.state !== "synced") {
    const syncDir = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
    const folder = readdirSync(syncDir).find((name) => name.endsWith(".recovery"))
    const raw = JSON.parse(readFileSync(path.join(syncDir, folder, `${id}.json`), "utf8"))
    process.stderr.write(`${JSON.stringify({ settlementBeforeAnyNextDispatch: id, observed: state, rawOperation: raw })}\n`)
  }
  if (state.state === "unknown") {
    process.stderr.write(`${JSON.stringify({ observedUnknownSettlement: state })}\n`)
    const syncDir = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
    const directory = path.join(syncDir, readdirSync(syncDir).find((name) => name.endsWith(".recovery")))
    const log = path.join(directory, `${id}.stderr`)
    if (existsSync(log) && readFileSync(log, "utf8")) process.stderr.write(readFileSync(log, "utf8"))
  }
  return state
}

test("a progressing native fetch outlives boot wait under one accepted worker", async (t) => {
  const f = fixture(t)
  const before = git(f.root, "rev-parse", "HEAD")
  const result = await syncWorkspace({ ...f, waitMs: 1, lifetimeMs: 20000 })
  assert.equal(result.state, "recovering")
  assert.ok(["unaccepted", "accepted"].includes(result.operation.custody))
  const joined = await syncWorkspace({ ...f, waitMs: 1, lifetimeMs: 20000 })
  assert.equal(joined.operation.id, result.operation.id)
  const final = await settled(f, result.operation.id)
  assert.equal(final.state, "synced")
  assert.equal(final.custody, "accepted")
  assert.ok(Number.isInteger(final.owner.pid))
  assert.equal(final.incoming.state, "verified")
  assert.equal(final.source.head, before)
  assert.equal(git(f.root, "rev-parse", "HEAD"), before)
  assert.equal(readFileSync(f.starts, "utf8"), "start\n")
  assert.equal(final.resources.childrenClosed, true)
})

test("the scoped fetch does not delegate maintenance or nested repository work", async (t) => {
  const f = fixture(t)
  const trace = path.join(f.dir, "git-trace.jsonl")
  f.env.GIT_TRACE2_EVENT = trace
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 30000 })
  const final = await settled(f, result.operation.id)
  assert.equal(final.state, "synced", JSON.stringify(final))
  const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const fetch = events.find((event) => event.event === "start" && event.argv?.includes("fetch"))
  assert.ok(fetch)
  assert.ok(fetch.argv.includes("--no-auto-maintenance"))
  assert.ok(fetch.argv.includes("--recurse-submodules=no"))
})

test("incoming graph recovery never moves pending bytes or the index", async (t) => {
  const f = fixture(t)
  const peer = path.join(f.dir, "peer")
  mkdirSync(peer)
  git(peer, "clone", "-q", "-b", "main", f.origin, ".")
  git(peer, "config", "user.name", "Fixture")
  git(peer, "config", "user.email", "fixture@example.invalid")
  writeFileSync(path.join(peer, "seed"), "remote\n")
  git(peer, "commit", "-qam", "remote change")
  git(peer, "push", "-q")
  writeFileSync(path.join(f.root, "seed"), "staged\n")
  git(f.root, "add", "seed")
  writeFileSync(path.join(f.root, "seed"), "unstaged\n")
  writeFileSync(path.join(f.root, "private"), "pending\n")
  const before = git(f.root, "rev-parse", "HEAD")
  const index = readFileSync(path.join(f.root, ".git", "index"))
  const result = await syncWorkspace({ ...f, waitMs: 1, lifetimeMs: 20000 })
  assert.equal(result.state, "recovering")
  const final = await settled(f, result.operation.id)
  assert.equal(final.incoming.state, "verified")
  assert.equal(final.source.state, "blocked")
  assert.equal(final.reason, "writer_custody_required")
  assert.equal(git(f.root, "rev-parse", "HEAD"), before)
  assert.deepEqual(readFileSync(path.join(f.root, ".git", "index")), index)
  assert.equal(readFileSync(path.join(f.root, "seed"), "utf8"), "unstaged\n")
  assert.equal(git(f.root, "show", ":seed"), "staged")
  assert.equal(readFileSync(path.join(f.root, "private"), "utf8"), "pending\n")
  assert.equal(existsSync(path.join(f.root, "_cache")), false)
})

test("incoming failure cannot expire or be cleared by outgoing success", () => {
  assert.equal(pullStillFailing({
    lastPull: { state: "unresolved", cause: "unreachable", at: "2020-01-01T00:00:00.000Z" },
    lastPushAt: "2026-10-30T00:00:00.000Z",
    fetchedAt: "2026-10-30T00:00:00.000Z",
  }), true)
})

test("a boot timeout never claims confirmed absence of effects", () => {
  assert.doesNotMatch(syncSummary({ sync: null, timedOut: true }), /nothing was pulled or pushed/u)
})

test("two cold CLI starts return within 3000ms without waiting for native recovery", async (t) => {
  const f = fixture(t, { delay: 4 })
  mkdirSync(path.join(f.root, "_meta"))
  mkdirSync(path.join(f.root, "_archive"))
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  let operationId
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const start = performance.now()
    const boot = spawnSync(process.execPath, cycle === 0 ? [script] : [script, "--json"], {
      cwd: f.root, env: { ...f.env, DESK: f.root, DESK_NONINTERACTIVE: "1" },
      encoding: "utf8", timeout: 6000,
    })

    const elapsed = performance.now() - start
    t.diagnostic(JSON.stringify({ cycle: cycle + 1, coldEntryMs: elapsed, exitCode: boot.status }))
    assert.equal(boot.status, 0, boot.stderr || boot.error?.message)
    assert.ok(elapsed <= 3000, `cold entry took ${elapsed}ms`)
    if (cycle === 0) {
      assert.match(boot.stdout, /Desk boot: ready/u)
      assert.match(boot.stdout, /pending in the background/u)
      assert.doesNotMatch(boot.stdout, /Active tasks: unavailable|Desk boot: degraded/u)
      operationId = readSyncStatus(f)?.recovery.id
      assert.ok(operationId)
      t.diagnostic(JSON.stringify({ actualPlainBootOutput: boot.stdout }))
    } else {
      const result = JSON.parse(boot.stdout)
      assert.equal(result.boot_complete, true)
      assert.equal(result.sync.state, "recovering")
      assert.equal(result.sync.operation.id, operationId)
    }
    assert.doesNotMatch(boot.stdout, /working from local state|nothing was pulled or pushed/u)
  }
  await settled(f, operationId)
  assert.equal(existsSync(path.join(f.root, ".git", "hooks", "pre-commit")), false, "Background inspection does not install hooks while the task is already running")
})

test("a failed native worker launch is explicit and dispatches no fetch", async (t) => {
  const f = fixture(t)
  const result = await syncWorkspace({ ...f, waitMs: 200, spawnImpl: () => spawn("/desk-fixture-missing-node", []) })
  assert.equal(result.state, "unresolved")
  assert.equal(result.reason, "worker_launch_failed")
  assert.equal(existsSync(f.starts), false)
})

test("nonfinite recovery budgets refuse before creating custody records", async (t) => {
  const f = fixture(t)
  for (const budget of [{ waitMs: NaN }, { lifetimeMs: Infinity }]) {
    const result = await syncWorkspace({ ...f, ...budget, spawnImpl: () => { throw new Error("No native dispatch allowed") } })
    assert.equal(result.reason, "invalid_recovery_budget")
    assert.equal(existsSync(f.env.XDG_STATE_HOME), false)
  }
})

test("the worker waits for its durable launch grant before accepting native custody", async (t) => {
  const f = fixture(t)
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 20000,
    spawnImpl: (...args) => {
      const child = spawn(...args)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800)
      assert.equal(existsSync(f.starts), false)
      return child
    } })
  const final = await settled(f, result.operation.id)
  assert.equal(final.state, "synced")
  assert.equal(final.custody, "accepted")
  assert.equal(readFileSync(f.starts, "utf8"), "start\n")
})

test("a route change cannot admit the old operation for the new destination", async (t) => {
  const f = fixture(t, { delay: 2 })
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 20000 })
  let state = readSyncStatus(f)?.recovery
  assert.equal(state.id, result.operation.id)
  const deadline = Date.now() + 15000
  while (!existsSync(f.starts) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(existsSync(f.starts), true)
  const substitute = path.join(f.dir, "substitute.git")
  mkdirSync(substitute)
  git(substitute, "init", "--bare", "-q")
  git(f.root, "remote", "set-url", "origin", substitute)
  state = await settled(f, result.operation.id)
  assert.equal(state.state, "blocked")
  assert.equal(state.reason, "binding_changed")
  assert.equal(git(substitute, "for-each-ref"), "")
  assert.equal(readFileSync(f.starts, "utf8"), "start\n")
})

test("a hung native helper has a finite lifetime and closes its exact process group", async (t) => {
  const f = fixture(t, { hang: true })
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 6000 })
  const final = await settled(f, result.operation.id, 18000)
  assert.equal(final.reason, "recovery_deadline")
  assert.equal(final.resources.childrenClosed, true)
  assert.equal(final.incoming.state, "unknown")
  assert.throws(() => process.kill(final.resources.childPid, 0), { code: "ESRCH" })
})

test("owner loss retains unknown custody and does not launch a replacement", async (t) => {
  const f = fixture(t, { hang: true })
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 15000 })
  const deadline = Date.now() + 15000
  let running = readSyncStatus(f)?.recovery
  while ((!existsSync(f.starts) || !running.resources.childPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    running = readSyncStatus(f)?.recovery
  }
  assert.ok(running.resources.childPid, "The owner must durably identify its native process group before recovery")
  try {
    assert.equal(await readProcessStart(running.owner.pid), running.owner.start)
    process.kill(running.owner.pid, "SIGKILL")
    await new Promise((resolve) => setTimeout(resolve, 100))
    const unknown = readSyncStatus(f).recovery
    assert.equal(unknown.state, "unknown")
    assert.equal(unknown.reason, "owner_lost")
    const joined = await syncWorkspace({ ...f, waitMs: 0 })
    assert.equal(joined.operation.id, result.operation.id)
    assert.equal(joined.state, "unresolved")
    assert.equal(readFileSync(f.starts, "utf8"), "start\n")
    assert.equal(await acquireSyncLock(f), null, "Outgoing workers cannot replace unknown incoming custody")
  } finally {
    const until = Date.now() + 5000
    let gone = false
    do {
      const observed = spawnSync("/bin/ps", [process.platform === "linux" ? "-s" : "-g", String(running.resources.group), "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 5000 })
      if (observed.status === 1 && !observed.stdout.trim() && !observed.stderr.trim()) { gone = true; break }
      assert.equal(observed.status, 0, observed.stderr || observed.error?.message)
      const members = observed.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/u))
        .filter(([, group, state]) => Number(group) === running.resources.group && !/^[ZX]/u.test(state ?? ""))
      gone = members.length === 0
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 25))
    } while (!gone && Date.now() < until)
    assert.equal(gone, true, "Product controllers must close the group after outer-owner loss without harness signaling")
    t.diagnostic(JSON.stringify({ operationId: running.id, lostOwner: running.owner,
      resources: running.resources, productObservedGroupClosure: gone, harnessSignals: [] }))
  }
})

for (const readback of ["ref_absent", "ref_present"]) test(`native-owner loss is read back and recovered once in the same fetch operation (${readback})`, async (t) => {
  const f = fixture(t)
  const once = path.join(f.dir, "first-native-start")
  if (readback === "ref_present") {
    const wrapper = path.join(f.dir, "bin", "git")
    writeFileSync(wrapper, `#!/bin/sh
if [ "$3" = fetch ]; then
  /usr/bin/git "$@"
  result=$?
  if [ "$result" = 0 ] && [ ! -e '${once}' ]; then
    printf fetched > '${once}'
    exec sleep 30
  fi
  exit "$result"
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  } else writeFileSync(path.join(f.dir, "upload-pack"), `#!/bin/sh
printf 'start\\n' >> '${f.starts}'
if [ ! -e '${once}' ]; then
  printf first > '${once}'
  exec sleep 30
fi
exec git-upload-pack "$@"
`)
  const result = await syncWorkspace({ ...f, waitMs: 0 })
  const end = Date.now() + 20000
  let running = readSyncStatus(f)?.recovery
  const ready = readback === "ref_present" ? once : f.starts
  while ((!existsSync(ready) || !running.resources.watchdog?.start) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    running = readSyncStatus(f)?.recovery
  }
  assert.equal(existsSync(ready), true)
  assert.equal(await readProcessStart(running.resources.childPid), running.resources.start)
  writeFileSync(path.join(f.dir, "loss-witness.json"), JSON.stringify(running.resources))
  process.kill(running.resources.childPid, "SIGKILL")
  const final = await settled(f, result.operation.id, 60000)
  assert.equal(final.state, "synced", JSON.stringify(final))
  assert.equal(final.incoming.attempts.length, 2)
  assert.equal(final.incoming.attempts[0].readback.state, readback)
  if (readback === "ref_present") assert.equal(final.incoming.attempts[0].readback.head, git(f.root, "rev-parse", "HEAD"))
  assert.equal(final.incoming.attempts[0].native.childrenClosed, true)
  assert.equal(final.resources.childrenClosed, true)
  assert.equal(readFileSync(f.starts, "utf8"), "start\nstart\n")
  t.diagnostic(JSON.stringify({ operationId: final.id, owner: final.owner, lossWitness: running.resources,
    attempts: final.incoming.attempts, resources: final.resources }))
})

test("unqualified executable reference hooks are reported before native fetch effects", async (t) => {
  const f = fixture(t)
  const marker = path.join(f.dir, "hook-was-run")
  writeFileSync(path.join(f.root, ".git", "hooks", "reference-transaction"),
    `#!/bin/sh\nprintf invoked > '${marker}'\n`, { mode: 0o700 })
  const result = await syncWorkspace({ ...f, waitMs: 0 })
  const final = await settled(f, result.operation.id)
  assert.equal(final.state, "blocked")
  assert.equal(final.reason, "native_hooks_not_qualified")
  assert.equal(final.incoming.state, "not_dispatched")
  assert.equal(existsSync(f.starts), false)
  assert.equal(existsSync(marker), false)
})

test("a damaged lock never grants replacement custody", async (t) => {
  const f = fixture(t)
  const lock = resolveSyncLockPath(f)
  mkdirSync(path.dirname(lock), { recursive: true })
  writeFileSync(lock, "{damaged")
  const claimed = await acquireSyncLock(f)
  claimed?.release?.()
  assert.equal(claimed, null)
  assert.equal(readFileSync(lock, "utf8"), "{damaged")
})

test("a permission refusal does not establish that the previous lock owner is dead", async (t) => {
  const f = fixture(t)
  const lock = resolveSyncLockPath(f)
  mkdirSync(path.dirname(lock), { recursive: true })
  const bytes = JSON.stringify({ token: "protected-owner", pid: process.pid, start: "unverifiable" })
  writeFileSync(lock, bytes)
  const claim = await acquireSyncLock({ ...f, processStart: async () => null,
    kill: () => { throw Object.assign(new Error("Cannot inspect owner"), { code: "EPERM" }) } })
  claim?.release?.()
  assert.equal(claim, null)
  assert.equal(readFileSync(lock, "utf8"), bytes)
})

test("two failed fetches recover on subsequent owned attempts without duplicate dispatch", async (t) => {
  const f = fixture(t)
  const helper = path.join(f.dir, "upload-pack")
  for (let cycle = 0; cycle < 2; cycle += 1) {
    writeFileSync(helper, `#!/bin/sh\nprintf 'failed\\n' >> '${f.starts}'\nexit 1\n`)
    const failed = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 20000 })
    const failure = await settled(f, failed.operation.id)
    assert.equal(failure.reason, "fetch_failed")
    assert.equal(failure.incoming.state, "unknown")
    writeFileSync(helper, `#!/bin/sh\nprintf 'recovered\\n' >> '${f.starts}'\nexec git-upload-pack "$@"\n`)
    const retry = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 20000 })
    const recovered = await settled(f, retry.operation.id)
    assert.notEqual(recovered.id, failure.id)
    assert.equal(recovered.state, "synced", JSON.stringify(recovered))
    assert.equal(recovered.source.head, git(f.root, "rev-parse", "HEAD"))
  }
  assert.equal(readFileSync(f.starts, "utf8"), "failed\nrecovered\nfailed\nrecovered\n")
  mkdirSync(path.join(f.root, "_meta"))
  mkdirSync(path.join(f.root, "_archive"))
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  for (let fresh = 0; fresh < 2; fresh += 1) {
    const started = performance.now()
    const boot = spawnSync(process.execPath, [script, "--json"], { cwd: f.root,
      env: { ...f.env, DESK: f.root, DESK_NONINTERACTIVE: "1" }, encoding: "utf8", timeout: 6000 })
    const elapsed = performance.now() - started
    t.diagnostic(JSON.stringify({ freshBootAfterRecovery: fresh + 1, coldEntryMs: elapsed, exitCode: boot.status }))
    assert.equal(boot.status, 0, boot.stderr || boot.error?.message)
    assert.ok(elapsed <= 3000)
    const final = await settled(f, JSON.parse(boot.stdout).sync.operation.id)
    const syncDir = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
    const folder = readdirSync(syncDir).find((name) => name.endsWith(".recovery"))
    const raw = JSON.parse(readFileSync(path.join(syncDir, folder, `${final.id}.json`), "utf8"))
    t.diagnostic(JSON.stringify({ freshBootBeforeAnyNextAttempt: fresh + 1, observed: final, rawOperation: raw }))
    assert.equal(final.state, "synced", JSON.stringify(final))
    assert.equal(final.incoming.head, git(f.root, "rev-parse", "HEAD"))
    assert.equal(final.outgoing.state, "verified")
  }
  assert.equal(readFileSync(f.starts, "utf8"), "failed\nrecovered\nfailed\nrecovered\nrecovered\nrecovered\n")
})

test("fetch equality does not prove delivery to a different push route", async (t) => {
  const f = fixture(t)
  const destination = path.join(f.dir, "push.git")
  mkdirSync(destination)
  git(destination, "init", "--bare", "-q")
  git(f.root, "remote", "set-url", "--push", "origin", destination)
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 20000 })
  const final = await settled(f, result.operation.id)
  assert.equal(final.state, "blocked")
  assert.equal(final.outgoing.state, "unknown")
  assert.equal(final.reason, "delivery_route_verification_required")
  assert.equal(git(destination, "for-each-ref"), "")
})

test("graph equality never claims required LFS bytes are available", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "asset"), "version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 42\n")
  git(f.root, "add", "asset")
  git(f.root, "commit", "-qm", "LFS pointer without hydration")
  git(f.root, "push", "-q")
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 20000 })
  const final = await settled(f, result.operation.id)
  assert.equal(final.state, "blocked")
  assert.equal(final.reason, "lfs_custody_required")
  assert.equal(final.lfs.state, "not_verified")
})

test("an unqualified network route is refused before native dispatch", async (t) => {
  const f = fixture(t)
  git(f.root, "remote", "set-url", "origin", "http://127.0.0.1:1/unqualified.git")
  const result = await syncWorkspace({ ...f, waitMs: 0, lifetimeMs: 20000 })
  const final = await settled(f, result.operation.id)
  assert.equal(final.reason, "native_transport_not_qualified")
  assert.equal(final.incoming.state, "not_dispatched")
  assert.equal(existsSync(f.starts), false)
})

test("pending custody does not overwrite the last incoming failure or record a success time", async (t) => {
  const f = fixture(t)
  updateSyncStatus(f.root, f.env, { last_pull: { state: "unresolved", reason: "previous incoming failure" } })
  recordPullOutcome({ ...f, result: { state: "recovering" } })
  const recorded = readSyncStatus(f)
  assert.equal(recorded.last_pull?.reason, "previous incoming failure")
  assert.equal(recorded.last_success_at, undefined)
})

test("a damaged operation cannot become success or replacement authority", async (t) => {
  const f = fixture(t)
  const result = await syncWorkspace({ ...f, waitMs: 0, spawnImpl: () => { throw new Error("No worker dispatched") } })
  const syncDir = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
  const directory = path.join(syncDir, readdirSync(syncDir).find((name) => name.endsWith(".recovery")))
  writeFileSync(path.join(directory, "active.json"), JSON.stringify({ id: result.operation.id }))
  for (const damaged of [JSON.stringify({ id: result.operation.id, state: "synced", finalized: true }), "{damaged"]) {
    writeFileSync(path.join(directory, `${result.operation.id}.json`), damaged)
    const unknown = readSyncStatus(f).recovery
    assert.equal(unknown?.state, "unknown")
    assert.equal(unknown.reason, "recovery_record_invalid")
  }
  const joined = await syncWorkspace({ ...f, waitMs: 0 })
  assert.equal(joined.operation.id, result.operation.id)
  assert.equal(joined.state, "unresolved")
  assert.equal(existsSync(f.starts), false)
})

test("large offline desks return from cold entry without scanning or contacting the remote", async (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, "_meta"))
  mkdirSync(path.join(f.root, "_archive"))
  const track = path.join(f.root, "large")
  mkdirSync(track)
  for (let index = 0; index < 1500; index += 1) {
    const task = path.join(track, `pending-${index}`)
    mkdirSync(task)
    writeFileSync(path.join(task, "task.md"), `---\nstatus: processing\n---\n# Pending ${index}\n`)
  }
  git(f.root, "remote", "set-url", "origin", path.join(f.dir, "missing-origin.git"))
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  const started = performance.now()
  const boot = spawnSync(process.execPath, [script, "--json"], { cwd: f.root,
    env: { ...f.env, DESK: f.root, DESK_NONINTERACTIVE: "1" }, encoding: "utf8", timeout: 6000 })
  const elapsed = performance.now() - started
  t.diagnostic(JSON.stringify({ pendingTasks: 1500, coldEntryMs: elapsed, exitCode: boot.status }))
  assert.equal(boot.status, 0, boot.stderr || boot.error?.message)
  assert.ok(elapsed <= 3000)
  assert.equal(JSON.parse(boot.stdout).active_tasks, null)
  assert.equal(existsSync(f.starts), false)
  const final = await settled(f, JSON.parse(boot.stdout).sync.operation.id)
  assert.equal(final.reason, "fetch_failed")
  assert.ok(final.checks, "Independent background checks still settle when sync cannot reach its remote")
  assert.notEqual(final.checks.state, "running")
})

test("blocked migration helpers stay in the background on two cold starts", async (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, "_meta"))
  mkdirSync(path.join(f.root, "_archive"))
  const marker = path.join(f.dir, "migration-pid")
  const bash = path.join(f.dir, "bin", "bash")
  writeFileSync(bash, `#!/bin/sh\nprintf '%s\\n' "$$" > '${marker}'\nexec sleep 30\n`)
  chmodSync(bash, 0o700)
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  let id
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const started = performance.now()
    const boot = spawnSync(process.execPath, [script, "--json"], { cwd: f.root,
      env: { ...f.env, DESK: f.root, DESK_NONINTERACTIVE: "1" }, encoding: "utf8", timeout: 6000 })
    const elapsed = performance.now() - started
    t.diagnostic(JSON.stringify({ blockedMigrationColdStart: cycle + 1, coldEntryMs: elapsed, exitCode: boot.status }))
    assert.equal(boot.status, 0, boot.stderr || boot.error?.message)
    assert.ok(elapsed <= 3000)
    const operation = JSON.parse(boot.stdout).sync.operation
    if (id) assert.equal(operation.id, id)
    id = operation.id
  }
  const final = await settled(f, id)
  assert.equal(existsSync(marker), true, "The real background migration runner reached the owned slow helper")
  assert.equal(final.incoming.state, "verified")
  assert.equal(final.checks.state, "blocked")
  assert.equal(final.checks.reason, "migration_check_incomplete")
  assert.equal(final.resources.childrenClosed, true)
  assert.throws(() => process.kill(Number(readFileSync(marker, "utf8").trim()), 0), { code: "ESRCH" })
})

test("a production-sized incomplete inspection recovers in the same owned operation", async (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, "_meta"))
  mkdirSync(path.join(f.root, "_archive"))
  const delayed = path.join(f.dir, "setup-delay-used")
  const wrapper = path.join(f.dir, "bin", "git")
  writeFileSync(wrapper, `#!/bin/sh
if [ "$3" = rev-parse ] && [ "$4" = --is-inside-work-tree ] && [ ! -e ${JSON.stringify(delayed)} ]; then
  printf delayed > ${JSON.stringify(delayed)}
  sleep 2.2
fi
exec /usr/bin/git "$@"
`)
  chmodSync(wrapper, 0o700)
  const result = await syncWorkspace({ ...f, waitMs: 0, bootChecks: true })
  const final = await settled(f, result.operation.id, 60000)
  assert.equal(existsSync(delayed), true)
  assert.equal(final.checks.attempts?.length, 2)
  assert.equal(final.checks.attempts[0].reason, "migration_check_incomplete")
  assert.notEqual(final.checks.migration, "unknown")
  assert.notEqual(final.checks.reason, "migration_check_incomplete")
  assert.equal(final.resources.childrenClosed, true)
  assert.equal(readFileSync(f.starts, "utf8"), "start\n", "Read-only recovery must not repeat the successful fetch")
  assert.equal(existsSync(path.join(f.root, ".git", "hooks", "pre-commit")), false)
})

test("a task commit during background inspection invalidates pre-inspection source equality", async (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, "_meta"))
  mkdirSync(path.join(f.root, "_archive"))
  const marker = path.join(f.dir, "inspection-started")
  const bash = path.join(f.dir, "bin", "bash")
  writeFileSync(bash, `#!/bin/sh\nprintf started > '${marker}'\nexec sleep 30\n`)
  chmodSync(bash, 0o700)
  writeFileSync(path.join(f.dir, "bin", "gh"), "#!/bin/sh\nexec sleep 6\n")
  const before = git(f.root, "rev-parse", "HEAD")
  const result = await syncWorkspace({ ...f, waitMs: 0, bootChecks: true })
  const deadline = Date.now() + 20000
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(existsSync(marker), true)
  writeFileSync(path.join(f.root, "seed"), "the task committed while inspection ran\n")
  git(f.root, "add", "seed")
  git(f.root, "commit", "-qm", "concurrent owned task commit")
  const after = git(f.root, "rev-parse", "HEAD")
  assert.notEqual(after, before)
  const final = await settled(f, result.operation.id, 60000)
  assert.equal(final.state, "blocked")
  assert.equal(final.reason, "local_source_changed")
  assert.equal(final.source.head, after)
  assert.equal(final.source.state, "blocked")
  assert.equal(final.incoming.head, before)
  assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), before)
  assert.equal(git(f.root, "show", "HEAD:seed"), "the task committed while inspection ran")
})

test("a route change during background inspection cannot admit the previous binding", async (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.root, "_meta"))
  mkdirSync(path.join(f.root, "_archive"))
  const marker = path.join(f.dir, "inspection-started")
  const bash = path.join(f.dir, "bin", "bash")
  writeFileSync(bash, `#!/bin/sh\nprintf started > '${marker}'\nexec sleep 30\n`)
  chmodSync(bash, 0o700)
  writeFileSync(path.join(f.dir, "bin", "gh"), "#!/bin/sh\nexec sleep 6\n")
  const result = await syncWorkspace({ ...f, waitMs: 0, bootChecks: true })
  const deadline = Date.now() + 20000
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(existsSync(marker), true)
  const substitute = path.join(f.dir, "never-used.git")
  mkdirSync(substitute)
  git(substitute, "init", "--bare", "-q")
  git(f.root, "remote", "set-url", "origin", substitute)
  const final = await settled(f, result.operation.id, 60000)
  assert.equal(final.state, "blocked")
  assert.equal(final.reason, "binding_changed")
  assert.equal(final.source.state, "unknown")
  assert.equal(git(substitute, "for-each-ref"), "")
})
