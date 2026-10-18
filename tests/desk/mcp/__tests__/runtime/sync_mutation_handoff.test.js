import { test, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { withDeskMutation, deskMutationScope } from "../../../../../plugins/desk/mcp/src/util/desk-mutation.js"
import { runPushWorker, readSyncStatus, schedulePush, resolveSyncLockPath, acquireSyncLock, updateSyncStatus, continuePushHandoffs } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
import { mkTempDeskRoot } from "../tools/_helpers.js"

const ownedRoots = new Set()
async function ownedRoot() {
  const root = await mkTempDeskRoot()
  ownedRoots.add(root)
  return root
}
after(async () => {
  for (const root of ownedRoots) await assert.rejects(fs.lstat(root), { code: "ENOENT" })
})

function gitBoundary() {
  let ahead = 1
  let pushes = 0
  return {
    get pushes() { return pushes },
    spawnGit(_command, args) {
      const op = args[2]
      if (op === "remote") return { status: 0, stdout: "origin\n", stderr: "" }
      if (op === "rev-list") return { status: 0, stdout: `0\t${ahead}\n`, stderr: "" }
      if (op === "push") { pushes++; ahead = 0; return { status: 0, stdout: "", stderr: "" } }
      throw new Error(`Unexpected Git operation ${op}`)
    },
  }
}

test("review: the sole push worker waits through live canonical contention and pushes after release", async () => {
  const root = await ownedRoot()
  const env = { ...process.env, XDG_STATE_HOME: await ownedRoot() }
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const held = withDeskMutation(root, async () => { entered(); await wait })
  await ready
  const boundary = gitBoundary()
  try {
    let worker
    let scheduled = 0
    schedulePush({ root, env, spawnWorker: () => {
      scheduled++
      worker = runPushWorker({ root, env, debounceMs: 0, spawnGit: boundary.spawnGit,
        clock: { sleep: async (ms) => { if (ms > 0) { release(); await held } } } })
    } })
    const result = await worker
    assert.equal(scheduled, 1)
    assert.equal(result.result, "ok")
    assert.equal(boundary.pushes, 1)
    assert.equal(readSyncStatus({ root, env }).pending_push, false)
  } finally {
    release()
    await held
  }
})

test("review: expired contention retains its request while an active sync reservation prevents transfer", async () => {
  const root = await ownedRoot()
  const env = { ...process.env, XDG_STATE_HOME: await ownedRoot() }
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const held = withDeskMutation(root, async () => { entered(); await wait })
  await ready
  const boundary = gitBoundary()
  let reservation
  try {
    const pending = await runPushWorker({ root, env, debounceMs: 0, mutationWaitMs: 0,
      spawnGit: boundary.spawnGit, clock: { sleep: async () => {} } })
    assert.equal(pending.result, "pending")
    assert.equal(boundary.pushes, 0)
    assert.equal(readSyncStatus({ root, env }).pending_push, true)
    reservation = await acquireSyncLock({ root, env, createOnly: true })
    assert.ok(reservation?.release)
  } finally {
    release()
    await held
    reservation?.release()
  }
  const scope = await deskMutationScope(root)
  assert.equal(JSON.parse(await fs.readFile(scope.pushStatus, "utf8")).release_handoffs.length, 1)
  assert.equal(boundary.pushes, 0)
})

test("review: unknown mutation ownership never grants a push or an unbounded wait", async () => {
  const root = await ownedRoot()
  const env = { ...process.env, XDG_STATE_HOME: await ownedRoot() }
  const claim = path.join(root, ".desk-mutation.lock")
  await fs.writeFile(claim, "unknown owner")
  const boundary = gitBoundary()
  const result = await runPushWorker({ root, env, debounceMs: 0, spawnGit: boundary.spawnGit,
    clock: { sleep: async (ms) => { assert.equal(ms, 0, "unknown owners must not be polled as live") } } })
  assert.equal(result.result, "pending")
  assert.equal(result.reason, "mutation_owner_unqualified")
  assert.equal(readSyncStatus({ root, env }).pending_push, true)
  assert.equal(boundary.pushes, 0)
  assert.equal(await fs.readFile(claim, "utf8"), "unknown owner")
})

test("review: an unavailable post-handoff ahead count cannot acknowledge a pending push", async () => {
  const root = await ownedRoot()
  const env = { ...process.env, XDG_STATE_HOME: await ownedRoot() }
  let counts = 0
  const spawnGit = (_command, args) => {
    if (args[2] === "remote") return { status: 0, stdout: "origin\n", stderr: "" }
    if (args[2] === "rev-list" && counts++ === 0) return { status: 0, stdout: "0\t1\n", stderr: "" }
    if (args[2] === "rev-list") return { status: 1, stdout: "", stderr: "owned unavailable count" }
    throw new Error("An unavailable count must not authorize a push")
  }
  const result = await runPushWorker({ root, env, debounceMs: 0, spawnGit, clock: { sleep: async () => {} } })
  assert.equal(result.result, "pending")
  assert.equal(result.reason, "push_counts_unavailable")
  assert.equal(readSyncStatus({ root, env }).pending_push, true)
})

for (const ownerMode of ["same process", "separate process with nested binding"]) {
test(`rereview: expired sole worker continues on ${ownerMode} release, without a manual worker call`, async () => {
  const root = await ownedRoot()
  const origin = await ownedRoot()
  const env = { ...process.env, XDG_STATE_HOME: await ownedRoot() }
  const git = (...args) => {
    const result = spawnSync("git", args, { encoding: "utf8", timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git("init", "--bare", "-q", origin)
  git("-C", root, "init", "-q")
  git("-C", root, "config", "user.name", "Test")
  git("-C", root, "config", "user.email", "test@example.com")
  await fs.writeFile(path.join(root, "proof.txt"), "first\n")
  git("-C", root, "add", "--", "proof.txt")
  git("-C", root, "commit", "-qm", "first")
  git("-C", root, "remote", "add", "origin", origin)
  git("-C", root, "push", "-qu", "origin", "HEAD")
  const first = git("-C", root, "rev-parse", "HEAD")
  await fs.writeFile(path.join(root, "proof.txt"), "second\n")
  git("-C", root, "add", "--", "proof.txt")
  git("-C", root, "commit", "-qm", "second")
  const second = git("-C", root, "rev-parse", "HEAD")
  let ready, release, held, checkOwner
  if (ownerMode === "same process") {
    let entered
    ready = new Promise((resolve) => { entered = resolve })
    const wait = new Promise((resolve) => { release = resolve })
    held = withDeskMutation(root, async () => { entered(); await wait })
  } else {
    const nested = path.join(root, "bound-person")
    await fs.mkdir(nested)
    const module = new URL("../../../../../plugins/desk/mcp/src/util/desk-mutation.js", import.meta.url).href
    const script = `import{withDeskMutation}from ${JSON.stringify(module)};await withDeskMutation(${JSON.stringify(nested)},async()=>{const wait=new Promise(r=>process.stdin.once("data",r));process.stdout.write("ready\\n");await wait});process.stdin.destroy()`
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += chunk })
    held = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`owned owner child exit ${code}: ${stderr}`)))
    })
    ready = new Promise((resolve, reject) => {
      let stdout = ""
      child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("ready\n")) resolve() })
      child.once("error", reject)
      child.once("close", (code) => reject(new Error(`owner child closed before readiness: ${code}`)))
    })
    release = () => { if (!child.stdin.destroyed) child.stdin.end("release\n") }
    checkOwner = async () => {
      const scope = await deskMutationScope(root)
      const receipt = JSON.parse(await fs.readFile(scope.file, "utf8"))
      assert.equal(receipt.pid, child.pid)
      assert.equal(await readProcessStart(child.pid), receipt.start)
    }
  }
  try {
    await ready
    await checkOwner?.()
    const result = await runPushWorker({ root, env, debounceMs: 0, mutationWaitMs: 0 })
    assert.equal(result.result, "pending")
    assert.equal(git("--git-dir", origin, "rev-parse", "HEAD"), first)
  } finally {
    release()
    await held
  }
  let worker
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try { worker ??= JSON.parse(await fs.readFile(resolveSyncLockPath({ root, env }), "utf8")) } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (git("--git-dir", origin, "rev-parse", "HEAD") === second) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // Observe the exact source-recorded worker generation and let it exit normally.
  if (worker) {
    const end = Date.now() + 35_000
    for (;;) {
      let alive = true
      try { process.kill(worker.pid, 0) } catch (error) { if (error.code === "ESRCH") alive = false; else throw error }
      const current = alive ? await readProcessStart(worker.pid) : null
      if (!alive || (current !== null && current !== worker.start)) break
      assert.ok(Date.now() < end, "owned continuation worker has not exited")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  assert.equal(git("--git-dir", origin, "rev-parse", "HEAD"), second, "normal release must continue the sole scheduled obligation")
  assert.ok(worker?.start, "continuation must have an observed source-owned worker receipt")
  assert.equal(readSyncStatus({ root, env }).pending_push, false)
})
}

