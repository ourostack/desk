// task_update unarchive and into_task, its dirty-tree refusals, and track_update. The other task_update cases are in move.test.js.

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
import { assertNextFirst, notCommitted } from "./_route_around.js"

// ── task_update: unarchive (M4-5) ──────────────────────────────────────────────

async function archivedTask(root, { track = "main-track", slug = "old-task", rows = [] } = {}) {
  await mkTrack(root, track, { rows })
  await task_create({ deskRoot: root, input: { track, slug, title: "T" } })
  await task_archive({ deskRoot: root, input: { track, slug, evidence: DONE_EVIDENCE } })
}

const DIRTY = /the source has unstaged changes or untracked files, so another session may be working there; commit or finish that work first, or pass allow_dirty: true to move it anyway/

const SECRET_SLUG = "set pw hunter2"

async function deskWithSecretTask() {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  const dir = path.join(root, "main-track", SECRET_SLUG)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "task.md"), "---\ntitle: T\nstatus: drafting\ntrack: main-track\n---\nsee main-track/set pw hunter2\n")
  await fs.writeFile(path.join(root, "main-track", "notes.md"), "old home: main-track/set pw hunter2\n")
  commitAll(root)
  return { root, handle: folderHandle("task", root, dir) }
}

test("task_update unarchive moves an archived task back to a live folder and restores its missing row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await archivedTask(root, { rows: ["other-task"] })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
    schedulePush: () => {},
  })

  assert.equal(result.from, path.posix.join("main-track", "_archive", "old-task"))
  assert.equal(result.to, path.posix.join("main-track", "old-task"))
  assert.equal(await exists(path.join(root, "main-track", "_archive", "old-task")), false)
  const { data } = await readFront(path.join(root, "main-track", "old-task", "task.md"))
  assert.equal(data.track, "main-track")
  assert.equal(data.status, "done", "unarchiving never changes the status; the agent reopens it with task_update")
  const body = await trackBody(root, "main-track")
  assert.match(body, /^\| `old-task` \| done \|  \|  \|  \|$/m)
  assert.match(body, /`other-task`/)
  assert.ok(result.updated_files.includes(path.posix.join("main-track", "track.md")))
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_update: old-task → main-track")
})

test("task_update unarchive leaves a row that is still in the table alone", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root, { rows: ["old-task"] })
  const before = await trackBody(root, "main-track")

  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
  })

  assert.equal(await trackBody(root, "main-track"), before)
  assert.deepEqual(result.updated_files, [path.posix.join("main-track", "old-task", "task.md")])
})

test("task_update unarchive with a new name renames the row that is still in the table", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root, { rows: ["old-task"] })

  await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true, to_slug: "reopened-task" },
  })

  assert.ok(await exists(path.join(root, "main-track", "reopened-task", "task.md")))
  const body = await trackBody(root, "main-track")
  assert.match(body, /`reopened-task`/)
  assert.doesNotMatch(body, /`old-task`/)
})

test("task_update unarchive into another track moves the source row there", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root, { rows: ["old-task"] })
  const archived = await readFront(path.join(root, "main-track", "_archive", "old-task", "task.md"))
  assert.equal(archived.data.status, "done")
  assert.match(await trackBody(root, "main-track"), /^\| `old-task` \| done \|/m)
  await mkTrack(root, "track-b", { rows: [] })

  await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true, to_track: "track-b" },
  })

  assert.ok(await exists(path.join(root, "track-b", "old-task", "task.md")))
  assert.doesNotMatch(await trackBody(root, "main-track"), /`old-task`/)
  assert.match(await trackBody(root, "track-b"), /^\| `old-task` \| done \|/m)
  const live = await readFront(path.join(root, "track-b", "old-task", "task.md"))
  assert.equal(live.data.status, archived.data.status, "moving a terminal task does not reopen it")
  assert.deepEqual(live.data.evidence, archived.data.evidence)
})

