import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkTempRoot } from "../_temp_roots.js"
import { reserveQuarantineDir, syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { readSyncStatus, recordPullOutcome, runPushWorker, syncStatusPath, updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { pullStillFailing } from "../../../../../plugins/desk/mcp/src/runtime/health.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { syncSummary } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

const fileProblem = () => ({ file: "synthetic; no filing" })
const clock = { sleep: async () => {} }
const pending = "staged bytes\nworking bytes\n"

function run(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000 })
}

function git(root, args) {
  const result = run(root, args)
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

async function root(t, label) {
  const directory = await mkTempRoot(`desk-sync-safety-${label}-`)
  process.stdout.write(`# owned fixture created: ${directory}\n`)
  return directory
}

async function commit(directory, name, bytes, message) {
  await fs.writeFile(path.join(directory, name), bytes)
  git(directory, ["add", "--", name])
  git(directory, ["commit", "-q", "-m", message])
}

async function fixture(t, { diverged = true } = {}) {
  const origin = await root(t, "origin")
  git(origin, ["init", "--bare", "-q", "--initial-branch=main"])
  const local = await root(t, "local")
  git(local, ["clone", "-q", origin, "."])
  git(local, ["config", "user.name", "Synthetic"])
  git(local, ["config", "user.email", "synthetic@example.invalid"])
  await commit(local, "seed.md", "base\n", "seed")
  await commit(local, "pending.md", "baseline\n", "pending baseline")
  git(local, ["push", "-q", "-u", "origin", "main"])
  const other = await root(t, "other")
  git(other, ["clone", "-q", origin, "."])
  git(other, ["config", "user.name", "Other"])
  git(other, ["config", "user.email", "other@example.invalid"])
  if (diverged) {
    await commit(other, "seed.md", "remote intent\n", "remote intent")
    git(other, ["push", "-q"])
    await commit(local, "seed.md", "local intent\n", "local intent")
    git(local, ["fetch", "-q", "origin"])
  }
  return { origin, local, other }
}

async function pendingWork(local) {
  await fs.writeFile(path.join(local, "pending.md"), "staged bytes\n")
  git(local, ["add", "--", "pending.md"])
  await fs.writeFile(path.join(local, "pending.md"), pending)
  await fs.writeFile(path.join(local, "draft.bin"), Buffer.from([0, 255, 13, 10, 0]))
}

async function snapshot(local) {
  const admin = git(local, ["rev-parse", "--absolute-git-dir"])
  const operations = {}
  for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD"]) {
    try {
      const file = path.join(admin, name)
      const info = await fs.lstat(file)
      operations[name] = info.isDirectory()
        ? Object.fromEntries(await Promise.all((await fs.readdir(file)).sort().map(async (entry) => {
          const bytes = await fs.readFile(path.join(file, entry))
          return [entry, bytes.toString("base64")]
        })))
        : (await fs.readFile(file)).toString("base64")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  const files = {}
  for (const name of ["seed.md", "pending.md", "draft.bin"]) {
    try { files[name] = (await fs.readFile(path.join(local, name))).toString("base64") } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return {
    head: git(local, ["rev-parse", "HEAD"]),
    index: git(local, ["ls-files", "--stage", "-z"]),
    stash: git(local, ["stash", "list", "--format=%H"]),
    reflog: git(local, ["reflog", "--format=%H %gs"]),
    operations,
    files,
  }
}

function startup(local, options = {}) {
  return syncWorkspace({ root: local, env: process.env, fileProblem, ...options })
}

function worker(local, options = {}) {
  return runPushWorker({ root: local, env: process.env, clock, fileProblem, ...options })
}

test("known non-Git folders keep the no-remote behavior without treating read errors as absence", async (t) => {
  const local = await root(t, "non-git")
  assert.deepEqual(await startup(local), { state: "synced", nothingToSync: "no_remote" })
  assert.deepEqual(await worker(local), { result: "skipped" })
  await fs.mkdir(path.join(local, ".git", "rebase-merge"), { recursive: true })
  assert.equal((await startup(local)).state, "unresolved", "unreadable Git metadata is not a plain folder")
})

for (const actor of ["startup", "worker"]) {
  test(`${actor} preserves a pre-existing rebase and autostash across repeated calls`, async (t) => {
    const { local } = await fixture(t)
    await pendingWork(local)
    const rebase = run(local, ["rebase", "--autostash", "origin/main"])
    assert.equal(rebase.status, 1)
    await fs.writeFile(path.join(local, "seed.md"), "unfinished resolution\n")
    const before = await snapshot(local)
    assert.ok(before.operations["rebase-merge"].autostash)
    for (let cycle = 0; cycle < 2; cycle++) {
      const result = await (actor === "startup" ? startup(local) : worker(local))
      assert.equal(actor === "startup" ? result.state : result.result, actor === "startup" ? "unresolved" : "blocked")
      assert.equal(result.reason, "git_operation_in_progress")
      assert.equal(result.cleanup.state, "not_attempted")
      assert.deepEqual(await snapshot(local), before)
    }
  })

  test(`${actor} refuses an unmerged index even without an operation marker`, async (t) => {
    const { local } = await fixture(t)
    const blob = git(local, ["rev-parse", "HEAD:seed.md"])
    const input = `100644 ${blob} 1\tseed.md\n100644 ${blob} 2\tseed.md\n100644 ${blob} 3\tseed.md\n`
    const updated = spawnSync("git", ["-C", local, "update-index", "--index-info"], { input, encoding: "utf8" })
    assert.equal(updated.status, 0, updated.stderr)
    const before = await snapshot(local)
    const result = await (actor === "startup" ? startup(local) : worker(local))
    assert.equal(actor === "startup" ? result.state : result.result, actor === "startup" ? "unresolved" : "blocked")
    assert.equal(result.reason, "unmerged_index")
    assert.deepEqual(await snapshot(local), before)
  })

  test(`${actor} treats a failed safety read as unknown rather than no work to sync`, async (t) => {
    const { local } = await fixture(t, { diverged: false })
    const result = await (actor === "startup" ? startup(local, {
      spawnGit(command, args, options) {
        if (args[2] === "ls-files") return { status: 128, stdout: "", stderr: "synthetic read denied" }
        return spawnSync(command, args, options)
      },
    }) : worker(local, {
      spawnGit(command, args, options) {
        if (args[2] === "ls-files") return { status: 128, stdout: "", stderr: "synthetic read denied" }
        return spawnSync(command, args, options)
      },
    }))
    assert.equal(actor === "startup" ? result.state : result.result, actor === "startup" ? "unresolved" : "blocked")
    assert.equal(result.reason, "git_state_unavailable")
    assert.equal(result.cleanup.state, "not_attempted")
  })
}

test("startup preserves staged and working bytes rather than replaying divergent history", async (t) => {
  const { local } = await fixture(t)
  await pendingWork(local)
  const before = await snapshot(local)
  for (let cycle = 0; cycle < 2; cycle++) {
    const result = await startup(local)
    assert.equal(result.state, "unresolved")
    assert.deepEqual(await snapshot(local), before)
  }
})

for (const withPending of [false, true]) test(`healthy fast-forward preserves ${withPending ? "disjoint staged and working content" : "the ordinary clean-checkout path"}`, async (t) => {
  const { local, other } = await fixture(t, { diverged: false })
  await commit(other, "seed.md", "incoming\n", "incoming")
  git(other, ["push", "-q"])
  if (withPending) await pendingWork(local)
  const index = git(local, ["ls-files", "--stage", "--", "pending.md"])
  const result = await startup(local)
  assert.deepEqual(result, { state: "synced" })
  assert.equal(git(local, ["rev-parse", "HEAD"]), git(other, ["rev-parse", "HEAD"]))
  assert.equal(git(local, ["ls-files", "--stage", "--", "pending.md"]), index)
  assert.equal(await fs.readFile(path.join(local, "seed.md"), "utf8"), "incoming\n")
  if (withPending) {
    assert.equal(await fs.readFile(path.join(local, "pending.md"), "utf8"), pending)
    assert.deepEqual(await fs.readFile(path.join(local, "draft.bin")), Buffer.from([0, 255, 13, 10, 0]))
  }
  assert.equal(readSyncStatus({ root: local, env: process.env }).last_pull, null)
})

test("startup does not autostash even when repository configuration enables it", async (t) => {
  const { local, other } = await fixture(t, { diverged: false })
  await commit(other, "seed.md", "incoming\n", "incoming")
  git(other, ["push", "-q"])
  git(local, ["config", "pull.rebase", "true"])
  git(local, ["config", "merge.autostash", "true"])
  git(local, ["config", "rebase.autostash", "true"])
  await fs.writeFile(path.join(local, "seed.md"), "pending intent\n")
  const before = await snapshot(local)
  const result = await startup(local)
  assert.equal(result.state, "unresolved")
  assert.deepEqual(await snapshot(local), before)
})

test("startup never aborts over bytes that arrive after a failed pull", async (t) => {
  const { local } = await fixture(t)
  await pendingWork(local)
  const arriving = `${pending}arriving writer\n`
  let arrived = false
  const result = await startup(local, {
    spawnGit(command, args, options) {
      const answer = spawnSync(command, args, options)
      if (args[2] === "pull" && answer.status !== 0) {
        writeFileSync(path.join(local, "pending.md"), arriving)
        arrived = true
      }
      return answer
    },
  })
  assert.equal(arrived, true)
  assert.equal(result.state, "unresolved")
  assert.equal(readFileSync(path.join(local, "pending.md"), "utf8"), arriving)
  assert.equal(result.cleanup.state, "not_attempted")
})

test("a failed worker push preserves the source instead of rebasing and retrying", async (t) => {
  const { local } = await fixture(t)
  await pendingWork(local)
  const before = await snapshot(local)
  const result = await worker(local)
  assert.equal(result.result, "blocked")
  assert.equal(result.reason, "push_rejected")
  assert.equal(result.effects.push, "not_applied")
  assert.deepEqual(await snapshot(local), before)
})

test("a push whose answer is lost stays unknown without replay after remote application", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  const head = git(local, ["rev-parse", "HEAD"])
  let pushes = 0
  const result = await worker(local, {
    spawnGit(command, args, options) {
      const answer = spawnSync(command, args, options)
      if (args[2] !== "push") return answer
      pushes++
      assert.equal(answer.status, 0, answer.stderr)
      return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("answer lost"), { code: "ETIMEDOUT" }) }
    },
  })
  assert.equal(git(local, ["ls-remote", "origin", "refs/heads/main"]).split(/\s/u)[0], head)
  assert.equal(result.result, "blocked")
  assert.equal(result.effects.push, "unknown")
  assert.equal(pushes, 1)
  assert.equal(readSyncStatus({ root: local, env: process.env }).effects.push, "unknown")
  const again = await worker(local, {
    spawnGit(command, args, options) {
      if (args[2] === "push") pushes++
      return spawnSync(command, args, options)
    },
  })
  assert.equal(again.result, "blocked")
  assert.equal(again.effects.push, "unknown")
  assert.equal(pushes, 1, "a later worker does not infer non-delivery from an earlier timeout")
})