test("rereview: strict handoff state never steals an old unknown status lock or writes around it", async () => {
  const root = await ownedRoot()
  const file = path.join(root, "owned-handoff.status.json")
  const lock = `${file}.lock`
  await fs.writeFile(file, '{"preserved":true}\n')
  await fs.writeFile(lock, "unknown")
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(lock, old, old)
  assert.throws(() => updateSyncStatus(root, process.env, { overwritten: true }, file, { strict: true, waitMs: 0 }), /busy/)
  assert.equal(await fs.readFile(file, "utf8"), '{"preserved":true}\n')
  assert.equal(await fs.readFile(lock, "utf8"), "unknown")
})

test("rereview: a release notification during a failed drain cannot be lost behind that drain", async () => {
  const root = await ownedRoot()
  const state = await ownedRoot()
  const env = { ...process.env, XDG_STATE_HOME: state }
  const scope = await deskMutationScope(root)
  updateSyncStatus(root, env, { push_handoff_version: 1, release_handoffs: [{ root, state_home: state }] }, scope.pushStatus, { strict: true })
  const reservation = await acquireSyncLock({ root, env, createOnly: true })
  let claims = 0
  let scheduled = 0
  try {
    await continuePushHandoffs({ scope, schedule: () => { scheduled++; return { scheduled: true } }, claim: async (action) => {
      claims++
      await action()
      if (claims === 1) {
        reservation.release()
        updateSyncStatus(root, env, (current) => ({ ...current, handoff_epoch: (current.handoff_epoch ?? 0) + 1 }), scope.pushStatus, { strict: true })
      }
    } })
    assert.equal(claims, 2)
    assert.equal(scheduled, 1)
    assert.deepEqual(JSON.parse(await fs.readFile(scope.pushStatus, "utf8")).release_handoffs, [])
  } finally {
    reservation.release()
  }
})