test("task_update unarchive into another track builds a row when the source table has none", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  await track_create({
    deskRoot: root,
    input: {
      slug: "track-b",
      title: "track-b",
      scope: SCOPE,
      body: ["## Tasks", "", "| Slug", "|------", "| `kept-task`"].join("\n"),
    },
  })

  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true, to_track: "track-b" },
  })

  assert.match(await trackBody(root, "track-b"), /^\| `old-task` \|$/m, "a one-column table gets just the slug")
  assert.ok(result.updated_files.includes(path.posix.join("track-b", "track.md")))
})

test("task_update unarchive leaves a track.md with no Tasks table alone", async () => {
  const root = await mkTempDeskRoot()
  await track_create({ deskRoot: root, input: { slug: "main-track", title: "main-track", scope: SCOPE } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-task", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "main-track", slug: "old-task", evidence: DONE_EVIDENCE } })

  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
  })
  assert.deepEqual(result.updated_files, [path.posix.join("main-track", "old-task", "task.md")])
})

test("task_update unarchive refuses a task that isn't archived", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "live-task", title: "T" } })

  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "live-task", unarchive: true } }),
    /no archived task to unarchive/,
  )
  assert.ok(await exists(path.join(root, "main-track", "live-task", "task.md")))
})

test("task_update unarchive refuses when the live folder already exists", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  // task_create refuses a slug that exists in the archive, so the colliding live folder is written directly.
  await writeMarkdown(path.join(root, "main-track", "old-task", "task.md"), { title: "T", status: "drafting" }, "")

  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "old-task", unarchive: true } }),
    /target already exists/,
  )
})

test("task_update unarchive validates a new name as usual", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "old-task", unarchive: true, to_slug: "please-reopen-it" } }),
    /invalid to_slug/,
  )
})

test("task_update refuses an unarchive flag that isn't a boolean", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "old-task", unarchive: "yes" } }),
    /`unarchive` must be true or false/,
  )
})

test("task_update with unarchive false behaves like a plain move", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: false, to_slug: "renamed-task" },
  })
  assert.equal(result.to, path.posix.join("main-track", "_archive", "renamed-task"))
})

// ── task_update: into_task (M4-5 duplicate merge) ──────────────────────────────

test("task_update into_task moves a duplicate into the kept task as a dated iteration folder", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["keep-task", "dup-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "keep-task", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  await fs.mkdir(path.join(root, "main-track", "dup-task", "_iterations", "2026-09-01-first-pass"), { recursive: true })
  await fs.writeFile(path.join(root, "main-track", "dup-task", "_iterations", "2026-09-01-first-pass", "doing.md"), "unique notes\n")
  const { data: before, content: beforeBody } = await readFront(path.join(root, "main-track", "dup-task", "task.md"))
  const day = new Date(before.created).toISOString().slice(0, 10)

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "dup-task", into_task: "keep-task" },
    schedulePush: () => {},
  })

  const iteration = path.posix.join("main-track", "keep-task", "_iterations", `${day}-dup-task`)
  assert.equal(result.from, path.posix.join("main-track", "dup-task"))
  assert.equal(result.to, iteration)
  assert.equal(await exists(path.join(root, "main-track", "dup-task")), false)
  assert.equal(await exists(path.join(root, iteration, "task.md")), false, "the merged card is no longer a task card")
  const { data, content } = await readFront(path.join(root, iteration, "merged-task.md"))
  assert.equal(data.merged_into, "keep-task")
  assert.equal(data.status, before.status, "merging never changes the status")
  assert.equal(content, beforeBody, "the merged card keeps its body")
  assert.equal(
    await fs.readFile(path.join(root, iteration, "_iterations", "2026-09-01-first-pass", "doing.md"), "utf8"),
    "unique notes\n",
    "nothing is deleted",
  )
  const body = await trackBody(root, "main-track")
  assert.doesNotMatch(body, /`dup-task`/)
  assert.match(body, /`keep-task`/)
  assert.deepEqual(result.updated_files, [path.posix.join(iteration, "merged-task.md"), path.posix.join("main-track", "track.md")])
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_update: dup-task → main-track")
})