test("partial quarantine failure reports every moved file without retry or hidden cleanup", async (t) => {
  const { local, other } = await fixture(t, { diverged: false })
  await commit(other, "first.txt", "incoming first\n", "first")
  await commit(other, "second.txt", "incoming second\n", "second")
  git(other, ["push", "-q"])
  await fs.writeFile(path.join(local, "first.txt"), "pending first\n")
  await fs.writeFile(path.join(local, "second.txt"), "pending second\n")
  const rename = fs.rename
  let pulls = 0
  try {
    fs.rename = async (from, to) => {
      if (from === path.join(local, "second.txt")) throw Object.assign(new Error("synthetic quarantine denied"), { code: "EACCES" })
      return rename(from, to)
    }
    const result = await startup(local, {
      spawnGit(command, args, options) {
        if (args[2] === "pull") pulls++
        return spawnSync(command, args, options)
      },
    })
    assert.equal(result.state, "unresolved")
    assert.equal(result.reason, "quarantine_failed")
    assert.equal(pulls, 1)
    assert.equal(result.quarantinedPaths.length, 1)
    assert.equal(await fs.readFile(path.join(local, result.quarantinedPaths[0]), "utf8"), "pending first\n")
    assert.equal(await fs.readFile(path.join(local, "second.txt"), "utf8"), "pending second\n")
    assert.equal(result.cleanup.state, "not_attempted")
    assert.match(result.error, /quarantine denied/u)
  } finally {
    fs.rename = rename
  }
})

