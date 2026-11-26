// #1843: in a desk bound to a worktree, task_update's `into_task` merge and a task_update that follows a queued log entry
// must both reach the remote's default branch, and must not fail on the index lock the queued log commit holds.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
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
  let released = Promise.resolve({ code: 0, signal: null })
  const spawnGit = (cmd, args, options) => {
    if (args.includes("add") && adds++ === 0) {
      writeFileSync(lock, "")
      if (holdMs !== null) {
        // An attached helper this test owns: it ends within `holdMs`, and `released` settles with its actual exit status.
        const helper = spawn("sh", ["-c", `sleep ${holdMs / 1000}; rm -f '${lock}'`], { stdio: "ignore" })
        released = new Promise((resolve) => helper.once("exit", (code, signal) => resolve({ code, signal })))
      }
    }
    return spawnSync(cmd, args, options)
  }
  return { spawnGit, lock, adds: () => adds, released: () => released }
}

test("staging waits out an index lock that appears just before its git add, instead of failing on it", async () => {
  const { worktree } = await deskWithWorktree()
  writeFileSync(path.join(worktree, "main-track", "track.md"), "changed\n", { flag: "a" })
  const held = lockAtFirstAdd(worktree, 300)
  const staged = stagePaths(worktree, ["main-track/track.md"], held.spawnGit)
  assert.equal(staged.ok, true, staged.stderr)
  assert.match(git(worktree, ["diff", "--cached", "--name-only"]), /main-track\/track\.md/u)
  assert.deepEqual(await held.released(), { code: 0, signal: null }, "the helper exited on its own")
  assert.equal(existsSync(held.lock), false)
})

test("a lock that never clears gives up on the wait and is left in place", async () => {
  const { worktree } = await deskWithWorktree()
  writeFileSync(path.join(worktree, "main-track", "track.md"), "changed\n", { flag: "a" })
  const held = lockAtFirstAdd(worktree, null)
  const staged = stagePaths(worktree, ["main-track/track.md"], held.spawnGit)
  assert.equal(staged.ok, false)
  assert.match(staged.stderr, /index\.lock/u)
  assert.equal(existsSync(held.lock), true, "the lock is not Desk's to remove")
})

test("a worktree move whose publication fails says so and leaves the move on disk", async () => {
  const { origin, worktree } = await deskWithWorktree()
  renameSync(origin, `${origin}.gone`)
  const result = await moveTask({ deskRoot: worktree, input: { track: "main-track", slug: "dup-task", to_track: "other-track" }, schedulePush: () => {} })
  assert.ok(result.commit, `a failed publication is reported: ${JSON.stringify(result)}`)
  assert.equal(existsSync(path.join(worktree, "other-track", "dup-task", "task.md")), true)
})

// The supported route: task_update's `log` leaves the entry queued, the push worker's commit (a real separate process, as the
// detached worker is, yielding the lock) takes the worktree's index lock for as long as a real `git add` runs, and a following
// task_update in the same worktree commits meanwhile. A clean filter on log.md, named only in the common git dir's info/attributes,
// is what makes the worker's own `git add` hold the lock for about a second.
test("task_update right after a queued log entry, while the worker's commit holds the index lock, loses nothing and publishes both", async () => {
  const { root, origin, worktree } = await deskWithWorktree()
  const marker = `${root}-filter-ran`
  const filter = `${root}-filter.sh`
  writeFileSync(filter, `#!/bin/sh\nif [ ! -e '${marker}' ]; then touch '${marker}'; sleep 1; fi\ncat\n`)
  chmodSync(filter, 0o755)
  git(worktree, ["config", "filter.slowlog.clean", filter])
  writeFileSync(path.join(root, ".git", "info", "attributes"), "log.md filter=slowlog\n", { flag: "a" })

  writeFileSync(path.join(worktree, "unrelated-staged.txt"), "staged bytes\n")
  git(worktree, ["add", "unrelated-staged.txt"])
  writeFileSync(path.join(worktree, "main-track", "track.md"), "unrelated working bytes\n", { flag: "a" })

  const logged = await task_update({ deskRoot: worktree, input: { track: "main-track", slug: "keep-task", log: "Ruling: queued entry." }, schedulePush: () => {} })
  assert.equal(logged.commit, "queued")

  const workerCode = `import { commitWaitingLogs } from ${JSON.stringify(new URL("../../../../../plugins/desk/mcp/src/runtime/append-lane.js", import.meta.url).href)}
    process.stdout.write(commitWaitingLogs(${JSON.stringify(worktree)}))`
  const worker = spawn(process.execPath, ["--input-type=module", "-e", workerCode], { env: { ...process.env, DESK_GIT_YIELD: "1", DESK_TOOL_COMMIT: "" }, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  worker.stdout.on("data", (chunk) => { out += chunk })
  const exited = new Promise((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })))
  const guard = setTimeout(() => worker.kill("SIGKILL"), 60_000)
  try {
    const lock = path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "index.lock"]))
    for (let waited = 0; !(existsSync(marker) && existsSync(lock)) && waited < 600; waited += 1) await new Promise((r) => setTimeout(r, 50))
    assert.equal(existsSync(lock), true, "the worker's real git add holds the index lock")

    let metLock = false
    const watching = (cmd, args, options) => {
      if (existsSync(lock)) metLock = true
      return spawnSync(cmd, args, options)
    }
    const updated = await task_update({ deskRoot: worktree, input: { track: "main-track", slug: "keep-task", note: "second update" }, schedulePush: () => {}, spawnGit: watching })
    assert.equal(metLock, true, "the second task_update ran its git while the worker held the lock")
    assert.equal(updated.status, "updated", JSON.stringify(updated))
    assert.deepEqual(await exited, { code: 0, signal: null })
  } finally {
    clearTimeout(guard)
    if (worker.exitCode === null) {
      worker.kill("SIGKILL")
      await exited
    }
    rmSync(filter, { force: true })
    rmSync(marker, { force: true })
  }
  assert.equal(out, "committed")

  const show = (rel) => spawnSync("git", ["--git-dir", origin, "show", `main:${rel}`], { encoding: "utf8" })
  assert.match(show("main-track/keep-task/log.md").stdout, /Ruling: queued entry\./u, "the queued log entry is on origin/main")
  assert.match(show("main-track/keep-task/task.md").stdout, /second update/u, "the second update is on origin/main")
  assert.equal(show("unrelated-staged.txt").status, 128, "unrelated staged bytes were not published")
  assert.doesNotMatch(show("main-track/track.md").stdout, /unrelated working bytes/u)
  assert.equal(git(worktree, ["show", ":unrelated-staged.txt"]), "staged bytes", "the unrelated staged entry is still staged")
  assert.match(readFileSync(path.join(worktree, "main-track", "track.md"), "utf8"), /unrelated working bytes/u)
  assert.equal(existsSync(path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "index.lock"]))), false)
})
