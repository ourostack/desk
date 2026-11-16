import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { commitWaitingLogs, settleLogs, waitingLogs } from "../../../../../plugins/desk/mcp/src/runtime/append-lane.js"

// Which task logs wait for a commit, how the push worker waits for them to go quiet, and what it does when Git will not commit them yet.

const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-append-lane-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "user.email", "test@example.com"])
  for (const dir of ["a", "b", "gone"]) {
    await fs.mkdir(path.join(root, dir))
    await fs.writeFile(path.join(root, dir, "task.md"), "card\n")
  }
  await fs.writeFile(path.join(root, "gone/log.md"), "old\n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Seed"])
  return root
}

test("a waiting log is a task's changed or untracked log.md; a log with no card, or one removed, is not", async (t) => {
  const root = await fixture(t)
  assert.deepEqual(waitingLogs(root), [])
  await fs.writeFile(path.join(root, "a/log.md"), "one\n")
  await fs.writeFile(path.join(root, "log.md"), "no card here\n")
  await fs.rm(path.join(root, "gone/log.md"))
  assert.deepEqual(waitingLogs(root), ["a/log.md"])
  await fs.writeFile(path.join(root, "gone/log.md"), "old\nnew\n")
  assert.deepEqual(waitingLogs(root).sort(), ["a/log.md", "gone/log.md"])
  assert.deepEqual(waitingLogs(root, () => ({ status: 128, stdout: "" })), [])
})

test("waiting logs are committed together, named for the card or their count, and nothing is left to commit after", async (t) => {
  const root = await fixture(t)
  assert.equal(commitWaitingLogs(root), "empty")
  await fs.writeFile(path.join(root, "a/log.md"), "one\n")
  assert.equal(commitWaitingLogs(root), "committed")
  assert.equal(git(root, ["log", "-1", "--format=%s"]), "task_update: log a")
  await fs.appendFile(path.join(root, "a/log.md"), "two\n")
  await fs.writeFile(path.join(root, "b/log.md"), "three\n")
  assert.equal(commitWaitingLogs(root), "committed")
  assert.equal(git(root, ["log", "-1", "--format=%s"]), "task_update: log 2 cards")
  assert.equal(git(root, ["status", "--porcelain"]), "")
})

test("a log Git will not stage or commit yet stays written and waiting, and a Git that cannot run never throws", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "a/log.md"), "one\n")
  const refusing = (verb) => (command, args, options) => (args.includes(verb) ? { status: 1, stdout: "", stderr: "refused" } : spawnSync(command, args, options))
  assert.equal(commitWaitingLogs(root, refusing("add")), "stage_failed")
  assert.equal(commitWaitingLogs(root, refusing("commit")), "commit_failed")
  assert.deepEqual(waitingLogs(root), ["a/log.md"])
  assert.equal(commitWaitingLogs(root, () => { throw new Error("spawn failed") }), "commit_failed")
  assert.equal(commitWaitingLogs(root), "committed")
})

test("the worker waits until the newest waiting log has been quiet, but never longer than the cap", async (t) => {
  const root = await fixture(t)
  assert.equal(await settleLogs(root, { sleep: () => assert.fail("nothing waits, so nothing to wait for") }), undefined)
  await fs.writeFile(path.join(root, "a/log.md"), "one\n")
  const written = (await fs.stat(path.join(root, "a/log.md"))).mtimeMs
  let clock = written
  const waits = []
  const sleep = async (ms) => { waits.push(ms); clock += ms }
  await settleLogs(root, { sleep, now: () => clock, quietMs: 100, maxWaitMs: 1000 })
  assert.deepEqual(waits, [100])
  clock = written
  waits.length = 0
  await settleLogs(root, { sleep, now: () => clock, quietMs: 5000, maxWaitMs: 300 })
  assert.deepEqual(waits, [300])
})