test("an uncertain pull that names untracked blockers never authorizes quarantine or replay", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await fs.writeFile(path.join(local, "stray.txt"), "pending stray\n")
  let pulls = 0
  const result = await startup(local, {
    spawnGit(command, args, options) {
      if (args[2] === "pull") {
        pulls++
        return { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "The following untracked working tree files would be overwritten by merge:\n\tstray.txt\n" }
      }
      return spawnSync(command, args, options)
    },
  })
  assert.equal(result.state, "unresolved")
  assert.equal(result.cause, "deadline")
  assert.equal(result.effects.pull, "unknown")
  assert.equal(result.quarantinedPaths, undefined)
  assert.equal(await fs.readFile(path.join(local, "stray.txt"), "utf8"), "pending stray\n")
  assert.equal(pulls, 1)
})

test("overlapping quarantine reservations cannot share a same-day destination", async (t) => {
  const local = await root(t, "quarantine")
  const [first, second] = await Promise.all([reserveQuarantineDir(local), reserveQuarantineDir(local)])
  assert.notEqual(first, second)
  await fs.writeFile(path.join(first, "pending.txt"), "pending first\n")
  await fs.writeFile(path.join(second, "pending.txt"), "pending second\n")
  assert.equal(await fs.readFile(path.join(first, "pending.txt"), "utf8"), "pending first\n")
  assert.equal(await fs.readFile(path.join(second, "pending.txt"), "utf8"), "pending second\n")
})