for (const replacement of ["token", "inode", "content"]) {
  test(`release correction: exact reservation ${replacement} replacement retains route and forbids launch`, async () => {
    const root = await ownedRoot()
    const state = await ownedRoot()
    const env = { ...process.env, XDG_STATE_HOME: state }
    const scope = await deskMutationScope(root)
    const route = { root, state_home: state }
    updateSyncStatus(root, env, { push_handoff_version: 1, release_handoffs: [route] }, scope.pushStatus, { strict: true })
    const lockFile = resolveSyncLockPath({ root, env })
    let retainedBytes
    let scheduled = 0
    await assert.rejects(continuePushHandoffs({
      scope,
      schedule: () => { scheduled++; return { scheduled: true } },
      claim: async (action) => {
        await action()
        const original = await fs.readFile(lockFile, "utf8")
        const record = JSON.parse(original)
        assert.equal(record.pid, process.pid)
        assert.ok(record.start)
        assert.equal(record.start, await readProcessStart(process.pid))
        if (replacement === "inode") {
          await fs.rename(lockFile, `${lockFile}.owned-original`)
          retainedBytes = original
          await fs.writeFile(lockFile, retainedBytes, { flag: "wx", mode: 0o600 })
        } else {
          retainedBytes = `${JSON.stringify(replacement === "token" ?
            { ...record, token: "owned-distinct-replacement-token" } :
            { ...record, ownedReplacement: true })}\n`
          await fs.writeFile(lockFile, retainedBytes)
        }
      },
    }), /reservation.*release/i)
    assert.equal(scheduled, 0)
    assert.equal(await fs.readFile(lockFile, "utf8"), retainedBytes)
    assert.deepEqual(JSON.parse(await fs.readFile(scope.pushStatus, "utf8")).release_handoffs, [route])
  })
}
