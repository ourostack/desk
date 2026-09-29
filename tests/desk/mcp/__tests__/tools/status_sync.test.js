// desk_status's own sync section (M4-6 "agents never fight the desk" Part
// 3, Task 4; spec.md §2 "desk_status surfaces sync state"; controller
// ruling 5: local state only, no network call).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"
import { syncStatusPath } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"

const env = process.env

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function mkBareOrigin() {
  const root = await mkTempRoot("desk-status-sync-origin-")
  git(root, ["init", "--bare", "-q"])
  return root
}

async function mkPlainRepo(prefix) {
  const root = await mkTempRoot(prefix)
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  return root
}

async function writeAndCommit(root, name, content, message) {
  await fs.writeFile(path.join(root, name), content)
  git(root, ["add", "--", name])
  git(root, ["commit", "-q", "-m", message])
}

async function mkOriginWithClone() {
  const origin = await mkBareOrigin()
  const cloneA = await mkPlainRepo("desk-status-sync-a-")
  git(cloneA, ["remote", "add", "origin", origin])
  await writeAndCommit(cloneA, "seed.md", "seed\n", "seed")
  git(cloneA, ["push", "-q", "-u", "origin", "main"])
  return { origin, cloneA }
}

function seedStatus(root, patch) {
  const file = syncStatusPath({ root, env })
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(patch)}\n`)
}

test("desk_status reports sync: \"no remote configured\" on a desk with no remote at all", async () => {
  const deskRoot = await mkPlainRepo("desk-status-sync-noremote-")
  await writeAndCommit(deskRoot, "seed.md", "seed\n", "seed")
  const body = await desk_status({ deskRoot, env })
  assert.equal(body.sync, "no remote configured")
})

test("desk_status reports sync: \"no remote configured\" on a plain non-Git desk", async () => {
  const deskRoot = await mkTempRoot("desk-status-sync-nongit-")
  const body = await desk_status({ deskRoot, env })
  assert.equal(body.sync, "no remote configured")
})

test("desk_status reports sync: null when the desk root itself is unavailable", async () => {
  const deskRoot = path.join(await mkTempRoot("desk-status-sync-missing-"), "nowhere")
  const body = await desk_status({ deskRoot, env })
  assert.equal(body.sync, null)
})

test("desk_status reports sync.blocked false, up to date, on a healthy repo with nothing ahead or behind", async () => {
  const { cloneA } = await mkOriginWithClone()
  const body = await desk_status({ deskRoot: cloneA, env })
  assert.deepEqual(body.sync, { blocked: false, ahead: 0, behind: 0, last_push_at: null })
})

test("desk_status reports ahead/behind counts and the worker's last recorded push time", async () => {
  const { cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  const lastPushAt = new Date("2026-01-01T00:00:00.000Z").toISOString()
  seedStatus(cloneA, { blocked: false, reason: null, paths: [], last_push_at: lastPushAt })

  const body = await desk_status({ deskRoot: cloneA, env })
  assert.deepEqual(body.sync, { blocked: false, ahead: 1, behind: 0, last_push_at: lastPushAt })
})

test("desk_status reports sync.blocked true with reason and paths when a push has failed twice", async () => {
  const { cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  seedStatus(cloneA, { blocked: true, reason: "push_rejected_after_retry", paths: ["more.md"], at: new Date().toISOString() })

  const body = await desk_status({ deskRoot: cloneA, env })
  assert.deepEqual(body.sync, { blocked: true, reason: "push_rejected_after_retry", paths: ["more.md"] })
})

test("desk_status treats a blocked status with no reason or paths recorded as blocked: true, reason: null, paths: []", async () => {
  const { cloneA } = await mkOriginWithClone()
  seedStatus(cloneA, { blocked: true })

  const body = await desk_status({ deskRoot: cloneA, env })
  assert.deepEqual(body.sync, { blocked: true, reason: null, paths: [] })
})

test("desk_status's sync section makes no network call: a repo with a remote pointing nowhere resolves fast", async () => {
  const deskRoot = await mkPlainRepo("desk-status-sync-deadremote-")
  git(deskRoot, ["remote", "add", "origin", "https://127.0.0.1:1/does/not/exist.git"])
  await writeAndCommit(deskRoot, "seed.md", "seed\n", "seed")

  const started = Date.now()
  const body = await desk_status({ deskRoot, env })
  assert.ok(Date.now() - started < 2000, "sync status must never attempt to reach the remote")
  // No upstream has ever been fetched, so ahead/behind default to 0/0 rather than erroring.
  assert.deepEqual(body.sync, { blocked: false, ahead: 0, behind: 0, last_push_at: null })
})
