// #1843: in a desk bound to a worktree, task_update's `into_task` merge and a task_update that follows a queued log entry
// must both reach the remote's default branch, and must not fail on the index lock the queued log commit holds.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { stagePaths } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { moveTask } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { task_create } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { mkTrack } from "./_move_fixture.js"

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, DESK_TOOL_COMMIT: "1" } })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

// A main checkout on `main` holding two duplicate tasks, pushed to a bare origin, and a worktree on `feature-card` made from origin/main.
async function deskWithWorktree() {
  const root = await mkTempDeskRoot()
  const origin = `${root}-origin.git`
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  await mkTrack(root, "main-track", { rows: ["keep-task", "dup-task"] })
  await mkTrack(root, "other-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "keep-task", title: "Keep" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "Dup" } })
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "--allow-empty", "-m", "seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["remote", "set-head", "origin", "main"])
  const worktree = `${root}-feature`
  git(root, ["worktree", "add", "-q", "-b", "feature-card", worktree, "origin/main"])
  return { root, origin, worktree }
}

const onOrigin = (origin, rel) => spawnSync("git", ["--git-dir", origin, "show", `main:${rel}`], { encoding: "utf8" })

test("into_task from a worktree publishes the merge to origin/main, not only to the worktree's branch", async () => {
  const { origin, worktree } = await deskWithWorktree()
  const featureBefore = git(worktree, ["rev-parse", "HEAD"])

  await moveTask({ deskRoot: worktree, input: { track: "main-track", slug: "dup-task", into_task: "keep-task" }, schedulePush: () => {} })

  assert.equal(onOrigin(origin, "main-track/dup-task/task.md").status, 128, "the duplicate is gone from origin/main")
  const tree = spawnSync("git", ["--git-dir", origin, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).stdout
  assert.match(tree, /^main-track\/keep-task\/_iterations\/[^/]*dup-task\/merged-task\.md$/mu, "origin/main holds the merged task")
  assert.equal(git(worktree, ["rev-parse", "HEAD"]), git(worktree, ["rev-parse", "origin/main"]), "the worktree caught up to what was published")
  assert.notEqual(git(worktree, ["rev-parse", "HEAD"]), featureBefore)
  assert.equal(git(worktree, ["status", "--porcelain"]), "")
})

test("a to_track move from a worktree publishes to origin/main too", async () => {
  const { origin, worktree } = await deskWithWorktree()
  await moveTask({ deskRoot: worktree, input: { track: "main-track", slug: "dup-task", to_track: "other-track" }, schedulePush: () => {} })
  assert.equal(onOrigin(origin, "other-track/dup-task/task.md").status, 0)
})

// Takes the worktree's index lock the instant the first `git add` is about to run (the window between the lock check and the add),
// as a live writer would. `holdMs` null never lets go; otherwise a real child process releases it, so Desk never removes a lock.
function lockAtFirstAdd(worktree, holdMs) {
  const lock = path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "index.lock"]))
  let adds = 0
  const spawnGit = (cmd, args, options) => {
    if (args.includes("add") && adds++ === 0) {
      writeFileSync(lock, "")
      if (holdMs !== null) spawn("sh", ["-c", `sleep ${holdMs / 1000}; rm -f '${lock}'`], { stdio: "ignore", detached: true }).unref()
    }
    return spawnSync(cmd, args, options)
  }
  return { spawnGit, lock, adds: () => adds }
}

test("staging waits out an index lock that appears just before its git add, instead of failing on it", async () => {
  const { worktree } = await deskWithWorktree()
  writeFileSync(path.join(worktree, "main-track", "track.md"), "changed\n", { flag: "a" })
  const held = lockAtFirstAdd(worktree, 300)
  const staged = stagePaths(worktree, ["main-track/track.md"], held.spawnGit)
  assert.equal(staged.ok, true, staged.stderr)
  assert.match(git(worktree, ["diff", "--cached", "--name-only"]), /main-track\/track\.md/u)
})

test("a lock that never clears fails within the bounded wait and is left in place", async () => {
  const { worktree } = await deskWithWorktree()
  writeFileSync(path.join(worktree, "main-track", "track.md"), "changed\n", { flag: "a" })
  const held = lockAtFirstAdd(worktree, null)
  const started = Date.now()
  const staged = stagePaths(worktree, ["main-track/track.md"], held.spawnGit)
  assert.equal(staged.ok, false)
  assert.match(staged.stderr, /index\.lock/u)
  assert.ok(Date.now() - started < 6000, "bounded")
  assert.equal(existsSync(held.lock), true, "the lock is not Desk's to remove")
})
