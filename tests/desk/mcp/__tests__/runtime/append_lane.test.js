import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { drainAppendLanes, flushAppends, pendingCount, pendingDigest, queueAppend } from "../../../../../plugins/desk/mcp/src/runtime/append-lane.js"

// What the append lane does when its commit cannot be made yet: the entry stays written and waiting, and the next flush tries again.

const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-append-lane-"))
  t.after(async () => {
    await drainAppendLanes()
    await fs.rm(root, { recursive: true, force: true })
  })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "user.email", "test@example.com"])
  await fs.writeFile(path.join(root, "seed.md"), "seed\n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Seed"])
  return root
}

const lane = (root, extra = {}) => {
  const pushes = []
  return { pushes, queue: (rels) => queueAppend({ root, rels, schedulePush: () => pushes.push(1), quietMs: 600_000, maxWaitMs: 900_000, ...extra }) }
}

test("an entry whose file vanished before its commit is dropped, not retried forever", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "log.md"), "one\n")
  const { queue, pushes } = lane(root)
  assert.equal(queue(["log.md"]), 1)
  assert.equal(typeof pendingDigest(root, "log.md"), "string")
  await fs.rm(path.join(root, "log.md"))
  assert.equal(flushAppends(root), "empty")
  assert.equal(pendingCount(root), 0)
  assert.equal(pendingDigest(root, "log.md"), null)
  assert.deepEqual(pushes, [])
  assert.equal(flushAppends(path.join(root, "never-queued")), "empty")
})

test("a file that cannot be staged stays waiting, and the next flush commits it", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "log.md"), "one\n")
  let failing = true
  const spawnGit = (command, args, options) => (failing && args.includes("add") ? { status: 1, stdout: "", stderr: "index busy" } : spawnSync(command, args, options))
  const { queue, pushes } = lane(root, { spawnGit })
  queue(["log.md"])
  assert.equal(flushAppends(root), "stage_failed")
  assert.equal(pendingCount(root), 1)
  failing = false
  assert.equal(flushAppends(root), "committed")
  assert.equal(pendingCount(root), 0)
  assert.equal(pushes.length, 1)
  assert.match(git(root, ["log", "-1", "--format=%s"]), /^task_update: log /u)
})

test("a commit Git refuses leaves the entry staged and waiting", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "log.md"), "one\n")
  const spawnGit = (command, args, options) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "hook refused" } : spawnSync(command, args, options))
  const { queue, pushes } = lane(root, { spawnGit })
  queue(["log.md"])
  assert.equal(flushAppends(root), "commit_failed")
  assert.equal(pendingCount(root), 1)
  assert.deepEqual(pushes, [])
})

test("a base the write may not build on keeps the entry waiting", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "log.md"), "one\n")
  const { queue } = lane(root, { admission: { policy_commit: "0".repeat(40) } })
  queue(["log.md"])
  assert.equal(flushAppends(root), "waiting")
  assert.equal(pendingCount(root), 1)
  assert.equal(git(root, ["status", "--porcelain"]), "?? log.md")
})

test("entries for two files share one commit named for their count", async (t) => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, "a"))
  await fs.mkdir(path.join(root, "b"))
  await fs.writeFile(path.join(root, "a/log.md"), "one\n")
  await fs.writeFile(path.join(root, "b/log.md"), "two\n")
  const { queue, pushes } = lane(root)
  queue(["a/log.md"])
  assert.equal(queue(["b/log.md"]), 2)
  assert.equal(flushAppends(root), "committed")
  assert.equal(git(root, ["log", "-1", "--format=%s"]), "task_update: log 2 cards")
  assert.equal(pushes.length, 1)
})