for (const [label, failure, cause, effect] of [
  ["credentials refused", { status: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://user:token@github.com/o/r.git/'" }, "auth_failed", "unknown"],
  ["network unavailable", { status: 128, stdout: "", stderr: "fatal: Could not resolve host: example.invalid" }, "unreachable", "unknown"],
  ["timeout", { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }, "deadline", "unknown"],
  ["timeout beside a zero exit status", { status: 0, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }, "deadline", "unknown"],
  ["mixed applied and rejected refs", { status: 1, stdout: " \trefs/heads/a:refs/heads/a\told..new\n!\trefs/heads/b:refs/heads/b\t[rejected]\n", stderr: "" }, "other", "unknown"],
  ["confirmed rejection", { status: 1, stdout: "!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\n", stderr: "" }, "rejected", "not_applied"],
]) test(`worker distinguishes ${label} without rewriting or retrying`, async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  const before = await snapshot(local)
  let pushes = 0
  const result = await worker(local, {
    spawnGit(command, args, options) {
      if (args[2] === "push") {
        pushes++
        if (pushes > 1) return { status: 128, stdout: "", stderr: "unexpected replay" }
        return failure
      }
      return spawnSync(command, args, options)
    },
  })
  assert.equal(result.result, "blocked")
  assert.equal(result.cause, cause)
  assert.equal(result.effects.push, effect)
  assert.equal(pushes, 1)
  assert.deepEqual(await snapshot(local), before)
  assert.doesNotMatch(result.error, /user:token/u)
})

test("a pull with a timeout beside a zero exit status remains unknown", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  const result = await startup(local, {
    spawnGit(command, args, options) {
      if (args[2] === "pull") return { status: 0, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }
      return spawnSync(command, args, options)
    },
  })
  assert.equal(result.state, "unresolved")
  assert.equal(result.cause, "deadline")
  assert.equal(result.effects.pull, "unknown")
})

test("the worker records an unknown attempt before dispatch and preserves it when dispatch is interrupted", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  let observed
  await assert.rejects(worker(local, {
    spawnGit(command, args, options) {
      if (args[2] === "push") {
        observed = readSyncStatus({ root: local, env: process.env })
        throw new Error("synthetic interruption")
      }
      return spawnSync(command, args, options)
    },
  }), /synthetic interruption/u)
  assert.equal(observed?.effects?.push, "unknown")
  assert.equal(typeof observed.push_attempt, "string")
  const result = await worker(local)
  assert.equal(result.result, "blocked")
  assert.equal(result.effects.push, "unknown")
})

test("an unreadable prior status cannot authorize a worker push", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  const file = syncStatusPath({ root: local, env: process.env })
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "{broken prior status\n")
  let pushes = 0
  const result = await worker(local, {
    spawnGit(command, args, options) {
      if (args[2] === "push") pushes++
      return spawnSync(command, args, options)
    },
  })
  assert.equal(result.result, "blocked")
  assert.equal(result.reason, "sync_status_unavailable")
  assert.equal(pushes, 0)
  assert.equal(await fs.readFile(file, "utf8"), "{broken prior status\n")
})