test("task_update into_task across tracks leaves the destination table alone", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "track-a", { rows: [] })
  await mkTrack(root, "track-b", { rows: ["keep-task"] })
  await task_create({ deskRoot: root, input: { track: "track-b", slug: "keep-task", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "dup-task", title: "T" } })
  const card = path.join(root, "track-a", "dup-task", "task.md")
  await fs.writeFile(card, (await fs.readFile(card, "utf8")).replace(/^created: .*$/m, "created: 2026-03-04"))
  const before = await trackBody(root, "track-b")

  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "dup-task", to_track: "track-b", into_task: "keep-task" },
  })

  assert.equal(result.to, path.posix.join("track-b", "keep-task", "_iterations", "2026-03-04-dup-task"))
  const { data } = await readFront(path.join(root, result.to, "merged-task.md"))
  assert.equal(data.track, "track-b")
  assert.equal(await trackBody(root, "track-b"), before)
  assert.deepEqual(result.updated_files, [path.posix.join(result.to, "merged-task.md")])
})

test("task_update into_task names the iteration after today when the card has no usable created date", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "keep-task", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  const card = path.join(root, "main-track", "dup-task", "task.md")
  await fs.writeFile(card, (await fs.readFile(card, "utf8")).replace(/^created: .*$/m, "created: not-a-date"))

  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "dup-task", into_task: "keep-task" },
  })
  assert.match(path.basename(result.to), /^\d{4}-\d{2}-\d{2}-dup-task$/)
})

test("task_update into_task refuses a task to merge into that doesn't exist", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "missing-task" } }),
    /the task to merge into doesn't exist/,
  )
  assert.ok(await exists(path.join(root, "main-track", "dup-task", "task.md")))
})

test("task_update into_task refuses to merge a task into itself, before touching anything", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "dup-task" } }),
    /cannot be merged into itself/,
  )
  assert.equal(await exists(path.join(root, "main-track", "dup-task", "_iterations")), false)
  assert.ok(await exists(path.join(root, "main-track", "dup-task", "task.md")))
})

test("task_update into_task refuses to_slug, unarchive and a traversal-shaped keeper", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  for (const extra of [{ to_slug: "other-name" }, { unarchive: true }]) {
    await assert.rejects(
      moveTask({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "keep-task", ...extra } }),
      /`into_task` cannot be combined/,
    )
  }
  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "../elsewhere" } }),
    /`into_task` must be a non-empty path segment/,
  )
})

// ── Leave other sessions' work alone (M4-5 fix round 2) ────────────────────

test("task_update refuses a task with uncommitted or untracked files, without quoting its name", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["pw-hunter2-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "clean-task", title: "T" } })
  commitAll(root)
  await fs.writeFile(path.join(root, "main-track", "clean-task", "doing.md"), "another session is writing this\n")

  const error = await moveTask({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "renamed-task" } }).catch((e) => e)
  assert.match(error.message, DIRTY)
  assert.doesNotMatch(error.message, /clean-task|main-track/)
  assert.ok(await exists(path.join(root, "main-track", "clean-task", "doing.md")), "nothing moved")

  // A tracked file with unstaged edits counts too.
  commitAll(root)
  await fs.appendFile(path.join(root, "main-track", "clean-task", "doing.md"), "more\n")
  await assert.rejects(moveTask({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "renamed-task" } }), DIRTY)
})

