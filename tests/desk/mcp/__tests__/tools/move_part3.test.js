// move — task_update and track_update, continued: the same suite as move.test.js, split so no single file sets a Windows shard's time.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { moveTask, renameTrack } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { task_create, task_archive, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"
import { folderHandle } from "../../../../../plugins/desk/mcp/src/desk/handles.js"
import { DONE_EVIDENCE, SCOPE, assertNoCandidateLeak, commitAll, gitLog, gitStatus, initGit, lastCommitMessage, mkTrack, tasksTableBody, trackBody } from "./_move_fixture.js"
import { assertNextFirst, notCommitted, routedPaths } from "./_route_around.js"


test("task_update mentions scan skips node_modules/.git/.state directories", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true })
  await fs.writeFile(
    path.join(root, "node_modules", "pkg", "note.md"),
    "t/old-name lives in node_modules and must not be scanned\n",
    "utf8",
  )

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.deepEqual(result.mentions, [])
})

// ── task_update: non-Git desk ──────────────────────────────────────────────────

test("task_update works on a non-Git desk via a plain rename", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.equal(await exists(path.join(root, "main-track", "old-name")), false)
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")))
  assert.match(await trackBody(root, "main-track"), /`new-name`/)
})

// ── task_update: person scoping ────────────────────────────────────────────────

test("task_update honors the --person write prefix", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    person: "ari",
    input: { slug: "main-track", title: "main-track", scope: SCOPE, body: tasksTableBody(["old-name"]) },
  })
  await task_create({
    deskRoot: root,
    person: "ari",
    input: { track: "main-track", slug: "old-name", title: "T" },
  })

  const result = await moveTask({
    deskRoot: root,
    person: "ari",
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
  })

  assert.equal(result.to, path.posix.join("desks", "ari", "main-track", "new-name"))
  assert.ok(await exists(path.join(root, "desks", "ari", "main-track", "new-name", "task.md")))
})

// ── task_update: injected git-plumbing failures (coverage of defensive paths) ──

test("task_update surfaces a git add failure", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
        spawnGit,
      }),
    /git add failed/,
  )
})

test("task_update surfaces a git mv failure", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("mv")) return { status: 1, stdout: "", stderr: "boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
        spawnGit,
      }),
    /git mv failed/,
  )
})

test("task_update surfaces a git add failure staging its own table edits", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  // movePath's own `git add -A -- <dir>` (source staging, ahead of `git mv`)
  // must still succeed; only stageWrites' plain `git add -- <files>` (for the
  // rewritten track.md table) fails here.
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add") && !args.includes("-A")) return { status: 1, stdout: "", stderr: "table add boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
        spawnGit,
      }),
    /git add failed staging the move's edits/,
  )
})

test("task_update reports a commit failure without losing the move", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit") || args.includes("commit-tree")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    spawnGit,
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"), "the move itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")))
  assert.deepEqual(notCommitted(result.commit), { status: "failed", reason: "nothing was committed: git commit-tree failed: commit boom" })
  assertNextFirst(result)
  assert.deepEqual(routedPaths(result.commit.route_around), ["main-track/old-name", "main-track/new-name", "main-track/new-name/task.md", "main-track/track.md"])
})

test("task_update reports a commit failure when Git cannot read the index it would commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  commitAll(root)
  const spawnGit = (cmd, args, opts) => args.includes("ls-files") && args.includes("-s") ? { status: 128, stdout: "", stderr: "index boom" } : spawnSync(cmd, args, opts)
  const result = await moveTask({ deskRoot: root, input: { track: "main-track", slug: "old-name", to_slug: "new-name" }, spawnGit })
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")), "the move itself is never lost")
  assert.deepEqual(notCommitted(result.commit), { status: "failed", reason: "git could not read the index" })
})

test("task_update commits only its own paths, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  commitAll(root)

  // Simulates another process staging an unrelated path in the window
  // between task_update's own dirty check and its stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.equal(result.commit, undefined, "the move's own commit succeeded")
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("task_update treats a spawnGit throw as a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = () => {
    throw new Error("git ENOENT")
  }

  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    spawnGit,
  })
  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")))
})

// ── task_update: push scheduling ───────────────────────────────────────────────
//
// After a successful, silent commit, task_update schedules a background push
// through the injectable `schedulePush` seam (never the real, spawning
// default in runtime/sync-worker.js — a test that reaches this code path
// without overriding it would fire a real detached process). It must run
// exactly once, keyed on the tool's own top-level `deskRoot` (never
// `effectiveRoot` or the moved directory), and only when the desk is a Git
// repo and the commit didn't fail.

test("task_update schedules a push exactly once, keyed on the plain deskRoot, after a successful commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  commitAll(root)

  const calls = []
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.deepEqual(calls, [{ root }])
})

test("task_update never schedules a push on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const calls = []
  await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.deepEqual(calls, [])
})

test("task_update never schedules a push when the commit fails", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit") || args.includes("commit-tree")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  const calls = []
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    spawnGit,
    schedulePush: (opts) => calls.push(opts),
  })

  assert.deepEqual(notCommitted(result.commit), { status: "failed", reason: "nothing was committed: git commit-tree failed: commit boom" })
  assert.deepEqual(calls, [])
})

test("task_update moves a task whose evidence a sparse checkout leaves out (a hosted desk excludes media), left-out files included", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["shot-task"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "shot-task", title: "T" } })
  await fs.mkdir(path.join(root, "track-a", "shot-task", "evidence"))
  await fs.writeFile(path.join(root, "track-a", "shot-task", "evidence", "shot.png"), "png")
  commitAll(root)
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(git("sparse-checkout", "set", "--no-cone", "/*", "!*.png").status, 0)
  assert.equal(await exists(path.join(root, "track-a", "shot-task", "evidence", "shot.png")), false, "the screenshot is left out of the checkout")

  await moveTask({ deskRoot: root, input: { track: "track-a", slug: "shot-task", to_track: "track-b" }, schedulePush: () => {} })

  const committed = git("ls-tree", "-r", "--name-only", "HEAD").stdout.split("\n").filter((file) => file.endsWith(".png"))
  assert.deepEqual(committed, ["track-b/shot-task/evidence/shot.png"], "the commit moves the left-out screenshot with its task, never deletes it")
  assert.equal(git("status", "--porcelain", "--", "track-a", "track-b").stdout, "", "and leaves nothing staged behind")
  assert.ok(await exists(path.join(root, "track-b", "shot-task", "task.md")))
})