test("an unknown incoming outcome blocks a later startup until readback, not a blind pull retry", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  let pulls = 0
  const spawnGit = (command, args, options) => {
    if (args[2] === "pull") {
      pulls++
      return { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }
    }
    return spawnSync(command, args, options)
  }
  const first = await startup(local, { spawnGit })
  assert.equal(first.effects.pull, "unknown")
  const second = await startup(local, { spawnGit })
  assert.equal(second.state, "unresolved")
  assert.equal(second.effects.pull, "unknown")
  assert.equal(pulls, 1)
})

test("startup records an unknown incoming attempt before dispatch can be interrupted", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  let observed
  await assert.rejects(startup(local, {
    spawnGit(command, args, options) {
      if (args[2] === "pull") {
        observed = readSyncStatus({ root: local, env: process.env })?.last_pull
        throw new Error("synthetic incoming interruption")
      }
      return spawnSync(command, args, options)
    },
  }), /synthetic incoming interruption/u)
  assert.equal(observed?.effects?.pull, "unknown")
  assert.equal(typeof observed.attempt, "string")
  const result = await startup(local)
  assert.equal(result.state, "unresolved")
  assert.equal(result.effects.pull, "unknown")
})

test("timestamps and a later push cannot expire an unknown incoming effect", () => {
  assert.equal(pullStillFailing({
    lastPull: { state: "unresolved", cause: "deadline", at: "2020-01-01T00:00:00Z", effects: { pull: "unknown" } },
    lastPushAt: "2026-01-01T00:00:00Z", fetchedAt: "2026-01-01T00:00:00Z",
  }), true)
})

test("status advice never sends an unknown outcome into a rebase/autostash retry", () => {
  const result = compactStatus({
    status: "ok", root: { path: "/synthetic", valid: true },
    sync: { last_pull: { state: "unresolved", cause: "deadline", effects: { pull: "unknown" } } },
  })
  assert.doesNotMatch(result.fix, /pull --rebase|pull.*--autostash/u)
  assert.match(result.fix, /read.*back|readback|Read.*status/u)
  const outgoing = compactStatus({ status: "ok", root: { path: "/synthetic", valid: true },
    sync: { blocked: true, reason: "push_failed", effects: { push: "unknown" } } })
  assert.match(outgoing.sync, /unknown/u)
})

test("boot distinguishes an unattempted pull from unknown incoming effects", () => {
  const unknown = syncSummary({ sync: { state: "unresolved", cause: "deadline", effects: { pull: "unknown" } } })
  assert.match(unknown, /unknown|unverified/u)
  assert.doesNotMatch(unknown, /nothing was pulled/u)
  const paused = syncSummary({ sync: { state: "unresolved", reason: "git_operation_in_progress", effects: { pull: "not_attempted" } } })
  assert.match(paused, /not attempted|before pulling/u)
})

test("a stale startup cannot replace another incoming attempt or clear its timeout", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  let resolveFirst
  let resolveSecond
  const firstAnswer = new Promise((resolve) => { resolveFirst = resolve })
  const secondAnswer = new Promise((resolve) => { resolveSecond = resolve })
  let second
  let secondId
  let dispatched = 0
  let timedOutMarker
  const first = startup(local, {
    spawnGit(command, args, options) {
      const answer = spawnSync(command, args, options)
      if (args[2] === "rev-list" && !second) {
        second = startup(local, {
          spawnPull() {
            dispatched++
            secondId = readSyncStatus({ root: local, env: process.env }).last_pull.attempt
            return secondAnswer
          },
        })
      }
      return answer
    },
    spawnPull() {
      dispatched++
      return firstAnswer
    },
  })
  try {
    assert.ok(second)
    resolveSecond({ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } })
    await second
    timedOutMarker = readSyncStatus({ root: local, env: process.env }).last_pull
  } finally {
    resolveFirst({ status: 0, stdout: "", stderr: "" })
    resolveSecond({ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } })
    await Promise.all([first, second])
  }
  await startup(local, { spawnPull() { dispatched++; return { status: 0, stdout: "", stderr: "" } } })
  assert.equal(timedOutMarker?.attempt, secondId, "a timeout keeps the ID of the attempt that actually dispatched")
  assert.equal(readSyncStatus({ root: local, env: process.env }).last_pull?.effects.pull, "unknown")
  assert.equal(dispatched, 1, "an older pre-reservation snapshot cannot authorize another dispatch")
})