test("task_update ignores ignored files, and moves a dirty task when allow_dirty is true", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "clean-task", title: "T" } })
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n")
  commitAll(root)
  await fs.writeFile(path.join(root, "main-track", "clean-task", "run.log"), "ignored\n")
  await moveTask({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "moved-task" }, schedulePush: () => {} })
  assert.ok(await exists(path.join(root, "main-track", "moved-task", "run.log")))

  commitAll(root)
  await fs.writeFile(path.join(root, "main-track", "moved-task", "doing.md"), "in progress\n")
  const result = await moveTask({ deskRoot: root, input: { track: "main-track", slug: "moved-task", to_slug: "final-task", allow_dirty: true }, schedulePush: () => {} })
  assert.equal(result.to, path.posix.join("main-track", "final-task"))
  // allow_dirty sweeps the dirty file along with the move (existing `git add
  // -A` + `git mv` behavior); the move's own commit picks it up too, since it
  // is part of the moved directory, not an unrelated path (M4-6 Part 2).
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_update: moved-task → main-track")

  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "final-task", to_slug: "other-task", allow_dirty: "yes" } }),
    /`allow_dirty` must be true or false/,
  )
})

test("task_update treats a failing git diff or git ls-files as unstaged work", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "clean-task", title: "T" } })
  commitAll(root)
  for (const failing of ["diff", "ls-files"]) {
    const spawnGit = (cmd, args, opts) => (args.includes(failing) ? { status: 128, stdout: "", stderr: "boom" } : spawnSync(cmd, args, opts))
    await assert.rejects(moveTask({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "moved-task" }, spawnGit }), DIRTY)
  }
})

test("task_update refuses to edit a track.md that holds another session's uncommitted changes, unless allow_dirty", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["clean-task"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "clean-task", title: "T" } })
  commitAll(root)
  await fs.appendFile(path.join(root, "track-b", "track.md"), "\nA line another session is writing.\n")

  const error = await moveTask({ deskRoot: root, input: { track: "track-a", slug: "clean-task", to_track: "track-b" } }).catch((e) => e)
  assert.equal(
    error.message,
    "task_update: Commit or finish that work first, or pass allow_dirty: true: a track.md this move would edit has unstaged changes or untracked files, so another session may be working there; commit or finish that work first, or pass allow_dirty: true to move it anyway",
  )
  assert.ok(await exists(path.join(root, "track-a", "clean-task", "task.md")), "nothing moved")

  // The source track's table counts too.
  await fs.appendFile(path.join(root, "track-a", "track.md"), "\nAnother edit.\n")
  await assert.rejects(moveTask({ deskRoot: root, input: { track: "track-a", slug: "clean-task", to_slug: "renamed-task" } }), /a track\.md this move would edit has unstaged changes or untracked files/)

  const result = await moveTask({ deskRoot: root, input: { track: "track-a", slug: "clean-task", to_track: "track-b", allow_dirty: true }, schedulePush: () => {} })
  assert.equal(result.to, path.posix.join("track-b", "clean-task"))
})

test("task_update into_task refuses to hide a live task inside a done one, and merges a done one into a live one", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  for (const slug of ["done-task", "live-task", "other-live-task"]) {
    await task_create({ deskRoot: root, input: { track: "main-track", slug, title: "T" } })
  }
  const done = path.join(root, "main-track", "done-task", "task.md")
  await fs.writeFile(done, (await fs.readFile(done, "utf8")).replace(/^status: .*$/m, "status: done"))
  commitAll(root)

  await assert.rejects(
    moveTask({ deskRoot: root, input: { track: "main-track", slug: "live-task", into_task: "done-task" } }),
    /^Error: task_update: Merge the finished task into the live one instead, or skip the merge: this task is still live but the task to merge into is done or cancelled; keep the live task \(merge the finished one into it instead\) or skip the merge$/,
  )
  assert.ok(await exists(path.join(root, "main-track", "live-task", "task.md")), "the live task stays where it is")

  const kept = await moveTask({ deskRoot: root, input: { track: "main-track", slug: "done-task", into_task: "live-task" }, schedulePush: () => {} })
  assert.match(kept.to, /^main-track\/live-task\/_iterations\/\d{4}-\d{2}-\d{2}-done-task$/)
  commitAll(root)
  const both = await moveTask({ deskRoot: root, input: { track: "main-track", slug: "other-live-task", into_task: "live-task" }, schedulePush: () => {} })
  assert.match(both.to, /other-live-task$/, "two live tasks for one job can still be merged")
})

