import { test, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { withDeskMutation } from "../../../../../plugins/desk/mcp/src/util/desk-mutation.js"
import { runPushWorker, readSyncStatus, schedulePush } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
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

test("review: bounded contention retains a pending push that the existing worker can retry without another write", async () => {
  const root = await ownedRoot()
  const env = { ...process.env, XDG_STATE_HOME: await ownedRoot() }
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const held = withDeskMutation(root, async () => { entered(); await wait })
  await ready
  const boundary = gitBoundary()
  try {
    const pending = await runPushWorker({ root, env, debounceMs: 0, mutationWaitMs: 0,
      spawnGit: boundary.spawnGit, clock: { sleep: async () => {} } })
    assert.equal(pending.result, "pending")
    assert.equal(boundary.pushes, 0)
    assert.equal(readSyncStatus({ root, env }).pending_push, true)
  } finally {
    release()
    await held
  }
  const pushed = await runPushWorker({ root, env, debounceMs: 0, spawnGit: boundary.spawnGit, clock: { sleep: async () => {} } })
  assert.equal(pushed.result, "ok")
  assert.equal(boundary.pushes, 1)
  assert.equal(readSyncStatus({ root, env }).pending_push, false)
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