test("incoming settlement compares its own attempt ID rather than adopting the current ID", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  updateSyncStatus(local, process.env, { last_pull: {
    state: "unresolved", reason: "pull_in_progress", attempt: "current-owner", effects: { pull: "unknown" },
  } })
  const file = syncStatusPath({ root: local, env: process.env })
  const before = await fs.readFile(file, "utf8")
  assert.equal(recordPullOutcome({ root: local, env: process.env, attempt: "stale-owner", result: { state: "synced" } }), null)
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("an incoming owner cannot settle without a recognized outcome or erase missing effect evidence", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  updateSyncStatus(local, process.env, { last_pull: {
    state: "unresolved", reason: "pull_in_progress", attempt: "owner", effects: { pull: "unknown" },
  } })
  const file = syncStatusPath({ root: local, env: process.env })
  const before = await fs.readFile(file, "utf8")
  for (const result of [undefined, {}, { state: "prepared" }]) {
    assert.equal(recordPullOutcome({ root: local, env: process.env, attempt: "owner", result }), null)
    assert.equal(await fs.readFile(file, "utf8"), before)
  }
  recordPullOutcome({ root: local, env: process.env, attempt: "owner",
    result: { state: "unresolved", reason: "result incomplete" } })
  assert.equal(readSyncStatus({ root: local, env: process.env }).last_pull.effects?.pull, "unknown")
})

test("a successful push cannot erase an incoming attempt created after its snapshot", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  let inserted = false
  const result = await worker(local, {
    spawnGit(command, args, options) {
      const answer = spawnSync(command, args, options)
      if (args[2] === "rev-list" && answer.stdout.trim() === "0\t0" && !inserted) {
        inserted = true
        recordPullOutcome({ root: local, env: process.env, result: {
          state: "unresolved", reason: "pull_in_progress", attempt: "new-incoming", effects: { pull: "unknown" },
        } })
      }
      return answer
    },
  })
  assert.equal(result.result, "ok")
  assert.equal(inserted, true)
  assert.equal(readSyncStatus({ root: local, env: process.env }).last_pull?.attempt, "new-incoming")
})

test("status lock contention cannot authorize safety dispatch or an unlocked write", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  const file = syncStatusPath({ root: local, env: process.env })
  updateSyncStatus(local, process.env, { sentinel: "retain this record" })
  const before = await fs.readFile(file, "utf8")
  const lock = `${file}.lock`
  await fs.writeFile(lock, "another writer owns this lock\n")
  let dispatched = 0
  try {
    const result = await startup(local, {
      spawnPull() { dispatched++; return { status: 0, stdout: "", stderr: "" } },
    })
    assert.equal(result.state, "unresolved")
    assert.equal(dispatched, 0)
    assert.equal(await fs.readFile(file, "utf8"), before)
    assert.equal(await fs.readFile(lock, "utf8"), "another writer owns this lock\n")
  } finally {
    await fs.rm(lock, { force: true })
  }
})

test("age alone does not permit a status writer to steal an unknown lock or write without it", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  const file = syncStatusPath({ root: local, env: process.env })
  updateSyncStatus(local, process.env, { last_pull: {
    state: "unresolved", attempt: "retained", effects: { pull: "unknown" },
  } })
  const before = await fs.readFile(file, "utf8")
  const lock = `${file}.lock`
  await fs.writeFile(lock, "unknown lock owner\n")
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(lock, old, old)
  try {
    assert.equal(updateSyncStatus(local, process.env, { last_pull: null }, file, { waitMs: 0 }), null)
    assert.equal(await fs.readFile(file, "utf8"), before)
    assert.equal(await fs.readFile(lock, "utf8"), "unknown lock owner\n")
  } finally {
    await fs.rm(lock, { force: true })
  }
})

test("a push reservation checks the current outgoing owner atomically", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  let counts = 0
  let pushes = 0
  const result = await worker(local, {
    spawnGit(command, args, options) {
      if (args[2] === "push") pushes++
      const answer = spawnSync(command, args, options)
      if (args[2] === "rev-list" && ++counts === 2) {
        updateSyncStatus(local, process.env, { blocked: true, reason: "push_in_progress",
          push_attempt: "another-push", effects: { push: "unknown" } })
      }
      return answer
    },
  })
  assert.equal(result.result, "blocked")
  assert.equal(pushes, 0)
  assert.equal(readSyncStatus({ root: local, env: process.env }).push_attempt, "another-push")
})