test("track_update refuses a track with uncommitted work unless allow_dirty is true", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })
  commitAll(root)
  await fs.writeFile(path.join(root, "old-track", "task-one", "doing.md"), "in progress\n")

  const error = await renameTrack({ deskRoot: root, input: { track: "old-track", to: "new-track" } }).catch((e) => e)
  assert.match(error.message, /^track_update: Commit or finish that work first, or pass allow_dirty: true: the source has unstaged changes or untracked files, so another session may be working there/)
  assert.doesNotMatch(error.message, /old-track|task-one/)
  assert.ok(await exists(path.join(root, "old-track", "track.md")))

  const result = await renameTrack({ deskRoot: root, input: { track: "old-track", to: "new-track", allow_dirty: true }, schedulePush: () => {} })
  assert.equal(result.to, "new-track")
  await assert.rejects(renameTrack({ deskRoot: root, input: { track: "new-track", to: "newer-track", allow_dirty: 1 } }), /`allow_dirty` must be true or false/)
})

// ── track_update ─────────────────────────────────────────────────────────────

test("track_update renames a track and rewrites track: on every live task card", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-two", title: "T" } })

  commitAll(root)
  const result = await renameTrack({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })

  assert.equal(result.from, "old-track")
  assert.equal(result.to, "new-track")
  assert.equal(await exists(path.join(root, "old-track")), false)
  assert.ok(await exists(path.join(root, "new-track", "track.md")))

  for (const slug of ["task-one", "task-two"]) {
    const { data } = await readFront(path.join(root, "new-track", slug, "task.md"))
    assert.equal(data.track, "new-track")
  }
  assert.deepEqual(
    result.updated_files.sort(),
    [path.posix.join("new-track", "task-one", "task.md"), path.posix.join("new-track", "task-two", "task.md")].sort(),
  )

  // Staged and committed (M4-6 Part 2): the tree is clean afterward, and the
  // new commit names the tool and the rename.
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "track_update: old-track → new-track")
})

test("track_update preserves every other frontmatter byte untouched: a date-only value, a long single-line scalar, quoted and unquoted values, and a note: | block", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })
  const filePath = path.join(root, "old-track", "task-one", "task.md")
  const handWritten = [
    "---",
    "schema_version: 1",
    "title: T",
    "track: old-track",
    "status: drafting",
    "created: 2026-05-26",
    "requester: \"ari\"",
    "reviewer: ari",
    "purpose: A long single-line scalar describing the task in one uninterrupted run of prose, with no wrapping at all.",
    "note: |",
    "  first literal line",
    "  second literal line",
    "updated: \"2026-09-20T10:00:00Z\"",
    "---",
    "",
    "# T",
    "",
    "Body text.",
    "",
  ].join("\n")
  await fs.writeFile(filePath, handWritten, "utf8")

  commitAll(root)
  await renameTrack({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })

  const raw = await fs.readFile(path.join(root, "new-track", "task-one", "task.md"), "utf8")
  assert.match(raw, /\ncreated: 2026-05-26\n/u, "the date-only created value is untouched")
  assert.match(raw, /\nrequester: "ari"\n/u, "the quoted requester value is untouched")
  assert.match(raw, /\nreviewer: ari\n/u, "the unquoted reviewer value is untouched")
  assert.match(
    raw,
    /\npurpose: A long single-line scalar describing the task in one uninterrupted run of prose, with no wrapping at all\.\n/u,
    "the long single-line purpose scalar is untouched",
  )
  assert.match(raw, /\nnote: \|\n {2}first literal line\n {2}second literal line\n/u, "the note: | block is untouched")
  assert.doesNotMatch(raw, /updated: "2026-09-20T10:00:00Z"/u, "updated is refreshed")
})