test("successful push settlement cannot clear a different outgoing owner", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  const result = await worker(local, {
    spawnGit(command, args, options) {
      const answer = spawnSync(command, args, options)
      if (args[2] === "push") {
        assert.equal(answer.status, 0, answer.stderr)
        updateSyncStatus(local, process.env, { blocked: true, reason: "push_in_progress",
          push_attempt: "replacement-push", effects: { push: "unknown" } })
      }
      return answer
    },
  })
  assert.equal(result.result, "blocked")
  const status = readSyncStatus({ root: local, env: process.env })
  assert.equal(status.push_attempt, "replacement-push")
  assert.equal(status.effects.push, "unknown")
})

test("a no-op worker cannot clear outgoing uncertainty created after its snapshot", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  let counts = 0
  const result = await worker(local, {
    spawnGit(command, args, options) {
      const answer = spawnSync(command, args, options)
      if (args[2] === "rev-list" && ++counts === 2) {
        updateSyncStatus(local, process.env, { blocked: true, reason: "push_in_progress",
          push_attempt: "pending-after-read", effects: { push: "unknown" } })
      }
      return answer
    },
  })
  assert.equal(result.result, "blocked")
  const status = readSyncStatus({ root: local, env: process.env })
  assert.equal(status.blocked, true)
  assert.equal(status.push_attempt, "pending-after-read")
})

test("a reservation that would exceed readable status capacity cannot authorize dispatch", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  await commit(local, "seed.md", "outgoing\n", "outgoing")
  const file = syncStatusPath({ root: local, env: process.env })
  await fs.mkdir(path.dirname(file), { recursive: true })
  const before = `${JSON.stringify({ padding: "x".repeat(1_048_500) })}\n`
  assert.ok(Buffer.byteLength(before) < 1_048_576)
  await fs.writeFile(file, before)
  let pushes = 0
  const result = await worker(local, {
    spawnGit(command, args, options) {
      if (args[2] === "push") {
        pushes++
        return { status: 1, stdout: "", stderr: "synthetic refusal" }
      }
      return spawnSync(command, args, options)
    },
  })
  assert.equal(result.result, "blocked")
  assert.equal(pushes, 0)
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
  assert.equal(digest(await fs.readFile(file)), digest(before))
})

test("boot reports unknown effects after its wait expires or dispatch throws without a result", () => {
  for (const input of [
    { sync: null, timedOut: true },
    { sync: null },
    { sync: {} },
    { sync: { state: "unresolved", cause: "other" } },
    { sync: { state: "unresolved", effects: { pull: "unknown" } }, timedOut: true },
  ]) {
    const message = syncSummary(input)
    assert.match(message, /unknown|unverified/u)
    assert.doesNotMatch(message, /nothing was pulled or pushed|it did not run/u)
  }
})

test("boot preserves confirmed non-application without inventing outgoing effects", () => {
  const message = syncSummary({ sync: {
    state: "unresolved", cause: "diverged", effects: { pull: "not_applied" },
  } })
  assert.match(message, /incoming update was not applied/u)
  assert.doesNotMatch(message, /nothing was pushed|nothing was pulled/u)
})

test("separate simultaneous startup processes reserve only one incoming attempt", async (t) => {
  const { local } = await fixture(t, { diverged: false })
  const coordination = await root(t, "process-coordination")
  const go = path.join(coordination, "go")
  const readyFiles = [path.join(coordination, "ready-0"), path.join(coordination, "ready-1")]
  assert.equal(readyFiles.some((file) => readFileSyncIfPresent(file)), false)
  const syncUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/session-sync.js", import.meta.url).href
  const workerUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/sync-worker.js", import.meta.url).href
  const isolation = new URL("../_isolated_env.mjs", import.meta.url).href
  const script = `
    import fs from "node:fs"
    import { spawnSync } from "node:child_process"
    import { syncWorkspace } from ${JSON.stringify(syncUrl)}
    import { readSyncStatus } from ${JSON.stringify(workerUrl)}
    const [root, ready, go] = process.argv.slice(1)
    let release, arrived = false
    const answer = new Promise(resolve => { release = resolve })
    process.on("message", message => {
      if (message.type === "finish") release(message.timeout
        ? { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }
        : { status: 0, stdout: "", stderr: "" })
    })
    const send = message => new Promise(resolve => process.send(message, resolve))
    try {
      const result = await syncWorkspace({
        root, env: process.env, fileProblem: () => ({ file: "synthetic; no filing" }),
        spawnGit(command, args, options) {
          const result = spawnSync(command, args, options)
          if (args[2] === "rev-list" && !arrived) {
            arrived = true
            fs.writeFileSync(ready, String(process.pid), { flag: "wx" })
            const deadline = Date.now() + 15000
            while (!fs.existsSync(go) && Date.now() < deadline)
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
            if (!fs.existsSync(go)) throw new Error("owned process barrier expired")
          }
          return result
        },
        spawnPull() {
          process.send({ type: "dispatched", attempt: readSyncStatus({ root, env: process.env }).last_pull.attempt })
          return answer
        },
      })
      await send({ type: "finished", result })
    } catch (error) {
      process.exitCode = 1
      await send({ type: "failed", error: error.message })
    } finally { process.disconnect() }
  `
  const within = async (promise) => {
    let timer
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("owned reservation process exceeded 20s")), 20000)
      })])
    } finally { clearTimeout(timer) }
  }
  const pending = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    promise.catch(() => {})
    return { promise, resolve, reject }
  }
  const actors = []
  t.after(async () => {
    for (const actor of actors) {
      if (actor.child.exitCode === null && actor.child.signalCode === null) actor.child.kill("SIGTERM")
    }
    await within(Promise.all(actors.map((actor) => actor.closed.promise)))
  })
  for (const ready of readyFiles) {
    const child = spawn(process.execPath, ["--import", isolation, "--input-type=module", "-e", script, local, ready, go], {
      env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
    })
    const actor = { child, phase: pending(), finished: pending(), closed: pending(), stderr: "" }
    actors.push(actor)
    child.once("spawn", () => process.stdout.write(`# owned reservation process created: ${child.pid}; root: ${local}\n`))
    child.stderr.on("data", (bytes) => { actor.stderr = (actor.stderr + bytes).slice(-8192) })
    child.on("message", (message) => {
      if (message.type === "dispatched") actor.phase.resolve(message)
      if (message.type === "finished") {
        actor.phase.resolve(message)
        actor.finished.resolve(message.result)
      }
      if (message.type === "failed") {
        actor.phase.reject(new Error(message.error))
        actor.finished.reject(new Error(message.error))
      }
    })
    child.once("error", (error) => { actor.phase.reject(error); actor.finished.reject(error); actor.closed.resolve(null) })
    child.once("close", (code) => {
      actor.closed.resolve(code)
      if (code !== 0) {
        actor.phase.reject(new Error(`owned child exited ${code}: ${actor.stderr}`))
        actor.finished.reject(new Error(`owned child exited ${code}: ${actor.stderr}`))
      }
    })
  }
  const readyDeadline = Date.now() + 15000
  while (!readyFiles.every((file) => readFileSyncIfPresent(file)) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(readyFiles.every((file) => readFileSyncIfPresent(file)), true, "both separate processes reached the stale-read boundary")
  await fs.writeFile(go, "release both reservation attempts\n", { flag: "wx" })
  const phases = await within(Promise.all(actors.map((actor) => actor.phase.promise)))
  const dispatched = actors.filter((_, index) => phases[index].type === "dispatched")
  for (const [index, actor] of dispatched.entries()) {
    actor.child.send({ type: "finish", timeout: index === 0 })
    await within(actor.finished.promise)
  }
  await within(Promise.all(actors.map((actor) => actor.finished.promise)))
  const exits = await within(Promise.all(actors.map((actor) => actor.closed.promise)))
  assert.deepEqual(exits, [0, 0])
  assert.equal(dispatched.length, 1)
  const owner = phases.find((phase) => phase.type === "dispatched").attempt
  const retained = readSyncStatus({ root: local, env: process.env }).last_pull
  assert.equal(retained.attempt, owner)
  assert.equal(retained.effects.pull, "unknown")
  let thirdDispatch = false
  const third = await startup(local, { spawnPull() {
    thirdDispatch = true
    return { status: 0, stdout: "", stderr: "" }
  } })
  assert.equal(third.state, "unresolved")
  assert.equal(thirdDispatch, false)
  assert.equal(readSyncStatus({ root: local, env: process.env }).last_pull.attempt, owner)
})

function readFileSyncIfPresent(file) {
  try { return readFileSync(file, "utf8") } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}
